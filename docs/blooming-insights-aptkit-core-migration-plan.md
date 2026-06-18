# Blooming Insights AptKit Core Migration Plan

This plan covers replacing reusable AI code in `../blooming_insights` with `@aptkit/core` while keeping Blooming-specific route, auth, data-source, UI, and storage code in Blooming.

Current state:

- `../blooming_insights` installs one bundled local tarball: `@aptkit/core`.
- `../blooming_insights/lib/agents/recommendation.ts` is already an adapter over `@aptkit/core`.
- `../blooming_insights/lib/agents/recommendation-legacy.ts` preserves the previous local implementation.
- `@aptkit/core` currently re-exports the recommendation slice only:
  - `@aptkit/runtime`
  - `@aptkit/tools`
  - `@aptkit/context`
  - `@aptkit/prompts`
  - `@aptkit/evals`
  - `@aptkit/agent-recommendation`
- AptKit has additional packages for monitoring, diagnostic, and query agents, but they are not yet exported or bundled by `@aptkit/core`.

## Migration Principles

- Keep Blooming route handlers, Next.js hooks, auth, cookies, MCP session lifecycle, and concrete data-source adapters in Blooming.
- Replace reusable agent, eval, prompt, parsing, coverage, streaming, and tool-policy logic with AptKit package APIs.
- Use compatibility adapters first. Keep Blooming constructor and method signatures stable until routes and eval scripts are migrated.
- Preserve legacy Blooming implementations under `*-legacy.ts` during each migration phase. Remove them only after parity is proven and explicitly approved.
- Repack core with `npm run build && npm run pack:core`, then reinstall the single tarball in Blooming after each AptKit surface change.

## Replacement Map

| Area | Blooming Source | AptKit Target | Status | Notes |
| --- | --- | --- | --- | --- |
| Recommendation agent | `lib/agents/recommendation.ts` | `@aptkit/core` via `@aptkit/agent-recommendation` | Active | Adapter exists and tests pass. |
| Recommendation legacy | `lib/agents/recommendation-legacy.ts` | None | Preserved | Reference only; not imported by active route. |
| Monitoring agent | `lib/agents/monitoring.ts` | `@aptkit/agent-anomaly-monitoring` | Ready package, not core-exported | Needs core export plus Blooming adapter. |
| Diagnostic agent | `lib/agents/diagnostic.ts` | `@aptkit/agent-diagnostic-investigation` | Ready package, not core-exported | Needs core export plus Blooming adapter. |
| Query agent | `lib/agents/query.ts` | `@aptkit/agent-query` | Ready package, not core-exported | Needs core export plus Blooming adapter. |
| Intent parsing | `lib/agents/intent.ts` | `@aptkit/agent-query` intent helpers | Partial | Pure parser can move; live Anthropic classifier remains adapter-owned unless AptKit adds provider-based classifier. |
| Agent loop | `lib/agents/base.ts` | `@aptkit/runtime` `runAgentLoop` | Partially replaced | Recommendation uses AptKit loop through package. Other Blooming agents still use local loop. |
| Tool schema filtering | `lib/agents/tool-schemas.ts`, `lib/mcp/tools.ts` | `@aptkit/tools` tool policy helpers | Partial | Package has policies; Blooming still needs provider-specific MCP/data-source adapter code. |
| Workspace summary | `lib/agents/monitoring.ts`, `lib/mcp/schema.ts` | `@aptkit/context` `schemaSummary` / `WorkspaceDescriptor` | Partial | Types are structurally compatible; bootstrap remains Blooming-specific. |
| JSON parser | `lib/mcp/validate.ts` | `@aptkit/runtime` JSON extractor plus package validators | Candidate | Keep Blooming validators until all local agents are replaced. |
| Category coverage | `lib/agents/categories.ts`, `lib/mcp/tool-coverage.ts` | `@aptkit/tools` coverage gate and `@aptkit/agent-anomaly-monitoring` categories | Candidate | Needs UI parity check because Blooming category IDs drive visible coverage tiles. |
| NDJSON reader | `lib/streaming/ndjson.ts` | `@aptkit/runtime` NDJSON stream decoder | Candidate | Browser hook behavior must preserve cancel and malformed-line semantics. |
| Structural diff eval | `eval/scripts/lib/structural-diff.ts` | `@aptkit/evals` structural diff | Ready | Replace script import after output shape compatibility check. |
| Detection scorer | `eval/scripts/lib/scorer.ts` | `@aptkit/evals` detection scorer | Ready | Verify seeded alias behavior before replacing. |
| Replay/eval runner | `eval/scripts/run-regression.ts`, `eval/scripts/lib/run-*.ts` | `@aptkit/evals` replay harness | Partial | Blooming run scripts include source-app live data setup and judge calls, so migrate deterministic pieces first. |
| Judge prompts | `eval/scripts/lib/judge*.ts`, `eval/judges/*.md` | Not in core | Defer | Rubric judge is a future AptKit candidate, not current core. |

