# Vector stores — where the vectors live

**Industry names:** vector database, vector store, vector index, ANN store ·
*Industry standard*

## Zoom out, then zoom in

Once a model turns text into vectors, something has to *hold* them and answer
"which stored vectors are nearest this query?" That something is the vector store.
The choice spans a wide range — pgvector on Postgres, sqlite-vec, dedicated
engines (Pinecone, Weaviate, Qdrant, Chroma), or the humblest option: an
in-memory array you brute-force. AptKit ships exactly that humblest option,
`InMemoryVectorStore`: a `Map` of chunks and a loop that scores every one against
the query. No ANN index, no cloud, no server.

```
  Zoom out — where the store sits in AptKit (packages/retrieval)

  ┌─ Embed: OllamaEmbeddingProvider → 768-dim vectors ────────────────┐
  │       │                                                            │
  │       ▼  upsert(chunks)                                            │
  ├─ Store: InMemoryVectorStore ★ ────────────────────────────────────┤
  │   chunks: Map<id, VectorChunk>      ←── THIS CONCEPT               │
  │   search(q, k): brute-force cosine over EVERY chunk → sort → top-k │
  └───────┬────────────────────────────────────────────────────────────┘
          │  VectorHit[] (id, score, meta), ranked
  ┌─ Contract seam: VectorStore { dimension, upsert, search } ▼───────┐
  │  PgVectorStore is a drop-in here — pipeline never changes          │
  │  (PgVectorStore actually lives in the buffr repo, not aptkit)      │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: a **vector store** is two operations behind one contract — `upsert`
(put vectors in) and `search` (get the nearest `k` out). AptKit's
`InMemoryVectorStore` implements both with zero infrastructure: `upsert` drops
chunks into a `Map`; `search` runs a `for` loop computing cosine similarity
against every stored chunk, sorts descending, and slices the top `k`. That's
O(n) per query — it reads *every* vector each time. You ran the scaled version in
AdvntrCue: pgvector on Postgres, where an index answers the same question without
scanning everything. AptKit is the local-first mirror — same `search(vector, k)`
contract, brute-force underneath, honest about the scale ceiling.

## Structure pass

**Layers.** Two. The *contract* layer (`VectorStore = { dimension, upsert,
search }` — the only thing the pipeline knows) sits above the *implementation*
layer (a `Map` + a cosine loop, or pgvector + HNSW, or Pinecone's hosted index).
The pipeline talks only to the top layer; the bottom is swappable.

**Axis — how does search cost grow with corpus size?** Trace *what happens to a
query as n chunks grows* down the stack. At the contract layer, nothing changes —
`search(vector, k)` looks identical. At the implementation layer everything
changes: brute-force is O(n) (double the corpus, double the query work); an HNSW
index is roughly O(log n) (double the corpus, a few more hops). The contract hides
which one you've got — which is exactly why you can start brute-force and graduate
to ANN without touching the pipeline.

**Seam.** The load-bearing seam is the `VectorStore` contract itself. Because
`upsert` and `search` are the only surface the pipeline depends on,
`InMemoryVectorStore` today and `PgVectorStore` tomorrow are interchangeable —
`createRetrievalPipeline` neither knows nor cares which is plugged in. That seam
is what lets the scale path live in a *different repo* (buffr) without aptkit
needing to anticipate it.

## How it works

You already know the difference between scanning an array and looking something up
in a hash map. Vector search is the same tension one level harder: brute-force
search *scans* every vector for each query (simple, exact, slow at scale); an ANN
index *navigates* a precomputed graph to a near-answer (complex, approximate,
fast at scale). AptKit ships the scan; the index is the buffr scale path.

### Move 1 — the mental model

The shape: the store is a bag of vectors plus a "find nearest" operation. Two ways
to implement "find nearest" — compare against all of them (brute force), or walk a
shortcut graph that skips most of them (ANN). The contract is identical; only the
inside differs.

```
  Vector store — one contract, two insides

  PATTERN:  VectorStore { dimension, upsert(chunks), search(q, k) → hits }
                                                  │
                 ┌────────────────────────────────┴───────────────────────┐
                 ▼                                                          ▼
        BRUTE FORCE (AptKit)                            ANN INDEX (buffr / pgvector)
   for each of n chunks:                          navigate HNSW graph:
     score = cosine(q, cᵢ)                           hop nearest neighbours
   sort desc, take top-k                             ~log(n) hops, approximate
        ●─●─●─●─●─●─●  scan ALL                       ●→●→●  jump to the cluster
   exact, O(n) per query                           approximate, sub-linear
