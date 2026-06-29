# RAG
> Retrieval-augmented generation · Industry standard

You shipped this exact shape in AdvntrCue: embed the query, cosine-search pgvector, stuff the top chunks into the prompt, let GPT-4 answer with citations. That's RAG — give the model facts it wasn't trained on, at query time, so it answers grounded in *your* corpus instead of hallucinating from its weights. aptkit's version is the same skeleton, built from scratch, with one extra thing AdvntrCue probably didn't have: a `search_knowledge_base` tool that's been hardened against a specific, nasty retrieval-quality bug — a weak local model hallucinating a metadata filter that silently wiped every result. This file walks that bug and the three pieces of the fix in detail, because they're the load-bearing skeleton of robust RAG.

## Zoom out, then zoom in

RAG is the whole stack assembled — every prior file is a component, and the `search_knowledge_base` tool is the seam where retrieval meets the agent.

```
the full RAG loop in aptkit
┌──────────────────────────────────────────────────────────┐
│  agent (Gemma) decides it needs facts → calls a tool        │
└───────────────┬────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────┐
│  ★ search_knowledge_base tool ★   the retrieval↔agent seam  │  ← you are here
│  minTopK floor · 4x over-fetch · hallucination-safe filter  │
└───────────────┬────────────────────────────────────────────┘
                ▼  pipeline.query(query, fetchK)
┌──────────────────────────────────────────────────────────┐
│  embed query (file 01) → store.search cosine (file 04)      │
│  over chunks (file 03) embedded by nomic (file 02)          │
└───────────────┬────────────────────────────────────────────┘
                ▼  ranked VectorHit[] with citations
┌──────────────────────────────────────────────────────────┐
│  agent stuffs chunks into context → generates GROUNDED answer│
└──────────────────────────────────────────────────────────┘
```

Everything below the tool you've already studied — embed, chunk, store, search. The tool is where it all becomes *agent-usable*: it turns "ranked vectors" into "cited passages an LLM can quote." And it's where retrieval quality lives or dies, because a tool that returns empty produces an ungrounded answer, and the model never tells you retrieval failed — it just makes something up.

## Structure pass

Pick the **failure** axis: how does RAG fail, and where does each failure originate?

```
failure across the RAG loop
  embed/search          the TOOL                  generation
  ┌──────────────┐     ┌──────────────────────┐   ┌──────────────────┐
  │ wrong chunks  │     │ EMPTY results          │   │ ignores context   │
  │ retrieved     │     │ (filter wiped them /   │   │ / over-trusts it  │
  │ (recall)      │     │  topK starved to 1)    │   │                   │
  └──────────────┘     └───────────┬──────────┘   └──────────────────┘
                                    ▼
              ★ seam: empty retrieval → ungrounded answer, SILENTLY ★
              the model doesn't know retrieval failed; it hallucinates
```

The seam — and the most dangerous failure — is *empty retrieval*. Wrong chunks at least give the model something to push back on; empty results give it nothing, so it falls back to its weights and confabulates with full confidence. The tool's hardening exists entirely to prevent the loop from silently returning empty. That's why the floor, the over-fetch, and the safe filter are the skeleton: each one stops a different path to "empty."

## How it works

**Move 1 — the RAG pattern.** Four steps, and the tool owns the middle two:

```
the RAG pattern
   1. RETRIEVE   embed query → cosine search → top-k chunks
   2. AUGMENT    format chunks as cited context: "[docId] passage..."
   3. STUFF      inject context + question into the prompt
   4. GENERATE   LLM answers, citing the passages
        │
        └─ grounding rule: answer FROM the chunks, say "I don't know" if absent
```

aptkit's `search_knowledge_base` tool is steps 1–2: it queries the pipeline and formats each hit into a citation string the agent can quote. Steps 3–4 are the agent's job (sub-section 04).

**The tool seam.** The tool wraps the pipeline's query path and adds the hardening:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:78-96 (the handler)
const handler: ToolHandler = async (args) => {
  const query = typeof args.query === 'string' ? args.query : '';
  const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
  const topK = Math.max(requestedTopK, minTopK);            // ← FIX 1: the floor (see below)
  const filter = /* parse args.filter if it's a plain object */;
  const fetchK = filter ? topK * 4 : topK;                  // ← FIX 2: over-fetch when filtering
  let hits = await pipeline.query(query, fetchK);
  if (filter) hits = hits.filter((h) => matchesFilter(h, filter)).slice(0, topK); // ← FIX 3 inside matchesFilter
  return { query, results: hits.map(toResult) };            // toResult builds the citation
};
```

Now the bug. A weak local model (Gemma) gets a tool whose schema allows an optional `filter` object. The model, trying to be helpful on a query like "find the part about kayaking," hallucinates a filter key that *sounds* plausible but no chunk's metadata actually has — say `{ "textContains": "kayaking" }`. A naive filter implementation (`every key must match`) then excludes *every* chunk, because no chunk has a `textContains` key. Retrieval returns empty. The agent, handed nothing, hallucinates an answer. No error anywhere. That's the signature retrieval-quality bug.

**Fix 1 — the minTopK floor.** A weak model can also starve retrieval by asking for `top_k: 1`, then miss everything in a multi-part question:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:51 and :81
const minTopK = Math.max(1, options.minTopK ?? 1);          // :51 — configurable lower bound
// ...
const topK = Math.max(requestedTopK, minTopK);              // :81 — model can't go below the floor
```

