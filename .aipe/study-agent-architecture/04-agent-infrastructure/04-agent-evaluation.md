# Agent Evaluation

**Industry standard.** "Agent eval," "trajectory eval," "replay testing." Type label: infrastructure. **In this codebase: yes — the replay-centric eval pipeline is aptkit's testing/observability backbone.** Live run → artifact → eval → promote to fixture → deterministic replay.

## Zoom out, then zoom in

Evaluating an agent is harder than evaluating one LLM call, because the unit of evaluation is the *trajectory* — the whole sequence of tool calls and turns — not just the final output. aptkit's answer is a replay pipeline: capture a run as an artifact (including the trace), score it, and promote good runs to fixtures that replay deterministically forever.

```
  Zoom out — aptkit's replay-centric eval pipeline

  ┌─ Live run ──────────────────────────────────────────────┐
  │  agent loop emits CapabilityEvent trace + output         │
  └───────────────────────────┬──────────────────────────────┘
                              ▼ saved as
  ┌─ Replay artifact (artifacts/replays/*.json) ─────────────┐
  │  output + trace + eval + modelTurns                      │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
        ┌──────────────────────┴──────────────────┐
        ▼ score                                    ▼ promote
  evals (structural-diff,                    fixtures/promoted/*.json
   detection-scorer, rubric-judge,           → FixtureModelProvider
   precision@k)                                replays deterministically
```

## Structure pass

**Axis: what's the unit of evaluation?** One LLM call → score the output. An agent → score the *trajectory*: was the right tool called, in the right order, did it recover from errors, how many steps/$/ms, was the final output good. Trace it across aptkit's artifact: it captures `output`, `trace` (the tool-call sequence), `eval` (the score), and `modelTurns` (the trajectory length) — every dimension a trajectory eval needs. The seam: live evaluation (non-deterministic, against a real model) vs replay evaluation (deterministic, against recorded responses).

## How it works

### Move 1 — the mental model

LLM eval scores one input→output. Agent eval scores a trajectory — the path, not just the destination. aptkit captures the whole path in an artifact and scores that.

```
  LLM eval (one call):       Agent eval (a trajectory):
  ┌──────────────┐           ┌──────────────────────────┐
  │ input        │           │ was the right tool called?│
  │ → output     │           │ in the right order?       │
  │ → score      │           │ did it recover from errors│
  └──────────────┘           │ how many steps / $ / ms?  │
                             │ was the final output good?│
                             └──────────────────────────┘
```

### Move 2 — the pipeline, scorer by scorer

**Capture: the replay artifact holds the trajectory.** A run produces an artifact (`artifacts/replays/*.json`) with the output, the `trace` (the `CapabilityEvent` stream — every `tool_call_start/end`, `model_usage`), the `eval`, and `modelTurns`. The trace IS the trajectory; capturing it is what makes trajectory eval possible offline.

**Score: aptkit has four scorer shapes** (`packages/evals`):
- **`structural-diff`** — rule-based shape assertion: does the output match the expected structure? Catches schema regressions deterministically.
- **`detection-scorer`** — for the anomaly agent: did it detect the right anomalies?
- **`rubric-judge`** — LLM-as-judge against a rubric, for quality dimensions a rule can't capture. (This is aptkit's offline critic — see the verifier-critic file.)
- **`precision-at-k` / `recall-at-k`** — `scorePrecisionAtK` / `scoreRecallAtK`: ranked-retrieval scorers for the rag-query agent. These score *retrieval quality* — did the right chunks rank in the top k — which is the trajectory metric that matters for agentic RAG.

**Promote: good runs become deterministic fixtures.** A promoted artifact (`fixtures/promoted/*.json`) is a recorded `ModelResponse[]` that the `FixtureModelProvider` replays exactly. So a run that was correct once becomes a regression test forever — re-run it, get the identical trajectory, assert it still passes. The promoted fixtures are *correctness baselines* (editing them changes test meaning).

```
  the replay loop — live → artifact → eval → promote → deterministic replay

  live model ──► run ──► artifact ──► eval scores it ──► promote ──┐
                                                                   │
  FixtureModelProvider ◄──── replays recorded ModelResponse[] ◄────┘
  (deterministic: same trajectory every time, no model call)
```

