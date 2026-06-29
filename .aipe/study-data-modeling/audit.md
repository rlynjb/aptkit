# audit.md — the 7-lens data-modeling audit

Pass 1. Walk the data-modeling lens inventory against this repo's *actual*
persistence: aptkit's in-memory shapes and buffr's `agents` Postgres
schema. Each lens names what's there with `path:line` grounding, or emits
`not yet exercised` honestly. Significant findings cross-link to a pattern
file rather than restating it.

The two-pass discipline (this audit + the discovered pattern files) comes
from `me.md` → AUDIT-STYLE GENERATORS.

---

## 1. The data model and its shape

There are two models bridged by one contract.

**aptkit (in-memory, vendor-neutral).** Defined as TypeScript types, not
tables:

- `VectorChunk {id, vector:number[], meta:Record}` and
  `VectorHit {id, score, meta}` —
  `packages/retrieval/src/contracts.ts:8-19`. The store contract itself
  (`upsert` / `search` + a `dimension`) is `contracts.ts:33-37`.
- Memory rows reuse the chunk shape: id `memory:<conversationId>:<n>`,
  `meta={kind:'memory', conversationId, text}` —
  `packages/memory/src/conversation-memory.ts:80-86`.
- The persisted trace shape `CapabilityEvent` — a discriminated union of
  `step | tool_call_start | tool_call_end | model_usage | warning |
  error`, each carrying `capabilityId` + ISO `timestamp` —
  `packages/runtime/src/events.ts:1-24`.

**buffr (relational, durable).** Five tables in
`/Users/rein/Public/buffr/sql/001_agents_schema.sql`: `documents`,
`chunks` (pgvector column + HNSW), `conversations`, `messages`,
`profiles`. The model is discernible and real — this is not "everything
in one JSON blob." → the full schema diagram is in `00-overview.md`.

**The shape verdict:** chunks is the center of gravity. It's a vector
table dressed as a relational row, shaped to satisfy the
aptkit `VectorStore` contract. → see `01-dropped-fk-for-drop-in-parity.md`.

## 2. Normalization and duplication

**Deliberate denormalization, contract-driven.** A chunk's facts are
stored twice: once as typed columns (`content`, `chunk_index`,
`document_id`) and once inside the `meta` jsonb bag. On read,
`PgVectorStore.search` *rebuilds* the in-memory `meta` shape
(`{docId, chunkIndex, text}`) from the typed columns —
`/Users/rein/Public/buffr/src/pg-vector-store.ts:80-84`. The duplication
is intentional: typed columns get indexed/queried; the `meta` bag honors
the contract's `Record<string,unknown>`. → `02-metadata-as-json-bag.md`.

**Soft-linked, not normalized away.** `chunks.document_id` references the
same id space as `documents.id`, but with no FK — so a chunk can exist
with no parent document row (e.g. memory rows, or chunks upserted via the
raw `VectorStore` contract). → `01-dropped-fk-for-drop-in-parity.md`.

**No editable-fact-in-two-places hazard.** `documents.content` is the
source of truth; `chunks.content` is a derived copy written only by the
index path (`buffr/src/runtime.ts:11-17`). The copy is never edited
independently, so the classic information-leak red flag does not fire here.

## 3. Indexing vs query patterns

Two indexes on `chunks`, both matching a real query:

- `chunks_embedding_hnsw` (`hnsw … vector_cosine_ops`) — schema line 28-29.
  The hot query is the cosine-distance ORDER BY in
  `PgVectorStore.search` (`pg-vector-store.ts:70-78`): `order by embedding
  <=> $1::vector limit $3`. HNSW is the index that makes that an ANN
  lookup instead of a full-table cosine scan.
- `chunks_app_id` (btree) — schema line 30. The same search filters
  `where app_id = $2`, so the tenant filter has support.

**No N+1 in the index path.** `upsert` batches all chunks inside one
transaction loop (`pg-vector-store.ts:42-58`) — one connection, one
`begin`/`commit`, one insert per chunk. It's a loop of inserts, not a
loop of round-trips fanned across connections.

**`profiles` and `conversations` are unindexed beyond their PKs.**
`loadProfile` does `order by updated_at desc limit 1` with no index on
`updated_at` (`buffr/src/profile.ts:5-7`). At laptop scale (a handful of
profile rows per app) that's a non-issue; named here for honesty, not
alarm. → `03` covers the vector side; this profile scan is the one place
a query outruns its index, and it doesn't matter yet.

## 4. Transactions and integrity

