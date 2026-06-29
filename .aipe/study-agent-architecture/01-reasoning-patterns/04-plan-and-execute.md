# Plan-and-Execute

**Industry standard.** "Plan-and-execute," "planner-executor," "decompose-then-run." Type label: reasoning pattern. **In this codebase: not yet implemented** — aptkit's agents are pure ReAct; no agent builds a plan up front before executing. Single-agent ReAct hasn't hit a planning-quality ceiling, so the escalation hasn't been made.

## Zoom out, then zoom in

Plan-and-execute separates *deciding the strategy* from *doing the work*. One expensive call builds the whole plan; cheap calls run each step without re-deciding the approach. aptkit doesn't do this — but it's the first rung on the escalation ladder above ReAct, so it's worth seeing where it would slot in.

```
  Zoom out — where plan-and-execute WOULD sit in aptkit

  ┌─ Pattern family (SECTION A) ────────────────────────────┐
  │  ReAct → ★ plan-and-execute ★ → reflexion → ToT          │ ← would-be here
  │  (aptkit is here)  (not yet exercised)                   │
  └───────────────────────────┬──────────────────────────────┘
                              │ would still run on
  ┌─ Loop layer ──────────────▼──────────────────────────────┐
  │  runAgentLoop (the same kernel; a plan phase added front) │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: where does reasoning live?** ReAct interleaves it; plan-and-execute pulls it out front. **The seam** is between the plan phase (one expensive reasoning call) and the execute phase (many cheap calls). aptkit has no such seam — its recommendation agent reasons and acts in the same loop. The recommendation agent is the closest candidate to refactor, because its task (build evidence across 13 tools, then propose) *has* a predictable structure a plan could capture.

## How it works

### Move 1 — the mental model

You know how you'd write a `.then()` chain when you know the steps, versus a `while` loop when you don't? Plan-and-execute is: use an expensive model *once* to write the `.then()` chain at runtime, then run it with a cheap model. Strategy and grunt work, decoupled.

```
  Plan-and-execute — split the strategy from the doing

  ┌─ Plan phase (expensive model, once) ────────────┐
  │  build full plan: [step1, step2, step3]         │
  └──────────────────┬───────────────────────────────┘
                     │  plan
                     ▼
  ┌─ Execute phase (cheap model, per step) ─────────┐
  │  run step1 → step2 → step3 (no re-planning)     │
  │  re-plan trigger ONLY if a step diverges         │
  └───────────────────────────────────────────────────┘
```

### Move 2 — what it would take in aptkit

aptkit's recommendation agent today is ReAct: the model queries tools in whatever order it picks, accumulating evidence, then proposes. To make it plan-and-execute, you'd split `propose()` (`recommendation-agent.ts:64`) into two loops:

**Plan loop.** One `runAgentLoop` call (or one `model.complete`) with the expensive provider, output = a structured list of which tools to query for this diagnosis. The diagnosis is already passed in (`recommendation-agent.ts:74`), so the plan input exists.

**Execute loop.** Run the planned queries with a cheaper provider (the Gemma local model, say), then synthesize. The synthesis step is already the forced-final turn — that part wouldn't change.

```
  Recommendation agent refactor — ReAct → plan-and-execute (would-be)

  TODAY (ReAct):
    runAgentLoop ─ model picks tools ad hoc ⇄ accumulate ─ synthesize

  REFACTORED:
    plan(diagnosis) ─expensive─► [get_metric_timeseries, get_segments, ...]
        │
        ▼
    execute each ─cheap─► evidence ─► synthesize (existing forced-final turn)
```

**The tradeoff that makes aptkit right to wait.** Plan-and-execute beats ReAct on *structured* tasks where the path is predictable — but it's brittle when plan assumptions break mid-execution (a planned tool returns nothing, and the plan has no branch). The mitigation is a re-plan trigger, which adds back much of ReAct's adaptivity *plus* the planning overhead. aptkit's recommendation task isn't structured enough to justify that yet — the model's ad-hoc tool order works, and `maxToolCalls: 4` already bounds the cost. You escalate when planning *quality* becomes the bottleneck, not before.

### Move 3 — the principle

ReAct for dynamic/exploratory tasks where the path can't be predicted; plan-and-execute for structured tasks where it can. aptkit's tasks are exploratory enough that ReAct is the right call. The day a task becomes "always query these five tools in this order," that's the signal to plan.

## Primary diagram

```
  Plan-and-execute — the general shape (not yet in aptkit)

  input ─► ┌─ PLAN (expensive, once) ──────────┐
           │  decompose into ordered steps     │
           └──────────────┬─────────────────────┘
                          ▼  plan = [s1, s2, s3]
           ┌─ EXECUTE (cheap, per step) ───────┐
           │  s1 → s2 → s3                     │
           │  diverged? ─► re-plan              │
           └──────────────┬─────────────────────┘
                          ▼
                       output
```

## Elaborate

Plan-and-execute was a response to ReAct burning expensive-model calls on every step of a long, predictable task. The fix: pay for the expensive model once (the plan), run the rest cheap. aptkit's provider layer would make the cheap/expensive split trivial — `ModelProvider` is swappable, so the plan loop could use Anthropic and the execute loop could use Gemma. The infrastructure is ready; the need isn't there.

## Interview defense

**Q: Do your agents plan?**
No — they're ReAct, reasoning and acting interleaved. I considered plan-and-execute for the recommendation agent because its task has structure, but its tool order is exploratory enough that ad-hoc ReAct works and `maxToolCalls: 4` bounds the cost. I'd split it into plan/execute loops the day planning quality became the bottleneck — and my swappable provider layer would let the plan run on an expensive model and the execute steps on a cheap one.

```
  plan (expensive, once) → execute (cheap, per step) → re-plan on divergence
```
*Anchor: escalate to planning when path *quality* is the failure, not before.*

## See also

- `03-react.md` — the pattern aptkit actually runs
- `03-tool-calling-and-mcp.md` (SECTION D) — the swappable provider layer that makes cheap/expensive splitting cheap
- `06-orchestration-system-design-templates/03-agentic-coding-system.md` — where plan-and-execute is the standard architecture
