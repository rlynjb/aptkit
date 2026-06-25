# 09 — Database-systems red-flags audit

**Subtitle:** Ranked storage-engine & consistency risks — *Project-specific
audit*

---

## Zoom out, then zoom in

This is the verdict file. Every concept file taught a mechanism and mapped it
to AptKit's analog or marked it absent; this one ranks the *risks* that follow,
by consequence, with the evidence for each. The honest framing up front: AptKit
has almost no database-systems risk *because it has almost no database* — the
working set is tiny, writes are rare and immutable, and artifacts are
regenerable. The risks below are mostly latent: harmless today, sharp the moment
one access pattern changes. Each names the trigger.

```
  Zoom out — where each ranked risk lives

  ┌─ Service layer ───────────────────────────────────────────┐
  │  #1 filename-sort index   #2 read-time constraints         │
  │  #3 N+1 in listing        #4 no-fsync durability           │
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Capability layer (@aptkit/retrieval + @aptkit/memory) ───┐
  │  #4b vector store: no durability · linear scan · no txn    │
  │  #4c memory recall: over-fetch + filter `kind` (no index)  │
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ───────────▼───────────────────────────────┐
  │  #5 full-scan reads   #6 no backup beyond git              │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** Ranked by *consequence if the trigger fires*, not by how exotic
the mechanism is. The top risks are the ones that fail *silently* — wrong
order, persisted bad data, secret corruption — because silent failures are the
ones you ship.

---

## The ranked risks

### #1 — The only index is a string sort that silently mis-orders if the filename format changes

**Consequence: HIGH (silent wrong results).** AptKit's entire ordering
guarantee rides on filenames starting with a zero-padded ISO-8601 timestamp,
so a *lexicographic* sort equals a *chronological* one. Two separate code paths
depend on it: `listReplayArtifacts` does `.sort()` on filenames
(`packages/evals/src/replay-runner.ts:43`), and `listReplaySummaries` does
`createdAt.localeCompare` (`apps/studio/vite.config.ts:983`). They agree only
because the filename is *derived* from `createdAt` (`vite.config.ts:376`).
Change the naming scheme — UUID prefix, non-padded month, locale-dependent date
— and ordering breaks with **no error and no test failure**; the list just
shows runs in the wrong order.

```
  evidence chain
  vite.config.ts:376  filename = ISO-timestamp + slug   (writes the "key")
  replay-runner.ts:43 .sort()                            (CLI reads the key)
  vite.config.ts:983  createdAt.localeCompare            (UI reads a parallel key)
        │
        └─ two indexes, one assumption (ISO sorts chronologically). Break it → silent.
