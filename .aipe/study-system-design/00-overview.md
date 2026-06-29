# 00 — The whole system in one map

Read only this file and you have the architecture. aptkit is a library of
agent capabilities that depend on two ports and never name a vendor; buffr is
the deployment that plugs real implementations into those ports. The diagram
below is the forest — every later file zooms into one tree.

```
  AptKit system map — library (aptkit) + deployment (buffr), one bundle between them

  ┌─ PRESENTATION ────────────────────────────────────────────────────────────┐
  │  apps/studio  (React 18 + Vite)        buffr CLI  (React + Ink, TUI)        │
  │  preview + replay UI, 5 NDJSON         one conversation, held in-process    │
  │  replay routes via Vite middleware     buffr/src/cli/chat.tsx               │
  └───────────┬──────────────────────────────────────┬─────────────────────────┘
              │ HTTP / NDJSON                          │ in-process call
  ┌─ CAPABILITY (agents) ──────────────────────────────▼─────────────────────────┐
  │  6 agents, each = prompt package + tool policy + loop config + validator      │
  │  recommendation · anomaly-monitoring · diagnostic-investigation               │
  │  query · rubric-improvement · rag-query        packages/agents/*              │
  └───────────┬───────────────────────────────────────────────────────────────────┘
              │ runAgentLoop(...)  — bounded turns + tool-call budget + forced synthesis
  ┌─ RUNTIME ─▼───────────────────────────────────────────────────────────────────┐
  │  runAgentLoop   CapabilityEvent trace   parseAgentJson   usage-ledger           │
  │  packages/runtime/src/run-agent-loop.ts        events.ts                        │
  └──────┬──────────────────────────────────┬──────────────────────────────────────┘
         │ ModelProvider.complete()          │ tool calls (ToolExecutor)
  ┌─ MODEL PORT ─▼──────────────┐   ┌─ RETRIEVAL PORTS ─▼─────────────────────────────┐
  │  ModelProvider (the port)   │   │  EmbeddingProvider + VectorStore (the two ports) │
  │  packages/runtime/          │   │  packages/retrieval/src/contracts.ts             │
  │   model-provider.ts         │   │                                                  │
  │  adapters:                  │   │  reached via search_knowledge_base tool          │
  │   gemma (local default)     │   │  adapters:                                       │
  │   local (ctx-window guard)  │   │   OllamaEmbeddingProvider (nomic, 768-dim)       │
  │   fallback (chain)          │   │   InMemoryVectorStore (cosine scan) ── aptkit     │
  │   anthropic · openai        │   │   PgVectorStore (pgvector + HNSW) ──── buffr      │
  └──────┬──────────────────────┘   └──────────────────┬───────────────────────────────┘
         │ HTTP :11434 (no key/TLS) / SDK              │ memory reuses these same ports
         ▼                                             ▼  (@aptkit/memory: remember/recall)
  ┌─ EXTERNAL ──────────────────┐   ┌─ DURABLE STORE (buffr only) ────────────────────┐
  │  Ollama (local)             │   │  Supabase Postgres, schema `agents`             │
  │  Anthropic / OpenAI (cloud) │   │  documents·chunks·conversations·messages        │
  │                             │   │  SupabaseTraceSink persists CapabilityEvent     │
  └─────────────────────────────┘   └─────────────────────────────────────────────────┘

  ════════ deployment boundary ════════
  everything above the EXTERNAL/DURABLE band ships as ONE npm tarball:
  @rlynjb/aptkit-core@0.4.1  (bundledDependencies inlines 16 @aptkit/* packages)
  buffr installs that tarball and supplies PgVectorStore + SupabaseTraceSink + agents schema
```

## Legend — what each component is, owns, and talks to

- **Studio** (`apps/studio`) — React/Vite preview + replay UI. Owns the
  in-browser developer view. Talks to the agents through a Vite dev-server
  middleware that exposes 5 replay routes and streams `CapabilityEvent`s as
  NDJSON (`apps/studio/vite.config.ts`). No production server — it's a dev
  tool and a static GitHub Pages demo.
- **buffr CLI** (`buffr/src/cli/chat.tsx`) — a TUI that holds one
  conversation in-process. Owns the laptop runtime. Talks to a single
  `RagQueryAgent` and a single warm `pg.Pool` across turns.
- **Agents** (`packages/agents/*`) — six capabilities. Each owns one
  `*_CAPABILITY_ID`, one read-only tool policy (least-privilege allowlist),
  one prompt package, and one output validator. Talk to the runtime via
  `runAgentLoop`. → `01`, `02`, `03`.
- **Runtime** (`packages/runtime`) — the foundation, zero internal deps.
  Owns the agent loop, the trace event union, JSON extraction, and the usage
  ledger. Talks down to the model port and out to the trace sink. → `03`, `04`.
- **Model port** (`ModelProvider`, `packages/runtime/src/model-provider.ts`)
  — the single contract everything depends on instead of a vendor SDK. Five
  adapters implement it; the default is the local gemma adapter, so the
  default path makes no cloud call. → `01`.
- **Retrieval ports** (`EmbeddingProvider` + `VectorStore`,
  `packages/retrieval/src/contracts.ts`) — the two RAG seams. Vendor-neutral.
  In-memory + Ollama in aptkit; pgvector in buffr. Episodic memory
  (`@aptkit/memory`) is a *second* consumer of the exact same two ports. → `02`.
- **buffr durable store** — Supabase Postgres, schema `agents`, with an HNSW
  index over a `vector(768)` column. The only durable store in the system;
  aptkit itself persists nothing. → `05`, and `study-database-systems` /
  `study-data-modeling` for engine + schema internals.
- **The bundle** (`@rlynjb/aptkit-core`) — the deployment boundary made
  literal: 16 internal packages inlined into one tarball so a consumer
  installs one dependency. → `06`.

## The one thing to remember

The architecture is **two ports and a bounded loop, published as one bundle,
with the deployment in a different repo.** Control flows down (Studio/CLI →
agent → loop → port → external), data flows back up as `CapabilityEvent`s.
Every boundary in the diagram is a seam where you can swap the implementation
without touching the layer above — that swappability is the whole design.
