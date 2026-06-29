# Database Systems — Red-Flags Audit

**Industry name:** storage-engine risk register · *Project-specific audit*

> Ranked by consequence. Each verdict names its evidence. The honest framing:
> almost every risk here is "a sensible default left untouched," which is the
> right call for a single-user laptop runtime — and exactly the list you'd work
> through before it serves anyone else.

## Zoom out — where the risks cluster

```
  Zoom out — risk by layer

  ┌─ Application (buffr) ──────────────────────────────────────┐
  │  ▲ non-atomic document write (R1)                          │
  │  ▲ N+1 chunk inserts (R4)                                  │
  │  ▲ best-effort memory loss (R6, accepted)                  │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Storage engine (Postgres + pgvector) ▼────────────────────┐
  │  ▲ untuned HNSW ef_search (R3)                             │
  │  ▲ no EXPLAIN — plans unverified (R5)                      │
  │  ▲ dropped FK → silent drift (R2)                          │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Operations (Supabase, inherited) ────▼────────────────────┐
  │  ▲ untested backups / no restore drill (R7)               │
  │  ▲ RLS deferred — app_id unenforced (R8)                  │
  └────────────────────────────────────────────────────────────┘
```

## The ranked register

### R1 — Indexing a document is not atomic across its row and chunks · HIGH

**Evidence:** `buffr/src/runtime.ts:11-17` writes the `documents` row, then
calls `pipeline.index()` — `PgVectorStore.upsert` (`pg-vector-store.ts:40-64`)
— as a *separate* transaction. A crash between them leaves a `documents` row
with zero chunks.

**Consequence:** an orphan `documents` row that the search never surfaces
(search reads only `chunks`, `pg-vector-store.ts:67`). Silent because the FK is
dropped (R2). At single-user scale, fixed by re-running `index`.

**The move:** thread one transaction through `indexDocumentRow` — pass the
`client` into the pipeline so the documents row and chunks commit together.
Costs a contract change (the pipeline would take a transaction handle).
→ deep walk in `05`.

### R2 — Dropped foreign key lets documents and chunks drift · MEDIUM (deliberate)

**Evidence:** `buffr/sql/001_agents_schema.sql:16-27` — `chunks.document_id`
is a soft link, `alter table agents.chunks drop constraint if exists
chunks_document_id_fkey`. The comment is explicit: a hard FK would break
`VectorStore.upsert` drop-in parity.

**Consequence:** nothing enforces that a chunk's `document_id` points at a real
`documents` row. Memory chunks (`memory:<convId>:<n>`) rely on this — they have
no parent document (`session.ts:53`, `context.md`). The accepted cost: R1's
orphans pass silently, and a deleted document leaves dangling chunks.

**The move:** none — this is a deliberate trade (referential integrity for
contract cleanliness), correctly documented in the schema. Flagged so it's a
*known* gap, not a forgotten one. → `02`, `05`; schema rationale in
study-data-modeling.

### R3 — HNSW index untuned (`ef_search`, `m` at defaults) · MEDIUM

**Evidence:** `buffr/sql/001_agents_schema.sql:28-29` creates
`chunks_embedding_hnsw` with no `with (m = ..., ef_construction = ...)` and no
`set hnsw.ef_search` anywhere in the codebase.

**Consequence:** search recall and latency run at pgvector's defaults. At a
laptop's corpus, fine. At scale, the default `ef_search` may return a worse
top-k than the query needs (missed nearest neighbors) or be slower than
necessary — and nobody would know, because recall is never measured against a
ground truth here.

**The move:** measure recall@k against an exact-scan baseline, then raise
`ef_search` until recall is acceptable; tune build-time `m`/`ef_construction`
if write cost allows. `not yet exercised`. → `03`.

### R4 — N+1 chunk inserts on the write path · MEDIUM

**Evidence:** `buffr/src/pg-vector-store.ts:43` — `for (const c of chunks)` one
`INSERT` per chunk inside the upsert transaction.

**Consequence:** indexing a doc that chunks into N pieces is N sequential
round-trips. Atomic (good) but not batched. Invisible at laptop ingest;
the first thing to bite under bulk ingest.

**The move:** multi-row `INSERT ... values (...),(...)` or `COPY`, collapsing
N round-trips to one — inside the adapter, no contract change. → `04`.

