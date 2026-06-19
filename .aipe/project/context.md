# Project Context — AptKit

AptKit is a **TypeScript monorepo** packaging reusable AI-agent capabilities extracted from working apps (notably "Blooming Insights"). It isolates the reusable parts of agent systems — a bounded agent loop, provider adapters, tool registry/policy, structured-output parsing, evaluators, content workflows, prompt packages, and a Studio preview/replay UI — so they can ship as a public npm bundle (`@rlynjb/aptkit-core`) without app-specific product logic leaking into the core.

## Stack

- **Language:** TypeScript `^5.5`, ESM only (`"type": "module"`). `tsconfig.base.json`: target ES2022, module/resolution `NodeNext`, `strict: true`, `declaration: true`.
- **Workspaces:** npm workspaces — `packages/*`, `packages/agents/*`, `packages/providers/*`, `apps/*`. Internal packages versioned `0.0.0`; published bundle is `0.3.0`.
- **Build:** per-package `tsc -b` (`npm run build --workspaces --if-present`). Core has an explicit ordered `build:core:deps` chain.
- **Tests:** Node's built-in runner (`node --test dist/test/*.test.js`) per package; Playwright smoke test for Studio (`playwright.studio.config.ts`, dev server on port 4187). No jest/vitest.
- **Model providers:** Anthropic (`@anthropic-ai/sdk ^0.60`, default `claude-sonnet-4-6`), OpenAI (`openai ^6.44`, default `gpt-4.1`), a sequential fallback chain, and a local context-window guard. Keys via env (`ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `OPENAI_API_KEY`, `OPENAI_MODEL` — see `.env`, gitignored).
- **Frontend:** `apps/studio` — React 18 + Vite. CSS-in-file styling, `lucide-react` icons, React hooks for state. Vite middleware exposes 5 replay API routes and streams NDJSON traces.
- **Publishing:** `@rlynjb/aptkit-core` published to npm public registry; `bundledDependencies` inlines all 11 internal packages into one standalone tarball (`scripts/pack-core-standalone.mjs`). CI: `.github/workflows/publish-core.yml`.

## File structure

| Path | Purpose |
| --- | --- |
| `packages/runtime` | Foundation, no internal deps. Provider contract (`ModelProvider`/`ModelRequest`/`ModelResponse`), bounded agent loop (`runAgentLoop`), trace events (`CapabilityEvent`), JSON extraction (`parseAgentJson`), structured generation w/ retry, usage/cost ledger, NDJSON stream helpers. |
| `packages/tools` | `ToolRegistry`/`InMemoryToolRegistry`, `ToolPolicy` + `filterToolsForPolicy` (least-privilege allowlists), coverage-gate (which capabilities are runnable from workspace metadata). Imports `ModelTool` from runtime. |
| `packages/context` | Pure types `WorkspaceDescriptor`/event+catalog descriptors/`DataHorizon`, plus deterministic `schemaSummary()` renderer. No internal deps. |
| `packages/prompts` | `PromptPackage` type + `renderPromptTemplate()` (`{var}` substitution). Per-agent prompt packages (query, recommendation, monitoring, diagnostic) with id/version/capabilityId provenance. |
| `packages/evals` | Replay-artifact shape assertions, rule-based `structural-diff`, `detection-scorer`, `rubric-judge`, and `replay-runner` (batch eval → `ReplayArtifactEvalSummary`). |
| `packages/workflows` | Content-generation workflow (split markdown by `##`, round-robin variant angles, generate fresh/stale/generated) + markdown-section helpers. |
| `packages/agents/recommendation` | Anomaly+diagnosis → ≤3 grounded recommendations. `runAgentLoop` maxTurns 6. |
| `packages/agents/anomaly-monitoring` | Scans workspace metrics against 10 ecommerce anomaly categories → severity-sorted anomalies. |
| `packages/agents/diagnostic-investigation` | Single anomaly → hypothesis-tested `Diagnosis` with confidence inference. |
| `packages/agents/query` | NL question → plain-text answer over ~49 read-only tools; intent classification. |
| `packages/agents/rubric-improvement` | Score subject against rubric → weakest dimension + next action/drill. |
| `packages/providers/{anthropic,openai,fallback,local}` | `ModelProvider` adapters. |
| `packages/core` | `@rlynjb/aptkit-core` — pure re-export composition of all 11 packages; the published surface. |
| `apps/studio` | React/Vite manual preview + replay UI (6 workspace panels + capabilities gallery + shared `AgentReplayShell`). |
| `scripts/*.mjs` | `eval-replay-artifacts`, `promote-replay-to-fixture`, `replay-model-recommendation`, `replay-promoted-fixtures`, `pack-core-standalone`. |
| `artifacts/replays/` | Saved replay artifacts (JSON) from Studio/live runs. |
| `docs/` | Capability inventory, architecture notes, Studio guide, publishing & migration plans, resume notes. |
| `tests/studio/` | Playwright smoke spec. |

## Data model

No SQL/relational database. "Data" is file- and stream-shaped:

- **Trace events (`CapabilityEvent`)** — a discriminated union emitted by the agent loop: `step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`; each carries `capabilityId` + ISO `timestamp`. Streamed/persisted as NDJSON.
- **Replay artifacts** (`artifacts/replays/*.json`) — keys: `schemaVersion`, `capabilityId`, `createdAt`, `durationMs`, `provider`, `fixture`, per-capability output (e.g. `question`/`intent`/`answer`, or recommendations/anomalies/diagnosis), `trace`, `eval`, `modelTurns`.
- **Fixtures** (`packages/agents/*/fixtures/*.json` + `fixtures/promoted/*.json`) — recorded `ModelResponse[]` replayed deterministically by `FixtureModelProvider`. Promoted fixtures are timestamped, auto-generated correctness baselines.
- **WorkspaceDescriptor** — runtime input metadata (project, events, customer properties, catalogs, totals, data horizon), summarized into prompts.

## Architecture seams (for partitioning study lenses)

- **Provider-neutral core:** everything depends on the `ModelProvider.complete()` contract, never a vendor SDK directly. Providers are swappable adapters (incl. fallback chain + context guard).
- **Capability = prompt package + tool policy + agent loop config + validator.** Each agent is one capability with a `*_CAPABILITY_ID` and a read-only `toolPolicy` allowlist.
- **Replay-centric evaluation:** live run → artifact → eval (structural-diff/detection/rubric) → promote to fixture → deterministic replay. This is the testing/observability backbone.

## Must-not-change constraints

- **`@rlynjb/aptkit-core` public API is a compatibility contract** (published, semver `0.3.0`). Re-exported names from runtime/tools/context/prompts/evals/workflows/agents are the surface.
- **`@aptkit/core` aliasing path** must keep working for host apps that alias `npm:@rlynjb/aptkit-core`.
- **Core must not import app-specific product logic** — that is the whole reason the monorepo exists.
- **Promoted fixtures are correctness baselines** — editing them changes test meaning; they are regenerated via `promote:replay`, not hand-edited.
- **`ModelProvider` / `CapabilityEvent` / `ToolRegistry` / `WorkspaceDescriptor`** are the load-bearing contracts; changing their shape ripples across every package.
- **Legacy alias:** `@aptkit/core` ↔ `@rlynjb/aptkit-core` must remain interchangeable.

## Notes / open items

- `.env` holds live provider keys (gitignored) — treat as secret; never echo values into artifacts or study output.
- `rubric-improvement` agent has no `replay:promoted` script wired into the root pipeline (others do).
- OpenAI cost pricing in `usage-ledger.ts` currently only covers `gpt-4.1-*` models.
