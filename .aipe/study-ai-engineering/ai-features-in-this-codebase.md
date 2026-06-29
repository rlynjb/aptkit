# How aptkit uses AI specifically

aptkit is an LLM-application-engineering codebase. Its whole reason to
exist is to package the reusable parts of an agent system — the model
interface, the retrieval pipeline, the agent loop, the eval harness — so
they ship as one npm bundle without app product logic leaking in. Every
AI feature below is a *capability*: a prompt package + a tool policy + an
agent-loop config + an output validator.

## AI features table

```
  ┌───────────────────────────┬──────────────────────────┬────────────────────────────┐
  │ Feature                   │ Pattern used             │ Why this pattern           │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ RAG query agent           │ Agentic RAG (ReAct loop  │ model decides when to       │
  │ (rag-query)               │ + search_knowledge_base) │ search; grounded + cited    │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ Recommendation agent      │ Bounded agent loop over  │ propose ≤3 grounded actions │
  │                           │ analytics tools          │ from an anomaly+diagnosis   │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ Anomaly monitoring        │ Bounded loop, 10 fixed   │ scan metrics → severity-    │
  │                           │ ecommerce categories     │ sorted anomalies            │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ Diagnostic investigation  │ Hypothesis-test loop     │ test 2–3 hypotheses, return │
  │                           │                          │ best-supported diagnosis    │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ Query agent               │ Free-form Q&A over ~40   │ NL question → grounded      │
  │                           │ read-only tools          │ plain-text answer           │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ Rubric improvement        │ LLM-as-judge + next-step │ score subject, name weakest │
  │                           │ recommender              │ dimension + next drill      │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ Rubric judge (eval)       │ LLM-as-judge (Claude     │ scalable rubric scoring,    │
  │                           │ judges Gemma)            │ anti-circular by design     │
  ├───────────────────────────┼──────────────────────────┼────────────────────────────┤
  │ Episodic memory           │ RAG over conversation    │ recall past turns; reuses   │
  │                           │ turns (same contracts)   │ the retrieval pipeline      │
  └───────────────────────────┴──────────────────────────┴────────────────────────────┘
```

## Per-feature specs

### RAG query agent — the capstone

- **Inputs:** `question: string` (+ optional profile text injected into the
  system prompt).
- **Outputs:** plain-text answer, citing retrieved chunks; falls back to a
  fixed answer string if the loop produces nothing.
- **Model and provider:** any `ModelProvider` (the agent is provider-neutral);
  the headline pairing is Gemma via Ollama with emulated tool calling.
- **Token cost per call:** not metered for Gemma (local, no price);
  metered for OpenAI via `usage-ledger.ts` (gpt-4.1 tiers only).
- **Failure modes observed:** weak model passing `top_k: 1` on multi-part
  questions (mitigated by the `minTopK` floor); hallucinated retrieval
  filters wiping all results (mitigated by hallucination-tolerant
  `matchesFilter`); runaway tool calls (bounded by `maxTurns: 6`,
  `maxToolCalls: 4`).
- **Eval set:** Studio's deterministic in-browser replay
  (`apps/studio/src/agent-runners.ts`, `runRagQueryFixtureReplay`) scores
  retrieval with `scorePrecisionAtK` / `scoreRecallAtK`.
- **File:** `packages/agents/rag-query/src/rag-query-agent.ts`.

### The five analytics agents

All five share the capability shape (`*_CAPABILITY_ID`, a read-only
`toolPolicy` allowlist, a bounded `runAgentLoop`, a structured-output
validator). They differ in tools and bounds:

- **recommendation** — `maxTurns: 6`, `maxToolCalls: 4`, 13-tool allowlist.
  `packages/agents/recommendation/src/recommendation-agent.ts`.
- **anomaly-monitoring** — `maxTurns: 8`, `maxToolCalls: 6`, 4-tool
  allowlist, 10 fixed anomaly categories
  (`packages/agents/anomaly-monitoring/src/categories.ts`).
- **diagnostic-investigation** — `maxTurns: 8`, `maxToolCalls: 6`, 11 tools.
- **query** — `maxTurns: 8`, `maxToolCalls: 6`, ~40 read-only tools.
- **rubric-improvement** — `maxTurns: 6`, `maxToolCalls: 3`, 6 tools.

### Episodic memory

- **Inputs:** `remember(turn)` where turn = `{conversationId, question, answer}`;
  `recall(query, k)`.
- **Outputs:** `MemoryHit[]` — past exchanges ranked by similarity to the query.
- **Model/store:** the same `EmbeddingProvider` + `VectorStore` contracts as
  RAG. No new infrastructure — the strongest evidence the contracts were
  the right boundary.
- **Wiring status:** no aptkit agent wires memory yet; buffr's session
  runtime does. `packages/memory/src/conversation-memory.ts`.

## What aptkit deliberately does NOT do

- No token-by-token LLM streaming (NDJSON streams trace *events*, not tokens).
- No reranking, hybrid/sparse (BM25) retrieval, query rewriting/HyDE, or GraphRAG.
- No semantic/prompt caching, no provider rate limiting, circuit breaker, or backoff.
- No fine-tuning or model training.

These are real gaps, marked `not yet exercised` in the relevant concept
files and turned into buildable exercises.
