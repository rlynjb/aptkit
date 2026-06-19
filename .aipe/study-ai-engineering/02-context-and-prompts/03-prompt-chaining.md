# Prompt chaining (multi-step, each step one job)

**Industry names:** prompt chaining, prompt pipelines, task decomposition · *Industry standard*

## Zoom out, then zoom in

One giant prompt that asks the model to "scan for anomalies, then diagnose the
worst one, then recommend fixes" is fragile — the model juggles three jobs, and a
failure in any one corrupts the rest. Prompt chaining splits that into a pipeline:
one focused prompt per job, where the *output* of each step becomes the *input* of
the next. AptKit's whole pipeline — monitor → diagnose → recommend — is exactly
this, with one agent per job and a typed handoff between them.

```
  Zoom out — where prompt chaining lives

  ┌─ Pipeline layer (chain across agents) ────────────────────────┐
  │  ★ monitor ──Anomaly──► diagnose ──Diagnosis──► recommend ★     │ ← we are here
  └───────────────────────────────┬────────────────────────────────┘
                                   │ each step = one agent + one prompt package
  ┌─ Prompt layer (prompts-as-code) ▼───────────────────────────────┐
  │  PromptPackage { id, version, capabilityId, system, … }         │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ rendered + run via runAgentLoop
  ┌─ Runtime / Provider ───────────▼────────────────────────────────┐
  │  the bounded agent loop, one per step                           │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a chain is a sequence of prompts where each does *one* job and passes a
structured result to the next. The questions this file answers: why split instead
of asking once, what flows across the seam between steps, and how AptKit keeps the
prompts themselves maintainable (versioned, with variables and examples — prompts as
code). The verdict up front: the monitor → diagnose → recommend pipeline is prompt
chaining, and the typed `Diagnosis` handoff is the contract that makes it one.

## Structure pass

**Layers.** Two: the *pipeline* layer (the fixed sequence of steps and the data
that flows between them) and the *prompt* layer (each step's `PromptPackage` — its
system text, variables, version). The pipeline is the chain; the package is one
link's definition.

**Axis — state / what data flows across each step, and who owns it?** Trace it. The
monitor *produces* `Anomaly[]` and owns nothing after. The diagnose step *consumes*
an anomaly and *produces* a `Diagnosis`. The recommend step *consumes* the
`Diagnosis` (and the anomaly) and *produces* `Recommendation[]`. State is handed
forward as typed values; no step reaches back. The data is the contract between
steps.

```
  One question — "what flows out of this step, into the next?"

  ┌─ monitor ───┐  → produces Anomaly[]  (owns nothing downstream)
  ┌─ diagnose ──┐  → consumes Anomaly, produces Diagnosis
  ┌─ recommend ─┐  → consumes Diagnosis (+Anomaly), produces Recommendation[]

  state flows ONE WAY; the typed value IS the handoff contract
```

**Seams.** The load-bearing seams are the *typed handoffs* between steps — most
clearly, `recommend` takes a `Diagnosis` as a function argument. That seam is a
contract: the recommend step doesn't re-derive the diagnosis, it trusts the typed
value handed to it. A second seam is the prompt-package boundary — each step's
prompt is a versioned artifact, so you can change one link's wording without
touching the others.

## How it works

You already know a Unix pipe: `cmd1 | cmd2 | cmd3`, where each command does one
thing and stdout becomes the next stdin. Prompt chaining is that, with LLM agents
as the commands and typed objects as the pipe. Each step is small, focused, and
independently testable; the chain is the composition.

### Move 1 — the mental model

```
  Prompt chaining — one job per step, typed handoff between

  ┌──────────┐  Anomaly   ┌───────────┐  Diagnosis  ┌────────────┐
  │ monitor  │ ─────────► │ diagnose  │ ──────────► │ recommend  │
  │ "what    │            │ "why did  │             │ "what to   │
  │  changed?"│           │  it       │             │  do about  │
  │          │            │  change?" │             │  it?"      │
  └──────────┘            └───────────┘             └─────┬──────┘
   each box: one prompt, one job, one focused output       │
                                                    Recommendation[]
