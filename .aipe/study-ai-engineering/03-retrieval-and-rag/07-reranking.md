# Reranking
> Two-stage cross-encoder · Industry standard

Your retriever is a *bi-encoder*: it embeds the query and the chunks separately, then compares vectors. That separation is what makes it fast — you precompute every chunk's vector once. But it's also what makes it imprecise: the query and chunk never actually "look at each other," so subtle relevance gets blurred. A *cross-encoder* reranker fixes that by feeding the query and each candidate chunk through a model *together*, scoring true relevance — but it's far too slow to run over your whole corpus. So you do both: retrieve cheaply (aptkit has this), then rerank the top ~20 expensively (the gap). Critically, you only add reranking once you've *measured* that retrieval precision is your bottleneck — and aptkit can measure it. This is `not yet exercised`.

## Zoom out, then zoom in

Reranking is a second, narrower stage that would sit between retrieval and the agent.

```
two-stage retrieval (stage 2 is the gap)
┌──────────────────────────────────────────────────────────┐
│  search_knowledge_base → agent context                      │
└───────────────┬────────────────────────────────────────────┘
                ▲
┌──────────────────────────────────────────────────────────┐
│  ★ STAGE 2: cross-encoder rerank ★   ✗ not yet exercised    │  ← the gap
│  takes top ~20, scores (query,chunk) jointly, keeps top 5   │
└───────────────┬────────────────────────────────────────────┘
                ▲ over-fetch 20
┌──────────────────────────────────────────────────────────┐
│  STAGE 1: bi-encoder retrieve   pipeline.query (exists ✓)   │
│  cosine over precomputed vectors — fast, approximate         │
└──────────────────────────────────────────────────────────┘
```

aptkit has stage 1 — `queryKnowledgeBase` does the cheap cosine retrieve. Stage 2 is the precision pass it lacks. The shape is "retrieve wide, rerank narrow": ask the cheap retriever for 20 candidates, run the expensive cross-encoder over just those 20, return the best 5. You'd never run a cross-encoder over 10k chunks — that's the point of staging.

## Structure pass

Pick the **cost** axis: what does each stage pay, and what does it buy?

```
cost vs precision across the two stages
  STAGE 1 (bi-encoder)              STAGE 2 (cross-encoder)
  ┌──────────────────────┐         ┌──────────────────────────┐
  │ query & chunk embedded │         │ query & chunk scored      │
  │ SEPARATELY             │         │ TOGETHER (joint attention)│
  │ vectors precomputed    │         │ NOTHING precomputable     │
  │ cost: O(n) cheap ops   │         │ cost: 1 model call /chunk │
  │ precision: blurry      │         │ precision: sharp          │
  └──────────────────────┘         └──────────────────────────┘
   run over: whole corpus            run over: top ~20 only
        ▲ seam: candidate-set size is what makes stage 2 affordable ▲
```

The seam is the candidate set. A cross-encoder is ~100x the cost per pair of a cosine compare, so it's affordable only because stage 1 already narrowed 10k chunks to 20. Flip it — run the cross-encoder first — and the latency is catastrophic. The two stages are cheap-and-wide then expensive-and-narrow, and that ordering is non-negotiable.

## How it works

**Move 1 — bi-encoder vs cross-encoder.** The whole distinction is *when* the query meets the chunk:

```
bi-encoder (retrieve)              cross-encoder (rerank)
  query ──► [encoder] ──► q_vec      ┌──────────────────────┐
  chunk ──► [encoder] ──► c_vec      │ [query  ‖  chunk]     │  concatenated
                  │                  │        ↓              │
            cosine(q_vec, c_vec)     │   [transformer]       │  joint attention
                  │                  │        ↓              │
            score (chunks scored     │   relevance score     │  query & chunk
            INDEPENDENTLY)           └──────────────────────┘  attend to each other
   FAST: c_vec precomputed once       SLOW: must run per (query,chunk) pair
```

In a bi-encoder the chunk's vector is computed once at index time and never sees the query. In a cross-encoder there's nothing to precompute — every (query, chunk) pair is a fresh forward pass — which is exactly why it's both more accurate (the two texts attend to each other) and too slow for the whole corpus.

**Move 2 — the staged flow.** aptkit already over-fetches; reranking would slot into that pattern. `not yet exercised`:

```
proposed rerank step (pseudocode — DOES NOT EXIST in aptkit)
function searchWithRerank(query, finalK = 5):
    candidates = pipeline.query(query, finalK * 4)     # stage 1: over-fetch 20
    scored = []
    for chunk in candidates:
        s = crossEncoder.score(query, chunk.meta.text) # stage 2: joint score, 1 call each
        scored.push({ ...chunk, score: s })
    return sort(scored by s DESC)[:finalK]             # keep the sharpest 5
```

The over-fetch instinct already lives in aptkit's tool — the filtering path fetches 4x before trimming:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:88-90
const fetchK = filter ? topK * 4 : topK;        // ← over-fetch when post-processing
let hits = await pipeline.query(query, fetchK);
if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
//          a reranker would slot in HERE: fetch wide, rescore, slice to topK
```

A reranker is the same shape as that filter: fetch `topK * N`, post-process, slice to `topK`. The seam already exists in the tool — reranking reuses it, swapping the boolean filter for a relevance rescore.

**The gate — measure before you rerank.** This is the part people skip. Reranking adds latency and a model dependency; you earn it only if retrieval precision is actually your problem. aptkit can measure that:

```
the measurement gate (cross-link to file 05/evals)
   build a fixture: queries with KNOWN relevant chunk ids
        │
        ▼ run stage-1 retrieval
   hit@k = fraction of queries where the right chunk is in top-k
        │
        ├─ hit@5 already high (>0.9)? → DON'T rerank (no headroom)
        └─ hit@20 high but hit@5 low? → RERANK (right chunk is retrieved,
                                          just ranked too low — exactly
                                          what a cross-encoder fixes)