## Phase 1: Expand `@aptkit/core` To Export Existing Agent Packages

Goal: make one bundled `@aptkit/core` tarball contain all Blooming-ready agent packages, not only recommendation.

Implementation in AptKit:

1. Add these dependencies to `packages/core/package.json`:
   - `@aptkit/agent-anomaly-monitoring`
   - `@aptkit/agent-diagnostic-investigation`
   - `@aptkit/agent-query`
2. Add them to `bundledDependencies`.
3. Re-export them from `packages/core/src/index.ts`.
4. Add core smoke tests for:
   - `AnomalyMonitoringAgent`
   - `DiagnosticInvestigationAgent`
   - `QueryAgent`
   - `parseIntent` or the exported intent helper
5. Update `scripts/pack-core-standalone.mjs` to pack and install those packages into the bundled core tarball.
6. Run:
   - `npm run build`
   - `npm test -w @aptkit/core`
   - `npm test`
   - `npm run eval:replays`
   - `npm run pack:core`

Acceptance criteria:

- A clean temp project can install only `/private/tmp/aptkit-packs/aptkit-core-0.0.0.tgz`.
- `node -e "import('@aptkit/core')"` can access all four agent classes.
- Blooming can reinstall only the single core tarball and still build/test before any additional source migration.

## Phase 2: Extract Shared Blooming Adapter Helpers

Goal: avoid duplicating the Anthropic/model, data-source/tool, and trace/hook adapters across four Blooming agent wrappers.

Implementation in Blooming:

1. Create `lib/agents/aptkit-adapters.ts`.
2. Move the current recommendation adapter helper classes there:
   - `AnthropicModelProviderAdapter`
   - `BloomingToolRegistryAdapter`
   - `BloomingTraceSinkAdapter`
3. Parameterize the trace adapter with Blooming `AgentName`, because query currently reports as `coordinator` while AptKit query capability is `query-agent`.
4. Keep `lib/agents/recommendation.ts` as a thin wrapper that imports those adapters.

Acceptance criteria:

- `test/agents/recommendation.test.ts` still passes.
- `test/api/agent.integration.test.ts` still passes.
- No route or UI code changes yet.

## Phase 3: Replace Diagnostic Agent

Goal: make `lib/agents/diagnostic.ts` delegate to `DiagnosticInvestigationAgent` from `@aptkit/core`.

Implementation in Blooming:

1. Copy current `lib/agents/diagnostic.ts` to `lib/agents/diagnostic-legacy.ts`.
2. Replace active `DiagnosticAgent` implementation with an adapter that preserves:
   - constructor `(anthropic, dataSource, schema, allTools, sessionId?)`
   - method `investigate(anomaly, hooks?)`
3. Use shared adapters from `lib/agents/aptkit-adapters.ts`.
4. Confirm confidence behavior matches current Blooming behavior:
   - AptKit derives confidence internally.
   - Blooming currently imports `diagnosisConfidence` from `lib/insights/derive`.
   - If output differs, keep a post-processing compatibility step in the adapter.

Tests:

- `npm test -- test/agents/diagnostic.test.ts`
- `npm test -- test/api/agent.integration.test.ts`
- `npm run build`
- `npm test`

Acceptance criteria:

- Diagnosis route events still emit the same `reasoning_step`, `tool_call_start`, `tool_call_end`, and `diagnosis` events.
- Existing diagnostic tests pass unchanged or with only intentional expectation updates.

## Phase 4: Replace Monitoring Agent And Coverage Helpers

Goal: make `lib/agents/monitoring.ts` delegate to `AnomalyMonitoringAgent` from `@aptkit/core`.

Implementation in Blooming:

1. Copy current `lib/agents/monitoring.ts` to `lib/agents/monitoring-legacy.ts`.
2. Replace active `MonitoringAgent` implementation with an adapter preserving:
   - constructor `(anthropic, dataSource, schema, allTools, sessionId?)`
   - method `scan(hooks?, categories?)`
3. Map Blooming `AnomalyCategory` to AptKit `AnomalyCategory`.
   - Blooming uses `eql(projectId)` recipes.
   - AptKit uses `queryRecipe` strings.
   - Adapter can compute `queryRecipe` before invoking AptKit.
