# 00 — Overview: the model in one frame

One page to orient. The data model lives in two repos joined by one
contract. Here's the whole thing before any detail.

```
  The full data model — in-memory shapes (aptkit) → relational schema (buffr)

  ┌─ aptkit: the SHAPES (packages/retrieval, packages/runtime, packages/memory) ─┐
  │                                                                              │
  │  VectorChunk           VectorHit          CapabilityEvent (union)            │
  │  ┌──────────────┐      ┌────────────┐     ┌────────────────────────────┐    │
  │  │ id   text    │      │ id   text  │     │ step | tool_call_start |    │    │
  │  │ vector num[] │      │ score num  │     │ tool_call_end | model_usage│    │
  │  │ meta  {...}  │      │ meta  {...}│     │ | warning | error          │    │
  │  └──────────────┘      └────────────┘     │ +capabilityId +timestamp   │    │
  │     contracts.ts:8        contracts.ts:15 └────────────────────────────┘    │
  │                                                events.ts:1                   │
  │  the VectorStore contract  (upsert / search)  ── implemented twice:          │
  │    InMemoryVectorStore (cosine over a Map)  ·  PgVectorStore (buffr)         │
  └──────────────────────────────┬───────────────────────────────────────────────┘
                                 │ PgVectorStore implements VectorStore
  ┌─ buffr: the SCHEMA (sql/001_agents_schema.sql) ──▼───────────────────────────┐
  │                                                                              │
  │   agents.documents              agents.chunks                                │
  │   ┌────────────────┐            ┌──────────────────────────┐                 │
  │   │ id        PK   │   soft     │ id           PK           │                 │
  │   │ app_id         │◄┄┄ link ┄┄┄│ document_id  (NO FK)      │ ← dropped FK    │
  │   │ source_type    │  (no FK)   │ app_id                    │                 │
  │   │ content        │            │ chunk_index               │                 │
  │   │ meta    jsonb  │            │ content                   │                 │
  │   │ created_at     │            │ embedding  vector(768)    │ ← HNSW index    │
  │   └────────────────┘            │ embedding_model           │                 │
  │                                 │ meta       jsonb          │                 │
  │   agents.conversations          └──────────────────────────┘                 │
  │   ┌────────────────┐                                                          │
  │   │ id        PK   │◄───── FK (on delete cascade) ──┐                         │
  │   │ app_id         │                                │                         │
  │   │ agent_name     │            agents.messages     │                         │
  │   │ created_at     │            ┌───────────────────┴──────┐                  │
  │   └────────────────┘            │ id              PK        │                 │
  │                                 │ conversation_id FK ───────┘                 │
  │   agents.profiles               │ role / content            │                 │
  │   ┌────────────────┐            │ tool_calls   jsonb        │                 │
  │   │ id  PK         │            │ tool_results jsonb        │                 │
  │   │ app_id         │            │ model / tokens_used       │                 │
  │   │ content        │            │ created_at                │                 │
  │   │ updated_at     │            └───────────────────────────┘                 │
  │   └────────────────┘                                                          │
  └──────────────────────────────────────────────────────────────────────────────┘

  legend:  ───  hard FK (DB-enforced)    ┄┄┄  soft link (app-enforced, no FK)
```

## The through-line

The data model is the most expensive thing to get wrong: code is cheap to
change, a schema with live data in it is not. This repo's central
data-modeling decision is **subordinating the schema to a swappable
contract**. The `VectorStore` interface (`packages/retrieval/src/contracts.ts:33`)
knows nothing about a `documents` table — `upsert(chunks)` takes chunks and
nothing else. So when buffr implements that contract over Postgres, it
*cannot* hard-require a parent `documents` row, because the contract never
promised one. That single fact explains the headline finding: the foreign
key on `chunks.document_id` was deliberately **dropped**
(`sql/001_agents_schema.sql:26-27`).

Two more decisions fall out of the same contract-first posture:

- **The `meta` field is a JSON bag, not columns.** `VectorChunk.meta` is
  `Record<string, unknown>` — so the durable table stores `meta jsonb`, and
  `PgVectorStore.search` *rebuilds* the in-memory `{docId, chunkIndex, text}`
  shape on read so citations work unchanged (`pg-vector-store.ts:79-84`).

- **The embedding dimension is a one-way door.** Both the in-memory store
  and `PgVectorStore` assert vector length against a fixed `dimension`
  (`vector(768)`), and the pipeline asserts at wiring time
  (`pipeline.ts:22-29`). This is the one integrity constraint enforced
  end-to-end, in code *and* in the column type.

## What's strong, what's the tension

**Strong:** every persisted row is reconstructable into the in-memory shape
the agent expects, so the `search_knowledge_base` tool's citations work
whether the store is in-memory or pgvector. The dimension constraint is
genuinely enforced (column type + runtime assert). `messages` captures a
complete, replay-ordered trajectory.

**The tension:** the schema trades normalization for drop-in parity (the
dropped FK), pushes structured facts into a `jsonb` bag, and relies on
`app_id` for tenancy with **no row-level security and no DB constraints
beyond the dimension and the two PKs/one FK shown**. These are deliberate
calls for a single-tenant laptop runtime — but they're the first things
that bite at multi-tenant scale. The audit walks each honestly.