**Why this is the right backbone for agent eval.** The hardest part of agent eval is non-determinism — you can't regression-test a thing that gives a different trajectory each run. The replay pipeline freezes the trajectory: a promoted fixture is a *golden trajectory*. The evaluator paradox (using an LLM to grade an LLM's trajectory, via rubric-judge) is real, and aptkit's controls are exactly the recommended ones: frozen golden trajectories (the promoted fixtures), iteration caps (`maxToolCalls`), and the rule-based scorers (`structural-diff`, `precision@k`) that don't need a judge at all.

**The honest gap.** The rubric-improvement agent has no `replay:promoted` script wired into the root pipeline (the project context notes this) — the other agents do. So its eval coverage is thinner than the rest.

### Move 3 — the principle

The unit of agent evaluation is the trajectory, and the metrics that matter are task success, tool-call accuracy, trajectory efficiency (steps and cost), and recovery rate. aptkit captures all of them in the artifact and freezes correct trajectories as fixtures — turning non-deterministic agent runs into deterministic regression tests. The rule-based scorers (precision@k, structural-diff) sidestep the evaluator paradox entirely; rubric-judge is used only where a rule can't capture quality.

## Primary diagram

```
  aptkit's agent eval — full frame

  ┌─ Live run (real model) ─────────────────────────────────┐
  │  runAgentLoop → output + trace(tool calls) + modelTurns  │
  └───────────────────────────┬──────────────────────────────┘
                              ▼ artifacts/replays/*.json
  ┌─ Score (packages/evals) ──────────────────────────────────┐
  │  structural-diff (shape) · detection-scorer (anomalies) ·  │
  │  rubric-judge (LLM quality) · precision@k / recall@k       │
  │  (the trajectory: right tools? right order? good output?)  │
  └───────────────────────────┬──────────────────────────────┘
                              ▼ promote good runs
  ┌─ Deterministic replay ────────────────────────────────────┐
  │  FixtureModelProvider replays recorded ModelResponse[]      │
  │  → golden trajectory, regression test forever              │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

Agent eval is where most teams underinvest, because eval of a non-deterministic multi-step process feels impossible. aptkit's replay-centric approach is the production answer: capture the trajectory, score it with a mix of rule-based and judge-based scorers, and freeze correct trajectories as deterministic fixtures. The precision@k scorers are the standout — they evaluate the *retrieval* leg of the trajectory specifically, which is the part that determines whether an agentic-RAG answer is grounded. This is the testing backbone the whole repo hangs off; it's also the observation half of graph orchestration (the trace) discussed in SECTION C.

## Interview defense

**Q: How do you evaluate an agent?**
The unit is the trajectory, not the output — so I capture the whole run as an artifact: output, the tool-call trace, and the turn count. Then I score it with four scorer shapes — `structural-diff` for output shape, `detection-scorer` for the anomaly agent, `rubric-judge` for quality a rule can't capture, and `precision@k`/`recall@k` for the rag-query agent's retrieval leg. Correct runs get promoted to fixtures that replay deterministically, so a non-deterministic agent becomes a deterministic regression test.

```
  live run → artifact(output+trace) → score → promote → deterministic replay
```
*Anchor: freeze correct trajectories as golden fixtures — that's how you regression-test a non-deterministic agent.*

**Q: How do you avoid the evaluator paradox (LLM grading an LLM)?**
Mostly by not needing a judge: `precision@k` and `structural-diff` are rule-based, no LLM. I use `rubric-judge` only for quality dimensions a rule can't capture, and I control its bias with frozen golden trajectories and iteration caps. The promoted fixtures are the golden set.

## See also

- `02-agent-loop-skeleton.md` — the trace the artifact captures
- `03-multi-agent-orchestration/05-debate-verifier-critic.md` — rubric-judge as the offline critic
- `02-agentic-retrieval/01-agentic-rag.md` — precision@k scores this agent's retrieval
- `study-ai-engineering/` — output-quality eval and LLM-as-judge bias (cross-ref)
- `study-testing/` — the replay pipeline as the testing backbone (cross-ref)
