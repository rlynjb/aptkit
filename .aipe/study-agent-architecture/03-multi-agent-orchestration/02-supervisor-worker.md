# Supervisor-Worker

**Industry standard.** "Supervisor-worker," "orchestrator-worker," "manager-agent." Type label: orchestration topology. **In this codebase: not yet exercised.** aptkit has no supervisor agent — its `classifyIntent` router is the *routing half* of a supervisor, but nothing synthesizes worker results because there are no workers to coordinate.

## Zoom out, then zoom in

The most common and most useful topology. A supervisor decomposes a task, delegates pieces to specialist workers, and synthesizes their results. aptkit has the routing primitive but not the topology — worth seeing the shape, because it's the first thing you'd build if you composed aptkit's agents.

```
  Zoom out — supervisor-worker (the shape, not in aptkit)

  ┌─ Supervisor (decompose, delegate, synthesize) ──────────┐
  │  the routing half exists in aptkit (classifyIntent)      │ ← partial
  │  the synthesis half does not                             │
  └───────┬───────────────┬───────────────┬──────────────────┘
          ▼               ▼               ▼
       worker 1        worker 2        worker 3
       (specialist)    (specialist)    (specialist)
```

## Structure pass

**Axis: who decides, and who synthesizes?** A supervisor owns both: it routes (decides which worker) and merges (synthesizes results). aptkit owns only the first half. The seam between supervisor and worker is a control decision: does the supervisor call workers *as tools* (stays in control) or *hand off* to them (control transfers)?

## How it works

### Move 1 — the mental model

A manager component delegating to child components, each owning one responsibility, with the parent merging the results. You've built this in UI: a parent component that fans data to children and combines their outputs. Supervisor-worker is that, where each child is an agent.

```
  Supervisor-worker — manager delegates, then merges

  ┌────────────── Supervisor ──────────────┐
  │   decompose task → delegate → synthesize│
  └───────┬───────────┬───────────┬─────────┘
          ▼           ▼           ▼
      worker 1    worker 2    worker 3
          └───────────┼───────────┘
                      ▼
            supervisor synthesizes → answer
```

### Move 2 — what it would take in aptkit

**The routing half already exists.** `classifyIntent` (`query/src/intent.ts:13`) classifies a query and picks a route — that's exactly a supervisor's "which worker handles this" decision. Lift it unchanged.

**The workers already exist.** The recommendation, monitoring, and diagnostic agents are ready specialist workers — each a focused single-agent capability.

**What's missing: the synthesis half.** No agent takes three workers' outputs and merges them into one answer. To build supervisor-worker in aptkit you'd write a supervisor agent that (a) routes via the existing classifier, (b) calls the relevant worker agents — as *tools* (`callWorker(input)` registered in a `ToolRegistry`) to stay debuggable, and (c) synthesizes. The tools-style delegation fits aptkit's existing pattern: workers become tools in the supervisor's policy.

```
  Supervisor-worker refactor in aptkit (would-be)

  supervisor agent:
    classifyIntent(query) ──► route                   ← exists
    callWorker(diagnostic, input) [as a tool]          ← workers exist
    synthesize(worker outputs) → final answer          ← MISSING
```

**The decision to make explicit: tools-style vs handoff-style.** Tools-style (supervisor calls workers as tools, stays in control) keeps the topology debuggable — every worker call is a traced tool call in the supervisor's loop, and aptkit's `CapabilityEvent` trace already captures tool calls. Handoff-style (control transfers to the worker) is more flexible but harder to trace. For aptkit, tools-style is the natural fit because the whole runtime is built around tool calls with traces.

### Move 3 — the principle

The supervisor's core job is routing (SECTION A) plus synthesis. aptkit has routing; it lacks synthesis only because its capabilities don't compose. The cheapest path to supervisor-worker is tools-style delegation, which keeps the inter-agent calls inside the existing traced tool-call machinery.

## Primary diagram

```
  Supervisor-worker — tools-style (the aptkit-fit version)

  ┌─ Supervisor agent (runAgentLoop) ───────────────────────┐
  │  classifyIntent → which worker?                          │
  │  callTool(worker_diagnostic, input)  ← worker AS a tool  │
  │  callTool(worker_recommendation, ...) ← traced like any  │
  │  synthesize results → final answer                       │
  └──────────────────────────────────────────────────────────┘
       │ (every worker call is a CapabilityEvent tool_call)
       ▼
  workers = existing single-agent capabilities, unchanged
```

## Elaborate

Supervisor-worker won because it's the topology that maps cleanest onto how engineers already think — a manager and its reports. The production caution: the supervisor becomes the bottleneck and the cost center (it makes the expensive routing and synthesis calls), so the pattern is "expensive supervisor, cheap workers." aptkit's swappable provider layer would make that split trivial. The reason aptkit hasn't built it is the gate (previous file): no single capability's failure was decomposable, so there was nothing for a supervisor to coordinate.

## Interview defense

**Q: Could aptkit become supervisor-worker?**
Cheaply. I already have the routing half — `classifyIntent` is exactly a supervisor's "which worker" decision — and the workers exist as focused single agents. I'd add a supervisor agent that calls workers *as tools* (tools-style, not handoff) so every worker call stays a traced tool call in my existing `CapabilityEvent` stream, then synthesizes. The missing piece is only the synthesis step.

```
  classifyIntent (have) → callWorker as tool (cheap) → synthesize (missing)
```
*Anchor: tools-style keeps it debuggable; the trace machinery already captures tool calls.*

## See also

- `01-when-not-to-go-multi-agent.md` — the gate before building this
- `01-reasoning-patterns/07-routing.md` — the routing half aptkit has
- `08-shared-state-and-message-passing.md` — how the supervisor passes context to workers
- `06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` — supervisor-worker as an interview answer
