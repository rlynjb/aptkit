# Project Context — AptKit

AptKit is a **TypeScript monorepo** packaging reusable AI-agent capabilities extracted from working apps (notably "Blooming Insights"). It isolates the reusable parts of agent systems — a bounded agent loop, provider adapters (incl. a **local Ollama/Gemma** provider), a **from-scratch RAG/retrieval pipeline** (embeddings + vector store behind swappable contracts), an **episodic conversation-memory engine** built over those same retrieval contracts, tool registry/policy, structured-output parsing, evaluators, content workflows, prompt packages, and a Studio preview/replay UI — so they can ship as a public npm bundle (`@rlynjb/aptkit-core`) without app-specific product logic leaking into the core.

> **Companion repo:** the deployment-specific "body" lives in **buffr** (`/Users/rein/Public/buffr`, `github.com/rlynjb/buffr`) — a Supabase-backed laptop runtime that *consumes* `@rlynjb/aptkit-core` from npm and supplies the Postgres/pgvector binding (`PgVectorStore`), the `agents` schema, and persistence. aptkit stays deployment-agnostic; buffr fills the slots.

## Stack

- **Language:** TypeScript `^5.5`, ESM only (`"type": "module"`). `tsconfig.base.json`: target ES2022, module/resolution `NodeNext`, `strict: true`, `declaration: true`.
- **Workspaces:** npm workspaces — `packages/*`, `packages/agents/*`, `packages/providers/*`, `apps/*`. Internal packages versioned `0.0.0`; published bundle `@rlynjb/aptkit-core` is `0.4.1` (repo dev version; `0.4.0` last published to npm), bundling **16** internal packages.
- **Build:** per-package `tsc -b` (`npm run build --workspaces --if-present`). Core has an explicit ordered `build:core:deps` chain.
- **Tests:** Node's built-in runner (`node --test dist/test/*.test.js`) per package; Playwright smoke test for Studio (`playwright.studio.config.ts`, dev server on port 4187). No jest/vitest.
- **Model providers:** Anthropic (`@anthropic-ai/sdk ^0.60`, default `claude-sonnet-4-6`), OpenAI (`openai ^6.44`, default `gpt-4.1`), **Gemma via Ollama** (`@aptkit/provider-gemma`, local HTTP `:11434`, no key/no TLS; emulates tool-calling since Gemma has none), a sequential fallback chain, and a local context-window guard. Cloud keys via env (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — see `.env`, gitignored); the local default makes no cloud call.
- **Embeddings:** `OllamaEmbeddingProvider` (`@aptkit/retrieval`, `nomic-embed-text`, 768-dim, local) behind an `EmbeddingProvider` contract — OpenAI/Voyage are later drop-ins.
- **Frontend:** `apps/studio` — React 18 + Vite. CSS-in-file styling, `lucide-react` icons, React hooks for state. Vite middleware exposes 5 replay API routes and streams NDJSON traces.
- **Publishing:** `@rlynjb/aptkit-core` published to npm public registry; `bundledDependencies` inlines all **16** internal packages into one standalone tarball (`scripts/pack-core-standalone.mjs`). Release flow documented in `RELEASE.md` (build:core → pack:core → publish:core:npm; each new bundled package needs `"files": ["dist/src"]` or `npm pack` excludes its gitignored `dist`). CI: `.github/workflows/publish-core.yml`.

## File structure

