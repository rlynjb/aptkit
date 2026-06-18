# AptKit Operational Plan

## Purpose

Build AptKit: a reusable TypeScript library of AI capabilities extracted from real projects.

This document is operating context for AI coding assistants and humans working in this workspace. It should guide discovery, extraction, standardization, testing, previewing, and eventual packaging of reusable AI-related code.

The library is not limited to agents. It includes any reusable AI capability that can be lifted out of an app without losing its value.

## Repository Model

Create one GitHub repository named `aptkit`.

This is a monorepo:

- AptKit is the reusable npm library under `packages/*`.
- AptKit Studio is the portfolio/demo UI under `apps/studio`.
- Studio imports local workspace packages while the library is being developed.
- Keep Studio in the same repo until it has independent product/release needs.

Do not create a separate Studio repository at the start. One repo keeps the package graph, examples, fixtures, tests, and display app aligned.

## Operating Principle

Do not assume AI code is an agent.

Catalog and extract the reusable capability beneath the app-specific surface. A capability may be:

- A provider adapter.
- A prompt package.
- A tool-use loop.
- A structured output parser.
- A retrieval pipeline.
- An evaluator.
- A workflow.
- A full agent.
- A multi-agent system.

The goal is not to rewrite projects into a generic framework. The goal is to preserve proven behavior, isolate useful logic, add contracts and tests, then make the result reusable.

## Current Recommendation

Start with `blooming_insights`, not a blank monorepo.

It already has the strongest seed material:

- Multi-agent workflow.
- Anthropic tool-use loop.
- MCP integration.
- Streaming event traces.
- Tool allowlists and validation.
- Fixtures and tests.
- Eval scripts.
- Portfolio-friendly demo surface.

Use `dryrun` as the second source, mainly for provider routing, on-device JSON extraction, usage accounting, and prompt-heavy mobile flows.

Do not start by extracting every project. Extract one vertical slice from `blooming_insights` first, then generalize only what a second capability proves is shared.

## Seed Capability Inventory

| Priority | Capability | Type | Source | Target Package | Why It Matters |
| --- | --- | --- | --- | --- | --- |
| P0 | Bounded agent tool-use loop | Runtime utility | `blooming_insights/lib/agents/base.ts` | `packages/runtime` | Shared model/tool loop with turn limits, tool-call budget, synthesis turn, cancellation, parse recovery, and test hooks. |
| P0 | Agent event trace contract | Utility | `blooming_insights/app/api/agent/route.ts`, `blooming_insights/lib/mcp/types.ts` | `packages/runtime` | Makes agent work observable, previewable, and replayable. |
| P0 | Tool/data-source seam | Tool adapter | `blooming_insights/lib/data-source/types.ts` | `packages/tools` | Existing `DataSource` seam is the starting point for generic `ToolRegistry`. |
| P0 | Structured-output parser and validators | Runtime utility | `blooming_insights/lib/mcp/validate.ts` | `packages/runtime` or `packages/evals` | Reusable fenced-JSON extraction, output validation, and graceful parse-failure handling. |
| P0 | NDJSON event streaming utility | Runtime utility | `blooming_insights/lib/streaming/ndjson.ts`, `blooming_insights/lib/mcp/events.ts` | `packages/runtime` | Generic event transport for live previews, fixture replay, and route streaming. |
| P0 | Recommendation agent | Agent | `blooming_insights/lib/agents/recommendation.ts` | `packages/agents/recommendation` | Smaller than the full workflow; good first extracted agent after domain terms are parameterized. |
| P1 | Monitoring/anomaly detection agent | Agent | `blooming_insights/lib/agents/monitoring.ts`, `blooming_insights/lib/agents/categories.ts` | `packages/agents/anomaly-monitoring` | Demonstrates schema-aware anomaly scanning, coverage gating, and structured anomaly outputs. |
| P1 | Diagnostic investigation agent | Agent | `blooming_insights/lib/agents/diagnostic.ts` | `packages/agents/diagnostic-investigation` | Demonstrates hypothesis-driven investigation with evidence, confidence, and fallback behavior. |
| P1 | Free-form query agent | Agent | `blooming_insights/lib/agents/query.ts`, `blooming_insights/lib/agents/intent.ts` | `packages/agents/query` | Demonstrates routed natural-language analysis over a tool registry. |
| P1 | Prompt packages | Prompt package | `blooming_insights/lib/agents/prompts/*.md` | `packages/prompts` | Existing role/task prompts can become parameterized prompt templates with schemas and evals. |
| P1 | Tool allowlist manifests | Tool safety | `blooming_insights/lib/mcp/tools.ts`, `blooming_insights/lib/agents/tool-schemas.ts` | `packages/tools` | Per-capability tool grants are a reusable safety pattern. |
| P1 | Workspace/schema summarizer | Context builder | `blooming_insights/lib/mcp/schema.ts`, `blooming_insights/lib/agents/monitoring.ts` | `packages/context` or `packages/tools` | Token-bounded schema summaries are reusable for any analytics/data workspace. |
| P1 | Capability coverage gate | Utility | `blooming_insights/lib/agents/categories.ts`, `blooming_insights/lib/mcp/tool-coverage.ts` | `packages/tools` | Generic pattern for deciding which tasks/tools are runnable from available schema/tool capabilities. |
| P1 | Bloomreach MCP adapter | MCP integration | `blooming_insights/lib/data-source/bloomreach-data-source.ts`, `blooming_insights/lib/mcp/auth.ts` | `packages/mcp-bloomreach` or example adapter | Useful adapter, but keep outside core because auth/session behavior is app-specific. |
| P1 | Olist/local SQL adapter | Tool adapter | `blooming_insights/lib/data-source/olist-data-source.ts`, `blooming_insights/mcp-server-olist` | `examples/adapters/olist` | Good fixture/demo adapter for evals and portfolio demos. |
| P1 | Eval runners and golden fixtures | Evaluator | `blooming_insights/eval/*` | `packages/evals` | Gives extracted agents regression, structural diff, similarity judge, and quality judge coverage. |
| P1 | Structural diff evaluator | Evaluator | `blooming_insights/eval/scripts/lib/structural-diff.ts` | `packages/evals` | Generic schema/field regression guard for model outputs. |
| P1 | Detection scorer | Evaluator | `blooming_insights/eval/scripts/lib/scorer.ts` | `packages/evals` | Reusable metric/segment/time matching pattern for anomaly detection evals. |
| P2 | Markdown/export renderer | Utility | `blooming_insights/lib/export/investigationMarkdown.ts` | `packages/renderers` or app-only | Useful for report generation, but split browser download behavior from pure markdown rendering. |
| P2 | Investigation/insight stores | State utility | `blooming_insights/lib/state/*` | `packages/runtime` or app-only | Pattern is reusable for replay/cache stores; concrete file paths and demo seeds are app-specific. |
| P1 | Provider fallback chain | Provider adapter | `dryrun/app/src/main/java/com/dryrun/app/ai/LlmClient.kt`, `OpenAiLlmClient.kt`, `RoutingLlmClient.kt` | `packages/providers` after TS port | Simple provider seam: primary cloud, fallback cloud, on-device-first routing, progress callbacks, null-as-fallback. |
| P1 | LLM progress and usage accounting | Runtime utility | `dryrun/app/src/main/java/com/dryrun/app/ai/LlmProgress.kt`, `CloudUsage.kt`, `data/usage/UsageStore.kt` | `packages/runtime` or `packages/usage` | Tracks exact vs estimated token counts, phase labels, context-window pressure, and per-feature usage. |
| P1 | On-device JSON retry/fallback pipeline | Structured output utility | `dryrun/app/src/main/java/com/dryrun/app/ai/ondevice/OnDeviceJson.kt`, `JsonExtract.kt` | `packages/runtime` or `packages/providers/local` after TS port | Generic pattern for local model JSON extraction, validation, strict retry, and cloud fallback. |
| P1 | Local model context-window guard | Provider adapter | `dryrun/app/src/main/java/com/dryrun/app/ai/ondevice/OnDeviceLlmEngine.kt` | `packages/providers/local` or design doc | Preflight token budgeting prevents native/local-model crashes and routes oversized prompts to cloud. |
| P1 | Prompt package with compact local variant | Prompt package | `dryrun/app/src/main/java/com/dryrun/app/data/bytes/BytePrompt.kt`, `data/compress/CompressPrompt.kt` | `packages/prompts` | Shows how each capability can define full cloud prompts and smaller local-model prompts with the same output schema. |
| P1 | Rubric judge capability | Evaluator | `dryrun/app/src/main/java/com/dryrun/app/data/compress/CompressPrompt.kt`, `CompressAi.kt` | `packages/evals` or `packages/agents/judge` | Reusable rubric-scored judge pattern: dimensions, verdict rules, coaching fix, structured output. |
| P1 | Content chunking and multi-angle generation | Workflow | `dryrun/app/src/main/java/com/dryrun/app/data/bytes/MarkdownSections.kt`, `ByteGenerator.kt` | `packages/workflows` or `packages/prompts` | Reusable markdown sectioning, angle rotation, stale-cache invalidation, bounded retries, and token tracking. |
| P2 | Short-title and section parser utilities | Utility | `dryrun/app/src/main/java/com/dryrun/app/data/fieldnotes/*`, `data/starlog/*` | `packages/utilities` or app-only | Small prompt+parser capabilities for title generation and two-section analysis. |
| P2 | Corpus diagnosis engine | Evaluator/analytics utility | `dryrun/app/src/main/java/com/dryrun/app/data/compress/CorpusDiagnosis.kt` | `packages/evals` or app-only | Deterministic pattern diagnosis over recent judged reps; useful as non-LLM evaluator logic. |
| P2 | OpenAI transcription adapter | Provider adapter | `dryrun/app/src/main/java/com/dryrun/app/ai/OpenAiLlmClient.kt` | `packages/providers/openai` later | Useful speech-to-text adapter pattern, but mobile file upload details are app-specific. |