```

Why not one mega-prompt? Because each step's prompt can be short, specific, and
*validated independently* — and a failure is localized to one step instead of
poisoning a three-in-one answer. Small focused prompts also dodge lost-in-the-middle
(`02-lost-in-the-middle.md`) by construction.

### Move 2 — the moving parts

**One job per prompt.** Bridge from the single-responsibility principle — each
prompt package is scoped to exactly one capability. The recommendation prompt opens
"You are a recommendation agent… given a diagnosis, propose 2-3 actions" — it does
*not* scan or diagnose; that work is assumed done. Boundary condition: the step
trusts its input. If the upstream diagnosis is wrong, recommend faithfully builds on
a wrong premise — the chain is only as good as each handoff, which is why each step
is validated on its own.

```
  Pattern — single-responsibility per step

  monitor prompt:    "scan categories, output Anomaly[]"     (only scanning)
  diagnose prompt:   "given an anomaly, output a Diagnosis"  (only diagnosing)
  recommend prompt:  "given a Diagnosis, output actions"     (only recommending)
        │
        └─ each prompt assumes the prior step's job is DONE and correct
```

**The typed handoff.** Bridge from a function signature — the contract between steps
isn't prose, it's a type. `recommend` is literally `propose(anomaly, diagnosis)`:
the `Diagnosis` is a typed argument, serialized into the recommend prompt as the
`{diagnosis}` variable. Boundary condition: the handoff is one-directional and
final — recommend can't ask diagnose to reconsider; it gets the diagnosis as a
fixed input and acts on it. That's what makes each step independently runnable and
testable.

```
  Layers-and-hops — the typed handoff into recommend

  ┌─ diagnose step ─┐ produces Diagnosis  ┌─ recommend step ──────────┐
  │  (upstream)     │ ───────────────────►│  propose(anomaly,         │
  └─────────────────┘  (typed value)      │          diagnosis)        │
                                          │    renderPromptTemplate(   │
                                          │      { diagnosis: JSON… }) │ ← injected
                                          └────────────┬───────────────┘
                                              runAgentLoop → Recommendation[]
```

**Prompts as code.** Bridge from a versioned config file — each step's prompt is a
`PromptPackage`, not a string literal buried in the agent. It carries an `id`, a
`version`, a `capabilityId`, declared `variables` (with required/optional and
descriptions), and `examples`. Boundary condition: because the prompt is a typed,
versioned artifact, you can change the recommend wording, bump its `version`, and
diff it in review — without touching the monitor or diagnose links. The prompt is a
unit of change, not an inline string.

```
  Pattern — PromptPackage as a versioned artifact

  PromptPackage {
    id:           'recommendation-agent.default'   ← addressable
    version:      '0.1.0'                           ← diffable, bumpable
    capabilityId: 'recommendation-agent'            ← which step it serves
    system:       '…You are a recommendation agent…'
    variables:    [{ schema, required }, { diagnosis, required }, …]
    examples:     [{ input, expectedContains }]     ← testable against output
  }
```

### Move 3 — the principle

Decompose by job, hand off by type. A chain of small, single-purpose prompts beats
one mega-prompt on every axis that matters: each link is shorter (dodging
lost-in-the-middle), independently testable, and isolates failures instead of
propagating them. The glue between links is a *typed value*, not prose — that's
what makes the seam a contract you can trust and test. And treating each prompt as
versioned code (id, version, variables, examples) means a prompt is something you
review and evolve deliberately, not a string you tweak and forget. Pipe small jobs;
type the handoffs; version the prompts.

## Primary diagram

The full chain: three single-job steps, typed handoffs, each backed by a versioned
prompt package.

```
  Prompt chaining — full picture

  PIPELINE (chain across agents — fixed order)
  ┌──────────┐          ┌───────────┐           ┌──────────────┐
  │ monitor  │ Anomaly[] │ diagnose  │ Diagnosis │ recommend    │
  │          │ ────────► │           │ ────────► │ propose(     │
  │          │           │           │           │  anomaly,    │
  │          │           │           │           │  diagnosis)  │
  └────┬─────┘          └─────┬─────┘           └──────┬───────┘
       │ backed by            │                        │ → Recommendation[]
  PROMPT LAYER (prompts-as-code)
  ┌────▼─────┐          ┌─────▼─────┐           ┌──────▼───────┐
  │monitoring│          │ diagnostic │          │recommendation│
  │Package   │          │ Package    │          │Package       │
  │id/version│          │id/version  │          │id/version    │
  └────┬─────┘          └─────┬─────┘           └──────┬───────┘
       │ renderPromptTemplate({schema, diagnosis, …}) each
       ▼                      ▼                        ▼
  RUNTIME: runAgentLoop (one bounded loop per step)
