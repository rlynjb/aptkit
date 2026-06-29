# Study — Database Systems · Overview

The question this guide answers: **how does the datastore execute and preserve reads and writes, and which engine guarantees does the application assume?**

aptkit itself ships no SQL database. Its store is `InMemoryVectorStore` — cosine similarity over a JavaScript `Map`, scanned linearly (`packages/retrieval/src/in-memory-vector-store.ts:10-43`). The real database lives in the **companion repo buffr** (`/Users/rein/Public/buffr`): `PgVectorStore` against **Supabase Postgres + pgvector**, an `agents` schema in a shared `reindb` database (`buffr/sql/001_agents_schema.sql`), an **HNSW** index on a `vector(768)` column, and an `upsert` wrapped in `begin/commit/rollback`.

So this guide reads two engines at once, behind one contract:

```
  Two stores, one VectorStore contract

  ┌─ aptkit (this repo) ───────────────────────────────────┐
  │  InMemoryVectorStore                                    │
  │   storage : a JS Map<string, VectorChunk>               │
  │   index   : none — full linear scan every query         │
  │   durable : no (process memory, lost on exit)           │
  │   txn     : none (single-threaded JS, no concurrency)   │
  └────────────────────────────┬────────────────────────────┘
                               │  same VectorStore interface
                               │  (contracts.ts:33-37)
  ┌─ buffr (companion repo) ───▼────────────────────────────┐
  │  PgVectorStore → Supabase Postgres + pgvector           │
  │   storage : agents.chunks heap, vector(768) column      │
  │   index   : HNSW (vector_cosine_ops) + b-tree on app_id │
  │   durable : yes — WAL, fsync, Supabase-managed          │
  │   txn     : begin/commit/rollback per upsert (atomic)   │
  └─────────────────────────────────────────────────────────┘
```

That seam — the same three-method `VectorStore` interface (`dimension`, `upsert`, `search`) implemented once over a Map and once over Postgres — is the spine of every concept file here. Most database-systems mechanisms (indexes, transactions, WAL, MVCC, replication) exist only on the buffr side. aptkit's side is the control: it shows what a store looks like with *none* of them, which is exactly why the mechanisms matter.

## Ranked findings

1. **The whole point is drop-in parity, and it holds.** `PgVectorStore` (`buffr/src/pg-vector-store.ts:19`) implements the identical `VectorStore` contract as `InMemoryVectorStore`. buffr's session wires Postgres into the exact pipeline aptkit wrote for the Map (`buffr/src/session.ts:41`). The strongest evidence: the **FK from `chunks` to `documents` was deliberately dropped** (`buffr/sql/001_agents_schema.sql:16-27`) because the contract's `upsert(chunks)` has no notion of a documents row — a hard FK would have broken parity. That is a real schema decision driven by an interface boundary. → 01, 02.

2. **The query path leans entirely on one HNSW index, used on defaults.** Every search is `order by embedding <=> $1::vector limit $3` (`buffr/src/pg-vector-store.ts:70-77`) — an approximate-nearest-neighbor scan over the HNSW index built in `buffr/sql/001_agents_schema.sql:28-29`. HNSW `ef_search`/`ef_construction` are **not tuned** (defaults), and the `app_id` filter rides a separate b-tree, not the HNSW index — the planner's interaction of the two is `not yet exercised` by any `EXPLAIN`. → 03, 04.

3. **Atomicity is per-document; isolation, MVCC, recovery, and replication are inherited from Postgres defaults, not exercised by the code.** The `upsert` loop is wrapped in one transaction so a multi-chunk document lands all-or-nothing (`buffr/src/pg-vector-store.ts:40-65`). Beyond that single boundary the code assumes Postgres defaults: READ COMMITTED isolation, MVCC snapshots, WAL durability, Supabase-managed backups and replicas — none configured, tuned, or tested in either repo. → 05, 06, 07, 08.

## Reading order

```
  00  overview                          ← you are here
  01  database-systems-map              the two stores, the contract seam, durability boundary
  02  records-pages-and-storage-layout  rows, the heap, vector(768) layout, locality
  03  btree-hash-and-secondary-indexes  HNSW (ANN) vs b-tree, write cost, index selection
  04  query-planning-and-execution      the search query, scans, N+1, EXPLAIN (absent)
  05  transactions-isolation-and-anomalies   per-upsert atomicity, READ COMMITTED
  06  locks-mvcc-and-concurrency-control      row locks, MVCC, retries (not exercised)
  07  wal-durability-and-recovery        fsync, WAL, the in-memory store's zero durability
  08  replication-and-read-consistency   replicas, lag, stale reads (not exercised)
  09  database-systems-red-flags-audit   ranked risks with evidence
```

Read 01 → 02 → 03 → 04 in order — they build the storage-then-index-then-query stack. 05–08 are the preserve-the-writes half and can be read independently. 09 is the verdict.

## `not yet exercised` topics

These mechanisms are real in Postgres but **not configured, tuned, or tested** by either repo's code. The guide teaches them and names exactly where they would attach:

- **Query planner tuning / `EXPLAIN`** — no `EXPLAIN ANALYZE` anywhere; HNSW `ef_search` left at default (04).
- **Isolation levels beyond READ COMMITTED** — no `set transaction isolation level`, no `serializable`, no `select ... for update` (05, 06).
- **MVCC / vacuum / bloat** — `on conflict do update` churns row versions; no vacuum strategy named (06).
- **WAL configuration / PITR / restore drills** — durability is whatever Supabase defaults give; no tested restore path (07).
- **Replication / read replicas / failover / stale-read handling** — single connection pool, one endpoint, no replica routing (08).
- **RLS** — `app_id` is a plain column filter in application SQL; row-level security is deferred (noted in 01, 09).

## Cross-links to neighboring guides

- **study-data-modeling** — the *shape* of the `agents` schema (normalization, the dropped FK as a modeling decision, the `meta` jsonb): `.aipe/study-data-modeling/`.
- **study-system-design** — *which* datastore was selected and how it scales (Supabase choice, local-first vs cloud): `.aipe/study-system-design/`.
- **study-distributed-systems** — coordination under partial failure, the best-effort memory write, trace-sink flush race: `.aipe/study-distributed-systems/`.