## Blooming Insights Agnostic Extraction Map

`blooming_insights` should be treated as the reference implementation, not as the library API.

Extract the reusable patterns below, then parameterize or isolate domain-specific pieces.

| Existing Module | Reusable Agnostic Concept | Keep Domain-Specific | Plan Action |
| --- | --- | --- | --- |
| `lib/agents/base.ts` | Bounded model/tool loop, tool budget, final synthesis turn, parse recovery, cancellation, usage logging hooks. | Anthropic SDK types, `AgentName`, MCP-specific tool result blocks. | Port to `packages/runtime` behind `ModelProvider` and `ToolRegistry`. |
| `lib/data-source/types.ts` | Tool execution seam with `callTool`, `listTools`, duration, cancellation, and lifecycle. | Name `DataSource`, MCP result envelope assumptions. | Convert to generic `ToolRegistry` plus optional `ToolCatalogProvider`. |
| `lib/mcp/events.ts` | Event encoding/decoding and agent trace events. | Event payloads named `insight`, `diagnosis`, `recommendation`. | Move generic events to runtime; keep domain payloads as typed capability outputs. |
| `lib/streaming/ndjson.ts` | NDJSON stream reader with cancellation and malformed-line handling. | None significant. | Extract directly to runtime streaming utilities. |
| `lib/mcp/validate.ts` | Fenced JSON extraction, substring scan fallback, type guards. | Hardcoded anomaly/diagnosis/recommendation validators and Bloomreach feature enum. | Extract parser generically; replace validators with Zod schemas per capability. |
| `lib/agents/tool-schemas.ts` | Filter advertised tools to a capability allowlist. | Anthropic `input_schema` output shape. | Move allowlist filtering to generic tool registry; provider adapters translate to provider tool schema. |
| `lib/mcp/tools.ts` | Per-agent least-privilege tool grants. | Specific Bloomreach and Olist tool names. | Convert to per-capability `toolPolicy` manifests. |
| `lib/mcp/schema.ts` | Workspace/schema bootstrap, unwrap helper, token-bounded schema model. | Bloomreach project/org tools, Olist synthetic schema, process-level cache. | Extract `WorkspaceDescriptor` and summarizer; keep concrete bootstraps in adapters. |
| `lib/agents/categories.ts` | Capability coverage gating from available events/properties/tools. | Ecommerce anomaly categories and EQL recipes. | Extract coverage engine; define ecommerce categories as one plugin/config. |
| `lib/agents/monitoring.ts` | Schema-aware anomaly scan agent. | Revenue/order/payment/ecommerce vocabulary and category checklist. | Extract as configurable anomaly-monitoring agent with domain category pack. |
| `lib/agents/diagnostic.ts` | Hypothesis/evidence diagnostic agent with confidence and parse recovery. | Olist/Bloomreach prompt wording. | Extract as generic diagnostic-investigation agent parameterized by domain prompt and schemas. |
| `lib/agents/recommendation.ts` | Recommendation agent grounded in diagnosis and available actions/tools. | Bloomreach action features: scenario, segment, campaign, voucher, experiment. | Extract after replacing `bloomreachFeature` with configurable action taxonomy. |
| `lib/agents/query.ts` | Free-form query agent over a schema and tool set. | Coordinator naming and analytics-specific prompt. | Extract as `query-over-tools` capability. |
| `app/api/agent/route.ts`, `app/api/briefing/route.ts` | Route orchestration, trace bridging, data-source lifecycle, replay/live mode split. | Next.js route handlers, cookies, UI-specific event sequencing. | Document as example app wiring; do not move into core package. |
| `lib/mcp/auth.ts` | OAuth provider persistence pattern, encrypted cookie store, dev/test/prod storage split. | Next cookies, Bloomreach OAuth metadata, app cookie names. | Keep as adapter/example; if extracted, require pluggable `AuthStateStore`. |
| `eval/scripts/*` | Eval runner, capture format, structural diff, judge prompts, summaries. | Olist seeded anomalies, ecommerce scoring aliases. | Extract eval harness and keep Olist scoring as example eval pack. |
| `test/**/*` and `eval/fixtures/**/*` | Fake providers/tools, golden outputs, schema fixtures, regression fixtures. | Real fixture data and domain labels. | Sanitize and promote selected fixtures into package examples. |