```

**Trigger / fix:** the moment you change filename format, or need ordering by
anything but time. Fix: sort on the parsed `createdAt` with an explicit date
comparator (already half-done in the UI path), or write an index file. Detail:
`03-btree-hash-and-secondary-indexes.md`.

### #2 — Integrity constraints are enforced at read time, not write time

**Consequence: HIGH (bad data persists silently).** The full shape check,
`assertReplayArtifactShape` and its capability-specific siblings
(`packages/evals/src/assertions.ts:58-126`), runs when a record is *read back*,
not when it's saved. The write path runs only the lighter `normalizeReplayArtifact`
(`vite.config.ts:1497-1512`), which catches gross malformation but not the full
shape (it won't run the recommendation/anomaly sub-checks). So a
normalizable-but-invalid artifact lands on disk and isn't caught until eval —
potentially long after the run that produced it.

**Notable sub-risk — secret leakage check is also read-time only.**
`findSecretLikeString` (`assertions.ts:397-421`) scans for `sk-...` and
`OPENAI_API_KEY=` patterns, but as part of the read-time assertion. A secret
that slips into an artifact is written to disk first and only flagged on the
next eval. Given `.env` holds live keys (per project context), the
write-time guard matters.

**Trigger / fix:** any time a malformed or secret-bearing artifact causing a
late failure is unacceptable. Fix: run the full `assertReplayArtifactShape`
(including the secret scan) inside `/api/replay/save` before `writeFile`. Detail:
`05-transactions-isolation-and-anomalies.md`.

### #3 — N+1 in the promoted-fixture listing endpoints

**Consequence: MEDIUM (latency cliff at scale).** Each of the four
promoted-fixture list endpoints scans a directory and, *per file*, re-runs the
full agent replay to recompute pass/fail:
`listPromotedFixtureSummaries` calls `runReplay(fixture, 'fixture')` in the loop
(`apps/studio/vite.config.ts:1001`), and the same shape repeats at lines `1047`
(monitoring), `1093` (diagnostic), `1139` (query). Listing M baselines = M agent
executions, serially, on one HTTP request. Fast today (deterministic fixture
mode, single-digit M), but structurally an N+1 — the textbook setup for a
slow-listing incident.

**Trigger / fix:** when promoted fixtures multiply or replay gets expensive.
Fix: cache the computed pass/fail (and usage/cost) alongside the fixture so the
listing reads metadata instead of recomputing. Detail:
`04-query-planning-and-execution.md`.

### #4 — Durability boundary is a single un-fsync'd, non-atomic write

**Consequence: MEDIUM (corruption window; bounded by regenerability).** Every
save and promotion is one `writeFile` with no `fsync` and no temp-file-and-rename
(`vite.config.ts:377`, `promote-replay-to-fixture.mjs:79`). "Saved" means OS
cache, not disk; a crash in the gap can lose the artifact or leave a *truncated*
file that fails `JSON.parse` on the next read (`replay-runner.ts:83`). The blast
radius is bounded because artifacts are regenerable by re-running the agent — but
promoted fixtures, which are committed baselines, deserve the atomic-write
treatment.

**Trigger / fix:** when artifacts become un-regenerable (live runs you can't
reproduce). Fix: write to a temp file then `rename` (atomic on POSIX), and
`fsync` for anything that must survive a crash. Detail:
`07-wal-durability-and-recovery.md`.

### #4b — The vector store has zero durability and a linear-scan "index"

**Consequence: LOW today / MEDIUM at scale (latent, by design).** The new
`InMemoryVectorStore` (`packages/retrieval/src/in-memory-vector-store.ts:10-43`)
is the repo's first storage engine with upsert/search semantics, and it makes
two deliberate omissions that are fine now and sharp later. First, **no
durability**: chunks live in a `Map` that dies with the process
(`line 11`), so the entire indexed corpus is lost on restart and re-indexing is
the only recovery — there is no disk, no WAL, nothing to recover *from*. Second,
**no ANN index**: `search` computes cosine similarity against every chunk then
sorts (`lines 25-33`), an O(N·d) full scan. At a few hundred chunks that's
microseconds; at tens of thousands it's the latency floor an HNSW index exists
to remove. Third, a multi-chunk `upsert` is **not atomic** — it loops `set`s
with no transaction (`lines 18-23`), so a mid-loop throw (e.g. a dimension
mismatch on chunk 3 of 5) leaves a partially-indexed corpus. The one integrity
guard it *does* enforce is the dimension check (`lines 36-42`), which fails
loudly rather than corrupting ranking silently.

```
  evidence chain — three omissions, all deliberate
  in-memory-vector-store.ts:11    private chunks = new Map(...)   → no disk (no durability)
  in-memory-vector-store.ts:25-33 search = scan + cosine + sort  → no ANN index (O(N·d))
  in-memory-vector-store.ts:18-23 upsert loops set()             → no txn (partial on throw)
        │
        └─ all three are correct for a from-scratch in-memory pipeline; each has
           a named trigger. None is a bug today.