```

## Implementation in codebase

**Use cases.** The product flow is the chain: scan a workspace for anomalies, pick
the worst, diagnose why it happened, recommend what to do. Each step is a separate
agent class with its own prompt package and its own tool policy — and the recommend
step's signature makes the handoff undeniable: it *requires* a `Diagnosis` to run.

**The typed handoff into recommend**, `packages/agents/recommendation/src/recommendation-agent.ts:64-75`:

```
  recommendation-agent.ts  (lines 64-75)

  async propose(
    anomaly: Anomaly,
    diagnosis: Diagnosis,          ← the upstream step's output, as a TYPED input
    runOptions: RecommendationRunOptions = {},
  ): Promise<Recommendation[]> {
    …
    const system = renderPromptTemplate(this.prompt, {
      schema: schemaSummary(this.options.workspace),
      project_id: this.options.workspace.projectId,
      diagnosis: JSON.stringify(diagnosis),   ← the handoff serialized into the prompt
    });
       │
       └─ recommend does NOT re-derive the diagnosis. It trusts the typed
          Diagnosis handed in and acts on it. That argument IS the chain
          seam — the contract between the diagnose link and the recommend link.
```

**Prompts as code**, `packages/prompts/src/types.ts:13-22` and a real package,
`packages/prompts/src/recommendation.ts:78-113`:

```
  prompts/recommendation.ts  (lines 78-100)

  export const recommendationPromptPackage: PromptPackage = {
    id: 'recommendation-agent.default',     ← addressable identity
    version: '0.1.0',                        ← bump on change, diff in review
    capabilityId: 'recommendation-agent',    ← which chain step it serves
    description: 'Action recommendation generation from a supported diagnosis…',
    system: RECOMMENDATION_PROMPT,           ← the one-job prompt text
    variables: [
      { name: 'schema',    description: '…', required: true },
      { name: 'project_id',description: '…', required: true },
      { name: 'diagnosis', description: 'JSON serialized diagnosis to act on', required: true },
    ],
    examples: [{ name: 'voucher-dropoff-recommendations',
      input: { diagnosis: {…} }, expectedContains: ['bloomreachFeature','successMetric'] }],
  };
       │
       └─ the prompt is a versioned artifact, not an inline string. The
          declared `diagnosis` variable is the chain contract in the prompt
          layer; the examples make the step testable in isolation.
```

The prompt text itself enforces single-responsibility — it opens "Given a diagnosis
of why something changed, propose 2-3 concrete actions"
(`recommendation.ts:3,7`), assuming monitor and diagnose are already done. The
agent renders it with `renderPromptTemplate` and runs it through `runAgentLoop`
(`recommendation-agent.ts:71-93`) — one bounded loop per chain step.

## Elaborate

Prompt chaining is task decomposition applied to LLMs, and it's the dominant pattern
for any multi-stage LLM workflow because it converts one unreliable mega-call into
several reliable small ones. The deep reason it works: each prompt is shorter (less
lost-in-the-middle), each output is narrower (easier to validate and to feed
forward), and a failure is contained to one stage. It's the same logic as breaking a
1000-line function into named helpers — and the same logic as the chain-vs-agent
split (`../04-agents-and-tool-use/01-agents-vs-chains.md`): the *pipeline* across
steps is a chain, even though each *step* is an agent loop.

Prompts-as-code is the operational maturity layer. A `PromptPackage` with id,
version, declared variables, and examples means prompts get the same discipline as
the rest of the codebase: reviewed, diffed, tested, evolved deliberately. The
alternative — prompts as string literals scattered through agent code — makes prompt
changes invisible in review and untestable in isolation. AptKit chose the versioned
artifact.

Adjacent concepts: the chain-vs-agent altitude split
(`../04-agents-and-tool-use/01-agents-vs-chains.md`), why short per-step prompts dodge
position bias (`02-lost-in-the-middle.md`), and the multi-agent *orchestration*
discipline this pipeline is an instance of — see `.aipe/study-agent-architecture/`.
The prompt-design craft itself (wording, examples, structure) is its own topic —
see `.aipe/study-prompt-engineering/`.

## Project exercises

*Provenance: Phase 2 — Context and prompts (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the chain and prompt-packages exist;
these strengthen the seams.*

### Exercise — validate the handoff type at the chain seam (Case A)

- **Exercise ID:** `[A2.5]` Phase 2, prompt-chaining concept
- **What to build:** Add a runtime validation of the `Diagnosis` passed to
  `propose` — reject (or log) a malformed diagnosis before it's serialized into the
  prompt, so a broken upstream handoff fails loudly at the seam instead of silently
  producing garbage recommendations.
- **Why it earns its place:** The chain is only as good as each handoff; today
  recommend trusts the diagnosis blindly. Validating the contract at the seam is the
  difference between a debuggable pipeline and a mysterious bad output three steps
  later.
- **Files to touch:** `packages/agents/recommendation/src/recommendation-agent.ts`,
  `packages/agents/recommendation/src/validate.ts`,
  `packages/agents/recommendation/test/recommendation-agent.test.ts`.
- **Done when:** A malformed `Diagnosis` is rejected at `propose` with a clear error;
  a valid one passes; a test covers both.
- **Estimated effort:** `1–4hr`

### Exercise — run prompt examples as a regression eval (Case A)

- **Exercise ID:** `[A2.6]` Phase 2, prompts-as-code concept
- **What to build:** A small eval runner that, for each `PromptPackage`, renders the
  declared `examples[].input`, runs the agent, and asserts the output contains every
  string in `expectedContains` — turning the example field from documentation into a
  test.
- **Why it earns its place:** `examples` with `expectedContains` exist on every
  package but aren't executed — they're dead documentation. Running them makes a
  prompt change that breaks the contract turn the suite red, which is the whole point
  of prompts-as-code.
- **Files to touch:** `packages/prompts/src/*` (examples are already there),
  `packages/evals/src/*` (a package-example runner), a fixture provider.
- **Done when:** Each prompt package's examples run as assertions; editing a prompt
  so it no longer satisfies `expectedContains` fails the eval.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why chain three prompts instead of one prompt that does everything?**
"Localized failure, shorter prompts, and testability. I'd draw the pipe:"

```
  monitor ─Anomaly─► diagnose ─Diagnosis─► recommend ─► Recommendation[]
  one job   typed     one job    typed       one job
            handoff              handoff
```

"One mega-prompt juggling scan + diagnose + recommend fails as a unit — a wrong
diagnosis poisons the recommendations and you can't tell which part broke. Chaining
makes each prompt short (which also dodges lost-in-the-middle), each output narrow
and validatable, and each failure contained to one stage. The handoff is a typed
value — `propose(anomaly, diagnosis)` in `recommendation-agent.ts:64` takes a
`Diagnosis` argument — so the contract between steps is a type, not prose."
*Anchor: pipe small jobs, type the handoffs, isolate the failures.*

**Q: How do you manage the prompts themselves so they don't rot?**
"Prompts as code. Each is a `PromptPackage` — `id`, `version`, declared `variables`,
and `examples` (`prompts/types.ts:13`, real one at `recommendation.ts:78`). So a
prompt is a versioned, diffable, testable artifact, not a string literal buried in
agent code. I can change one link's wording, bump its version, review the diff, and
run its examples as a regression — without touching the other links."
*Anchor: a prompt is a unit of change you review and test, not an inline string.*

## Validate

- **Reconstruct:** From memory, draw the three-step chain with the typed value on
  each arrow (Anomaly, Diagnosis, Recommendation[]). Check against the Move 1
  diagram.
- **Explain:** Why does `propose` take `diagnosis` as a typed argument rather than
  re-running diagnosis itself (`recommendation-agent.ts:64`)? (Single
  responsibility — recommend's job is only to act on a diagnosis; re-deriving it
  would merge two steps and lose the testable, isolatable handoff.)
- **Apply:** You want to reword the recommendation prompt without risking the monitor
  or diagnose steps. What changes, and how is it safe? (Edit
  `RECOMMENDATION_PROMPT`, bump `recommendationPromptPackage.version` —
  `recommendation.ts:3,79` — review the diff; the other packages and steps are
  untouched because each link is a separate versioned artifact.)
- **Defend:** Why are short per-step prompts better than one long prompt beyond just
  "cleaner"? (Each dodges lost-in-the-middle by being short — `02-lost-in-the-middle.md`
  — produces a narrow, validatable output, and contains failures to one stage.)

## See also

- [01-context-window.md](01-context-window.md) — why short per-step prompts fit easily
- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — short prompts dodge position bias
- [../04-agents-and-tool-use/01-agents-vs-chains.md](../04-agents-and-tool-use/01-agents-vs-chains.md) — the chain (pipeline) vs agent (loop) altitude split
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the loop each chain step runs on
- [.aipe/study-agent-architecture/](../../study-agent-architecture/) — multi-agent orchestration of this pipeline
- [.aipe/study-prompt-engineering/](../../study-prompt-engineering/) — the prompt-design craft inside each package
