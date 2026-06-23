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

The seam every model plugs into: `complete()` takes a `ModelRequest` (system prompt, messages, advertised tools) and returns a `ModelResponse` whose `content` is the provider-neutral content blocks (§4). Implement it to swap in any chat model. It is a `type`, not an `interface`. `id` and `defaultModel` are part of the contract alongside `complete`.

### `VectorStore` — `packages/retrieval/src/contracts.ts`

```ts
type VectorStore = {
  dimension: number;
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
```

Stores embedded chunks and retrieves them: `upsert` writes vectors, `search` ranks the stored chunks by similarity to a query vector and returns the top `k`. Implement it to back retrieval with a real vector database.

### `EmbeddingProvider` — `packages/retrieval/src/contracts.ts`

```ts
type EmbeddingProvider = {
  id: string;
  dimension: number;
  embed(texts: string[]): Promise<number[][]>;
};
```

Turns text into vectors. Its `dimension` must match the `VectorStore`'s `dimension` — `createRetrievalPipeline` throws on mismatch. Implement it to swap the embedding model.

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

Lists and executes the tools an agent may call: `listTools` advertises the catalog to the model, `callTool` runs one by name. Implement it to source tools from anywhere (e.g. an MCP server). `InMemoryToolRegistry` is the bundled implementation (§7).

---

## 4. Runtime

`packages/runtime/src/`. The agent execution kernel.

### Model wire types — `model-provider.ts`

The provider-neutral message and content-block format. Every provider maps its own API to and from these types, so agents and the loop never depend on a vendor SDK. A `ModelMessage` carries either plain text or an array of content blocks; `tool_use` blocks are what the model emits to call a tool, `tool_result` blocks feed the result back on the next user turn.

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

The tool-calling loop used by every prebuilt agent. It drives the model↔tool conversation: it calls the model, executes any `tool_use` blocks the model emits, feeds the results back as a new turn, and repeats until the model stops emitting tool calls or the `maxTurns` / `maxToolCalls` budget is hit (the final turn drops the tools and, if set, appends `synthesisInstruction` to force an answer). If `parseResult` is supplied it parses the final text into `parsed`, optionally retrying once via `recoveryPrompt`.

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

One-shot validated JSON generation with retry, and no tool loop. Use it when you want a single structured object from the model (not a multi-step tool conversation): it calls the model, runs `validate` on the parsed output, and re-prompts up to `retry.maxAttempts` times when validation fails.

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

`parseAgentJson` pulls JSON out of messy model output: it prefers a fenced ```json block, else scans for the first `{`/`[` to the last `}`/`]`, and throws if nothing parses. `parseValidatedJson` chains that into a `JsonValidator`, returning a typed `{ ok }` result instead of throwing.

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

The observable event stream of a run: the loop, providers, and agents emit `step`, `tool_call_start` / `tool_call_end`, `model_usage`, `warning`, and `error` events as they execute. Collect them to log, replay, or compute cost/usage. Pass any object with an `emit` method as `trace` to a provider, agent, or `runAgentLoop` to capture the run.

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

Turn a trace into token totals and (where priced) a dollar estimate: roll the run's `model_usage` events into a summary, look up per-model pricing, derive a cost, and format it for display. `summarizeUsage` sums `model_usage` events from a trace. `pricingForModel` / `estimateCost` only carry a built-in price table for `provider === 'openai'` (gpt-4.1 family) and return `undefined` otherwise — local Gemma runs report token counts but no dollar cost.

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

`packages/retrieval/src/`. Wires an `EmbeddingProvider` and a `VectorStore` into the two RAG paths: **index** (chunk a document → embed each chunk → upsert) and **query** (embed the query → search the store → return ranked hits).

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

The bundled `VectorStore`: keeps chunks in process memory and ranks `search` by cosine similarity. No persistence — good for development, tests, and small in-process corpora; swap in a real store for production.

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

The bundled `EmbeddingProvider`: embeds text locally via Ollama's `nomic-embed-text` model. Requires a running Ollama with the embedding model pulled. `id` and `dimension` are fixed (768).

### `search_knowledge_base` tool — `search-knowledge-base-tool.ts`

Wraps a pipeline's query path as a callable tool so an agent can retrieve from the knowledge base mid-conversation. `createSearchKnowledgeBaseTool` returns a `definition` (the schema the model sees) plus a `handler` (runs `pipeline.query`).

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

Splits a document's text into overlapping windows (default 512 chars, 64-char overlap) before embedding, so each chunk is small enough to embed and retrieve independently. Used by the pipeline's `index` path.

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

The bundled `ToolRegistry`: construct it with an array of tool definitions and a name→handler map, then hand it to an agent. `callTool` looks up the handler by name, runs it, and returns the result with its duration.

### Policy — `tool-policy.ts`

```ts
type ToolPolicy = { capabilityId: string; allowedTools: readonly string[] };

