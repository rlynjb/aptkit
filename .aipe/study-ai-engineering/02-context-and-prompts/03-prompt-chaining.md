# Prompt chaining

**Subtitle:** Multi-step pipelines · one job per step · *Industry pattern, aptkit's analytics pipeline*

## Zoom out, then zoom in

Before the mechanism, here's the shape of aptkit's clearest chain. Three separate
agents run in sequence, each producing the typed input for the next.

```
  Zoom out — the analytics chain

  ┌─ AnomalyMonitoringAgent ──────────────────────────────────┐
  │  scan() → Anomaly[]      (own prompt pkg, own tool policy) │
  └──────────────────────────┬────────────────────────────────┘
                            │ Anomaly
  ┌─ DiagnosticInvestigationAgent ─▼──────────────────────────┐
  │  investigate(anomaly) → Diagnosis                          │ ← ★ each step ★
  └──────────────────────────┬────────────────────────────────┘
                            │ Anomaly + Diagnosis
  ┌─ RecommendationAgent ─────▼───────────────────────────────┐
  │  propose(anomaly, diagnosis) → Recommendation[]            │
  └─────────────────────────────────────────────────────────────┘
```

Now zoom in. Prompt chaining is doing one LLM task per step and feeding its output
into the next step's input, instead of asking one giant prompt to do everything.
aptkit's analytics pipeline is the textbook case: *find* an anomaly, then
*explain* it, then *act* on it. Three jobs, three agents, three prompts. The
payoff is that each step has a small context, a single responsibility, and an
error boundary — a bad diagnosis doesn't corrupt detection, it just produces a
weaker recommendation.

## Structure pass

**Layers.** Each step is a full agent: a prompt package (the system prompt + its
variables), a tool policy (least-privilege tool grant), and a `runAgentLoop` call.
The chain is these three layers composed in sequence.

**Axis — what does each step *know*?** Trace the data forward. Monitoring knows
the workspace schema and produces `Anomaly[]`
(`monitoring-agent.ts:57`). Diagnostic knows *one* anomaly plus the schema and
produces a `Diagnosis` (`diagnostic-agent.ts:55-62`). Recommendation knows the
anomaly *and* the diagnosis and produces `Recommendation[]`
(`recommendation-agent.ts:64-75`). Each step's context contains only what its job
needs — not the whole world.

**Seam.** The boundary between steps is the typed handoff: an `Anomaly` object, a
`Diagnosis` object. Above each seam: free-form model reasoning inside one agent.
Below it: a validated, parsed value the next agent treats as plain input. The axis
"is this model output or input?" flips at each handoff — one agent's parsed result
is the next agent's data.

## How it works

### Move 1 — the mental model

You compose pure functions all the time: `format(validate(parse(raw)))`. Each
function does one thing, takes typed input, returns typed output, and you can test
each in isolation. A render pipeline is the same — parse, transform, paint. Prompt
chaining is that pattern with LLM calls as the functions. The difference is each
"function" is a whole agent loop, and the value passed between them is a parsed,
validated object, not a raw model string.

```
  Chaining as function composition

   workspace ──► [ scan ] ──► Anomaly ──► [ investigate ] ──► Diagnosis ──► [ propose ] ──► Recommendation[]
                  │                          │                                │
                  one job                    one job                          one job
   each box: own prompt + own tools + own loop; output of one = input of next
```

### Move 2 — building the chain, step by step

**Step 1 — monitoring detects.** The agent renders its prompt with the workspace
schema and the category checklist, runs the loop, and returns parsed anomalies.
From `monitoring-agent.ts:57-83`:

```ts
async scan(runOptions: MonitoringRunOptions = {}): Promise<Anomaly[]> {
  const system = renderPromptTemplate(this.prompt, {        // monitoring prompt package
    schema: schemaSummary(this.options.workspace),
    categories: formatCategoryChecklist(categories),
  });
  const { parsed } = await runAgentLoop<Anomaly[]>({
    capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,
    system, userPrompt: 'Run the anomaly checklist...',
    maxTurns: 8, maxToolCalls: 6,
    parseResult: tryParseAnomalies,
  });
  // ...returns severity-sorted Anomaly[]
}
```

Its only job is "find anomalies." It never tries to explain or fix them — that
keeps its prompt short and its tool policy tight.

```
  Step 1 — scan

   schema + categories ──renderPromptTemplate──► system prompt
                                                    │ runAgentLoop (maxTurns 8)
                                                    ▼
                                       parse ──► Anomaly[]
```

**Step 2 — diagnostic explains one anomaly.** The next agent takes a single
`Anomaly`, serializes it straight into its prompt via the `{anomaly}` placeholder,
and produces a `Diagnosis`. From `diagnostic-agent.ts:55-62`:

