# Vector databases
> ANN storage · Industry standard

You've already run one of these — pgvector in AdvntrCue. A vector database is just the thing that stores your embeddings and answers "give me the *k* closest to this query vector" fast. aptkit ships two implementations behind one contract: a from-scratch in-memory store that does a linear cosine scan (great for a prototype, O(n)), and buffr's pgvector store that uses an HNSW index for sublinear search at scale. Same `VectorStore` interface, two bodies. The swap from one to the other is the entire point of the contract — it's drop-in, and buffr proves it with shipped code.

## Zoom out, then zoom in

The vector store is the bottom of the retrieval stack — it owns the durable state and answers the only question that matters at query time.

```
where the vector store sits, and its two bodies
┌──────────────────────────────────────────────────────────┐
│  pipeline / search_knowledge_base   (vendor-agnostic)       │
└───────────────┬────────────────────────────────────────────┘
                ▼  store.upsert(chunks) / store.search(vec, k)
┌──────────────────────────────────────────────────────────┐
│  ★ VectorStore contract ★   { dimension, upsert, search }   │
└───────┬─────────────────────────────────────────┬──────────┘
        ▼ aptkit                                    ▼ buffr (SHIPPED)
┌───────────────────────┐               ┌───────────────────────────┐
│ InMemoryVectorStore   │               │ PgVectorStore             │
│ Map + cosine scan O(n)│  ◄── swap ──► │ pgvector + HNSW, SQL       │
│ zero-cloud prototype  │               │ durable, sublinear, prod   │
└───────────────────────┘               └───────────────────────────┘
```

The contract is four members. Both stores implement exactly those four, so the pipeline above never knows which one it's talking to. You develop against the in-memory store with no infra, then point the same pipeline at Postgres for production — that's the line `in-memory-vector-store.ts:7-8` makes explicit ("`PgVectorStore` is a later drop-in behind the same contract — no pipeline change").

## Structure pass

Pick the **cost** axis: what does a single `search` cost as the corpus grows?

```
cost of search(vector, k) as n chunks grows
  InMemoryVectorStore               PgVectorStore (HNSW)
  ┌──────────────────┐              ┌──────────────────────┐
  │ score EVERY chunk │              │ walk a navigable graph│
  │ O(n) cosine ops   │              │ ~O(log n) hops        │
  │ sort all, take k  │              │ index returns ~k      │
  └────────┬─────────┘              └──────────┬───────────┘
   n=100   instant                   n=100      instant
   n=10k   ~fine                      n=10k      fast
   n=10M   melts                      n=10M      still fast
           ▲ seam: this is where you MUST swap stores ▲
```

The seam is corpus size. Below ~tens of thousands of chunks, the linear scan is genuinely fine and the simplicity wins — no index to tune, no Postgres to run. Past that, scoring every chunk per query stops being free and you cross over to the indexed store. The contract is designed so crossing that seam is a wiring change, not a rewrite.

## How it works

**Move 1 — the contract is the whole design.** A vector store is two operations over a dimension-pinned space:

```
VectorStore — four members, two verbs
┌──────────────────────────────────────────────┐
│ dimension: number                ← the door    │
│ upsert(chunks: VectorChunk[]) → void  (write)  │
│ search(vector, k) → VectorHit[]       (read)   │
└──────────────────────────────────────────────┘
```

```ts
// packages/retrieval/src/contracts.ts:33-37
export type VectorStore = {
  dimension: number;                                       // carries its own dimension
  upsert(chunks: VectorChunk[]): Promise<void>;            // idempotent by chunk id
  search(vector: number[], k: number): Promise<VectorHit[]>; // ranked, top-k
};
```

That's it. Any backend that can store `{id, vector, meta}` and return the top-k by similarity satisfies it.

