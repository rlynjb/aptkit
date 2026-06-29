# Vector databases

**Subtitle:** Vector store · ANN / similarity search storage · *Industry standard*

## Zoom out, then zoom in

The vector store is the one stateful box in the retrieval pipeline. Everything
above it is stateless glue; the store owns the corpus. aptkit ships an in-memory
implementation; buffr fills a Postgres one — both behind the same contract.

```
  Zoom out — where the store sits

  ┌─ Pipeline (stateless) ──────────────────────────────────────┐
  │  index → embed → upsert        query → embed → search        │
  └───────────────────────────┬─────────────────────────────────┘
                              │ VectorStore contract
  ┌─ Storage (stateful) ──────▼─────────────────────────────────┐
  │  ★ InMemoryVectorStore ★      |      ★ buffr PgVectorStore ★ │ ← we are here
  │  Map<id,chunk>, cosine scan   |      pgvector + HNSW index   │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You think of a vector store the way you think of a DB table — rows
you write and query — except the "query" isn't `WHERE id = ?`, it's "the k rows
*closest* to this vector." aptkit's pick is deliberate: an in-memory cosine scan
that needs zero infrastructure, with a real pgvector store as a drop-in behind the
same interface. The choice is "what's the smallest persistent thing that fills the
contract," not "which managed vector DB."

## Structure pass

**Layers.** Contract (`VectorStore`) → implementation (in-memory or pg) → physical
storage (a `Map` or a Postgres table with an HNSW index).

**Axis — cost.** What does a search cost? Trace it: in-memory = O(n) full scan over
every chunk (fine under ~10k chunks); pgvector with HNSW = approximate O(log n)
graph walk (fine into millions). The axis "is search exact or approximate?" flips
across the implementations — in-memory is exact cosine, HNSW is approximate.

**Seam.** The `VectorStore` contract (`contracts.ts:33`): `upsert(chunks)` +
`search(vector, k)` + a `dimension`. That's the entire surface. The cost/exactness
axis flips below it; nothing above it knows or cares.

## How it works

### Move 1 — the mental model

A vector store is a table where the primary lookup is "nearest neighbors," not
"exact key." You know how a DB index turns `WHERE email = ?` from a scan into a
B-tree seek? An ANN index (HNSW) does the same for "closest vector" — turns an
O(n) scan into a graph walk. The in-memory store skips the index and just scans.

```
  Two stores, one contract

  ┌─ VectorStore ──────────────────────────────────┐
  │  dimension: number                              │
  │  upsert(chunks): Promise<void>                  │
  │  search(vector, k): Promise<VectorHit[]>        │
  └───────────────┬─────────────────────┬───────────┘
        implements │                     │ implements
   ┌───────────────▼───┐       ┌─────────▼─────────────┐
   │ InMemoryVectorStore│       │ buffr PgVectorStore   │
   │ Map + cosine scan  │       │ pgvector + HNSW       │
   └────────────────────┘       └───────────────────────┘
```

### Move 2 — the two implementations

**In-memory: a Map and a cosine scan.** `InMemoryVectorStore`
(`in-memory-vector-store.ts:10`) is the zero-cloud adapter. `search` is a full scan:

```ts
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');     // fail loud on wrong dim
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {        // O(n) over the whole corpus
    hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
  }
  hits.sort((a, b) => b.score - a.score);            // rank by similarity, desc
  return hits.slice(0, Math.max(0, k));              // top-k
}
```

Exact, simple, correct, and fine until the corpus gets big. No index — every query
touches every chunk. That's the right default for "build the whole pipeline with
zero cloud."

```
  In-memory search — O(n) scan

  qv ─► for each chunk: cosine(qv, chunk.vector) ─► [0.81, 0.42, 0.77, …]
                                                         │ sort desc
                                                         ▼
                                                   slice top-k
```

**Postgres: pgvector + HNSW.** buffr's `PgVectorStore`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts:67`) implements the *same*
contract against a real index. The search is one SQL query:

```ts
async search(vector, k) {
  this.assertDim(vector);
  // <=> is cosine DISTANCE; similarity score = 1 - distance.
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score
     from agents.chunks
     where app_id = $2
     order by embedding <=> $1::vector       -- HNSW index serves this ORDER BY
     limit $3`,
    [toVectorLiteral(vector), this.appId, k],
  );
  return rows.map((r) => ({                  // rebuild the in-memory meta shape
    id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
  }));
}
```

Two things to notice. The `<=>` operator is cosine *distance*, so the score is
`1 - distance` to match the in-memory store's similarity convention. And the
returned `meta` is rebuilt to carry `docId`/`chunkIndex`/`text` — so the
`search_knowledge_base` tool's citation logic works identically on both stores.

```
  Postgres search — HNSW-indexed nearest neighbor

  qv ─► SQL: order by embedding <=> qv limit k
              │
        HNSW index (created in sql/001_agents_schema.sql:28
        using hnsw (embedding vector_cosine_ops))
              ▼
        rows ─► rebuild meta {docId, chunkIndex, text} ─► VectorHit[]
