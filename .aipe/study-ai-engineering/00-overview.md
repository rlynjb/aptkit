# AI Engineering — aptkit, in one map

This guide studies one codebase: **aptkit** (`/Users/rein/Public/aptkit`),
a TypeScript monorepo that packages reusable AI-agent capabilities as
`@rlynjb/aptkit-core`, plus its companion runtime **buffr**
(`/Users/rein/Public/buffr`) — the laptop body that supplies the durable
vector store (`PgVectorStore`).

Everything below is grounded in real files. Where aptkit doesn't do
something, this guide says `not yet exercised` instead of inventing it.

## The shape of this codebase

Of the three AI-work shapes the spec recognizes — LLM application
engineering (loopd-shaped), prompt engineering as meta-tooling
(aipe-shaped), classical supervised ML (contrl-mo-shaped) — aptkit is
overwhelmingly **LLM application engineering**. It builds the substrate
under an agent product: a provider-neutral model interface, a from-scratch
RAG pipeline, a bounded agent loop, episodic memory over the retrieval
contracts, and a distinctive eval/replay harness. The classical-ML
section (08, 09) is almost entirely new ground; the one genuine bridge is
the ranked-retrieval scorer (`scorePrecisionAtK`, `packages/evals/src/precision-at-k.ts`).

```
  aptkit on the three-shapes map

  ┌─ LLM application engineering (loopd-shaped) ──── PRIMARY ─┐
  │  provider-neutral ModelProvider.complete()               │
  │  from-scratch RAG (EmbeddingProvider + VectorStore)      │
  │  bounded agent loop (runAgentLoop, maxTurns)             │
  │  episodic memory over the retrieval contracts           │
  │  precision@k / rubric-judge / replay eval harness        │
  └──────────────────────────────────────────────────────────┘
  ┌─ prompt engineering meta-tooling (aipe-shaped) ── adjacent ┐
  │  PromptPackage + renderPromptTemplate + injectProfile      │
  │  (see the sibling guide study-prompt-engineering)          │
  └────────────────────────────────────────────────────────────┘
  ┌─ classical supervised ML (contrl-mo-shaped) ─ NOT EXERCISED ┐
  │  one bridge only: precision@k / recall@k scorer            │
  │  no training, no feature engineering, no on-device model   │
  └──────────────────────────────────────────────────────────────┘
```

## The whole system in one diagram

This is the picture to hold. Every concept file zooms into one box.

```
  aptkit — the layers, end to end

  ┌─ App layer (apps/studio, host apps, buffr CLI) ──────────────┐
  │  React/Vite Studio · buffr laptop runtime · your own host    │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ calls capabilities
  ┌─ Capability layer (packages/agents/*) ───▼───────────────────┐
  │  rag-query · recommendation · anomaly-monitoring ·           │
  │  diagnostic-investigation · query · rubric-improvement       │
  │  (each = prompt package + tool policy + loop config + validator)
  └───────────────────────────────┬───────────────────────────────┘
                                   │ runAgentLoop()
  ┌─ Runtime layer (packages/runtime) ───────▼───────────────────┐
  │  bounded agent loop · ModelProvider contract · JSON extract  │
  │  · structured-generation retry · usage/cost ledger · NDJSON  │
  └──────────┬────────────────────────────────────┬──────────────┘
             │ ModelProvider.complete()            │ tools / retrieval
  ┌─ Provider layer (packages/providers/*) ▼──┐  ┌─▼ Retrieval layer ──┐
  │  anthropic (claude-sonnet-4-6) · openai   │  │ (packages/retrieval)│
  │  (gpt-4.1) · gemma (Ollama, emulated tool │  │ EmbeddingProvider + │
  │  calling) · fallback chain · context guard│  │ VectorStore contracts│
  └────────────────────────────────────────────┘  │ pipeline · chunker  │
                                                   │ search_knowledge_base│
  ┌─ Storage layer ─────────────────────────────┐  │ + memory (episodic) │
  │  InMemoryVectorStore (cosine, aptkit)        │◄─┴─────────────────────┘
  │  PgVectorStore (pgvector + HNSW, buffr)      │
  └───────────────────────────────────────────────┘
```

## Reading order

The sub-sections follow the phases of building an LLM system: foundations
first, then context, retrieval, agents, evals, serving, and finally the
interview-reframe templates and the (mostly aspirational) ML track.

1. `01-llm-foundations/` — what the model is, how aptkit talks to it,
   the provider abstraction, the cost ledger, the heuristic-before-LLM
   coverage gate, the user-override lock idea.
2. `02-context-and-prompts/` — the context window guard, lost-in-the-middle,
   prompt chaining across capabilities.
3. `03-retrieval-and-rag/` — the from-scratch RAG pipeline, the contracts,
   embeddings, chunking, the in-memory and pgvector stores, the signature
   hallucinated-filter bug and its fix, and what RAG is here.
4. `04-agents-and-tool-use/` — agents vs chains, emulated tool calling,
   the ReAct-style loop, tool routing/policy, episodic agent memory,
   error recovery in the bounded loop.
5. `05-evals-and-observability/` — eval set types, the eval-method ladder,
   LLM-as-judge bias (Claude judging Gemma), trace/replay observability.
6. `06-production-serving/` — caching, cost optimization, prompt injection,
   rate limiting/backpressure, retry/circuit breaker (most `not yet exercised`).
7. `07-system-design-templates/` — search ranking, tech-support chatbot,
   reframed as interview prompts this codebase exemplifies (or could).
8. `08-machine-learning/` — classical ML as new ground; one bridge
   (precision@k), the rest curriculum-only.
9. `09-ml-system-design-templates/` — recommender, anomaly detection,
   object detection, reframed for interviews.

Then the two root files:

- `ai-features-in-this-codebase.md` — the actual AI features aptkit ships.
- `ml-features-in-this-codebase.md` — the honest ML answer (one bridge,
  no trained models).

## Cross-links to sibling guides

- **study-prompt-engineering** — the prompt-as-code layer (PromptPackage,
  renderPromptTemplate, injectProfile) and prompt-injection defenses are
  taught in depth there.
- **study-agent-architecture** — the agent loop, multi-agent orchestration,
  agentic retrieval reasoning patterns.
- **study-dsa-foundations** — cosine similarity, ranked retrieval, the
  heap/sort math under precision@k.
- **study-database-systems** — pgvector storage layout, HNSW indexing,
  the durable store beneath buffr.
- **study-testing** — the replay/fixture golden-master harness, the
  eval seam, deterministic provider fixtures.

> Note on curriculum IDs: no `aieng-curriculum.md` / `curriculum.md` is
> present in `.aipe/project/`. Project-exercise blocks therefore name the
> curriculum *phase* (from this spec) but do not cite invented `Bx.y`
> Build-item IDs. Files to touch are always real aptkit/buffr paths.
