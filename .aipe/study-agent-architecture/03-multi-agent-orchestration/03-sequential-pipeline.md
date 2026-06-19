# 03 — Sequential Pipeline

> The deep one. This is the single topology in the whole sub-section with real
> grounding in AptKit — and the grounding is *latent*: the pipeline exists in
> the data contracts (`Anomaly → Diagnosis → Recommendation`), not yet in
> running code. The payoff of this file is seeing how *little* has to change to
> wire it live, precisely because the types already line up.

## Zoom out

A sequential pipeline is the simplest multi-agent shape: agent A's output is
agent B's input is agent C's input. No coordinator deciding anything at
runtime — the wiring is fixed, written by you, in advance. The interesting part
in AptKit is that the pipeline is *almost* already here. Three agents each take
the previous stage's output type as their input. The only thing missing is a
caller that runs them in a row.

```
  The layers of "pipeline" in AptKit (what exists vs what's missing)

  ┌─ Layer 3: A running orchestrator ─────────────────────────────────┐
  │  one function: scan() → investigate() → propose()                 │
  │  STATUS: does not exist. No code chains all three.                │  ◄ the gap
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  rests on ↓
  ┌─ Layer 2: The typed handoff contract ─────────────────────────────┐
  │  investigate(anomaly: Anomaly) · propose(anomaly, diagnosis)      │
  │  STATUS: EXISTS. The inputs chain by type, today.                 │  ◄ real
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  rests on ↓
  ┌─ Layer 1: Three independent agents ───────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent          │
  │  STATUS: EXISTS. Each is a bounded ReAct loop, runnable alone.    │  ◄ real
  └────────────────────────────────────────────────────────────────────┘
```

Layers 1 and 2 are real code in the repo right now. Layer 3 is the one missing
piece — and because Layer 2 already holds, Layer 3 is about ten lines. That is
the whole story of this file.

## Structure pass

The axis is **data direction**: output of stage N is input of stage N+1, one
way, no cycles. The seams between stages are the typed boundaries.

```
  The pipeline along its one axis (left → right, data only flows forward)

  stage 1            seam: Anomaly      stage 2            seam: Diagnosis    stage 3
  ┌──────────┐       ──────────────►    ┌──────────────┐   ──────────────►   ┌─────────────┐
  │ scan()   │                          │ investigate( │                     │ propose(    │
  │ → Anomaly[]                         │   anomaly )  │                     │  anomaly,   │
  └──────────┘                          │ → Diagnosis  │                     │  diagnosis) │
                                        └──────────────┘                     │ → Recomm.[] │
                                                                             └─────────────┘
   each stage: prompt + tool policy + budget + validator  (a full ReAct loop)
```

The seams are not glue you write — they're *types*. `investigate` already
*demands* an `Anomaly`. `propose` already *demands* both an `Anomaly` and a
`Diagnosis`. The compiler enforces the pipeline's shape even though no code
runs it as a pipeline.

## How it works

### Move 1 — the mental model

The mental model is a **`.then()` chain of single-purpose functions** — the
exact pattern you reach for in frontend code when each step transforms the
previous step's result.

```
  The .then()-chain mental model (the topology IS this picture)

  scan()
    .then(anomalies => investigate(anomalies[0]))
    .then(diagnosis => propose(anomaly, diagnosis))
    .then(recommendations => render(recommendations))

  ┌────────┐  Anomaly   ┌──────────────┐  Diagnosis  ┌──────────┐  Recommendation[]
  │ scan   │ ─────────► │ investigate  │ ──────────► │ propose  │ ──────────────────►
  └────────┘            └──────────────┘             └──────────┘
   pure-ish step         pure-ish step                pure-ish step
   (each is an LLM loop, but the COMPOSITION is a plain promise chain)
```

For a frontend reader: you've written this a hundred times.
`fetchUser().then(u => fetchOrders(u.id)).then(orders => render(orders))`. Each
function does one thing, takes the prior result, returns the next. A sequential
agent pipeline is *that*, where each `.then` step happens to be a bounded ReAct
loop instead of a `fetch`. The composition logic is identical and trivial. The
agents do the hard work; the pipeline is just the chain.

### Move 2 — step by step

Each stage is a single-purpose function with a typed in and a typed out.

**Stage 1 — scan: produce anomalies from nothing but the workspace.**