### Parameterization Required Before Packaging

Before any `blooming_insights` capability becomes package API:

- Replace direct `Anthropic` constructor injection with `ModelProvider`.
- Replace `DataSource`/`McpCaller` with `ToolRegistry`.
- Replace `readFileSync(join(process.cwd(), ...))` prompt loading with imported prompt strings or explicit prompt templates.
- Replace hardcoded Bloomreach feature unions with configurable action taxonomies.
- Replace hardcoded ecommerce category IDs with domain category packs.
- Replace `crypto.randomUUID()` inside agents with injectable `idGenerator` or runtime helper for portability.
- Replace process-global schema cache with an explicit cache passed by the host app.
- Replace app-specific `AgentName` with `capabilityId` or `role`.
- Convert runtime validators to Zod schemas and JSON Schema exports.
- Keep Next.js route handlers, cookie handling, and UI hooks out of library packages.

### Agnostic Naming Rules

Core package names, exported types, and capability IDs should describe the pattern, not the source app.

Use:

- `ToolRegistry`, not `McpCaller`.
- `WorkspaceDescriptor`, not `BloomreachSchema`.
- `ActionTaxonomy`, not `BloomreachFeature`.
- `CapabilityEvent`, not `AgentEvent` when the event is generic.
- `AnomalyMonitoringAgent`, not `BloomingMonitoringAgent`.
- `DiagnosticInvestigationAgent`, not `BloomreachDiagnosticAgent`.
- `RecommendationAgent`, with injected action taxonomy.
- `ReportMarkdownRenderer`, not `InvestigationMarkdown` if exported generally.

Keep source-specific names only in adapters and examples:

- `BloomreachMcpAdapter`
- `OlistDataSourceAdapter`
- `BloomingInsightsDemo`
- `EcommerceAnomalyCategoryPack`

Rule of thumb: if a consumer building a legal, healthcare, education, or developer-tools product would find the name strange, it does not belong in the core package.

### What Stays App-Specific

Do not extract these into the core package:

- Next.js route handlers.
- React hooks and UI state.
- Bloomreach OAuth cookie handling.
- Demo-specific JSON state files.
- Olist seeded anomaly assumptions.
- Hardcoded ecommerce category recipes.
- Presentation/demo copy.
- Browser download behavior.

These can live in example apps, adapter packages, or domain packs after the core seams are stable.

## Dryrun Agnostic Extraction Map

`dryrun` is a Kotlin/Android reference implementation. Treat it as a source of portable patterns and capability specs, not as code to copy directly into the npm package.

Port only the concepts that strengthen the TypeScript library.

| Existing Module | Reusable Agnostic Concept | Keep App/Platform-Specific | Plan Action |
| --- | --- | --- | --- |
| `ai/LlmClient.kt` | Minimal single-shot LLM seam: system prompt, user prompt, max tokens, model, progress callback, nullable failure. | Kotlin coroutines, Hilt bindings, Android logging, `SettingsStore` key lookup. | Use as input to `ModelProvider`; add provider fallback and progress semantics to runtime docs. |
| `ai/OpenAiLlmClient.kt` | OpenAI chat completion, usage parsing, STT transcription adapter, graceful null failure. | Ktor client setup, Android `File`, hardcoded model defaults, mobile settings. | Port completion/STT adapters later behind `packages/providers/openai`; keep file-upload examples server-side. |
| `ai/CloudUsage.kt` | Quote-anchored token usage extraction from raw JSON. | Regex-based implementation if official SDK usage objects are available. | Keep concept: normalize provider usage into `ModelUsage`; prefer structured SDK fields in TS. |
| `ai/LlmProgress.kt` | Progress event with phase, input/output tokens, estimated flag, done flag. | Kotlin data class naming. | Fold into `ModelStreamEvent` and `CapabilityEvent` usage events. |
| `ai/ondevice/RoutingLlmClient.kt` | Provider chain: local first, cloud fallback. | Hilt qualifiers and Android-local provider selection. | Add `createFallbackProvider([local, cloud])` or runtime policy helper. |
| `ai/ondevice/OnDeviceJson.kt` | Structured local generation: run prompt, extract JSON, parse/validate, strict retry, return null for fallback. | MediaPipe readiness check, Android progress labels. | Port as `generateStructured()` helper for any weak/local model provider. |
| `ai/ondevice/JsonExtract.kt` | Strip fences/prose and extract first JSON object. | Object-only extraction; no array support. | Merge with Blooming Insights `parseAgentJson` into one robust JSON extraction utility. |
| `ai/ondevice/OnDeviceLlmEngine.kt` | Local model engine seam, context-window guard, serialized generation, live token estimates, exact final token usage. | MediaPipe SDK, Android context, native mutex behavior. | Capture as local-provider design; implement only if a JS local model provider is added. |
| `ai/ondevice/OnDeviceModelStore.kt` | Model availability/download state. | Android filesystem, download manager, settings UI. | Keep out of npm core; document as host-app responsibility. |
| `data/bytes/BytePrompt.kt` | Prompt package with full cloud prompt, compact local prompt, user prompt builder, parser, output schema. | Personal reader persona and project-specific examples. | Extract the pattern; turn the actual byte generator into a domain/example prompt pack. |
| `data/bytes/MarkdownSections.kt` | Deterministic markdown H2 section splitting. | None significant. | Port as small utility if content-generation workflows need markdown chunking. |
| `data/bytes/ByteGenerator.kt` | Multi-angle content-generation workflow: section rotation, angle rotation, stale cache, bounded skip retries, token accounting. | Room repositories, `Byte` entity, settings, personal angle names. | Extract workflow pattern; keep dryrun-specific feed/cards as example domain pack. |
| `data/compress/CompressPrompt.kt` | Prompt pack with extract, judge, scenario generation, structured parsers, compact local variants. | Communication-compression domain and calibration examples. | Use as exemplar for prompt-package layout; extract judge pattern if useful. |
| `data/compress/CompressAi.kt` | Capability orchestrator choosing on-device/cloud per feature and honoring explicit strong-model judge choice. | `SettingsStore` constants, direct Anthropic/OpenAI clients, Android file transcription. | Convert into provider policy examples: per-capability provider preference and fallback strategy. |
| `data/compress/CorpusDiagnosis.kt` | Deterministic evaluator over recent scored attempts; identifies weakest dimension and next drill. | Compression-specific dimensions. | Generalize as `RecentScoreDiagnosis` helper only after another evaluator needs it. |
| `data/fieldnotes/*` | Small prompt capabilities: title generation, lens-based analysis, marker-section parser. | Social-experiment/workplace lens copy. | Keep as example prompt packs; port section parser utility if repeated. |
| `data/starlog/*` | STAR story title and analysis prompt capabilities. | Interview-coaching persona and STAR domain. | Keep as example prompt packs or future `behavioral-story` capability. |
| `data/usage/UsageStore.kt` | Per-feature token usage ledger and context-window pressure signal. | Android DataStore persistence and fixed feature list. | Add a generic usage event/ledger interface; persistence is host-provided. |
| `data/prefs/SettingsStore.kt` | Per-feature provider routing preferences and daily generation budget. | Android DataStore, app navigation/timer settings. | Extract the policy idea, not the store. Host apps supply provider policy and budgets. |
| `test/**/*AiTest.kt`, `*PromptTest.kt`, `*JsonTest.kt` | Tests use fake `LlmClient`, parser fixtures, on-device fallback assertions, prompt-shape assertions. | MockK/Kotlin test framework. | Mirror the testing style in TS: fake providers, parser unit tests, fallback-chain tests. |

