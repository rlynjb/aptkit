# Linear Vector Scan

*Industry names: brute-force / flat / exact nearest-neighbor search, full
cosine scan. Type: Industry standard (the baseline every ANN index is
measured against).*

## Zoom out, then zoom in

You've got a query vector and a pile of stored chunk vectors. To rank them
by relevance you compare the query against *every* stored vector, score
each, sort, and take the top-k. That's the whole search. It's correct,
it's trivial to read, and its cost grows linearly with the corpus — O(n·d)
for n chunks of d dimensions. Fine for a few dozen notes; a wall the
moment the corpus is large.

```
  Zoom out — where the scan sits in the RAG pipeline

  ┌─ Agent layer ──────────────────────────────────────────┐
  │  RagQueryAgent → search_knowledge_base tool             │ ← caller
  └────────────────────────────┬────────────────────────────┘
                               │  query text in
  ┌─ Retrieval layer ──────────▼────────────────────────────┐
  │  pipeline.query → embedder.embed([query]) → 768-d vector │
  │  ★ InMemoryVectorStore.search ★  O(n·d) cosine scan      │ ← we are here
  └────────────────────────────┬────────────────────────────┘
                               │  top-k ranked hits out
  ┌─ Storage ──────────────────▼────────────────────────────┐
  │  Map<id, VectorChunk>  (all vectors live in JS heap)     │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: it's the exact-search baseline. For each stored chunk, compute
cosine similarity against the query vector, push the score, sort
descending, slice top-k. No index, no approximation — every chunk is
touched on every query. The pattern worth learning isn't the scan itself;
it's *why this is the right call at this corpus size* and *exactly what
flips when it isn't* (HNSW lives in buffr — cross-link below).

## The structure pass

**Layers:** agent (asks for ranked passages) → retrieval (embeds the
query, scans the store) → storage (the in-heap `Map` of vectors).

**Axis — cost per query as the corpus grows.** Hold one question constant:
*how much work does one search do as n chunks increases?* The answer flips
across one seam.

```
  Axis = "work per query as corpus grows" — traced across the store seam

  ┌─ InMemoryVectorStore ─┐   seam    ┌─ PgVectorStore + HNSW (buffr) ─┐
  │  scan ALL n vectors   │ ════╪════► │  walk a graph, visit ~log(n)   │
  │  cost = O(n·d)        │ (it flips) │  cost ≈ O(log n · d) typical   │
  └───────────────────────┘           └────────────────────────────────┘
         ▲                                         ▲
         └──── same VectorStore contract, two cost classes ─────┘
               → the seam carries a perf contract:
                 swap the adapter, the pipeline never knows
```

**The seam is the `VectorStore` interface** (`packages/retrieval/src/
contracts.ts:33-37`): `upsert` + `search(vector, k)`. Both
`InMemoryVectorStore` and buffr's `PgVectorStore` implement it. The cost
class flips across that seam — linear here, sub-linear with an HNSW index
there — and the pipeline above it doesn't change a line. That's the whole
point of putting the scan behind a contract.

## How it works

### Move 1 — the mental model

You already know the shape: it's a `.map()` that scores every item,
followed by a `.sort()`, followed by a `.slice(0, k)`. Same thing you'd
write to rank search results in a frontend list — except the "score" is a
cosine similarity between two 768-element arrays instead of a string match.

```
  The flat-search kernel

  query vector q ──┐
                   ▼
   for each stored chunk c:                ┐
       score = cosine(q, c.vector)         │  ← O(n) iterations,
       hits.push({ id, score, meta })      │    O(d) work each = O(n·d)
                                           ┘
   hits.sort(by score desc)               ← O(n log n)
   return hits.slice(0, k)                ← top-k

   nothing is skipped — every chunk is scored on every query
```

The kernel is: **score-everything → sort → slice**. Strip any of the three
and it stops being a ranked search.

### Move 2 — the walkthrough

**The cosine score — the inner loop.** Bridge from a dot product: cosine
similarity is the dot product of two vectors divided by the product of
their magnitudes, landing in [-1, 1]. One pass over the d dimensions
accumulates three running sums (dot, |a|², |b|²), then one divide.

```
  cosine(a, b) — one pass over d dimensions

  dot ← 0 ; magA ← 0 ; magB ← 0
  for i in 0..d:
      dot  += a[i] * b[i]      ← the alignment
      magA += a[i] * a[i]      ← |a|²
      magB += b[i] * b[i]      ← |b|²
  denom = sqrt(magA) * sqrt(magB)
  return denom == 0 ? 0 : dot / denom   ← 0 guards a zero vector (no NaN)
