# Lost in the middle

**Subtitle:** Position bias in long contexts · retrieve few, rank well · *Industry pattern, aptkit mitigates by top-k*

## Zoom out, then zoom in

Before the failure mode, here's where the lever lives in aptkit. The search tool
sits between the agent and the vector store, and the one knob that fights this
problem is how many chunks it returns.

```
  Zoom out — where the count is decided

  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  rag-query agent: "search first, then answer"                │
  └───────────────────────────┬─────────────────────────────────┘
                              │ search_knowledge_base(query, top_k)
  ┌─ Retrieval tool ──────────▼─────────────────────────────────┐
  │  ★ createSearchKnowledgeBaseTool ★  top_k default 5, minTopK │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ pipeline.query(query, k)
  ┌─ Vector store ────────────▼─────────────────────────────────┐
  │  cosine similarity, sort desc, slice(k) — best k chunks      │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. "Lost in the middle" is a measured property of LLMs: when you stuff
a lot of content into the context, the model reliably uses what's near the
*start* and the *end*, and reliably under-uses what's in the *middle*. Accuracy
sags in the center even when the answer is sitting right there. The naive RAG
instinct — "retrieve 20 chunks, the model will find the right one" — walks straight
into this. aptkit's stance is the opposite: retrieve *few*, rank them *well*, and
keep the high-relevance chunks where the model actually reads.

## Structure pass

**Layers.** Agent asks → search tool chooses `k` → vector store ranks by cosine
and returns the top `k`. The count `k` is the lever.

**Axis — how many chunks reach the model?** Trace it. The model may request a
`top_k`; the tool floors it at `minTopK` and defaults to 5
(`search-knowledge-base-tool.ts:22,50,80-81`); the store sorts all chunks by
score and slices `k` (`in-memory-vector-store.ts:31-32`). Small, ranked, top-of-
list. The opposite design — return everything and let the model sort it out —
maximizes middle content, exactly what the model ignores.

**Seam.** The boundary is `pipeline.query(query, fetchK)` called from the tool
handler (`search-knowledge-base-tool.ts:89`). Above it: a model that asked a
question. Below it: a ranked, length-bounded result list. The axis "how much does
the model have to read?" flips here — above, one query; below, exactly `k`
scored chunks.

## How it works

### Move 1 — the mental model

You know how users read a long list: they read the top few items, glance at the
bottom, and skim past the middle. Search results, a long settings page, an
infinite feed — the middle is dead zone. The LLM has the same attention profile
over its context. So you don't fight the reader's behavior; you put the important
thing where they look. In RAG terms: return few enough chunks that there *is* no
neglected middle, and order them so the best one is at the top.

```
  Attention over context position (the failure mode)

  recall │█████                              █████
         │█████ ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ █████
         │ high │       low (the middle)      │ high
         └──────┴─────────────────────────────┴────────► position
           start            middle               end
   stuff 20 chunks → the right one lands in the dead zone → missed
```

### Move 2 — aptkit's lever, step by step

**Default to few, not many.** The tool's default `top_k` is 5, not 20 or 50.
From `search-knowledge-base-tool.ts:22,50`:

```ts
const DEFAULT_TOP_K = 5;
// ...
const defaultTopK = options.defaultTopK ?? DEFAULT_TOP_K;
```

Five chunks is small enough that there's barely a middle to get lost in. This is
the mitigation: you never create the long-context condition in the first place.

```
  top_k = 5 — no dead zone to fall into

  ┌──[1]──┐ best
  ┌──[2]──┐
  ┌──[3]──┐  ← "middle" is two chunks, not eighteen
  ┌──[4]──┐
  ┌──[5]──┐ worst of the kept set
   all five are near an edge of the prompt
```

**Floor the count so a weak model can't starve itself.** A small local model
sometimes asks for `top_k: 1`, which misses multi-part questions. `minTopK`
clamps the floor. From `search-knowledge-base-tool.ts:51,80-81`:

```ts
const minTopK = Math.max(1, options.minTopK ?? 1);
// ...
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);   // never below the floor
```

So the count is bounded on *both* sides by intent: default keeps it from being
huge, `minTopK` keeps it from collapsing to one. The model proposes, the tool
disposes.

```
  topK = max(requestedTopK, minTopK)

   model asks top_k:1 ──► max(1, minTopK) ──► floored up
   model omits top_k  ──► defaultTopK (5)
   model asks top_k:50──► passed through (caller can cap upstream)
```

**Rank well — cosine, sort desc, slice.** "Few" only helps if the few are the
*right* few. The store scores every chunk by cosine similarity, sorts highest
first, and returns the top slice. From `in-memory-vector-store.ts:28-32`:

```ts
for (const chunk of this.chunks.values()) {
  hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
}
hits.sort((a, b) => b.score - a.score);   // best relevance first
return hits.slice(0, Math.max(0, k));     // keep only k
```

Because the list is sorted by relevance descending, the most relevant chunk is
chunk #1 — the top of the prompt, the high-attention zone. Ranking *is* the
position mitigation: best content lands where the model reads.

```
  rank → slice → best at the top of the prompt

  all chunks ──cosine──► [0.91, 0.88, 0.55, 0.40, 0.31, 0.12, ...]
                            │ sort desc
                            ▼
                         [0.91, 0.88, 0.55, 0.40, 0.31]  slice(5)
                            ▲ chunk #1 = highest relevance = start of context