```

**Trigger / fix:** corpus outgrows a few hundred chunks, or the index must
survive a restart, or a partial upsert is unacceptable. Fix: swap in the
durable implementation of the *same* `VectorStore` contract — which already
exists in the **buffr** repo (`/Users/rein/Public/buffr/src/pg-vector-store.ts`):
Postgres-backed, an HNSW index (`buffr/sql/001_agents_schema.sql:28-29`), and a
real `begin/commit/rollback` around the multi-chunk upsert
(`pg-vector-store.ts:40-64`). The swap is a one-line wiring change because the
pipeline never names a store. Detail: `03` (scan vs ANN index) and `04` (the
query path). **Boundary note:** that durable engine, its transactions, and its
HNSW index live in buffr, *not* aptkit — aptkit ships only the in-memory store
and the contract.

### #4c — Memory recall over-fetches then filters by `kind` — silent under-return on a shared collection

**Consequence: LOW today / MEDIUM on a shared, skewed store (silent wrong
results).** The `VectorStore` contract (`packages/retrieval/src/contracts.ts:33-37`)
has no metadata predicate — `search(vector, k)` only. `@aptkit/memory`'s
`recall` (`packages/memory/src/conversation-memory.ts:89-105`) needs the top-k
of *only* memory rows (`meta.kind === 'memory'`), but memory may share a
collection with documents (the store is injected — `conversation-memory.ts:20-26`).
With no `kind` index, recall over-fetches a wider window
(`fetchK = Math.max(k * 4, 20)`, `line 94`), then filters and slices in the
application (`lines 96-98`). The failure mode is **silent under-return**: if a
query surfaces enough documents to outrank the memory rows, the real memory
matches fall past the fetch window and recall returns fewer than `k` — no error,
no log. The same shape exists in the `search_knowledge_base` tool when a `filter`
is passed (`search-knowledge-base-tool.ts:87-90`), but that filter is optional;
memory's is structural — it runs on every recall.

```
  evidence chain — predicate the engine can't see → over-read then filter
  contracts.ts:33-37            search(vector, k)        → no metadata predicate
  conversation-memory.ts:94     fetchK = max(k*4, 20)    → over-fetch the window
  conversation-memory.ts:96-98  filter kind==='memory'   → predicate in the app
        │
        └─ matches outranked by docs past fetchK are never fetched → recall
           returns < k, silently. `kind` is a partition with no index behind it.
```

**Trigger / fix:** a shared memory+document collection where documents vastly
outnumber memory rows (or a query that strongly favors documents). Fix options,
in order: (a) give memory a *dedicated* store so no filter is needed (the
contract already supports it — `conversation-memory.ts:20-26`); (b) widen
`fetchK` further, trading read cost for recall; (c) the real fix — an indexed,
pushed-down metadata predicate. buffr proves the pushdown shape works for one
column (`where app_id = $2`, `/Users/rein/Public/buffr/src/pg-vector-store.ts`)
but has **no `kind` predicate either**, so even on Postgres a shared store
over-fetches on `kind` today. The indexed metadata filter is shipped in neither
repo. Detail: `04` (the over-fetch-then-filter execution path) and `03` (the
missing `kind` secondary index).

### #5 — Every read is a full directory scan with no projection

**Consequence: LOW today / MEDIUM at scale.** There's no index for any
attribute and no projection: listing reads and `JSON.parse`s every full file to
surface even one field (`replay-runner.ts:81-94`, `vite.config.ts:949-983`).
Linear in directory size, no pagination — the whole directory is materialized
per request. Trivial at N=8; a problem when a list view must render thousands of
records' metadata. **Trigger / fix:** when N grows large enough that
parse-everything-per-list is felt. Fix: an index/manifest file, or a real store.
Detail: `02` and `03`.

### #6 — No backup or restore path beyond git, and it's manual

**Consequence: LOW (mitigated, but manual).** The only durability that survives
losing the machine is committing `artifacts/replays/` and the promoted fixtures
to git. There's no automated backup, no point-in-time restore, and saved-but-
uncommitted artifacts are unprotected. Promoted fixtures are the ones that matter
(correctness baselines) and they're meant to be committed — so the important data
is covered, but by convention, not by a mechanism. **Trigger / fix:** when
artifacts carry value that can't be regenerated and a git commit isn't reliably
happening. Fix: an explicit archival step. Detail: `07`.

---

## What is genuinely NOT a risk (and why)

Worth stating, so the audit isn't read as alarmist:

```
  non-risk                        why it's fine
  ─────────────────────────────── ──────────────────────────────────────────
  no transactions / isolation     filesystem: no op spans 2+ files, no in-place
   (filesystem path)              update → no atomicity exposure (file 05).
                                  vector store: a multi-chunk upsert COULD partial
                                  on throw, but the corpus is in-memory and
                                  rebuildable, so the blast radius is "re-index"
  no locks / MVCC                 unique-filename writes + immutable records →
                                  zero write contention by construction (file 06).
                                  vector store is single-process in-memory: no
                                  concurrent writers to contend
  no replication / failover       single-node; reads reproducible via deterministic
                                  replay, not distribution (file 08)
  lost-update anomaly             filesystem: impossible, nothing updated in place.
                                  vector store: upsert DOES replace by id, but
                                  single-process → no concurrent lost update (file 05)