```ts
async investigate(anomaly: Anomaly, runOptions: DiagnosticRunOptions = {}): Promise<Diagnosis> {
  const system = renderPromptTemplate(this.prompt, {        // diagnostic prompt package
    schema: schemaSummary(this.options.workspace),
    project_id: this.options.workspace.projectId,
    anomaly: JSON.stringify(anomaly),                       // ← step 1's output, injected
  });
  // runAgentLoop<Diagnosis>(... parseResult: tryParseDiagnosis ...)
}
```

The handoff is literal: step 1's parsed `Anomaly` becomes a `{anomaly}` variable
in step 2's prompt. `renderPromptTemplate` does plain `{var}` substitution
(`prompts/src/types.ts:24-32`) — no magic, just string replacement.

```
  Step 2 — investigate

   Anomaly ──JSON.stringify──► {anomaly} ──┐
   schema, project_id ─────────────────────┼─renderPromptTemplate──► system prompt
                                            │  runAgentLoop (maxTurns 8)
                                            ▼
                                  parse ──► Diagnosis
```

**Step 3 — recommendation acts on the diagnosis.** The last agent takes *both* the
anomaly and the diagnosis and proposes actions. From `recommendation-agent.ts:64-92`:

```ts
async propose(anomaly: Anomaly, diagnosis: Diagnosis, /* ... */): Promise<Recommendation[]> {
  const system = renderPromptTemplate(this.prompt, {        // recommendation prompt package
    schema: schemaSummary(this.options.workspace),
    project_id: this.options.workspace.projectId,
    diagnosis: JSON.stringify(diagnosis),                   // ← step 2's output, injected
  });
  const { parsed } = await runAgentLoop<IdlessRecommendation[]>({
    capabilityId: RECOMMENDATION_CAPABILITY_ID,
    system, maxTurns: 6, maxToolCalls: 4,
    parseResult: (text) => tryParseRecommendations(text, this.taxonomy),
    recoveryPrompt: (toolCalls) => buildRecoveryPrompt(anomaly, diagnosis, toolCalls),
  });
  // ...assigns ids, returns at most 3 Recommendation[]
}
```

Note `maxTurns: 6` here versus `8` upstream — each step is tuned to its own job.
The recommendation step's context is just the diagnosis plus the feature catalog
it queries, not the raw detection data. Each prompt lives in its own package
under `packages/prompts/src/` (`monitoring.ts`, `diagnostic.ts`,
`recommendation.ts`), each a `PromptPackage` with its own `id`, `version`, and
`capabilityId` (`prompts/src/types.ts:13-22`).

```
  Step 3 — propose

   Diagnosis ──JSON.stringify──► {diagnosis} ──┐
   schema, project_id ──────────────────────────┼─renderPromptTemplate──► system prompt
                                                 │  runAgentLoop (maxTurns 6)
                                                 ▼
                                       parse + assign ids ──► Recommendation[] (≤3)
```

**The compose-then-render discipline.** A related pattern shows up in the
rag-query agent: it *injects the profile* into the template, then renders
placeholders — two composition steps in order. From `rag-query-agent.ts:53-58`:

```ts
const withProfile = options.profile
  ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
  : template;
this.system = renderPromptTemplate(withProfile, {});   // inject context, THEN substitute vars
```

Same idea as the chain: build the prompt by composing well-defined steps, each
with one job, rather than concatenating everything at once.

### Move 3 — the principle

Give each LLM step exactly one job and hand off typed values, not raw text. The
wins compound: each step's context is small (cheaper, and dodges
lost-in-the-middle), each step's prompt is testable in isolation, and errors are
contained — a parse failure in diagnosis doesn't poison detection. The cost is
latency (three sequential model calls) and the need to validate at each seam. For
a pipeline where the steps are genuinely different jobs — find, explain, act —
that trade is clearly worth it.

## Primary diagram

```
  The analytics chain — one job per step, typed handoffs

  AnomalyMonitoring          DiagnosticInvestigation        Recommendation
  ┌────────────────┐         ┌────────────────────┐         ┌────────────────┐
  │ prompt: monitor│         │ prompt: diagnostic  │         │ prompt: recommend
  │ tools: read    │         │ tools: read+context │         │ tools: feature │
  │ loop maxTurns 8│         │ loop maxTurns 8     │         │ loop maxTurns 6│
  │  scan()        │ Anomaly │  investigate(a)     │Diagnosis│  propose(a,d)  │
  │     ───────────┼────────►│     ────────────────┼────────►│     ───────────┼──► Recommendation[]
  └────────────────┘         └────────────────────┘         └────────────────┘
   each step: renderPromptTemplate({...}) → runAgentLoop → parseResult → typed value
   errors isolate per step · context stays small per step · prompts test in isolation
```