```

The diagnostic that *justifies* reranking is specifically "hit@20 ≫ hit@5": the relevant chunk is in the candidate set but ranked 8th instead of 2nd. That's a precision problem a reranker solves. If hit@20 is also low, the chunk isn't being retrieved at all — that's a *recall* problem, and reranking can't conjure a candidate that isn't there.

**Move 3 — the principle.** Reranking is a precision tool with a strict precondition: the relevant chunk must already be in the candidate set. So you measure first. The architecture is always "retrieve wide and cheap, then rerank narrow and expensive," and you add stage 2 only when the numbers say recall is fine but ranking is off. Bolting a cross-encoder onto a recall problem burns latency and fixes nothing.

## Primary diagram

```
two-stage retrieval, gated on measurement
   query
     │ stage 1: pipeline.query(query, 20)   ← cheap, wide, recall
     ▼
   [20 candidates by cosine]
     │   ┌─────── GATE: is hit@20 ≫ hit@5? ───────┐
     │   │ NO  → skip rerank (no precision gap)     │
     │   │ YES → proceed                            │
     │   └──────────────────────────────────────────┘
     ▼ stage 2: crossEncoder.score(query, chunk) × 20  ← expensive, narrow, precision
   [20 rescored] ── sort ── slice(5) ──► top 5 sharpest ──► agent
```

Retrieve wide, gate on measured precision, rerank narrow — skip stage 2 unless the candidate set already contains the answer but ranks it poorly.

## Elaborate

The bi-/cross-encoder split is from the Sentence-BERT line of work (Reimers & Gurevych, 2019); the SBERT library popularized the two-stage retrieve-then-rerank pattern. Today you'd reach for **cross-encoder/ms-marco-MiniLM** (a small local reranker — fits aptkit's local-first stance), Cohere Rerank, or BGE-reranker (hosted/heavier). Adjacent: **ColBERT** (late interaction — a middle ground between bi- and cross-encoder that precomputes per-token vectors), and **listwise rerankers** (LLM-as-reranker — feed all candidates to an LLM and ask it to order them). The measurement piece connects to sub-section 05 (evals): hit@k / precision@k is the metric that gates this whole decision. Read next: `06-hybrid-retrieval-rrf.md` (the fusion stage reranking often follows) and the evals sub-section for the measurement harness.

## Project exercises

### Measure hit@k first, add rerank only if it helps

- **Exercise ID:** `EX-RAG-07a`
- **What to build:** A retrieval-quality harness — a fixture of queries with known-relevant chunk ids — that reports hit@5 and hit@20 over `pipeline.query`. Add a cross-encoder rerank step *only* on the queries where hit@20 ≫ hit@5, and re-measure.
- **Why it earns its place:** This is the disciplined version: the harness is the artifact that *justifies or rejects* reranking, and it's reusable for every other retrieval change (chunking, hybrid). Building the measurement before the feature is the whole lesson. Case B. Phase 2B.
- **Files to touch:** new harness under `packages/retrieval/`; measures `queryKnowledgeBase` (`packages/retrieval/src/pipeline.ts:50-59`); rerank step slots into the over-fetch seam in `packages/retrieval/src/search-knowledge-base-tool.ts:88-90`.
- **Done when:** the report shows hit@5 vs hit@20 per query, and the rerank step is added only where the gap exists — with before/after hit@5 proving it moved the metric (or proving it didn't, and you back it out).
- **Estimated effort:** `1–2 days`

### Wire a local cross-encoder behind a Reranker contract

- **Exercise ID:** `EX-RAG-07b`
- **What to build:** A `Reranker { rerank(query, hits, topK): VectorHit[] }` contract + a stub/local implementation, slotted into the search tool's over-fetch path.
- **Why it earns its place:** Names the seam so reranking is a drop-in adapter (like `EmbeddingProvider`), not a hardcoded branch — and proves the over-fetch path generalizes beyond the existing filter.
- **Files to touch:** new `packages/retrieval/src/reranker.ts`; integrate at `packages/retrieval/src/search-knowledge-base-tool.ts:88-90`.
- **Done when:** the tool optionally reranks the over-fetched candidates and slices to `topK`, with a test using a deterministic stub reranker.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why not just use the cross-encoder for retrieval and skip the bi-encoder?**

```
cross-encoder: 1 model call PER (query, chunk) pair, nothing precomputable
  over 10k chunks = 10k forward passes per query = seconds-to-minutes
bi-encoder: chunk vectors precomputed once; query is 1 embed + cheap cosine
```

Anchor: a cross-encoder can't precompute chunk representations, so running it over the whole corpus is intractable — it only works on a pre-narrowed candidate set.

**Q: Reranking didn't improve your answers. What did you fail to check?**

```
hit@20 ≫ hit@5  → precision gap → rerank HELPS
hit@20 ALSO low → recall gap → relevant chunk isn't even retrieved
                  → reranking can't promote what isn't there
```

Anchor: reranking only reorders the candidate set — if the right chunk isn't retrieved into the top-20, reranking is powerless; that's a recall problem (better chunking/embedding/hybrid), not a ranking one.

## See also

- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — fusion, the stage reranking often follows
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — recall-side fixes when reranking can't help
- [11-rag.md](11-rag.md) — where the reranked list feeds the agent
