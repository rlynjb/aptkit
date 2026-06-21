# `@rlynjb/aptkit-core` — API Reference

Developer reference for the published AptKit core bundle. The package is a single npm install that re-exports 15 internal AptKit packages (runtime, tools, context, prompts, evals, workflows, retrieval, two providers, and six prebuilt agents) under one flat ESM entry point.

This is a lookup reference, not a tutorial. Signatures are taken from source; file paths are cited where useful (paths are relative to the AptKit monorepo, under `packages/`).

---

## 1. Install & import

```bash
npm install @rlynjb/aptkit-core
```

- Node ≥ 20.
- ESM only. The package sets `"type": "module"` and ships `exports.import` / `exports.types` — there is no CommonJS build. Use `import`, not `require`.
- Everything is exported from the single root entry; there are no subpath imports.

```ts
import {
  RagQueryAgent,
  GemmaModelProvider,
  ContextWindowGuardedProvider,
  InMemoryVectorStore,
  OllamaEmbeddingProvider,
  createRetrievalPipeline,
  createSearchKnowledgeBaseTool,
  InMemoryToolRegistry,
} from '@rlynjb/aptkit-core';
```

> A few exported names collide across internal packages and are re-aliased at the bundle boundary (see `packages/core/src/index.ts`). The notable aliases: `Anomaly` is exported as `MonitoringAnomaly` and `DiagnosticAnomaly`; `Diagnosis` as `DiagnosticDiagnosis`; the query `Intent` as `QueryIntent`; rubric types as `ImprovementRubricDefinition` / `ImprovementRubricJudgment`. Type names referenced in this doc use the **internal** names unless noted; if a name clashes, prefer the aliased export.

---

## 2. Quick start — local RAG agent