```
the floor: model asks for 1, floor forces ≥ minTopK
   model: top_k = 1   ──► Math.max(1, minTopK)   ──► topK = minTopK (e.g. 3)
   stops a weak model from starving its own retrieval on multi-part questions
```

*Remove this* and a model that under-asks retrieves one chunk for a three-part question and answers two-thirds wrong. The floor is the guardrail on the model's own bad `top_k`.

**Fix 2 — the 4x over-fetch.** Filtering *after* retrieval shrinks the result set, so you must fetch extra to still return `topK`:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:88
const fetchK = filter ? topK * 4 : topK;                    // fetch 4x when a filter will trim
```

```
over-fetch: post-filter shrinks results, over-fetch refills
   want topK=5, with filter:
     fetch 20 ──► filter trims (some don't match) ──► still ≥5 survive ──► slice(5)
   WITHOUT over-fetch: fetch 5 ──► filter trims to 2 ──► only 2 returned (starved)
```

*Remove this* and any legitimate filter that excludes some hits leaves you under `topK` — fewer chunks, weaker grounding.

**Fix 3 — the hallucination-tolerant filter.** The core fix: a filter key only excludes hits that *have* that key with a different value; keys absent from a chunk's meta are ignored:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:101-106
function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  // A filter key only excludes hits that HAVE that key with a different value.
  // Keys absent from a chunk's meta are ignored, so a weak model's hallucinated
  // filter (e.g. {textContains: "x"}) can't silently wipe every result.
  return Object.entries(filter).every(([key, value]) =>
    !(key in hit.meta) || hit.meta[key] === value);         // ← absent key ⇒ pass, not fail
}
```

```
naive filter vs hallucination-tolerant filter
  query filter: { textContains: "kayaking" }   (no chunk has a textContains key)
  NAIVE:  every key must match → key absent → FAIL → ALL chunks excluded → EMPTY ✗
  APTKIT: key absent → IGNORE that key → chunk passes → results survive ✓
          but: { docId: "guide" } on a chunk WITH docId="other" → correctly excluded ✓
```

The genius is the `!(key in hit.meta) ||` clause. A real filter on a real metadata key (`docId`, `chunkIndex`) still works — it excludes mismatches. But a *hallucinated* key that no chunk carries is simply ignored, so a bad model can't weaponize the filter into wiping retrieval. *Remove this clause* (revert to `every key matches`) and you're back to the original bug: one hallucinated filter key empties the whole result set.

**Move 3 — the principle.** RAG's load-bearing failure is silent empty retrieval, because the LLM downstream can't tell "no facts found" from "no facts needed" — it just hallucinates. So the tool seam must *refuse to return empty for the wrong reasons*: floor the model's `top_k` so it can't starve itself, over-fetch so post-filtering doesn't under-deliver, and make the filter ignore keys it doesn't recognize so a weak model's hallucinated constraint can't wipe everything. And the framing rule on top: don't RAG features that work without it — retrieval is for grounding in *your* facts, not a reflex on every query.

## Primary diagram

```
RAG end to end, with the three fixes named
   agent calls search_knowledge_base(query, top_k?, filter?)
        │
        ▼ topK = max(requestedTopK, minTopK)        ◄── FIX 1: floor (no self-starvation)
        ▼ fetchK = filter ? topK*4 : topK           ◄── FIX 2: over-fetch (filter won't starve)
   pipeline.query(query, fetchK)
        │ embed(query) → store.search → ranked VectorHit[]
        ▼
   if filter: hits.filter(matchesFilter).slice(topK) ◄── FIX 3: absent keys ignored
        │                                                  (hallucinated filter can't wipe all)
        ▼ toResult: "[docId] snippet..."  ← citation
   ranked, cited chunks ──► agent stuffs context ──► GROUNDED answer
   ─────────────────────────────────────────────────────────────────
   remove FIX 1 → multi-part questions under-retrieve
   remove FIX 2 → filtered queries return < topK
   remove FIX 3 → one hallucinated filter key → EMPTY → ungrounded answer
```

Three small guards, each closing a different path to silent empty retrieval — together they're why aptkit's RAG doesn't quietly hallucinate when a weak model misuses the tool.

## Elaborate

RAG is Lewis et al., 2020 (the original "Retrieval-Augmented Generation" paper) — the idea that you don't need to fine-tune facts into a model when you can retrieve them at inference. The frontier moved to **agentic RAG** (the model decides *whether* and *how* to retrieve, iterating — exactly aptkit's tool-call shape, sub-section 04), **RAG vs long-context** (do you retrieve or just stuff the whole corpus into a 1M-token window? — retrieval still wins on cost, freshness, and citation), and **graph RAG** (file 12). The hallucinated-filter bug is a specific instance of a general agent lesson: never trust LLM-generated tool arguments to be well-formed — validate, floor, and degrade gracefully. Bridge: AdvntrCue gave you steps 1–4; aptkit adds the tool-seam hardening that production agentic RAG needs. Read next: `07-reranking.md` (the precision stage) and the agents sub-section (who calls the tool).

