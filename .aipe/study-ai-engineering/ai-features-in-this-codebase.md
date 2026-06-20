# How This Codebase Uses AI

AptKit is a library of reusable AI-agent capabilities. It does not run a single
mega-prompt; it ships six distinct AI features, each one a *capability* —
a prompt package plus a least-privilege tool policy plus an agent-loop config plus
a validator. They are provider-neutral: every one calls the `ModelProvider.complete()`
contract, never a vendor SDK directly.

Three of the six form a pipeline — **monitor → diagnose → recommend**: the
anomaly-monitoring agent detects what changed, the diagnostic-investigation agent
tests hypotheses for why, and the recommendation agent proposes what to do. The
query agent answers free-form questions over analytics tools. The rubric-improvement
agent scores a subject against a rubric and names the next action. The newest,
**rag-query**, is the vector-RAG capstone: it answers questions grounded in an
indexed knowledge base via a `search_knowledge_base` tool, and it's the one
feature designed to run **zero-cloud** — local Gemma2:9b + local nomic embeddings,
both over Ollama.

A sharp contrast worth naming up front: query-agent and rag-query are *both*
question-answering agents, but they ground differently. query-agent does **agentic
retrieval over exact analytics tools** (no vectors — it calls a metric endpoint).
rag-query does **vector retrieval over a prose corpus** (embed → cosine search →
cite). The choice between them is the above-threshold rule in
[03-retrieval-and-rag/11-rag.md](./03-retrieval-and-rag/11-rag.md).

## AI features

| Feature | Pattern used | Why this pattern |
| --- | --- | --- |
| query-agent | Tool-augmented Q&A over ~49 read-only tools, with heuristic+LLM intent routing | A free-form question needs live data, not a static answer; cheap keyword routing handles the common case, an LLM classifier handles the ambiguous case |
| anomaly-monitoring-agent | Bounded agent loop + structured-output anomaly scan over 10 categories | Detection must be deterministic to validate and cheap to bound; a fixed checklist with per-category thresholds keeps the model from inventing unsupported work |
| diagnostic-investigation-agent | Hypothesis-tested diagnosis (bounded loop) | "Why did this happen" is an investigation, not a lookup — the agent proposes hypotheses and tests each against tool evidence before concluding |
| recommendation-agent | Diagnosis → ≤3 grounded actions (recommender shape) | Actions must be grounded in a real diagnosis and framed in a fixed taxonomy; bounding to 3 forces prioritization instead of a wishlist |
| rubric-improvement-agent | LLM-as-judge rubric scoring → weakest dimension + next action | Quality is multi-dimensional; a structured rubric makes the judgment auditable and reduces it to one highest-leverage fix |
| rag-query-agent | Vector RAG: `search_knowledge_base` tool over an in-memory pipeline, inside a bounded loop → grounded, cited answer | The answer lives in a private prose corpus the model wasn't trained on; retrieve-ground-cite (with a search-only tool policy) keeps it from hallucinating, and local Gemma + nomic make it run with zero cloud |

## Prompt shapes (structure, not full text)

- **query-agent** — system prompt = role + `{schema}` + `{project_id}` + `{intent}`; user = the raw question. Model calls read-only tools, then a `synthesisInstruction` forces a plain-prose answer citing the numbers found.
- **anomaly-monitoring-agent** — system prompt = role + `{schema}` + a `{categories}` checklist (each with warning/critical % thresholds); user = "run the checklist, return a JSON array of anomalies or `[]`."
- **recommendation-agent** — system prompt = role + action taxonomy + hard rules + the `{diagnosis}` JSON + `{schema}`; user = "propose recommendations, return the JSON array." Output capped at 3, no `id` field (assigned post-validation).
- **rubric-improvement-agent** — system prompt = rubric definition + the exact output shape; user = context + subject. Output = `{judgment, weakestDimension, nextAction, nextDrill?}`.
- **rag-query-agent** — system prompt = optional injected profile (`me.md`) + "always call `search_knowledge_base` first, ground every answer in the retrieved chunks, cite their sources, say so plainly if the KB doesn't cover it"; user = the question. Model calls the search tool, then a `synthesisInstruction` forces a concise answer citing the retrieved sources.

