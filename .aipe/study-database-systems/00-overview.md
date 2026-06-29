# Study — Database Systems · Overview

> The question this guide answers: **how does the datastore execute and preserve reads and writes, and which engine guarantees does the application assume?**

## Read this first — where the database actually is

aptkit ships **no SQL database**. Its store is a JS `Map`:

```
  The datastore split — aptkit vs buffr

  ┌─ aptkit (the toolkit, deployment-agnostic) ──────────────┐
  │  the store (`InMemoryVectorStore`)                       │
  │  cosine over a Map<string, VectorChunk>                  │
  │  packages/retrieval/src/in-memory-vector-store.ts        │
  │  → no pages, no WAL, no transactions, no replication     │
  └──────────────────────────┬───────────────────────────────┘
                             │ same `VectorStore` contract
                             │ (packages/retrieval/src/contracts.ts:33)
  ┌─ buffr (the body, the real database) ──▼──────────────────┐
  │  the store (`PgVectorStore`)                             │
  │  Supabase Postgres + pgvector, HNSW index                │
  │  buffr/src/pg-vector-store.ts                            │
  │  agents schema in a shared reindb DB                     │
  │  buffr/sql/001_agents_schema.sql                         │
  │  → pages, WAL, MVCC, transactions — all real here        │
  └───────────────────────────────────────────────────────────┘
```

Every storage-engine mechanism this guide teaches — pages, B-tree vs HNSW
indexes, query execution, transactions, MVCC, WAL, replication — lives in
**buffr**, the companion repo at `/Users/rein/Public/buffr`. aptkit's
contribution to the database story is one thing: the `VectorStore` **port**
(the interface at `contracts.ts:33`) that lets the in-memory toy and the
Postgres-backed real store be the same shape. So this guide is grounded in
buffr's SQL and `pg` code, cross-referenced to aptkit's contracts.

## Ranked findings — what matters most

**1. The whole consistency story is "Postgres defaults, untouched."**
buffr never sets an isolation level, never tunes HNSW `ef_search`, never
runs `EXPLAIN`, never configures a replica. It gets Read Committed, an HNSW
index with default build/search params, and whatever Supabase's managed
Postgres does for durability and failover — all by inheritance, none by
decision. That is the right call for a single-user laptop runtime, but it
means *every* guarantee below is an assumed default, not an exercised one.
→ `05`, `06`, `07`, `08`.

**2. The dropped foreign key is the load-bearing schema decision.**
`agents.chunks.document_id` is a *soft* link with the FK deliberately
dropped (`001_agents_schema.sql:16-27`) so the `VectorStore.upsert` contract
— which knows nothing about a `documents` row — stays a clean drop-in.
This is the one place where a database-systems concern (referential
integrity) was traded away on purpose to preserve an application contract.
Memory chunks (`memory:<convId>:<n>`) exploit exactly this: they live with
no parent document. → `02`, `05`.

**3. `upsert` is atomic per document; indexing a doc is NOT.**
`PgVectorStore.upsert` wraps all of a document's chunks in one
`begin`/`commit`/`rollback` (`pg-vector-store.ts:40-64`) — so a document's
chunks land all-or-nothing. But buffr's `indexDocumentRow`
(`buffr/src/runtime.ts:11-17`) writes the `documents` row in one statement
and *then* calls `pipeline.index()` (the upsert) in a separate transaction.
A crash between them leaves a `documents` row with no chunks. The dropped FK
means nothing complains. → `05`, `07`.

## Reading order

```
  01  database-systems-map            the datastore map, engines, query paths
  02  records-pages-and-storage-layout records, pages, the vector(768) column
  03  btree-hash-and-secondary-indexes B-tree (PK) vs HNSW (the ANN index)
  04  query-planning-and-execution     the two SQL paths, scan shape, N+1
  05  transactions-isolation-anomalies atomic upsert, the non-atomic seam
  06  locks-mvcc-and-concurrency       MVCC by inheritance, upsert conflicts
  07  wal-durability-and-recovery       WAL, Supabase-managed durability
  08  replication-and-read-consistency  not exercised — single primary
  09  database-systems-red-flags-audit  ranked risks with evidence
```

## `not yet exercised` — name them honestly

These mechanisms have no code in either repo. The guide teaches the concept
and says when it would start to matter, rather than inventing evidence:

- **Query-planner tuning / `EXPLAIN`** — no plan is ever inspected. `04`.
- **Isolation levels / MVCC / WAL work** — never configured; all default. `05`, `06`, `07`.
- **HNSW `ef_search` / `m` tuning** — index created with defaults, never tuned. `03`.
- **Replication / read replicas / failover** — single Supabase primary, no replica wiring. `08`.
- **Backups / restore drills** — relies on Supabase's managed snapshots; no restore ever run. `07`.
- **Row-Level Security** — `app_id` column exists; RLS deferred (no policies). `06`, `09`.

## Cross-links to neighboring guides

```
  study-data-modeling      the SHAPE of the agents schema — tables, the
                           dropped-FK normalization call, the app_id key.
  study-database-systems   ← you are here — the MECHANISMS that execute
                           and preserve those reads and writes.
  study-system-design      WHICH datastore was chosen (Supabase) and how
                           the aptkit/buffr split scales.
  study-distributed-systems  coordination across the pg pool, the
                             best-effort memory write, partial failure.
```

When a finding is about the *shape* of the data, it belongs to
study-data-modeling and is cross-linked, not re-taught here. When it is
about *which* store and *how it scales*, it belongs to study-system-design.
