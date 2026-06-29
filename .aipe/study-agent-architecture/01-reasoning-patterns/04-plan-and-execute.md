# Plan-and-Execute

**Industry term:** plan-and-execute (plan up front, then run the plan). *Industry standard.*

## Zoom out, then zoom in

The first escalation past ReAct. Instead of re-deciding the whole approach every turn, you build a plan once with an expensive model, then run each step with a cheap one.

```
  Zoom out — where it would sit (not built in aptkit)

  ┌─ Reasoning-pattern family ──────────────────────────────────┐
  │   ReAct (aptkit runs this)                                   │
  │   ★ plan-and-execute ★  ← study material; not in aptkit      │ ← we are here
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit does not use plan-and-execute. Its loop re-decides per turn (ReAct). This file teaches the pattern and names the specific aptkit capability that would adopt it first if its path grew.

## The structure pass

**Layers.** A plan phase (outer, one expensive call) and an execute phase (inner, many cheap calls).

**Axis: cost — where is the expensive reasoning spent?** ReAct spreads it across every turn; plan-and-execute concentrates it into one planning call.

**The seam.** The plan boundary. Once the plan is fixed, the execute phase doesn't re-plan — which is the win (no re-deciding) and the risk (no branch when a step fails).

## How it works

**Use case it would fit in aptkit:** none today, honestly. The closest *future* fit is the recommendation flow if it grew from "gather evidence, propose" into a long structured task with known sub-steps. Right now its path is too short to justify a planning phase.

### Move 1 — the mental model

It's the difference between writing a recipe before you cook versus deciding the next ingredient mid-stir. ReAct stirs and decides. Plan-and-execute writes the recipe once, then a line cook runs it.

```
  ┌─ Plan phase ──────────────────────────────────┐
  │  Expensive model builds the full plan up front │
  │  (list of steps, dependencies)                 │
  └──────────────────┬─────────────────────────────┘
                     │  plan: [step1, step2, step3]
                     ▼
  ┌─ Execute phase ───────────────────────────────┐
  │  Cheap/fast model runs each step               │
  │  (no re-planning per step)                     │
  └────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Why it beats sequential ReAct on structured tasks.** You decouple strategy (one expensive call) from grunt work (many cheap calls), and you stop re-deciding the whole approach on every loop. For a long task with known sub-steps, ReAct wastes tokens re-reasoning the plan it already implicitly has.

**The brittleness.** When a step's assumption breaks mid-execution and the plan has no branch for it, plan-and-execute stalls. The mitigation is a re-plan trigger: when execution diverges from the plan, kick back to the planner. aptkit has nothing like this — its `runAgentLoop` has no plan object and no re-plan path.

**What adopting it would cost in aptkit.** You'd add a planning call before the loop, a plan data structure threaded through state, and a divergence check that can re-enter the planner. That's real new infrastructure on top of `runAgentLoop`, justified only if a capability's path got long and structured. See `06-orchestration-system-design-templates/03-agentic-coding-system.md` for where this pattern is the natural fit.

### Move 3 — the principle

ReAct for dynamic, exploratory tasks where the path can't be predicted; plan-and-execute for structured tasks where it can. The breakpoint is predictability of the step sequence, not task difficulty.

## Primary diagram

```
  Plan-and-execute vs aptkit's ReAct

  plan-and-execute:  PLAN (expensive, once) ─► step ─► step ─► step
                                                │ divergence?
                                                └─► re-plan (mitigation)

  aptkit today:      no plan ─► ReAct turn ─► ReAct turn ─► ...
                     (re-decides every turn; bounded by budget)
```

## Elaborate

Plan-and-execute showed up as a fix for ReAct's tendency to lose the thread on long tasks — by turn 8 a ReAct agent has re-derived its strategy eight times and may have drifted. Pinning the plan once stops the drift. The cost is rigidity, which the re-plan trigger buys back partially. For aptkit's short-path capabilities, the rigidity isn't worth it yet.

## Interview defense

**Q: Why doesn't aptkit use plan-and-execute?**

The capability paths are too short to justify a planning phase. Recommendation gathers evidence and proposes — three or four tool calls. ReAct's per-turn re-deciding costs nothing at that length. Plan-and-execute earns its keep on long structured tasks where ReAct drifts; aptkit has none yet.

*Anchor: the breakpoint is path length and predictability, not "is the task hard."*

## See also

- [03-react.md](03-react.md) — the baseline this escalates from.
- [05-reflexion-self-critique.md](05-reflexion-self-critique.md) — the other escalation.
- [../06-orchestration-system-design-templates/03-agentic-coding-system.md](../06-orchestration-system-design-templates/03-agentic-coding-system.md) — where plan-and-execute is the natural fit.
