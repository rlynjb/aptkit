# Hybrid retrieval
> Reciprocal Rank Fusion · Industry standard

You've got two rankers that fail on opposite query types (file 05): dense catches paraphrase, sparse catches exact tokens. Hybrid retrieval runs both and merges their ranked lists into one. The clean way to merge isn't to average their scores — those scores live on incompatible scales (cosine is [-1,1], BM25 is unbounded) — it's **Reciprocal Rank Fusion**: throw away the scores, keep only each item's *rank position*, and combine. RRF is a few lines, has one tunable constant, and consistently beats either ranker alone. aptkit has neither lane fused today — this is `not yet exercised`, and building it is the exercise.

## Zoom out, then zoom in

Hybrid retrieval is a fusion layer that would sit *above* the two retriever lanes and *below* the search tool.

```
where RRF would sit (DOES NOT EXIST YET)
┌──────────────────────────────────────────────────────────┐
│  search_knowledge_base                                      │
└───────────────┬────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│  ★ RRF fusion ★   merge two ranked lists by rank position   │  ← the gap
└───────┬───────────────────────────────────┬────────────────┘
        ▼                                     ▼
┌────────────────────┐              ┌────────────────────────┐
│ DENSE (cosine)      │              │ SPARSE (BM25)           │
│ exists ✓            │              │ not yet exercised (05)  │
└────────────────────┘              └────────────────────────┘
```

Two gaps stack here: there's no sparse lane (file 05) and no fusion. But fusion is the *interesting* gap — it's the small, elegant algorithm that makes hybrid worth doing. It depends only on each lane returning a ranked `VectorHit[]`, which both lanes already do (or would). The fusion layer never looks at raw scores, so it doesn't care that cosine and BM25 are unit-incompatible — that scale-blindness is the whole reason RRF wins.

## Structure pass

Pick the **trust** axis: how much does fusion trust each ranker's *scores* vs its *ordering*?

```
trust across fusion strategies
  SCORE FUSION                       RANK FUSION (RRF)
  ┌──────────────────────┐          ┌──────────────────────────┐
  │ trusts raw scores      │          │ trusts ONLY the ordering  │
  │ cosine [-1,1] vs       │          │ rank 1, rank 2, rank 3... │
  │ BM25 [0,∞) → must      │          │ no normalization needed   │
  │ normalize (fragile)    │          │ scale-immune              │
  └──────────────────────┘          └──────────────────────────┘
         ▲ seam: RRF refuses to trust scores it can't compare ▲
```

The seam is the score scale. Score fusion needs you to normalize cosine and BM25 onto a common scale — and that normalization is brittle, corpus-dependent, and a constant source of "why did this regress." RRF sidesteps it entirely by trusting only rank order. A rank of 1 means the same thing from both lanes ("this ranker's top pick") regardless of the underlying number. That's why RRF is the default fusion method: it's robust precisely because it trusts less.

## How it works

**Move 1 — the RRF formula.** Each item's fused score is the sum, over every ranked list it appears in, of `1 / (k + rank)`:

```
RRF score for one item
   RRF(item) = Σ over lists L  of   1 / (k + rank_L(item))
                                          │        │
                                          │        └─ item's position in list L (1-based)
                                          └────────── constant, conventionally 60
   appears high in BOTH lists → two big terms → big fused score
   appears in only one list, low → one small term → small fused score
```

Why `1/(k+rank)`? It's a reciprocal: rank 1 contributes a lot, rank 2 less, rank 100 almost nothing — so being near the top matters far more than being present at all. The constant `k=60` (the value from the original RRF paper, and everyone's default) flattens the curve a little so the very top ranks don't completely dominate — without it, a rank-1 item (`1/1`) would be worth 2x a rank-2 item (`1/2`), which over-rewards the top. With `k=60`, rank 1 is `1/61` and rank 2 is `1/62` — close, so agreement across lists drives the result more than any single list's #1.

**Move 2 — the fusion step.** `not yet exercised`. The logic in pseudocode:

```
fuse two ranked lists with RRF (pseudocode — DOES NOT EXIST in aptkit)
function rrfFuse(denseHits, sparseHits, k = 60, topK = 5):
    scores = {}                                  # id → fused score
    for list in [denseHits, sparseHits]:
        for rank, hit in enumerate(list, start=1):
            scores[hit.id] += 1 / (k + rank)     # ← rank position only; ignore hit.score
    ranked = sort scores by value DESC
    return ranked[:topK] as VectorHit[]          # same return shape as either lane
```

```
worked example (k=60, topK=3)
  DENSE ranks:   [A, B, C, D]        SPARSE ranks:  [C, A, E]
  A: 1/(60+1) + 1/(60+2) = .0164 + .0161 = .0325   ← high in both → wins
  C: 1/(60+3) + 1/(60+1) = .0159 + .0164 = .0323   ← also high in both
  B: 1/(60+2)            =          .0161           ← dense only
  E:            1/(60+3) =          .0159           ← sparse only
  fused top-3: [A, C, B]   ← A and C surface because BOTH lanes agree on them
```

The magic is in A and C: neither lane ranked both at the top, but RRF rewards *cross-lane agreement*, so the items both rankers liked rise above the items only one liked. That's the consensus signal you can't get from either list alone.

**Where it plugs in.** The fused output must keep the `VectorHit` shape so the search tool downstream is untouched:

