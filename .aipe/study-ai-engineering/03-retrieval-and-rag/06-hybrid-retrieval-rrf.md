# Hybrid retrieval — Reciprocal Rank Fusion

**Subtitle:** Hybrid retrieval · merging dense + sparse rankings with RRF · *Industry standard*

## Zoom out, then zoom in

Hybrid retrieval is what you build *after* you have both a dense path and a sparse
path and need one ranked list out of two. It sits above both retrievers, as a pure
merge step. aptkit has the dense path and the merge slot, but no sparse path and no
merger yet — so this whole concept is `not yet exercised`, taught as the pattern and
its insertion point.

```
  Zoom out — fusion sits above two retrievers

  ┌─ search_knowledge_base tool ────────────────────────────────┐
  │  ★ FUSE two ranked lists into one ★   ← the RRF slot         │ ← we are here
  └──────────────┬───────────────────────────┬──────────────────┘
                 │ dense (exists)             │ sparse (not built)
  ┌─ pipeline.query ▼─────────┐   ┌─ bm25Index.search ▼─────────┐
  │ cosine over nomic, top-k  │   │ NOT YET EXERCISED           │
  └───────────────────────────┘   └─────────────────────────────┘
```

Now zoom in. You have merged two sorted lists before — but you couldn't just
concatenate their scores, because the two lists score on different scales. A cosine
similarity of 0.82 and a BM25 score of 14.3 are not comparable numbers. RRF solves
this by throwing away the scores entirely and fusing on *rank position* — which is
the move worth understanding even before you build it.

## Structure pass

**Layers.** Fusion (RRF) → two rankings (dense list, sparse list) → two retrievers
(cosine — exists; BM25 — `not yet exercised`).

**Axis — control.** Trace who decides the final order. The retrievers each propose a
ranked list; the fuser decides the merged order. Control over "what's #1" moves from
*either retriever* up to *the fuser*. RRF's design choice is that control depends
only on each item's *rank* in each list, never on the raw scores — so no retriever's
score scale can dominate.

**Seam.** The would-be seam is inside `search-knowledge-base-tool.ts`: today the
handler calls `pipeline.query` once (`search-knowledge-base-tool.ts:89`). The fusion
step slots right there — call both retrievers, fuse, return. Nothing in the
pipeline or agent changes; the tool grows a merge.

## How it works

### Move 1 — the mental model

You know that merging two sorted lists by their values requires the values to be on
one scale. When they aren't — two judges scoring on different rubrics — you don't
average their scores; you average their *ranks*. RRF is exactly that: convert each
list to "you were #1, #2, #3…" and score an item by how high it ranks across lists.
A chunk that both retrievers rank near the top wins; a chunk only one finds still
scores, just lower.

```
  RRF — fuse on rank position, not on score

  dense ranks:  [A(#1), C(#2), B(#3)]      sparse ranks: [B(#1), A(#2), D(#3)]
       │                                         │
       └──────────► score(item) = Σ 1/(k + rank_in_each_list) ◄──────────┘
   A: 1/(60+1) + 1/(60+2)   B: 1/(60+3) + 1/(60+1)   ─► sort by summed score
```

### Move 2 — the RRF formula and where it slots

**The formula: sum of reciprocal ranks.** RRF assigns each item a score by summing
`1 / (k + rank)` over every list it appears in. `k` is a constant — conventionally
60 — that dampens the gap between top ranks so a single retriever's #1 cannot
steamroll the fusion. No score normalization is needed because scores never enter
the formula; only positions do.

```
  RRF score (PSEUDOCODE — not yet exercised)

  score(item) = Σ over lists  1 / (k + rank_in_list)      k = 60
   rank is 1-based; absent-from-a-list contributes nothing
   no normalization: cosine 0.82 vs BM25 14.3 never compared directly
```

**Where it slots in aptkit.** The tool handler today is single-path
(`search-knowledge-base-tool.ts:89`):

```ts
let hits = await pipeline.query(query, fetchK);   // dense only, today
```

The hybrid version wraps this. It is the *only* line that changes — the agent, the
pipeline contracts, and the citation logic are all downstream of the fused list:

```
  Hybrid handler (PSEUDOCODE — not yet exercised)

  dense  = await pipeline.query(query, fetchK)      # exists (line 89)
  sparse = await bm25Index.search(query, fetchK)    # not built (see 05-dense-vs-sparse)
  fused  = reciprocalRankFusion([dense, sparse], k=60)
  hits   = fused.slice(0, topK)                     # then existing toResult/citation path
```

**Why RRF over weighted score-blend.** A weighted blend
(`0.7*cosine + 0.3*bm25`) forces you to normalize two incomparable scales and tune a
weight per corpus. RRF needs neither — it is parameter-light (just `k`), robust, and
the reason it is the standard hybrid-fusion default. That robustness is exactly what
you want for a step that has to work across query types without per-query tuning.

