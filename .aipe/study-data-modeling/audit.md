# audit.md — the 7 data-modeling lenses, walked

Pass 1. Every lens checked against both repos. Findings cite real files;
`not yet exercised` is named honestly. Significant patterns cross-link to a
dedicated file rather than restate.

---

## 1. the data model and its shape

Two models joined by one contract. The full picture is drawn in
`00-overview.md`; the short version:

- **In-memory shapes (aptkit).** `VectorChunk {id, vector:number[], meta}`
  and `VectorHit {id, score, meta}` (`packages/retrieval/src/contracts.ts:8,15`);
  the `CapabilityEvent` discriminated union — `step | tool_call_start |
  tool_call_end | model_usage | warning | error`, each carrying
  `capabilityId` + ISO `timestamp` (`packages/runtime/src/events.ts:1-24`);
  memory rows `MemoryTurn`/`MemoryHit` with id `memory:<conversationId>:<n>`
  and `meta:{kind, conversationId, text}`
  (`packages/memory/src/conversation-memory.ts:80-86`).

- **Relational schema (buffr).** Five tables in the `agents` schema:
  `documents`, `chunks`, `conversations`, `messages`, `profiles`
  (`sql/001_agents_schema.sql`). The model *is* discernible and real —
  this is not "everything in one JSON blob." The entities are documents,
  their chunks, conversations, the messages in them, and a per-app profile.

No red flag here: the data has real structure and the schema reflects it.
The interesting parts are *how* normalized it is (lens 2) and what's
enforced (lens 4).

---

## 2. normalization and duplication

This is where the model deviates from textbook normal form, **on purpose**.

- **The soft FK (`chunks.document_id`).** A `chunk` logically belongs to a
  `document`, but the foreign key was deliberately dropped
  (`sql/001_agents_schema.sql:14-27`) so the `VectorStore` contract can
  upsert a chunk with no parent row. → **see
  `01-soft-fk-for-drop-in-parity.md` for the full walk.**

- **`meta jsonb` as a denormalized bag.** `chunks` has both first-class
  columns (`document_id`, `chunk_index`, `content`) *and* a `meta jsonb`
  column, and on read `PgVectorStore.search` *rebuilds* a `{docId,
  chunkIndex, text}` object from the columns — so the same facts exist as
  columns and (potentially) inside the bag (`pg-vector-store.ts:44-46,
  79-84`). This is duplication-for-drop-in: the in-memory shape needs the
  bag; the SQL schema promotes the hot fields to columns for indexing.
  → **see `02-metadata-as-a-json-bag.md`.**

- **Memory and documents share one collection.** A memory row and a
  document chunk are the same physical `chunks`-table row, distinguished
  only by `meta.kind` (`conversation-memory.ts:84`). One table, two logical
  entities, partitioned by a tag — denormalized on purpose so memory
  surfaces through the existing search tool. → **see
  `03-kind-tag-shared-collection.md`.**

Verdict: the denormalization is deliberate and documented in the SQL
comments, not accidental. The cost — a fact editable in two places (a
chunk's `document_id` can point at a `documents.id` that doesn't exist,
because nothing enforces it) — is real and named in `01`.

---

## 3. indexing vs query patterns

The indexes match the queries that actually run.

- **HNSW index on `embedding`** (`sql/001_agents_schema.sql:28-29`,
  `using hnsw (embedding vector_cosine_ops)`). Every retrieval query is a
  cosine nearest-neighbour scan: `order by embedding <=> $1::vector limit $3`
  (`pg-vector-store.ts:70-77`). The `<=>` operator is cosine distance; the
  index supports exactly this ordering. Hot path, supporting index. Good.

- **B-tree index on `app_id`** (`sql/001_agents_schema.sql:30`). Every
  query filters `where app_id = $2` (`pg-vector-store.ts:74`,
  `profile.ts:6`). Index matches the predicate.

- **The `messages.conversation_id` FK** is the read path for a conversation's
  trajectory, but there is **no explicit index on it** — Postgres does not
  auto-index FK columns. For a single-tenant laptop runtime this is fine;
  at scale a `select ... where conversation_id = $1` would seq-scan.
  Naming it: missing index on a foreseeable query path. Low severity now.

- **No N+1 in the persistence layer.** `upsert` batches all chunks inside
  one transaction in a loop (`pg-vector-store.ts:43-57`) — that's N inserts
  in one transaction, not N round-trips with N transactions, but it *is* a
  per-row `client.query` rather than a single multi-row insert. For a
  handful of chunks per document this is a non-issue; a large backfill would
  want a single multi-VALUES insert or `COPY`.

---

## 4. transactions and integrity

What the database guards vs what hopeful app code guards.

- **DB-enforced:** three primary keys (`documents.id`, `chunks.id`,
  `conversations.id`/`messages.id`/`profiles.id`), one foreign key
  (`messages.conversation_id references agents.conversations(id) on delete
  cascade`, `sql/001_agents_schema.sql:42`), `not null` on the load-bearing
  columns, and the `vector(768)` column type which rejects a wrong-length
  embedding. The cascade is the one real referential-integrity guarantee:
  delete a conversation and its messages go with it.

