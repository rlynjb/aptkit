# Overview — the whole system in one frame

One page, one diagram. Skim only this file and you have the map: every major component, what it owns, and what it talks to. The detail lives in `audit.md` and the ten pattern files; this is the orientation you return to.

AptKit is not a deployed service. It's a **library monorepo** — 16 internal packages plus a Studio dev app, published as one npm tarball (`@rlynjb/aptkit-core` 0.4.1). There's no request coming in from the internet; the "request" is a host app calling an agent's method, or you clicking "Replay" in Studio. So the system map is a *dependency-and-data-flow* map, not a traffic map.

Three things changed the shape recently and are worth flagging before the diagram: (1) the default reasoning model is now **local Gemma over Ollama** (the bundled providers are `provider-gemma` + `provider-local`; Anthropic/OpenAI adapters still exist but are out of the published build chain), (2) there's a from-scratch **retrieval (RAG)** capability — `@aptkit/retrieval` plus a capstone `@aptkit/agent-rag-query` — that adds two new provider-neutral seams the same shape as `ModelProvider` (→ `09-retrieval-pipeline-seam.md`), and (3) the newest package, `@aptkit/memory`, gives agents **episodic memory that persists across runs** by *reusing* those same two retrieval seams — a second consumer, zero new infrastructure. Memory is the first thing in the repo to make agent state survive a process; the durable store that holds it lives across the repo boundary in buffr. → see `10-memory-store-topology.md`.

## The full system

This is the whole thing — every package as a labelled band, every arrow a real dependency or data hop. Read it top to bottom: input flows down into the agent loop, out to a provider, and the trace flows back up.

