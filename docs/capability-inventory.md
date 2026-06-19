# AptKit Capability Inventory

This inventory turns the operational plan in `docs/ai-capability-library-plan.md` into a working list of packaged capabilities.

Use it as the package ledger after code moves into `packages/*`. Each entry should answer three questions:

- What reusable behavior exists?
- What app-specific surface must stay behind?
- What maturity gap remains before the capability is Level 6?

## Extraction Rubric

Score each capability before extraction.

| Score | Meaning |
| --- | --- |
| High | Strong reuse, clear contract, testable without the source app, low coupling. |
| Medium | Valuable, but needs parameterization or fixture work before packaging. |
| Low | Useful mostly as app code, an example, or a later adapter/domain pack. |

Extraction priority:

- `P0`: first vertical slice and runtime foundation.
- `P1`: second wave once the first slice proves shared seams.
- `P2`: examples, adapters, or later packages after core APIs settle.

Maturity follows the plan's Level 0-6 model, where Level 6 means a reusable package with docs, examples, CI tests, versioning, and preview UI.

## Capability Summary

| Priority | Capability ID | Name | Type | Source | Target Package | Score | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P0 | `bounded-agent-loop` | Bounded agent tool-use loop | Utility | `blooming_insights` | `packages/runtime` | High | Packaged |
| P0 | `capability-trace-events` | Agent event trace contract | Utility | `blooming_insights` | `packages/runtime` | High | Packaged |
| P0 | `tool-registry` | Tool/data-source seam | Tool | `blooming_insights` | `packages/tools` | High | Packaged |
| P0 | `json-output-extractor` | Structured-output parser and validators | Utility | `blooming_insights`, `dryrun` | `packages/runtime` | High | Packaged |
| P0 | `ndjson-event-streaming` | NDJSON event streaming utility | Utility | `blooming_insights` | `packages/runtime` | High | Packaged |
| P0 | `recommendation-agent` | Recommendation agent | Agent | `blooming_insights` | `packages/agents/recommendation` | Medium | Packaged |
| P1 | `anomaly-monitoring-agent` | Monitoring/anomaly detection agent | Agent | `blooming_insights` | `packages/agents/anomaly-monitoring` | Medium | Packaged |
| P1 | `diagnostic-investigation-agent` | Diagnostic investigation agent | Agent | `blooming_insights` | `packages/agents/diagnostic-investigation` | Medium | Packaged |
| P1 | `query-over-tools-agent` | Free-form query agent | Agent | `blooming_insights` | `packages/agents/query` | Medium | Packaged |
| P1 | `rubric-improvement-agent` | Rubric improvement agent | Agent | `dryrun` | `packages/agents/rubric-improvement` | Medium | Packaged |
| P1 | `prompt-package` | Prompt packages | Prompt | `blooming_insights`, `dryrun` | `packages/prompts` | Medium | Packaged |
| P1 | `tool-policy-manifest` | Tool allowlist manifests | Tool | `blooming_insights` | `packages/tools` | High | Packaged |
| P1 | `workspace-descriptor` | Workspace/schema summarizer | Utility | `blooming_insights` | `packages/context` | Medium | Packaged |
| P1 | `capability-coverage-gate` | Capability coverage gate | Utility | `blooming_insights` | `packages/tools` | Medium | Packaged |
| P1 | `provider-fallback-chain` | Provider fallback chain | Provider | `dryrun` | `packages/providers/fallback` | High | Packaged |
| P1 | `usage-ledger` | LLM progress and usage accounting | Utility | `dryrun` | `packages/runtime` | Medium | Packaged |
| P1 | `structured-generation` | On-device JSON retry/fallback pipeline | Utility | `dryrun` | `packages/runtime` | Medium | Packaged |
| P1 | `local-context-guard` | Local model context-window guard | Provider | `dryrun` | `packages/providers/local` | Medium | Packaged |
| P1 | `rubric-judge` | Rubric judge capability | Evaluator | `dryrun` | `packages/evals` | Medium | Packaged |
| P1 | `content-generation-workflow` | Content chunking and multi-angle generation | Workflow | `dryrun` | `packages/workflows` | Medium | Packaged |
| P1 | `eval-harness` | Eval runners and golden fixtures | Evaluator | `blooming_insights` | `packages/evals` | High | Packaged |
| P1 | `structural-diff-evaluator` | Structural diff evaluator | Evaluator | `blooming_insights` | `packages/evals` | High | Packaged |
| P1 | `detection-scorer` | Detection scorer | Evaluator | `blooming_insights` | `packages/evals` | Medium | Packaged |