```

The brain to hold: the contract makes them interchangeable. You pick the inside by
corpus size, not by rewriting the pipeline.

### Move 2 — the step-by-step walkthrough

**Step 1 — upsert: drop the vectors into a Map.** `InMemoryVectorStore.upsert`
checks each vector's length against the store's declared dimension, then stores it
keyed by id. No index is built — the data structure is a plain hash map. Cheap to
write, nothing precomputed for search.

```
  Step 1 — upsert (in-memory-vector-store.ts:18-23)

  upsert([ {id:'doc#0', vector:[768 floats], meta}, ... ])
       │
       ▼  for each chunk:
   assertDimension(vector)  → length === 768 ?  ok  :  THROW
       │
       ▼
   chunks.set(id, chunk)        ← a Map, no index built
       │
       └──► O(1) per chunk to store; ALL the cost is deferred to search
```

The boundary that bites: deferring all work to query time is exactly why this
adapter is "zero setup" — and exactly why it doesn't scale. Nothing is precomputed,
so every query pays full price.

**Step 2 — search: brute-force cosine over every chunk.** This is the heart of the
adapter. `search` loops over *all* stored chunks, computes `cosineSimilarity`
against each, collects hits, sorts by score descending, and returns the top `k`.
The loop is O(n): a corpus of 100k chunks means 100k cosine computations per query.

```
  Step 2 — search, the brute-force scan (in-memory-vector-store.ts:25-33)

  search(q, k):
     hits = []
     for chunk of chunks.values():          ← visits EVERY chunk, no skipping
        hits.push({ id, score: cosineSimilarity(q, chunk.vector), meta })
     hits.sort((a,b) => b.score - a.score)   ← rank all n by score
     return hits.slice(0, k)                 ← keep the best k
       │
       └──► n=1000 → 1000 cosines + a 1000-element sort, every query.
            Fine. n=100k → 100k cosines + 100k sort, every query. A wall.
```

The boundary: it's *exact* — it cannot miss the true nearest neighbour, because it
looked at all of them. ANN trades that exactness for speed.

**Step 3 — swap the inside, keep the contract.** When n outgrows brute force, you
implement the same `VectorStore` contract over pgvector with an HNSW index. The
pipeline doesn't change — `createRetrievalPipeline` still calls `upsert` and
`search`. The cost model flips from O(n) exact to sub-linear approximate.

```
  Step 3 — the swap seam (contracts.ts:33-37)

  pipeline ──calls──► VectorStore { dimension, upsert, search }
                              │  same three methods
            ┌─────────────────┼──────────────────┐
            ▼                                     ▼
   InMemoryVectorStore (aptkit)        PgVectorStore (buffr repo)
   Map + brute-force cosine            Postgres + pgvector + HNSW index
   exact, O(n)                         approximate, ~O(log n)
            │                                     │
            └──── pipeline code is IDENTICAL ─────┘
