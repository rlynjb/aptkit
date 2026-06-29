# Supervisor-Worker

**Industry term:** supervisor-worker (orchestrator-worker) topology. *Industry standard.*

## Zoom out, then zoom in

The most common and most useful multi-agent topology. A supervisor decomposes a task, delegates to specialist workers, and synthesizes their results. aptkit does not do this — but its `runAgentLoop` is exactly the unit a supervisor and its workers would each run.

```
  Zoom out — not built in aptkit; the unit it would compose

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  6 independent agents, no supervisor over them               │ ← we are here
  │  (a supervisor would be a 7th agent calling the others)      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet implemented in aptkit.** No agent decomposes a task and delegates to other agents. The closest lived shape is blooming-insights, where a controller drove monitor/investigate/recommend — but even there it was a fixed pipeline, not a decomposing supervisor.

## How it works

**Use case it would fit:** the multi-agent research assistant ([../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md](../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md)) — a supervisor splits a research question, fans workers across sources, and synthesizes a cited answer.

### Move 1 — the topology (the mental model IS the shape)

It's a manager component delegating to child components, each owning one responsibility, with the parent merging the results — the React pattern you've shipped many times, made of agents.

```
  ┌───────────────────────────────────────────────┐
  │              Supervisor agent                  │
  │   (decomposes task, delegates, synthesizes)    │
  └───────┬───────────────┬───────────────┬────────┘
          ▼               ▼               ▼
      ┌────────┐      ┌────────┐      ┌────────┐
      │worker 1│      │worker 2│      │worker 3│
      │(spec.) │      │(spec.) │      │(spec.) │
      └────┬───┘      └────┬───┘      └────┬───┘
           └───────────────┼───────────────┘
                           ▼
                  supervisor synthesizes
                  worker results → answer
```

### Move 2 — the walkthrough

**The supervisor's core job is routing + synthesis.** Routing is the pattern from [../01-reasoning-patterns/07-routing.md](../01-reasoning-patterns/07-routing.md) — decide which worker handles which sub-task. aptkit already has the routing half (`classifyIntent`); it lacks the *delegation* half (a worker to route *to*).

**The decision that defines the topology: tools vs handoff.** Does the supervisor call workers as *tools* (it stays in control, reads each result, decides next) or *hand off* to them (control transfers)? Tools-style keeps the topology debuggable — one trace, the supervisor's. Handoff-style is more flexible but harder to trace. For aptkit's debuggable, replay-centric style, tools-style is the natural fit: a worker would be a tool the supervisor calls, fitting straight into the existing `ToolRegistry` + `runAgentLoop` machinery.

**What it would cost aptkit.** A supervisor agent (a 7th `runAgentLoop`) whose tools are the other agents, each wrapped as a `ToolHandler`. The least-privilege `ToolPolicy` model already supports this — the supervisor's allowlist would be the worker-agent tools. Worker outputs would need schema validation before synthesis (aptkit's `validate.ts` per agent is the precedent). **Not yet implemented.**

### Move 3 — the principle

Supervisor-worker is a manager delegating to single-responsibility children and merging the results. The tools-vs-handoff choice is the design decision: tools-style for traceability, handoff-style for flexibility. aptkit's replay-centric, least-privilege design points squarely at tools-style if it ever crosses the gate.

## Primary diagram

```
  Supervisor-worker as aptkit would build it (tools-style)

  supervisor runAgentLoop
     │ tools = [ wrapWorker(query), wrapWorker(diagnostic), ... ]
     ▼ tool_use: run a worker  (ToolRegistry + ToolPolicy allowlist)
  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ worker = │  │ worker = │  │ worker = │   each is itself a runAgentLoop
  │ an agent │  │ an agent │  │ an agent │
  └────┬─────┘  └────┬─────┘  └────┬─────┘
       └─────────────┼─────────────┘
                     ▼ validate each output (validate.ts precedent)
            supervisor synthesizes → final answer
  (Not yet implemented in aptkit)
```

## Elaborate

Supervisor-worker won as the default multi-agent topology because it keeps a single point of control (easier to reason about than peer-to-peer) while still splitting work across specialists. The tools-style variant — workers as callable tools — is what most production frameworks converged on, because it preserves one debuggable trajectory. aptkit's tool-registry-plus-policy substrate is unusually well-positioned to adopt it: a worker is just a tool with an agent inside.

## Interview defense

**Q: If aptkit went multi-agent, what topology and why?**

Supervisor-worker, tools-style. A supervisor `runAgentLoop` whose tools wrap the existing agents; it routes sub-tasks to workers, validates each output, and synthesizes. Tools-style because aptkit is replay-centric and least-privilege — keeping one debuggable trajectory and one allowlist matters more than handoff flexibility.

```
  supervisor (control stays here) → workers-as-tools → validate → synthesize
```

*Anchor: tools-style keeps one trace; the ToolRegistry + ToolPolicy already model "a worker is a tool with an allowlist."*

## See also

- [01-when-not-to-go-multi-agent.md](01-when-not-to-go-multi-agent.md) — whether to build this at all.
- [03-sequential-pipeline.md](03-sequential-pipeline.md) — the simpler topology blooming-insights actually used.
- [../01-reasoning-patterns/07-routing.md](../01-reasoning-patterns/07-routing.md) — the supervisor's routing half, which aptkit has.