**Where atomicity exists:** `PgVectorStore.upsert` wraps the whole chunk
batch in `begin`/`commit` with `rollback` on error
(`pg-vector-store.ts:40-64`) — a partial corpus is never half-committed.
`runMigration` runs the entire schema file in one transaction
(`buffr/src/migrate.ts:8-20`).

**Where integrity is enforced by the DB:** `not null` on
`chunks.embedding`, `content`, `chunk_index`; PK uniqueness on `id`; the
single *real* FK is `messages.conversation_id → conversations.id on
delete cascade` (schema line 42).

**Where integrity is enforced only by hopeful app code (the gap):**
- The dimension invariant. `vector(768)` guards the column length, but
  the deeper "embedder dim must equal store dim" rule lives in
  `assertWiring` (`retrieval/src/pipeline.ts:22-29`) and
  `PgVectorStore.assertDim` (`pg-vector-store.ts:32-36`).
  → `03-embedding-dimension-one-way-door.md`.
- `meta.kind` partitioning. Nothing in the DB knows a "memory" row from a
  "document" row; `recall` filters client-side
  (`conversation-memory.ts:96-105`). → `05-kind-tag-logical-partition.md`.
- No CHECK constraints anywhere. No `(document_id, chunk_index)` unique
  pair. `role` in `messages` is free text, not an enum.

## 5. Migrations and evolution

**One forward-only SQL file, idempotent by construction.** Every
statement in `001_agents_schema.sql` is `create … if not exists` /
`create index if not exists`, so re-running the file is safe. `migrate.ts`
reads that one file and runs it in a transaction (`migrate.ts:23-32`).

**The one real schema *change* shipped is itself a teaching case.** The FK
on `chunks.document_id` was dropped, and the migration carries the change
as `alter table agents.chunks drop constraint if exists
chunks_document_id_fkey` (schema line 27) — idempotent, so it's a no-op on
fresh databases and a real change on already-migrated ones. That's the
zero-downtime-safe way to retract a constraint. → `01`.

**Gaps:** no version table, no down-migrations, no numbered migration
runner beyond the single file, no backfill tooling. New columns would have
to be additive-and-nullable to stay safe under live data (which they
currently are — every column has a default or is nullable). `not yet
exercised`: any destructive column drop, any data backfill.

## 6. Access patterns and storage choice

**Relational + vector colocated in one Postgres, matching the access
shape.** The read pattern is "embed a query, ANN-search chunks filtered by
tenant, return ranked rows with citations" — exactly what the
`chunks` table + HNSW + `app_id` btree serve. The write pattern is
"index a document → chunk → embed → batch-upsert" — served by the
transaction in `upsert`. Storage shape matches access shape; no relational
schema fighting a document-shaped access pattern here.

**The `meta` jsonb is the document-shaped escape hatch** inside the
relational table — flexible per-chunk metadata without a migration per
new field. → `02-metadata-as-json-bag.md`.

**Memory and documents share one collection by design**, partitioned only
by the `meta.kind` tag — a logical, not physical, separation.
→ `05-kind-tag-logical-partition.md`.

**`agents.messages` is an append-only trajectory log**, not mutable
domain state — every `CapabilityEvent` variant becomes a row.
→ `06-trace-as-append-only-log.md`.

## 7. Data-modeling red-flags audit (capstone checklist)

```
  red flag                                    this repo
  ─────────────────────────────────────────  ──────────────────────────
  everything in one JSON blob / one table     NO — 5 typed tables
  same fact editable in two places             NO — chunk copy is derived,
                                                    never edited alone
  a hot query with no supporting index         NO on vector path (HNSW +
                                                    app_id); minor on
                                                    profiles.updated_at (06/§3)
  N+1 query in app code                         NO — upsert batches in one txn
  multi-write op with no transaction            NO — upsert & migrate wrapped
  invariant only in app code, DB doesn't guard  YES — dimension rule (03),
                                                    kind partition (05),
                                                    no CHECKs/unique pairs (§4)
  destructive migration with no rollback        NOT YET — only an idempotent
                                                    constraint drop shipped (01)
  FK that should exist but doesn't              YES, DELIBERATE — the dropped
                                                    chunks→documents FK (01)
  tenancy with no enforcement boundary          YES — app_id, no RLS (04)
```

The two YES rows that are *deliberate* (the dropped FK, the app-code
dimension guard) are the interesting ones — each bought a real capability
(drop-in `VectorStore` parity; fail-loud-at-wiring). The one YES that's a
genuine deferred risk is RLS → `04-app-id-tenancy-without-rls.md`.