```
  scan: workspace ──► Anomaly[]
  ┌──────────────────────────────────┐
  │ ReAct loop over analytics tools   │
  │ → validate → severity-sort → top10│
  └──────────────────────────────────┘
```

```
scan():
  anomalies = reactLoop(monitoringPrompt, monitoringPolicy, budget=8/6)
  return validate(anomalies).sortBySeverity().slice(0, 10)
```

**Stage 2 — investigate: take ONE anomaly, return a diagnosis.**

```
  investigate: Anomaly ──► Diagnosis
  ┌────────────────────────────────────────┐
  │ inject anomaly into the system prompt    │
  │ ReAct loop (hypothesis test) → validate  │
  └────────────────────────────────────────┘
```

```
investigate(anomaly: Anomaly):
  system = render(diagnosticPrompt, { anomaly: JSON(anomaly) })
  diagnosis = reactLoop(system, diagnosticPolicy, budget=8/6)
  return validate(diagnosis) ?? FALLBACK_DIAGNOSIS
```

**Stage 3 — propose: take the anomaly AND its diagnosis, return actions.**

```
  propose: (Anomaly, Diagnosis) ──► Recommendation[]
  ┌──────────────────────────────────────────────┐
  │ inject diagnosis into prompt                   │
  │ ReAct loop (grounded propose) → validate → ≤3  │
  └──────────────────────────────────────────────┘
```

```
propose(anomaly: Anomaly, diagnosis: Diagnosis):
  system = render(recommendationPrompt, { diagnosis: JSON(diagnosis) })
  recs = reactLoop(system, recommendationPolicy, budget=6/4)
  return validate(recs).assignIds().slice(0, 3)
```

The orchestrator that doesn't exist yet is just the composition of these three:

```
runPipeline(workspace):              # ← THIS is the missing ~10 lines
  anomalies   = scan()               # Anomaly[]
  if anomalies.isEmpty(): return []
  diagnosis   = investigate(anomalies[0])     # Diagnosis
  recs        = propose(anomalies[0], diagnosis)  # Recommendation[]
  return recs
```

### Move 2.5 — current state vs future state

This is the crux of the file. Watch how the future state is *the same agents*
plus a tiny composition.

**Current state — three isolated agents, wired by types only.**

```
  TODAY: three agents, three SEPARATE runs, no chain

  ┌────────┐      ┌──────────────┐      ┌──────────┐
  │ scan   │      │ investigate  │      │ propose  │
  └───┬────┘      └──────┬───────┘      └────┬─────┘
      │                  │                   │
   own fixture        own fixture         own fixture
   own endpoint       own endpoint        own endpoint
   own replay         own replay          own replay

   no arrow connects them. The Anomaly that stage 2 consumes
   is hand-written in stage 2's fixture, NOT produced by stage 1.
```

Each agent runs against its *own* fixture through its *own* replay endpoint. The
diagnostic fixture already *contains* an anomaly; the recommendation fixture
already *contains* both an anomaly and a diagnosis. The handoff values are
pre-baked into each stage's test data, not flowed from the prior stage.

**Future state — a thin orchestrator chains the same three.**

```
  FUTURE: same three agents, one composing function

  ┌────────┐ Anomaly  ┌──────────────┐ Diagnosis ┌──────────┐ Recommendation[]
  │ scan   │ ───────► │ investigate  │ ────────► │ propose  │ ───────────────►
  └────────┘          └──────────────┘           └──────────┘
       ▲                    ▲                          ▲
       └──── same agent ────┴──── same agent ──────────┘
   the ONLY new code: the arrows (a runPipeline() function)
```

**The takeaway — how little has to change.** The agents don't change. The
prompts don't change. The tool policies don't change. The validators don't
change. The *types* don't change — `investigate` already takes `Anomaly`,
`propose` already takes `(Anomaly, Diagnosis)`. The entire delta is one
composing function that passes `anomalies[0]` into `investigate` and the result
into `propose`. The contracts did the integration work in advance. That is the
reward for typed handoffs: the pipeline is latent because it was *designed*
latent, and lighting it up is composition, not surgery.

One honest seam to flag: `Anomaly` and `Diagnosis` are *structurally
duplicated* across the diagnostic and recommendation packages (byte-identical
type definitions, not a shared import). The compiler accepts the handoff because
TypeScript is structural, but a real orchestrator would want one shared type
package so the contract has a single source of truth. That's the one piece of
"surgery" — and it's a type-move, not a logic change.