- **Atomicity is used where it matters.** `upsert` wraps its inserts in
  `begin`/`commit` with `rollback` on error (`pg-vector-store.ts:40-64`);
  `runMigration` runs the whole schema script in one transaction
  (`migrate.ts:10-19`). A partial upsert can't leave half a document
  indexed.

- **The dimension constraint is enforced in three places:** the column type
  `vector(768)`, `PgVectorStore.assertDim` (`pg-vector-store.ts:32-36`), and
  the pipeline's `assertWiring` (`pipeline.ts:22-29`). → **see
  `04-embedding-dimension-one-way-door.md`.** This is the strongest
  invariant in the model.

- **Hopeful-app-code integrity:** the `chunks.document_id → documents.id`
  link is enforced *nowhere* (the FK was dropped). `meta.kind = 'memory'`
  partitioning is enforced only in `conversation-memory.ts` filter logic,
  not the DB. `role` in `messages` is free `text`, not a check constraint or
  enum — any string is a valid role. These are invariants the DB does not
  guard.

- **No CHECK constraints, no UNIQUE beyond PKs, no enums.** Honest gap:
  there are no DB constraints beyond what's shown above.

---

## 5. migrations and evolution

- **One idempotent forward migration.** `sql/001_agents_schema.sql` is all
  `create ... if not exists` plus one `alter table ... drop constraint if
  exists` (`:27`) — re-runnable safely. `migrate.ts` reads the one file and
  runs it in a transaction (`migrate.ts:23-32`).

- **The dropped-FK migration is the one real schema evolution.** The
  `alter table agents.chunks drop constraint if exists chunks_document_id_fkey`
  line exists specifically to migrate databases created *before* the FK was
  removed — idempotent, safe under live data, no backfill needed (dropping a
  constraint touches no rows). This is a textbook-correct evolution step.
  → walked in `01-soft-fk-for-drop-in-parity.md`.

- **No down-migrations / no rollback scripts.** There is no
  `002_*_down.sql`; reversing the schema is manual. For a single-file
  laptop schema this is acceptable, but `not yet exercised` as a discipline.

- **No retention / archival / partitioning of `messages`.** The trace table
  grows unbounded — every event of every turn becomes a row
  (`supabase-trace-sink.ts:53-85`). No TTL, no partition-by-month. `not yet
  exercised`.

---

## 6. access patterns and storage choice

- **Vector-shaped reads, relational-shaped writes.** The dominant read is
  "embed a query, find the k nearest chunks for this app_id" — a
  vector-similarity access pattern, served correctly by pgvector + HNSW. The
  writes are relational rows. pgvector-in-Postgres is the right call: it
  puts the vector index and the relational metadata in *one* store, so a
  chunk's embedding and its `document_id`/`content` are colocated — no
  separate vector DB to keep in sync.

- **Document-shaped flexibility inside a relational table.** The `meta jsonb`
  column is the document-database escape hatch inside Postgres: arbitrary
  per-chunk metadata with no migration. The schema doesn't fight the access
  pattern — it uses `jsonb` exactly where the shape is open
  (`02-metadata-as-a-json-bag.md`).

- **In-memory adapter for the zero-infra path.** `InMemoryVectorStore` does
  a full cosine scan over a `Map` (`in-memory-vector-store.ts:25-32`) —
  O(n) per query, fine for tests and Studio's in-browser demo, swapped for
  HNSW in production via the same contract. The storage choice tracks the
  deployment: Map for tests, pgvector for the laptop runtime.

No red flag: the storage shape matches the access shape on both sides.

---

## 7. data-modeling red-flags audit (capstone)

```
  checklist                                        this repo
  ─────────────────────────────────────────────   ─────────────────────────
  everything in one JSON blob / one table          NO — 5 real tables
  same fact editable in two places                 PARTIAL — chunks.meta vs
                                                     columns; doc_id soft link
  frequent query with no supporting index          MINOR — messages.
                                                     conversation_id unindexed
  N+1 query loop                                    NO (upsert is one txn;
                                                     per-row insert, low N)
  multi-write with no transaction                  NO — upsert + migrate
                                                     are transactional
  invariant only in app code, DB doesn't guard     YES — doc_id link, kind
                                                     tag, message role
  destructive migration, no rollback               NO — only idempotent
                                                     create + drop-constraint
  column drop with no backfill plan                N/A — FK drop needs none
  no down-migrations                                YES — none exist
  no retention on an unbounded log table            YES — messages grows
                                                     forever
  multi-tenant data with no RLS                     YES — app_id only, no RLS
                                                     → study-security
```

**Ranked, worst tension first:**

1. **The dropped FK / soft link** (`01`) — the deliberate denormalization
   that defines the whole model. Highest-leverage to understand.
2. **`meta jsonb` bag + rebuild-on-read** (`02`) — duplication of facts
   across columns and bag; the citation contract depends on it.
3. **`app_id` tenancy with no RLS** (`05`) — fine for one laptop, the first
   thing to fix before multi-tenant.

**`not yet exercised`:** down-migrations; `messages` retention/partitioning;
any CHECK/UNIQUE/enum constraints; row-level security; a dedicated index on
`messages.conversation_id`; bulk-load (`COPY`/multi-row insert) on the index
path.