| Path | Purpose |
| --- | --- |
| `packages/runtime` | Foundation, no internal deps. Provider contract (`ModelProvider`/`ModelRequest`/`ModelResponse`), bounded agent loop (`runAgentLoop`), trace events (`CapabilityEvent`), JSON extraction (`parseAgentJson`), structured generation w/ retry, usage/cost ledger, NDJSON stream helpers. |
| `packages/tools` | `ToolRegistry`/`InMemoryToolRegistry`, `ToolPolicy` + `filterToolsForPolicy` (least-privilege allowlists), coverage-gate (which capabilities are runnable from workspace metadata). Imports `ModelTool` from runtime. |
| `packages/context` | Pure types `WorkspaceDescriptor`/event+catalog descriptors/`DataHorizon`, deterministic `schemaSummary()` renderer, plus `injectProfile()` (pure string→string profile/`me.md` injection into a system template). No internal deps. |
| `packages/retrieval` | **RAG pipeline.** Swappable `EmbeddingProvider` + `VectorStore` contracts; `InMemoryVectorStore` (cosine scan); `OllamaEmbeddingProvider` (nomic, 768); index path (doc→chunk→embed→upsert) + query path (query→embed→search→rank); `search_knowledge_base` tool (`minTopK` floor + hallucination-tolerant filter). Dimension mismatch fails loud. |
| `packages/memory` | **Episodic conversation memory (NEW).** `createConversationMemory({embedder, store})` → `remember(turn)` / `recall(query, k?)` over the SAME `EmbeddingProvider`/`VectorStore` contracts as retrieval (zero new infra). Rows tagged `meta.kind:'memory'`, id `memory:<convId>:<n>`; `recall` over-fetches then filters by `kind` (the contract has no metadata predicate). Store INJECTED — SHARED with documents (memory surfaces via `search_knowledge_base`) or DEDICATED (`search_memory` tool from `createMemoryTool`). Durable store = buffr's `PgVectorStore`. |
| `packages/prompts` | `PromptPackage` type + `renderPromptTemplate()` (`{var}` substitution). Per-agent prompt packages (query, recommendation, monitoring, diagnostic) with id/version/capabilityId provenance. |
| `packages/evals` | Replay-artifact shape assertions, rule-based `structural-diff`, `detection-scorer`, `rubric-judge`, `replay-runner` (batch eval → `ReplayArtifactEvalSummary`), and `precision-at-k` (`scorePrecisionAtK`/`scoreRecallAtK` — ranked-retrieval scorers). |
| `packages/workflows` | Content-generation workflow (split markdown by `##`, round-robin variant angles, generate fresh/stale/generated) + markdown-section helpers. |
| `packages/agents/recommendation` | Anomaly+diagnosis → ≤3 grounded recommendations. `runAgentLoop` maxTurns 6. |
| `packages/agents/anomaly-monitoring` | Scans workspace metrics against 10 ecommerce anomaly categories → severity-sorted anomalies. |
| `packages/agents/diagnostic-investigation` | Single anomaly → hypothesis-tested `Diagnosis` with confidence inference. |
| `packages/agents/query` | NL question → plain-text answer over ~49 read-only tools; intent classification. |
| `packages/agents/rubric-improvement` | Score subject against rubric → weakest dimension + next action/drill. |
| `packages/agents/rag-query` | **Capstone RAG agent (NEW).** Composes the Gemma provider + `search_knowledge_base` tool + `injectProfile` through `runAgentLoop` — agentic retrieval (model decides when to search), grounded + cited answers. |
| `packages/providers/{anthropic,openai,fallback,local,gemma}` | `ModelProvider` adapters. `gemma` (NEW) is the local Ollama provider with emulated tool-calling + parse-retry; `local` is the context-window guard. |
| `packages/core` | `@rlynjb/aptkit-core` — pure re-export composition of all **16** packages; the published surface. |
| `apps/studio` | React/Vite manual preview + replay UI. The analytics agents use the shared `AgentReplayShell`; three **custom (off-shell) pages**: `CapabilitiesWorkspace`, a **RAG Query Agent page** (`RagQueryWorkspace` — deterministic in-browser RAG: fake embedder + `InMemoryVectorStore` + recorded responses, scored with precision@k), and **in-app doc pages** (`DocPage` — renders `docs/*.md` via react-markdown + a github-slugger TOC sidebar, imported with Vite `?raw` so they inline into the static GitHub Pages demo). |
| `scripts/*.mjs` | `eval-replay-artifacts`, `promote-replay-to-fixture`, `replay-model-recommendation`, `replay-promoted-fixtures`, `pack-core-standalone`. |
| `artifacts/replays/` | Saved replay artifacts (JSON) from Studio/live runs. |
| `docs/` | Capability inventory, architecture notes, Studio guide, publishing & migration plans, resume notes. |
| `tests/studio/` | Playwright smoke spec. |

## Data model

No SQL/relational database *in this repo* (the persistent Postgres `agents` schema — documents/chunks/conversations/messages/profiles, app_id-keyed — lives in **buffr**). aptkit's data is file-, stream-, and **vector**-shaped:

- **Vector store (`VectorChunk`/`VectorHit`)** — the in-memory RAG corpus: chunks `{ id: "<docId>#<index>", vector: number[768], meta }` upserted into `InMemoryVectorStore` (cosine over an array); search returns `{ id, score, meta }` with `meta` rebuilt to carry `docId`/`chunkIndex`/`text` for citations. Embedding dimension is a one-way door (mismatch throws at wiring time). The durable `PgVectorStore` implements the same `VectorStore` contract but lives in buffr.
- **Memory rows (`MemoryTurn`/`MemoryHit`)** — a remembered Q/A exchange stored as a vector row in the SAME store: id `memory:<conversationId>:<n>`, `meta={ kind:'memory', conversationId, text }`, vector = `embed(format(turn))`. The `kind` tag is a logical partition over a shared collection (memory + documents share one store); recall over-fetches then filters by `kind` client-side since the `VectorStore` contract has no metadata predicate.
- **Trace events (`CapabilityEvent`)** — a discriminated union emitted by the agent loop: `step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`; each carries `capabilityId` + ISO `timestamp`. Streamed/persisted as NDJSON.
- **Replay artifacts** (`artifacts/replays/*.json`) — keys: `schemaVersion`, `capabilityId`, `createdAt`, `durationMs`, `provider`, `fixture`, per-capability output (e.g. `question`/`intent`/`answer`, or recommendations/anomalies/diagnosis), `trace`, `eval`, `modelTurns`.
- **Fixtures** (`packages/agents/*/fixtures/*.json` + `fixtures/promoted/*.json`) — recorded `ModelResponse[]` replayed deterministically by `FixtureModelProvider`. Promoted fixtures are timestamped, auto-generated correctness baselines.
- **WorkspaceDescriptor** — runtime input metadata (project, events, customer properties, catalogs, totals, data horizon), summarized into prompts.

## Architecture seams (for partitioning study lenses)

- **Provider-neutral core:** everything depends on the `ModelProvider.complete()` contract, never a vendor SDK directly. Providers are swappable adapters (cloud SDKs, local Ollama/Gemma, fallback chain, context guard).
- **Retrieval-neutral pipeline:** the same adapter shape applied to RAG — `EmbeddingProvider` and `VectorStore` are vendor-neutral contracts (in-memory + Ollama now; pgvector/OpenAI are drop-ins). Retrieval reaches agents as a tool (`search_knowledge_base`), not bespoke control flow.
- **Memory reuses the retrieval contracts (NEW):** episodic conversation memory (`@aptkit/memory`) is a SECOND consumer of `EmbeddingProvider`/`VectorStore` — `remember` is the RAG index path, `recall` the query path — with zero new infrastructure (the strongest evidence the contracts were the right boundary). Reached either via a dedicated `search_memory` tool or, when memory shares the document store, the existing `search_knowledge_base` tool. No aptkit agent wires memory yet; buffr's session runtime does.
- **Capability = prompt package + tool policy + agent loop config + validator.** Each agent is one capability with a `*_CAPABILITY_ID` and a read-only `toolPolicy` allowlist (the RAG agent is the 6th instance of this shape).
- **Replay-centric evaluation:** live run → artifact → eval (structural-diff/detection/rubric) → promote to fixture → deterministic replay. This is the testing/observability backbone.

## Must-not-change constraints

- **`@rlynjb/aptkit-core` public API is a compatibility contract** (published, semver `0.4.x`). Re-exported names from runtime/tools/context/prompts/evals/workflows/retrieval/providers/agents are the surface.
- **`@aptkit/core` aliasing path** must keep working for host apps that alias `npm:@rlynjb/aptkit-core`.
- **Core must not import app-specific product logic** — that is the whole reason the monorepo exists.
- **Promoted fixtures are correctness baselines** — editing them changes test meaning; they are regenerated via `promote:replay`, not hand-edited.
- **`ModelProvider` / `CapabilityEvent` / `ToolRegistry` / `WorkspaceDescriptor` / `EmbeddingProvider` / `VectorStore`** are the load-bearing contracts; changing their shape ripples across packages (the retrieval contracts are also what buffr's `PgVectorStore` implements).
- **Legacy alias:** `@aptkit/core` ↔ `@rlynjb/aptkit-core` must remain interchangeable.

## Notes / open items

- `.env` holds live provider keys (gitignored) — treat as secret; never echo values into artifacts or study output.
- `rubric-improvement` agent has no `replay:promoted` script wired into the root pipeline (others do).
- OpenAI cost pricing in `usage-ledger.ts` currently only covers `gpt-4.1-*` models.