function filterToolsForPolicy(allTools: readonly ToolDefinition[], policy: ToolPolicy): ModelTool[];
```

Least-privilege allowlisting: a `ToolPolicy` names the tools a capability is permitted to use, and `filterToolsForPolicy` whittles a broad tool catalog down to that allowlist before the schemas are advertised to the model. Each prebuilt agent exports a `*ToolPolicy` (§10).

### Coverage helpers — `coverage-gate.ts`

Decide which capabilities are actually runnable given a workspace's schema, before spending model tokens. `schemaCapabilities` derives the set of available tokens (event names, `event.property`, `catalog:name`) from a descriptor; `coverageReport` classifies each requirement against that set as `full`, `limited`, or `unavailable` (listing what's `missing`).

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

`renderPromptTemplate` does token substitution: it replaces `{name}` placeholders in a template string with the matching values. A `PromptPackage` bundles a versioned system prompt (plus optional compact variant), its variables, and worked examples for one capability.

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

`injectProfile` prepends (or appends) a user profile — e.g. a `me.md` — into a system prompt under an optional heading, so an agent answers with the person in mind; it is pure string-in/string-out and leaves `{placeholder}` tokens intact for later rendering. `schemaSummary` renders a `WorkspaceDescriptor` into prompt-ready text (project totals, top events with properties, customer properties, data horizon) for the analytics agents.

```ts
function injectProfile(systemTemplate: string, profileText: string, opts?: {
  position?: 'start' | 'end';   // default 'start'
  heading?: string;
}): string;

