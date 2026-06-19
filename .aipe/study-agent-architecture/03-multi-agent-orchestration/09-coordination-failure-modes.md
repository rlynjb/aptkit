# 09 — Coordination Failure Modes

> The bill for going multi-agent, itemized. Five ways coordination breaks — and
> the surprising part: AptKit's *single-agent* controls already bound four of
> them. Coordination failure is mostly unbounded-loop failure wearing a
> multi-agent hat, and AptKit bounds its loops.

## Zoom out

Every topology in this sub-section adds coordination, and coordination is a new
surface of failure that a single agent doesn't have. There are five recurring
ones, and they're not exotic — each is some loop or some context that nobody
bounded. The useful frame: don't memorize five separate bugs; see that they're
all "a thing grew without a cap." Then notice AptKit already has the caps,
because the same caps that keep a single agent honest also bound the multi-agent
versions.

```
  The five failure modes as layers (all are "unbounded X")

  ┌─ Loop failures (something repeats forever) ───────────────────────┐
  │  1. infinite handoff   — agents pass work in a cycle              │
  │  2. tool-call cascade  — each agent fires more tool calls         │
  │  3. synthesis failure  — agent ends by asking for more, never done│
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  and ↓
  ┌─ Growth failures (something inflates) ────────────────────────────┐
  │  4. context bloat      — shared state grows into every prompt     │
  │  5. cost blowup        — N agents × M calls, concurrent           │
  └────────────────────────────────────────────────────────────────────┘
  every one is "X had no ceiling." The fix is always "give X a ceiling."
```

That reframing is the whole file: coordination failures are bounding failures.

## Structure pass

The axis is **what grew without a bound, and where the bound lives**. For each
failure, there's a specific cap that stops it — and AptKit already has most of
those caps as single-agent controls.

```
  The bounding axis: each failure ↔ its cap ↔ does AptKit have it?

  failure              the cap that stops it           AptKit has it?
  ───────────────────  ────────────────────────────    ──────────────
  infinite handoff     hop budget (max transfers)       NO* (no handoff exists)
  tool-call cascade    per-agent maxToolCalls           YES ✓
  synthesis failure    forced synthesis turn            YES ✓
  context bloat        typed message passing            YES ✓ (not blackboard)
  cost blowup          concurrency cap / budgets        PARTIAL (no fan-out yet)
  * can't occur because AptKit has no handoff; you'd add the cap when you build one
```

The seam to notice: four of five caps are *already in the single-agent kernel*.
Going multi-agent doesn't invent these controls — it reuses them and adds one
new one (the hop budget).

## How it works

### Move 1 — the mental model

The mental model is a **runaway `useEffect` / unbounded loop you've already
debugged in the browser** — every one of these failures has a frontend twin you
know by feel.

```
  The runaway-loop mental model (the topology IS this picture)

  failure                  its frontend twin
  ─────────────────────    ────────────────────────────────────────
  infinite handoff     ≈   two components setState-ing each other forever
  tool-call cascade    ≈   a list that fetches on every item, unthrottled
  synthesis failure    ≈   a promise that never resolves (awaiting more data)
  context bloat        ≈   a global store every component reads → giant renders
  cost blowup          ≈   Promise.all over 1000 fetches → rate-limit wall

  you fix all of these the same way: PUT A CEILING ON IT.
```

For a frontend reader: you've shipped the infinite-render bug where two effects
each trigger the other's state update. You've throttled a list that fired a
fetch per row. You've added a timeout to a promise that hung. Coordination
failures are those same bugs at the agent layer, and the fixes rhyme: a counter,
a throttle, a forced resolution, a typed boundary.

### Move 2 — step by step (each failure, its bound, a diagram)

**Failure 1 — infinite handoff (loop).**

```
  A ──handoff──► B ──handoff──► A ──handoff──► B ...   (never terminates)
  BOUND: hop counter ──► stop at maxHandoffs
```

```
runSwarm():
  for hop in 0..maxHandoffs:        # the cap
    if agent.answers(): return
    agent = agent.handoffTo
  return best_effort()              # cap tripped → stop
```

**Failure 2 — tool-call cascade (loop).**

```
  agent keeps calling tools: query → query → query → ...  (burns budget)
  BOUND: per-agent maxToolCalls ──► force final answer
```

```
loop:
  budgetSpent = toolCalls.length >= maxToolCalls   # the cap
  if budgetSpent: forceFinal = true                 # no more tools offered
```

**Failure 3 — synthesis failure (loop).**

```
  agent ends turn by saying "I need more queries" — but there are none left
  BOUND: forced synthesis turn ──► drop tools + instruct "answer NOW, don't ask"
```

```
if forceFinal:
  system += synthesisInstruction          # "you have NO more tool calls"
  response = model.complete(tools=NONE)   # can't ask for more — must answer
```

**Failure 4 — context bloat (growth).**