## Per-feature specs

### query-agent

- **File:** `packages/agents/query/src/query-agent.ts`, intent in `packages/agents/query/src/intent.ts`, prompt in `packages/prompts/src/query.ts`.
- **Inputs (typed):** `question: string`; optional `intent: Intent` (`monitoring | diagnostic | recommendation`), `signal?: AbortSignal`. Constructed with `{model, tools, workspace: WorkspaceDescriptor}`.
- **Outputs (typed):** `Promise<string>` — plain-prose answer, or `FALLBACK_ANSWER` ("I was unable to find enough data to answer that question.") when the loop produces nothing usable.
- **Model + provider:** any `ModelProvider`. Default Anthropic `claude-sonnet-4-6` (`packages/providers/anthropic`), or OpenAI `gpt-4.1` (`packages/providers/openai`), swappable, with a sequential fallback chain (`packages/providers/fallback`) and a context-window guard (`packages/providers/local`).
- **Token cost per call:** `runAgentLoop` runs up to `maxTurns 8`, `maxToolCalls 6`, `maxTokens 4096` per turn. Cost is only *priced* for OpenAI `gpt-4.1-*` in `packages/runtime/src/usage-ledger.ts` (gpt-4.1: \$2/M in, \$8/M out); Anthropic token usage is summed but **unpriced** (`pricingForModel` returns `undefined` for non-OpenAI).
- **Failure modes:** empty/short synthesis → returns `FALLBACK_ANSWER`; budget exhaustion (`maxToolCalls` hit or last turn) → loop forces a final synthesis turn with tools stripped; provider failure → fallback chain tries the next adapter.
- **Eval set:** replay fixtures in `packages/agents/query/fixtures/` (+ `fixtures/promoted/`), replayed deterministically by `FixtureModelProvider`. Scored by `assertQueryAnswerShape` / `assertQueryReplayArtifactShape` (`packages/evals/src/assertions.ts`). Artifacts in `artifacts/replays/`.

### anomaly-monitoring-agent

- **File:** `packages/agents/anomaly-monitoring/src/monitoring-agent.ts`, categories in `categories.ts`, prompt in `packages/prompts/src/monitoring.ts`.
- **Inputs (typed):** none at call time beyond `scan(runOptions?)`; constructed with `{model, tools, workspace, categories?: AnomalyCategory[]}`. Runnable categories are filtered to what the workspace schema supports (`runnableCategories`).
- **Outputs (typed):** `Promise<Anomaly[]>` — validated, severity-sorted (`critical > warning > info > positive`), capped at the top 10.
- **Model + provider:** same provider contract and defaults as above (Anthropic `claude-sonnet-4-6` default / OpenAI `gpt-4.1`, swappable + fallback chain).
- **Token cost per call:** `maxTurns 8`, `maxToolCalls 6`. Read-only tools only (`execute_analytics_eql`, `get_metric_timeseries`, `get_segments`, `get_anomaly_context`). Same pricing caveat — OpenAI gpt-4.1 priced, Anthropic unmeasured.
- **Failure modes:** parse failure → recovery turn (`buildRecoveryPrompt` converts gathered evidence into the final JSON array); no anomalies or unparseable → returns `[]`; budget exhaustion → forced synthesis turn with a "return ONLY the JSON array" instruction.
- **Eval set:** fixtures in `packages/agents/anomaly-monitoring/fixtures/` (e.g. `sp-revenue-monitoring.json`) + `fixtures/promoted/`. Scored by `assertAnomalyShape` / `assertMonitoringReplayArtifactShape` and `scoreDetections` (`packages/evals/src/detection-scorer.ts` — checks required categories/metrics/scopes/severities + min/max count). Artifacts in `artifacts/replays/`.

