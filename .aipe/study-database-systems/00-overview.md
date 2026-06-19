# 00 — Overview: the database-systems map of AptKit

**Verdict first:** AptKit has no database engine. It has a filesystem and an
in-memory replay cursor. Everything a database does for you — durable
storage layout, indexing, query planning, transactions, isolation,
concurrency control, write-ahead logging, recovery, replication — is either
solved by the cheapest filesystem mechanism available or not solved at all.
This file is the map: where the analogs live, what's genuinely missing, and
the single trigger that would force a real database into the repo.

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

1. **The only index is a filename sort, and it's a string sort, not a time
   sort.** `listReplayArtifacts` does `.sort()` on filenames
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
  B-tree / LSM storage          not yet exercised   need range scans by a key
  hash / secondary indexes      analog: filename    need lookup by capabilityId
                                sort (one "index")   without scanning every file
  query planning / joins        analog: scan+filter  need to relate two record sets
  N+1 behavior                  PRESENT (read note)  listPromoted* re-runs replay
                                                     per file — a real N+1 shape
  ACID transactions             not yet exercised   one logical write spans 2+ files
  isolation levels / anomalies  not yet exercised   concurrent writers to one record
  locks / MVCC                  not yet exercised    in-place updates under contention
  WAL / fsync durability        not yet exercised   a crash mid-write must not corrupt
  backup / restore              partial (git)        artifacts must survive a wipe
  replication / read replicas   not yet exercised    multi-process or multi-host reads
  failover / stale reads        not yet exercised    a replica can lag a primary
```

The one genuinely-present database *pathology* worth flagging: the
promoted-fixture listing endpoints (`listPromotedFixtureSummaries` et al.,
`vite.config.ts:986-1168`) read every file in a directory and *re-run the
full replay for each one*. That is an N+1 read pattern — one directory scan
plus one expensive operation per row. It's covered in
`04-query-planning-and-execution.md`.

## Where to go next

`01-database-systems-map.md` zooms into the map above and traces the four
paths end to end. Then walk `02 → 08` in order, or jump to
`09-database-systems-red-flags-audit.md` for the ranked risk list.
