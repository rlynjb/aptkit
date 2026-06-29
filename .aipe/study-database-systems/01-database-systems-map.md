# The Datastore Map

**Industry name:** storage topology / datastore architecture · *Project-specific map*

## Zoom out — where the database sits

You've shipped AdvntrCue: a Next.js RAG app where pgvector and relational
data live in one Postgres instance. buffr is that same shape, pulled apart —
the toolkit (aptkit) holds the *contract*, the body (buffr) holds the
*database*. Here's the whole picture, one diagram:

```
  Zoom out — the datastore in the aptkit/buffr split

  ┌─ Application layer (buffr CLI / session) ─────────────────┐
  │  chat.tsx · index-cmd.ts · session.ts                     │
  └───────────────────────────┬───────────────────────────────┘
                              │ calls the ports
  ┌─ Contract layer (aptkit, npm @rlynjb/aptkit-core) ───▼─────┐
  │  ★ VectorStore port ★   EmbeddingProvider port            │
  │  packages/retrieval/src/contracts.ts:33                   │ ← we are here
  └───────────────────────────┬───────────────────────────────┘
                              │ implemented by
        ┌──────────────────────┴────────────────────────┐
        ▼                                                ▼
  ┌─ in-memory adapter ─┐                ┌─ Postgres adapter ──────────┐
  │ InMemoryVectorStore │                │ PgVectorStore               │
  │ Map + cosine scan   │                │ buffr/src/pg-vector-store.ts│
  │ (aptkit, the toy)   │                └──────────────┬──────────────┘
  └─────────────────────┘                               │ pg pool
                                          ┌─ Storage layer ─▼──────────┐
                                          │ Supabase Postgres+pgvector │
                                          │ agents schema, reindb DB   │
                                          └────────────────────────────┘
```

## Zoom in — what this file maps