```

**What aptkit does NOT do.** It does not rerank by *position* — there's no pass
that reorders the kept chunks to push the most relevant ones to both the start
and the end of the prompt (the textbook lost-in-the-middle fix). There's also no
cross-encoder reranker re-scoring candidates after retrieval. Both are `not yet
exercised`. aptkit's bet is simpler: keep `k` small enough that position bias
barely bites, and rely on cosine ranking to put the best chunk first. If recall
ever degraded at scale, position-aware reranking is the next move — and it would
slot in right after `pipeline.query` returns, before the chunks become a
`tool_result`.

### Move 3 — the principle

Don't fight the model's attention curve — avoid creating the condition that
triggers it. The lever is the *count*, governed at the tool boundary: default
small, floor sensible, rank by relevance so the best chunk sits at the top. "More
context" is not "more signal"; past a small `k`, extra chunks mostly add middle
that the model neglects and tokens you pay for. Retrieve few, rank well.

## Primary diagram

```
  Retrieve-few-rank-well as the lost-in-the-middle mitigation

  agent                     search tool                    vector store
  ┌──────────┐  query+top_k ┌────────────────────┐  query,k ┌──────────────┐
  │ "search  │ ───────────► │ topK = max(         │ ───────► │ cosine score │
  │  first"  │              │   requested||5,     │          │ sort desc    │
  │          │ ◄─────────── │   minTopK)          │ ◄─────── │ slice(k)     │
  └──────────┘  ≤5 ranked   └────────────────────┘  k hits  └──────────────┘
                chunks
   model reads a SHORT, RANKED list → best chunk at top → no neglected middle
   (position-reranking / cross-encoder rerank = not yet exercised)
```

## Elaborate

The lost-in-the-middle finding is robust across model families and context
lengths — it's not a quirk of one model, it's how attention over long sequences
behaves. The standard mitigations split into two families: *reduce* (retrieve
fewer, higher-quality chunks) and *reorder* (place the best chunks at the
start and end where attention peaks). aptkit commits hard to "reduce" via
`top_k: 5` plus cosine ranking, and skips "reorder" entirely. That's a reasonable
call for a personal knowledge base where the corpus is small and five chunks
genuinely covers most questions; it would *not* hold for a large enterprise corpus
where you must over-fetch dozens of candidates and rerank. Note the one place
aptkit over-fetches: when a metadata filter is present it fetches `topK * 4` and
post-filters back down (`search-knowledge-base-tool.ts:88-90`) — but it still
returns only `topK`, so the model never sees the long list. Read
`03-prompt-chaining.md` next: another way to keep context short is to never put
everything in one prompt at all — split the work across steps.

## Project exercises

### Add position-aware reranking after retrieval

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a pure function `interleaveByRelevance(hits)` that takes the
  cosine-sorted hits and reorders them so the top chunks land at the *start and
  end* of the returned array (best, 3rd, 5th... then ...6th, 4th, 2nd), then call
  it in the tool handler before `toResult`.
- **Why it earns its place:** implements the canonical lost-in-the-middle fix the
  repo currently skips, and proves you understand position bias, not just count.
- **Files to touch:** `packages/retrieval/src/search-knowledge-base-tool.ts`, plus
  a test in `packages/retrieval/test/` asserting the highest-score chunk is first
  and the second-highest is last.
- **Done when:** `node --test` shows a 5-hit input comes back reordered with the
  two best scores at index 0 and index 4.
- **Estimated effort:** `1–4hr`

### Make top_k respond to query complexity

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** raise `minTopK` (or the effective `topK`) when the query
  looks multi-part — e.g. detect a conjunction ("and", "compare", "versus") and
  bump the floor — so multi-part questions surface more evidence without globally
  inflating `k`.
- **Why it earns its place:** turns the `minTopK` knob from a static floor into a
  signal-aware one, the kind of judgment that separates "set a constant" from
  "matched retrieval to the question."
- **Files to touch:** `packages/retrieval/src/search-knowledge-base-tool.ts`, plus
  a test asserting a single-clause query returns the default and a conjunction
  query returns more.
- **Done when:** a test passing a two-part query yields a larger result set than a
  one-part query against the same store.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "How does aptkit avoid lost-in-the-middle in its RAG path?"**
It avoids creating the condition. The search tool defaults to `top_k: 5` and the
store ranks chunks by cosine similarity descending, so the model reads a short
list with the most relevant chunk at the top — there's barely a middle to neglect.
It does not rerank by position; that's `not yet exercised`.

```
  20 chunks ──► middle ignored        5 ranked chunks ──► best at top, all near edges
   (the failure)                       (aptkit: retrieve few, rank well)
```
Anchor: *`DEFAULT_TOP_K = 5` plus `sort desc; slice(k)` — `search-knowledge-base-tool.ts:22`, `in-memory-vector-store.ts:31`.*

**Q: "Why not just retrieve more chunks to be safe?"**
Because more chunks means more middle, which the model under-attends to, plus more
tokens you pay for and a closer brush with the window budget. Past a small `k`,
extra chunks add noise, not signal. The floor (`minTopK`) guards the other
direction so a weak model can't collapse to `top_k: 1` and miss multi-part
questions.

```
  k too high ──► neglected middle + token cost
  k too low  ──► misses multi-part questions  ──► minTopK floor
  k ≈ 5, ranked ──► the sweet spot
```
Anchor: *the tool clamps both ends — `topK = max(requestedTopK, minTopK)` at `search-knowledge-base-tool.ts:81`.*

## See also

- `01-context-window.md` — fewer chunks also means more budget headroom
- `03-prompt-chaining.md` — splitting work is another way to keep each context short
- `../01-llm-foundations/08-provider-abstraction.md` — the store contract that hides cosine vs pgvector
