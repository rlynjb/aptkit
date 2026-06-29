# Linear scan vs approximate nearest-neighbor

*Industry names: brute-force / exact k-NN search vs ANN (approximate
nearest-neighbor, e.g. HNSW). Type: Industry standard.*

## Zoom out, then zoom in

You've shipped pgvector before (AdvntrCue). So you already hold the shape: a
vector store takes a query embedding and returns the closest chunks. The
question this file answers is the one that decides whether retrieval stays fast
as the corpus grows: **does the store look at every vector, or does it skip
most of them?** aptkit's in-memory store looks at every one. buffr's pgvector
store, behind the *same contract*, can skip most.

```
  Zoom out — where the scan lives in the retrieval path

  ┌─ Runtime layer (packages/runtime) ──────────────────────────┐
  │  runAgentLoop → tool call: search_knowledge_base            │
  └───────────────────────────┬──────────────────────────────────┘
                              │  query string
  ┌─ Retrieval layer (packages/retrieval) ▼──────────────────────┐
  │  queryKnowledgeBase → embed(query) → store.search(vec, k)    │
  │                                        ★ THIS CONCEPT ★       │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  same VectorStore contract
  ┌─ Storage layer (buffr, out of repo) ▼────────────────────────┐
  │  PgVectorStore.search → SQL order-by-distance + HNSW index   │
  └───────────────────────────────────────────────────────────────┘

  the contract is identical on both sides; the algorithm under it flips
  from O(n) exact to ~O(log n) approximate — the whole performance story
```

The pattern: an **exact** k-NN store computes similarity against *every* stored
vector and sorts; an **approximate** store (ANN) navigates a pre-built index
that visits a small fraction of vectors and accepts a tiny recall loss for a
large speed win. aptkit ships the exact one because it's the "build the whole
pipeline with zero cloud" adapter; the speed it gives up doesn't matter until
the corpus is large.

## The structure pass

Trace one axis — **cost per query** — across the two implementations of the
`VectorStore` contract.

```
  One axis (cost per query) traced across the contract seam

  ┌─ InMemoryVectorStore (aptkit) ─┐  seam   ┌─ PgVectorStore (buffr) ──┐
  │  visits ALL n vectors          │ ══════► │  visits ~ef·log(n)        │
  │  O(n·d) compute + O(n log n)   │ (flips) │  HNSW graph walk          │
  │  sort, on the JS event loop    │         │  index work in Postgres   │
  └────────────────────────────────┘         └───────────────────────────┘
         exact, slow-at-scale                   approximate, sub-linear
```

- **Layers:** the contract (`VectorStore.search(vector, k)`) is the upper
  layer; the algorithm is the lower. The contract promises "ranked top-k"; it
  does *not* promise *how*.
- **Axis:** cost per query. On the in-memory side it's O(n·d) + O(n log n). On
  the pg side it's roughly O(ef · log n) graph traversal.
- **Seam:** the `VectorStore` interface. This is the load-bearing boundary —
  the axis-answer (query cost) flips completely across it while the type
  signature stays byte-for-byte identical. That identical signature is *why*
  the swap is a drop-in.

## How it works

#### Move 1 — the mental model

You know how `Array.prototype.find` walks the whole array until it returns? The
exact scan is that, except it can't stop early — it must score *every* element
to know which k are closest, then sort. ANN is the opposite instinct: build a
navigable graph once, at insert time, so that at query time you "greedily walk
toward" the query and only ever touch a handful of nodes.

```
  Pattern — exact scan vs ANN graph walk

  EXACT (aptkit):                ANN / HNSW (buffr):

  query ●                        query ●
        │ score every node             │ enter at a hub
   ┌────┼────┬────┬────┐               ▼
   ▼    ▼    ▼    ▼    ▼          (n1)──(n2)   greedily hop
  v1   v2   v3   …   vn            │  ╲   │    toward nearer
   └────┴──sort all──┘            (n3)  (n4)  neighbors only
        slice top-k                      ▼
                                    top-k found
   touches n nodes                  touches ~ef·log(n) nodes
```

#### Move 2 — the step-by-step walkthrough

