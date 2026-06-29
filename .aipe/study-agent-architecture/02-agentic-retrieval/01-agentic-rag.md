# Agentic RAG

**Industry term:** agentic RAG (retrieval as a tool the agent decides to call). *Industry standard.*

## Zoom out, then zoom in

This is the pattern worth studying in aptkit above all others. Static RAG splices retrieved chunks into the prompt before generation — the engineer decides to retrieve. Agentic RAG makes retrieval a *tool the model calls when it judges it needs grounding*. The model owns the *when*; the loop owns the *budget*. That split is the whole idea.

```
  Zoom out — retrieval reaches the agent as a tool, not a prompt-splice

  ┌─ Capability layer (rag-query agent) ────────────────────────┐
  │  RagQueryAgent.answer — model decides whether to search      │ ← we are here
  └───────────────────────────────┬──────────────────────────────┘
                                   │ runAgentLoop → tool_use: search_knowledge_base
  ┌─ Tools layer ───────────────────▼───────────────────────────┐
  │  search_knowledge_base tool (minTopK floor + filter guard)   │
  └───────────────────────────────┬──────────────────────────────┘
                                   │ pipeline.query()
  ┌─ Retrieval layer ───────────────▼───────────────────────────┐
  │  EmbeddingProvider (Ollama nomic, 768) + VectorStore (cosine)│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the `rag-query` agent (`packages/agents/rag-query/src/rag-query-agent.ts`) is the capstone. It composes a Gemma provider + the `search_knowledge_base` tool + an injected profile through `runAgentLoop`. The model decides to call the tool, reads the ranked chunks, and grounds its answer in them — or, if nothing comes back, says so. That's ReAct whose primary tool is retrieval.

## The structure pass

**Layers.** The agent (decides *whether/what* to search) over the tool (executes one ranked search) over the pipeline (embed → cosine search → rank).

**Axis: control — who decides to retrieve?** This is the axis that separates static from agentic RAG.

```
  "who decides to retrieve?" — the static→agentic flip

  ┌─ static RAG ─────┐   seam    ┌─ agentic RAG ─────┐
  │ ENGINEER splices │ ═══╪═════► │ MODEL calls the    │
  │ chunks in front  │ (it flips) │ tool when it judges│
  │ of generation    │            │ it needs grounding │
  └──────────────────┘           └───────────────────┘
```

**The seam.** The `search_knowledge_base` tool boundary. The model emits a `tool_use` with a query and top_k; the tool runs the pipeline and returns ranked, cited chunks. The loop bounds how many times this can happen (`maxToolCalls: 4`).

## How it works

**Use case in aptkit:** the personal knowledge assistant. Index a corpus (the reader's notes, profile, docs), then ask free-text questions. The agent retrieves grounding when it needs it and cites sources.

### Move 1 — the mental model

You already know static RAG as a shape: retrieve → augment → generate, one pass, no second try. Agentic RAG is that shape wrapped in a `while` loop where the model decides each iteration whether one more retrieval would help — like a `fetch` you fire conditionally based on what the last response told you, not unconditionally up front.

```
  Static RAG (one shot):
    query → retrieve top-k → stuff → generate   (no evaluation, no retry)

  Agentic RAG (a loop):
  ┌───────────────────────────────────────────────┐
  │  model decides: do I need to search?           │
  └────────────────────┬──────────────────────────┘
             ┌──────────┴──────────┐
             ▼ yes                 ▼ no
   search_knowledge_base      answer directly
        │ ranked chunks
        ▼
   evaluate: enough to answer? ──no──► search again (refine)
        │ yes                              │
        ▼                                  └── loop (capped at 4 calls)
   generate grounded + cited answer
