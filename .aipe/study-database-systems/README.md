# Study — Database Systems (AptKit)

The headline, stated up front so nothing downstream is misleading:

> **AptKit has no database engine.** No SQL, no SQLite, no LevelDB, no
> Redis, no ORM, no embedded KV store. Persistence is plain JSON files on
> the filesystem plus an in-memory replay cursor. There is no query
> planner, no B-tree, no WAL, no MVCC, no replication.

So why a database-systems guide at all? Because every persistence
foundation a real datastore gives you — durable storage layout, indexes,
query execution, transactions, isolation, concurrency control, durability,
recovery, replication — is *still present as a problem* the moment a
program reads and writes data. AptKit solves a few of those problems with
the cheapest possible mechanism (write a new file, list a directory, sort
filenames) and ignores the rest entirely.

This guide is **curriculum-style**, not audit-style. Each concept file
teaches the engine mechanism the way you would need to know it to reach for
a real database — then maps it to the nearest in-repo analog by `file:line`,
or marks it `not yet exercised` and names the exact trigger that would make
you reach for the real thing.

## The nearest in-repo analogs (the whole substrate)

```
  AptKit's "storage engine" — the filesystem, used four ways

  ┌─ write path ──────────────────────────────────────────────┐
  │  /api/replay/save  →  writeFile(timestamp-slug.json)       │
  │  apps/studio/vite.config.ts:364-383                        │
  │  append-by-write-new-file — never updates, never deletes   │
  └────────────────────────────────────────────────────────────┘
  ┌─ read path ───────────────────────────────────────────────┐
  │  /api/replays  →  readdir() + filter .json + sort()        │
  │  packages/evals/src/replay-runner.ts:31-44                 │
  │  directory listing = the table scan                        │
  │  filename timestamp sort = the only "index"                │
  └────────────────────────────────────────────────────────────┘
  ┌─ commit/durability path ──────────────────────────────────┐
  │  promote-replay-to-fixture.mjs  →  authoritative baseline  │
  │  scripts/promote-replay-to-fixture.mjs:44-79               │
  │  promotion = a manual "commit" of a chosen write           │
  └────────────────────────────────────────────────────────────┘
  ┌─ integrity path ──────────────────────────────────────────┐
  │  assertReplayArtifactShape() at read time                  │
  │  packages/evals/src/assertions.ts:58-126                   │
  │  shape assertions ≈ integrity constraints (checked late)   │
  └────────────────────────────────────────────────────────────┘
```

And one more, the closest thing to an engine internal:

- **`CapabilityEvent`** (`packages/runtime/src/events.ts:1-24`) — an
  append-only, timestamped event log. Events are only ever pushed, never
  mutated. That is the *shape* of a write-ahead log / event-sourcing store,
  even though nothing in AptKit replays the log to rebuild state.

## Reading order

```
  00-overview.md                          the map + ranked findings + what's missing
  01-database-systems-map.md              datastore map, "query" paths, durability boundary
  02-records-pages-and-storage-layout.md  the JSON-file-as-record cost model
  03-btree-hash-and-secondary-indexes.md  why a filename sort is the only index
  04-query-planning-and-execution.md      readdir-scan-filter as the only "plan"
  05-transactions-isolation-and-anomalies.md  no transactions; the lost-update race
  06-locks-mvcc-and-concurrency-control.md     no locks; append-only sidesteps it
  07-wal-durability-and-recovery.md       fsync, torn writes, promotion-as-commit
  08-replication-and-read-consistency.md  no replicas; deterministic replay instead
  09-database-systems-red-flags-audit.md  ranked risks grounded in the repo
```

Start at `00-overview.md`. Read `01` next for the map. After that the files
stand alone, but `02 → 03 → 04` is the natural storage-engine arc and
`05 → 06 → 07 → 08` is the consistency arc.

## Cross-links to neighboring guides

The partition is sharp — a finding belongs to exactly one generator:

```
  study-data-modeling      the SHAPE of the data: the CapabilityEvent
                           discriminated union, the replay-artifact schema,
                           fixture types, schema versioning. → .aipe/study-data-modeling/

  study-database-systems   THIS GUIDE — the MECHANISMS that execute and
                           preserve reads and writes.

  study-system-design      WHICH store was chosen (filesystem) and why,
                           and how the choice scales. → .aipe/study-system-design/
```

When this guide touches "what does the artifact look like," it points at
`study-data-modeling`. When it touches "why filesystem instead of Postgres,"
it points at `study-system-design`. It does not re-teach either.