```

**The storage layout that makes the swap honest.** buffr's schema
(`sql/001_agents_schema.sql:14`) stores chunks as `embedding vector(768)` with the
HNSW index and an `app_id` partition. Crucially, `document_id` is a *soft* link
(no FK) — because the `VectorStore` contract upserts chunks with no notion of a
`documents` row, a hard FK would break drop-in parity. The schema bends to the
contract, not the other way around.

### Move 2.5 — current state vs future state

```
  Phase A (aptkit default)        Phase B (buffr, shipped)
  ┌──────────────────────┐        ┌───────────────────────────┐
  │ InMemoryVectorStore  │        │ PgVectorStore             │
  │ exact cosine, O(n)    │  same  │ approximate HNSW, O(log n)│
  │ no infra, forgets     │contract│ Supabase pg, persists     │
  │ good < ~10k chunks    │        │ good into millions        │
  └──────────────────────┘        └───────────────────────────┘
   verified live against reindb 2026-06-19 (buffr design doc)
```

### Move 3 — the principle

Don't pick a vector DB; pick a *contract*, then fill it with the smallest thing
that works. The "which managed vector store" question is the wrong one at small
scale — managed stores add latency, cost, and a network dependency you don't need
under ~100k chunks. aptkit's in-memory scan is the right default; buffr's pgvector
is the right graduation, and the agent never learns the difference.

## Primary diagram

```
  One contract, two stores, the same citations

  pipeline.query(q, k)
        │ embed q
        ▼
  store.search(qv, k) ──────────────┬───────────────────────────┐
        │                            │                           │
  ┌─ InMemory ───────────┐    ┌─ PgVector (buffr) ──────────────┐│
  │ Map<id,chunk>        │    │ agents.chunks                   ││
  │ cosineSimilarity()   │    │ embedding vector(768)           ││
  │ sort desc, slice k   │    │ hnsw (vector_cosine_ops)        ││
  │ exact, O(n)          │    │ 1 - (embedding <=> qv), limit k ││
  └──────────────────────┘    └─────────────────────────────────┘│
        │                            │                            │
        └──────────► VectorHit[] {id, score, meta{docId,text}} ◄──┘
                     identical shape → citations work on both
```

## Elaborate

The reason aptkit doesn't reach for Pinecone is the same reason AdvntrCue
co-located vectors and relational data in one Postgres: at this scale a separate
vector service is overhead, not leverage. buffr's design doc frames the whole
graduation as "fill a contract aptkit already drew, from inside buffr" — the
persistence problem became an adapter problem, not a feature. Read `11-rag.md` for
how the store fits the pipeline and `09-stale-embeddings.md` for the
`embedding_model` column that makes re-embedding safe.

## Project exercises

### Add a metadata-predicate search to the contract
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend `VectorStore.search` (or add `searchWhere`) to accept a
  metadata filter pushed into the query — in pgvector a `where meta @> $filter`,
  in-memory a post-filter — so memory recall and scoped retrieval don't have to
  over-fetch-then-filter in application code.
- **Why it earns its place:** the current contract has no metadata predicate, which
  forces the over-fetch hack in both the search tool and memory recall; closing it
  shows you can evolve a load-bearing contract without breaking either store.
- **Files to touch:** `packages/retrieval/src/contracts.ts`,
  `packages/retrieval/src/in-memory-vector-store.ts`,
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** both stores pass the same filtered-search test, and
  `conversation-memory.recall` no longer over-fetches.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "In-memory vs pgvector — when do you switch, and what changes?"**
Switch when the corpus outgrows a single-node scan (~10k+ chunks) or you need
persistence across runs. What changes is *only the store* — both implement
`VectorStore.search(vector, k)`, both return `VectorHit{id,score,meta}` with the
same rebuilt meta, so the pipeline and agent are untouched. In-memory is exact
cosine O(n); pgvector is approximate HNSW O(log n).

```
  search outgrows the scan ─► drop in PgVectorStore (same contract)
  pipeline + agent: zero changes   │   store: O(n) scan → O(log n) HNSW
```
Anchor: *pick a contract, not a vendor; the store is the only thing that swaps.*

**Q: "Why is the score `1 - (embedding <=> $1)` in the SQL?"**
pgvector's `<=>` is cosine *distance* (0 = identical, 2 = opposite); the in-memory
store returns cosine *similarity* (1 = identical). To keep one ranking convention
across both stores, the SQL converts distance back to similarity with `1 - distance`,
so a `VectorHit.score` means the same thing regardless of backend.

```
  pgvector <=>  = distance (lower = closer)
  contract score = similarity (higher = closer)  ─► score = 1 - distance
```
Anchor: *the contract promises similarity; pgvector speaks distance; convert at the boundary.*

## See also

- `11-rag.md` — the pipeline the store plugs into
- `01-embeddings.md` — what the 768-dim vector is
- `09-stale-embeddings.md` — the `embedding_model` column
- `04-agents-and-tool-use/05-agent-memory.md` — memory reuses this store
- `01-llm-foundations/08-provider-abstraction.md` — the same swap discipline for models
