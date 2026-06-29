# Agent Evaluation

**Industry term:** agent evaluation (trajectory eval, not just output eval). *Industry standard.*

## Zoom out, then zoom in

Evaluating an agent is harder than evaluating one LLM call, because the unit of evaluation is the *trajectory* — what tools were called, in what order, did it recover — not just the final output. aptkit's replay-centric backbone captures exactly this.

```
  Zoom out — eval over the trace, not just the answer

  ┌─ Eval layer (@aptkit/evals) ────────────────────────────────┐
  │  replay-runner → structural-diff / detection-scorer /        │ ← we are here
  │  rubric-judge / precision-at-k, over the trace + output      │
  └───────────────────────────────┬──────────────────────────────┘
                                   │ reads replay artifacts (output + trace + modelTurns)
  ┌─ Artifacts ─────────────────────▼───────────────────────────┐
  │  live run → artifact → eval → promote to fixture → replay     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit's loop emits a `CapabilityEvent` trace (`step`, `tool_call_start/end`, `model_usage`), and a run is saved as a replay artifact carrying the output, the trace, and `modelTurns`. The evals package scores both the output and the trajectory. That replay loop — live run → artifact → eval → promote to fixture → deterministic replay — is the testing and observability backbone.

## The structure pass

**Layers.** Output eval (was the answer good?) over trajectory eval (was the *path* good?).

**Axis: guarantees — what's actually being asserted?** Output eval asserts answer quality; trajectory eval asserts tool-call correctness, ordering, and recovery.

**The seam.** The replay artifact. It freezes a run (output + trace + model turns) so eval is deterministic and repeatable — the boundary between a live nondeterministic run and a reproducible test.

## How it works

**Use case in aptkit:** regression-proofing the agents. A run is recorded, scored, and (when correct) promoted to a fixture that replays deterministically — so a prompt change that breaks tool-call behavior is caught.

### Move 1 — what expands

A single LLM call evals input → output → score. An agent evals the whole trajectory.

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

### Move 2 — the walkthrough

**The replay artifact captures the trajectory, not just the output.** An artifact carries `capabilityId`, the per-capability output, the `trace` (the `CapabilityEvent` stream), and `modelTurns`. So eval can ask trajectory questions — which tools were called, did a tool error, how many turns — not just "was the answer right."

**The scorers, matched to what's being evaluated.** aptkit's evals package (`@aptkit/evals`) holds several:
- `structural-diff` — rule-based diff of the output shape against an expected artifact.
- `detection-scorer` — for the anomaly agent, did it detect the right anomalies.
- `rubric-judge` — an LLM-as-judge over a rubric (the eval-time critic, with the self-preference-bias caveat from [../03-multi-agent-orchestration/05-debate-verifier-critic.md](../03-multi-agent-orchestration/05-debate-verifier-critic.md)).
- `precision-at-k` / `recall-at-k` (`scorePrecisionAtK` / `scoreRecallAtK`) — ranked-retrieval scorers for the RAG agent.

The retrieval scorers are the trajectory-eval angle for agentic RAG: they grade *what was retrieved*, the load-bearing step before the answer.

**Promote-to-fixture is how trajectory eval becomes a deterministic test.** A correct live run is promoted to a fixture (`fixtures/promoted/*.json`), and a `FixtureModelProvider` replays the recorded `ModelResponse[]` deterministically. So the *exact* trajectory — same tool calls, same order — replays without a live model. That's how aptkit catches "this prompt change made the agent stop calling the search tool": the replayed trajectory diverges from the promoted baseline.

**The honest gap.** aptkit doesn't compute the full trajectory-efficiency metric suite (steps-to-completion trends, recovery-rate over a set) as a dashboard — the building blocks (trace, `model_usage` for cost, tool-call records) are all captured, but they're scored per-artifact, not aggregated into trajectory-efficiency KPIs across runs. And `rubric-improvement` has no `replay:promoted` script wired into the root pipeline (the others do). `not yet exercised` as a cross-run efficiency dashboard.

**The evaluator paradox.** Using an LLM (`rubric-judge`) to grade an LLM's trajectory is real; the controls are frozen golden trajectories (the promoted fixtures), iteration caps (the loop's budget), and human spot-checks (the Studio replay UI). aptkit leans hardest on the *frozen-trajectory* control — deterministic replay against a promoted baseline — which doesn't depend on a judge model at all.

### Move 3 — the principle

The unit of agent evaluation is the trajectory, not the output — and the way to make a nondeterministic trajectory testable is to freeze it. aptkit's promote-to-fixture loop is exactly that: a correct run becomes a deterministic replay baseline, so a regression in tool-call behavior is caught without a live model. The metrics that matter — task success, tool-call accuracy, trajectory efficiency, recovery rate — are all derivable from the trace aptkit already captures.

## Primary diagram

```
  aptkit's replay-centric eval — the trajectory is the unit

  live run ─► artifact { output, trace (CapabilityEvent), modelTurns }
                 │
                 ▼  scorers (@aptkit/evals)
        structural-diff · detection-scorer · rubric-judge · precision-at-k
                 │ passes?
                 ▼
        promote to fixture (frozen golden trajectory)
                 │
                 ▼
        FixtureModelProvider replays the EXACT trajectory deterministically
        → a prompt change that alters tool calls diverges from the baseline = caught
  (cross-run efficiency dashboard: not yet exercised)
```

## Elaborate

Agent eval is where most teams under-invest, because output eval feels sufficient until a prompt tweak silently changes *how* the agent gets the answer — wrong tool, extra turns, a recovery that used to fire and now doesn't. Trajectory eval catches that, and the cheapest robust form is a frozen golden trajectory you replay deterministically. aptkit's promote-to-fixture loop is a clean instance: it turns a verified run into a regression test that asserts the whole path, not just the endpoint. The LLM-as-judge scorer (`rubric-judge`) is there for the cases a rule can't grade, with the frozen fixtures as the bias-free backstop.

## Interview defense

**Q: How do you evaluate an agent, not just a model call?**

Over the trajectory. aptkit records each run as a replay artifact carrying the output *and* the trace — which tools fired, in what order, with what cost. The scorers grade both (structural-diff, detection, rubric-judge, precision@k). The key move is promote-to-fixture: a verified run becomes a frozen golden trajectory that replays deterministically, so a prompt change that alters tool-call behavior diverges from the baseline and gets caught — no live model needed.

```
  output eval:     was the answer right?
  trajectory eval: right tools, right order, recovered? (the agent unit)
  frozen fixture:  deterministic replay = the bias-free regression test
```

*Anchor: freeze the trajectory; a promoted fixture asserts the whole path, not just the endpoint.*

## See also

- [../03-multi-agent-orchestration/05-debate-verifier-critic.md](../03-multi-agent-orchestration/05-debate-verifier-critic.md) — rubric-judge as the eval-time critic.
- [../02-agentic-retrieval/02-self-corrective-rag.md](../02-agentic-retrieval/02-self-corrective-rag.md) — precision@k as offline retrieval grading.
- LLM-as-judge bias and output-quality eval: `.aipe/study-ai-engineering/05-evaluation/`.