```

### Move 2 — the walkthrough

**The tool is the seam — retrieval is not bespoke control flow.** `search_knowledge_base` (`packages/retrieval/src/search-knowledge-base-tool.ts`) is a normal tool with a JSON schema. The agent reaches it through the same `runAgentLoop` machinery as any other tool. There's no special "RAG mode" in the loop — retrieval is just a tool the model is allowed to call:

```ts
// rag-query-agent.ts:15 — least-privilege: this agent may ONLY search
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // exactly one tool
};
```

**The model owns the when; the loop owns the budget.** The system prompt nudges ("Always call search_knowledge_base first"), but the *decision* and the *query text* come from the model each turn. The loop caps the spend:

```ts
// rag-query-agent.ts:66 — model decides; loop bounds
await runAgentLoop({
  system: this.system,          // "...call search first, ground every answer, cite sources"
  userPrompt: question,
  toolSchemas,                  // just search_knowledge_base
  maxTurns: 6,
  maxToolCalls: 4,              // ← the budget the model can't exceed
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.'),
});
```

**Hardening a weak model: the minTopK floor.** Gemma has no native tool-calling and is weak — left alone it sometimes asks for `top_k: 1`, starving its own retrieval on a multi-part question. The tool clamps a floor:

```ts
// search-knowledge-base-tool.ts:51 — floor against a weak model starving itself
const minTopK = Math.max(1, options.minTopK ?? 1);
// ...
const topK = Math.max(requestedTopK, minTopK);   // :81 — model can't go below the floor
```

Set `minTopK` above 1 and the model physically cannot retrieve fewer than that many chunks, even if it asks. This is the concrete fix for multi-part-question misses — a structural guard, not a prompt plea.

**Hardening a weak model: the hallucination-tolerant filter.** A weak model sometimes hallucinates a metadata filter (`{textContains: "x"}`) that, applied strictly, would wipe every result. aptkit's `matchesFilter` only excludes a hit that *has* that key with a *different* value — keys the chunk doesn't have are ignored:

```ts
// search-knowledge-base-tool.ts:101 — a hallucinated filter can't silently wipe results
function matchesFilter(hit: VectorHit, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(
    ([key, value]) => !(key in hit.meta) || hit.meta[key] === value,
  );
}
```

Both guards exist for the same reason: agentic retrieval hands the model control of the retrieval parameters, and a weak model abuses that control. The fix is structural floors and tolerant matching, not trusting the model.

**Citations come back with the chunks.** The tool returns `{ id, score, citation, meta }` where `citation` is a `[docId] snippet` string (`toResult`, `search-knowledge-base-tool.ts:108`). The model sees the source inline, so grounding-with-citation is one tool call, not a separate step.

### Move 2.5 — current state vs the agentic-RAG ceiling

aptkit's agentic RAG is the *first rung*: the model decides whether and what to search, and can search again within budget. It does **not** decompose a query into sub-questions or run an explicit relevance-grade step before generating (that's `02-self-corrective-rag.md`). So:

```
  Phase A (now):  model decides when/what to search → up to 4 searches → answer
                  (re-search is the model's call; no explicit grader)

  Phase B (would add):  decompose query → retrieve per sub-question →
                        grade chunks → re-retrieve on low relevance → synthesize
```

What doesn't have to change to reach Phase B: the tool, the pipeline, the contracts. Phase B is more loop structure and a grader, layered on the same `search_knowledge_base` seam.

### Move 3 — the principle

The reframe to keep: *all agentic RAG is agentic AI; not all agentic AI does retrieval.* Agentic RAG is just ReAct whose primary tool happens to be retrieval. The tradeoff is steep — roughly 3-10x token cost and 2-5x latency over static RAG — so use the loop only when one-shot retrieval measurably fails on multi-step or cross-source queries. aptkit pays it because a single-shot retrieval can't handle "search, see it's not enough, refine and search again," which is exactly what a weak local model needs the option to do.

## Primary diagram

```
  aptkit agentic RAG — full loop, one frame
  (rag-query agent → search_knowledge_base → retrieval pipeline)

  question ─► runAgentLoop (maxToolCalls: 4)
                  │
       ┌──────────▼─────────── model turn ──────────────────┐
       │  decide: search or answer?                          │
       │     │ search                    │ answer            │
       │     ▼                           ▼                   │
       │  tool_use: search_knowledge_base   final text       │
       │     │  { query, top_k }              + citations    │
       │     ▼                                               │
       │  TOOL: clamp top_k≥minTopK ─► pipeline.query()       │
       │        ─► cosine search ─► rank ─► tolerant filter   │
       │     │  ranked chunks + [docId] citations             │
       │     ▼                                               │
       │  observe ─► loop (until enough, or budget) ──────────┘
                  │ budget hit
                  ▼
       forceFinal: tools withheld + "answer now, cite sources"
```

## Elaborate

Agentic RAG emerged when teams hit static RAG's ceiling: one-shot top-k retrieval can't handle queries that need decomposition, cross-source lookup, or "that wasn't enough, try again." Making retrieval a tool inside a ReAct loop solves it — at a steep token/latency cost. aptkit's version is notable for *who it's hardened against*: a weak, tool-call-less local model. The `minTopK` floor and tolerant filter are the scar tissue of running this loop on Gemma instead of GPT-4. That's the load-bearing lesson — agentic RAG hands the model the retrieval knobs, and the production work is bounding what a bad model does with them.

## Interview defense

**Q: What makes aptkit's RAG "agentic" rather than static?**

Retrieval is a tool the model calls, not a prompt-splice the engineer wires in. The `rag-query` agent hands the model exactly one tool — `search_knowledge_base` — and the model decides whether to call it, what query to use, and whether to search again, all inside a bounded loop.

```
  static:  engineer retrieves → stuffs → generates  (one shot)
  agentic: MODEL decides to search → loop → ground   (model owns WHEN)
```

*Anchor: the model owns the when; the loop owns the budget (maxToolCalls: 4).*

**Q: You're running this on a weak local model. How do you stop it from breaking its own retrieval?**

Two structural guards in the tool. A `minTopK` floor so it can't ask for `top_k: 1` and starve a multi-part question. And a hallucination-tolerant filter — `matchesFilter` only excludes hits that *have* a key with a different value, so a hallucinated filter can't wipe every result.

```
  model asks top_k:1  →  clamp to minTopK  →  enough chunks
  model hallucinates filter  →  tolerant match  →  results survive
```

*Anchor: hand the model the retrieval knobs, then bound them structurally — don't trust a weak model to set them well.*

## See also

- [02-self-corrective-rag.md](02-self-corrective-rag.md) — adding a relevance grader (the Phase B above).
- [../01-reasoning-patterns/03-react.md](../01-reasoning-patterns/03-react.md) — agentic RAG is ReAct with a retrieval tool.
- RAG / embeddings / chunking / vector-store mechanics: `.aipe/study-ai-engineering/03-retrieval-and-rag/`.
- The retrieval-neutral contracts and the buffr pgvector binding: `.aipe/study-system-design/`.