### Parameterization Required Before Porting Dryrun Patterns

Before a dryrun-derived pattern enters the npm package:

- Convert Kotlin interfaces to TypeScript runtime interfaces.
- Replace nullable failure (`String?`) with explicit `ModelResponse | null` or `Result` shape.
- Replace Hilt qualifiers with provider policy objects.
- Replace Android `SettingsStore` with host-supplied configuration.
- Replace DataStore usage persistence with a pluggable `UsageLedger`.
- Replace MediaPipe-specific local model code with a generic `LocalModelProvider` contract.
- Replace personal reader persona prompts with configurable prompt templates.
- Replace Kotlin serializers with Zod schemas and JSON Schema exports.
- Keep Room repositories, Compose UI, Android files, and mobile recording APIs out of the npm package.

### Dryrun Patterns To Add To Core Design

The plan should carry these dryrun ideas into the agnostic library:

- Provider fallback chains are first-class, not app glue.
- Capability-level provider policy matters: cheap generation, strong judging, local-first extraction, cloud fallback.
- Local model calls need context-window preflight checks before inference starts.
- Weak/local models need compact prompt variants and strict structured-output retry.
- Usage events must distinguish exact token counts from estimates.
- Prompt packages should bundle system prompt, compact prompt, user builder, parser, schemas, examples, and tests.
- Deterministic parsers and prompt-shape tests are as important as model evals.

### Dryrun Naming Rules

Use generic names in core:

- `FallbackModelProvider`, not `CompositeLlmClient`.
- `LocalFirstProvider`, not `RoutingLlmClient`.
- `StructuredGeneration`, not `OnDeviceJson`.
- `JsonOutputExtractor`, not `JsonExtract`.
- `UsageLedger`, not `UsageStore`.
- `PromptPackage`, not `BytePrompt` or `CompressPrompt`.
- `RubricJudge`, not `CompressJudge`.

Keep dryrun-specific names only in examples or domain packs:

- `BytesizeCardPromptPack`
- `CompressionRubricJudge`
- `StarStoryAnalysisPromptPack`
- `FieldNoteAnalysisPromptPack`

### What Stays Dryrun-Specific

Do not extract these into npm core:

- Android Compose UI and ViewModels.
- Room entities, repositories, and DAOs.
- Hilt modules and qualifiers.
- Android DataStore persistence.
- MediaPipe implementation details.
- Mobile model download/storage.
- Camera/audio recording and Android `File` handling.
- Personal reader persona copy.
- Daily feed budget and app-specific settings.

## Capability Types

### Agent

A focused AI unit that accepts input, may call tools, and returns a useful typed output.

Examples:

- Recommendation agent.
- Code review agent.
- Resume reviewer.
- Planning agent.

### Workflow

Multiple capabilities orchestrated together.

Examples:

- Detect -> investigate -> recommend.
- Ingest -> analyze -> report.
- Retrieve -> summarize -> validate.

### Tool

A reusable function made available to a model or workflow.

Examples:

- Entity extraction.
- Classification.
- Data enrichment.
- MCP tool wrapper.

### Utility

Supporting functionality with deterministic behavior.

Examples:

- Prompt formatting.
- Schema validation.
- Output normalization.
- Context construction.
- JSON extraction and repair.

### Prompt Package

Reusable prompts and templates with versioned inputs, expected outputs, and test fixtures.

### Evaluator

Measures output quality or regression risk.

Examples:

- Schema compliance.
- Grounding checks.
- Recommendation quality.
- Instruction compliance.
- Hallucination resistance.

### RAG Component

Reusable retrieval functionality.

Examples:

- Embedding search.
- Document indexing.
- Retrieval ranking.
- Citation extraction.

### Memory Component

Reusable state across turns, sessions, or users.

Examples:

- Conversation memory.
- Session memory.
- Long-term memory.
- Retrieval-backed memory.

### Provider Adapter

Abstraction around model providers.

Examples:

- Anthropic messages adapter.
- OpenAI responses adapter.
- Gemini adapter.
- Local model adapter.

### MCP Integration

Reusable MCP client, auth, tool discovery, tool validation, and tool execution boundary.

## Capability Runtime Contract

Every extractable capability should move toward this shape:

```ts
export type CapabilityType =
  | 'agent'
  | 'workflow'
  | 'tool'
  | 'utility'
  | 'prompt'
  | 'evaluator'
  | 'rag'
  | 'memory'
  | 'provider'
  | 'mcp';

export type CapabilityDefinition<TInput, TOutput> = {
  id: string;
  name: string;
  version: string;
  type: CapabilityType;
  description: string;
  tags: string[];

  inputSchema: unknown;
  outputSchema: unknown;

  dependencies: CapabilityDependencies;
  examples: CapabilityExample<TInput, TOutput>[];
  evals?: CapabilityEval[];

  run(input: TInput, context: CapabilityRunContext): Promise<TOutput>;
  runStream?: (input: TInput, context: CapabilityRunContext) => AsyncIterable<CapabilityEvent | TOutput>;
};

export type CapabilityDependencies = {
  providers?: string[];
  tools?: string[];
  env?: string[];
  dataSources?: string[];
  network?: boolean;
};

export type CapabilityRunContext = {
  model?: ModelProvider;
  tools?: ToolRegistry;
  dataSources?: Record<string, unknown>;
  logger?: CapabilityLogger;
  trace?: CapabilityTraceSink;
  signal?: AbortSignal;
};

export type CapabilityExample<TInput, TOutput> = {
  name: string;
  input: TInput;
  expectedOutput?: Partial<TOutput>;
  fixturePath?: string;
};

export type CapabilityEval = {
  id: string;
  fixturePath: string;
  assertions: string[];
  liveProviderRequired?: boolean;
};
```

