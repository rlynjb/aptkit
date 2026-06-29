# Reranking — two-stage retrieval

**Subtitle:** Reranking · cheap recall then expensive precision · *Industry standard*

## Zoom out, then zoom in

Reranking is the answer to "retrieval found the right chunk, but it's ranked #7."
It sits *between* the store's top-k and the model, re-ordering candidates with a
slower, sharper scorer. aptkit's retrieval is single-stage cosine top-k — so the
rerank stage is `not yet exercised`, and it is the most natural next build in the
whole pipeline.

```
  Zoom out — rerank sits between retrieve and generate

  ┌─ search_knowledge_base tool ────────────────────────────────┐
  │  retrieve top-k (cosine) ─► ★ RERANK ★ ─► top-n to model     │ ← we are here
  └──────────────┬──────────────────────────┬───────────────────┘
   stage 1: fast │              stage 2: slow │
  ┌─ pipeline.query ▼────────┐   ┌─ cross-encoder ▼────────────┐
  │ bi-encoder cosine, top-k │   │ NOT YET EXERCISED            │
  │ DEFAULT_TOP_K = 5         │   │ score (query, chunk) pairs   │
  └───────────────────────────┘   └─────────────────────────────┘
```

Now zoom in. You know the database pattern: a cheap index narrows millions of rows
to a few hundred, then an expensive `WHERE` predicate filters those few precisely.
You'd never run the expensive predicate over all millions. Reranking is that exact
shape for retrieval — a cheap bi-encoder recalls 50 candidates, an expensive
cross-encoder precisely re-scores those 50. aptkit only has the cheap stage today.

## Structure pass

**Layers.** Stage 1 (bi-encoder recall — cosine, exists) → stage 2 (cross-encoder
rerank — `not yet exercised`) → the model (gets the reranked top-n).

**Axis — cost.** Trace the cost per stage. Stage 1 embeds the query *once* and
compares against precomputed chunk vectors — cheap, fast, runs over the whole
corpus. Stage 2 runs the model *per (query, chunk) pair* — expensive, so it only
runs over the ~50 stage-1 survivors, never the corpus. The axis "how many model
calls?" flips: stage 1 is O(1) embeddings, stage 2 is O(candidates) cross-encodes.

**Seam.** The would-be seam is the search tool: `pipeline.query(query, fetchK)`
returns the candidates (`search-knowledge-base-tool.ts:89`), and a rerank step would
re-score and re-slice them before `toResult`. Today there is no stage 2 — what the
cosine ranks, the model gets.

## How it works

### Move 1 — the mental model

You know why a database has an index *and* a `WHERE` clause. The index is a cheap
filter that's slightly imprecise; the `WHERE` is an exact predicate too expensive to
run over everything. You run the cheap filter first to get a small candidate set,
then the exact predicate on just those. Reranking is recall-then-precision:
bi-encoder for cheap recall (cast a wide net), cross-encoder for expensive precision
(judge each catch closely).

```
  Two-stage retrieval — cheap recall, expensive precision

  corpus (all chunks)
        │ stage 1: bi-encoder cosine — fast, wide
        ▼
  top-50 candidates
        │ stage 2: cross-encoder — slow, sharp, per (query,chunk) pair
        ▼
  top-5 to the model
   bi-encoder embeds q and chunk SEPARATELY; cross-encoder reads them TOGETHER
```

### Move 2 — bi-encoder vs cross-encoder, and the rerank slot

**Stage 1: the bi-encoder aptkit already has.** The cosine path is a bi-encoder
setup — query and chunks are embedded *independently* and compared by angle
(`in-memory-vector-store.ts:25`), and the tool returns the top-k with
`DEFAULT_TOP_K = 5` (`search-knowledge-base-tool.ts:22`). Independent embedding is
what makes it cheap: chunk vectors are precomputed at index time, so a query costs
one embed plus a scan.

```
  Bi-encoder (stage 1, exists) — embed separately, compare

  query ─► embed ─► qv ┐
                        ├─► cosine(qv, cv)   chunk vectors precomputed
  chunk ─► embed ─► cv ┘   cheap: query pays one embed, not one per pair
```

**Stage 2: the cross-encoder that's missing.** A cross-encoder reads the query and a
candidate chunk *together* in one model pass and outputs a relevance score for that
specific pair. It's far more accurate — it sees the interaction between query and
chunk — and far slower, because nothing is precomputed: every (query, chunk) pair is
a fresh model call. So it only runs over the handful of stage-1 survivors.

```
  Cross-encoder (stage 2, not yet exercised) — read together, score

  [query ⊕ chunk] ─► model ─► relevance score    one call PER PAIR
   only over the ~50 stage-1 candidates — never the whole corpus
```

**Where it slots in aptkit.** Single-stage today; the rerank wraps the candidate
list (`search-knowledge-base-tool.ts:89`):

```
  Reranked handler (PSEUDOCODE — not yet exercised)

  candidates = await pipeline.query(query, 50)     # widen stage-1 net (exists)
  scored     = await reranker.score(query, candidates)   # cross-encoder, NOT built
  hits       = scored.sort(desc).slice(0, 5)       # then existing toResult path
```