The question this file answers: **for a read or a write in buffr, which
engine handles it, down which path, with what guarantee at the boundary?**
Not the shape of the tables (that's study-data-modeling) — the *machinery*.

## Structure pass

**Layers.** Three: the application (buffr's CLI and session), the contract
(aptkit's two ports), the storage engine (Postgres + pgvector inside
Supabase).

**Axis — trace "what guarantees the data?" down the stack.** Hold that one
question constant and watch the answer change:

```
  One question, held down the layers: "what guarantees the data?"

  ┌────────────────────────────────────────┐
  │ App layer: session.ts                   │  → nothing; trusts the port
  └────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ Contract: VectorStore.upsert/search   │  → a Promise that resolves;
      └──────────────────────────────────────┘    no durability promise in
                                                   the type
          ┌──────────────────────────────────┐
          │ Adapter: PgVectorStore            │  → begin/commit = atomic
          └──────────────────────────────────┘    per call
              ┌──────────────────────────────┐
              │ Engine: Postgres + WAL        │  → fsync'd WAL = durable
              └──────────────────────────────┘    once commit returns

  the guarantee is manufactured at the bottom and merely passed up
```

The lesson is in the contrast: the `VectorStore` **port** promises nothing
about durability — its type is just `upsert(): Promise<void>`. The real
guarantee is invented two layers down, in Postgres's WAL. The toy
(`InMemoryVectorStore`) satisfies the *same* port while promising nothing at
all — its data dies with the process. Same contract, opposite guarantee.

**Seams.** The load-bearing seam is the `VectorStore` port
(`contracts.ts:33`). The control axis flips there: above it, application
code that has no idea whether the data is in a `Map` or in Postgres; below
it, an adapter that decides everything about persistence. That seam is why
buffr can swap the toy for Postgres without touching a line of aptkit.

## How it works

### Move 1 — the mental model

Think of it like a `fetch()` behind a typed client. Your React code calls
`api.getUser()` and doesn't care whether that's a real server or a mock —
the client *is* the boundary. The `VectorStore` port is exactly that
boundary for storage: two methods, `upsert` and `search`, and everything
below is swappable.

```
  The map — two query paths through one port

         index path                    query path
         ──────────                     ──────────
  doc → chunk → embed → upsert      query → embed → search
                          │                          │
                          ▼ VectorStore port ▼
                  ┌───────────────────────────┐
                  │  upsert(chunks)           │
                  │  search(vector, k) → hits │
                  └───────────┬───────────────┘
                              ▼
                  PgVectorStore → Postgres
                  INSERT ... on conflict        SELECT ... order by <=>
                  (B-tree PK)                   (HNSW index)
```

Every read and every write in the whole system funnels through those two
methods. There is no third path.

### Move 2 — the two paths, one moving part at a time

**The write path (index).** A document gets indexed in two database hits,
and this is the seam to watch.

```
  Index path — two separate DB transactions (buffr/src/runtime.ts:11-17)

  ┌─ App ─────────┐ hop 1: INSERT documents row  ┌─ Postgres ─┐
  │ indexDocument │ ───────────────────────────► │ documents  │  TXN A
  │ Row()         │                              └────────────┘
  │               │ hop 2: pipeline.index(doc)
  │               │   → chunk → embed → upsert    ┌─ Postgres ─┐
  │               │ ───────────────────────────► │ chunks     │  TXN B
  └───────────────┘                              └────────────┘
        ▲ a crash between hop 1 and hop 2 leaves a documents
          row with zero chunks — and the dropped FK won't object
```

`indexDocumentRow` writes the `documents` row with one `INSERT`, then calls
`pipeline.index()`, which is `PgVectorStore.upsert` — a *different*
transaction. Inside `upsert`, all of one document's chunks are atomic
together (`pg-vector-store.ts:40-64`, the `begin`/`commit`). But the
documents row and its chunks are not atomic *with each other*. → walked in
full in `05`.

**The read path (query).** One SQL statement, one transaction, returns
ranked hits.

```
  Query path — one statement (buffr/src/pg-vector-store.ts:67-85)

  ┌─ App ──────┐ embed(query) ┌─ aptkit ─┐  search(vec, k)  ┌─ Postgres ──┐
  │ agent.     │ ───────────► │ pipeline │ ───────────────► │ SELECT ...  │
  │ answer()   │              └──────────┘                  │ order by <=>│
  │            │ ◄─────────────────────────── hits ──────── │ limit k     │
  └────────────┘   {id, score, meta}                        └─────────────┘
```

The `<=>` operator is pgvector's cosine **distance**; the query computes
`1 - distance` as the similarity score (`pg-vector-store.ts:69`) so it
matches the in-memory adapter's cosine *similarity*. Same numbers out of
both stores — that's what makes them interchangeable. → engine details in `04`.

### Move 3 — the principle

A datastore map is worth drawing the moment you have **more than one
implementation of one storage contract**. The instant aptkit had both
`InMemoryVectorStore` and `PgVectorStore` behind the same port, "where does
a write go and what guarantees it" stopped being obvious — the answer now
depends on which adapter is wired. The map is how you keep that straight.

## Primary diagram

The full picture: application → port → two adapters → engine, with both
query paths drawn.

```
  Database systems map — buffr/aptkit, full recap

  ┌─ Application (buffr) ─────────────────────────────────────────┐
  │  index-cmd.ts          session.ts           chat.tsx          │
  └───────┬───────────────────┬───────────────────────────────────┘
          │ index             │ query
  ┌─ Contract (aptkit) ───────▼───────────────────────────────────┐
  │  RetrievalPipeline → VectorStore port (contracts.ts:33)       │
  │     index(doc)                    query(q, k)                 │
  └───────┬───────────────────────────────┬───────────────────────┘
          │                               │
  ┌─ Adapter (buffr) ─────────────────────▼───────────────────────┐
  │  PgVectorStore.upsert         PgVectorStore.search             │
  │  begin/commit, INSERT..       SELECT.. order by <=> limit k    │
  └───────┬───────────────────────────────┬───────────────────────┘
          │ pg pool                        │ pg pool
  ┌─ Engine (Supabase Postgres + pgvector) ▼──────────────────────┐
  │  agents.documents   agents.chunks(embedding vector(768))      │
  │  B-tree PK indexes        chunks_embedding_hnsw (ANN)         │
  │  WAL · MVCC · Read Committed — all by default                 │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

This split — a vendor-neutral storage **port** in a published library, the
concrete engine in the consuming app — is the Repository/DAO pattern at the
package boundary. It's the same instinct behind your AdvntrCue Drizzle
layer, but pushed one level further: there, Drizzle was the abstraction over
one Postgres; here the abstraction (`VectorStore`) is over *two* stores that
don't even share an engine. The payoff shows up across this guide: every
time a mechanism (transactions, MVCC, WAL) is "Postgres's, not aptkit's,"
it's because the port deliberately refused to know about it.

## Interview defense

**Q: Where does aptkit store its vectors?**
In memory, in a `Map`, ranked by a cosine scan (`InMemoryVectorStore`). The
real database is in the companion repo buffr — Supabase Postgres with
pgvector — and both implement the *same* `VectorStore` port, so aptkit
itself stays deployment-agnostic.

```
  one port, two adapters: Map (toy) | Postgres (real)
```

**Q: What's the load-bearing seam in the storage layer?**
The `VectorStore` port at `contracts.ts:33`. Control over persistence flips
there — application code above knows nothing about the engine; the adapter
below decides everything. That seam is the entire reason the swap is free.

**Anchor:** "Two methods — `upsert` and `search` — are the whole storage
contract; everything else is which adapter you wired."

## See also

- `02-records-pages-and-storage-layout.md` — the `chunks` row and its `vector(768)` column.
- `04-query-planning-and-execution.md` — the two SQL statements in depth.
- `05-transactions-isolation-and-anomalies.md` — the non-atomic index seam.
- study-system-design — why Supabase was the chosen engine.
- study-data-modeling — the shape of the `agents` schema.
