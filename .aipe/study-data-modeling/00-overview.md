# 00 — Overview: the schema as built

One page. The whole data model in one diagram, then the verdict on what's
worth studying.

## The schema, drawn from the live DDL

Every box below is a real table in `/Users/rein/Public/buffr/sql/001_agents_schema.sql`,
plus the two aptkit in-memory shapes the schema implements.

```
  agents schema (buffr) + the aptkit shapes it serves
  ── Storage layer (Postgres + pgvector) ──────────────────────────────

  ┌─ agents.documents ──────────┐        ┌─ agents.profiles ───────────┐
  │ id            text  PK      │        │ id          uuid PK         │
  │ app_id        text  ='laptop'│       │ app_id      text ='laptop'  │
  │ source_type   text          │        │ user_id     text            │
  │ source_path   text          │        │ content     text  (me.md)   │
  │ content       text          │        │ updated_at  timestamptz     │
  │ meta          jsonb         │        └─────────────────────────────┘
  │ created_at    timestamptz   │
  └──────────────┬──────────────┘
                 ┊  document_id   ← SOFT link: NO foreign key
                 ┊  (dashed = no DB-enforced reference; see 01)
  ┌─ agents.chunks ─▼───────────┐        ┌─ agents.conversations ──────┐
  │ id            text  PK      │        │ id          uuid PK         │
  │ document_id   text (soft)   │        │ app_id      text ='laptop'  │
  │ app_id        text  idx     │◄─┐     │ user_id     text            │
  │ chunk_index   int           │  │     │ agent_name  text            │
  │ content       text          │  │     │ created_at  timestamptz     │
  │ embedding   vector(768) HNSW│  │     └──────────────┬──────────────┘
  │ embedding_model text         │  │ app_id            │ FK (real, cascade)
  │ meta          jsonb         │  │ filter   ┌─ agents.messages ─▼────┐
  └─────────────────────────────┘  │         │ id            uuid PK   │
                                    │         │ conversation_id uuid FK │
  indexes: chunks_embedding_hnsw    │         │ role          text      │
           (hnsw vector_cosine_ops) │         │ content       text      │
           chunks_app_id (btree) ───┘         │ tool_calls    jsonb     │
                                              │ tool_results  jsonb     │
                                              │ model / tokens_used     │
                                              │ created_at  timestamptz │
                                              └─────────────────────────┘

  ── aptkit contract these tables implement (in-memory shapes) ─────────
  VectorChunk {id, vector:number[], meta}   ← chunks row maps to this
  VectorHit   {id, score, meta}             ← search() returns this
```

## The verdict — what's load-bearing here

Read these first, in this order:

1. **The dropped FK (01)** is the single most important modeling
   decision in the repo. `chunks.document_id` *looks* like it should
   reference `documents.id`, but the FK was deliberately removed — and
   the DDL even runs an idempotent `drop constraint if exists` to undo
   it on already-migrated databases. The reason is the whole thesis of
   the repo: the table must be a drop-in `VectorStore`, and the
   contract's `upsert` knows nothing about documents.

2. **Metadata-as-JSON-bag (02)** is the second. The same fact lives
   twice — once in a typed column (`content`, `chunk_index`,
   `document_id`) and once inside the `meta` jsonb. `PgVectorStore.search`
   *rebuilds* the in-memory `meta` shape from the typed columns on the
   way out so citations work unchanged. That's deliberate denormalization
   to honor a contract.

3. **The dimension one-way-door (03)** is the strongest integrity
   constraint in the system — and it's enforced in app code
   (`assertWiring`, `assertDim`), not by the database. `vector(768)` is
   a column-level guard; the deeper "you can't search a corpus embedded
   at a different dimension" invariant lives in TypeScript.

The rest (`app_id` tenancy without RLS — 04; the `kind` logical
partition over a shared collection — 05; `agents.messages` as an
append-only trajectory log — 06) are real patterns worth a file each,
but they hang off these three.

## Honest gaps (`not yet exercised`)

- **No relational integrity beyond what's shown.** No CHECK constraints,
  no NOT NULL on the soft `document_id`, no unique constraint pairing
  `(document_id, chunk_index)`. The DB guards almost nothing; app code does.
- **RLS deferred.** `app_id` is a plain column. Row-level security is
  *not exercised* — any connection sees every app's rows. → see 04.
- **No migration framework / versioning.** One SQL file, run in one
  transaction by `migrate.ts`. No down-migrations, no version table,
  no backfill tooling. → see audit.md, migrations lens.
