# Multi-Agent Research Assistant

A system-design interview template. Nine bullets; the generic architecture is the model answer's shape, the last two bullets are about aptkit.

- **The prompt:** "Design a system that answers a complex research question by gathering from multiple sources and synthesizing."

- **Standard architecture:** supervisor decomposes the question → parallel worker agents each retrieve from a source (agentic RAG per worker) → supervisor synthesizes with citations.

```
  Fan-out + synthesis

  question → supervisor (decompose)
                 ┌────────┼────────┐
                 ▼        ▼        ▼
            worker(src1) worker(src2) worker(src3)   each = agentic RAG
                 └────────┼────────┘
                          ▼
              supervisor synthesizes → cited answer
```

- **Data model:** source registry, per-worker retrieval indices, a shared findings store keyed by sub-question, citation provenance.

- **Key components:** decomposition (supervisor), parallel retrieval (workers, fan-out), synthesis (merge agent), citation tracking. Decision per component: tools-style vs handoff-style delegation; shared state vs message passing.

- **Scale concerns:** at many sources, fan-out cost; at deep questions, iteration blowup (cap it); at high volume, the supervisor becomes the bottleneck (cheap workers, expensive supervisor only).

- **Eval framing:** trajectory eval (did each worker hit the right source?), answer groundedness (every claim cites a retrieved chunk), cost/latency per question.

- **Common failure modes:** synthesis of contradictory sources, citation hallucination, cost blowup from deep loops, lost-in-the-middle across many worker results.

- **Applies to this codebase: partially.** aptkit has the *worker* fully built — the rag-query agent is exactly "an agentic-RAG worker that retrieves and cites" (`packages/agents/rag-query/`, with `search_knowledge_base` and precision@k eval). It has the *routing primitive* (`classifyIntent`) that a supervisor's decomposition step would use. And it has citation provenance baked into the tool output (`search-knowledge-base-tool.ts:108`). What's missing is the multi-agent layer: no supervisor decomposes one question into sub-questions, no fan-out runs workers concurrently, no merge agent synthesizes. aptkit is a *single* research worker, not a multi-agent assembly of them.

- **How to make it apply:** Three additions in aptkit's files. (1) A supervisor agent that decomposes the question — reuse `classifyIntent`'s one-call-classify shape (`packages/agents/query/src/intent.ts:13`) to split into sub-questions. (2) Fan out the existing `RagQueryAgent.answer()` over sub-questions with `Promise.all` plus a concurrency cap (the limiter from `05-production-serving/02-fan-out-backpressure.md`). (3) A merge agent that synthesizes the workers' cited answers — validating each against a schema before merging (reuse the validator pattern from `tryParseRecommendations`). The shared findings store is the existing `VectorStore` partitioned by sub-question (the same `kind`-tag trick the memory engine uses, `conversation-memory.ts:84`). Every piece reuses an existing aptkit primitive; the only genuinely new code is the supervisor's decompose-and-synthesize loop.

## See also

- `03-multi-agent-orchestration/02-supervisor-worker.md` · `04-parallel-fan-out.md`
- `02-agentic-retrieval/01-agentic-rag.md` — the worker that's already built
- `04-agent-infrastructure/04-agent-evaluation.md` — precision@k for the worker