function schemaSummary(workspace: WorkspaceDescriptor, options?: WorkspaceSummaryOptions): string;
```

`WorkspaceDescriptor` (required by the four analytics agents) — `workspace-descriptor.ts`. A compact snapshot of an analytics project's schema and scale (its events and their properties, customer properties, catalogs, totals, and data window) that the agents summarize into the prompt and gate coverage against:

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

Measure ranked-retrieval quality against a known relevant set. precision@k = fraction of the top-k retrieved ids that are relevant; recall@k = fraction of all relevant ids that appear in the top-k. (`ok` reports whether the metric is well-formed, not a pass/fail threshold.)

```ts
type RetrievalScoreResult = { ok: boolean; score: number; matched: number; total: number };
function scorePrecisionAtK(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): RetrievalScoreResult;
function scoreRecallAtK(retrievedIds: readonly string[], relevantIds: ReadonlySet<string>, k: number): RetrievalScoreResult;
```

`relevantIds` is a `ReadonlySet<string>`, not an array.

### LLM rubric judge — `rubric-judge.ts`

LLM-as-judge: scores an output's faithfulness/quality against a `RubricDefinition` (per-dimension scales, checks, verdict rules) by prompting a model for structured scores. Use it to grade generated text where a structural diff can't capture quality.

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

Checks an output's shape and required fields against declarative rules (a path is required, equals a value, is a number within tolerance, has a given array count, contains text, or includes an item) and returns the issues. Use it to assert deterministic structure without an LLM.

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

Scores categorical detections (e.g. anomalies) against expectations — required categories, metrics, scopes, severities, and count bounds — reporting what matched, was missed, or was unexpected, plus a fractional `score`. Use it to measure precision/recall of an agent's detections.

```ts
type DetectionScoreResult = { ok: boolean; score: number; matched: string[]; missed: string[]; unexpected: string[]; issues: StructuralIssue[] };
function scoreDetections(detections: readonly DetectionLike[], expectations?: DetectionExpectations): DetectionScoreResult;
```

### Shape assertions — `assertions.ts`

Ready-made structural checks for each agent's output (and for replay artifacts): they assert the expected required fields and shape so a malformed result fails loudly. Each takes `(output: unknown)` and returns `EvalAssertionResult` (`{ name; ok; issues }`), synchronously:

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
Answers a free-form question by retrieving from the knowledge base (via `search_knowledge_base`) and grounding the reply in the retrieved chunks.
```ts
type RagQueryAgentOptions = { model: ModelProvider; tools: ToolRegistry; profile?: string; prompt?: string; trace?: CapabilityTraceSink };
type RagQueryRunOptions   = { signal?: AbortSignal };
new RagQueryAgent(options).answer(question: string, runOptions?: RagQueryRunOptions): Promise<string>;
```
`profile` (e.g. a `me.md`) is injected into the system prompt under heading "# About the person you are assisting". Allowed tool: `search_knowledge_base`.

**`QueryAgent`** — `packages/agents/query/src/query-agent.ts`
Answers a free-form analytics question about a workspace, calling read-only analytics tools to gather data; an optional `intent` biases it toward monitoring, diagnostic, or recommendation framing.
```ts
type QueryAgentOptions = { model: ModelProvider; tools: ToolRegistry; workspace: WorkspaceDescriptor; trace?: CapabilityTraceSink; prompt?: string };
type QueryRunOptions   = { intent?: QueryIntent; signal?: AbortSignal };   // QueryIntent: 'monitoring'|'diagnostic'|'recommendation', default 'diagnostic'
new QueryAgent(options).answer(question: string, runOptions?: QueryRunOptions): Promise<string>;
```
Helpers: `classifyIntent(model, query, opts?)`, `parseIntent(raw)`, `validateQueryAnswer(answer)`.

**`RecommendationAgent`** — `packages/agents/recommendation/src/recommendation-agent.ts`
Given an anomaly and its diagnosis, proposes up to three concrete next actions drawn from an action taxonomy.
```ts
type RecommendationAgentOptions = { model; tools; workspace; actionTaxonomy?; trace?; idGenerator?: () => string; prompt? };
new RecommendationAgent(options).propose(anomaly: Anomaly, diagnosis: Diagnosis, runOptions?): Promise<Recommendation[]>;  // ≤3 items
```
Validators: `isRecommendationArray`, `tryParseRecommendations`. (No `validateRecommendation`.)

**`AnomalyMonitoringAgent`** — `packages/agents/anomaly-monitoring/src/monitoring-agent.ts`
Scans a workspace across anomaly categories and returns the detected anomalies, severity-sorted and capped at ten.
```ts
type MonitoringAgentOptions = { model; tools; workspace; categories?: readonly AnomalyCategory[]; trace?; prompt? };  // default ECOMMERCE_ANOMALY_CATEGORIES
new AnomalyMonitoringAgent(options).scan(runOptions?): Promise<Anomaly[]>;   // severity-sorted, ≤10
```
Note: class is `AnomalyMonitoringAgent` but its options type is `MonitoringAgentOptions`. Exports `ECOMMERCE_ANOMALY_CATEGORIES`, `runnableCategories`, `formatCategoryChecklist`, `validateAnomalies`, `tryParseAnomalies`.

**`DiagnosticInvestigationAgent`** — `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts`
Investigates a given anomaly by gathering evidence through analytics tools and returns a `Diagnosis` (conclusion, evidence, hypotheses, confidence).
```ts
type DiagnosticAgentOptions = { model; tools; workspace; trace?; prompt? };  // options type is DiagnosticAgentOptions
new DiagnosticInvestigationAgent(options).investigate(anomaly: Anomaly, runOptions?): Promise<Diagnosis>;
function diagnosisConfidence(diagnosis: Diagnosis): 'high' | 'medium' | 'low';
```
Validators: `validateDiagnosis`, `tryParseDiagnosis`.

**`RubricImprovementAgent`** — `packages/agents/rubric-improvement/src/rubric-improvement-agent.ts`
Judges a subject against a rubric, then returns the judgment plus the weakest dimension, a suggested next action, and an optional follow-up drill.
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
