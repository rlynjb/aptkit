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
  │  rubric-improvement   — each = prompt + tool policy + loop     │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  runAgentLoop() / generateStructured()
  ┌─ Runtime (packages/runtime) ───▼──────────────────────────────┐
  │  ★ run-agent-loop · structured-generation · json-output ·     │
  │    usage-ledger · model-provider (the CONTRACT) · events ·    │
  │    ndjson-stream                                              │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  ModelProvider.complete(request)
  ┌─ Providers (packages/providers/*) ─▼──────────────────────────┐
  │  anthropic · openai · fallback (chain) · local (ctx guard)    │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  vendor SDK calls (awaited whole)
  ┌─ External LLM APIs ────────────▼──────────────────────────────┐
  │  Anthropic Messages API · OpenAI Chat Completions API         │
  └────────────────────────────────────────────────────────────────┘

  ┌─ Evals (packages/evals) ──── cuts across all layers ──────────┐
  │  assertions · structural-diff · detection-scorer ·            │
  │  rubric-judge · replay-runner                                 │
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
before tokens are spent. Read `01-llm-foundations/08-provider-abstraction.md`
and `06-production-serving/`.

## Honest scope

AptKit is an LLM-application toolkit. It does **not** ship: a vector store, an
embedding pipeline, RAG, token streaming from the provider, response caching, or
any trained ML model. Those are taught as foundations in sections 03 and 08,
each with a Project Exercises block naming the concrete build that would land it
in this repo. The reader has shipped RAG separately (AdvntrCue, pgvector +
GPT-4) — that's the right mental anchor, but the code here is the thing we cite.