### Move 3 — the principle

A sequential pipeline trades flexibility for inspectability and cheapness. There
is no runtime decision about *which* agent runs next — the order is fixed, so
there's nothing to debug about routing. The cost is rigidity: if a stage needs
to loop back or skip ahead, a straight pipeline can't express it (that's when
you reach for a graph, file 07). The deep lesson is that designing the
*handoff types* first makes the pipeline assembly trivial later. The contract is
the integration. Write the types as if the pipeline existed, and wiring it
becomes a `.then()` chain.

## Primary diagram

The latent pipeline, current and future on one page, with the real file:line
anchors.

```
  AptKit's latent sequential pipeline — contract today, orchestrator tomorrow

  ┌──────────────────────────────────────────────────────────────────────┐
  │  CONTRACT (exists now)                                                 │
  │                                                                        │
  │  scan(): Promise<Anomaly[]>          monitoring-agent.ts:57            │
  │      │  Anomaly                                                        │
  │      ▼                                                                 │
  │  investigate(anomaly: Anomaly):      diagnostic-agent.ts:55            │
  │      Promise<Diagnosis>                                                │
  │      │  Diagnosis                                                      │
  │      ▼                                                                 │
  │  propose(anomaly: Anomaly,           recommendation-agent.ts:64        │
  │          diagnosis: Diagnosis):                                        │
  │      Promise<Recommendation[]>                                         │
  └──────────────────────────────────────────────────────────────────────┘
                                  │
                                  │  add ~10 lines:
                                  ▼
  ┌──────────────────────────────────────────────────────────────────────┐
  │  ORCHESTRATOR (does not exist yet — SECTION F template)                │
  │  runPipeline(): scan() → investigate(a[0]) → propose(a[0], d)         │
  └──────────────────────────────────────────────────────────────────────┘
```

## Implementation in this codebase

This is the file with real (latent) grounding. The contract is live; the
orchestrator is the named refactor.

Use cases — the contract, traced through real signatures:

1. **Stage 1 produces the handoff type.**
   `AnomalyMonitoringAgent.scan()` returns `Promise<Anomaly[]>`
   (`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:57`). Its result
   is severity-sorted and capped at 10 (`monitoring-agent.ts:86-88`). The first
   element is exactly what stage 2 wants.

2. **Stage 2 consumes stage 1's type.**
   `DiagnosticInvestigationAgent.investigate(anomaly: Anomaly): Promise<Diagnosis>`
   (`packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:55`). The
   anomaly is injected into the system prompt at
   `diagnostic-agent.ts:58-62` (`anomaly: JSON.stringify(anomaly)`). The output
   `Diagnosis` is exactly what stage 3 wants.

3. **Stage 3 consumes BOTH prior types.**
   `RecommendationAgent.propose(anomaly: Anomaly, diagnosis: Diagnosis): Promise<Recommendation[]>`
   (`packages/agents/recommendation/src/recommendation-agent.ts:64`). The
   diagnosis is injected into the prompt at `recommendation-agent.ts:71-75`.
   The chain `Anomaly → Diagnosis → Recommendation` is complete in the
   signatures.

4. **The callers that touch multiple agents do NOT chain them.** The only places
   that instantiate more than one of these agents —
   `apps/studio/src/agent-runners.ts` and `apps/studio/vite.config.ts` — run
   each against its *own fixture* through a *separate replay endpoint*:
   - `runMonitoringFixtureReplay` calls `agent.scan()` on a monitoring fixture
     (`agent-runners.ts:65`)
   - `runDiagnosticFixtureReplay` calls `agent.investigate(fixture.anomaly)` —
     where `fixture.anomaly` is hand-written test data, *not* a scan output
     (`agent-runners.ts:97`)
   - `runFixtureReplay` (recommendation) calls
     `agent.propose(fixture.anomaly, fixture.diagnosis)` — both inputs from the
     fixture (`agent-runners.ts:34`)
   - The Studio dev server mounts them as *distinct* endpoints:
     `/api/monitoring/replay`, `/api/diagnostic/replay`, `/api/replay`
     (`apps/studio/vite.config.ts:450,469,507`).

   **No code runs all three end to end. The pipeline is a data contract, not an
   orchestrator.**

