# 01 · The Database Systems Map

**Industry name(s):** storage-engine topology / persistence boundary. **Type:** Project-specific (the aptkit↔buffr split).

## Zoom out, then zoom in

You already know the shape of a swappable backend from frontend work: you code against `fetch()` and the API can be REST, GraphQL, or a mock in a test — the caller never changes. This guide's whole map is that pattern applied to a *datastore*. There is one interface, `VectorStore`, and two things behind it: a JavaScript `Map` in aptkit, and Postgres in buffr.

```
  Zoom out — where the datastore sits in the stack

  ┌─ Agent layer (aptkit) ─────────────────────────────────┐
  │  RagQueryAgent → runAgentLoop → search_knowledge_base   │
  │  tool                                                   │
  └────────────────────────────┬────────────────────────────┘
                               │  pipeline.query(text, k)
  ┌─ Retrieval pipeline (aptkit) ──▼────────────────────────┐
  │  embed(query) → store.search(vector, k) → ranked hits   │
  └────────────────────────────┬────────────────────────────┘
                               │  ★ VectorStore contract ★  ← we are here
                               │  (dimension, upsert, search)
            ┌──────────────────┴───────────────────┐
  ┌─ aptkit ▼──────────────┐        ┌─ buffr ───────▼─────────┐
  │ InMemoryVectorStore    │        │ PgVectorStore           │
  │ Map<id, VectorChunk>   │        │ → Supabase Postgres     │
  │ NOT durable            │        │   + pgvector  DURABLE   │
  └────────────────────────┘        └─────────────────────────┘
```

Zoom in: the concept this file owns is the **durability boundary** — the line where data stops living in process memory and starts living on disk with a write-ahead log behind it. In aptkit that line doesn't exist (everything is RAM). In buffr it sits exactly at the `PgVectorStore` boundary. Every other concept in this guide hangs off that single line.

## The structure pass

**Layers.** Three, top to bottom: the agent/tool layer that *asks* for data, the retrieval pipeline that *shapes* the request into `embed → search`, and the store that *executes and preserves* it. The store layer is the only one that splits into two implementations.

**Axis — trace "where does the data physically live, and does it survive a restart?" down the layers:**

```
  One question down the layers: "does this survive a process restart?"

  ┌──────────────────────────────────────────┐
  │ agent / tool layer                        │  → nothing persists; pure call
  └──────────────────────────────────────────┘
  ┌──────────────────────────────────────────┐
  │ retrieval pipeline                        │  → nothing persists; pure functions
  └──────────────────────────────────────────┘
  ┌──────────────────────────────────────────┐
  │ store layer (InMemoryVectorStore)         │  → NO  — Map dies with the process
  └──────────────────────────────────────────┘
  ┌──────────────────────────────────────────┐
  │ store layer (PgVectorStore → Postgres)    │  → YES — heap + WAL on disk
  └──────────────────────────────────────────┘

  the answer flips at the store layer, and ONLY there — that flip is the durability boundary
```

**Seam.** The load-bearing boundary is the `VectorStore` contract in `packages/retrieval/src/contracts.ts:33-37`. Above it: vendor-neutral pipeline logic that never names Postgres or a Map. Below it: two implementations where the durability axis flips. The contract is what lets buffr drop Postgres in with zero pipeline change — and it's also why the schema had to drop a foreign key (see How it works).

## How it works

### Move 1 — the mental model

The shape is a single narrow interface with two implementations, where one implementation is the "build it with zero infrastructure" version and the other is the "make it durable" version. The pattern is **the repository/adapter seam**: the application depends on an abstract store, concrete stores plug in underneath.

```
  The contract seam — three methods, two implementors

                     VectorStore (the contract)
            ┌───────────────────────────────────────┐
            │  dimension: number                    │
            │  upsert(chunks): Promise<void>        │
            │  search(vector, k): Promise<VectorHit>│
            └───────────────┬───────────────────────┘
                  implements │ implements
          ┌─────────────────┴──────────────────┐
   InMemoryVectorStore                   PgVectorStore
   (aptkit, a Map)                       (buffr, Postgres)
```

The kernel here is that the contract has **exactly three things** and `upsert` takes *chunks*, not documents. That single design choice ripples all the way into the SQL schema — keep it in mind, it's the load-bearing part.

### Move 2 — the walkthrough

**The contract itself.** This is the whole database abstraction, in seven lines:

```ts
// packages/retrieval/src/contracts.ts:33-37
export type VectorStore = {
  dimension: number;                                  // the one-way door: corpus dim must match query dim
  upsert(chunks: VectorChunk[]): Promise<void>;       // write path — takes CHUNKS, not documents
  search(vector: number[], k: number): Promise<VectorHit[]>; // read path — vector in, top-k out
};
```

Notice what's *not* here: no `delete`, no `update`, no transaction handle, no `documents` concept. The store only knows about chunks (id + vector + meta). That minimalism is deliberate — and it's what forces the buffr schema decision below.

**Implementation A — the Map.** aptkit's store is a `Map` plus a linear scan:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:11-33
private readonly chunks = new Map<string, VectorChunk>();    // the entire "database"