**Prove it with the metric the repo already has.** Reranking is only worth its cost
if it lifts a measured number. aptkit ships `scorePrecisionAtK`
(`packages/evals/src/precision-at-k.ts:47`) — the fraction of the top-k that's
relevant — and `scoreRecallAtK`. Measure precision@5 before and after the rerank:
widen stage 1 to recall@50 (catch the right chunk somewhere), then show the rerank
lifts it into the top-5.

```
  The measurement that justifies the cost (precision-at-k.ts:47)

  before: cosine top-5 ─► precision@5 = m/5
  after:  cosine top-50 ─► rerank ─► top-5 ─► precision@5 should rise
   recall@50 must already contain the right chunk, or rerank can't help
```

### Move 2.5 — current state vs future state

```
  Phase A (aptkit, now)             Phase B (reranked — not yet exercised)
  ┌────────────────────────┐        ┌──────────────────────────────────┐
  │ single-stage cosine     │        │ two-stage: cosine recall + rerank │
  │ top-5 to the model      │  add   │ cosine top-50 ─► cross-enc ─► top-5│
  │ what cosine ranks, model │ stage2 │ precision@5 measured before/after │
  │  gets                   │        │ slot: search-…-tool.ts:89          │
  └────────────────────────┘        └──────────────────────────────────┘
```

### Move 3 — the principle

Split recall from precision and pay for precision only where it counts. The cheap
stage casts a wide net over the whole corpus; the expensive stage judges only the
catch. Never run the cross-encoder over the corpus, and never ship a reranker without
a before/after precision@k number — an extra model call per chunk has to *earn* its
latency. aptkit's single-stage cosine is the right starting point, and the reranker
over its candidates is the highest-leverage next build precisely because the eval
to prove it already exists.

## Primary diagram

```
  Two-stage retrieval in aptkit terms

  query
    │ stage 1 (exists): pipeline.query — bi-encoder cosine over the corpus
    ▼
  top-50 candidates  ── recall@50 must contain the right chunk
    │ stage 2 (not yet exercised): cross-encoder scores each (query,chunk) pair
    ▼
  top-5  ─► toResult/citation (unchanged) ─► model
    │
    └─ measure: precision@5 before vs after (precision-at-k.ts:47)
```

## Elaborate

The reason reranking is the "natural next build" and not, say, GraphRAG is leverage
vs cost. aptkit already retrieves the right chunk most of the time — it just
sometimes ranks it #4 instead of #1. A cross-encoder over the existing cosine
candidates fixes ranking without touching the store, the contracts, or the agent,
and the repo *already has the eval* to prove the lift
(`packages/evals/src/precision-at-k.ts`). That combination — small surface, real
metric, common interview topic — is why it tops the build queue. Read
`06-hybrid-retrieval-rrf.md` for fusing the candidates before reranking and
`05-evals-and-observability/01-eval-set-types.md` for precision@k as the gate.

## Project exercises

### Add a rerank stage over the cosine candidates and measure precision@5
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** widen `pipeline.query` to fetch top-50 in the tool, add a
  `Reranker` that scores (query, chunk) pairs (a cross-encoder, or an LLM-judge stub
  for the test), re-sort, slice top-5; report precision@5 before and after with the
  existing scorer.
- **Why it earns its place:** this is the single highest-leverage RAG upgrade in the
  repo — small surface, the eval already exists, and "retrieve wide then rerank" is
  the most-probed two-stage pattern in interviews.
- **Files to touch:** a new `packages/retrieval/src/reranker.ts`,
  `packages/retrieval/src/search-knowledge-base-tool.ts` (around line 89),
  `packages/evals/src/precision-at-k.ts` (reuse), a new test in
  `packages/retrieval/test/`.
- **Done when:** a test shows the right chunk recalled at top-50 but ranked low by
  cosine moves into the top-5 after rerank, and precision@5 rises.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "Why two stages instead of one good ranker?"**
Cost. A cross-encoder reads the query and chunk together and is far more accurate,
but it costs one model call per (query, chunk) pair — running it over the whole
corpus is infeasible. So stage 1 is a cheap bi-encoder (precomputed chunk vectors,
one query embed, cosine scan) that recalls ~50 candidates, and stage 2 runs the
expensive cross-encoder only over those 50. Recall cheap, then precision expensive.

```
  bi-encoder: precompute chunks, cheap recall over corpus
  cross-encoder: per-pair, expensive precision over ~50 survivors only
```
Anchor: *cast a wide cheap net, then judge only the catch closely.*

**Q: "How do you know reranking actually helped?"**
Measure precision@k before and after. aptkit has `scorePrecisionAtK`
(`precision-at-k.ts:47`): widen stage 1 to recall@50 so the right chunk is *somewhere*
in the candidates, then show the rerank lifts it into the top-5 — precision@5 rises.
If recall@50 already misses the chunk, reranking can't help, and the number says so.

```
  recall@50 contains it? ─► rerank ─► precision@5 ↑   (proven, not asserted)
```
Anchor: *a reranker without a before/after precision@k number hasn't earned its latency.*

## See also

- `05-dense-vs-sparse.md` — the bi-encoder recall stage 1 builds on
- `06-hybrid-retrieval-rrf.md` — fuse candidates before reranking
- `04-vector-databases.md` — the single-stage cosine retrieval today
- `11-rag.md` — the search tool the rerank slots into
- `05-evals-and-observability/01-eval-set-types.md` — precision@k as the gate