```

The boundary condition that bites if you forget it: a zero-magnitude
vector makes `denom == 0`, and `dot/denom` is `NaN`. A single `NaN` score
poisons the sort — comparisons against `NaN` are all false, so the sort
order goes undefined. Returning 0 for the zero-vector case is the
load-bearing guard.

**The scan — the outer loop.** For each chunk in the `Map`, compute that
cosine, push a hit. This is the O(n) part. There's no early exit, no
pruning, no index to consult — *every* stored vector is visited on *every*
query. At n = 30 chunks (the `ask.ts` corpus) this is ~30 × 768 ≈ 23K
multiply-adds — sub-millisecond, invisible next to the embedding HTTP call
and the model turn. At n = 1,000,000 it's 768M multiply-adds *per query* —
now it's the bottleneck.

**The sort + slice — the top-k.** Sort all n hits descending, slice k.
Sorting all n to keep k is itself wasteful at scale (a bounded
min-heap of size k would be O(n log k) instead of O(n log n)) — but at
small n it doesn't matter, and the readable `.sort().slice()` wins.

### Move 2.5 — current state vs future state

This is built-but-deliberately-small. The contract is already future-proof;
only the adapter is the cheap one.

```
  Phase A (here, aptkit)              Phase B (buffr, shipped)
  ─────────────────────              ───────────────────────────
  InMemoryVectorStore                PgVectorStore
  Map in JS heap                     Postgres + pgvector
  O(n·d) flat scan                   HNSW index, ANN walk
  exact top-k                        approximate top-k (high recall)
  zero infra, instant to test        a DB + an index to maintain
        │                                      │
        └──────── same VectorStore contract ───┘
                  the pipeline, the tool, the agent: unchanged
```

What *doesn't* have to change is the lesson: `pipeline.query`, the
`search_knowledge_base` tool, and `RagQueryAgent` all sit above the
`VectorStore` seam and never learn which store they're talking to. The
migration cost is one adapter (`buffr/src/pg-vector-store.ts`) plus the
`create index ... using hnsw` DDL (`buffr/sql/001_agents_schema.sql:28-29`).

### Move 3 — the principle

The flat scan is the *correct baseline* — exact top-k, zero infra,
trivially testable. An ANN index (HNSW, IVFFlat) trades a sliver of recall
for a huge latency win, and you only reach for it once n makes the linear
cost real. Putting both behind one `VectorStore` contract means you ship
the cheap exact version first and earn the indexed one later without
touching the pipeline. **Don't pay for the index until the corpus makes
you.**

## Implementation in codebase

**Use cases.** Every `pipeline.query(...)` call routes here. The
`search_knowledge_base` tool calls it (`search-knowledge-base-tool.ts:89`),
the rag-query agent drives that tool, and the retrieval eval scores its
output (`packages/agents/rag-query/scripts/eval.ts`). The hand-test
`ask.ts` indexes 3 docs and queries them live with real nomic embeddings.

```
  packages/retrieval/src/in-memory-vector-store.ts  (lines 25–33)

  async search(vector, k) {
    this.assertDimension(vector, 'query vector');   ← reject wrong-dim query
    const hits = [];
    for (const chunk of this.chunks.values()) {     ← O(n): EVERY chunk
      hits.push({ id, score: cosineSimilarity(vector, chunk.vector), meta });
    }                                               ← no index, no pruning
    hits.sort((a, b) => b.score - a.score);         ← O(n log n) full sort
    return hits.slice(0, Math.max(0, k));           ← top-k
  }
       │
       └─ the `for ... of this.chunks.values()` IS the O(n) scan; there is
          no index to consult, so cost scales linearly with corpus size.
          This is what an HNSW index replaces in buffr.