The contract should stay small. Add fields only when at least two capabilities need them.

## Event And Trace Contract

Preview, eval, and debugging all depend on a shared event model.

Use this shape for agents and workflows:

```ts
export type CapabilityEvent =
  | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
  | { type: 'tool_call_start'; capabilityId: string; toolName: string; args: unknown; timestamp: string }
  | { type: 'tool_call_end'; capabilityId: string; toolName: string; result?: unknown; error?: string; durationMs: number; timestamp: string }
  | { type: 'model_usage'; capabilityId: string; provider: string; model: string; inputTokens?: number; outputTokens?: number; timestamp: string }
  | { type: 'warning'; capabilityId: string; message: string; timestamp: string }
  | { type: 'error'; capabilityId: string; message: string; timestamp: string };
```

Do not expose provider-specific raw responses as the primary trace format. Keep raw responses available only in sanitized fixtures or debug logs.

## LLM Provider Seam Pattern

Agents and workflows must not import provider SDKs directly.

They should depend on a small provider interface from `packages/runtime`. Provider-specific SDK code belongs in `packages/providers`.

```ts
export type ModelProvider = {
  id: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
  stream?: (request: ModelRequest) => AsyncIterable<ModelStreamEvent>;
};

export type ModelRequest = {
  system?: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
  responseFormat?: ModelResponseFormat;
  maxTokens?: number;
  temperature?: number;
  metadata?: Record<string, unknown>;
  signal?: AbortSignal;
};

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  toolCallId?: string;
};

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string };

export type ModelTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ModelToolCall = {
  id: string;
  name: string;
  args: unknown;
};

export type ModelResponse = {
  text: string;
  toolCalls?: ModelToolCall[];
  usage?: ModelUsage;
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';
  raw?: unknown;
};

export type ModelStreamEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; toolCall: ModelToolCall }
  | { type: 'usage'; usage: ModelUsage }
  | { type: 'done'; response: ModelResponse }
  | { type: 'error'; message: string };

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
};
```

Provider rules:

- `packages/providers/anthropic` translates `ModelRequest` into Anthropic Messages API calls.
- `packages/providers/openai` translates `ModelRequest` into OpenAI Responses API calls.
- `packages/providers/gemini` translates `ModelRequest` into Gemini calls.
- `packages/providers/fake` returns scripted responses for tests and fixture replay.
- Agents never construct SDK clients, read API keys, or choose provider-specific request shapes.
- Raw provider responses are debug-only and must not be required by capability logic.
- Provider adapters must support `AbortSignal` when the underlying SDK supports cancellation.

## Tool Registry Seam Pattern

MCP is one tool transport, not the core tool abstraction.

Capabilities should call tools through a generic registry:

```ts
export type ToolDefinition<TArgs = unknown, TResult = unknown> = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  permission: 'read' | 'write' | 'external' | 'dangerous';
  timeoutMs?: number;
  run(args: TArgs, context: ToolRunContext): Promise<TResult>;
};

export type ToolRunContext = {
  trace?: CapabilityTraceSink;
  logger?: CapabilityLogger;
  signal?: AbortSignal;
};

export type ToolRegistry = {
  list(): ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  call(name: string, args: unknown, context?: ToolRunContext): Promise<unknown>;
};
```

Tool rules:

- Tool calls must validate arguments before execution.
- Tool results should validate when an `outputSchema` exists.
- Write-path and dangerous tools must be opt-in and disabled in examples.
- Tool calls must emit trace events.
- Tool failures must return bounded errors, not raw stack traces.
- Fixture replay should use a fake registry with recorded results.
- MCP adapters should expose MCP tools through this registry instead of leaking MCP SDK shapes into agents.

## Schema And Validation Strategy

Use Zod as the internal schema authoring format for TypeScript packages.

Use JSON Schema as the interchange format for:

- Provider tool schemas.
- Preview form generation.
- Fixture validation.
- Docs.
- Cross-language consumers.

Recommended pattern:

```ts
import { z } from 'zod';

export const RecommendationInputSchema = z.object({
  diagnosis: z.string(),
  evidence: z.array(z.string()),
  availableActions: z.array(z.string()).optional(),
});

export type RecommendationInput = z.infer<typeof RecommendationInputSchema>;
```

Schema rules:

- Every exported capability has input and output schemas.
- Parse inputs at capability boundaries.
- Parse model/tool outputs before returning from `run()`.
- Version schemas when breaking fields change.
- Keep provider schemas generated from canonical package schemas, not duplicated by hand.

## Streaming And Trace Semantics

Default `run()` returns the final typed output.

Use `context.trace` for progress updates that do not need backpressure. Use optional `runStream()` for consumers that need a stream they can iterate over.

Rules:

- `run()` must work without streaming.
- `runStream()` must emit the same event shapes used by `context.trace`.
- The final stream item should be the typed output or a `done` event containing it.
- Preview UI should use fixture replay first and live streaming second.
- Streaming APIs must support cancellation through `AbortSignal`.
- Streamed text is not a stable output contract; typed final output is.

## Package Boundaries

The library should separate stable capability logic from app-specific wiring.

```txt
aptkit/
+-- apps/
|   +-- studio/              # portfolio display app: catalog, playground, traces, evals
|   +-- playground/          # lightweight manual runs and fixture replay
+-- packages/
|   +-- runtime/             # run context, trace events, agent loop primitives
|   +-- agents/              # extracted focused agents
|   +-- workflows/           # orchestration of multiple capabilities
|   +-- tools/               # callable tool abstractions and adapters
|   +-- prompts/             # prompt packages
|   +-- utilities/           # JSON extraction, markdown chunking, title cleanup
|   +-- context/             # workspace descriptors, schema summaries, context builders
|   +-- evals/               # eval runner, judges, fixture assertions
|   +-- usage/               # token usage events and host-pluggable usage ledgers
|   +-- rag/                 # retrieval components
|   +-- memory/              # reusable memory components
|   +-- providers/           # OpenAI, Anthropic, Gemini, local model adapters
|   +-- mcp/                 # MCP client, auth, validation, allowlists
|   +-- renderers/           # optional report/markdown renderers
|   +-- shared/              # types and tiny cross-package utilities
+-- examples/
|   +-- adapters/
|   |   +-- olist/           # local demo adapter from Blooming Insights
|   +-- fixtures/
|   +-- demo-scenarios/
+-- docs/
    +-- extraction-guide.md
    +-- capability-contract.md
    +-- evals.md
    +-- roadmap.md
```