### R5 — No `EXPLAIN` ever run; plans are inferred, not verified · MEDIUM

**Evidence:** no `EXPLAIN`/`EXPLAIN ANALYZE` anywhere in buffr; no
`pg_stat_statements` usage.

**Consequence:** nobody has confirmed the HNSW index is actually chosen for the
search query. If the opclass (`vector_cosine_ops`) and the query operator
(`<=>`) ever mismatched, search would silently fall back to a sequential scan
and just be slow — undetectable without a plan inspection. They match today
(`pg-vector-store.ts:74` vs `001_agents_schema.sql:29`), but that's read off
the code, not observed.

**The move:** one `EXPLAIN ANALYZE` on the search query — confirm an index
scan, not `Seq Scan on chunks`. Cheap, high-value. `not yet exercised`. → `04`.

### R6 — Best-effort memory write silently drops on failure · LOW (accepted)

**Evidence:** `buffr/src/session.ts:64-69` — `memory.remember()` in a
`try/catch` with a swallowed catch; the comment states the intent.

**Consequence:** a memory-write failure (Postgres hiccup) loses that
conversation memory; the turn still succeeds. At-most-once, not exactly-once.

**The move:** none — this is a deliberate durability downgrade so a
non-critical write never costs the user the answer they already have. Correct
by design; flagged so the at-most-once semantics are explicit. → `07`.

### R7 — Backups are Supabase-managed and never restored · MEDIUM

**Evidence:** no backup/restore/PITR code in either repo; `migrate.ts` is
forward-only with no down-migration or schema-version table.

**Consequence:** recovery is a hypothesis. An untested backup might not
restore; a bad migration's only rollback is a snapshot nobody has drilled.

**The move:** restore a backup into a scratch DB once and confirm row counts.
Until then the recovery plan is unverified. `not yet exercised`. → `07`.

### R8 — Row-Level Security deferred; `app_id` is unenforced · LOW (single-tenant)

**Evidence:** every table has `app_id text not null default 'laptop'`
(`001_agents_schema.sql:6,17,33,54`) but there are no RLS policies; isolation
is by an application-supplied `where app_id = $2` (`pg-vector-store.ts:74`).

**Consequence:** tenant isolation lives in the app, not the engine. With one
tenant (`'laptop'`) there's nothing to leak. The moment a second tenant shares
`reindb`, a missing `where app_id` clause anywhere would cross-read data — and
nothing at the database layer would stop it.

**The move:** enable RLS with an `app_id`-scoped policy before multi-tenant.
`not yet exercised`. → `06`; trust-boundary detail in study-security.

## Verdict

```
  Risk register — ranked

  R1  non-atomic document write        HIGH    fix: one txn through indexDocumentRow
  R2  dropped FK → drift               MED*    deliberate; documented
  R3  untuned HNSW                     MED     fix: measure recall, tune ef_search
  R4  N+1 chunk inserts                MED     fix: batch / COPY
  R5  no EXPLAIN — unverified plans    MED     fix: one EXPLAIN ANALYZE
  R6  best-effort memory loss          LOW*    deliberate; at-most-once
  R7  untested backups                 MED     fix: one restore drill
  R8  RLS deferred                     LOW     fix: RLS before multi-tenant

  * = accepted tradeoff, not a defect
```

The pattern across the register: buffr's database engineering is "lean on
Postgres + Supabase defaults, and trade a couple of guarantees on purpose for
contract cleanliness." That's correct for a single-user laptop runtime. The
two that are *real defects rather than deferred decisions* are R1 (a crash can
orphan a documents row today) and R5 (the hot query's plan has never been
verified). The rest are honest `not yet exercised` items that turn into work
the day buffr serves more than one person.

## See also

- `00-overview.md` — the three top findings and the `not yet exercised` list.
- `05-transactions-isolation-and-anomalies.md` — R1, R2 in depth.
- `03-btree-hash-and-secondary-indexes.md` — R3 in depth.
- `04-query-planning-and-execution.md` — R4, R5 in depth.
- `07-wal-durability-and-recovery.md` — R6, R7 in depth.
- study-security — R8, the tenant trust boundary.
- study-data-modeling — R2, the dropped-FK schema call.