```

These are absent *correctly*. Append-only-immutable-single-node (filesystem)
plus single-process-rebuildable (vector store) deletes whole categories of
database risk. Where those guarantees come from a real engine instead of from
construction — transactions, isolation, an HNSW index — they live in the
**buffr** `PgVectorStore`, not aptkit. The audit's real content is the latent
items above, each one trigger away from mattering.

---

## Primary diagram — the risk map

```
  AptKit database-systems risks, ranked by consequence-if-triggered

  HIGH  ┌──────────────────────────────────────────────────────────┐
        │ #1 filename-sort index → silent wrong order               │
        │    replay-runner.ts:43 · vite.config.ts:983/376           │
        │ #2 read-time constraints → bad/secret data persists       │
        │    assertions.ts:58,397 · vite.config.ts:1497             │
  MED   ├──────────────────────────────────────────────────────────┤
        │ #3 N+1 listing → latency cliff   vite.config.ts:1001 +3   │
        │ #4 no-fsync write → corruption window  vite.config.ts:377 │
        │ #4b vector store: no durability + linear scan + no txn    │
        │     in-memory-vector-store.ts:11,25,18 (durable: buffr)   │
        │ #4c recall over-fetch+filter `kind` → silent under-return │
        │     conversation-memory.ts:94-98 · contracts.ts:33 (no    │
        │     metadata predicate; buffr pushes app_id, not kind)    │
  LOW   ├──────────────────────────────────────────────────────────┤
        │ #5 full-scan reads   replay-runner.ts:81 · vite.config:949│
        │ #6 git-only manual backup                                 │
        └──────────────────────────────────────────────────────────┘
  all eight are LATENT: harmless now, sharp when their trigger fires.
```

---

## Implementation in codebase — the load-bearing lines

The four lines that, between them, carry every risk above:

```
  replay-runner.ts:43      .sort();                         → risk #1, #5
  assertions.ts:58         assertReplayArtifactShape(...)   → risk #2 (read-time)
  vite.config.ts:1001      runReplay(fixture, 'fixture')    → risk #3 (N+1)
  vite.config.ts:377       writeFile(..., no fsync)         → risk #4, #6
       │
       └─ four lines hold the storage-engine behavior of the whole repo. That
          concentration is itself the finding: there's so little persistence
          machinery that the risks are countable on one hand.
```

---

## Interview defense

**Q: "Rank the database risks in this codebase."**

> The honest headline is there's barely any database, so barely any database
> risk — append-only immutable single-node files delete transactions, locking,
> and replication concerns by construction. The real risks are latent. Top is
> the index: ordering rides on filenames being ISO-timestamp-prefixed, so a
> naming change silently mis-orders with no test catching it
> (`replay-runner.ts:43`). Second is read-time integrity: bad or secret-bearing
> artifacts persist and aren't caught until eval (`assertions.ts:58,397`). Then
> the N+1 in the promoted-fixture listing (`vite.config.ts:1001`) and the
> no-fsync write (`377`). Each is one access-pattern change from mattering.

```
  #1 silent mis-order (filename index)   #2 bad data persists (read-time check)
  #3 N+1 listing                         #4 no-fsync corruption window
  → all latent; harmless today, named with their triggers
```

**Anchor:** "Four lines carry the whole storage engine; the top two risks fail
*silently*, which is why they rank above the latency ones."

---

## Validate

1. **Reconstruct:** List the eight risks (including #4b and #4c) in consequence
   order and the one `file:line` that anchors each.
2. **Explain:** Why do risks #1 and #2 rank above #3 and #4? (Silent vs visible
   failure.)
3. **Apply:** A teammate switches artifact filenames to UUIDs and adds 5,000
   live (non-regenerable) runs. Which risks activate, and in what order would you
   address them?
4. **Defend:** Argue why none of these were worth fixing when the repo had 8
   regenerable artifacts, and name the single change that would force you to fix
   #2 and #4 immediately.

---

## See also

- `00-overview.md` — the same findings in map form
- `03-btree-hash-and-secondary-indexes.md` — risk #1, #5 in depth
- `05-transactions-isolation-and-anomalies.md` — risk #2 in depth
- `04-query-planning-and-execution.md` — risk #3 and #4c (over-fetch-then-filter) in depth
- `07-wal-durability-and-recovery.md` — risk #4, #6 in depth
- `study-system-design` → the storage-choice and caching decisions that fix #3/#5
- `study-data-modeling` → the schema and `schemaVersion` behind #2
