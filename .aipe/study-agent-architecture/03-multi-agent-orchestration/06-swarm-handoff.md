# 06 — Swarm / Handoff

> Peers handing work to each other with no boss. The most flexible topology and
> the most dangerous one — its signature failure is two agents handing the same
> task back and forth forever. Not exercised in AptKit; taught in full, then
> pointed to SECTION F.

## Zoom out

A swarm is supervisor-worker with the supervisor removed. Instead of a boss
routing work, each agent decides on its own whether it can handle the current
task or should *hand off* to a peer better suited to it. Control moves with the
work — there's no central place holding the plan. This is how "transfer me to
the right department" support systems are built: the triage agent hands to
billing, billing hands to refunds, refunds answers. Maximum flexibility, because
any agent can route to any other; minimum control, because nobody owns the
whole interaction.

```
  Swarm as layers (note: no coordination layer above the peers)

  ┌─ Peer layer (flat — no boss) ─────────────────────────────────────┐
  │   agent A ──handoff──► agent B ──handoff──► agent C                │
  │      ▲                                          │                  │
  │      └────────────── handoff ───────────────────┘  (can cycle!)    │
  │   each peer: "can I handle this? if not, who can?"                 │
  └────────────────────────────────────────────────────────────────────┘
  control + context travel WITH the conversation; no central plan holder
```

The missing layer is the point: there's no supervisor whose budget bounds the
whole thing. That absence is the source of both the flexibility and the danger.

## Structure pass

The axis is **who holds control**. Supervisor-worker: the boss always reholds
control after each worker (file 02). Swarm: control *transfers* and may never
return. The seam is the handoff itself — and the dangerous property is that the
handoff graph can contain a cycle.

```
  The control-holding axis

  SUPERVISOR-WORKER                    SWARM / HANDOFF
  ────────────────────────►            ◄──────────────────────────────
  boss reholds control each turn       control transfers to the peer
  one budget (boss) bounds all          no central budget bounds the chain
  acyclic by construction (boss→worker) handoff graph CAN cycle (A→B→A)
  → bounded, easier to debug            → flexible, can loop forever ★
```

The whole risk lives in that bottom-right cell: A hands to B, B decides A is
better suited, hands back to A, A hands to B... nobody's wrong on any single
step, and the system never terminates.

## How it works

### Move 1 — the mental model

The mental model is a **phone tree where each operator can transfer you to any
other operator** — and nobody tracks how many transfers you've had.

```
  The phone-transfer mental model (the topology IS this picture)

  you ──► triage op ──"let me transfer you"──► billing op
                                                   │
                            "actually that's refunds"
                                                   ▼
                                              refunds op ──"that's billing"──┐
                                                   ▲                          │
                                                   └──────────────────────────┘
                                                        (the infinite transfer)
  each operator decides the next transfer; no one owns your call end-to-end
```

For a frontend reader: imagine a wizard where each step can `navigate()` to *any
other step*, and the steps decide among themselves where you go next, with no
parent router and no step counter. Powerful — a step can shortcut you straight
to the end. But with no guard, two steps can bounce you between them forever.
You'd never ship that wizard without a max-navigation counter. Swarm is that
wizard, and the counter is the handoff budget.

### Move 2 — step by step

**Step 1 — an agent receives the task and self-assesses.**

```
  assess: (task, context) ──► "I'll handle it" | "hand off to peer X"
```

```
handle(task, context):
  if can_handle(task): return reactLoop(myPrompt, myPolicy, budget)
  else: return HANDOFF(pick_peer(task), task, context)
```

**Step 2 — handoff transfers control AND context to the peer.**

```
  handoff: (peer, task, context) ──► peer.handle(task, context)
  ┌──────────────────────────────────────────────┐
  │ the WHOLE conversation/context moves to peer;  │
  │ the handing agent is now out of the loop       │
  └──────────────────────────────────────────────┘
```

```
runSwarm(task):
  agent = entryAgent
  context = { task, history: [] }
  for hop in 0..maxHandoffs:          # ★ the only thing preventing infinity
    outcome = agent.handle(task, context)
    if outcome.is_answer: return outcome.answer
    agent = outcome.handoffTo         # control moves
    context.history.push(hop)
  return best_effort(context)         # handoff budget exhausted → stop
```

**Step 3 — terminate (an agent answers, or the handoff budget trips).**

```
  terminate: answer produced  |  maxHandoffs reached ──► stop + best effort
```

### Move 3 — the principle

Swarm trades all central control for routing flexibility, and the bill is
termination. With no supervisor, there is no single budget bounding the
interaction — so you *must* impose a **handoff budget** (a max number of hops)
or the system can cycle forever. The discipline is: cap the hops, make handoff a
typed transfer (so the receiving peer gets a clean context, not a mess), and
prefer a swarm only when routing genuinely needs to be peer-decided rather than
boss-decided. If a boss can make the routing call, use supervisor-worker — it's
bounded by construction. Reach for swarm when the routing knowledge lives in the
peers, not in a central planner.

## Primary diagram

The swarm with its one essential control — the handoff budget — marked, and the
failure it prevents drawn explicitly.

