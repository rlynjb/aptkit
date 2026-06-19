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
  no transactions / isolation     no operation spans 2+ files; no in-place update
                                  → no atomicity or anomaly exposure (file 05)
  no locks / MVCC                 unique-filename writes + immutable records →
                                  zero write contention by construction (file 06)
  no replication / failover       single-node; reads reproducible via deterministic
                                  replay, not distribution (file 08)
  lost-update anomaly             impossible: nothing is updated in place (file 05)
```

These are absent *correctly*. Append-only-immutable-single-node deletes whole
categories of database risk. The audit's real content is the six latent items
above, each one trigger away from mattering.

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
  LOW   ├──────────────────────────────────────────────────────────┤
        │ #5 full-scan reads   replay-runner.ts:81 · vite.config:949│
        │ #6 git-only manual backup                                 │
        └──────────────────────────────────────────────────────────┘
  all six are LATENT: harmless now, sharp when their trigger fires.
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

1. **Reconstruct:** List the six risks in consequence order and the one
   `file:line` that anchors each.
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
- `04-query-planning-and-execution.md` — risk #3 in depth
- `07-wal-durability-and-recovery.md` — risk #4, #6 in depth
- `study-system-design` → the storage-choice and caching decisions that fix #3/#5
- `study-data-modeling` → the schema and `schemaVersion` behind #2
