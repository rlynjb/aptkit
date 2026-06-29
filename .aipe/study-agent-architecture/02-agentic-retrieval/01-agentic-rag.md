# Agentic RAG

**Industry standard.** "Agentic RAG," "retrieval-as-a-tool," "tool-calling RAG." Type label: reasoning pattern (ReAct with retrieval as the primary tool). **In this codebase: yes — the rag-query agent is the capstone instance.**

## Zoom out, then zoom in

This is the most interesting agent-architecture decision in aptkit, and it's worth stating sharply: **retrieval is a tool, not a prompt-splice.** Static RAG retrieves once, stuffs the chunks into the prompt, and generates — the framework decides when to retrieve. Agentic RAG hands the model a `search_knowledge_base` tool and lets *the model* decide when (and whether) to call it, how to phrase the query, and whether one search was enough.

```
  Zoom out — retrieval-as-a-tool in aptkit

  ┌─ Agent layer ───────────────────────────────────────────┐
  │  RagQueryAgent.answer()   rag-query-agent.ts:62          │
  └───────────────────────────┬──────────────────────────────┘
                              │ runs runAgentLoop with ONE tool
  ┌─ Loop layer ──────────────▼──────────────────────────────┐
  │  ★ model decides WHEN to call search_knowledge_base ★    │ ← we are here
  │  loop owns the budget (maxToolCalls: 4)                   │
  └───────────────────────────┬──────────────────────────────┘
                              │ tool wraps the query path
  ┌─ Retrieval layer ─────────▼──────────────────────────────┐
  │  pipeline.query → embed → InMemoryVectorStore.search      │
  └────────────────────────────────────────────────────────────┘
```

The reframe to hold onto: *all agentic RAG is agentic AI; not all agentic AI does retrieval.* aptkit's rag-query agent is agentic RAG; its recommendation agent is agentic AI that happens to use 13 non-retrieval tools.

## Structure pass

**Layers:** agent → loop → retrieval pipeline → vector store. **Axis: who decides *when* to retrieve?** Trace it and the difference from static RAG is the whole lesson.

```
  "who decides when to retrieve?" — static vs agentic

  STATIC RAG:                      AGENTIC RAG (aptkit):
  ┌─ framework ─┐                  ┌─ model ──────────┐
  │ retrieve    │ → always, once   │ call search tool │ → when it judges
  │ then stuff  │                  │ ...maybe again   │   it needs grounding
  └─────────────┘                  └──────────────────┘
       │                                │
  CODE decides when                LLM decides when (loop caps how many)
```

**The seam that flips:** control over *when to retrieve* moves from CODE (static) to LLM (agentic). That single flip is what makes RAG "agentic." The loop's `maxToolCalls` is the code reasserting the budget — the model picks when, the loop picks how many.

## How it works

### Move 1 — the mental model

You know how a ReAct loop calls whatever tool it needs? Agentic RAG is that loop where the primary tool happens to be search. The model reasons "I need to know X," calls `search_knowledge_base("X")`, reads the ranked chunks, and either answers or searches again for a missing piece.

```
  Agentic RAG = ReAct whose primary tool is retrieval

  ┌─ decompose / decide what to look up ────────────┐
  └────────────────────┬─────────────────────────────┘
                       ▼
  search_knowledge_base(query, top_k)  ← model calls when it needs grounding
                       │
                       ▼
  ┌─ evaluate: enough to answer? ───────────────────┐
  └──────────┬─────────────────────┬─────────────────┘
             ▼ no                  ▼ yes
        search again           generate cited answer
             │
             └──── loop (capped: maxToolCalls 4)
```

### Move 2 — the three packages composed

The rag-query agent is the 6th instance of aptkit's capability shape: **model + tool registry + profile, composed through `runAgentLoop`.**

**Package A — the model (the *when* owner).** A `ModelProvider` (typically the guarded Gemma local model). It decides whether to search.

**Package B — the tool registry (the *what* it can do).** Holds `search_knowledge_base`, filtered to a one-tool allowlist so this agent can do nothing *but* search.

```typescript
// packages/agents/rag-query/src/rag-query-agent.ts:14-18
/** Least-privilege grant: this agent may only search the knowledge base. */
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← exactly one tool
};
```