**Body 1 — the in-memory cosine scan.** aptkit's store is a `Map` and a loop:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:25-33
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');            // gate (file 02)
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {              // ← O(n): touch every chunk
    hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
  }
  hits.sort((a, b) => b.score - a.score);                  // sort DESC by score
  return hits.slice(0, Math.max(0, k));                    // top k
}
// cosineSimilarity (:46-57): dot/magA/magB loop, denom===0 ? 0 : dot/denom
```

```
in-memory search: brute force, exact
  query vec ──► [score vs chunk 0][score vs chunk 1]...[score vs chunk n]
                         │ sort all DESC │
                         ▼ slice(0, k)
                    top-k hits (EXACT — no approximation)
```

Note it's *exact* nearest neighbor — every chunk is scored, so the top-k is provably correct. That's the in-memory store's quiet advantage: no recall loss. The cost is O(n) per query.

**Body 2 — pgvector + HNSW (buffr, shipped).** The production store pushes the work into Postgres:

```ts
// buffr/src/pg-vector-store.ts:67-78
async search(vector: number[], k: number): Promise<Hit[]> {
  this.assertDim(vector);
  // <=> is cosine DISTANCE; similarity score = 1 - distance
  const { rows } = await this.pool.query(
    `select id, content, chunk_index, document_id, meta,
            1 - (embedding <=> $1::vector) as score      -- ← convert distance → similarity
     from agents.chunks
     where app_id = $2
     order by embedding <=> $1::vector                   -- ← HNSW index serves this ORDER BY
     limit $3`,
    [toVectorLiteral(vector), this.appId, k],
  );
  // rebuild meta so citations work identically to in-memory (:80-84)
  return rows.map((r) => ({ id: r.id, score: Number(r.score),
    meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content } }));
}
```

The index that makes the `ORDER BY` sublinear:

```sql
-- buffr/sql/001_agents_schema.sql:22-30
embedding vector(768) not null,                            -- pinned dimension (the door)
embedding_model text not null default 'nomic-embed-text:v1.5',
-- ...
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops); -- ← HNSW, cosine ops
create index if not exists chunks_app_id on agents.chunks (app_id);
```

```
HNSW = Hierarchical Navigable Small World (a navigable graph index)
   query ──► enter at top layer (few nodes, long jumps)
              │ greedily hop toward nearest
              ▼ descend layers (more nodes, shorter jumps)
              │
              ▼ bottom layer → ~k nearest neighbors
   ~O(log n) hops instead of O(n) scans — APPROXIMATE (tiny recall loss for huge speed)
```

Two things to clock. First, `<=>` is cosine *distance* (0 = identical), so the query computes `1 - distance` to get back the same similarity score the in-memory store returns — the contract returns *score*, so the SQL converts. Second, `search` rebuilds `meta` into the exact `{docId, chunkIndex, text}` shape the in-memory store produces (`:80-84`), so the `search_knowledge_base` tool's citation code (file 11) doesn't care which store it ran against. Drop-in means *behaviorally* drop-in, not just type-compatible.

**Move 3 — the principle.** The vector store is an adapter, and the contract is the load-bearing decision. Get the contract right — dimension + upsert + search returning scored hits with citation-ready meta — and you can start on a `Map`, ship on Postgres, and never touch the pipeline. The HNSW index isn't magic; it trades a sliver of recall (approximate, not exact) for log-time search. You buy that trade exactly when the linear scan stops being free, and not a day before.

## Primary diagram

```
two bodies, one contract
                    pipeline.query(q, k)
                          │
                          ▼  store.search(vec, k)
              ┌───────────┴───────────┐
              ▼                        ▼
  InMemoryVectorStore         PgVectorStore (buffr)
  ┌────────────────────┐      ┌──────────────────────────┐
  │ Map<id, chunk>      │      │ agents.chunks (Postgres)  │
  │ for-loop cosine     │      │ embedding vector(768)     │
  │ sort + slice(k)     │      │ HNSW index, <=> cosine    │
  │ EXACT, O(n)         │      │ APPROX, ~O(log n)         │
  └─────────┬──────────┘      └────────────┬─────────────┘
            ▼                                ▼
       VectorHit[]  ◄── identical shape ──►  VectorHit[]
       { id, score, meta:{docId,chunkIndex,text} }