## Elaborate

aptkit's chain is *static* — a fixed three-step sequence, not a dynamic plan the
model assembles. That's deliberate: the steps are known and stable (you always
detect before you explain, explain before you act), so a hardcoded chain is
simpler and more debuggable than a planner. Each step also carries its own
*recovery* path — `recommendation-agent.ts:103` builds a recovery prompt from the
anomaly, diagnosis, and tool calls if the first parse fails — so the seam between
steps is defended, not assumed. Two things worth noticing: the prompt packages are
*versioned* (`id`, `version` on every `PromptPackage`), which means you can A/B a
new monitoring prompt without touching diagnostic or recommendation — the chain's
modularity extends to prompt evolution. And `renderPromptTemplate` is deliberately
dumb: a single regex doing `{var}` substitution with no logic, no loops, no
conditionals (`prompts/src/types.ts:24-32`) — the intelligence lives in the agents,
not the templating. Read `01-context-window.md` to see *why* small per-step
contexts matter, and `02-lost-in-the-middle.md` for the retrieval analogue of
"keep each context tight."

## Project exercises

### Wire the three agents into one orchestrated `runPipeline`

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a function that takes a workspace, runs `scan()`, then for
  the top anomaly runs `investigate()`, then `propose()`, and returns
  `{ anomaly, diagnosis, recommendations }` — with the chain short-circuiting
  cleanly when `scan()` returns `[]`.
- **Why it earns its place:** the agents exist but the explicit composition is the
  thing an interviewer asks you to draw; building it proves you own the handoffs
  and the empty-result boundaries.
- **Files to touch:** a new module under `packages/agents/` (e.g. a small
  `analytics-pipeline` package) importing the three agents, plus a test using
  their fixture providers.
- **Done when:** a test with fixture providers runs all three steps and asserts a
  `Recommendation[]` comes out; an empty-anomaly fixture returns early with no
  diagnosis call.
- **Estimated effort:** `1–2 days`

### Add a fourth chain step that critiques recommendations

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a new prompt package + agent that takes the
  `Recommendation[]` and the original diagnosis and returns a confidence-adjusted,
  deduplicated list — extending the chain by one job without touching the upstream
  three.
- **Why it earns its place:** proves the chain is genuinely modular — you can add a
  step that consumes typed output and emits typed output without rewriting the
  pipeline.
- **Files to touch:** a new prompt file in `packages/prompts/src/` registered in
  `packages/prompts/src/index.ts`, plus a new agent package mirroring
  `packages/agents/recommendation/`.
- **Done when:** the new agent parses a `Recommendation[]` input and returns a
  filtered `Recommendation[]`, tested against a fixture provider.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "Why split this into three agents instead of one big prompt?"**
One job per step. Each agent has a small context (cheaper, avoids
lost-in-the-middle), a tight tool policy, and an error boundary — a parse failure
in diagnosis doesn't corrupt detection. And each prompt package is versioned, so I
can iterate on detection without touching the rest. One mega-prompt would couple
all three jobs and balloon the context.

```
  one prompt: find+explain+act ──► huge context, coupled failures
  three steps: find │ explain │ act ──► small contexts, isolated failures
```
Anchor: *three packages, three `runAgentLoop` calls — `monitoring-agent.ts:57`, `diagnostic-agent.ts:55`, `recommendation-agent.ts:64`.*

**Q: "How does data actually move between steps?"**
Typed handoffs. Each step's `parseResult` turns the model's text into a validated
object — `Anomaly`, then `Diagnosis` — and the next step serializes that object
into its prompt via a `{var}` placeholder. `renderPromptTemplate` does plain
string substitution, nothing clever; the validated object is the contract.

```
  Anomaly ──JSON.stringify──► {anomaly} in diagnostic prompt
  Diagnosis ──JSON.stringify──► {diagnosis} in recommendation prompt
   (parse at each seam → next step treats it as plain input)
```
Anchor: *`renderPromptTemplate(prompt, { anomaly: JSON.stringify(anomaly) })` — `diagnostic-agent.ts:58`, `prompts/src/types.ts:24`.*

## See also

- `01-context-window.md` — why small per-step contexts are cheaper and safer
- `02-lost-in-the-middle.md` — the retrieval version of "keep each context tight"
- `../04-agents-and-tool-use/` — what each `runAgentLoop` step does internally
- `../01-llm-foundations/04-structured-outputs.md` — the `parseResult` validation at each seam
