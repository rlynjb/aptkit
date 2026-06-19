# 04 — Agent Evaluation

*Agent evaluation / replay eval / trajectory eval — Pattern + in-codebase (the
replay-artifact backbone is real and central in AptKit).*

## Zoom out, then zoom in

Agents are non-deterministic: same input, different path, sometimes a different
answer. So "did it pass the test" splits into two questions you must evaluate
separately — *was the final output the right shape and content* (output eval),
and *did it get there sanely — right tools, bounded turns* (trajectory eval).
AptKit answers both off one captured artifact. Start by seeing the pipeline that
turns a messy live run into a deterministic, re-runnable test.

```
  How a live run becomes a deterministic test (the replay backbone)

  ┌─ LIVE RUN ─────────────────────────────────────────────────────────┐
  │  runAgentLoop emits CapabilityEvents → trace[]                       │
  │  output (Anomaly[] / Diagnosis / answer) + modelTurns + durationMs   │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  ▼  serialize
  ┌─ REPLAY ARTIFACT (JSON) ───────────────────────────────────────────┐
  │  { schemaVersion, capabilityId, provider, fixture, output,          │
  │    trace, eval, modelTurns, createdAt, durationMs }                  │
  │  artifacts/replays/*.json                                            │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  ▼  evaluate (shape + structural + rubric)
  ┌─ EVAL ─────────────────────────────────────────────────────────────┐
  │  assert<Shape> · structural-diff · scoreDetections · RubricJudge     │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  ▼  promote a good run to a baseline
  ┌─ PROMOTED FIXTURE ─────────────────────────────────────────────────┐
  │  fixtures/promoted/*.json  → FixtureModelProvider replays it         │
  │  deterministic: canned model responses, no live model call           │
  └─────────────────────────────────────────────────────────────────────┘
```

The frontend anchor: a replay artifact is a recorded HTTP session (think a
saved fetch/VCR cassette). The promoted fixture is a snapshot test — you froze a
known-good run and now you re-run it deterministically on every CI pass. The
trace is the Redux DevTools timeline of the agent's reasoning.

## Structure pass

Trace the **provenance axis** — *what evidence does each eval stage trust, and
where does that evidence come from.* The seam is "what's observable" vs "what's
asserted."

```
  The provenance axis: evidence in, judgment out

  Stage             Trusts (input)             Produces (output)
  ────────────────  ─────────────────────────  ─────────────────────────────
  trace capture     CapabilityEvent stream      trace[] (the trajectory)
  artifact build    output + trace + modelTurns  one JSON file (events.ts shapes)
  ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ◄ SEAM
  shape eval        the artifact's required keys ok / issues[] (assertions.ts)
  rubric eval       the output text              dimension scores (rubric-judge)
```

The seam separates *observation* (the trace and artifact are recorded facts, no
judgment) from *assertion* (the eval stages apply rules). This matters because
trajectory eval is only possible *below* the seam if the trajectory was captured
*above* it — the `CapabilityEvent` trace is the thing that makes tool-call and
turn-count eval possible at all. No trace, no trajectory eval.

## How it works

### Move 1 — the mental model

Eval an agent on two independent axes: **output** (is the answer right) and
**trajectory** (did it behave). They fail independently — a right answer reached
by 8 flailing tool calls is a trajectory failure even with a passing output, and
a clean 2-call run that produces malformed JSON is an output failure with a clean
trajectory.

```
  Two independent eval axes (PATTERN)

                   OUTPUT correct?
                   YES            NO
                ┌────────────┬────────────┐
  TRAJECTORY  Y │  ✓ ship     │ bad answer,│
  sane?         │             │ clean path │
                ├────────────┼────────────┤
              N │ right but   │ broken     │
                │ wasteful/   │ both ways  │
                │ flaky       │            │
                └────────────┴────────────┘
   you need BOTH axes; a green output cell can still hide a red trajectory
```

You measure output with shape/structural assertions and rubric judging; you
measure trajectory off the captured trace (which tools, how many turns). One
artifact carries the evidence for both.

### Move 2 — the pieces, one at a time

**Piece 1 — the trace makes trajectory observable**

```
  runAgentLoop emits a typed event stream → the trajectory

  step             ← assistant reasoning text
  tool_call_start  ← { toolName, args }       ┐
  tool_call_end    ← { result, error, durationMs } ┘ per tool call
  model_usage      ← { inputTokens, outputTokens } per model turn
  warning / error  ← problems
       │
       ▼  collected into trace[]
  "which tools, in what order, how long, how many turns" = TRAJECTORY
```