```ts
// the contract RRF must satisfy — packages/retrieval/src/contracts.ts:15-19
export type VectorHit = {
  id: string;
  score: number;     // ← put the RRF score here so callers stay generic
  meta: Record<string, unknown>;
};
// fusion returns VectorHit[] — search_knowledge_base (file 11) never knows it fused
```

The fused list reuses `VectorHit` so `createSearchKnowledgeBaseTool` (`search-knowledge-base-tool.ts:89`) calls `pipeline.query` and gets the same shape back whether it's pure dense or fused — the over-fetch and filter logic above it doesn't change.

**Move 3 — the principle.** Fuse rankings, not scores. The instant you're combining two rankers that score on different scales, normalization is a trap — it's fragile and corpus-specific. RRF's discipline is to discard the scores and trust only positions, which makes it scale-immune and nearly tuning-free (one constant, and 60 works). The payoff isn't just "best of both"; it's the *agreement* signal — items both lanes rank highly get promoted, and that consensus is more reliable than either lane's top pick.

## Primary diagram

```
hybrid retrieval with RRF (the buildable target)
   query
     ├──────────────► DENSE lane  ──► [A, B, C, D]  (by cosine)
     └──────────────► SPARSE lane ──► [C, A, E]     (by BM25)
                              │            │
                              ▼            ▼
                  ┌────────────────────────────────┐
                  │ RRF: Σ 1/(60 + rank)            │
                  │ rank position only, scores tossed│
                  └───────────────┬────────────────┘
                                  ▼
                     fused [A, C, B] as VectorHit[]
                                  │
                                  ▼  cross-lane agreement → A, C promoted
                        search_knowledge_base (unchanged)
```

Two ranked lists in, one fused list out, scores discarded, agreement rewarded.

## Elaborate

RRF comes from Cormack, Clarke & Büttcher (2009), who showed this trivially simple method beats more complex learned fusion — a recurring lesson in IR. It's now the built-in fusion in Elasticsearch, OpenSearch, and Weaviate's hybrid search. Adjacent: **weighted RRF** (multiply each lane's contribution by a trust weight when you know one lane is better for your corpus), **convex score combination** (`α·dense + (1-α)·sparse` after normalization — the fragile alternative RRF avoids), and the fact that RRF generalizes to *any* number of rankers (add a reranker's list, a recency list, etc.). Read next: `05-dense-vs-sparse.md` (the two lanes you're fusing) and `07-reranking.md` (the precision stage after fusion).

## Project exercises

### Combine the dense store and a sparse retriever with RRF

- **Exercise ID:** `EX-RAG-06a`
- **What to build:** An `rrfFuse(lists, k=60, topK)` and a `HybridRetriever` that calls the dense store + the sparse retriever (from `EX-RAG-05a`) in parallel and fuses their ranked lists into one `VectorHit[]`.
- **Why it earns its place:** This is the payoff of building the sparse lane — and the thing that makes aptkit's retrieval beat dense-only on a mixed query set. The fusion is tiny but the win is real and measurable. Case B; depends on `EX-RAG-05a`. Phase 2B.
- **Files to touch:** new `packages/retrieval/src/rrf.ts` and `packages/retrieval/src/hybrid-retriever.ts`; consumes the dense `VectorStore` (`packages/retrieval/src/in-memory-vector-store.ts`) and the future sparse retriever; returns `VectorHit` (`packages/retrieval/src/contracts.ts:15-19`).
- **Done when:** on the `EX-RAG-05b` fixture, the hybrid retriever beats both dense-only and sparse-only on top-5 hit rate, and a test pins the RRF math on a hand-computed example.
- **Estimated effort:** `1–2 days`

### Unit-test the RRF math against a hand-computed example

- **Exercise ID:** `EX-RAG-06b`
- **What to build:** A pure-function test of `rrfFuse` using the worked example above (DENSE `[A,B,C,D]`, SPARSE `[C,A,E]`, k=60) asserting the exact fused order and that cross-lane agreement promotes A and C.
- **Why it earns its place:** RRF's whole value is the agreement-promotion behavior — pin it so a refactor that "simplifies" the formula can't silently turn it into score-averaging.
- **Files to touch:** test alongside `packages/retrieval/src/rrf.ts`.
- **Done when:** the test asserts `[A, C, B]` and fails if `k` or the reciprocal is changed.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Why fuse ranks instead of just averaging the cosine and BM25 scores?**

```
cosine ∈ [-1,1]   BM25 ∈ [0,∞)   ← incompatible scales
average → BM25 dominates by magnitude, normalization is corpus-fragile
RRF → 1/(k+rank): rank 1 means "top pick" identically in both lanes
```

Anchor: score averaging requires normalizing incompatible scales, which is brittle; RRF trusts only rank position, which is scale-immune.

**Q: What does the constant k=60 actually do?**

```
k small (k=0): rank1=1/1, rank2=1/2 → top rank dominates 2:1
k=60:          rank1=1/61, rank2=1/62 → near-equal → AGREEMENT decides
```

Anchor: `k` flattens the reciprocal curve so cross-lane agreement, not a single list's #1, drives the fused order — 60 is the paper's default and it works.

## See also

- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — the two lanes fusion combines
- [07-reranking.md](07-reranking.md) — adding a precision stage after fusion
- [11-rag.md](11-rag.md) — where the fused list feeds the agent