**The exact scan, line by line.** This is the whole of
`InMemoryVectorStore.search` — `packages/retrieval/src/in-memory-vector-store.ts:25-33`:

```ts
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');     // fail loud on wrong dim
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {       // ← visits EVERY chunk: O(n)
    hits.push({ id: chunk.id,
      score: cosineSimilarity(vector, chunk.vector), //   each score is O(d), d=768
      meta: chunk.meta });
  }
  hits.sort((a, b) => b.score - a.score);           // ← sorts ALL n hits: O(n log n)
  return hits.slice(0, Math.max(0, k));             //   then throws away all but k
}
```

Three things to see. First, the `for…of` over `this.chunks.values()` is the
O(n) term — there is no index, no early exit, every vector is touched. Second,
`cosineSimilarity` (`:46-57`) is a tight loop over all 768 dimensions: one dot
product and two magnitudes, so each score is O(d) and the scan is **O(n·d)**.
Third — the part people miss — it sorts the *entire* hit array and then slices
k. You computed and sorted n results to keep 5. A heap of size k would be
O(n log k); a full sort is O(n log n). For small n nobody cares; the choice was
"simplest correct thing," and that's the right call for a demo adapter.

**The boundary condition: it's synchronous inside an `async` signature.** The
method returns a `Promise`, but nothing inside it `await`s — the entire scan and
sort run to completion synchronously before the promise resolves. So the JS
event loop is **blocked** for the whole O(n·d) scan. At demo-corpus size that's
microseconds. At 100k chunks it's a stall that freezes everything else on the
loop. The async signature is there for *contract parity* with `PgVectorStore`
(which genuinely awaits the DB), not because this implementation does I/O.

**The ANN side, in buffr.** Same contract, different cost.
`PgVectorStore.search` — `buffr/src/pg-vector-store.ts:67-85`:

```ts
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score   -- <=> is cosine DISTANCE
   from agents.chunks
   where app_id = $2
   order by embedding <=> $1::vector                -- ← the index serves this
   limit $3`,
  [toVectorLiteral(vector), this.appId, k],
);
```

The `order by embedding <=> $1 limit k` is the magic line. *If* an HNSW index
exists on `embedding`, Postgres serves this with a graph walk that visits
roughly `ef_search · log(n)` rows instead of all n — sub-linear. Without the
index it degrades to the same full scan as the in-memory store, just in C
instead of JS. The performance win is entirely contingent on the index being
there and its `ef_search` being tuned — and in this code `ef_search` is **never
set**, so it sits at the default. That's the untuned knob the audit flags.

#### Move 2 variant — the load-bearing skeleton

The irreducible kernel of *any* k-NN store: **(1) a similarity function, (2) a
way to find the top-k by that function, (3) a tie to the chunk metadata for
citations.**

- Drop the similarity function → no ranking; you return arbitrary chunks.
- Drop the top-k selection → you return everything; the model drowns in
  context and you blow the token budget.
- Drop the metadata tie → you return scores with no `docId`/`text`, so the
  agent can't cite (`toResult` in `search-knowledge-base-tool.ts:108-118`
  rebuilds the citation from `meta`).

The **algorithm under step 2 is the optional-hardening axis**: full-scan-then-sort
is the skeleton; a top-k heap, then an HNSW index, then a tuned `ef_search` are
successive hardening layers. Naming which is skeleton and which is hardening is
the lesson: the *contract* is the skeleton, the *algorithm* is swappable
hardening.

#### Move 2.5 — current state vs future state

```
  Phase A (now, aptkit)            Phase B (prod, buffr)
  ─────────────────────            ─────────────────────
  InMemoryVectorStore              PgVectorStore
  O(n·d) exact scan                HNSW approximate walk
  heap-resident Map                Postgres + pgvector
  zero infra, instant setup        needs pg + index + tuning
  recall = 1.0 (exact)             recall < 1.0 (approx, tunable via ef)

  what DOESN'T change: the VectorStore contract, the search_knowledge_base
  tool, the retrieval pipeline, every agent above it. The swap is one
  constructor call in the wiring. That's the payoff of the seam.