```

Same return shape from both bodies — that identical `VectorHit` is what makes the swap invisible upstream.

## Elaborate

The storage landscape: dedicated vector DBs (Pinecone, Weaviate, Qdrant, Milvus), Postgres-as-vector-DB (pgvector — what you and buffr use), and embedded libraries (FAISS, the original from Meta). The index families: **HNSW** (graph-based, great recall/speed, more memory — buffr's choice) vs **IVFFlat** (clustered, cheaper memory, needs training, pgvector's other option). Adjacent knobs you'd tune in prod: HNSW's `m` and `ef_construction` (recall vs build cost) and `ef_search` (recall vs query latency). Bridge: in AdvntrCue you used pgvector with — most likely — IVFFlat or a flat scan; buffr's HNSW choice is the upgrade for larger corpora. Read next: `01-embeddings.md` (what's stored) and `11-rag.md` (who calls `search`).

## Project exercises

### Benchmark InMemory vs Pg on a 10k-chunk corpus

- **Exercise ID:** `EX-RAG-04a`
- **What to build:** A harness that indexes ~10k chunks into both stores, runs the same 100 queries against each, and reports p50/p95 latency and top-5 agreement (recall of HNSW vs the exact in-memory baseline).
- **Why it earns its place:** The O(n) → O(log n) crossover is theory until you watch the in-memory p95 climb while pgvector stays flat — and the recall number tells you exactly what HNSW's approximation costs. This is the measurement that justifies the swap. Phase 2B.
- **Files to touch:** new bench script under `packages/retrieval/` or `buffr/`; exercise `InMemoryVectorStore.search` (`packages/retrieval/src/in-memory-vector-store.ts:25`) vs `PgVectorStore.search` (`buffr/src/pg-vector-store.ts:67`).
- **Done when:** a report shows in-memory exact top-5 as ground truth, pgvector's recall@5 against it, and a latency crossover you can point at.
- **Estimated effort:** `1–2 days`

### Prove drop-in parity with a contract conformance test

- **Exercise ID:** `EX-RAG-04b`
- **What to build:** One test suite parameterized over both stores asserting identical `VectorHit` shape and ranking order on a fixed small corpus (use deterministic vectors).
- **Why it earns its place:** "Drop-in" is a claim until a single test runs green against both bodies. It also pins the meta-rebuild in `pg-vector-store.ts:80-84` so a schema change can't break citations silently.
- **Files to touch:** shared test alongside `packages/retrieval/src/in-memory-vector-store.ts`; import `PgVectorStore` from buffr (or a test double honoring the same SQL contract).
- **Done when:** the same assertions pass for both stores; meta carries `docId`, `chunkIndex`, `text` from each.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: When do you move off the in-memory store, and what do you lose?**

```
corpus size ──►  small: linear scan, EXACT, simple
                 large: HNSW, ~O(log n), APPROXIMATE (recall < 100%)
   you trade exact top-k for log-time search at the size where O(n) hurts
```

Anchor: the in-memory store is exact and simple but O(n); you swap to HNSW when scan cost bites, accepting a small recall loss for sublinear latency.

**Q: pgvector's `<=>` returns distance but the contract wants a score — how does that not break callers?**

```
<=> → cosine DISTANCE (0 = identical)
score = 1 - distance → cosine SIMILARITY (1 = identical)
   the SQL converts so VectorHit.score means the same thing from both stores
```

Anchor: the Pg store computes `1 - (embedding <=> q)` so its `score` matches the in-memory cosine — the contract returns similarity, and each body is responsible for producing it.

## See also

- [01-embeddings.md](01-embeddings.md) — what gets stored
- [02-embedding-model-choice.md](02-embedding-model-choice.md) — where `dimension` is enforced
- [10-incremental-indexing.md](10-incremental-indexing.md) — `upsert` on-conflict and re-indexing
- [11-rag.md](11-rag.md) — the search tool that calls into the store