async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);                        // upsert == Map.set (id collision overwrites)
  }
}
async search(vector: number[], k: number): Promise<VectorHit[]> {
  for (const chunk of this.chunks.values())                 // FULL SCAN — every chunk, every query
    hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
  hits.sort((a, b) => b.score - a.score);                   // sort all, then slice top-k
  return hits.slice(0, Math.max(0, k));
}
```

No index, no durability, no transaction. `upsert` is `Map.set`; "atomic" is free because JS is single-threaded and the whole op is synchronous inside one tick. This is the *control case* — a store with none of the mechanisms the rest of this guide teaches.

**Implementation B — Postgres, and the dropped FK.** buffr maps the same three methods onto SQL. Here's the schema seam that proves the contract is load-bearing:

```sql
-- buffr/sql/001_agents_schema.sql:14-27
create table if not exists agents.chunks (
  id text primary key,
  document_id text,            -- SOFT link to documents.id — deliberately NO foreign key
  app_id text not null default 'laptop',
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null,
  embedding_model text not null default 'nomic-embed-text:v1.5',
  meta jsonb not null default '{}'
);
-- Drop the FK on databases migrated before this change (idempotent).
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
```

The comment in the SQL says it plainly: *"the VectorStore contract upserts chunks with no notion of a documents row, so a hard FK would break drop-in parity."* The contract's `upsert(chunks)` can be called with chunks whose `document_id` has no matching `documents` row (memory rows do exactly this — `buffr/src/session.ts:52`). A foreign key would reject those inserts. So buffr *removed referential integrity* to preserve interface parity. That's the seam asserting itself against the schema.

**The layers-and-hops view — how a query crosses the boundary in buffr:**

```
  Layers-and-hops — a search request crossing into Postgres (buffr)

  ┌─ Pipeline (aptkit) ─┐  hop 1: store.search(vec, k)   ┌─ PgVectorStore ─┐
  │ queryKnowledgeBase  │ ──────────────────────────────►│ (buffr)         │
  └─────────────────────┘  hop 4: VectorHit[] ◄────────── └────────┬────────┘
                                                          hop 2 SQL │ over pg.Pool
                                                                    ▼
                                                          ┌─ Supabase Postgres ─┐
                                                          │ HNSW scan on        │
                                                          │ agents.chunks       │
                                                          └─────────────────────┘
                                                          hop 3: rows ▲
```

Hop 2 is where the durability boundary is crossed: above it, JS objects; below it, on-disk rows with a WAL behind them.

### Move 3 — the principle

A narrow store contract is a *commitment*: every guarantee you want (referential integrity, transactions, durability) either fits through the three methods or gets dropped. buffr chose to drop the FK rather than widen the contract — interface parity beat schema-level integrity. The general lesson: the shape of your storage interface silently decides which database features you're allowed to use.

## Primary diagram

```
  The full map — agent down to disk, both stores

  ┌─ aptkit ────────────────────────────────────────────────────────┐
  │  RagQueryAgent ─► search_knowledge_base tool ─► retrieval pipeline│
  │                                                  │ embed+search   │
  │                          ┌───────────────────────▼──────────────┐ │
  │                          │     VectorStore contract (3 methods)  │ │  ◄ the seam
  │                          └───────┬───────────────────┬──────────┘ │
  │              InMemoryVectorStore ▼                    │            │
  │              Map · full scan · NO durability          │            │
  └───────────────────────────────────────────────────────┼───────────┘
                                                            │ buffr implements
  ┌─ buffr ──────────────────────────────────────────────▼───────────┐
  │  PgVectorStore ─► pg.Pool ─► Supabase Postgres                     │
  │     agents.chunks (heap) · HNSW index · WAL · fsync   DURABLE      │
  │     agents.{documents,conversations,messages,profiles}            │
  └───────────────────────────────────────────────────────────────────┘
        ▲ durability boundary lives exactly at the pg.Pool hop
```

## Elaborate

The repository pattern is decades old; the modern twist is RAG: the "store" is a vector index, and the contract has to be narrow enough that an in-memory toy and a production pgvector instance both satisfy it. buffr's `agents` schema lives in a *shared* `reindb` database — `documents`, `chunks`, `conversations`, `messages`, `profiles`, all `app_id`-keyed (default `'laptop'`) so multiple apps can share one database, partitioned by a column rather than by separate databases. RLS (row-level security) would normally enforce that partition at the engine; here it's a plain `where app_id = $2` in application SQL (`buffr/src/pg-vector-store.ts:74`), with RLS deferred. Read next: 02 for how a chunk row physically lays out, 07 for what "durable" actually buys.

## Interview defense

**Q: You have two implementations of one store. What's the cost of that abstraction?**

```
  contract narrow enough for both  →  features that don't fit get dropped
        InMemory (Map)  ───┐
                           ├──► VectorStore: upsert(CHUNKS), no doc concept
        Postgres (pgvector)┘                  │
                                              ▼
                              FK chunks→documents had to be DROPPED
```

Answer: "The contract takes chunks, not documents — so a chunk can reference a document_id with no matching row. Postgres would reject that with a foreign key, so buffr dropped the FK (`001_agents_schema.sql:16-27`) to keep drop-in parity. The cost is real: no engine-enforced referential integrity between chunks and documents. We pay it because the same pipeline code has to run over both a Map and Postgres unchanged." Anchor: *the dropped FK is the price of the seam.*

**Q: Where is the durability boundary?**

Answer: "Exactly at the `pg.Pool` hop in `PgVectorStore`. Above it, everything is process memory — `InMemoryVectorStore` is a `Map` that dies on exit. Below it, rows are on disk with a WAL. aptkit has no boundary because it has no disk; buffr's is the one line where data starts surviving restarts." Anchor: *one line, the Pool hop.*

## See also

- `00-overview.md` — the two-store map and ranked findings.
- `02-records-pages-and-storage-layout.md` — how a chunk row is physically stored.
- `07-wal-durability-and-recovery.md` — what crossing the boundary buys.
- study-data-modeling — the schema *shape* and the dropped FK as a modeling call.
- study-system-design — *why* Supabase, and the local-first/cloud split.