```

### Move 3 — the principle

A vector store is a contract with a tunable cost model: the *interface* (`upsert`,
`search`) is fixed, the *complexity* (O(n) exact vs sub-linear approximate) is an
implementation choice you make by corpus size. AptKit ships the exact O(n) version
because at prototype scale exactness is free and infrastructure is the expense;
the moment n makes the scan a wall, you swap the implementation — not the pipeline.
The general lesson: put the expensive, scale-sensitive decision behind a narrow
contract so you can defer it until the data forces your hand.

## Primary diagram

The full store, from upsert through brute-force search to the swap seam that makes
the scale path someone else's problem.

```
  Vector store end to end — store, scan, rank, and the swap seam

  UPSERT (index time)                    SEARCH (query time)
  ┌──────────────────────┐               ┌──────────────────────┐
  │ chunks → assertDim   │               │ q vector, k          │
  │ → Map.set(id, chunk) │               │ → assertDim(q)       │
  └──────────┬───────────┘               └──────────┬───────────┘
             │ no index built                       │ for EACH chunk:
             ▼                                       ▼   cosine(q, cᵢ)   O(n)
  ┌────────────────────────────────────────────────────────────┐
  │  Map<id, VectorChunk>  ──► sort by score desc ──► slice k   │
  │                        ──► VectorHit[] (id, score, meta)    │
  └────────────────────────────────────────────────────────────┘
             │ exact, O(n) — fine < ~1000 chunks, a wall at 100k+
             ▼
  ┌─ SWAP SEAM: VectorStore contract ──────────────────────────┐
  │  PgVectorStore / HNSW (in buffr) drops in here, no pipeline │
  │  change → sub-linear approximate search at scale            │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The `rag-query` agent indexes a handful of knowledge-base docs into
`InMemoryVectorStore` and queries them mid-loop — at that scale (tens to low
hundreds of chunks) the brute-force scan is instant and the lack of any server,
index build, or cloud account is the entire point: the pipeline runs end-to-end on
a laptop. Tests use the same store with deterministic injected vectors, so ranking
is verifiable without infrastructure. The scale path — pgvector with an HNSW index
and the live corpus — lives in the separate **buffr** repo, behind the same
`VectorStore` contract; AptKit deliberately does *not* ship it.

**The brute-force scan**, `packages/retrieval/src/in-memory-vector-store.ts:25-33`
— Move 2, Step 2 in real code:

```
  packages/retrieval/src/in-memory-vector-store.ts  (lines 25-33)

  async search(vector: number[], k: number): Promise<VectorHit[]> {
    this.assertDimension(vector, 'query vector');   ← reject wrong-dim query
    const hits: VectorHit[] = [];
    for (const chunk of this.chunks.values()) {     ← scans EVERY chunk: O(n)
      hits.push({
        id: chunk.id,
        score: cosineSimilarity(vector, chunk.vector),  ← full cosine per chunk
        meta: chunk.meta,
      });
    }
    hits.sort((a, b) => b.score - a.score);         ← rank all n descending
    return hits.slice(0, Math.max(0, k));           ← keep top-k
  }
       │
       └─ No ANN index exists. Every query touches every vector and sorts the lot.
          Exact (never misses the true nearest), and O(n) — correct for small
          corpora, a wall past ~100k chunks where you need HNSW's sub-linear hops.
```

**The swap seam**, `packages/retrieval/src/contracts.ts:33-37` — the contract that
lets pgvector drop in without a pipeline change:

```
  packages/retrieval/src/contracts.ts  (lines 33-37)

  export type VectorStore = {
    dimension: number;                              ← guards the one-way door
    upsert(chunks: VectorChunk[]): Promise<void>;   ← put vectors in
    search(vector: number[], k: number):            ← get nearest k out
      Promise<VectorHit[]>;
  };
       │
       └─ This is the ONLY surface the pipeline depends on (pipeline.ts imports
          VectorStore, never InMemoryVectorStore). The class doc says it plainly:
          "PgVectorStore is a later drop-in behind the same contract — no pipeline
          change." That drop-in lands in buffr; aptkit just defines the seam.
```

## Elaborate

What does an ANN index actually buy you, mechanically? HNSW (Hierarchical
Navigable Small World) builds a layered graph where each vector links to its
nearest neighbours, with sparse "express lanes" at the top layers. A query starts
at the top, greedily hops toward the target through progressively denser layers,
and touches only a tiny fraction of the corpus — roughly O(log n) vectors instead
of all n. The cost: the result is *approximate* (it can occasionally miss the true
nearest neighbour), and you pay to build and maintain the graph at index time.
Brute force inverts every term: O(n), exact, zero index. The crossover where ANN
wins is corpus-size-dependent, but as a rule of thumb you stay brute-force into the
thousands and reach for an index before six figures.