Builds a Retrieval-Augmented-Generation agent entirely against local services. **Requires a running [Ollama](https://ollama.com) instance** (`http://localhost:11434` by default) with both an embedding model (`nomic-embed-text`) and a chat model (`gemma2:9b`) pulled.

```ts
import {
  OllamaEmbeddingProvider,
  InMemoryVectorStore,
  createRetrievalPipeline,
  createSearchKnowledgeBaseTool,
  InMemoryToolRegistry,
  GemmaModelProvider,
  ContextWindowGuardedProvider,
  RagQueryAgent,
} from '@rlynjb/aptkit-core';

const embedder = new OllamaEmbeddingProvider();               // nomic-embed-text, dim 768
const store = new InMemoryVectorStore(embedder.dimension);
const pipeline = createRetrievalPipeline({ embedder, store });

await pipeline.index({ id: 'doc-1', text: 'AptKit ships local-first LLM agents.' });

const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });

const model = new ContextWindowGuardedProvider(new GemmaModelProvider(), { maxTokens: 8192 });
const agent = new RagQueryAgent({ model, tools });

console.log(await agent.answer('What does AptKit ship?'));
```

The agent never touches the pipeline directly: you wrap the pipeline as a `search_knowledge_base` tool, register the tool, and hand the registry to the agent. This mirrors `packages/agents/rag-query/scripts/ask.ts`.

---

## 3. Core contracts (swap seams)

These four object types are the extension points. Implement them to bring your own model, vector store, embedder, or tool source.

### `ModelProvider` — `packages/runtime/src/model-provider.ts`

```ts
type ModelProvider = {
  id: string;
  defaultModel?: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};
```

It is a `type`, not an `interface`. `id` and `defaultModel` are part of the contract alongside `complete`.

### `VectorStore` — `packages/retrieval/src/contracts.ts`

```ts
type VectorStore = {
  dimension: number;
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
```

### `EmbeddingProvider` — `packages/retrieval/src/contracts.ts`

```ts
type EmbeddingProvider = {
  id: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
};
```

### `ToolRegistry` — `packages/tools/src/tool-registry.ts`

```ts
type ToolRegistry = {
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<ToolCallResult>;
};
```

`InMemoryToolRegistry` is the bundled implementation (§7).

---

## 4. Runtime

`packages/runtime/src/`. The agent execution kernel.

### Model wire types — `model-provider.ts`

```ts
type ModelTextBlock      = { type: 'text'; text: string };
type ModelToolUseBlock   = { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
type ModelToolResultBlock= { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };
type ModelContentBlock   = ModelTextBlock | ModelToolUseBlock;          // note: excludes tool_result

type ModelMessage = {
  role: 'user' | 'assistant';
  content: string | ModelContentBlock[] | ModelToolResultBlock[];
};

type ModelTool = { name: string; description?: string; inputSchema: object };

type ModelUsage = { inputTokens?: number; outputTokens?: number; estimated?: boolean };

type ModelRequest = {
  system?: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

type ModelResponse = { content: ModelContentBlock[]; usage?: ModelUsage; model?: string };
```

### `runAgentLoop` — `run-agent-loop.ts`

The tool-calling loop used by every prebuilt agent.

```ts
function runAgentLoop<T = null>(options: RunAgentLoopOptions<T>): Promise<AgentRunResult<T>>;

type AgentRunResult<T = null> = {
  finalText: string;
  toolCalls: ToolCallRecord[];
  parsed: T | null;
};
```

`RunAgentLoopOptions<T>`:

| Field | Type | Required | Notes |
|---|---|---|---|
| `capabilityId` | `string` | yes | Tag for trace events |
| `model` | `ModelProvider` | yes | |
| `tools` | `ToolExecutor` | yes | See below |
| `system` | `string` | yes | System prompt |
| `userPrompt` | `string` | yes | |
| `toolSchemas` | `ModelTool[]` | yes | Schemas advertised to the model |
| `trace` | `CapabilityTraceSink` | no | |
| `maxTurns` | `number` | no | Default `8` |
| `maxTokens` | `number` | no | Default `4096` |
| `maxToolCalls` | `number` | no | |
| `synthesisInstruction` | `string` | no | Final-answer nudge |
| `signal` | `AbortSignal` | no | |
| `parseResult` | `(finalText: string) => T \| null` | no | Populates `parsed` |
| `recoveryPrompt` | `(toolCalls: ToolCallRecord[]) => string` | no | |

```ts
type ToolExecutor = {
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }):
    Promise<{ result: unknown; durationMs: number }>;
};
type ToolCallRecord = {
  id: string; capabilityId: string; toolName: string;
  args: Record<string, unknown>; result?: unknown; durationMs?: number; error?: string;
};

function buildSynthesisInstruction(middle: string): string;
```

`ToolRegistry` satisfies `ToolExecutor` (both expose a compatible `callTool`).

### `generateStructured` — `structured-generation.ts`

One-shot validated JSON generation with retry (no tool loop).

```ts
function generateStructured<T>(options: GenerateStructuredOptions<T>):
  Promise<StructuredGenerationResult<T>>;

type GenerateStructuredOptions<T> = {
  capabilityId: string;
  model: ModelProvider;
  validate: JsonValidator<T>;          // (value: unknown) => { ok: true; value: T } | { ok: false; error: string }
  system?: string;
  messages?: ModelMessage[];
  userPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  retry?: { maxAttempts?: number; strictSuffix?: string };
  trace?: CapabilityTraceSink;
  signal?: AbortSignal;
};

type StructuredGenerationResult<T> =
  | { ok: true;  value: T; rawText: string; attempts: StructuredGenerationAttempt[] }
  | { ok: false; error: string; attempts: StructuredGenerationAttempt[] };
```

### JSON parsing — `json-output.ts`

```ts
type JsonValidation<T> = { ok: true; value: T } | { ok: false; error: string };
type JsonValidator<T>  = (value: unknown) => JsonValidation<T>;

function parseAgentJson(text: string): unknown;                       // strips fences/prose, parses
function parseValidatedJson<T>(text: string, validate: JsonValidator<T>): JsonValidation<T>;
```

### Trace events — `events.ts`

```ts
type CapabilityEvent =
  | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
  | { type: 'tool_call_start'; capabilityId: string; toolName: string; args: unknown; timestamp: string }
  | { type: 'tool_call_end'; capabilityId: string; toolName: string; result?: unknown; error?: string; durationMs: number; timestamp: string }
  | { type: 'model_usage'; capabilityId: string; provider: string; model: string; inputTokens?: number; outputTokens?: number; estimated?: boolean; timestamp: string }
  | { type: 'warning'; capabilityId: string; message: string; timestamp: string }
  | { type: 'error'; capabilityId: string; message: string; timestamp: string };

type CapabilityTraceSink = { emit(event: CapabilityEvent): void };
```

Pass any object with an `emit` method as `trace` to a provider, agent, or `runAgentLoop` to capture the run.

### Cost & usage — `usage-ledger.ts`

```ts
function summarizeUsage(trace: readonly CapabilityEvent[]): TokenUsageSummary;
function estimateCost(
  provider: string,
  usage: { inputTokens: number; outputTokens: number },   // 2nd arg
  modelName: string,                                       // 3rd arg
): CostEstimate | undefined;
function pricingForModel(provider: string, modelName: string): UsagePricing | undefined;
function formatCost(costEstimate: CostEstimate | undefined): string;
```

`summarizeUsage` sums `model_usage` events from a trace. `pricingForModel` / `estimateCost` only carry a built-in price table for `provider === 'openai'` (gpt-4.1 family) and return `undefined` otherwise — local Gemma runs report token counts but no dollar cost.

---

## 5. Providers

The bundle is **local-first**. It ships exactly two providers:

- `GemmaModelProvider` — local Ollama chat with emulated tool-calling.
- `ContextWindowGuardedProvider` — a wrapper that rejects oversized requests.

> The bundle does **not** include Anthropic or OpenAI providers. Those are separate, unbundled packages outside `@rlynjb/aptkit-core`. To use a hosted model with this package, implement the `ModelProvider` contract (§3) yourself and pass your instance wherever a `model` is required.

### `GemmaModelProvider` — `packages/providers/gemma/src/gemma-provider.ts`

```ts
class GemmaModelProvider implements ModelProvider {
  readonly id = 'gemma';
  readonly defaultModel: string;                 // = options.model ?? 'gemma2:9b'
  constructor(options?: GemmaModelProviderOptions);
  complete(request: ModelRequest): Promise<ModelResponse>;
}

type GemmaModelProviderOptions = {
  model?: string;              // default 'gemma2:9b'
  host?: string;               // default 'http://localhost:11434'
  chat?: GemmaChatTransport;   // override the HTTP transport (testing)
  maxToolCallAttempts?: number;// default 2 (min 1)
};
```

Requires a running Ollama with the chat model pulled. Gemma has no native tool API, so the provider **emulates tool-calling**: it renders each advertised tool into the system prompt and asks for a JSON reply `{"tool": "<name>", "arguments": {...}}`, retrying up to `maxToolCallAttempts` on malformed output before accepting prose as the final answer. Usage is reported with `estimated: false` from Ollama's `prompt_eval_count` / `eval_count`.

### `ContextWindowGuardedProvider` — `packages/providers/local/src/context-window-guard.ts`

Wraps any `ModelProvider` and throws before sending a request that would overflow the context window. Mirrors the inner provider's `id` / `defaultModel`.

```ts
class ContextWindowGuardedProvider implements ModelProvider {
  constructor(provider: ModelProvider, options: ContextWindowGuardOptions);
  complete(request: ModelRequest): Promise<ModelResponse>;
}

type ContextWindowGuardOptions = {
  maxTokens: number;          // required
  outputReserve?: number;     // default 768
  charsPerToken?: number;     // default 3
  capabilityId?: string;      // default 'local-context-guard'
  trace?: CapabilityTraceSink;
};

class ContextWindowExceededError extends Error { readonly estimate: ContextWindowEstimate; }

function estimateContextWindow(
  request: ModelRequest,
  options: Pick<ContextWindowGuardOptions, 'maxTokens' | 'outputReserve' | 'charsPerToken'>,
): ContextWindowEstimate;
function estimateModelRequestTokens(request: ModelRequest, charsPerToken?: number): number;  // default 3
function estimateTextTokens(text: string, charsPerToken?: number): number;                   // default 3
```

On overflow `complete` emits a `warning` trace event and throws `ContextWindowExceededError` (carrying the `ContextWindowEstimate`) instead of calling the inner provider.

---

## 6. Retrieval (RAG)

`packages/retrieval/src/`.

### Pipeline — `pipeline.ts`

```ts
type RetrievalDocument = { id: string; text: string; meta?: Record<string, unknown> };
type RetrievalWiring   = { embedder: EmbeddingProvider; store: VectorStore };

type RetrievalPipeline = {
  embedder: EmbeddingProvider;
  store: VectorStore;
  index(doc: RetrievalDocument): Promise<void>;
  query(query: string, topK?: number): Promise<VectorHit[]>;   // default topK 5
};

function createRetrievalPipeline(wiring: RetrievalWiring): RetrievalPipeline;  // throws on dim mismatch

// Standalone equivalents (no pipeline object):
function indexDocument(doc: RetrievalDocument, wiring: RetrievalWiring): Promise<void>;
function queryKnowledgeBase(query: string, wiring: RetrievalWiring, topK?: number): Promise<VectorHit[]>;
```

`index` chunks the document, embeds each chunk, and upserts with ids `${doc.id}#${i}` and meta `{ ...doc.meta, docId, chunkIndex, text }`.

### Vector store — `in-memory-vector-store.ts` / `contracts.ts`

```ts
type VectorChunk = { id: string; vector: number[]; meta: Record<string, unknown> };
type VectorHit   = { id: string; score: number; meta: Record<string, unknown> };

class InMemoryVectorStore implements VectorStore {
  readonly dimension: number;
  constructor(dimension: number);
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;   // cosine similarity ranking
}
```

### Embedding provider — `ollama-embedding-provider.ts`

```ts
class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'nomic-embed-text';
  readonly dimension = 768;
  constructor(options?: OllamaEmbeddingProviderOptions);
  embed(texts: string[], options?: { signal?: AbortSignal }): Promise<number[][]>;
}

type OllamaEmbeddingProviderOptions = {
  model?: string;          // default 'nomic-embed-text'
  host?: string;           // default 'http://localhost:11434'
  embed?: EmbedTransport;  // override HTTP transport (testing)
};
```

Requires a running Ollama with the embedding model pulled. `id` and `dimension` are fixed (768).

### `search_knowledge_base` tool — `search-knowledge-base-tool.ts`

```ts
const SEARCH_KNOWLEDGE_BASE_TOOL_NAME = 'search_knowledge_base';

function createSearchKnowledgeBaseTool(
  pipeline: RetrievalPipeline,
  options?: SearchKnowledgeBaseToolOptions,
): { definition: ToolDefinition; handler: ToolHandler };

type SearchKnowledgeBaseToolOptions = {
  defaultTopK?: number;   // top_k when caller omits it. Default 5
  minTopK?: number;       // floor on top_k even if the model asks for fewer. Default 1
};
```

Effective `topK = max(requestedTopK, max(1, minTopK ?? 1))`. Register the returned `definition` + `handler` in a `ToolRegistry` (§7) and pass that registry to an agent.

### Chunker — `chunker.ts`

```ts
const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 64;
function chunkText(text: string, size?: number, overlap?: number): string[];   // defaults to the constants
```

---

## 7. Tools & policy

`packages/tools/src/`.

```ts
type ToolDefinition = ModelTool;                                   // { name; description?; inputSchema }
type ToolCallResult = { result: unknown; durationMs: number };
type ToolHandler = (args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown> | unknown;

class InMemoryToolRegistry implements ToolRegistry {
  constructor(definitions: ToolDefinition[], handlers: Record<string, ToolHandler>);
  listTools(): ToolDefinition[];
  callTool(name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<ToolCallResult>;
}
```

### Policy — `tool-policy.ts`

```ts
type ToolPolicy = { capabilityId: string; allowedTools: readonly string[] };

function filterToolsForPolicy(allTools: readonly ToolDefinition[], policy: ToolPolicy): ModelTool[];
```

Each prebuilt agent exports a `*ToolPolicy` (§10). Use `filterToolsForPolicy` to whittle a broad tool catalog down to the set an agent is allowed to call.

### Coverage helpers — `coverage-gate.ts`

```ts
function schemaCapabilities(source: CapabilityDescriptorSource): Set<string>;
function coverageReport(
  requirements: readonly CoverageRequirement[],
  capabilities: ReadonlySet<string>,
): CoverageReportItem[];   // each item: { category; label; coverage: 'full'|'limited'|'unavailable'; missing? }
```

---

## 8. Prompts & context

### Prompts — `packages/prompts/src/`

```ts
function renderPromptTemplate(template: string, variables: Record<string, string>): string;  // substitutes {name} tokens

type PromptPackage = {
  id: string; version: string; capabilityId: string; description: string;
  system: string; compactSystem?: string;
  variables: PromptVariable[]; examples: PromptExample[];
};
```

Per-agent prompt packages exported (each a `PromptPackage`): `queryPromptPackage`, `monitoringPromptPackage`, `diagnosticPromptPackage`, `recommendationPromptPackage`.

### Context — `packages/context/src/`

```ts
function injectProfile(systemTemplate: string, profileText: string, opts?: {
  position?: 'start' | 'end';   // default 'start'
  heading?: string;
}): string;

function schemaSummary(workspace: WorkspaceDescriptor, options?: WorkspaceSummaryOptions): string;
```

`WorkspaceDescriptor` (required by the four analytics agents) — `workspace-descriptor.ts`:

```ts
type WorkspaceDescriptor = {
  projectId: string;
  projectName: string;
  events: { name: string; properties: string[]; eventCount: number }[];
  customerProperties: string[];
  catalogs: { id?: string; name: string }[];
  totalCustomers: number;
  totalEvents: number;
  oldestTimestamp: number | null;
  dataHorizon?: { from: string; to: string; durationDays: number };
};
```

---

## 9. Evals

`packages/evals/src/`. See `docs/studio.md` for the end-to-end eval workflow (fixture replay + the Studio eval panels); the functions below are the building blocks.

### Retrieval scoring — `precision-at-k.ts`

```ts
type RetrievalScoreResult = { ok: boolean; score: number; matched: number; total: number };
function scorePrecisionAtK(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): RetrievalScoreResult;
function scoreRecallAtK(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): RetrievalScoreResult;
```

`relevantIds` is a `ReadonlySet<string>`, not an array.

### LLM rubric judge — `rubric-judge.ts`

```ts
class RubricJudge {
  constructor(options: RubricJudgeOptions);   // { model; rubric; capabilityId?; maxTokens?; temperature?; trace? }
  judge(input: RubricJudgeInput, options?: { signal?: AbortSignal }): Promise<StructuredGenerationResult<RubricJudgment>>;
}
function buildRubricJudgeSystemPrompt(rubric: RubricDefinition): string;
function buildRubricJudgeUserPrompt(input: RubricJudgeInput): string;
function createRubricJudgmentValidator(rubric: RubricDefinition): (value: unknown) => JsonValidation<RubricJudgment>;
```

`RubricJudgeInput = { subject: string; context?: Record<string, string> }`. A `RubricJudgment` carries per-dimension scores, an optional checks map, a `verdict`, and a `fix`.

### Structural diff — `structural-diff.ts`

```ts
type StructuralDiffRule =
  | { type: 'required'; path: string; message? }
  | { type: 'equals'; path: string; expected: unknown; message? }
  | { type: 'number'; path: string; expected: number; tolerance?: number; message? }
  | { type: 'arrayCount'; path: string; exact?: number; min?: number; max?: number; message? }
  | { type: 'containsText'; path: string; text: string; caseSensitive?: boolean; message? }
  | { type: 'arrayIncludes'; path: string; value: unknown; itemPath?: string; message? };

function evaluateStructuralDiff(value: unknown, rules: readonly StructuralDiffRule[]):
  { ok: boolean; issues: { path: string; message: string }[] };
```

### Detection scoring — `detection-scorer.ts`

```ts
type DetectionScoreResult = { ok: boolean; score: number; matched: string[]; missed: string[]; unexpected: string[]; issues: StructuralIssue[] };
function scoreDetections(detections: readonly DetectionLike[], expectations?: DetectionExpectations): DetectionScoreResult;
```

### Shape assertions — `assertions.ts`

Each takes `(output: unknown)` and returns `EvalAssertionResult` (`{ name; ok; issues }`), synchronously:

`assertRecommendationShape`, `assertAnomalyShape`, `assertQueryAnswerShape`, `assertDiagnosticShape`, `assertReplayArtifactShape`, `assertCapabilityReplayArtifactShape`, `assertMonitoringReplayArtifactShape`, `assertDiagnosticReplayArtifactShape`, `assertQueryReplayArtifactShape`.

> Replay-runner functions (`evaluateReplayArtifact`, `evaluateReplayArtifactFiles`, `listReplayArtifacts`) live behind the `@aptkit/evals/replay-runner` subpath in the source monorepo and are **not** part of the flattened `@rlynjb/aptkit-core` root export.

---

## 10. Prebuilt agents

`packages/agents/*`. All agents share the option shape `{ model: ModelProvider; tools: ToolRegistry; trace?: CapabilityTraceSink; prompt?: string }`. The four **analytics** agents additionally require `workspace: WorkspaceDescriptor`. Every run-options type carries `signal?: AbortSignal`.

| Agent class | Capability ID | Main method | Extra constructor options |
|---|---|---|---|
| `RagQueryAgent` | `rag-query-agent` | `answer(question, opts?): Promise<string>` | `profile?: string` |
| `QueryAgent` | `query-agent` | `answer(question, opts?): Promise<string>` | `workspace`; run opts add `intent?: QueryIntent` |
| `RecommendationAgent` | `recommendation-agent` | `propose(anomaly, diagnosis, opts?): Promise<Recommendation[]>` | `workspace`, `actionTaxonomy?`, `idGenerator?` |
| `AnomalyMonitoringAgent` | `anomaly-monitoring-agent` | `scan(opts?): Promise<Anomaly[]>` | `workspace`, `categories?` |
| `DiagnosticInvestigationAgent` | `diagnostic-investigation-agent` | `investigate(anomaly, opts?): Promise<Diagnosis>` | `workspace` |
| `RubricImprovementAgent` | `rubric-improvement-agent` | `improve(input, opts?): Promise<RubricImprovementResult>` | `rubric: RubricDefinition`, `toolPolicy?` |

Each agent also exports a matching tool policy: `ragQueryToolPolicy`, `queryToolPolicy`, `recommendationToolPolicy`, `anomalyMonitoringToolPolicy`, `diagnosticInvestigationToolPolicy`, `rubricImprovementToolPolicy`. Combine with `filterToolsForPolicy` (§7).

### Per-agent detail

**`RagQueryAgent`** — `packages/agents/rag-query/src/rag-query-agent.ts`
```ts
type RagQueryAgentOptions = { model: ModelProvider; tools: ToolRegistry; profile?: string; prompt?: string; trace?: CapabilityTraceSink };
type RagQueryRunOptions   = { signal?: AbortSignal };
new RagQueryAgent(options).answer(question: string, runOptions?: RagQueryRunOptions): Promise<string>;
```
`profile` (e.g. a `me.md`) is injected into the system prompt under heading "# About the person you are assisting". Allowed tool: `search_knowledge_base`.

**`QueryAgent`** — `packages/agents/query/src/query-agent.ts`
```ts
type QueryAgentOptions = { model: ModelProvider; tools: ToolRegistry; workspace: WorkspaceDescriptor; trace?: CapabilityTraceSink; prompt?: string };
type QueryRunOptions   = { intent?: QueryIntent; signal?: AbortSignal };   // QueryIntent: 'monitoring'|'diagnostic'|'recommendation', default 'diagnostic'
new QueryAgent(options).answer(question: string, runOptions?: QueryRunOptions): Promise<string>;
```
Helpers: `classifyIntent(model, query, opts?)`, `parseIntent(raw)`, `validateQueryAnswer(answer)`.

**`RecommendationAgent`** — `packages/agents/recommendation/src/recommendation-agent.ts`
```ts
type RecommendationAgentOptions = { model; tools; workspace; actionTaxonomy?; trace?; idGenerator?: () => string; prompt? };
new RecommendationAgent(options).propose(anomaly: Anomaly, diagnosis: Diagnosis, runOptions?): Promise<Recommendation[]>;  // ≤3 items
```
Validators: `isRecommendationArray`, `tryParseRecommendations`. (No `validateRecommendation`.)

**`AnomalyMonitoringAgent`** — `packages/agents/anomaly-monitoring/src/monitoring-agent.ts`
```ts
type MonitoringAgentOptions = { model; tools; workspace; categories?: readonly AnomalyCategory[]; trace?; prompt? };  // default ECOMMERCE_ANOMALY_CATEGORIES
new AnomalyMonitoringAgent(options).scan(runOptions?): Promise<Anomaly[]>;   // severity-sorted, ≤10
```
Note: class is `AnomalyMonitoringAgent` but its options type is `MonitoringAgentOptions`. Exports `ECOMMERCE_ANOMALY_CATEGORIES`, `runnableCategories`, `formatCategoryChecklist`, `validateAnomalies`, `tryParseAnomalies`.

**`DiagnosticInvestigationAgent`** — `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts`
```ts
type DiagnosticAgentOptions = { model; tools; workspace; trace?; prompt? };  // options type is DiagnosticAgentOptions
new DiagnosticInvestigationAgent(options).investigate(anomaly: Anomaly, runOptions?): Promise<Diagnosis>;
function diagnosisConfidence(diagnosis: Diagnosis): 'high' | 'medium' | 'low';
```
Validators: `validateDiagnosis`, `tryParseDiagnosis`.

**`RubricImprovementAgent`** — `packages/agents/rubric-improvement/src/rubric-improvement-agent.ts`
```ts
type RubricImprovementAgentOptions = { model; tools; rubric: RubricDefinition; trace?; toolPolicy?: ToolPolicy; prompt? };
type RubricImprovementInput  = { subject: string; context?: Record<string, string> };
type RubricImprovementResult = { judgment: RubricJudgment; weakestDimension: string; nextAction: string; nextDrill?: { prompt: string; goal: string } };
new RubricImprovementAgent(options).improve(input: RubricImprovementInput, options?): Promise<RubricImprovementResult>;  // throws if output unparseable
```
Helpers: `buildRubricImprovementSystemPrompt`, `buildRubricImprovementUserPrompt`, `validateRubricImprovementResult(rubric)` (curried factory returning the validator).

---

## Appendix: Workflows

`packages/workflows/src/`. Content-generation helpers (also re-exported from the root).

```ts
function ensureGeneratedContent<TExisting extends ExistingContentVariant, TGenerated>(
  options: EnsureGeneratedContentOptions<TExisting, TGenerated>,
): Promise<EnsureGeneratedContentResult<TExisting, TGenerated>>;
function planContentVariant(options: { /* ... */ }): ContentVariantPlan;
function splitMarkdownSections(markdown: string): MarkdownSection[];
```

`ensureGeneratedContent` regenerates per-section content variants for a source document (default target count 4) while the host owns persistence.
