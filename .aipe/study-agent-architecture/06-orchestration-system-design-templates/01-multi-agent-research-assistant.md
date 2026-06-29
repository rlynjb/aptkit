# Template — Multi-Agent Research Assistant

Nine-bullet system-design template. The studied codebase is aptkit; the standard-architecture bullets are generic, the last two are answered about aptkit.

- **The prompt:** "Design a system that answers a complex research question by gathering from multiple sources and synthesizing."

- **Standard architecture:** supervisor decomposes the question → parallel worker agents each retrieve from a source (agentic RAG per worker) → supervisor synthesizes with citations.

```
  question ─► supervisor (decompose)
                 │ fan-out (Promise.all + concurrency cap)
        ┌────────┼────────┐
        ▼        ▼        ▼
    worker 1  worker 2  worker 3   each: agentic RAG over one source
    (source A)(source B)(source C)
        └────────┼────────┘
                 ▼
        supervisor synthesizes → cited answer
```

- **Data model:** source registry, per-worker retrieval indices, a shared findings store keyed by sub-question, citation provenance.

- **Key components:** decomposition (supervisor), parallel retrieval (workers, fan-out), synthesis (merge agent), citation tracking. Decision per component: tools-style vs handoff-style delegation; shared state vs message passing.

- **Scale concerns:** at many sources, fan-out cost; at deep questions, iteration blowup (cap it); at high volume, the supervisor becomes the bottleneck (cheap workers, expensive supervisor only).

- **Eval framing:** trajectory eval (did each worker hit the right source?), answer groundedness (every claim cites a retrieved chunk), cost/latency per question.

- **Common failure modes:** synthesis of contradictory sources, citation hallucination, cost blowup from deep loops, lost-in-the-middle across many worker results.

- **Applies to this codebase:** **Partially.** aptkit has the *per-worker* half built and shipped — the `rag-query` agent IS an agentic-RAG worker with citations (`packages/agents/rag-query/src/rag-query-agent.ts`), and the `search_knowledge_base` tool returns `[docId] snippet` citations (`search-knowledge-base-tool.ts:108`). What's missing is the multi-agent half: there's no supervisor that decomposes a question, fans out to multiple workers, and synthesizes. aptkit has one worker, one source, no fan-out. The retrieval-routing seam ([../02-agentic-retrieval/03-retrieval-routing.md](../02-agentic-retrieval/03-retrieval-routing.md)) is the per-source-worker precondition, half-built (one source behind a swappable contract).

- **How to make it apply:** Add a supervisor agent (a new `runAgentLoop` whose tools wrap worker `rag-query` instances, tools-style — see [../03-multi-agent-orchestration/02-supervisor-worker.md](../03-multi-agent-orchestration/02-supervisor-worker.md)). Give each worker its own dimension-matched `RetrievalPipeline` over a different source (`createRetrievalPipeline`, `packages/retrieval/src/pipeline.ts`). Add a concurrency cap for the fan-out ([../05-production-serving/02-fan-out-backpressure.md](../05-production-serving/02-fan-out-backpressure.md)). Validate each worker's findings before synthesis (the `validate.ts` precedent). The contracts (`VectorStore`, `ModelProvider`, `ToolPolicy`) already support every piece; the work is the supervisor and the fan-out, both `not yet exercised`.