**Package C — the profile (the *who* it's serving).** `injectProfile` splices the user's `me.md` into the system prompt so answers are personalized — context engineering, covered in SECTION D.

```typescript
// packages/agents/rag-query/src/rag-query-agent.ts:54-58
const withProfile = options.profile
  ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
  : template;
this.system = renderPromptTemplate(withProfile, {});
```

**The loop wiring — the *when* meets the budget.** `answer()` filters the tools to the policy, then runs the loop with retrieval-tuned caps:

```typescript
// packages/agents/rag-query/src/rag-query-agent.ts:63-80
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);
const { finalText } = await runAgentLoop({
  model: this.options.model,
  tools: this.options.tools,
  system: this.system,
  userPrompt: question,
  toolSchemas,                  // ← only search_knowledge_base
  maxTurns: 6, maxToolCalls: 4, // ← model owns WHEN; loop owns HOW MANY
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the question directly and concisely, citing the sources you retrieved.'),
});
return finalText.trim() || FALLBACK_ANSWER;
```

The system prompt nudges the model to search first (`rag-query-agent.ts:23`), but it's a *nudge*, not a forced splice — the model could answer without searching, and on a question the KB can't answer it's told to say so plainly rather than guess (line 25). That's the agentic property: the model owns the decision.

**The tool itself — the query path wrapped for the model.** `search_knowledge_base` embeds the query, searches the store, and returns ranked chunks *with citations* so the model can ground its answer.

```typescript
// packages/retrieval/src/search-knowledge-base-tool.ts:78-96
const handler: ToolHandler = async (args) => {
  const query = typeof args.query === 'string' ? args.query : '';
  const requestedTopK = ... ;
  const topK = Math.max(requestedTopK, minTopK);   // ← the floor (next file)
  let hits = await pipeline.query(query, fetchK);
  return { query, results: hits.map(toResult) };   // toResult builds the citation (:108)
};
```

`toResult` (line 108) builds a `[docId] snippet` citation per hit, so when the model answers it has the provenance to cite. The boundary condition: if the model passes `top_k: 1` (a weak-model failure), the `minTopK` floor catches it before it starves a multi-part question — that's the self-corrective guard, next file.

### Move 2.5 — current state vs future state

aptkit's vector store is `InMemoryVectorStore` (a cosine scan over an array). The retrieval *contracts* (`EmbeddingProvider`, `VectorStore`) are vendor-neutral, and buffr supplies a durable `PgVectorStore` implementing the same `VectorStore` interface.

```
  Phase A (aptkit, now)          Phase B (buffr, durable)
  ─────────────────────          ────────────────────────
  InMemoryVectorStore            PgVectorStore (pgvector)
  cosine scan over array         indexed ANN in Postgres
  re-index per process           persistent corpus
       │                              │
       └──── SAME VectorStore contract; agent code unchanged ────┘
```

The agent doesn't change at all — it speaks the contract, not the store. That's the payoff of retrieval-neutral design: the agentic-RAG loop is identical whether the store is an in-memory array or pgvector.

### Move 3 — the principle

The tradeoff is steep — agentic RAG costs roughly 3-10x tokens and 2-5x latency over static RAG, because it's a loop with multiple model calls and possibly multiple searches. The above-threshold rule applies hard: use the loop only when one-shot retrieval measurably fails on multi-step or cross-source queries. aptkit bounds the cost with `maxToolCalls: 4` and the forced synthesis turn, so the loop can't run away — but the principle stands: don't make RAG agentic unless static RAG is measurably failing.

## Primary diagram

```
  Agentic RAG in aptkit — rag-query, full frame

  ┌─ Agent (3 packages composed) ───────────────────────────┐
  │  A model · B tools(1-tool policy) · C injectProfile      │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ runAgentLoop (maxTurns 6, maxToolCalls 4) ─────────────┐
  │  model reasons → search_knowledge_base(query, top_k)     │ [Loop→Retrieval]
  │       ▲                          │                       │
  │       │  ranked chunks + citation│                       │
  │       └──────────────────────────┘                       │
  │  enough? → cited answer | budget out → forced synthesis  │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Retrieval pipeline ──────────────────────────────────────┐
  │  embed(query) → InMemoryVectorStore.search → top-k hits    │
  │  (contract-identical to buffr's PgVectorStore)             │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Agentic RAG emerged when teams hit static RAG's ceiling: one-shot retrieval can't handle "compare X and Y" (needs two retrievals) or "what's the latest on Z" (needs a query rewrite after seeing stale chunks). Exposing retrieval as a tool lets the model do the multi-step retrieval that the question actually needs. aptkit's version is the clean minimal form — one search tool, a tight budget, citations baked into the tool output — which is exactly what you'd build before adding self-correction or multi-source routing (the next two files).

## Interview defense

**Q: Is your RAG static or agentic?**
Agentic. Retrieval is a tool — `search_knowledge_base` — not a prompt-splice. The model decides *when* to call it and how to phrase the query; the loop owns the budget at `maxToolCalls: 4`. The rag-query agent is three packages composed: a model, a one-tool policy, and a profile injection — run through the shared loop.

```
  model owns WHEN to search ═══ loop owns HOW MANY (maxToolCalls 4)
```
*Anchor: the control flip — when-to-retrieve moves from code to model. That's what makes it agentic.*

**Q: Why not just stuff the top-k into the prompt (static RAG)?**
Static RAG can't do multi-step or query-rewrite-on-miss. But agentic RAG costs 3-10x tokens — so I'd only go agentic where one-shot retrieval measurably fails. I bound the cost with the tool-call cap and the forced synthesis turn, so the loop can't run away searching.

**Q: How does the model cite?**
The tool returns a `[docId] snippet` citation per hit (`toResult`, search-knowledge-base-tool.ts:108), and the system prompt requires grounding every claim in retrieved chunks. So provenance travels with the data into the model's context.

## See also

- `02-self-corrective-rag.md` — the minTopK floor + matchesFilter guard that harden this loop
- `02-agent-loop-skeleton.md` — the loop this runs in; the forced synthesis turn
- `04-agent-infrastructure/01-context-engineering.md` — injectProfile (Package C)
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the registry + policy (Package B)
- `study-ai-engineering/03-retrieval-and-rag/` — embeddings, chunking, vector store mechanics (cross-ref)