```

The migration cost is nearly zero *in code* because the contract absorbed the
change — the entire point of `packages/retrieval/src/contracts.ts`. The cost
that's real is operational: standing up Postgres, creating the HNSW index,
choosing `ef_search`. None of which aptkit has to know about.

#### Move 3 — the principle

Exact search is the right default until n is big enough that O(n) hurts — and
the *only* honest way to know when that is, is to measure. ANN trades a sliver
of recall for sub-linear latency; you reach for it when the corpus outgrows the
scan, not before. The deeper principle: **put the algorithm behind a contract
so the speed/recall tradeoff becomes a deployment decision, not a rewrite.**
aptkit nailed the contract; what it's missing is the measurement that tells you
when to flip.

## Primary diagram

```
  Exact scan vs ANN, end to end — one contract, two costs

  ┌─ Retrieval contract: VectorStore.search(vector, k) ──────────┐
  │                                                              │
  │  IN-MEMORY (aptkit)                  PGVECTOR (buffr)         │
  │  ┌──────────────────────┐            ┌──────────────────────┐│
  │  │ for chunk in all n:  │            │ SQL: order by         ││
  │  │   score = cosine(d)  │  O(n·d)    │  embedding <=> q      ││
  │  │ sort all n  O(nlogn) │            │  limit k              ││
  │  │ slice top-k          │            │ HNSW walk ~ef·log(n)  ││
  │  │ (blocks event loop)  │            │ (index in Postgres)   ││
  │  └──────────────────────┘            └──────────────────────┘│
  │     recall 1.0, slow-at-scale          recall<1.0, sub-linear│
  └───────────────────────────────────────────────────────────────┘
        the green-field measurement gap: nobody has timed either one
```

## Elaborate

ANN comes from the realization that exact nearest-neighbor in high dimensions
is fundamentally expensive (the "curse of dimensionality" — no index beats
brute force for *exact* results past a certain d). HNSW (Hierarchical Navigable
Small World) sidesteps it by accepting approximate answers: a layered graph
where upper layers are sparse "express lanes" and you descend greedily. The two
knobs are `m` (graph connectivity, set at build) and `ef_search` (how many
candidates to keep while walking, set at query) — `ef_search` is the
recall/latency dial buffr leaves untuned. Read next:
`04-embedding-batching.md` (the I/O cost *before* the scan) and
`06-over-fetch-then-filter.md` (a cost the scan inherits from the contract's
missing metadata predicate).

## Interview defense

**Q: Your vector store is O(n·d) with a full sort. Isn't that a problem?**

Answer with the verdict first: it's the right call for what it is — the
zero-cloud demo adapter — and the wrong call for production, which is exactly
why production uses a different implementation behind the same contract. Then
the detail: the scan touches every chunk and sorts all of them to keep k, and
it's synchronous so it blocks the event loop. At demo size that's invisible; at
scale it's the bottleneck. The fix isn't to optimize the JS scan — it's to swap
in `PgVectorStore`, which the `VectorStore` contract makes a one-line change.

```
  sketch while you talk:

  search(q,k):  for n vectors → cosine(768) → sort n → slice k
                └ O(n·d) ──────────────────┘ └ O(n log n) ┘   blocks loop
  swap point:   same contract → pgvector HNSW → ~O(ef·log n)
```

One-line anchor: *"exact scan behind a contract, ANN drops in — the speed/recall
tradeoff is a deployment decision, not a rewrite."*

**Q: What would you actually measure first?**

Index a growing corpus (1k, 10k, 100k chunks), time `search` at each, find the n
where p95 crosses your latency budget — then you have the crossover point that
tells you when to graduate. Right now that number doesn't exist; that's the real
gap, not the algorithm.

## See also

- `audit.md` — lens 4 (cpu-memory) and red-flag #1.
- `04-embedding-batching.md` — the embed call that precedes the scan.
- `06-over-fetch-then-filter.md` — the contract's missing metadata predicate.
- `05-build-time-inlining-zero-fetch.md` — the in-browser version of this scan
  running on the Studio main thread.