```
  blackboard grows: every agent's prompt swells toward the whole shared state
  BOUND: typed message passing ──► each agent sees only its typed input
```

```
investigate(anomaly: Anomaly)            # context = one Anomaly, not the world
# no shared store to inflate the prompt
```

**Failure 5 — cost blowup (growth).**

```
  N agents × M tool calls, fired concurrently ──► rate-limit / token wall
  BOUND: per-agent budgets + concurrency cap on fan-out
```

```
results = await pool(concurrency=3,      # the cap on parallelism
  anomalies.map(a => investigate(a)))    # each already budgeted 8/6
```

### Move 3 — the principle

Coordination failures are bounding failures: each is some loop or some context
that nobody capped. So the defense isn't five clever mechanisms — it's the
discipline of giving every repeating thing a ceiling and every shared thing a
narrow type. A multi-agent system is safe to the exact degree that every loop in
it (each agent's internal loop, *and* the loop between agents) has a budget, and
every handoff is a typed payload rather than a growing shared blob. If you can
point at the ceiling for each of the five, the system terminates and stays
affordable. If you can't, it doesn't.

## Primary diagram

The failure table as a defended system — each failure, its cap, and the AptKit
control that already provides it.

```
  The five failures, each with its bound and AptKit's existing control

  ┌──────────────────┬──────────────────────┬───────────────────────────────┐
  │ FAILURE          │ THE CAP              │ AptKit control (file:line)     │
  ├──────────────────┼──────────────────────┼───────────────────────────────┤
  │ infinite handoff │ hop budget           │ none yet (no handoff exists);  │
  │                  │                      │ add when building a swarm      │
  ├──────────────────┼──────────────────────┼───────────────────────────────┤
  │ tool-call cascade│ maxToolCalls         │ run-agent-loop.ts:101          │
  │                  │ (per agent)          │ budgetSpent → forceFinal       │
  ├──────────────────┼──────────────────────┼───────────────────────────────┤
  │ synthesis failure│ forced synthesis turn│ run-agent-loop.ts:102-105      │
  │                  │ (drop tools, instruct)│ + buildSynthesisInstruction:72 │
  ├──────────────────┼──────────────────────┼───────────────────────────────┤
  │ context bloat    │ typed message passing│ diagnostic-agent.ts:55         │
  │                  │ (no blackboard)      │ investigate(anomaly: Anomaly)  │
  ├──────────────────┼──────────────────────┼───────────────────────────────┤
  │ cost blowup      │ per-agent budgets +  │ maxToolCalls per agent (8/6,   │
  │                  │ concurrency cap      │ 6/4, 6/3); concurrency cap NYB │
  └──────────────────┴──────────────────────┴───────────────────────────────┘
   four of five are ALREADY bounded by single-agent controls. NYB = not yet built.
```

## Implementation in this codebase

The headline: **AptKit's single-agent controls already bound four of the five
coordination failures.** That's why staying single-agent (file 01) is cheap and
why a future multi-agent build inherits most of its safety.

1. **Tool-call cascade — bounded by per-agent `maxToolCalls`.** Each agent
   declares its own cap: monitoring, diagnostic, and query at 8 turns / **6 tool
   calls** (`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:76-77`,
   `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:73-74`),
   recommendation at **6 / 4** (`packages/agents/recommendation/src/recommendation-agent.ts:86-87`),
   rubric at **6 / 3** (`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:76-77`).
   The kernel enforces it: `budgetSpent = maxToolCalls !== undefined &&
   toolCalls.length >= maxToolCalls` (`packages/runtime/src/run-agent-loop.ts:101`)
   trips `forceFinal` (line 102). The cascade is bounded *per agent*, so a future
   pipeline's total tool spend is the sum of known caps, not unbounded.

2. **Synthesis failure — bounded by the forced synthesis turn.** When the budget
   is spent or it's the last turn, the kernel drops the tool schemas and appends
   a synthesis instruction: `tools: forceFinal ? undefined : toolSchemas`
   (`run-agent-loop.ts:106`), with the instruction built by
   `buildSynthesisInstruction` (`run-agent-loop.ts:72`) — literally "You have NO
   more tool calls available... Do not say you need more queries." An agent
   *cannot* end a run by asking for more; it's forced to answer from what it has.

3. **Context bloat — avoided by typed message passing, not a blackboard.** Each
   agent receives only its typed input —
   `investigate(anomaly: Anomaly)` (`diagnostic-agent.ts:55`),
   `propose(anomaly, diagnosis)` (`recommendation-agent.ts:64`) — and the loop's
   `messages` state is local to one run (`run-agent-loop.ts:94`). There's no
   shared blackboard to inflate every prompt (file 08), so the pipeline's context
   stays bounded by each stage's input type.

4. **Bad worker output before synthesis — caught by per-agent validators.** Each
   agent validates its structured output before anyone trusts it, e.g.
   `isDiagnosis` (`packages/agents/diagnostic-investigation/src/validate.ts:25`),
   wired in via `parseResult` with a one-shot recovery turn
   (`run-agent-loop.ts:193-198`). In a supervisor/critic build this *is* the
   "validate worker output against schema before synthesis" control — present
   today, per agent.

5. **Infinite handoff — cannot occur (no handoff exists).** AptKit has no
   agent-to-agent handoff, so this failure is impossible today. The honest gap:
   if you build a swarm (file 06), the per-agent budgets above bound each agent's
   *internal* loop but *not* the hop count between agents — you'd add a new hop
   budget. That's the one cap AptKit doesn't already have.

6. **Cost blowup — partially bounded.** Per-agent budgets cap each agent's spend,
   so sequential runs are bounded. But fan-out concurrency (file 04) isn't built,
   so there's no concurrency cap yet — that's the not-yet-built piece, owned by
   `../05-production-serving/`.

The honest one-liner: four of five coordination failures are already bounded by
controls AptKit needs *anyway* for a single agent; going multi-agent adds
exactly one new required cap (the handoff hop budget) and one serving control
(fan-out concurrency).

## Elaborate

The deep reason single-agent controls transfer so well: a multi-agent system is
loops-within-loops, and a loop is a loop wherever it sits. The discipline that
keeps one agent's tool loop bounded (a tool-call budget) is the *same* discipline
that keeps a pipeline's total spend bounded (the sum of those budgets) and a
swarm's interaction bounded (a hop budget on top). AptKit's bet — bound every
loop, type every handoff — is not a single-agent convenience that you'd throw
away when scaling up. It's the foundation the multi-agent version stands on.

This is also the strongest version of the file-01 argument. The reason staying
single-agent is cheap *and* the reason going multi-agent later is safe are the
*same* reason: the controls are already there. You don't pay twice. The budgets,
the forced synthesis, the validators, and the typed handoffs are dual-purpose —
they keep today's single agents honest and pre-bound tomorrow's coordination.

## Interview defense

**Q: "What breaks when you go multi-agent, and how would AptKit cope?"**

"Five things, and they're all 'something looped or grew without a cap.' Infinite
handoff — agents cycle work forever; bound it with a hop budget, which AptKit
lacks because it has no handoff yet. Tool-call cascade — each agent fires more
tool calls; AptKit already caps this per agent with `maxToolCalls`, enforced in
the kernel at `run-agent-loop.ts:101`. Synthesis failure — an agent ends by
asking for more data; AptKit's forced synthesis turn drops the tools and forbids
asking, `run-agent-loop.ts:102-105`. Context bloat — a shared blackboard swells
every prompt; AptKit uses typed message passing, so each agent sees only its
input. Cost blowup — N agents firing concurrently; per-agent budgets bound
sequential spend, and I'd add a concurrency cap for fan-out. The headline: four
of five are already bounded by controls I need for a single agent anyway — going
multi-agent adds one new cap, the hop budget."

```
  The one-line defense
  coordination failure = unbounded loop/growth ; AptKit already caps 4 of 5
  (maxToolCalls, forced synthesis, validators, typed handoff); add hop budget for swarm
```

Anchor: `run-agent-loop.ts:101` (cascade cap), `run-agent-loop.ts:102-105` + `:72`
(synthesis), `diagnostic-agent.ts:55` (typed handoff = no bloat),
`validate.ts:25` (bad-output gate), per-agent `maxToolCalls` (8/6, 6/4, 6/3).

## Validate your understanding

1. **Spot the cascade cap.** Read `run-agent-loop.ts:101`. Confirm
   `toolCalls.length >= maxToolCalls` trips `forceFinal` (line 102), and find the
   per-agent values (e.g. `recommendation-agent.ts:86-87` → 6/4).

2. **Spot the synthesis bound.** Read `run-agent-loop.ts:102-106` and
   `:72`. Explain how an agent is *prevented* from ending by asking for more
   data. (Tools dropped + instruction forbids it.)

3. **Spot the bloat avoidance.** Read `diagnostic-agent.ts:55` and
   `run-agent-loop.ts:94`. Why does AptKit's pipeline not suffer context bloat?
   (Typed input per agent; loop state is local — no shared blackboard.)

4. **Find the one missing cap.** Which failure has *no* existing AptKit control,
   and why is that okay today? (Infinite handoff — there's no handoff to cap;
   you'd add a hop budget when building a swarm, file 06.)

## See also

- `01-when-not-to-go-multi-agent.md` — the 2-5x tax this file itemizes; why the
  shared controls make both staying and scaling cheap
- `06-swarm-handoff.md` — the infinite-handoff failure and the hop budget
- `08-shared-state-and-message-passing.md` — context bloat (blackboard) vs typed
  message passing
- `04-parallel-fan-out.md` — cost blowup and the concurrency cap
- `../04-agent-infrastructure/05-guardrails-and-control.md` — the control
  envelope (budgets, forced synthesis, validators) in full
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel where the
  budget and synthesis caps live