Pseudocode: `trace.emit({ type: 'tool_call_end', toolName, durationMs, ... })`.
Without these events the run is a black box — you'd only see the final output.
The `CapabilityEvent` union is the observability contract that turns the run into
an inspectable trajectory.

**Piece 2 — the replay artifact freezes one run**

```
  serialize the run to a self-describing JSON file

  artifact = {
    schemaVersion: 1, capabilityId, createdAt, durationMs,
    provider: { id, model }, fixture: { id, path },
    <output>: Anomaly[] | Diagnosis | answer | recommendations,
    trace: CapabilityEvent[],
    eval: { name, ok, issues },     ← the embedded verdict
    modelTurns                       ← how many model calls it took
  }
```

Pseudocode: `writeFile(path, JSON.stringify({ ...meta, output, trace, eval,
modelTurns }))`. The artifact is self-contained: metadata for provenance, the
output for content eval, the trace for trajectory eval, and an embedded `eval`
verdict. `modelTurns` is the turn count (from the recording provider's request
counter); the trace's `model_usage` events are the per-turn evidence behind it.

**Piece 3 — shape/structural eval asserts the output**

```
  required-path assertions over the output

  assertAnomalyShape(output)  → checks 0.metric, 0.scope, 0.change.value, ...
  assertRequiredPaths(output, ['0.title','0.steps', ...]) → ok / issues[]
       │
       ▼  ok = issues.length === 0
```

Pseudocode: `result = assertRequiredPaths(output, requiredPaths); ok =
result.issues.length === 0`. This is cheap, deterministic, and catches the most
common agent failure: malformed/incomplete structured output. Each capability
has its own shape assertion plus a `validate.ts` (e.g. `validateDiagnosis`).

**Piece 4 — rubric judge for output quality (LLM-as-judge)**

```
  a model scores the output against a rubric

  RubricJudge.judge({ subject }) → { dimensions:{...scores}, verdict, fix }
       ▲
   for QUALITY (not just shape) — meaning/evidence, scored on a scale
```

Pseudocode: `judgment = await rubricJudge.judge({ subject: output })`. Shape eval
can't tell a *good* diagnosis from a *plausible-but-wrong* one — that needs
judgment, so a model scores it on rubric dimensions. (LLM-as-judge has known
biases; see the cross-link.)

**Piece 5 — promoted fixture = a deterministic baseline**

```
  freeze a good run as canned model responses

  good replay artifact ──promote──▶ fixtures/promoted/*.json
       │
       ▼  FixtureModelProvider serves the canned responses (no live model)
  re-run is DETERMINISTIC: same fixture in → same trajectory → same output
```

Pseudocode: `model = new FixtureModelProvider(fixture.modelResponses)`. The
fixture is a correctness baseline per the data contract: it pins a known-good
trajectory so a regression in the loop, the prompt, or a tool shows up as a
diff against the frozen run.

### Move 3 — the principle

Make the trajectory observable, freeze runs as self-describing artifacts, and
eval on two axes (output shape/quality + trajectory). The deterministic replay
is what converts a non-deterministic agent into something you can regression-test
at all.

## Primary diagram

The full eval lifecycle, live run through deterministic regression.

```
  Eval lifecycle: live run → artifact → eval → fixture → replay

  ┌─ live ─────────────┐
  │ runAgentLoop        │ emits CapabilityEvents
  │  + live model       │──────────────┐
  └─────────────────────┘              ▼
                          ┌─ replay artifact JSON ─────────────────┐
                          │ schemaVersion / capabilityId / provider │
                          │ fixture / output / trace / eval /       │
                          │ modelTurns / createdAt / durationMs     │
                          │ artifacts/replays/*.json                │
                          └──────────────┬──────────────────────────┘
              evaluateReplayArtifact()    │  assert<Shape> chooses validator
              ┌─────────────────────────┐ │  by capabilityId / output keys
              │ assertCapabilityReplay…  │◀┘
              │  Shape() → ok, issues[]  │
              │ + scoreDetections /       │
              │   RubricJudge for quality │
              └─────────────────────────┘
                          │ a clean run is worth keeping
                          ▼  promote
                          ┌─ promoted fixture ─────────────────────┐
                          │ fixtures/promoted/*.json                 │
                          │ FixtureModelProvider → deterministic     │
                          │ replay (no live model call)              │
                          └──────────────────────────────────────────┘
```