## Packaged API Map

| Capability ID | Primary Package | Main Exports | Studio Preview |
| --- | --- | --- | --- |
| `bounded-agent-loop` | `@aptkit/runtime` | `runAgentLoop`, `ModelProvider`, `CapabilityEvent` | Agent workspaces |
| `capability-trace-events` | `@aptkit/runtime` | `CapabilityEvent`, `CapabilityTraceSink`, event helpers | Agent and utility traces |
| `tool-registry` | `@aptkit/tools` | `ToolRegistry`, `InMemoryToolRegistry` | Agent workspaces |
| `json-output-extractor` | `@aptkit/runtime` | `parseAgentJson`, `parseValidatedJson` | Runtime utilities |
| `ndjson-event-streaming` | `@aptkit/runtime` | `encodeNdjsonRecord`, `decodeNdjsonStream`, `collectNdjsonStream` | Agent workspaces |
| `recommendation-agent` | `@aptkit/agent-recommendation` | `RecommendationAgent`, validators, prompt package | Recommendation |
| `anomaly-monitoring-agent` | `@aptkit/agent-anomaly-monitoring` | `AnomalyMonitoringAgent`, categories, coverage helpers | Monitoring |
| `diagnostic-investigation-agent` | `@aptkit/agent-diagnostic-investigation` | `DiagnosticInvestigationAgent`, validators | Diagnostic |
| `query-over-tools-agent` | `@aptkit/agent-query` | `QueryAgent`, `classifyIntent`, validators | Query |
| `rubric-improvement-agent` | `@aptkit/agent-rubric-improvement` | `RubricImprovementAgent`, validators, prompt builders | Rubric Improvement |
| `prompt-package` | `@aptkit/prompts` | prompt packages and render helpers | Agent prompt panels |
| `tool-policy-manifest` | `@aptkit/tools` | `ToolPolicy`, `filterToolsForPolicy` | Agent workspaces |
| `workspace-descriptor` | `@aptkit/context` | `WorkspaceDescriptor`, schema summary helpers | Agent workspaces |
| `capability-coverage-gate` | `@aptkit/tools` | coverage gate helpers | Monitoring |
| `provider-fallback-chain` | `@aptkit/provider-fallback` | `FallbackModelProvider` | Runtime utilities |
| `usage-ledger` | `@aptkit/runtime` | `UsageLedger`, usage summary helpers | Agent traces |
| `structured-generation` | `@aptkit/runtime` | `generateStructured` | Runtime utilities |
| `local-context-guard` | `@aptkit/provider-local` | `ContextWindowGuardedProvider`, estimate helpers | Runtime utilities |
| `rubric-judge` | `@aptkit/evals` | `RubricJudge`, prompt builders, validator | Runtime utilities |
| `content-generation-workflow` | `@aptkit/workflows` | `ensureGeneratedContent`, `planContentVariant`, `splitMarkdownSections` | Runtime utilities |
| `eval-harness` | `@aptkit/evals` | replay runner and assertions | Replay scripts |
| `structural-diff-evaluator` | `@aptkit/evals` | `evaluateStructuralDiff`, `assertRequiredPaths`, `getPath` | Replay scripts |
| `detection-scorer` | `@aptkit/evals` | detection scorer helpers | Package tests |