Recommended mechanics:

- Use TypeScript first.
- Use `pnpm` workspaces unless an existing repo decision says otherwise.
- Use `vitest` for unit and integration tests.
- Keep live provider tests opt-in.
- Publish packages privately first.
- Prefer one package per boundary, not one package per tiny helper.

## NPM Package Strategy

Start with one npm package, then split only when dependency boundaries demand it.

Recommended initial package:

```txt
@rein/aptkit
```

Use subpath exports:

```txt
@rein/aptkit/runtime
@rein/aptkit/agents
@rein/aptkit/workflows
@rein/aptkit/tools
@rein/aptkit/prompts
@rein/aptkit/providers
@rein/aptkit/evals
@rein/aptkit/mcp
@rein/aptkit/utilities
@rein/aptkit/usage
```

Initial `package.json` direction:

```json
{
  "name": "@rein/aptkit",
  "version": "0.1.0",
  "type": "module",
  "sideEffects": false,
  "files": ["dist", "README.md", "LICENSE"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./runtime": {
      "types": "./dist/runtime/index.d.ts",
      "import": "./dist/runtime/index.js"
    },
    "./agents": {
      "types": "./dist/agents/index.d.ts",
      "import": "./dist/agents/index.js"
    },
    "./workflows": {
      "types": "./dist/workflows/index.d.ts",
      "import": "./dist/workflows/index.js"
    },
    "./tools": {
      "types": "./dist/tools/index.d.ts",
      "import": "./dist/tools/index.js"
    },
    "./prompts": {
      "types": "./dist/prompts/index.d.ts",
      "import": "./dist/prompts/index.js"
    },
    "./providers": {
      "types": "./dist/providers/index.d.ts",
      "import": "./dist/providers/index.js"
    },
    "./evals": {
      "types": "./dist/evals/index.d.ts",
      "import": "./dist/evals/index.js"
    },
    "./utilities": {
      "types": "./dist/utilities/index.d.ts",
      "import": "./dist/utilities/index.js"
    },
    "./usage": {
      "types": "./dist/usage/index.d.ts",
      "import": "./dist/usage/index.js"
    }
  },
  "peerDependencies": {
    "zod": "^4.0.0"
  },
  "optionalDependencies": {
    "@anthropic-ai/sdk": "^0.99.0",
    "openai": "^6.0.0"
  }
}
```

Package rules:

- Build ESM first.
- Emit `.d.ts` type declarations.
- Keep provider SDKs optional unless the adapter is imported.
- Do not run network calls at import time.
- Keep examples runnable with fake providers.
- Avoid exporting source-project paths or app-specific types.
- Treat prompt, schema, and output shape changes as semver-significant.

If the package grows too large, split later into:

```txt
@rein/aptkit-runtime
@rein/aptkit-agents
@rein/aptkit-tools
@rein/aptkit-providers
@rein/aptkit-evals
@rein/aptkit-mcp
@rein/aptkit-prompts
@rein/aptkit-usage
```

## Runtime Compatibility Matrix

Every package should declare where it is expected to run.

| Package Area | Node.js | Browser | Edge Runtime | React Native | Notes |
| --- | --- | --- | --- | --- | --- |
| `runtime` | Yes | Yes | Yes | Yes | No Node-only APIs. |
| `agents` | Yes | Partial | Partial | Partial | Works anywhere if provider/tool dependencies work. |
| `providers/anthropic` | Yes | No by default | Maybe | No by default | Server-side recommended because of API keys. |
| `providers/openai` | Yes | No by default | Maybe | No by default | Server-side recommended because of API keys. |
| `tools` | Yes | Partial | Partial | Partial | Depends on tool implementation. |
| `prompts` | Yes | Yes | Yes | Yes | Pure prompt builders, schemas, and parsers only. |
| `utilities` | Yes | Yes | Yes | Yes | Pure JSON, markdown, and text utilities only. |
| `usage` | Yes | Yes | Yes | Yes | Core interfaces are portable; persistence is host-provided. |
| `mcp` | Yes | No | Maybe | No | Depends on transport and auth flow. |
| `evals` | Yes | No | No | No | Node scripts and fixture runners. |
| `web/playground` | Yes | Browser UI | Maybe | No | App layer, not library core. |

Compatibility rules:

- `runtime` must not import provider SDKs.
- Provider adapters must stay out of browser bundles unless explicitly imported.
- Server-only adapters must document that they are server-only.
- React Native support should come from portable runtime types first, not from forcing every provider to work on mobile.

## Extraction Scoring Rubric

Score each candidate from 1 to 5 for each dimension.

| Dimension | 1 | 3 | 5 |
| --- | --- | --- | --- |
| Reuse value | One-off app behavior | Useful in similar apps | Useful across many projects |
| Testability | Needs live service | Can mock most dependencies | Runs fully from fixtures |
| Coupling | Tied to route/UI/database | Some adapter work needed | Already mostly isolated |
| Contract clarity | Freeform input/output | Partially typed | Typed schema and examples |
| Portfolio value | Hard to explain | Useful but narrow | Demo-friendly and impressive |
| Extraction risk | Behavior likely to change | Some regression risk | Low-risk isolated move |

Recommended extraction order:

1. High reuse value.
2. High testability.
3. Low coupling.
4. Strong portfolio value.

Do not extract a capability only because it has AI in it. Extract it when reuse, testability, and contract clarity are good enough to justify the extra package surface.

## Maturity Model

| Level | Name | Entry Criteria | Exit Criteria |
| --- | --- | --- | --- |
| 0 | Inline model call | AI logic lives inside a route, component, script, or service. | Inputs, outputs, provider, prompts, and dependencies are documented. |
| 1 | Reusable utility | Logic is callable outside UI/framework code. | Unit tests cover deterministic behavior. |
| 2 | Tool/provider injected | Provider, tools, data sources, and logger are injected. | Runs with fake provider/tool fixtures. |
| 3 | Workflow | Multiple capabilities compose through explicit steps. | Trace events, error behavior, and fixtures are present. |
| 4 | Agent | Agent has bounded model/tool loop and typed output. | Tool limits, cancellation, structured output recovery, and evals are present. |
| 5 | Multi-agent system | Multiple agents coordinate through a workflow. | Cross-agent trace, replay, and regression evals are present. |
| 6 | Reusable package | Capability is in monorepo package. | Docs, examples, CI tests, versioning, and preview UI are complete. |

## Extraction Template

Use this for every discovered capability.