Read it as a ratchet: every good live run can become a frozen baseline, and once
frozen it replays deterministically — so the next loop/prompt/tool change is
checked against it for free.

## Implementation in codebase

**Use case 1 — the trace is the trajectory.**
`packages/runtime/src/events.ts:1`:

```ts
export type CapabilityEvent =
  | { type: 'step'; role; content; ... }                 // assistant reasoning
  | { type: 'tool_call_start'; toolName; args; ... }      // ┐ trajectory:
  | { type: 'tool_call_end'; toolName; result?; error?; durationMs; ... } // ┘ which tools, latency
  | { type: 'model_usage'; provider; model; inputTokens?; outputTokens?; ... } // turns + cost
  | { type: 'warning'; ... } | { type: 'error'; ... };
```

This union (line 1) is the observability contract. The loop emits these
(`run-agent-loop.ts:147` tool_call_start, `:171` tool_call_end, `:112`
model_usage), and the array of them *is* the trajectory you later eval.

**Use case 2 — shape assertions per capability.**
`packages/evals/src/assertions.ts`:

```ts
export function assertAnomalyShape(output) {              // line 19
  if (Array.isArray(output) && output.length === 0) return { ok: true, issues: [] }; // [] is valid
  const result = assertRequiredPaths(output, ['0.metric','0.scope','0.change.value',
    '0.change.direction','0.change.baseline','0.severity']);  // ← required shape
  return { name: 'anomaly-shape', ...result };
}

export function assertCapabilityReplayArtifactShape(output) { // line 35 — routes by capability
  if (... output.capabilityId === 'query-agent' || typeof output.answer === 'string')
    return assertQueryReplayArtifactShape(output);
  if (... 'diagnostic-investigation-agent' || isRecord(output.diagnosis))
    return assertDiagnosticReplayArtifactShape(output);
  if (... 'anomaly-monitoring-agent' || Array.isArray(output.anomalies))
    return assertMonitoringReplayArtifactShape(output);
  return assertReplayArtifactShape(output);                // default: recommendation
}
```

Line 35 dispatches to the right validator by `capabilityId` or output shape; each
validator (e.g. `assertMonitoringReplayArtifactShape` line 128) checks the
required artifact keys *plus* the output shape, and even scans for leaked secrets
(`findSecretLikeString`, line 397) and prompt-package provenance (line 374).

**Use case 3 — `modelTurns` and the batch report.**
`packages/evals/src/replay-runner.ts:47` reads `modelTurns` and per-output counts
into a `ReplayArtifactEvalSummary`; `apps/studio/src/agent-runners.ts:42` is
where `modelTurns: model.requests.length` is computed at capture time (the
recording provider counts its requests). The trace's `model_usage` events are the
per-turn evidence; `modelTurns` is the count. A real captured artifact
(`artifacts/replays/*.json`) carries `modelTurns: 2`, `trace` length 5, and an
embedded `eval: { name, ok, issues }`.

**Use case 4 — per-agent validators feed both run and eval.**
`packages/agents/diagnostic-investigation/src/validate.ts:25` (`isDiagnosis`),
`:49` (`validateDiagnosis`): the *same* validator that gates the agent's output
inside the loop (the parse/recovery step, `05-guardrails-and-control.md`) is the
correctness predicate the eval uses. One contract, two consumers — the agent
self-checks with it, the eval re-checks with it.

**Use case 5 — detection scoring (recall-style trajectory-adjacent eval).**
`packages/evals/src/detection-scorer.ts:29` (`scoreDetections`) scores anomaly
output against expected categories/metrics/scopes/severities and returns a
0..1 score plus matched/missed/unexpected — a richer-than-binary check for the
monitoring agent.

**Use case 6 — rubric judge for quality.**
`packages/evals/src/rubric-judge.ts:72` (`RubricJudge.judge`) runs an
LLM-as-judge: a model scores the subject on rubric dimensions and returns a
validated `{ dimensions, verdict, fix }`. This is the quality axis shape eval
can't cover.