## Maturity Gaps

All P0/P1 inventory rows are packaged. The remaining work is Level 6 maturity, not extraction.

| Gap | Status | Next Work |
| --- | --- | --- |
| Package tests | In place for packaged core utilities, evals, agents, workflows, and providers. | Keep adding fixture tests when APIs expand. |
| Studio previews | Agents and non-agent utilities have preview entries. | Add previews for future provider adapters and examples. |
| READMEs/examples | Package READMEs exist for current reusable packages. | Keep README examples aligned with exported APIs. |
| Manual testing guide | `docs/studio.md` explains Studio pages, modes, shared agent architecture, custom runtime utility dashboard, and smoke paths. | Keep it updated when Studio pages or modes change. |
| Versioning | Core bundle is published as `@rlynjb/aptkit-core`. | Publish only after API or example changes require a release. |
| Adapter examples | Blooming consumes the public core package; provider adapters remain separate. | Add example adapters only when they are generic enough to reuse. |

## P0 Packaged Capabilities

### Capability: Bounded Agent Tool-Use Loop

Reusable behavior: bounded model/tool loop with turn limits, tool-call budget, final synthesis turn, cancellation, parse recovery, and test hooks.

Type: Utility

Current location:

- Project: `blooming_insights`
- Files: `lib/agents/base.ts`

Keep app-specific:

- Anthropic SDK request/response types.
- `AgentName`.
- MCP-specific tool result blocks.

Target package: `packages/runtime`

Extraction requirements:

- Define provider-neutral `ModelProvider`, `ModelRequest`, and `ModelResponse`.
- Replace direct tool calls with injected `ToolRegistry`.
- Emit standard `CapabilityEvent` records.
- Add fake provider/tool tests for budget, cancellation, parse recovery, and final synthesis behavior.

Acceptance criteria:

- Runs without `blooming_insights`.
- Does not import provider SDKs.
- Handles malformed structured output with bounded recovery.
- Produces deterministic traces with fake providers and tools.

### Capability: Agent Event Trace Contract

Reusable behavior: provider-neutral trace events for steps, tool calls, model usage, warnings, and errors.

Type: Utility

Current location:

- Project: `blooming_insights`
- Files: `app/api/agent/route.ts`, `lib/mcp/types.ts`, `lib/mcp/events.ts`

Keep app-specific:

- Domain event payloads named around insights, diagnoses, and recommendations.
- Next.js route sequencing.

Target package: `packages/runtime`

Extraction requirements:

- Define `CapabilityEvent`.
- Add event builders or validation helpers only where they remove duplication.
- Keep raw provider responses out of the primary trace contract.

Acceptance criteria:

- Agents and workflows can emit one shared trace format.
- Fixture replay can consume the trace without source-app code.
- Events carry enough metadata for preview UI and eval debugging.

### Capability: Tool/Data-Source Seam

Reusable behavior: model-callable tool registry with discovery, execution, duration, cancellation, and lifecycle boundaries.

Type: Tool

Current location:

- Project: `blooming_insights`
- Files: `lib/data-source/types.ts`

Keep app-specific:

- `DataSource` naming.
- MCP result envelope assumptions.
- Concrete Bloomreach and Olist implementations.

Target package: `packages/tools`

Extraction requirements:

- Define `ToolRegistry` and optional `ToolCatalogProvider`.
- Normalize tool call result and error shapes.
- Add fake tool registry for tests.
- Keep provider-specific tool schema translation in provider adapters.

Acceptance criteria:

- Agents can run against fake and real registries through the same interface.
- Tool execution supports abort signals.
- Tool errors are structured enough for traces and fallback behavior.

### Capability: Structured-Output Parser

Reusable behavior: robust JSON extraction from model text, fenced block handling, substring scan fallback, validation, and graceful parse-failure handling.

Type: Utility

Current location:

- Projects: `blooming_insights`, `dryrun`
- Files: `blooming_insights/lib/mcp/validate.ts`, `dryrun/app/src/main/java/com/dryrun/app/ai/ondevice/JsonExtract.kt`, `dryrun/app/src/main/java/com/dryrun/app/ai/ondevice/OnDeviceJson.kt`

Keep app-specific:

- Hardcoded anomaly, diagnosis, recommendation, and Bloomreach feature validators.
- Kotlin/Android local-model retry implementation details.

Target package: `packages/runtime`

Extraction requirements:

- Expose `JsonOutputExtractor` and schema-driven validation helpers.
- Support object and array outputs.
- Use Zod schemas at capability boundaries.
- Add fixtures for fenced JSON, prose-wrapped JSON, malformed JSON, and no JSON.

Acceptance criteria:

- Deterministic parser tests cover common model response shapes.
- Validation errors are useful and safe to expose in traces.
- Local/weak model retry logic can reuse the parser without Android dependencies.

### Capability: NDJSON Event Streaming

Reusable behavior: NDJSON stream encoding/reading with cancellation and malformed-line handling.

Type: Utility

Current location:

- Project: `blooming_insights`
- Files: `lib/streaming/ndjson.ts`, `lib/mcp/events.ts`

Keep app-specific:

- Domain-specific event payloads.
- Route-level streaming behavior.

Target package: `packages/runtime`

Extraction requirements:

- Define stream encoder/decoder helpers around `CapabilityEvent`.
- Preserve malformed-line behavior as tested semantics.
- Keep browser and route adapters outside the core utility.

Acceptance criteria:

- Streaming helpers run in package tests without Next.js.
- Malformed records produce bounded warnings or errors.
- Abort behavior is covered by tests.

### Capability: Recommendation Agent

Reusable behavior: typed recommendation agent grounded in diagnosis, evidence, action taxonomy, and available tools.

Type: Agent

Current location:

- Project: `blooming_insights`
- Files: `lib/agents/recommendation.ts`

Keep app-specific:

- Bloomreach feature names such as scenario, segment, campaign, voucher, and experiment.
- Ecommerce-specific prompt wording unless moved into a domain pack.

Target package: `packages/agents/recommendation`

Extraction requirements:

- Define input/output schemas.
- Inject model provider, tool registry, action taxonomy, logger, trace sink, and abort signal.
- Replace hardcoded action features with configurable `ActionTaxonomy`.
- Add fixture-backed tests and one regression eval.

Acceptance criteria:

- Runs outside `blooming_insights`.
- Uses no source-app imports.
- Emits standard trace events.
- Includes at least three examples and no real secrets.

## P1 Packaged Capabilities

### Capability: Anomaly Monitoring Agent

Reusable behavior: schema-aware anomaly scanning with category coverage gates and structured anomaly output.

Type: Agent

Current location:

- Project: `blooming_insights`
- Files: `lib/agents/monitoring.ts`, `lib/agents/categories.ts`

Keep app-specific:

- Ecommerce category IDs and recipes.
- Revenue/order/payment vocabulary.

Target package: `packages/agents/anomaly-monitoring`

Extraction requirements:

- Split generic monitoring loop from ecommerce category pack.
- Use injected workspace descriptor and tool registry.
- Add coverage-gate tests before live model tests.

Acceptance criteria:

- Can run against non-ecommerce category packs.
- Skips unsupported categories deterministically.
- Produces typed anomalies and trace events.

### Capability: Diagnostic Investigation Agent

Reusable behavior: hypothesis-driven investigation using evidence, confidence, and fallback behavior.

Type: Agent

Current location:

- Project: `blooming_insights`
- Files: `lib/agents/diagnostic.ts`

Keep app-specific:

- Olist/Bloomreach prompt wording.
- Ecommerce assumptions in evidence interpretation.

Target package: `packages/agents/diagnostic-investigation`

Extraction requirements:

- Define generic investigation schemas.
- Parameterize domain prompt and evidence vocabulary.
- Add fake-tool tests for missing evidence and low-confidence conclusions.