```

```
  packages/retrieval/src/in-memory-vector-store.ts  (lines 46–57)

  function cosineSimilarity(a, b) {
    for (let i = 0; i < a.length; i += 1) {         ← O(d): the 768-dim pass
      dot += a[i] * b[i]; magA += a[i]*a[i]; magB += b[i]*b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;           ← 0 on zero-vector
  }                                                    (without it: NaN
                                                        poisons the sort)
```

The contrast adapter, for reference (not in this repo —
`study-database-systems` / buffr owns the index mechanics):

```
  buffr/src/pg-vector-store.ts  (lines 67–76)   ← the HNSW-backed search

  select ..., 1 - (embedding <=> $1::vector) as score
  from agents.chunks
  order by embedding <=> $1::vector              ← <=> = cosine distance;
  limit $3                                          the HNSW index turns this
                                                    ORDER BY ... LIMIT into an
                                                    ANN graph walk, not a scan

  buffr/sql/001_agents_schema.sql  (lines 28–29)
  create index chunks_embedding_hnsw
    on agents.chunks using hnsw (embedding vector_cosine_ops);
       │
       └─ this index is the thing the in-memory store does NOT have.
          With it, the DB visits ~log(n) candidates, not all n.
```

## Elaborate

Exact (flat) vs approximate (ANN) nearest-neighbor is the central tradeoff
of vector search. Flat search is O(n·d) and exact. ANN indexes — HNSW
(graph-based), IVFFlat (cluster-based), product quantization (compression)
— give sub-linear query time at the cost of *recall*: they may miss a true
top-k neighbor occasionally. HNSW (Hierarchical Navigable Small World)
builds a layered proximity graph and greedily walks it toward the query,
visiting a small fraction of nodes. The knobs (`m`, `ef_construction`,
`ef_search`) trade build time and memory for recall. The deep mechanics of
pgvector's HNSW belong to **study-database-systems**; what *this* guide owns
is the cost contract — linear here, sub-linear there, same interface.

## Interview defense

**Q: This loops over every vector on every query. Isn't that slow?**

At this corpus size, no — and that's the point. The kernel is
score-everything → sort → slice; at n = 30 it's ~23K multiply-adds,
invisible next to the embedding HTTP round-trip and the model turn. It's
O(n·d), so it becomes the bottleneck at large n — at which point you swap
in `PgVectorStore` with an HNSW index behind the same `VectorStore`
contract, and the pipeline doesn't change.

```
  exact flat scan          approximate HNSW
  O(n·d), 100% recall  ──► O(log n · d), ~99% recall
  the baseline             the upgrade you earn at scale
```

Anchor: *the flat scan is the correct baseline; the index is the upgrade
you defer until the corpus forces it.*

**Q: What's the load-bearing line people forget?**

The `denom === 0 ? 0` guard in `cosineSimilarity`. Without it a zero-magnitude
vector yields `NaN`, and a single `NaN` score makes the descending sort
order undefined — every comparison against `NaN` is false. The zero-guard
keeps the ranking total-ordered.

## Validate

1. **Reconstruct:** write the flat-search kernel from memory
   (score-everything → sort → slice) and the cosine inner loop with its
   zero guard. Check against `in-memory-vector-store.ts:25-57`.
2. **Explain:** why is O(n·d) acceptable at `ask.ts`'s n = 30 but a wall at
   n = 10⁶? Name the two costs that dwarf it at small n (embed call, model
   turn).
3. **Apply:** the corpus grows to 500K chunks and p99 query latency climbs.
   What do you change, and what *doesn't* change? (Swap to `PgVectorStore`
   + HNSW behind `VectorStore`; the pipeline/tool/agent are untouched.)
4. **Defend:** why ship the linear scan first instead of starting with
   pgvector? (Exact top-k, zero infra, instant to test; you don't pay for
   the index until n makes you. The contract makes the later swap free.)

## See also

- **08-embedding-batch-and-topk-floor.md** — the embed call that feeds this
  scan (batched) and the top-k floor that controls how many hits it returns.
- **04-fixture-replay-as-zero-cost-path.md** — the same "cheap exact thing
  behind a swappable contract" instinct, applied to the model.
- **audit.md** lens 4 (cpu-memory) and lens 5 (io-network) — where this
  scan sits in the full perf picture.
- **study-database-systems** (buffr) — owns the HNSW index mechanics this
  scan is the baseline for.