**Not yet exercised: a frozen golden-trajectory suite.** Eval today is mostly
*shape/structural* + rubric-judge; promoted fixtures *are* correctness baselines
(per the data contract), but there's no assertion that pins the exact tool
sequence/turn count as a golden trajectory the way some agent test harnesses do.
The trace makes it *possible* — nothing yet asserts trajectory equality. See
SECTION F (`../06-orchestration-system-design-templates/`).

**Not yet exercised: online/production eval (live scoring, sampling, drift).**
Eval runs offline against artifacts and fixtures; there's no live-traffic
sampling or drift monitor. See SECTION F.

## Elaborate

**Origin.** The replay-artifact pattern is the agent generalization of
record/replay testing (VCR cassettes, snapshot tests). Capturing a typed trace
and freezing a known-good run as a deterministic fixture is the standard way
teams tame agent non-determinism enough to put it in CI.

**Adjacent — why two axes.** Output-only eval misses runaway/flaky trajectories;
trajectory-only eval misses wrong answers. The artifact carries both the output
and the trace precisely so one file evals both. The `modelTurns` field is the
cheapest trajectory metric — a run that suddenly needs 8 turns where it used to
need 2 is a regression even if the output still passes shape.

**Adjacent — LLM-as-judge bias.** The rubric judge is a model scoring a model;
it inherits position bias, verbosity bias, and self-preference. That's why it's
*one* signal alongside cheap deterministic shape checks, not the only gate. The
bias mechanics and mitigations are taught in `.aipe/study-ai-engineering/`.

## Interview defense

**Q: "How do you test a non-deterministic agent?"**

```
  capture a live run → replay artifact JSON → promote a good one to a fixture
  → FixtureModelProvider replays it deterministically (no live model)
```

Anchor: "I record each run as a self-describing artifact — metadata, output,
trace, embedded eval, turn count — then promote good runs to fixtures that a
fixture provider replays deterministically. That turns a flaky agent into a
snapshot test."

**Q: "How do you eval the *path*, not just the answer?"**

```
  the CapabilityEvent trace (events.ts:1): tool_call_start/end, model_usage
  → which tools, in what order, how long, how many turns (modelTurns)
```

Anchor: "Off the captured trace. The loop emits a typed event stream, so the
trajectory — tools, order, latency, turn count — is observable and evaluable.
No trace, no trajectory eval."

**Q: "Why both shape assertions and a rubric judge?"**

```
  shape:  cheap, deterministic — catches malformed output (assertions.ts)
  rubric: LLM-as-judge — catches plausible-but-wrong (rubric-judge.ts:72)
  shape can't tell good from plausibly-wrong; rubric can't be your only gate (bias)
```

Anchor: "Shape eval is cheap and deterministic but only checks structure. The
rubric judge catches quality but it's a biased model scoring a model, so it's
one signal next to the deterministic checks, never the sole gate." This is the
load-bearing judgment: layer a cheap deterministic gate under an expensive
judgmental one.

## Validate

- **Reconstruct:** Draw the lifecycle (live → artifact → eval → fixture →
  deterministic replay) and name the artifact's keys (`assertReplayArtifactShape`,
  `assertions.ts:58`: schemaVersion, createdAt, durationMs, provider, fixture,
  output, trace, eval, modelTurns).
- **Explain:** Why is the trace required for trajectory eval?
  (`events.ts:1` — the trajectory is the event stream; without `tool_call_*` and
  `model_usage` events the run is a black box.)
- **Apply:** A run produces a valid-shaped but factually wrong diagnosis. Which
  eval catches it, which misses it? (shape eval at `validate.ts:25` passes;
  `RubricJudge.judge`, `rubric-judge.ts:72`, can catch it — with judge-bias
  caveats.)
- **Defend:** A teammate wants to drop shape assertions "because the rubric judge
  covers quality." What do you lose? (`assertions.ts:19` — the cheap,
  deterministic gate; you'd be relying solely on a biased LLM judge and you'd miss
  malformed JSON the judge might not even parse.)

## See also

- [01-context-engineering.md](01-context-engineering.md) — provenance keys
  (promptPackage id/version) the artifact carries
- [02-agent-memory-tiers.md](02-agent-memory-tiers.md) — statelessness is what
  makes deterministic replay work
- [05-guardrails-and-control.md](05-guardrails-and-control.md) — the same
  `validate.ts` predicates gate the output and feed the eval
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — where the trace events
  are emitted in the loop
- `.aipe/study-ai-engineering/` — LLM-as-judge bias and output-quality eval