Why does AptKit's `search` not pre-normalize and use the cheaper dot-product
shortcut? Because at in-memory scale the full cosine (dividing by magnitudes every
comparison) costs nothing measurable, and skipping normalization keeps the store
dead simple. A pgvector backend would normalize once at index time and use an
indexed dot product, because at its scale every saved multiply compounds across
millions of comparisons. The tradeoff tracks the same brute-force-vs-index axis:
optimize nothing when n is small, optimize everything when n is large.

The honest scope line: AptKit is the local-first prototype store. It is *not*
trying to be a production vector database, and pretending otherwise would be a
lie the O(n) loop exposes immediately. The contract is the bridge — it lets the
prototype and the production store (buffr's pgvector) be the same shape, so growing
up is a swap, not a rewrite.

Adjacent concepts: embeddings ([01-embeddings.md](01-embeddings.md)) make the
vectors this store holds; model choice
([02-embedding-model-choice.md](02-embedding-model-choice.md)) fixes the
`dimension` this store guards; the full pipeline
([11-rag.md](11-rag.md)) is what `search` feeds.

## Project exercises

*Provenance: Phase 2A — Retrieval foundations (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. **Case A — the store ships
(`InMemoryVectorStore` with brute-force `search`); these exercises probe its
ceiling and the swap seam.***

### Exercise — implement the PgVectorStore adapter shape (the swap seam)

- **Exercise ID:** `[B2A.5]` Phase 2A, vector-databases concept
- **What to build:** A `PgVectorStore` implementing the same `VectorStore`
  contract — `dimension`, `upsert(chunks)`, `search(vector, k)` — backed by
  Postgres + pgvector with an HNSW index. Build it against an injected query
  client so tests need no live database, and wire it into `createRetrievalPipeline`
  to prove the pipeline is untouched.
- **Why it earns its place:** It makes the swap seam concrete: the same pipeline
  runs on a brute-force store or an indexed one purely by which adapter you pass.
  *Note:* the real production version lands in the **buffr** repo; this exercise
  is the aptkit-side proof that the contract is genuinely the only coupling.
- **Files to touch:** `packages/retrieval/src/pgvector-store.ts`,
  `packages/retrieval/test/pgvector-store.test.ts`.
- **Done when:** A test proves `PgVectorStore` satisfies the `VectorStore`
  contract with an injected client, and a second proves
  `createRetrievalPipeline({ embedder, store: pgVectorStore })` indexes and queries
  with the exact same pipeline code as the in-memory store.
- **Estimated effort:** `1–4hr`

### Exercise — add an LSH approximation and measure recall@k loss

- **Exercise ID:** `[B2A.6]` Phase 2A, vector-databases (approximate search)
- **What to build:** An `ApproxVectorStore` (same contract) that buckets vectors by
  a simple LSH / random-hyperplane sign and, at search time, scans only the query's
  bucket(s) instead of every chunk. Then use the **existing** `scoreRecallAtK`
  (`packages/evals/src/precision-at-k.ts`) — treat the exact `InMemoryVectorStore`
  top-k ids as the relevant set, and score the approximate store's top-k against it
  to get `recall@k` (the fraction of the exact top-k the approximation also found).
- **Why it earns its place:** It turns the brute-force-vs-ANN tradeoff into a
  measured number: you *see* the speedup (smaller scan) and the *cost* (recall
  below 1.0). That's the core intuition behind every production ANN index, made
  hands-on against the repo's real brute-force baseline — and it reuses the
  retrieval RULER aptkit already ships rather than reinventing it.
- **Files to touch:** `packages/retrieval/src/approx-vector-store.ts`,
  `packages/retrieval/test/approx-vector-store.test.ts` (importing `scoreRecallAtK`
  from `@aptkit/evals`).
- **Done when:** A test reports `recall@k` of the LSH store vs the exact
  `InMemoryVectorStore` on a fixed corpus, and demonstrates the approximate store
  scans strictly fewer chunks per query than n.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: AptKit's vector store is a brute-force scan over a Map. When does that break,
and what's the fix?**

```
  search(q, k):  for EACH of n chunks → cosine(q, cᵢ) → sort → top-k

   n = 1000   ●●●●●●●●  1000 cosines/query   → instant, exact   ✓
   n = 100k   ●●●●●●...●●●●  100k cosines/query → a WALL         ✗
                                   │
                                   ▼  swap behind VectorStore contract
   PgVectorStore + HNSW:  ●→●→●  ~log(n) hops, approximate, sub-linear
```

"It's O(n) per query — `search` loops over every stored chunk, computes cosine,
sorts, and slices top-k, in `in-memory-vector-store.ts:25-33`. That's exact and
zero-setup, which is correct for prototype scale, low hundreds to low thousands of
chunks. It breaks past roughly 100k chunks, where scanning everything per query is
a wall. The fix is an ANN index — HNSW via pgvector — which navigates a precomputed
graph in about log(n) hops instead of scanning all n. Crucially I don't rewrite the
pipeline: `PgVectorStore` implements the same `VectorStore` contract from
`contracts.ts:33-37`, so it's a drop-in. In this codebase that scaled store
actually lives in the separate buffr repo; aptkit ships only the in-memory one and
defines the seam."
*Anchor: brute-force is O(n) exact, ANN is sub-linear approximate; the contract
makes the swap free; the scale store lives in buffr.*

**Q: Why ship the slow store at all instead of pgvector from day one?**
"Because the expense at prototype scale is infrastructure, not compute. At a few
hundred chunks the brute-force scan is instant, and `InMemoryVectorStore` needs no
Postgres, no index build, no cloud account — the whole pipeline runs on a laptop,
which is AptKit's thesis. The scale-sensitive decision is parked behind the
`VectorStore` contract, so I can defer pgvector until the data forces it and swap
without touching pipeline code. Shipping pgvector first would buy speed I don't
need and pay setup cost I can't justify yet."
*Anchor: at small n the cost is infrastructure, not compute; defer the expensive
decision behind the contract.*

## Validate

- **Reconstruct:** From memory, write the brute-force `search`: loop every chunk,
  push `{ id, score: cosine(q, c), meta }`, sort by score descending, slice top-k.
  Check it against `in-memory-vector-store.ts:25-33`.
- **Explain:** Why does `InMemoryVectorStore` build no index at `upsert` time, and
  what does that cost later? (`upsert` just does `Map.set` —
  `in-memory-vector-store.ts:18-23` — deferring all work to query time, which is
  why it's zero-setup and why every query pays full O(n) price. An ANN store pays at
  index time to make queries cheap.)
- **Apply:** Your corpus grows from 500 to 200k chunks and query latency goes from
  imperceptible to seconds. What changed, and what do you reach for? (Brute-force
  `search` is O(n); 400× the chunks is 400× the cosines and a far larger sort per
  query. Reach for an ANN index — HNSW via pgvector — implementing the same
  `VectorStore` contract so the pipeline is untouched. In this repo that adapter
  lives in buffr.)
- **Defend:** The in-memory `search` is exact while HNSW is approximate — so why is
  swapping to HNSW the right move at scale? (Exactness is free only while the scan
  is cheap. Past ~100k chunks the O(n) scan dominates latency; HNSW trades a small,
  measurable recall loss for sub-linear search, which is the right trade when
  scanning everything is the wall. The `VectorStore` contract at `contracts.ts:33-37`
  is what makes accepting that trade a one-adapter swap, not a rewrite.)

## See also

- [01-embeddings.md](01-embeddings.md) — the vectors this store holds and how cosine ranks them
- [02-embedding-model-choice.md](02-embedding-model-choice.md) — the `dimension` this store guards, and why it's a one-way door
- [03-chunking-strategies.md](03-chunking-strategies.md) — what gets stored as each chunk
- [11-rag.md](11-rag.md) — the full pipeline `search` feeds