```
  AptKit — full system map (dependency + data flow)

  ┌─ Entry / UI layer ───────────────────────────────────────────────────┐
  │  apps/studio (React 18 + Vite)        host app importing               │
  │   click "Replay" → fetch POST          @rlynjb/aptkit-core              │
  │        │  Vite middleware                    │  calls agent.method()    │
  │        │  5 NDJSON stream routes             │                          │
  └────────┼─────────────────────────────────────┼──────────────────────────┘
           │  body: {fixtureId, mode}             │
           ▼                                      ▼
  ┌─ Capability layer — packages/agents/* (6 agents) ─────────────────────┐
  │                                                                        │
  │   anomaly-monitoring ──► diagnostic-investigation ──► recommendation   │
  │   (scan → Anomaly[])     (Anomaly → Diagnosis)        (Anomaly+        │
  │                                                        Diagnosis →     │
  │   query (NL → answer)    rubric-improvement            Recs[])         │
  │                                                                        │
  │   rag-query (NL → grounded answer)  ── model + search tool + profile   │
  │                                                                        │
  │   each agent = prompt package + tool policy + loop config + validator  │
  └────────────────────────────────┬───────────────────────────────────────┘
                                    │  runAgentLoop(...) + filtered tools
                                    ▼
  ┌─ Runtime core — packages/runtime (no internal deps) ──────────────────┐
  │   runAgentLoop  ───emits───►  CapabilityEvent[]  (the trace)           │
  │   bounded by maxTurns / maxToolCalls, forced synthesis turn            │
  │   structured-generation (retry+validate)   ndjson-stream (encode)      │
  │        │  every model call goes through ONE contract                   │
  │        ▼                                                               │
  │   ModelProvider.complete(request) ◄── the central seam ──┐            │
  └──────────────────────────────────────────────────────────┼────────────┘
                                                              │
  ┌─ Policy + context layer ───────────┐   ┌─ Provider layer — packages/providers/* ─┐
  │  packages/tools                    │   │  gemma (Ollama /api/chat)  ◄ bundled     │
  │   ToolRegistry (Map by name)       │   │      ▲                                   │
  │   ToolPolicy (Set allowlist)       │   │      └── FallbackModelProvider (chain)   │
  │   coverage-gate (Set tokens)       │   │  ContextWindowGuardedProvider (pre-flight│
  │  packages/context (WorkspaceDescr  │   │            token budget guard, ~8k)      │
  │    + injectProfile)                │   │  (anthropic/openai adapters: out of      │
  │  packages/prompts (templates)      │   │            the published bundle)         │
  └────────────────────────────────────┘   └──────────────────┬───────────────────────┘
                                                               │  HTTP (only wire hop)
                                                               ▼
                                                    ┌─ External ──────────┐
                                                    │ Ollama @ localhost  │
                                                    │ gemma2:9b (reason)  │
                                                    │ nomic-embed (768d)  │
                                                    └─────────────────────┘

  ┌─ Retrieval (RAG) — packages/retrieval ────────────────────────────────────────────┐
  │  search_knowledge_base tool ──► RetrievalPipeline                                  │
  │    index: doc→chunk→embed→upsert    query: q→embed→search→rank                     │
  │    EmbeddingProvider seam (Ollama/nomic) │ VectorStore seam (InMemory cosine)      │
  │    dimension checked at wiring + per-vector (the one-way door)                     │
  └────────────────────────────────────────┬──────────────────────────────────────────┘
                  reuses the SAME two seams │ (second consumer, no new infra)
  ┌─ Memory (episodic) — packages/memory ───▼──────────────────────────────────────────┐
  │  createConversationMemory({embedder, store}) → {remember, recall}                  │
  │    remember: turn→embed→upsert(kind=memory)   recall: q→embed→search(k×4)→filter   │
  │    store INJECTED → caller picks topology:                                          │
  │      SHARED (mixes into docs, surfaces via search_knowledge_base)                   │
  │      DEDICATED (isolated, recalled via createMemoryTool's search_memory)            │
  │    state PERSISTS ACROSS RUNS when store is durable (PgVectorStore lives in buffr)  │
  └───────────────────────────────────────────────────────────────────────────────────┘

  ┌─ Testing / observability backbone — packages/evals + scripts + artifacts ─────────┐
  │  live run → artifact (artifacts/replays/*.json) → eval (structural-diff /          │
  │  detection-scorer / rubric-judge) → promote-to-fixture → FixtureModelProvider      │
  │  replays it deterministically (no network, no tokens spent)                        │
  └─────────────────────────────────────────────────────────────────────────────────┘

  ┌─ Publish boundary — packages/core ────────────────────────────────────────────────┐
  │  @rlynjb/aptkit-core (0.4.1): re-exports all 16 packages; bundledDependencies        │
  │  inlines them into ONE standalone tarball. App-specific product logic must not leak.│
  └─────────────────────────────────────────────────────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

| Component | What it is | What it owns | What it talks to |
| --- | --- | --- | --- |
| `apps/studio` | React + Vite dev app | The manual preview/replay UI; 5 NDJSON stream routes (`vite.config.ts`) | Imports core; POSTs to its own Vite middleware; consumes NDJSON |
| `packages/agents/*` | 6 capability agents (incl. `rag-query`) | One capability each: `*_CAPABILITY_ID`, a tool policy, a loop config, a validator | Calls `runAgentLoop`; reads tools filtered by its policy |
| `packages/agents/rag-query` | The RAG capstone | Composes a model + the `search_knowledge_base` tool + an injected profile; grants exactly one tool | Calls `runAgentLoop`; imports `@aptkit/retrieval`, `@aptkit/provider-gemma` |
| `packages/retrieval` | From-scratch RAG | `EmbeddingProvider` + `VectorStore` contracts, `RetrievalPipeline`, `chunkText`, `InMemoryVectorStore`, `OllamaEmbeddingProvider`, `search_knowledge_base` tool | Imports tool contract from `@aptkit/tools`; talks to Ollama over HTTP |
| `packages/memory` | Episodic conversation memory | `createConversationMemory` (`remember`/`recall`), `createMemoryTool` (`search_memory`), the `kind` tag + over-fetch-and-filter recall | Imports `EmbeddingProvider`/`VectorStore` from `@aptkit/retrieval` and the tool contract from `@aptkit/tools` — nothing else. Store injected by the caller |
| `packages/runtime` | Foundation, zero internal deps | The `ModelProvider` contract, `runAgentLoop`, `CapabilityEvent`, structured-generation, NDJSON helpers | Nothing internal depends downward; everything depends *on* it |
| `packages/tools` | Registry + policy + gate | `ToolRegistry` (Map by name), `ToolPolicy` (Set allowlist), `coverage-gate` (Set tokens) | Imports `ModelTool` from runtime; consumed by agents |
| `packages/context` | Pure types + renderer | `WorkspaceDescriptor`, `schemaSummary()` | No internal deps; consumed by agents/prompts |
| `packages/prompts` | Prompt packages | Per-agent templates with id/version/capabilityId provenance | Consumed by agents |
| `packages/providers/*` | `ModelProvider` adapters | `GemmaModelProvider` (Ollama, bundled default); `FallbackModelProvider` chain; `ContextWindowGuardedProvider`. anthropic/openai adapters exist but are out of the published bundle | Implements the runtime contract; calls Ollama (or a vendor SDK) over HTTP |
| `packages/evals` | Eval functions | shape assertions, structural-diff, detection-scorer, rubric-judge, replay-runner | Reads replay artifacts; consumed by scripts |
| `packages/core` | The published surface | `@rlynjb/aptkit-core` re-export bundle; `bundledDependencies` | Re-exports all 16 packages; published to npm (0.4.1) |
| `scripts/*.mjs` | Pipeline CLIs | eval / promote / replay / pack-standalone | Read artifacts + fixtures; write fixtures + tarball |
| `artifacts/replays/` | Saved JSON | Replay artifacts (the observability record) | Written by replay scripts/Studio; read by evals |

## The one axis to hold in your head: **who decides control flow?**

Trace that single question down the layers and the seams pop:

```
  "who decides what happens next?" — traced down the stack

  Studio / host app        → CODE decides (calls a fixed agent method)
  multi-agent pipeline     → CODE decides (fixed order: monitor→diagnose→recommend)
  runAgentLoop             → LLM decides (per turn: emit tool calls or finish)
  ...but bounded by        → CODE decides (maxTurns/maxToolCalls hard ceiling)
  ModelProvider.complete   → PROVIDER decides (gemma/local, fallback, guard)
  Ollama / vendor          → EXTERNAL decides (the model itself)
```

The answer flips four times. Each flip is a seam worth studying — and each is a pattern file. The most important flip is at `runAgentLoop`: control hands from code to the LLM, then code claws it back with a hard iteration budget. That tension is the heart of the repo.
