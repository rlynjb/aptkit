# AI Engineering — aptkit, in one picture

aptkit is an **LLM application engineering** codebase. Not classical ML, not
prompt meta-tooling — a TypeScript monorepo that packages the reusable parts of
an agent system behind swappable contracts, with a local-first default (Gemma
on Ollama, zero cloud) and an eval/replay backbone that is the strongest single
thing in the repo.

Here is the whole AI system in one frame. Every concept file in this guide
zooms into one box.

```
  aptkit AI system — the whole thing, top to bottom

  ┌─ Capability layer (the agents) ───────────────────────────────────┐
  │  rag-query · query · recommendation · anomaly-monitoring ·         │
  │  diagnostic-investigation · rubric-improvement                     │
  │  each = prompt package + tool policy + agent-loop config + parser  │
  └───────────────────────────┬───────────────────────────────────────┘
                              │ runAgentLoop (bounded turns, forced synthesis)
  ┌─ Runtime layer (provider-neutral core) ─▼─────────────────────────┐
  │  ModelProvider.complete()  ·  ToolRegistry  ·  CapabilityEvent     │
  │  parseAgentJson  ·  generateStructured  ·  usage ledger            │
  └───────────────┬───────────────────────────────┬───────────────────┘
                  │ tools                          │ model
  ┌─ Retrieval ───▼──────────────┐   ┌─ Providers ─▼────────────────────┐
  │ EmbeddingProvider+VectorStore│   │ gemma (local, emulated tools)     │
  │ chunk→embed→upsert / search  │   │ anthropic · openai · fallback ·   │
  │ search_knowledge_base tool   │   │ context-window guard              │
  │ + episodic memory (reuses    │   └───────────────────────────────────┘
  │   the same two contracts)    │
  └──────────────┬───────────────┘
                 │ implements VectorStore
  ┌─ Storage (in aptkit: in-memory · in buffr: Postgres) ─▼───────────┐
  │ InMemoryVectorStore (cosine scan)   │  buffr PgVectorStore         │
  │                                     │  (pgvector + HNSW, agents.*)  │
  └──────────────────────────────────────────────────────────────────┘
  ┌─ Eval / observability backbone (cuts across all of it) ───────────┐
  │ precision@k · rubric-judge (Claude judges Gemma) · structural-diff │
  │ detection-scorer · replay-runner · promoted-fixture golden master  │
  └────────────────────────────────────────────────────────────────────┘
```

## The shape of this codebase

Of the three AI shapes the spec recognizes — LLM application engineering,
prompt meta-tooling, classical ML — aptkit is squarely the first. It builds a
bounded agent loop, provider adapters, a from-scratch RAG pipeline, episodic
memory over the same retrieval contracts, and an eval harness. There is **no
training pipeline, no feature engineering, no on-device classifier**. Section 08
(Machine Learning) is therefore taught as new ground, not as a tour of code that
exists — and the ML system-design templates in Section 09 are honest about that.

## What's distinctive here (read these first)

1. **The retrieval-quality bug + fix + regression test.** A weak local model
   passing a hallucinated `filter` argument used to wipe every search result.
   The fix (`matchesFilter` in `search-knowledge-base-tool.ts:101`) ignores
   filter keys absent from a chunk's metadata. See `03-retrieval-and-rag/04` and
   `03/11`.

2. **Emulated tool-calling for a model with none.** Gemma has no native tool
   API, so the provider renders tools into the system prompt and parses a JSON
   tool call back out, with a bounded retry nudge and a graceful text fallback
   (`gemma-provider.ts`). See `04-agents-and-tool-use/02`.

3. **One contract, two consumers.** `EmbeddingProvider` + `VectorStore` power
   both RAG and episodic memory with zero new infrastructure — the strongest
   evidence the boundary was drawn in the right place. See `04/05` and `03/11`.

## How to read this guide

Start with `01-llm-foundations` (foundations move fast — you already have the
shapes from AdvntrCue). Then `03-retrieval-and-rag` and `04-agents-and-tool-use`
are the heart of this repo. `05-evals-and-observability` is the part most
candidates can't defend — spend time there. `06-production-serving` and the
templates in `07`/`09` are interview-reframe layers. `08-machine-learning` is
study-only ground.

See `README.md` for the file-by-file index and reading order.
