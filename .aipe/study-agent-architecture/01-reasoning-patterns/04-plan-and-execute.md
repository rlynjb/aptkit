# 04 — Plan-and-Execute

*Plan-and-execute (a.k.a. plan-and-solve, planner-executor) — Industry standard
(LangChain "Plan-and-Execute" agents; BabyAGI-lineage).*

## Zoom out, then zoom in

This pattern is *not in AptKit.* Place the empty slot honestly before describing
what would fill it.

```
  The reasoning family, with the empty slot marked

  ┌─ reasoning patterns ─────────────────────────────────────┐
  │   chain                                                   │
  │   ReAct ───────────── all 5 agents (base case)            │
  │   ★ plan-and-execute ★ ── NOT BUILT  ← we are here, empty │
  │   reflexion ───────── rubric agent                        │
  │   tree-of-thoughts ── NOT BUILT                           │
  └──────────────────────────────────────────────────────────┘
```

So why spend a file on a slot that's empty? Because knowing *when you'd reach
for it* is the staff-level skill, and because the moment AptKit grows a live
monitor→diagnose→recommend orchestrator, the planner question becomes real.
Right now the pipeline is *latent* — wired by data contracts, not by a runtime
planner (see `../03-multi-agent-orchestration/03-sequential-pipeline.md`). That
latent pipeline is, in a sense, a *hand-coded plan*: a human decided "scan, then
diagnose, then recommend" and wrote it as a fixed order. Plan-and-execute is
what you build when you want the *model* to write that order instead of you.

Frontend anchor: ReAct is `useReducer` where you dispatch one action, see the
result, decide the next. Plan-and-execute is "compute the entire list of actions
up front, then run them" — like building an array of operations and then
`for`-looping over it. The plan is a value you hold; the executor consumes it.

## Structure pass

Trace the **control axis** — "when is the sequence of steps decided" — to see
exactly how plan-and-execute differs from ReAct.

```
  Control axis: WHEN the step sequence is chosen

  Pattern             Step sequence decided…           Re-decides mid-run?
  ──────────────────  ───────────────────────────────  ───────────────────
  ReAct               one step at a time, each turn     yes, every turn
  ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ◄ SEAM
  plan-and-execute    ALL up front, in a plan phase     only on replan
```

The seam is the plan phase. In ReAct there's no plan phase — the model decides
the next step using all evidence so far, every turn, which is *adaptive* but can
*lose the thread* over long horizons. Plan-and-execute moves the deciding to the
front: one model call produces the whole list, then a cheaper executor runs each
item. You trade adaptivity for a coherent long-horizon structure.

## How it works

### Move 1 — the mental model

Two phases: a **planner** (one model call that emits an ordered list of
sub-tasks) and an **executor** (runs each sub-task, often as its own small ReAct
loop), with an optional **replan** when reality diverges from the plan.

```
  Plan-and-execute = plan phase, then execute phase

  user goal
     │
     ▼
  ┌─────────┐   ordered list of steps   ┌────────────────────────┐
  │ PLANNER │ ───────────────────────▶  │ EXECUTOR (per step)     │
  │ 1 call  │   [s1, s2, s3]            │  run s1 → run s2 → s3   │
  └─────────┘                           │  each step = mini-ReAct  │
       ▲                                └───────────┬─────────────┘
       │ replan if a step fails / surprises          │
       └─────────────────────────────────────────────┘
                                                     ▼
                                                 final answer
```

### Move 2 — the moving parts

**The plan phase**

```
  planner call: "decompose this goal into ordered steps"
       │
       ▼
  plan = ["query revenue by segment", "check campaign calendar",
          "correlate", "write diagnosis"]     ← a VALUE, held in memory
```

Pseudocode: `plan = await model.complete({ system: plannerPrompt, ...})` parsed
into a list. This is one extra model call ReAct doesn't make. Its payoff is a
coherent skeleton the executor follows instead of re-deciding every turn.

**The execute phase**

```
  for step in plan:
     result = runStep(step)        ← often a small ReAct loop itself
     accumulate result
```

Pseudocode: a loop over the plan, each item executed (frequently by *reusing*
`runAgentLoop` with that single sub-task as the prompt). The executor can be
dumber/cheaper than the planner because the hard thinking already happened.

**The replan loop**

```
  step failed OR returned a surprise
       │
       ▼
  feed (plan-so-far + new fact) back to planner ──▶ revised plan
```

Pseudocode: `if surprised: plan = await replan(plan, results)`. Without replan,
plan-and-execute is brittle — the world changes and the stale plan marches on.
With it, you've reinvented an outer ReAct loop around an inner plan, which is
why the patterns blur at the edges.

### Move 3 — the principle

Plan-and-execute buys long-horizon coherence by deciding the whole sequence up
front — pay for it only when ReAct *measurably* loses the thread over many steps.