```
  Two fusion strategies

  weighted blend: normalize scales + tune weights per corpus  ── fragile
  RRF:            rank-only, single k=60, no normalization     ── robust ✓
```

### Move 2.5 — current state vs future state

```
  Phase A (aptkit, now)             Phase B (hybrid — not yet exercised)
  ┌────────────────────────┐        ┌──────────────────────────────────┐
  │ tool calls pipeline.query│      │ tool calls dense + sparse, fuses  │
  │ one ranked list (cosine) │ add  │ RRF(k=60) merges by rank          │
  │ search-…-tool.ts:89      │ RRF  │ same line is the only change      │
  └────────────────────────┘        └──────────────────────────────────┘
   the fusion slot exists; the second retriever and the fuser do not
```

### Move 3 — the principle

When you merge rankings from systems that score on different scales, fuse on
*position*, not on *value* — that's what makes RRF the default. Don't normalize two
incomparable score scales and don't tune a blend weight per corpus; sum reciprocal
ranks with `k=60` and let robustness beat precision-tuning. Build it only once a
sparse path exists — fusing one list with itself is a no-op — which is why aptkit's
RRF is a documented next step, not a feature.

## Primary diagram

```
  Hybrid retrieval with RRF (the target shape)

  query
    ├──► pipeline.query (cosine) ───► [A,C,B]   (dense ranks)   ── exists
    └──► bm25Index.search ──────────► [B,A,D]   (sparse ranks)  ── not yet exercised
                                         │
                  RRF: score = Σ 1/(60 + rank), per item across both lists
                                         ▼
                              fused ranked list ─► slice topK
                                         │
                       existing toResult/citation path (unchanged)
```

## Elaborate

Hybrid retrieval is the canonical answer to "dense alone misses exact tokens"
(`05-dense-vs-sparse.md`): keep dense for semantics, add sparse for literals, fuse
so a chunk strong in either surfaces. The reason RRF specifically dominates is
operational — it has one knob (`k`), needs no score calibration, and degrades
gracefully when one retriever returns garbage. At aptkit's scale this is premature
until the corpus carries identifiers or code; the value of documenting it now is
knowing the *exact line* (`search-knowledge-base-tool.ts:89`) where it lands.
Read `05-dense-vs-sparse.md` for the sparse path RRF needs and `07-reranking.md` for
the complementary "re-score the fused candidates" stage.

## Project exercises

### Implement reciprocal rank fusion over dense + a stub sparse list
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a pure `reciprocalRankFusion(lists, k = 60)` that takes ranked
  id lists and returns one fused ranked list, wired into the search tool to fuse the
  existing dense results with a second list (a BM25 path, or a stub for the test).
- **Why it earns its place:** RRF is the single most-asked hybrid-retrieval
  mechanism; a tested implementation that fuses on rank (not score) proves you
  understand why score-blending is fragile.
- **Files to touch:** a new `packages/retrieval/src/reciprocal-rank-fusion.ts`,
  `packages/retrieval/src/search-knowledge-base-tool.ts` (call it around line 89), a
  new test in `packages/retrieval/test/`.
- **Done when:** a unit test shows an item ranked #2 in both lists outscores an item
  ranked #1 in only one, with `k = 60`.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "How do you combine dense and sparse results?"**
Reciprocal Rank Fusion. Each retriever returns a ranked list; I score every item by
summing `1/(k + rank)` over the lists it appears in, with `k = 60`, then sort by that
sum. It fuses on rank *position*, so I never have to normalize cosine scores against
BM25 scores — which are on incomparable scales. In aptkit it slots into the search
tool around `search-knowledge-base-tool.ts:89`; today only the dense list exists, so
it's `not yet exercised`.

```
  score = Σ 1/(60 + rank)  ── rank-based, no normalization, one knob
```
Anchor: *fuse on rank, not on score — that's why RRF needs no calibration.*

**Q: "Why not just average the two scores?"**
Because cosine similarity (≈0–1) and BM25 (unbounded, corpus-dependent) live on
different scales — averaging them lets whichever scores bigger dominate, and you'd
have to normalize and tune a weight per corpus. RRF sidesteps all of that by using
only rank position, which is why it's the robust default.

```
  blend 0.82 (cosine) vs 14.3 (BM25) ─► incomparable, needs tuning
  RRF on ranks #1/#2/#3 ─► comparable by construction
```
Anchor: *scores from different retrievers aren't comparable; ranks are.*

## See also

- `05-dense-vs-sparse.md` — the two retrievers RRF fuses
- `07-reranking.md` — re-scoring the fused candidates with a cross-encoder
- `04-vector-databases.md` — the dense retriever that exists today
- `11-rag.md` — the search tool and pipeline RRF plugs into
- `05-evals-and-observability/01-eval-set-types.md` — proving fusion beats dense alone