### diagnostic-investigation-agent

- **File:** `packages/agents/diagnostic-investigation/src/` (capability id `diagnostic-investigation-agent`), prompt in `packages/prompts/src/`.
- **Inputs (typed):** `investigate(anomaly: Anomaly, runOptions?)` — takes one anomaly (typically from the monitoring agent's output).
- **Outputs (typed):** `Promise<Diagnosis>` — `{conclusion, evidence[], hypothesesConsidered[]}` with inferred confidence.
- **Model + provider:** same provider contract and defaults (swappable + fallback chain).
- **Token cost per call:** bounded loop with a read-only tool policy; same pricing caveat (OpenAI gpt-4.1 priced, Anthropic unmeasured).
- **Failure modes:** parse failure → recovery turn; budget exhaustion → forced synthesis; provider failure → fallback chain.
- **Eval set:** fixtures in `packages/agents/diagnostic-investigation/fixtures/` (e.g. `sp-revenue-diagnostic.json`) + `fixtures/promoted/`. Scored by `assertDiagnosticShape` / `assertDiagnosticReplayArtifactShape` (`packages/evals/src/assertions.ts`). Artifacts in `artifacts/replays/`.

### recommendation-agent

- **File:** `packages/agents/recommendation/src/recommendation-agent.ts`, prompt in `packages/prompts/src/recommendation.ts`.
- **Inputs (typed):** `propose(anomaly: Anomaly, diagnosis: Diagnosis, runOptions?)`; constructed with `{model, tools, workspace, actionTaxonomy?, idGenerator?}`.
- **Outputs (typed):** `Promise<Recommendation[]>` — at most 3, each `{id, title, rationale, bloomreachFeature, steps[], estimatedImpact, confidence, …}`. `bloomreachFeature` ∈ `scenario | segment | campaign | voucher | experiment`. `id` assigned post-validation by `idGenerator` (default `crypto.randomUUID()`).
- **Model + provider:** same provider contract and defaults (swappable + fallback chain).
- **Token cost per call:** `maxTurns 6`, `maxToolCalls 4` — the tightest loop; feature-discovery tools (read-only) checked only to avoid duplicating live work. Same pricing caveat.
- **Failure modes:** parse failure → recovery turn (`buildRecoveryPrompt` re-states anomaly + diagnosis + evidence, asks for 2–3 recommendations); cannot ground actions → returns `[]`; budget exhaustion → forced synthesis ("ONLY a JSON array of at most 3 objects, no `id` field").
- **Eval set:** fixtures in `packages/agents/recommendation/fixtures/` + `fixtures/promoted/`. Scored by `assertRecommendationShape` / `assertReplayArtifactShape` (`packages/evals/src/assertions.ts`) and structural-diff. Artifacts in `artifacts/replays/`.

### rubric-improvement-agent

- **File:** `packages/agents/rubric-improvement/src/rubric-improvement-agent.ts`; the underlying judge is `packages/evals/src/rubric-judge.ts`.
- **Inputs (typed):** `improve(input: RubricImprovementInput, options?)` — `{subject: string, context?: Record<string,string>}`; constructed with `{model, tools, rubric: RubricDefinition}`.
- **Outputs (typed):** `Promise<RubricImprovementResult>` — `{judgment (per-dimension scores + verdict + fix), weakestDimension, nextAction, nextDrill?}`. Throws if the output is not parseable.
- **Model + provider:** same provider contract and defaults (swappable + fallback chain).
- **Token cost per call:** `maxTurns 6`, `maxToolCalls 3`, `maxTokens 2400`. Tools include both read (`get_recent_judgments`, `get_rubric_definition`, …) and two write-ish actions (`save_judgment`, `generate_next_scenario`) — the one agent whose policy is not purely read-only. Same pricing caveat.
- **Failure modes:** parse failure → recovery turn (re-states completed tool evidence, asks for the exact JSON shape); still unparseable → throws `'rubric improvement output was not parseable'`; verdict/score outside rubric bounds → rejected by `createRubricJudgmentValidator` (score must fall within the dimension's scale; verdict must be an allowed verdict).
- **Eval set:** validated by the rubric judge's own validator (`createRubricJudgmentValidator`, `packages/evals/src/rubric-judge.ts`). Note: this agent has **no `replay:promoted` script wired into the root pipeline** (the other agents do — see `.aipe/project/context.md`).

### rag-query-agent

- **File:** `packages/agents/rag-query/src/rag-query-agent.ts` (`@aptkit/agent-rag-query`, capability id `rag-query-agent`). Retrieval pipeline + tool in `@aptkit/retrieval`; profile injection in `@aptkit/context` (`injectProfile`).
- **Inputs (typed):** `answer(question: string, runOptions?: {signal?})`. Constructed with `{model: ModelProvider, tools: ToolRegistry (holding search_knowledge_base), profile?: string, prompt?: string, trace?}`.
- **Outputs (typed):** `Promise<string>` — a grounded, source-citing answer, or `FALLBACK_ANSWER` ("I couldn't find anything in the knowledge base to answer that.") when the loop produces nothing.
- **Model + provider:** designed for a **local** `GemmaModelProvider` (`gemma2:9b` over Ollama) wrapped in `ContextWindowGuardedProvider` — but any `ModelProvider` works (the contract is vendor-neutral, so a cloud adapter swaps in unchanged). Embeddings via `OllamaEmbeddingProvider` (nomic-embed-text, 768-dim).
- **Token cost per call:** `runAgentLoop` with `maxTurns 6`, `maxToolCalls 4`, plus a forced synthesis turn. Local Gemma is zero per-token cost (after hardware); the same pricing caveat applies if a cloud provider is swapped in.
- **Failure modes:** weak local model emits a malformed JSON tool call → the Gemma adapter's parse-retry nudges it (`gemma-provider.ts`); model passes `top_k: 1` and starves retrieval → the tool's `minTopK` floor backstops it; nothing retrieved or empty synthesis → `FALLBACK_ANSWER`; budget exhaustion → forced synthesis turn citing whatever was retrieved.
- **Tool policy:** `ragQueryToolPolicy` — least privilege, allows **only** `search_knowledge_base`. The agent cannot do anything but search and answer.
- **Eval set:** retrieval quality is measured by `scorePrecisionAtK` / `scoreRecallAtK` (`packages/evals/src/precision-at-k.ts`) over `pipeline.query` ids (already wired in `packages/agents/rag-query/test/rag-query-agent.test.ts`). The durable corpus + live precision@k run live in the **buffr** repo. See [05-evals-and-observability/05-precision-at-k.md](./05-evals-and-observability/05-precision-at-k.md).

## The eval seam (shared by the analytics + rubric features)

Live run → replay artifact (`artifacts/replays/*.json`) → eval (structural-diff /
`detection-scorer` / `rubric-judge`) → promote to fixture
(`scripts/promote-replay-to-fixture.mjs`) → deterministic replay via
`FixtureModelProvider`. Replay-artifact shape assertions (`packages/evals/src/assertions.ts`)
also scan for secret-like strings, so a leaked key fails the eval. This is the
testing and observability backbone; see [`05-evals-and-observability/`](./05-evals-and-observability/).

## Cross-links

- Agent loop and orchestration internals: [`../study-agent-architecture/`](../study-agent-architecture/)
- Prompt-package design: [`../study-prompt-engineering/`](../study-prompt-engineering/)
- Interview reframes of these features: [`07-system-design-templates/`](./07-system-design-templates/)
- The honest ML statement: [`ml-features-in-this-codebase.md`](./ml-features-in-this-codebase.md)