```md
## Capability: <name>

### Summary

What reusable behavior does this provide?

### Type

Agent / Workflow / Tool / Utility / Prompt / Evaluator / RAG / Memory / Provider / MCP

### Current Location

- Project:
- Files:
- Route/component/service:
- Tests:
- Fixtures:

### Current Behavior

- Inputs:
- Outputs:
- Side effects:
- Error behavior:
- Streaming/trace behavior:

### Dependencies

- Model provider:
- Tools:
- Data source:
- Environment variables:
- Network:
- Framework/runtime:
- Secrets/auth:

### Extraction Score

- Reuse value:
- Testability:
- Coupling:
- Contract clarity:
- Portfolio value:
- Extraction risk:

### Extraction Plan

1. Define input and output schemas.
2. Move pure logic behind a standalone function/class.
3. Inject provider, tools, data sources, logger, trace sink, and abort signal.
4. Add fixture-backed tests.
5. Add eval cases.
6. Add preview example.
7. Move to target package.

### Target Package

`packages/<category>/<name>/`

### Acceptance Criteria

- Runs without the source app.
- Runs against fakes or recorded fixtures.
- Has unit tests for deterministic pieces.
- Has at least three examples.
- Has at least one regression eval.
- Emits standard trace events if model/tool calls are used.
- Does not require real secrets in CI.
```

## Discovery Instructions For AI Assistants

When analyzing a project:

1. Search for model providers and SDK calls.
2. Search for prompts and structured output parsing.
3. Search for tool calls and MCP usage.
4. Search for retrieval, memory, and embedding code.
5. Search for evals, fixtures, and judge scripts.
6. Search for UI routes that expose AI behavior.
7. Identify capability boundaries before recommending extraction.
8. Preserve behavior during isolation.
9. Prefer small extractions that can be tested immediately.
10. Avoid broad framework rewrites.

Search terms:

```txt
openai
anthropic
gemini
ollama
llm
agent
workflow
tool
prompt
systemPrompt
completion
chat.completions
responses.create
generateText
streamText
embedding
retrieve
memory
rag
evaluate
classify
extract
analyze
recommend
schema
parse
json
mcp
tool_use
```

## Testing And Eval Strategy

### Unit Tests

Use for deterministic logic:

- Schema validation.
- Prompt rendering.
- Parser behavior.
- JSON extraction and repair.
- Output normalization.
- Tool allowlist checks.
- Trace event formatting.

### Fixture Integration Tests

Use for full capability execution without live network:

- Fake model provider returns recorded model responses.
- Fake tool registry returns recorded tool results.
- Capability emits expected trace events.
- Malformed input returns useful errors.
- Tool failure produces bounded fallback behavior.
- Cancellation aborts cleanly.

### Live Integration Tests

Use only when explicitly enabled by environment variables.

Required behavior:

- Skipped by default in CI.
- Redacts secrets from logs.
- Records token usage and cost estimate.
- Has timeouts.
- Does not mutate external systems unless the test is explicitly marked write-path.

### Eval Tests

Each agent or workflow should have evals for:

- Schema compliance.
- Grounding in supplied evidence.
- Unsupported claim avoidance.
- Useful recommendation/action quality.
- Uncertainty handling.
- Regression against known good fixtures.

Use deterministic assertions first. Use model-judged evals only when deterministic checks cannot capture the quality dimension.

## Security And Fixture Hygiene

Every extracted capability must respect these rules:

- No real API keys in fixtures, examples, tests, or logs.
- No raw customer data in public examples.
- Sanitize provider responses before committing fixtures.
- Tool calls must go through allowlists when tools touch external systems.
- Write-path tools must be disabled by default.
- Prompt and trace exports must redact secrets and PII.
- Live evals must require explicit opt-in.
- Package examples should run with fake providers by default.

## Preview Requirement

Every Level 6 capability should have a preview page or playground entry.

The preview should include:

- Name.
- Description.
- Capability type.
- Input form.
- Example selector.
- Fixture replay mode.
- Live run mode when configured.
- Output preview.
- Raw structured output.
- Trace timeline.
- Tool calls and errors.
- Eval result summary.

The preview is not the source of truth. It is a thin UI over the package contract.

## AptKit Studio

AptKit Studio is the portfolio-facing UI for the library.

The package proves reuse. Studio proves understanding by making every capability inspectable: input, intermediate state, provider routing, tool calls, retries, evals, and final typed output.

Studio should be built after the core runtime and first capabilities are real enough to visualize.

Core screens:

- Capability catalog: agents, workflows, tools, prompts, providers, evals, utilities.
- Live playground: run a capability with fixture inputs by default and live provider mode when configured.
- Trace timeline: model calls, tool calls, retries, JSON repair, usage events, warnings, and final output.
- Workflow visualizer: DSA-style graph where nodes light up as `input -> monitor -> diagnose -> recommend -> output`.
- Eval dashboard: golden fixtures, structural diffs, pass/fail status, judge scores, and regression summaries.
- Provider routing demo: local-first, cloud fallback, Anthropic/OpenAI fallback, exact vs estimated token usage.
- Prompt package viewer: full prompt, compact/local prompt, input schema, output schema, examples, and parser tests.
- Extraction story view: source project module -> agnostic AptKit capability -> package import example.

Portfolio demo rules:

- Fixture mode is the default so the public demo works without API keys.
- Live mode is opt-in and hidden or disabled unless credentials are configured.
- The most impressive first demo is the `detect -> investigate -> recommend` workflow with graph visualization, streaming trace, tool-call drawer, typed JSON output, eval panel, and token/cost meter.
- Studio should avoid marketing-only pages. The first screen should be the usable catalog/playground.
- The UI should make AptKit feel like a DSA visualizer for AI systems: show the algorithmic shape of model calls, tool use, validation, fallback, and evaluation.

## Consumer Usage Examples

### Node Script

```ts
import { recommendationAgent } from '@rein/aptkit/agents';
import { createAnthropicProvider } from '@rein/aptkit/providers';

const result = await recommendationAgent.run(
  {
    diagnosis: 'Refund rate rose after a sizing chart change.',
    evidence: ['Refund comments mention size mismatch.', 'Spike started June 10.'],
  },
  {
    model: createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
  },
);

console.log(result);
```

### Next.js Route

```ts
import { NextResponse } from 'next/server';
import { recommendationAgent } from '@rein/aptkit/agents';
import { createAnthropicProvider } from '@rein/aptkit/providers';

export async function POST(req: Request) {
  const input = await req.json();
  const result = await recommendationAgent.run(input, {
    model: createAnthropicProvider({ apiKey: process.env.ANTHROPIC_API_KEY }),
    signal: req.signal,
  });

  return NextResponse.json(result);
}
```

### Test With Fake Provider

```ts
import { describe, expect, it } from 'vitest';
import { recommendationAgent } from '@rein/aptkit/agents';
import { createFakeProvider } from '@rein/aptkit/providers/fake';

it('returns structured recommendations', async () => {
  const model = createFakeProvider([
    {
      text: '{"recommendations":[{"title":"Fix size chart","priority":"high"}]}',
    },
  ]);

  const result = await recommendationAgent.run(
    { diagnosis: 'Sizing-related refund spike.', evidence: ['Refund comments mention fit.'] },
    { model },
  );

  expect(result.recommendations[0].priority).toBe('high');
});
```

