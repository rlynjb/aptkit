# 02 — Supervisor-Worker

> A boss agent that decides, at runtime, which worker does what — and stitches
> the workers' results back together. The first *dynamic* topology: unlike the
> fixed pipeline, the supervisor chooses. Not exercised in AptKit; taught in
> full, then pointed to SECTION F.

## Zoom out

Supervisor-worker is what people usually mean when they say "multi-agent." One
agent sits above the others, reads the task, decides which specialist to invoke,
collects the result, and decides whether to invoke another or synthesize a final
answer. The supervisor holds the plan; the workers hold the skills. It's a
hub-and-spoke layered on top of the single-agent loop you already know.

```
  Supervisor-worker as layers

  ┌─ Coordination layer ──────────────────────────────────────────────┐
  │  SUPERVISOR agent: reads task, plans, routes, synthesizes          │
  └───────────────┬───────────────┬───────────────┬───────────────────┘
                  │ delegate       │ delegate       │ delegate
                  ▼                ▼                ▼
  ┌─ Worker layer ────────────────────────────────────────────────────┐
  │  worker A        worker B        worker C                           │
  │  (each = a full single-agent loop with its own tools + budget)     │
  └───────────────┬───────────────┬───────────────┬───────────────────┘
                  │ result         │ result         │ result
                  └───────────────►supervisor synthesizes◄──────────────┘
```

The supervisor is the new thing. Everything below it is the single-agent loop,
unchanged.

## Structure pass

The axis is **who decides the next step**. In a pipeline, you decided in advance
(file 03). Here, the supervisor decides at runtime. The seam is the
delegate/result boundary between supervisor and worker — and there are two
different shapes that seam can take.

```
  Two shapes of the supervisor→worker seam

  TOOLS-STYLE                          HANDOFF-STYLE
  workers ARE tools the supervisor     supervisor hands the whole conversation
  "calls"; control returns to boss     to a worker; worker runs autonomously
  after each                           and may hand back or hand on

  ┌───────────┐                        ┌───────────┐
  │ supervisor│  call worker(args)     │ supervisor│  handoff(context)
  │           │ ────────────────►      │           │ ────────────────►
  │  (holds   │ ◄────────────────      │  (releases│  (worker now owns
  │  control) │  result                │  control) │   the conversation)
  └───────────┘                        └───────────┘
  control always returns to boss       control moves WITH the work
```

Tools-style keeps the supervisor in charge every turn — a worker is just a
fancy tool call that returns a value. Handoff-style transfers ownership: the
worker takes over and may never return to the supervisor (that's the slide
toward swarm, file 06). Tools-style is easier to bound; handoff-style is more
flexible and more dangerous.

## How it works

### Move 1 — the mental model

The mental model is a **manager component delegating to child components**. The
parent owns the orchestration state and decides which child renders / which
child does work; children do one job and report back via callbacks.

```
  The manager-component mental model (the topology IS this picture)

  <Supervisor>                         ← owns plan + which worker to call
    decide(task) → pick worker
      <WorkerA onResult={collect} />   ← does job A, calls back
      <WorkerB onResult={collect} />   ← does job B, calls back
    synthesize(results) → final
  </Supervisor>

  parent decides WHICH child runs and stitches their outputs —
  exactly a manager component routing to children and merging callbacks
```

For a frontend reader: this is a dashboard container that decides which panel to
mount based on the route, passes each panel its props, receives results through
`onChange`/`onResult` callbacks, and composes them into one view. The container
is the supervisor; the panels are the workers. The difference is the
supervisor's routing decision is made by an LLM reading the task, not by a
`switch` on a route string.

### Move 2 — step by step

**Step 1 — the supervisor plans and picks a worker.**

```
  supervisor.plan: task ──► (which worker, what sub-task)
  ┌──────────────────────────────────────────┐
  │ LLM reads task → emits "call workerB with  │
  │ {sub-task}" as a tool-use / handoff intent │
  └──────────────────────────────────────────┘
```

```
supervise(task):
  state = { task, results: [] }
  loop until done or budget spent:
    decision = supervisorLoop(state)      # LLM picks worker + sub-task
    if decision.is_final: return decision.answer
    result = runWorker(decision.worker, decision.subTask)
    state.results.push(result)
```

**Step 2 — the worker runs its own bounded loop.**

```
  worker: sub-task ──► validated result
  ┌──────────────────────────────────────┐
  │ a FULL single-agent ReAct loop:       │
  │ own prompt, own tool policy, own budget│
  └──────────────────────────────────────┘
```

```
runWorker(worker, subTask):
  result = reactLoop(worker.prompt, worker.toolPolicy, worker.budget)
  return validate(result)                # validate BEFORE handing back
```

**Step 3 — the supervisor synthesizes.**

```
  supervisor.synthesize: results[] ──► final answer
  ┌───────────────────────────────────────┐
  │ LLM reads all worker results → one     │
  │ coherent answer; may loop for more      │
  └───────────────────────────────────────┘
```

```
synthesize(results):
  return supervisorLoop({ instruction: "combine into final", results })
```

### Move 3 — the principle