## Primary diagram

The two-phase shape with the replan back-edge, and the named-failure gate that
should precede building it.

```
  Plan-and-execute — full shape (NOT in AptKit)

  named failure: "ReAct loses thread / redoes work over 10+ steps"
        │ (only build it if you saw THIS)
        ▼
  ┌─────────┐                 ┌──────────────────────────────┐
  │ PLANNER │ ──[s1..sN]────▶ │ EXECUTOR: run each step       │
  │ 1 model │                 │  s1→s2→…  (each a mini-ReAct)  │
  │  call   │ ◀──replan────── │  on surprise, ask to replan   │
  └─────────┘                 └───────────────┬──────────────┘
                                              ▼
                                          final answer
```

AptKit's box for this is empty; the diagram is what you'd draw on the whiteboard.

## Implementation in codebase

**Not yet implemented.** AptKit has no separate plan phase anywhere — every
capability is a single bare ReAct loop (`runAgentLoop` called once per
capability, no planner call preceding it). The closest thing is the
*hand-coded* pipeline order encoded in the data contracts (`Anomaly` →
`Diagnosis` → `Recommendation`, consumed by `investigate(anomaly)` at
`diagnostic-agent.ts:55` and `propose(anomaly, diagnosis)` at
`recommendation-agent.ts:64`) — a human wrote that plan, not a model.

When AptKit *would* reach for it: the day someone wants the system to handle an
open-ended request like *"figure out why Q3 revenue is soft and tell me what to
do,"* where the number and order of sub-investigations isn't known in advance
and a single ReAct loop would lose coherence across a dozen queries. At that
point you'd add a planner that decomposes the goal into scan/diagnose/recommend
sub-tasks and an executor that runs each — and the executor could *reuse*
`runAgentLoop` per sub-task. The build template for this lives in
`../06-orchestration-system-design-templates/` (the multi-agent research
assistant template is the closest fit).

## Elaborate

**Origin.** Plan-and-execute crystallized from BabyAGI / AutoGPT (2023) — "make
a task list, work the list" — and was formalized in LangChain's
Plan-and-Execute agents and the "Plan-and-Solve" prompting paper (Wang et al.,
2023), which showed planning-then-solving beat plain CoT on multi-step
arithmetic and reasoning.

**Adjacent concepts.** Plan-and-execute with a replan edge converges toward
ReAct-with-memory; the meaningful distinction is *whether a full plan exists as
an artifact.* It's also the natural home of a *supervisor* in multi-agent
systems — the planner becomes the supervisor, each step a worker
(`../03-multi-agent-orchestration/`). And the hand-coded version of "the plan" is
just a chain (`01-chains-vs-agents.md`) — which is exactly what AptKit's latent
pipeline is today.

## Interview defense

**Q: "Your codebase is ReAct. When would you add a planner?"**

```
  the gate, drawn

  ReAct loses coherence over many steps?  ──NO──▶  don't build it
        │
        YES ──▶ add plan phase: 1 planner call → executor runs the list
```

Anchor: "I add a planner the day a single ReAct loop measurably loses the thread
over a long horizon — not before; today AptKit's investigations are short, so
the plan is hand-coded as a data contract."

**Q: "Difference between plan-and-execute and ReAct in one line?"**

```
  ReAct:  decide next step every turn   (adaptive, can drift)
  P&E:    decide ALL steps up front      (coherent, can go stale → replan)
```

Anchor: "Plan-and-execute front-loads the deciding into one plan artifact;
ReAct decides one step at a time." Surfaces the skeleton part: P&E is the kernel
*wrapped twice* — a planner call, then `runAgentLoop` per step.

## Validate

- **Reconstruct:** Draw the planner→executor→replan shape from memory; mark
  which box would reuse `runAgentLoop`.
- **Explain:** Why is AptKit's `Anomaly`→`Diagnosis`→`Recommendation` chain
  *not* plan-and-execute? (the plan is hand-coded by a human as a data contract;
  no model produced the step list; see `diagnostic-agent.ts:55`,
  `recommendation-agent.ts:64`.)
- **Apply:** A user asks an open-ended "diagnose Q3 and recommend fixes." Sketch
  the planner output and how the executor reuses `runAgentLoop` per step.
- **Defend:** Argue against adding a planner *today.* (No measured long-horizon
  failure; current investigations fit inside one 8-turn budget; a planner adds a
  model call and a stale-plan failure mode for no observed gain.)

## See also

- [03-react.md](03-react.md) — the base case you'd escalate *from*
- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — the kernel an executor
  would reuse per step
- `../03-multi-agent-orchestration/03-sequential-pipeline.md` — the latent
  hand-coded "plan" AptKit has today
- `../06-orchestration-system-design-templates/` — where you'd build the live
  planner version