### Fixture Replay

```ts
import { replayFixture } from '@rein/aptkit/evals';
import { recommendationAgent } from '@rein/aptkit/agents';

await replayFixture(recommendationAgent, './fixtures/recommendation-sizing-spike.json');
```

## MVP Milestone

The first useful milestone is a single extracted, previewable capability from `blooming_insights`.

Recommended MVP:

1. Create the monorepo skeleton.
2. Add `packages/runtime` with:
   - capability types,
   - run context,
   - trace event contract,
   - bounded agent/tool loop extracted from `blooming_insights/lib/agents/base.ts`.
3. Add `packages/tools` with:
   - tool registry interface,
   - allowlist validation,
   - fake tool registry for tests.
4. Add `packages/providers/fake` and `packages/providers/anthropic` with:
   - fake scripted responses for tests,
   - Anthropic adapter behind `ModelProvider`,
   - no direct provider SDK imports from agents.
5. Add `packages/context` with:
   - generic workspace descriptor,
   - token-bounded schema summary helpers,
   - no Bloomreach/Olist-specific bootstrap code.
6. Add `packages/agents/recommendation` with:
   - extracted recommendation prompt,
   - typed input/output,
   - fixture-backed tests,
   - one eval.
7. Add `apps/playground` or `apps/web` page for:
   - fixture replay,
   - live run when `ANTHROPIC_API_KEY` is configured,
   - trace timeline.
8. Document the extraction in `docs/extraction-guide.md`.

MVP definition of done:

- `pnpm test` passes without network.
- Recommendation capability runs outside `blooming_insights`.
- No source app imports remain in the package.
- No package API mentions Bloomreach, Olist, Next.js, or MCP unless it is an adapter/example package.
- At least three fixtures exist.
- At least one regression eval exists.
- Preview can run from fixtures without secrets.

## Roadmap

### Phase 1: Discovery

Deliverables:

- `docs/capability-inventory.md`
- `docs/blooming-insights-extraction-map.md`
- `docs/dryrun-extraction-map.md`
- Completed extraction templates for P0 and P1 candidates.
- Decision on package manager and monorepo tooling.

### Phase 2: Isolation In Source Projects

Deliverables:

- Source project logic separated from UI/routes where needed.
- Provider, tools, data sources, logger, trace sink, and abort signal injected.
- Source project tests still pass.

### Phase 3: Runtime And Contract

Deliverables:

- `packages/runtime`
- `packages/tools`
- `packages/context`
- Shared capability contract.
- Trace event contract.
- Fake model provider and fake tool registry.

### Phase 4: First Extracted Capability

Deliverables:

- `packages/agents/recommendation`
- Fixtures.
- Tests.
- Eval.
- Preview entry.

### Phase 5: Workflow Extraction

Deliverables:

- Monitoring, diagnostic, and recommendation agents extracted.
- Detect -> investigate -> recommend workflow package.
- Cross-agent trace and replay.

### Phase 6: Package Hardening

Deliverables:

- CI.
- Docs.
- Examples.
- Versioning.
- Private package publishing.
- Export map and type declaration checks.
- Install test in a separate sample project.

### Phase 7: Broader Library

Deliverables:

- Provider adapters.
- MCP package.
- Eval package.
- RAG and memory components if real projects justify them.

### Phase 8: AptKit Studio

Deliverables:

- `apps/studio` portfolio app.
- Capability catalog powered by package metadata.
- Fixture replay playground for every Level 6 capability.
- Live run mode gated by environment configuration.
- DSA-style workflow visualizer for multi-step agents and workflows.
- Trace timeline for model calls, tool calls, retries, validation, usage, and errors.
- Eval dashboard for golden fixtures, structural diffs, judge scores, and regression summaries.
- Provider routing visualization for local-first and cloud fallback chains.
- Prompt package viewer with full prompt, compact prompt, schemas, examples, and parser tests.
- Public demo dataset with sanitized fixtures from Blooming Insights and Dryrun patterns.

## Release And Versioning Workflow

Use Changesets for versioning and changelog generation once packages are published.

Recommended flow:

1. Develop against workspace packages.
2. Run unit, fixture, eval, type, lint, and build checks.
3. Run an install test in a separate temp/sample app.
4. Add a changeset for public API, schema, prompt, or behavior changes.
5. Publish privately first.
6. Promote to public only after package docs and examples are stable.

Semver rules:

- Major: breaking input schema, output schema, exported type, package export, or behavior contract change.
- Minor: new capability, new optional field, new provider adapter, or backward-compatible eval.
- Patch: bug fix, prompt improvement that preserves output contract, fixture update, docs fix.

Prompt versioning rules:

- Prompts that affect structured output quality are part of the capability version.
- Prompt-only behavior changes should still get regression evals.
- Keep old fixtures when changing prompts so regressions are visible.

Release checks:

- `pnpm test`
- `pnpm typecheck`
- `pnpm build`
- fixture replay
- live-provider smoke tests only when credentials are explicitly configured
- package install/import test from a clean project

## Definition Of Done For A Capability

A capability is done when it is:

- Discoverable in the catalog.
- Runnable outside the source app.
- Typed at input and output boundaries.
- Tested without network.
- Covered by at least one eval if model output quality matters.
- Equipped with sanitized examples and fixtures.
- Observable through the standard trace contract.
- Explicit about provider, tool, environment, and data dependencies.
- Safe by default with no real secrets required.
- Previewable from fixture data.
- Documented with import and usage examples.
- Exported from a stable package path.
- Verified by an install/import test when published.

## Relationship To Earlier Agent Plan

`agent-toolbox-plan.md` is the narrower ancestor focused on agents. This plan supersedes it for library work.

Keep useful material from the older plan:

- The agent contract shape.
- The preview requirement.
- The testing strategy.
- The ecommerce anomaly workflow example.

But use this document as the operational source of truth because it includes non-agent capabilities, extraction scoring, package boundaries, eval mechanics, security rules, and concrete first milestones.

## Success Criteria

AptKit succeeds when new projects can import tested, previewable capabilities instead of copying app-specific AI code.

Near-term success:

- One real capability extracted from `blooming_insights`.
- It runs with fake providers and fixtures.
- It has a preview.
- It has an eval.
- It has a documented contract.

Long-term success:

- Reusable TypeScript packages.
- A catalog of agents, workflows, tools, prompts, evals, providers, and MCP integrations.
- AptKit Studio displays and explains those capabilities through fixture replay, traces, workflow graphs, and eval dashboards.
- Stable examples that demonstrate AI product engineering beyond chat UI.
