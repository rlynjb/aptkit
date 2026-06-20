# 00 — Overview: the database-systems map of AptKit

**Verdict first:** AptKit has no *durable* database engine — but as of the
`@aptkit/retrieval` package it now ships one genuine in-memory storage engine.
There are three "stores" to hold in your head: (1) the **filesystem** —
artifacts/fixtures as JSON files, the durable persistence surface; (2) the
in-memory **replay cursor** (`FixtureModelProvider`) — a read-only positional
index; and (3) the new **`InMemoryVectorStore`** — a vector store that does
cosine-similarity *search* over an in-memory array. That third one is the
closest thing in the repo to a real database query engine: it has a contract
(`VectorStore`: upsert/search-by-vector), it ranks records by similarity, and
it does a linear scan that stands in for an index. What it does *not* have is
durability (a `Map` that dies with the process), transactions, or an ANN index
— which is exactly the database-systems lesson. The real Postgres/pgvector/HNSW
implementation of the same `VectorStore` contract lives in a **separate repo
(buffr)**, not aptkit; aptkit ships only the in-memory store + the contract.
This file is the map: where each store lives, what each does (and doesn't)
guarantee, and the triggers that force the real engine in.

## The one diagram to hold

Here is the whole "datastore" in one frame. Note that there is no storage
layer in the usual sense — the filesystem *is* the storage layer, and the
Vite dev server is the only thing that ever talks to it.

```
  AptKit's entire persistence surface

  ┌─ UI layer (apps/studio, React) ───────────────────────────┐
  │  AgentReplayShell → fetch('/api/replay/save')              │
  │                   → fetch('/api/replays')                  │
  └───────────────────────────┬───────────────────────────────┘
                              │  HTTP (localhost dev only)
  ┌─ Service layer (Vite middleware) ─────────────────────────┐
  │  vite.config.ts: writeFile / readdir / readFile           │
  │  no connection pool, no client, no driver                 │
  └───────────────────────────┬───────────────────────────────┘
                              │  node:fs/promises
  ┌─ "Storage" layer (the filesystem) ────────────────────────┐
  │  artifacts/replays/*.json          ← write-new-file        │
  │  packages/agents/*/fixtures/*.json ← promoted baselines    │
  │  no engine, no index, no transactions                     │
  └───────────────────────────────────────────────────────────┘
```

There is a second, even smaller "store": the `FixtureModelProvider`
(`packages/agents/recommendation/src/fixture-provider.ts:3-18`). It holds a
`ModelResponse[]` in memory and serves them by an incrementing `index`. That
is a read-only cursor over a fixed page — the closest thing in the repo to a
deterministic read path, and the analog `08-replication-and-read-consistency`
leans on.

And now there is a third, the one that actually behaves like a database query
engine: the `InMemoryVectorStore`
(`packages/retrieval/src/in-memory-vector-store.ts:10-43`). It holds
`VectorChunk`s in a `Map` keyed by id, and its `search(vector, k)` ranks every
stored chunk by cosine similarity, sorts, and returns the top-k. That's a real
storage engine with a real (if naive) execution strategy — `upsert` is an
INSERT/UPSERT, `search` is a `SELECT ... ORDER BY similarity LIMIT k` run as a
full table scan. It just lacks the three things that make a database a
database: it never touches disk (no durability), it has no transaction around a
multi-chunk upsert (no atomicity), and its "index" is a linear scan, not an ANN
structure (no real index). Files `03` and `04` walk it as a storage engine;
the buffr `PgVectorStore` is the durable counterpart behind the same contract.

```
  The three "stores" — one durable on disk, two in memory

  ┌─ Filesystem (durable) ────────────────────────────────────┐
  │  artifacts/replays/*.json   ·   fixtures/promoted/*.json  │
  │  write-once JSON; durability = writeFile resolved          │
  └───────────────────────────────────────────────────────────┘
  ┌─ In-memory store #1: FixtureModelProvider ────────────────┐
  │  ModelResponse[] served by integer cursor (read-only)      │
  └───────────────────────────────────────────────────────────┘
  ┌─ In-memory store #2: InMemoryVectorStore ─────────────────┐
  │  Map<id, VectorChunk>; search = scan + cosine + sort + topK│
  │  ★ the only thing with upsert/query semantics ★            │
  │  no disk · no txn · no ANN index → dies with the process   │
  └───────────────────────────────────────────────────────────┘
```

## The query paths (all four of them)

A "query path" here means: how does a byte get from a program into storage
and back out. There are exactly four, and none involve a query language.

```
  the four paths, and which file owns each

  WRITE   POST /api/replay/save → writeFile()
          apps/studio/vite.config.ts:364-383

  READ    GET /api/replays → readdir + filter + sort
          packages/evals/src/replay-runner.ts:31-44

  COMMIT  npm run promote:replay → writeFile(authoritative)
          scripts/promote-replay-to-fixture.mjs:44-79

  VALIDATE  assertReplayArtifactShape(parsed) at read time
            packages/evals/src/assertions.ts:58-126
```

## The durability boundary

The most important line in the whole system to understand: **the durability
boundary is a single `writeFile()` with no `fsync`.** Once Node's
`writeFile` resolves, AptKit considers the data saved. It does not call
`fsync`, does not write to a temp file and rename, and does not log the
intent first. Full walk in `07-wal-durability-and-recovery.md`.

```
  artifact in memory ──writeFile()──► OS page cache ──?──► disk
                       │                                    ▲
                       └─ AptKit declares "saved" HERE      │
                          (durability boundary)             │
                                                            │
                          actual durability happens         │
                          out here, asynchronously, ────────┘
                          and AptKit never waits for it
```

## Ranked findings — what's most consequential

0. **`@aptkit/retrieval` adds the repo's first real storage engine — an
   in-memory vector store with upsert/search semantics but no durability, no
   transactions, and a linear-scan "index."** `InMemoryVectorStore`
   (`packages/retrieval/src/in-memory-vector-store.ts:10-43`) holds chunks in a
   `Map` and answers `search(vector, k)` by computing cosine similarity against
   *every* stored chunk, sorting, and slicing top-k (`lines 25-33`). It is a
   `SELECT ... ORDER BY similarity LIMIT k` executed as a full scan: O(N·d) per
   query, where a production system would use an ANN index (HNSW) for
   sub-linear search. It persists nothing — the `Map` dies with the process — so
   "durability" is zero and re-indexing is the only recovery. The one integrity
   guard it does enforce is a **dimension check** (`lines 36-42`): a
   wrong-length vector throws loudly, because a silent dimension mismatch
   corrupts ranking. The real Postgres/pgvector/HNSW version of the same
   `VectorStore` contract lives in the **buffr** repo
   (`/Users/rein/Public/buffr/src/pg-vector-store.ts`), not aptkit — aptkit
   ships only the in-memory store and the contract. Detail in `03` (the
   scan-vs-ANN-index lesson) and `04` (the query execution path).

1. **The only on-disk index is a filename sort, and it's a string sort, not a
   time sort.** `listReplayArtifacts` does `.sort()` on filenames
   (`packages/evals/src/replay-runner.ts:43`); `listReplaySummaries` sorts by
   `createdAt.localeCompare` (`apps/studio/vite.config.ts:983`). Both work
   *only because* the ISO-8601 timestamp filename prefix sorts
   lexicographically the same as chronologically. The day a filename stops
   leading with a zero-padded ISO timestamp, the "index" silently
   mis-orders. Detail in `03`.

2. **Integrity constraints are checked at read time, not write time.** A
   real database rejects a bad row on `INSERT`. AptKit happily writes any
   JSON to `artifacts/replays/` and only runs `assertReplayArtifactShape`
   *when something reads it back* (`packages/evals/src/assertions.ts:58`).
   `/api/replay/save` does run a lightweight `normalizeReplayArtifact`
   (`vite.config.ts:1497-1512`) — a partial write-time check — but the full
   shape eval is a read-time gate. A malformed artifact persists silently
   until eval. Detail in `05`.

3. **No transaction, no lock, no atomicity across files.** Promotion reads a
   source fixture, reads the artifact, and writes a new file
   (`scripts/promote-replay-to-fixture.mjs:33-79`). If two promotions of the
   same artifact run concurrently, or the process dies mid-write, there is
   no rollback and no guard. Append-only-write-new-file is what saves it: no
   two writers ever touch the same file, so the classic lost-update race is
   sidestepped by construction, not by a lock. Detail in `05` and `06`.

4. **The append-only event log is never replayed.** `CapabilityEvent`
   (`packages/runtime/src/events.ts:1-24`) has the exact shape of a
   write-ahead log: append-only, timestamped, ordered. But nothing in AptKit
   reconstructs state by replaying it — the trace is embedded in the
   artifact for display and eval, not used for recovery. It's a WAL shape
   with no recovery semantics. Detail in `07`.

5. **"Read consistency" is provided by determinism, not by isolation.** The
   `FixtureModelProvider` serves the same `ModelResponse[]` in the same
   order every run (`fixture-provider.ts:11-17`). Two readers always see the
   same bytes because the bytes never change — not because a snapshot
   isolates them. This is why promoted fixtures are reproducible without any
   MVCC. Detail in `08`.

## `not yet exercised` — most of the curriculum

Honestly, most of database systems is absent. Each is taught in its file as
a concept, then marked absent with its trigger:

```
  topic                         status              trigger to reach for it
  ───────────────────────────── ─────────────────── ──────────────────────────
  records & pages               analog: JSON files  artifacts outgrow a directory
                                + in-mem VectorChunk
  B-tree / LSM storage          not yet exercised   need range scans by a key
  hash / secondary indexes      analog: filename    need lookup by capabilityId
                                sort + Map<id>       without scanning every file
                                point lookup
  vector / ANN index            ANALOG: linear scan  corpus outgrows a few hundred
                                (InMemoryVectorStore  chunks → swap in HNSW/pgvector
                                cosine, NO ANN)       (buffr's PgVectorStore)
  query planning / joins        analog: scan+filter  need to relate two record sets
                                + cosine top-k scan
  N+1 behavior                  PRESENT (read note)  listPromoted* re-runs replay
                                                     per file — a real N+1 shape
  ACID transactions             not yet exercised   multi-chunk upsert must be atomic
                                (aptkit) — buffr's    (buffr PgVectorStore wraps it in
                                PgVectorStore HAS one  begin/commit/rollback)
  isolation levels / anomalies  not yet exercised   concurrent writers to one record
  locks / MVCC                  not yet exercised    in-place updates under contention
  WAL / fsync durability        not yet exercised   a crash mid-write must not corrupt
                                (vector store: ZERO   (in-mem Map → no persistence at all)
                                 durability)
  backup / restore              partial (git)        artifacts must survive a wipe
  replication / read replicas   not yet exercised    multi-process or multi-host reads
  failover / stale reads        not yet exercised    a replica can lag a primary
```

Two genuinely-present database mechanisms worth flagging:

1. **A real query execution path with a linear-scan "index."** The
   `InMemoryVectorStore.search` (`packages/retrieval/src/in-memory-vector-store.ts:25-33`)
   ranks every chunk by cosine similarity then sorts and slices — a
   `SELECT ... ORDER BY similarity LIMIT k` run as a full scan. No ANN index, no
   persistence. Covered in `03` and `04`.

2. **An N+1 read pattern.** The promoted-fixture listing endpoints
   (`listPromotedFixtureSummaries` et al., `vite.config.ts:986-1168`) read every
   file in a directory and *re-run the full replay for each one* — one directory
   scan plus one expensive operation per row. Covered in
   `04-query-planning-and-execution.md`.

## Where to go next

`01-database-systems-map.md` zooms into the map above and traces the four
paths end to end. Then walk `02 → 08` in order, or jump to
`09-database-systems-red-flags-audit.md` for the ranked risk list.
