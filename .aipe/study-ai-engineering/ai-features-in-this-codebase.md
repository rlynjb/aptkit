# How aptkit uses AI specifically

aptkit is an LLM application toolkit, so AI is not one feature — it's the whole
product. What ships are reusable capabilities, each one an instance of the same
shape: **prompt package + tool policy + agent-loop config + result parser**.

## AI features table

```
  ┌──────────────────────────┬────────────────────────┬─────────────────────────┐
  │ Capability               │ Pattern used           │ Why this pattern        │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ rag-query agent          │ Agentic retrieval      │ model decides WHEN to   │
  │                          │ (ReAct loop, 1 tool)   │ search; grounded+cited  │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ query agent              │ Bounded agent loop     │ NL → answer over ~35    │
  │                          │ over read-only tools   │ read-only tools         │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ intent classification    │ Heuristic + LLM        │ one-word classify;      │
  │                          │ (parseIntent fallback) │ keyword shortcut first  │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ anomaly-monitoring agent │ Single structured pass │ scan metrics → ranked   │
  │                          │ (generateStructured)   │ anomalies               │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ diagnostic-investigation │ Bounded agent loop +   │ one anomaly → tested    │
  │                          │ structured output      │ Diagnosis + confidence  │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ recommendation agent     │ Agent loop, maxTurns 6 │ anomaly+diagnosis →     │
  │                          │                        │ ≤3 grounded recs        │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ rubric-improvement agent │ LLM-as-judge           │ score subject → weakest │
  │                          │ (RubricJudge)          │ dimension + next action │
  ├──────────────────────────┼────────────────────────┼─────────────────────────┤
  │ episodic memory          │ RAG index/query reused │ remember/recall over    │
  │                          │ as remember/recall     │ same contracts (no agent│
  │                          │                        │ wires it yet)           │
  └──────────────────────────┴────────────────────────┴─────────────────────────┘
```

## Per-feature spec

### rag-query agent — the capstone
- **Inputs:** a natural-language `question: string`; optional `profile` (me.md
  text) injected into the system prompt via `injectProfile`.
- **Outputs:** plain-text answer, grounded in retrieved chunks, with citations;
  falls back to "I couldn't find anything…" on empty retrieval.
- **Model and provider:** any `ModelProvider`; the intended default is a
  context-window-guarded Gemma (`gemma2:9b`, local Ollama, no cloud call).
- **Token cost per call:** local Gemma = $0 (no per-token billing). The usage
  ledger only prices `gpt-4.1-*`; Gemma usage is logged but free.
- **Failure modes observed:** weak model passing `top_k: 1` (starves multi-part
  questions → `minTopK` floor); hallucinated `filter` arg wiping results (→
  `matchesFilter` tolerance); model never calling the tool (→ system prompt
  "Always call … first"); model never stopping (→ `maxToolCalls: 4`,
  `maxTurns: 6`, forced synthesis turn).
- **Eval set:** precision@k / recall@k over a fixed corpus in the Studio RAG page
  (`apps/studio`, deterministic fake embedder + InMemoryVectorStore); replay
  artifacts in `artifacts/replays/`.
- **Files:** `packages/agents/rag-query/src/rag-query-agent.ts`.

### query agent
- **Inputs:** `question: string`, optional `intent`, a `WorkspaceDescriptor`.
- **Outputs:** plain-prose answer citing key numbers.
- **Failure modes:** agent loops on tools (→ `maxToolCalls: 6`, `maxTurns: 8`);
  never synthesizes (→ `buildSynthesisInstruction`).
- **Files:** `packages/agents/query/src/query-agent.ts`,
  `packages/agents/query/src/intent.ts`.

### rubric-improvement (LLM-as-judge)
- **Inputs:** a `subject` string + a `RubricDefinition` (dimensions, verdicts).
- **Outputs:** per-dimension scores, a verdict, one highest-leverage fix —
  validated against the rubric's own score ranges.
- **Anti-circular design:** intended to run Claude (anthropic) as the judge over
  Gemma's outputs, avoiding self-preference bias.
- **Files:** `packages/evals/src/rubric-judge.ts`,
  `packages/agents/rubric-improvement/`.

## The seam that makes it a toolkit

Every capability depends only on `ModelProvider.complete()` and the
`ToolRegistry` / `VectorStore` / `EmbeddingProvider` contracts — never a vendor
SDK directly. That's why buffr can supply a `PgVectorStore` and a durable
`agents` schema (`/Users/rein/Public/buffr/src/pg-vector-store.ts`,
`/Users/rein/Public/buffr/sql/001_agents_schema.sql`) without aptkit changing a
line. See `01-llm-foundations/08-provider-abstraction.md` and
`03-retrieval-and-rag/04-vector-databases.md`.
