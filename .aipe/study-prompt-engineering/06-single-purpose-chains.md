# 06 — Single-purpose chains

**Industry name(s):** task decomposition / pipeline of single-purpose agents.
**Type:** Language-agnostic.

## Zoom out, then zoom in

AptKit doesn't have one mega-prompt that does everything. It has five
capabilities, each with one job, each composable into a longer flow. That's a
deliberate choice with debugging and cost payoffs. Look at the shape.

```
  Zoom out — five single-purpose capabilities

  ┌─ Agent layer (packages/agents/*) ───────────────────────────┐
  │  query           → NL question to plain answer               │
  │  ★ anomaly-monitoring → detect anomalies only ★              │ ← each does ONE job
  │  ★ diagnostic    → investigate ONE anomaly's cause ★         │
  │  ★ recommendation → diagnosis to ≤3 actions ★                │
  │  rubric-improvement → score + one next action                │
  └───────────────────────────┬──────────────────────────────────┘
                             │  each = prompt package + tool policy + loop config
  ┌─ Runtime layer ──────────▼──────────────────────────────────┐
  │  one runAgentLoop per capability                             │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: monitoring finds *what* changed, diagnostic finds *why*,
recommendation says *what to do*. Each is a separate prompt, a separate tool
allowlist, a separate validator. Compose them into a pipeline and you get a system
where every failure is attributable to one stage.

## Structure pass

**Layers.** Two: the *capability* (one prompt + one job) and the *pipeline* (the
composition: monitoring → diagnostic → recommendation, where each stage's output
is the next stage's input).

**Axis — held constant: "what is this stage allowed to do?"**

```
  One question across the pipeline: what's each stage's job + grant?

  ┌─ monitoring ──────────────┐  → DETECT only; prompt says "Do not diagnose"
  │ tools: metric/anomaly read│
  └───────────────────────────┘
  ┌─ diagnostic ──────────────┐  → INVESTIGATE one anomaly; "do not propose remediation"
  │ tools: anomaly_context etc│
  └───────────────────────────┘
  ┌─ recommendation ──────────┐  → PROPOSE only; "read-only: you do NOT execute"
  │ tools: feature-discovery  │
  └───────────────────────────┘
```

**Seam — the stage boundary.** The load-bearing seam is each handoff: monitoring's
`Anomaly` becomes diagnostic's `{anomaly}` input; diagnostic's `Diagnosis` becomes
recommendation's `{diagnosis}` input. The axis (job + grant) flips hard at each
seam — detection has no proposal tools, proposal has no execution tools. Job
boundaries are also tool-policy boundaries.

## How it works

#### Move 1 — the mental model

You already build pipelines: a build step compiles, a test step verifies, a deploy
step ships — each does one thing and hands off. When the test step fails you know
exactly where you are. Single-purpose chains are that pipeline, with prompts as the
steps.

```
  The pipeline — one job per stage, typed handoffs

  WorkspaceDescriptor
        │
        ▼
  ┌──────────────┐  Anomaly[]   ┌──────────────┐  Diagnosis   ┌──────────────┐
  │ monitoring   │ ───────────► │ diagnostic   │ ───────────► │ recommendation│
  │ "what?"      │              │ "why?"       │              │ "what to do?" │
  └──────────────┘              └──────────────┘              └──────────────┘
        each stage: its own prompt + tool policy + validator
```

#### Move 2 — the walkthrough

**Each capability has one prompt with one job, stated as a prohibition.** The
strongest signal of single-purpose design is the *negative* instruction. The
monitoring prompt says "detect measurable anomalies only. Do not diagnose causes.
Do not propose actions." The diagnostic prompt says "You do not propose
remediation." The recommendation prompt says "You are read-only: you do NOT
execute anything." **Breaks if missing:** a monitoring agent that also diagnoses
produces a blob you can't grade — did it miss an anomaly, or just diagnose it
wrong? You can't tell.

**Each capability has its own tool allowlist.** The job boundary is enforced in
code as a least-privilege tool policy. Recommendation gets feature-discovery tools
(`list_scenarios`, `list_voucher_pools`); monitoring gets metric-read tools.
**Breaks if missing:** the model reaches for a tool outside its job and the stage
stops being single-purpose. (This is also a trust boundary — see 12.)

```
  Tool policy as the job boundary

  recommendationToolPolicy.allowedTools = [
    'list_scenarios', 'get_scenario', 'list_voucher_pools', ...  ← discovery only
  ]                                                              ← no execute_* tools
        │
        └─ the policy IS the "what can this stage do" answer, in code