The honest one-liner: the contract is real and load-bearing; the orchestrator
that would chain it is not yet built. The build is the
`runPipeline()` shape in Move 2 — and the SECTION F templates in
`../06-orchestration-system-design-templates/` specify it. Because Layer 2
holds, the build is composition, not redesign.

## Elaborate

Why is this latent instead of built? Because the *product* surfaces each
capability independently — Studio replays one agent at a time so you can inspect
each stage's trace in isolation. A live pipeline would hide the intermediate
`Diagnosis` behind a single "give me recommendations" button, which is worse for
an evaluation/inspection tool. So the latency is a *product* decision, not an
oversight — the engineering was done (the types), the wiring was deliberately
left out.

The structural-duplication seam (`Anomaly`/`Diagnosis` defined identically in
both packages) is worth internalizing. It works today because each agent is
tested alone, so each package owns its own copy. The moment you build
`runPipeline`, you'd hoist those types into a shared package so the handoff has
a single source of truth — otherwise a change to `Diagnosis` in one package
silently diverges from the other and the structural match breaks without a
compile error pointing at the pipeline. That's the kind of latent-coupling bug
that only shows up once the latent pipeline goes live.

## Interview defense

**Q: "You have three agents whose types chain perfectly. Why isn't there a
pipeline running them? And how hard is it to add one?"**

"The pipeline is latent by design. The contract is real:
`investigate` takes the `Anomaly` that `scan` produces, and `propose` takes the
`Anomaly` and `Diagnosis` from the prior two stages — the types chain end to
end. What's missing is a composing function, because the product surfaces each
agent independently in Studio for inspection. Adding it is about ten lines —
`scan().then(investigate).then(propose)` — precisely because I designed the
handoff *types* up front. The one real change is hoisting the duplicated
`Anomaly`/`Diagnosis` types into a shared package so the contract has one source
of truth. The agents, prompts, policies, and validators don't change at all."

```
  The one-line defense
  contract exists (Anomaly→Diagnosis→Recommendation) → orchestrator is a .then chain
  → the types did the integration in advance
```

Anchor: `monitoring-agent.ts:57`, `diagnostic-agent.ts:55`,
`recommendation-agent.ts:64` (the chained signatures);
`agent-runners.ts:34,65,97` + `vite.config.ts:450,469,507` (separate
fixtures/endpoints, no chain).

If you don't know whether something should be a pipeline vs a graph: say so, and
reason out loud — "a straight pipeline if the order is fixed and never loops
back; a graph (file 07) the moment a stage needs to skip ahead or retry an
earlier stage."

## Validate your understanding

1. **Spot the contract.** Read the three signatures: `scan()` →
   `Promise<Anomaly[]>` (`monitoring-agent.ts:57`), `investigate(anomaly: Anomaly)`
   → `Promise<Diagnosis>` (`diagnostic-agent.ts:55`),
   `propose(anomaly: Anomaly, diagnosis: Diagnosis)` → `Promise<Recommendation[]>`
   (`recommendation-agent.ts:64`). Confirm the output of each is the input of the
   next.

2. **Trace the non-chain.** In `agent-runners.ts`, confirm
   `runDiagnosticFixtureReplay` passes `fixture.anomaly` (line 97) — hand-written
   data, not a `scan()` result. Then confirm the three replay functions never
   call each other.

3. **Predict the orchestrator.** Write the `runPipeline()` body from memory.
   (`scan()` → take `[0]` → `investigate` → `propose`.) Count the lines you'd add
   to the codebase. (About ten.)

4. **Find the latent-coupling seam.** Compare
   `packages/agents/diagnostic-investigation/src/types.ts:5-23` with
   `packages/agents/recommendation/src/types.ts:5-23`. They're byte-identical
   duplicates. Why does the handoff still compile? (Structural typing.) What
   would you fix before going live? (One shared type package.)

## See also

- `08-shared-state-and-message-passing.md` — why this pipeline is *message
  passing* (each stage gets only the prior typed output), not a blackboard
- `07-graph-orchestration.md` — when a straight pipeline isn't enough; the
  latent pipeline as a 3-node graph
- `04-parallel-fan-out.md` — why these three *stages* can't fan out (dependent),
  but multiple anomalies could
- `01-when-not-to-go-multi-agent.md` — why this is the one justified split
- `../06-orchestration-system-design-templates/` — SECTION F: the orchestrator
  spec
- `../agent-patterns-in-this-codebase.md` — the latent-pipeline section with the
  same anchors
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop each stage runs