4. Decide whether to replace `lib/agents/categories.ts` immediately or keep it as a UI/domain pack for one phase.
5. Only after monitoring parity, replace `lib/mcp/tool-coverage.ts` with AptKit coverage helpers or a small adapter.

Tests:

- `npm test -- test/agents/monitoring.test.ts`
- `npm test -- test/agents/categories.test.ts`
- `npm test -- test/mcp/tool-coverage.test.ts`
- `npm run eval:detection`
- `npm run build`
- `npm test`

Acceptance criteria:

- Briefing output still sorts and caps anomalies the same way.
- Coverage grid remains stable.
- Detection eval does not regress on seeded Olist anomalies.

## Phase 5: Replace Query Agent And Intent Parser

Goal: make `lib/agents/query.ts` delegate to `QueryAgent` from `@aptkit/core`.

Implementation in Blooming:

1. Copy current `lib/agents/query.ts` to `lib/agents/query-legacy.ts`.
2. Replace active `QueryAgent` implementation with an adapter preserving:
   - constructor `(anthropic, dataSource, schema, allTools, sessionId?)`
   - method `answer(query, intent, hooks?)`
3. Pass `intent` through AptKit `QueryAgent.answer(question, { intent, signal })`.
4. Evaluate replacing `parseIntent` with AptKit's exported parser.
5. Keep live `classifyIntent` in Blooming until AptKit has a provider-neutral classifier helper.

Tests:

- `npm test -- test/agents/query.test.ts`
- `npm test -- test/agents/intent.test.ts`
- `npm test -- test/api/agent.integration.test.ts`
- `npm run build`
- `npm test`

Acceptance criteria:

- Free-form query route still emits no diagnosis/recommendation events.
- Query answers preserve the current fallback text when no answer is found.

## Phase 6: Replace Eval Utilities

Goal: remove duplicate deterministic eval helpers from Blooming after agent parity is stable.

Implementation in Blooming:

1. Replace `eval/scripts/lib/structural-diff.ts` with imports from `@aptkit/core`.
2. Replace `eval/scripts/lib/scorer.ts` with imports from `@aptkit/core`.
3. Keep Blooming-specific judge prompts and live judge runners in Blooming for now.
4. Keep `run-*-agent.ts` scripts in Blooming until all four agents use AptKit wrappers; then simplify them to import shared wrappers.
5. Leave `eval/fixtures/*` in Blooming because they are source-app fixtures.

Tests:

- `npm run eval:regression`
- `npm run eval:detection`
- `npm run eval:diagnosis`
- `npm run eval:recommendation`
- `npm test`

Acceptance criteria:

- Regression summary shape is unchanged.
- Detection score for seeded fixtures is unchanged or intentionally documented.
- No eval script imports deleted local agent internals that are now legacy-only.

## Phase 7: Replace Small Runtime Utilities

Goal: remove low-risk duplicated utilities once agent/eval behavior is stable.

Candidates:

1. `lib/mcp/validate.ts`
   - Replace `parseAgentJson` with AptKit JSON extraction.
   - Keep Blooming validators only if local legacy agents still import them.
2. `lib/streaming/ndjson.ts`
   - Replace `readNdjson` internals with AptKit NDJSON decoder while preserving hook API.
3. `lib/agents/tool-schemas.ts`
   - Replace with AptKit tool-policy filtering once all active agents use AptKit policies.

Tests:

- `npm test -- test/mcp/validate.test.ts`
- `npm test -- test/streaming/ndjson.test.ts`
- `npm test -- test/agents/tool-schemas.test.ts`
- `npm test`

Acceptance criteria:

- Browser stream cancellation behavior is unchanged.
- Malformed NDJSON line behavior is unchanged.
- Existing tests either pass unchanged or document intentional naming differences.

## Deferred Work

- Bloomreach and Olist data-source adapters stay in Blooming until AptKit defines adapter packages.
- OAuth/session/cookie code stays in Blooming.
- Next.js route handlers stay in Blooming.
- Judge prompts and live judge calls stay in Blooming until AptKit has a rubric judge package.
- Publishing should wait until the local bundled tarball path is replaced with a durable package source.

## Recommended Next Task

Start with Phase 1 and Phase 2 together:

1. Expand `@aptkit/core` to bundle and export monitoring, diagnostic, and query agents.
2. Extract Blooming's current recommendation adapter helpers into `lib/agents/aptkit-adapters.ts`.

This gives every later agent migration the same adapter surface and keeps each follow-up phase small.