```

**Each capability has its own validator and its own loop config.** Monitoring caps
at 6 tool calls and returns `Anomaly[]`; recommendation caps at 4 and returns
`Recommendation[]`; the rubric-improvement agent caps at 3. The budget matches the
job. **Breaks if missing:** a generous budget on a simple stage burns tokens; a
tight budget on a complex stage truncates the work.

**The debugging payoff.** When the pipeline produces a bad recommendation, you
replay each stage's artifact independently: was the anomaly detected correctly?
Was the diagnosis sound? Was only the recommendation off? Single-purpose stages
make the failure *attributable*. **The model-routing payoff:** intent
classification (07, 09) can run on a cheap model because it's a one-word
classifier; generation runs on the larger model. Small jobs, small models.

#### Move 3 — the principle

One chain, one job, composed into longer flows. The multi-purpose mega-prompt is
brittle (more instructions interfere), expensive (every call does everything), and
opaque (you can't tell which sub-job failed). Decomposition trades a little
orchestration overhead for attributable failures and per-stage model routing.

## Primary diagram

The composed pipeline with every handoff and grant labelled.

```
  Monitoring → diagnostic → recommendation pipeline

  WorkspaceDescriptor ──► ┌─ anomaly-monitoring-agent ─────────────┐
                          │ prompt: "detect only, do not diagnose"  │
                          │ policy: metric/anomaly read tools       │
                          │ maxToolCalls 6 → Anomaly[] (sorted)     │
                          └──────────────┬──────────────────────────┘
                                       Anomaly (one)
                          ┌─ diagnostic-investigation-agent ────────┐
                          │ prompt: "investigate why; no remediation"│
                          │ {anomaly} injected; maxToolCalls 6       │
                          │ → Diagnosis (+ confidence inference)     │
                          └──────────────┬──────────────────────────┘
                                       Diagnosis
                          ┌─ recommendation-agent ──────────────────┐
                          │ prompt: "read-only; propose 2-3 actions" │
                          │ {diagnosis} injected; maxToolCalls 4     │
                          │ → Recommendation[] (≤3, ids assigned)    │
                          └──────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The three-stage ecommerce pipeline (detect → diagnose → recommend)
is the canonical flow. Query and rubric-improvement are standalone single-purpose
capabilities.

The negative instruction that defines monitoring's single job:

```
  packages/prompts/src/monitoring.ts  (lines 4–6)

  You are an anomaly-monitoring agent for an analytics workspace.
  Your job is to detect measurable anomalies only. Do not diagnose causes.
  Do not propose actions.
       │
       └─ the two "Do not" lines are the job boundary stated to the model. They
          are what keep the output gradeable by detection-scorer (05).
```

The tool policy that enforces the job boundary in code:

```
  packages/agents/recommendation/src/recommendation-agent.ts  (lines 19–36)

  export const recommendationToolPolicy = {
    capabilityId: RECOMMENDATION_CAPABILITY_ID,
    allowedTools: [
      'list_scenarios', 'get_scenario', 'list_initiatives', ...
      'get_metric_timeseries', 'get_segments', 'get_anomaly_context',
    ] as const,   ← discovery + read only; no execute_* anywhere
  };
       │
       └─ a recommendation agent that could execute would not be single-purpose.
          The allowlist is the job boundary made enforceable, not just promised.
```

The handoff — diagnostic's `Diagnosis` becomes recommendation's injected input:

```
  packages/agents/recommendation/src/recommendation-agent.ts  (lines 64–75)

  async propose(anomaly: Anomaly, diagnosis: Diagnosis, ...): Promise<Recommendation[]> {
    ...
    const system = renderPromptTemplate(this.prompt, {
      schema: schemaSummary(this.options.workspace),
      project_id: this.options.workspace.projectId,
      diagnosis: JSON.stringify(diagnosis),   ← the previous stage's typed output, injected
    });
```

Per-stage budgets matched to per-stage jobs:

```
  monitoring-agent.ts:78  maxTurns: 8, maxToolCalls: 6   ← broad scan
  diagnostic-agent.ts:73  maxTurns: 8, maxToolCalls: 6   ← hypothesis testing
  recommendation-agent.ts:86  maxTurns: 6, maxToolCalls: 4  ← mostly reason from diagnosis
  rubric-improvement-agent.ts:75  maxTurns: 6, maxToolCalls: 3  ← light tool use
       │
       └─ recommendation's tighter budget reflects its prompt: "Mostly reason from
          the diagnosis." The budget encodes the job's shape.
```

## Elaborate

Single-purpose decomposition is the pattern that makes everything else in this
guide tractable. You can only eval a stage (05) if the stage has one job — a
mega-prompt's output can't be scored against a single expectation. You can only
enforce a tool policy (12) if the job boundary is clear. You can only route to a
cheap model if the sub-task is small. The decomposition is upstream of the other
disciplines.

The honest tradeoff: orchestration overhead. Three stages mean three model calls,
three sets of injected context, three places to keep prompts in sync. AptKit
accepts that cost because the alternative — one prompt that detects, diagnoses, and
recommends — fails opaquely and can't be graded per sub-job. The `confidence`
inference in the diagnostic agent (downgrading high→medium when any tool errored,
`diagnostic-agent.ts:85`) is a nice touch only possible because the stage owns one
job and knows its own tool-call history.

Where it connects: 07 (each stage declares its output mode, and a mismatch at a
handoff is a real bug), 02 (each stage's output is structured and validated at its
own boundary), and 05 (per-stage artifacts are what make failures attributable).

## Interview defense

**Q: Why split a workflow into single-purpose agents instead of one prompt?**
Attributable failures and per-stage model routing. When the pipeline produces a
bad recommendation, single-purpose stages let me replay each one's artifact and
find which stage failed — detection, diagnosis, or proposal. A mega-prompt fails
opaquely. The cost is orchestration overhead, which I accept for gradeable stages.

```
  bad output → which stage? ┌─monitor─┐→┌─diagnose─┐→┌─recommend─┐
                            replay each independently → blame is attributable
```
Anchor: "three capabilities, negative instructions in `monitoring.ts:4`,
per-stage tool policies."

**Q: How is the 'one job' boundary actually enforced?**
Two ways. In the prompt, as a prohibition — "Do not diagnose causes." In code, as
a least-privilege tool allowlist — recommendation has discovery tools and no
`execute_*`. The prompt states the job; the policy makes the boundary
unbypassable.
Anchor: "`recommendationToolPolicy.allowedTools` at `recommendation-agent.ts:19`."

## Validate

- **Reconstruct:** Draw the three-stage pipeline with each stage's job and the
  typed handoff between them.
- **Explain:** Why does the monitoring prompt explicitly say "Do not diagnose"
  (`monitoring.ts:5`) when diagnosis is a different agent anyway? What does the
  negative instruction protect?
- **Apply:** You need a new "forecast" stage between diagnosis and recommendation.
  What three things does it need (per `recommendation-agent.ts`), and what's its
  tool policy?
- **Defend:** A teammate wants to merge monitoring and diagnostic "to save a model
  call." Argue against it using the attributability and eval-grading payoffs.

## See also

- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — output modes declared per stage; mismatches at handoffs.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — per-stage artifacts make failures attributable.
- [12-prompt-injection-defense.md](12-prompt-injection-defense.md) — tool policy as a trust boundary.