## Project exercises

### Add a relevance-threshold gate (refuse to answer below score X)

- **Exercise ID:** `EX-RAG-11a`
- **What to build:** A score threshold in the tool: if the top hit's cosine score is below a configurable minimum, return an explicit "no relevant results" signal so the agent says "I don't know" instead of grounding on weak matches.
- **Why it earns its place:** The current tool always returns *something* — even garbage low-score chunks — and a weak model will dutifully cite them. A threshold turns "force an answer from bad chunks" into "honestly refuse," which is the other half of robust grounding. Phase 2A: the natural next hardening on the tool you just studied.
- **Files to touch:** `packages/retrieval/src/search-knowledge-base-tool.ts:78-96` (handler) and `:32-41` (options); the score is on `VectorHit` (`packages/retrieval/src/contracts.ts:15-19`).
- **Done when:** a query with no good match returns an empty/`belowThreshold` result the agent can detect, a query with a strong match returns chunks as before, and a test pins both around the threshold.
- **Estimated effort:** `1–4hr`

### Regression-test the three hardening fixes

- **Exercise ID:** `EX-RAG-11b`
- **What to build:** Three tests: (a) a hallucinated filter key returns full results not empty; (b) `top_k: 1` is floored to `minTopK`; (c) a filtered query still returns `topK` thanks to over-fetch.
- **Why it earns its place:** These three behaviors are subtle and easy to "simplify" away in a refactor — each test pins one path to silent empty retrieval shut. This is the safety net for the signature bug.
- **Files to touch:** test file alongside `packages/retrieval/src/search-knowledge-base-tool.ts`; exercise lines `:51`, `:81`, `:88`, `:101-106`.
- **Done when:** all three pass, and reverting `matchesFilter` to a naive `every-key-matches` makes test (a) fail.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: A weak model passed a filter and your RAG returned an empty result and hallucinated. What's the fix?**

```
{ textContains: "x" } — no chunk HAS a textContains key
  naive filter: key absent → fail → ALL excluded → empty → hallucination
  fix: !(key in hit.meta) || hit.meta[key] === value
       absent key IGNORED → real filters still work, hallucinated ones don't wipe all
```

Anchor: an LLM's tool arguments are untrusted input — the filter ignores keys no chunk carries, so a hallucinated constraint can't empty the result set while real metadata filters still exclude mismatches.

**Q: Why over-fetch 4x only when filtering, and why floor top_k?**

```
filter trims AFTER retrieval → fetch topK*4 so ≥topK survive the trim
floor: Math.max(requestedTopK, minTopK) → weak model can't ask for top_k:1
       and starve a multi-part question
```

Anchor: both guards prevent silent empty/under-retrieval — over-fetch refills what the post-filter removes, the floor stops the model starving itself; the LLM can't tell "no facts" from "few facts," so the tool must not under-deliver.

**Q: When should a feature NOT use RAG?**

```
retrieval = grounding in YOUR facts the model lacks
   feature works from the model's own knowledge? → RAG adds latency + a failure mode
   above-threshold rule: don't RAG what works without it
```

Anchor: RAG earns its cost only when the answer depends on corpus facts the model can't know — reflexively retrieving on every query adds latency and the empty-retrieval failure mode for no grounding benefit.

## See also

- [01-embeddings.md](01-embeddings.md) — the retrieve step's representation
- [04-vector-databases.md](04-vector-databases.md) — the store behind `pipeline.query`
- [07-reranking.md](07-reranking.md) — the precision stage before generation
- [12-graphrag.md](12-graphrag.md) — RAG over a graph instead of vectors