```
  Swarm / handoff with the handoff budget (the one thing that saves it)

  ┌── handoff budget: hop < maxHandoffs ? ★ ──────────────────────────┐
  │                                                                   │
  │   agent A ──handoff──► agent B ──handoff──► agent C ──answer──► ✓  │
  │      ▲                     │                                       │
  │      └──── handoff ────────┘   ◄── WITHOUT the budget: A⇄B forever │
  │                                                                   │
  └───────────────────────────────────────────────────────────────────┘
   no central budget exists — the hop counter is the ONLY guard against
   the infinite-handoff failure (file 09)
```

## Implementation in this codebase

**Not yet exercised.** AptKit's five agents are peers in the sense that none is
above another — but they never hand off to each other. None of them can invoke
or transfer control to another agent; the only code touching multiple agents
(`apps/studio/src/agent-runners.ts`) runs each in isolation. There is no handoff
mechanism and therefore no handoff budget.

What's worth noting for a future build: AptKit *already* bounds its single-agent
loops with per-agent budgets — `maxTurns` and `maxToolCalls` in
`packages/runtime/src/run-agent-loop.ts:87,89`. A swarm would need a *new,
higher* budget — the handoff hop count — because the per-agent loop budgets only
bound each agent's *internal* work, not the number of times control bounces
between agents. That cross-agent budget is exactly what AptKit lacks today
(because there's nothing to bound), and exactly what you'd add first.

The honest one-liner: there is no handoff in AptKit, so the infinite-handoff
failure can't occur — but if you build a swarm you must add a hop budget on top
of the existing per-agent budgets. The SECTION F templates
(`../06-orchestration-system-design-templates/`) — especially the agentic
support/task system — sketch the handoff version.

## Elaborate

The reason swarm feels attractive and bites hard is that *no single handoff
looks wrong*. The billing agent handing to refunds is a reasonable local
decision; refunds handing back to billing is also reasonable. The failure is
emergent — it's in the *cycle*, not in any one step — which makes it invisible
in code review and only visible in production traces (or in a hop counter
tripping). This is why the handoff budget isn't optional polish; it's the only
thing standing between a reasonable local rule and a non-terminating system.

When *should* you use a swarm over supervisor-worker? When the routing decision
genuinely requires the peer's specialized judgment. A triage desk can route
"billing vs technical" without knowing the details — that's supervisor-worker.
But "this refund needs the fraud team because of something only refunds would
notice" is a peer-discovered route — that's where swarm earns its keep. If your
routing can be decided by a generalist boss up front, you don't need a swarm,
and you shouldn't take on its termination risk.

## Interview defense

**Q: "Why not let AptKit's agents hand off to each other directly — let
monitoring hand to diagnostic, diagnostic hand to recommendation?"**

"That'd be a swarm, and for this flow it's the wrong tool — the routing is
*fixed* (`scan → investigate → propose`, never branching, never looping back),
so a sequential pipeline expresses it exactly with zero termination risk. I'd
only reach for handoff if the routing needed peer-discovered judgment, like a
support flow where one agent realizes mid-task that another should take over.
And the moment I did, I'd add a *handoff budget* — a max hop count — on top of
the existing per-agent loop budgets, because with no supervisor nothing else
bounds how many times control bounces. Without that cap two agents can hand the
same task back and forth forever, and no single handoff looks wrong in review."

```
  The one-line defense
  fixed routing → pipeline (no risk) ; peer-decided routing → swarm + hop budget
```

Anchor: `run-agent-loop.ts:87,89` (per-agent budgets — they bound *internal*
work, not handoff hops, so a swarm needs a *new* cross-agent budget).

If asked "how do you detect an infinite handoff in production?" and you're
unsure: reason it out — a hop counter that trips, plus the trace showing the
same two `capabilityId`s alternating; the `CapabilityEvent` trace
(`packages/runtime/src/events.ts`) is where you'd see it.

## Validate your understanding

1. **Spot the absence.** Confirm no AptKit agent hands off to another: the five
   agents in `packages/agents/*/src/*-agent.ts` never instantiate or call each
   other, and `agent-runners.ts` runs each alone.

2. **Spot the budget gap.** Read `run-agent-loop.ts:87,89`. Explain why these
   budgets do *not* prevent an infinite handoff. (They bound each agent's
   internal loop, not the number of control transfers between agents.)

3. **Predict the failure.** Two peer agents each think the other is better
   suited. With no hop budget, what happens? (A⇄B forever — the infinite-handoff
   failure, file 09.)

4. **Choose the topology.** Given "fixed order scan→investigate→propose, never
   branches," is swarm or pipeline correct? (Pipeline — fixed routing needs no
   peer-decided handoff and carries no termination risk.)

## See also

- `02-supervisor-worker.md` — the bounded cousin; a boss reholds control, so one
  budget bounds everything
- `03-sequential-pipeline.md` — the right tool for *fixed* routing (AptKit's
  flow)
- `09-coordination-failure-modes.md` — the infinite-handoff failure and the hop
  budget that bounds it
- `07-graph-orchestration.md` — a graph can express a swarm's handoffs as edges
  *with* a visible cycle check
- `../06-orchestration-system-design-templates/` — SECTION F: the support/task
  build template where handoff fits
