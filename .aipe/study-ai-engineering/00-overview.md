# Overview — AptKit as an AI-engineering system

One page. The whole repo as a map, the one axis that makes it legible, and the
three things worth your attention before you open any concept file.

## Zoom out — the whole system in one diagram

AptKit packages the reusable parts of an LLM-agent system into one monorepo. The
load-bearing idea: **everything routes through a single `ModelProvider.complete()`
contract, and nothing in the core ever touches a vendor SDK directly.** That one
seam is what lets you swap Anthropic for OpenAI, drop in a deterministic fixture
for tests, or wrap a provider in a fallback chain — without changing a single
agent.

```
  AptKit — layers, top to bottom

  ┌─ Studio (apps/studio) ──────────────────────────────────────┐
  │  React/Vite preview + replay UI. Reads NDJSON trace stream.  │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  NDJSON CapabilityEvent stream
  ┌─ Agents (packages/agents/*) ───▼──────────────────────────────┐
  │  query · anomaly-monitoring · diagnostic · recommendation ·    │
  │  rubric-improvement · ★ rag-query (retrieve→ground→cite)       │
  │  — each = prompt + tool policy + loop                          │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  runAgentLoop() / generateStructured()
  ┌─ Runtime (packages/runtime) ───▼──────────────────────────────┐
  │  ★ run-agent-loop · structured-generation · json-output ·     │
  │    usage-ledger · model-provider (the CONTRACT) · events ·    │
  │    ndjson-stream                                              │
  └──────────┬─────────────────────────────────┬─────────────────┘
             │ ModelProvider.complete()         │ search_knowledge_base tool
  ┌─ Providers (packages/providers/*) ─▼──────┐  │
  │  anthropic · openai · fallback (chain) ·  │  │
  │  local (ctx guard) · ★ gemma (local,      │  │
  │  Ollama, emulated tool-calling)           │  │
  └──────────┬────────────────────────────────┘  │
             │ vendor SDK / Ollama HTTP           │
  ┌─ External LLM APIs ─▼─────────────────────┐   │
  │  Anthropic · OpenAI · Ollama (gemma2:9b)  │   │
  └───────────────────────────────────────────┘   │
  ┌─ Retrieval (packages/retrieval) ★ NEW ◄───────┘──────────────┐
  │  OllamaEmbeddingProvider (nomic, 768) · InMemoryVectorStore  │
  │  (cosine) · pipeline (doc→chunk→embed→upsert; q→search→rank) │
  └────────────────────────────────────────────────────────────────┘

  ┌─ Evals (packages/evals) ──── cuts across all layers ──────────┐
  │  assertions · structural-diff · detection-scorer ·            │
  │  rubric-judge · replay-runner · ★ precision-at-k (ranked-     │
  │  retrieval RULER)                                             │
  │  live run → artifact → eval → promote-to-fixture → replay     │
  └────────────────────────────────────────────────────────────────┘
```

## The one axis: who decides control flow?

Trace a single question down the stack — *who decides what happens next?* — and
the whole architecture's seams light up.

```
  "who decides control flow?" — held constant down the layers

  ┌──────────────────────────────────────┐
  │ Agent (e.g. recommendation-agent)    │  → CODE decides the budget
  │   maxTurns=6, maxToolCalls=4         │    (the guardrails)
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ runAgentLoop (per turn)          │  → LLM decides each step
      │   call model → run tools → loop  │    (which tool, when to stop)
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ forced synthesis turn        │  → CODE decides again
          │   (last turn / budget spent) │    (yank the tools away)
          └──────────────────────────────┘
              ┌──────────────────────────┐
              │ tool call                │  → TOOL runs, returns result
              └──────────────────────────┘

  control flips at each altitude. That flip — CODE → LLM → CODE — is the
  whole design. The agent loop is freedom inside a fence the code controls.
```

## The three things worth your attention

**1. The bounded agent loop (`packages/runtime/src/run-agent-loop.ts`).** This
is the core AI-engineering primitive in the repo. It's the ReAct loop with three
guardrails most candidates' loops are missing: a hard turn budget, a hard
tool-call budget, and — the part people forget — a **forced synthesis turn** that
strips the tools away on the last turn so the model is compelled to answer
instead of querying forever. Plus a fallback recovery turn if the final output
won't parse. Read `04-agents-and-tool-use/`.

**2. The eval layer (`packages/evals/`).** This is the standout. Most candidates
can talk about "LLM-as-judge" abstractly; AptKit *ships* one (`rubric-judge.ts`)
with the bias defenses baked into the rubric contract. It also ships
detection scoring (precision/recall-style scoring of structured detections),
structural diff (rule-based assertions over JSON), and a replay harness that
turns a live run into a deterministic test fixture. Read
`05-evals-and-observability/`.

**3. The provider abstraction + fallback chain (`packages/providers/`).** The
`ModelProvider` contract is two methods wide (`id`, `complete()`), and that
narrowness is the point. The fallback provider tries adapters in order; the
local provider wraps any adapter in a context-window guard that refuses the call
before tokens are spent. **The newest adapter, `@aptkit/provider-gemma`, is the
sharp one**: Gemma2:9b over Ollama has *no native tool-calling*, so the adapter
renders the tools into the system prompt, demands a JSON tool call back, and
parses it into a `tool_use` block — with a parse-retry nudge. That's the same
port serving a fundamentally harder vendor. Read
`01-llm-foundations/08-provider-abstraction.md`, `10-local-vs-cloud-models.md`,
`04-agents-and-tool-use/07-emulated-tool-calling.md`, and `06-production-serving/`.

**4. The from-scratch RAG stack (`packages/retrieval/` + `packages/agents/rag-query/`).**
This landed this session and it's the new headline. `@aptkit/retrieval` ships a
real embedding provider (nomic-embed-text, 768-dim, over Ollama), an in-memory
cosine vector store, the index/query pipeline (`doc→chunk→embed→upsert`;
`query→embed→search→rank`), and a `search_knowledge_base` retrieval tool. The
capstone `@aptkit/agent-rag-query` wires a local Gemma model + that tool + a
profile injector into the bounded agent loop: retrieve → ground → cite. And
`@aptkit/evals` now scores retrieval quality with `scorePrecisionAtK` /
`scoreRecallAtK` — measure-then-decide for the retriever itself. Read
`03-retrieval-and-rag/` and `05-evals-and-observability/05-precision-at-k.md`.

## Honest scope

AptKit now **does** ship a vector RAG pipeline — embeddings, an in-memory vector
store, chunking, the index/query pipeline, a retrieval tool, and a grounded RAG
agent — all built from scratch and provider-neutral, all runnable with zero cloud
(local Gemma + local nomic over Ollama). What it deliberately **does not** ship:
the durable persistence layer (`PgVectorStore` / Supabase pgvector) and the live
precision@k-over-a-real-corpus eval run — those live in the **buffr** repo, which
assembles these packages into a running service. AptKit stays library code: the
in-memory pipeline + the scorers; buffr is the body. Still genuinely absent here:
provider-side token streaming, response caching, and any trained ML model (section
08 is foundations, each with a Project Exercises block). The reader also shipped
classic cloud RAG separately (AdvntrCue, pgvector + GPT-4) — that's the cloud
mirror of what's now in-repo as local-first.