The supervisor's power is also its risk: it makes a *runtime* decision every
turn, so the system is non-deterministic and the supervisor's own loop must be
bounded or it will keep delegating forever. The core discipline is two-fold:
**validate each worker's output against a schema before the supervisor trusts
it** (a worker that returns garbage shouldn't poison synthesis), and **bound the
supervisor's delegation loop** (a turn/tool budget on the supervisor itself, not
just the workers). Tools-style is the safer default because control always
returns to the boss, so the boss's budget caps the whole system.

## Primary diagram

The full supervisor-worker cycle, tools-style, with the two control points
(validate, bound) marked.

```
  Supervisor-worker (tools-style) with the two safety points

  ┌───────────────────────────────────────────────────────────┐
  │ SUPERVISOR loop  (BOUNDED: own maxTurns/maxToolCalls) ★1    │
  │   plan → pick worker ──┐                                    │
  │   ◄── validated result │                                    │
  └────────────────────────┼───────────────────────────────────┘
                           ▼  delegate(subTask)
              ┌────────────────────────────┐
              │ WORKER (single-agent loop)  │
              │  reactLoop → raw result      │
              └─────────────┬───────────────┘
                            ▼  validate against schema ★2
              ┌────────────────────────────┐
              │ valid? → return to supervisor│
              │ invalid? → reject / retry    │
              └────────────────────────────┘
  ★1 bound the supervisor or it delegates forever
  ★2 validate worker output before synthesis
```

## Implementation in this codebase

**Not yet exercised.** AptKit has no supervisor and no worker delegation — its
five agents are peers that never call each other; the only thing that
instantiates more than one (`apps/studio/src/agent-runners.ts`) runs each in
isolation against its own fixture.

The two control points above, however, already exist as single-agent primitives
you'd reuse to build this safely: a worker's bounded loop is exactly
`runAgentLoop` with `maxTurns`/`maxToolCalls`
(`packages/runtime/src/run-agent-loop.ts:87,89`), and "validate worker output
before trusting it" is exactly the per-agent validator pattern, e.g.
`isDiagnosis` in `packages/agents/diagnostic-investigation/src/validate.ts:25`.
To build supervisor-worker you'd add a *new* coordinating loop on top; the
workers are the agents you already have.

See `../06-orchestration-system-design-templates/` (SECTION F) for the build-it
template — the multi-agent research-assistant prompt is the canonical
supervisor-worker design.

## Elaborate

The tools-style vs handoff-style choice is the one that bites teams. Tools-style
treats each worker as a synchronous function call: the supervisor's loop owns
the budget, so the whole system's cost is bounded by the supervisor's budget
times each worker's budget — knowable in advance. Handoff-style lets the worker
take the wheel, which is more natural for "transfer me to billing" support flows
but means no single budget bounds the whole interaction (control can ping-pong).
Start tools-style. Move to handoff-style only when a worker genuinely needs to
own a multi-turn sub-conversation the supervisor shouldn't mediate.

## Interview defense

**Q: "How would you add a supervisor over AptKit's agents without it spiraling?"**

"Tools-style, so control always returns to the supervisor and one budget bounds
the system. Each worker is the agent I already have — a bounded `runAgentLoop`
with its own tool policy. Two non-negotiables: the supervisor's *own* loop is
budgeted (`maxTurns`/`maxToolCalls`) so it can't delegate forever, and every
worker's output is schema-validated before the supervisor trusts it for
synthesis — I already have that per-agent validator, like `isDiagnosis`. I'd
avoid handoff-style until a worker needs to own a sub-conversation, because
handoff makes the total budget unbounded."

```
  The one-line defense
  tools-style boss → bounded supervisor loop + validate each worker → bounded, safe
```

Anchor: `run-agent-loop.ts:87,89` (the worker budget), `validate.ts:25`
(`isDiagnosis`, the worker-output check). Both are single-agent today;
supervisor-worker reuses them.

## Validate your understanding

1. **Spot the reusable primitive.** Find the bounded loop a worker would run:
   `run-agent-loop.ts:87,89` (`maxTurns`, `maxToolCalls`). Confirm it's already
   the shape every AptKit agent uses.

2. **Spot the validation gate.** Read `diagnostic-investigation/src/validate.ts:25`
   (`isDiagnosis`). This is "validate worker output before synthesis," present
   per-agent today.

3. **Predict the failure.** If you build a supervisor but only budget the
   *workers*, what breaks? (The supervisor delegates forever — its own loop is
   unbounded. ★1 in the primary diagram.)

4. **Tell the two styles apart.** Given "transfer me to a billing specialist who
   handles the rest of the chat" vs "summarize these three docs," which is
   handoff-style and which is tools-style? (Billing transfer = handoff; doc
   summary = tools-style.)

## See also

- `06-swarm-handoff.md` — handoff-style taken to its limit: peers, no boss
- `03-sequential-pipeline.md` — the static cousin: fixed order, no supervisor
- `09-coordination-failure-modes.md` — the unbounded-supervisor and
  bad-worker-output failures, and the bounds that catch them
- `../04-agent-infrastructure/05-guardrails-and-control.md` — budgets and
  validators as control
- `../06-orchestration-system-design-templates/` — SECTION F: the build template