Acceptance criteria:

- Requires evidence for claims.
- Represents uncertainty in typed output.
- Handles tool failures without unbounded retries.

### Capability: Query Over Tools Agent

Reusable behavior: free-form natural-language analysis over a schema and bounded tool set.

Type: Agent

Current location:

- Project: `blooming_insights`
- Files: `lib/agents/query.ts`, `lib/agents/intent.ts`

Keep app-specific:

- Analytics-specific prompt wording.
- Coordinator naming.

Target package: `packages/agents/query`

Extraction requirements:

- Define query input, answer output, citation/evidence shape, and tool policy.
- Keep intent routing configurable.
- Add fixture tests for unsupported questions and missing tools.

Acceptance criteria:

- Provides grounded answers from supplied tools/schema.
- Refuses or narrows unsupported requests.
- Emits trace events for tool use and warnings.

### Capability: Prompt Package

Reusable behavior: versioned prompt bundles with system prompt, compact prompt variant, user builder, parser, schemas, examples, and tests.

Type: Prompt

Current location:

- Projects: `blooming_insights`, `dryrun`
- Files: `blooming_insights/lib/agents/prompts/*.md`, `dryrun/app/src/main/java/com/dryrun/app/data/bytes/BytePrompt.kt`, `dryrun/app/src/main/java/com/dryrun/app/data/compress/CompressPrompt.kt`

Keep app-specific:

- Personal reader persona copy.
- Domain examples that only make sense in the source apps.

Target package: `packages/prompts`

Extraction requirements:

- Define `PromptPackage` structure.
- Support compact local-model variants.
- Add prompt-shape tests and parser fixtures.

Acceptance criteria:

- Prompt packages expose input/output schemas.
- Compact and full variants target the same output contract.
- App-specific copy lives in example/domain packs.

### Capability: Tool Policy Manifest

Reusable behavior: per-capability least-privilege tool allowlists and advertised tool filtering.

Type: Tool

Current location:

- Project: `blooming_insights`
- Files: `lib/mcp/tools.ts`, `lib/agents/tool-schemas.ts`

Keep app-specific:

- Concrete Bloomreach and Olist tool names.
- Anthropic `input_schema` output shape.

Target package: `packages/tools`

Extraction requirements:

- Define provider-neutral tool policy manifests.
- Apply allowlists before provider schema translation.
- Add deterministic tests for blocked and allowed tools.

Acceptance criteria:

- Write-path tools are disabled by default.
- Tool grants are capability-scoped.
- Policy failures are visible in traces.

### Capability: Workspace Descriptor

Reusable behavior: token-bounded workspace/schema summary for analytics or data-backed agents.

Type: Utility

Current location:

- Project: `blooming_insights`
- Files: `lib/mcp/schema.ts`, `lib/agents/monitoring.ts`

Keep app-specific:

- Bloomreach project/org bootstrap tools.
- Olist synthetic schema.
- Process-global cache.

Target package: `packages/context`

Extraction requirements:

- Define `WorkspaceDescriptor`.
- Move source-specific bootstrap to adapters.
- Use explicit host-provided cache.

Acceptance criteria:

- Summaries are bounded and deterministic.
- No process-global cache is required.
- Works with fixture descriptors in tests.

### Capability: Capability Coverage Gate

Reusable behavior: decide which tasks or categories are runnable from available tools, events, properties, and schema capabilities.

Type: Utility

Current location:

- Project: `blooming_insights`
- Files: `lib/agents/categories.ts`, `lib/mcp/tool-coverage.ts`

Keep app-specific:

- Ecommerce anomaly categories.
- EQL recipes.

Target package: `packages/tools`

Extraction requirements:

- Define generic coverage requirements and result shape.
- Move ecommerce categories to a domain pack.
- Add tests for partial and missing coverage.

Acceptance criteria:

- Agents can skip unsupported work before model calls.
- Coverage reasons are inspectable in preview UI.
- Domain packs can define their own requirements.

### Capability: Provider Fallback Chain

Reusable behavior: provider chain with local-first or primary/fallback routing, progress callbacks, and null/error-as-fallback semantics.

Type: Provider

Current location:

- Project: `dryrun`
- Files: `app/src/main/java/com/dryrun/app/ai/LlmClient.kt`, `OpenAiLlmClient.kt`, `RoutingLlmClient.kt`

Keep app-specific:

- Kotlin coroutines and Hilt bindings.
- Android settings lookup.
- Mobile logging.

Target package: `packages/providers`

Extraction requirements:

- Define provider policy objects.
- Normalize fallback reasons.
- Emit usage/progress events.
- Add fake provider tests for failover ordering.

Acceptance criteria:

- Capability code depends only on `ModelProvider`.
- Fallback behavior is deterministic under tests.
- Provider choice is visible in traces.

### Capability: Usage Ledger

Reusable behavior: exact and estimated token accounting with phase labels, context-window pressure, and per-feature usage.

Type: Utility

Current location:

- Project: `dryrun`
- Files: `app/src/main/java/com/dryrun/app/ai/LlmProgress.kt`, `CloudUsage.kt`, `data/usage/UsageStore.kt`

Keep app-specific:

- Android DataStore persistence.
- Fixed mobile feature list.

Target package: `packages/runtime` or `packages/usage`

Extraction requirements:

- Define `ModelUsage` and usage events.
- Make persistence host-provided through `UsageLedger`.
- Preserve exact-vs-estimated semantics.

Acceptance criteria:

- Usage can be recorded without choosing a storage backend.
- Traces can distinguish estimates from provider-reported counts.
- Context-window pressure can be surfaced without platform dependencies.

### Capability: Structured Generation

Reusable behavior: prompt, extract JSON, parse/validate, strict retry, and fallback for weak or local models.

Type: Utility

Current location:

- Project: `dryrun`
- Files: `app/src/main/java/com/dryrun/app/ai/ondevice/OnDeviceJson.kt`, `JsonExtract.kt`

Keep app-specific:

- MediaPipe readiness checks.
- Android progress labels.

Target package: `packages/runtime` or `packages/providers/local`

Extraction requirements:

- Build on `JsonOutputExtractor`.
- Accept schema and retry policy.
- Return explicit result/failure state instead of platform-specific null handling.

Acceptance criteria:

- Retry behavior is bounded and tested.
- Cloud fallback can use the same output schema.
- Parser failures are represented safely in traces.

### Capability: Rubric Judge

Reusable behavior: rubric-scored judge with dimensions, verdict rules, coaching fix, and structured output.

Type: Evaluator

Current location:

- Project: `dryrun`
- Files: `app/src/main/java/com/dryrun/app/data/compress/CompressPrompt.kt`, `CompressAi.kt`

Keep app-specific:

- Communication-compression dimensions and calibration examples.

Target package: `packages/evals` or `packages/agents/judge`

Extraction requirements:

- Define generic rubric, dimension, and verdict schemas.
- Parameterize calibration examples.
- Add deterministic schema tests and optional live judge evals.

Acceptance criteria:

- A domain pack can provide dimensions without changing judge code.
- Judge output is structured and versioned.
- Live provider tests are opt-in.

### Capability: Content Generation Workflow

Reusable behavior: markdown sectioning, angle rotation, stale-cache invalidation, bounded skip retries, and token tracking.

Type: Workflow

Current location:

- Project: `dryrun`
- Files: `app/src/main/java/com/dryrun/app/data/bytes/MarkdownSections.kt`, `ByteGenerator.kt`

Keep app-specific:

- Room repositories.
- `Byte` entity.
- Personal angle names and feed/card behavior.

Target package: `packages/workflows` or `packages/prompts`

Extraction requirements:

- Extract deterministic markdown section splitting first.
- Define workflow input/output and retry policy.
- Keep source app feed behavior as an example.

Acceptance criteria:

- Runs against fake providers.
- Retry and skip behavior are deterministic under tests.
- Token usage is emitted through standard usage events.

### Capability: Eval Harness

Reusable behavior: fixture capture, regression execution, structural assertions, judge prompts, summaries, and golden output handling.

Type: Evaluator

Current location:

- Project: `blooming_insights`
- Files: `eval/*`, `eval/scripts/*`

Keep app-specific:

- Olist seeded anomalies.
- Ecommerce scoring aliases.

Target package: `packages/evals`

Extraction requirements:

- Define fixture format.
- Split deterministic assertions from model-judged evals.
- Keep live provider tests opt-in.

Acceptance criteria:

- Package tests run without network.
- Fixtures are sanitized.
- Eval summaries are stable enough for CI and preview UI.

### Capability: Structural Diff Evaluator

Reusable behavior: schema and field-level regression guard for model outputs.

Type: Evaluator

Current location:

- Project: `blooming_insights`
- Files: `eval/scripts/lib/structural-diff.ts`

Keep app-specific:

- Domain-specific field aliases or scoring thresholds.

Target package: `packages/evals`

Extraction requirements:

- Define generic structural diff options.
- Add fixtures for missing fields, type drift, extra fields, and tolerated optional fields.

Acceptance criteria:

- Diffs are deterministic and readable.
- Capability evals can use it without model calls.
- Thresholds are configurable by capability.

### Capability: Detection Scorer

Reusable behavior: metric, segment, and time matching for anomaly detection evals.

Type: Evaluator

Current location:

- Project: `blooming_insights`
- Files: `eval/scripts/lib/scorer.ts`

Keep app-specific:

- Olist seeded anomaly definitions.
- Ecommerce metric aliases.

Target package: `packages/evals`

Extraction requirements:

- Separate generic matching from ecommerce-specific aliases.
- Define scorer input/output schema.
- Add fixtures covering partial matches and false positives.

Acceptance criteria:

- Domain packs can supply matching aliases.
- Scoring is deterministic.
- Results can feed eval summaries and Studio dashboards.

## Deferred Or Example Candidates

| Priority | Capability ID | Name | Reason To Defer |
| --- | --- | --- | --- |
| P1 | `bloomreach-mcp-adapter` | Bloomreach MCP adapter | Useful adapter, but auth/session behavior is app-specific. |
| P1 | `olist-adapter` | Olist/local SQL adapter | Best as fixture/demo adapter after core tool registry stabilizes. |
| P2 | `report-markdown-renderer` | Markdown/export renderer | Split pure rendering from browser download behavior first. |
| P2 | `replay-store` | Investigation/insight stores | Concrete paths and demo seeds are app-specific. |
| P2 | `short-title-parser` | Short-title and section parser utilities | Small utility; extract only after repeated use. |
| P2 | `corpus-diagnosis` | Corpus diagnosis engine | Valuable deterministic evaluator, but domain dimensions are source-specific. |
| P2 | `openai-transcription-adapter` | OpenAI transcription adapter | Mobile file upload details are app-specific; server adapter can come later. |

## First Extraction Slice

The first slice made `recommendation-agent` runnable outside `blooming_insights` with fake providers and fixtures.

Required supporting capabilities:

1. `bounded-agent-loop`
2. `capability-trace-events`
3. `tool-registry`
4. `json-output-extractor`
5. `tool-policy-manifest`
6. `recommendation-agent`

This kept the initial package graph small while still proving the runtime seams that later agents needed.

## Inventory Maintenance Rules

- Add new candidates here before creating package APIs.
- Keep source-specific names only in adapter/example entries.
- Update status when a candidate moves from discovery to extraction, package, or deferred.
- Add acceptance criteria before extraction begins.
- Do not mark a capability package-ready until it runs with fakes or recorded fixtures and has no source-app imports.
