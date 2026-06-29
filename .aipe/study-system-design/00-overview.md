# 00 — System Overview

One page. The whole of aptkit in one diagram, plus the seam that connects it to
buffr. Read this and you can place every pattern file that follows.

## What aptkit *is*, in one sentence

aptkit is a provider-neutral agent toolkit: a stack of swappable contracts
(`ModelProvider`, `EmbeddingProvider`, `VectorStore`, `CapabilityTraceSink`) with
a default local implementation of each, packaged as one npm bundle so a host app
can `npm install` it and fill the slots. It runs end-to-end with zero cloud. The
durable deployment lives in a separate repo, **buffr**, which fills the slots with
Postgres.

## The full-system map

The whole system, top to bottom, with the library/deployment boundary drawn as a
hard horizontal line. Above the line ships to npm; below it is one consumer.

```
  aptkit — the full system, and the seam to buffr

  ┌─ UI layer (apps/studio, React 18 + Vite) ───────────────────────────────┐
  │  AgentReplayShell (5 analytics agents)  +  RagQueryWorkspace             │
  │  + CapabilitiesWorkspace + DocPage                                       │
  │  Vite middleware: 5 replay routes, streams CapabilityEvent as NDJSON     │
  └───────────────────────────────┬──────────────────────────────────────────┘
                                  │  in-process call + application/x-ndjson
  ┌─ agents layer (packages/agents/*) ─────────────────────────────────────┐
  │  recommendation · anomaly-monitoring · diagnostic-investigation ·        │
  │  query · rubric-improvement · rag-query                                  │
  │  each = prompt package + tool policy + loop config + validator           │
  └───────────────────────────────┬──────────────────────────────────────────┘
                                  │  runAgentLoop({ model, tools, trace, ... })
  ┌─ runtime layer (packages/runtime) ─────────────────────────────────────┐
  │  runAgentLoop (bounded)  ·  CapabilityEvent trace  ·  parseAgentJson     │
  │  ★ ModelProvider.complete() — the contract everything depends on ★       │
  └───────────────┬─────────────────────────────────┬─────────────────────────┘
                  │ ModelProvider                    │ tools.callTool
  ┌─ providers ───▼──────────────┐   ┌─ retrieval/memory ▼────────────────────┐
  │ gemma  (local Ollama,default)│   │ EmbeddingProvider + VectorStore         │
  │ local  (context-window guard)│   │ InMemoryVectorStore (cosine scan)       │
  │ fallback (sequential chain)  │   │ OllamaEmbeddingProvider (nomic, 768)    │
  │ anthropic · openai (unbundled│   │ search_knowledge_base tool              │
  │   adapters, no key in default)│   │ @aptkit/memory (remember/recall)        │
  └───────────────┬──────────────┘   └────────────────┬───────────────────────┘
                  │ HTTP :11434 (no key, no TLS)       │ VectorStore.upsert/search
                  ▼                                    │
        ┌──────────────────┐                           │
        │  Ollama (local)  │                            │
        └──────────────────┘                            │
  ═══════════════════════════════════════════════════════│════════════════════
  LIBRARY / DEPLOYMENT SEAM — above ships as @rlynjb/aptkit-core@0.4.1 to npm
  ═══════════════════════════════════════════════════════│════════════════════
  ┌─ buffr (separate repo, consumes the bundle) ──────────▼──────────────────┐
  │  PgVectorStore implements VectorStore   →  Supabase pgvector + HNSW       │
  │  SupabaseTraceSink implements CapabilityTraceSink → agents.messages       │
  │  ChatSession: warm pg pool, one conversation, memory.remember per turn    │
  │  shared `agents` schema in reindb (chunks/documents/conversations/...)    │
  └────────────────────────────────────────────────────────────────────────┘
```

## Legend — what each component is, owns, and talks to

| Component | What it is | Owns | Talks to |
| --- | --- | --- | --- |
| **Studio** (`apps/studio`) | React/Vite preview + replay UI; dev-only | Replay routes, NDJSON trace streaming, in-browser RAG demo | Agents in-process; serves over Vite middleware (`apps/studio/vite.config.ts:201`) |
| **agents** (`packages/agents/*`) | 6 capabilities, each a thin assembly | Prompt + tool policy + loop config + validator | `runAgentLoop`, a `ModelProvider`, a `ToolRegistry` |
| **runtime** (`packages/runtime`) | The contracts + the loop | `ModelProvider` type (`model-provider.ts:54`), `runAgentLoop` (`run-agent-loop.ts:76`), `CapabilityEvent` (`events.ts:1`) | Nothing internal — it is the foundation |
| **gemma provider** | Local Ollama adapter, default model | Tool-call emulation + parse-retry (`gemma-provider.ts:52`) | Ollama HTTP `:11434` |
| **local guard** | Context-window pre-check wrapper | Token estimate + loud reject (`context-window-guard.ts:57`) | Wraps any inner `ModelProvider` |
| **fallback** | Sequential provider chain | Try-in-order, record attempts (`fallback-provider.ts:47`) | A list of `ModelProvider`s |
| **retrieval** (`packages/retrieval`) | The RAG pipeline | `EmbeddingProvider`/`VectorStore` contracts (`contracts.ts:22`), `InMemoryVectorStore`, the search tool | Embedder + store, injected |
| **memory** (`packages/memory`) | Episodic memory | `remember`/`recall` over the *same* retrieval contracts | A shared or dedicated `VectorStore` |
| **core** (`packages/core`) | The published bundle | Re-export of all 16 packages (`index.ts:1`); the compatibility surface | npm; buffr imports from here |
| **buffr** | The durable deployment body | `PgVectorStore` (`pg-vector-store.ts:19`), `SupabaseTraceSink` (`supabase-trace-sink.ts:49`), the `agents` schema | Supabase Postgres; imports `@rlynjb/aptkit-core` |

## The one thing to take away

Every box above either *is* a contract or *implements* one. The architecture isn't
a stack of services — it's a stack of seams with a default implementation behind
each, and one consumer (buffr) that swaps the bottom two for Postgres without
aptkit knowing. That's the whole design. The pattern files walk each seam in turn.
