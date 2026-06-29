# Graph Orchestration

**Industry standard.** "Graph orchestration," "stateful agent graph," "LangGraph-style," "agent state machine." Type label: orchestration topology. **In this codebase: not yet exercised.** aptkit has no explicit agent graph — no nodes, edges, or checkpointed state. Its control flow is a single `for` loop (`runAgentLoop`), not a state machine over agent turns.

## Zoom out, then zoom in

Control flow as an explicit state machine: nodes (agent steps), edges (transitions), conditional edges (branches), and checkpointed state (so you can pause for human review and resume). It's the topology that makes the others *inspectable* — supervisor-worker, pipeline, and debate can all be expressed as a graph. aptkit doesn't have it, but the reader builds state machines daily (multi-step form UI states), so the shape is home turf.

```
  Zoom out — graph orchestration (the shape, not in aptkit)

  ┌──────┐    ┌──────┐    ┌──────┐
  │ node │───►│ node │───►│ node │
  │  A   │    │  B   │    │  C   │
  └──────┘    └──┬───┘    └──────┘
                 │ conditional edge
                 ▼
              ┌──────┐
              │ node │  (loop back / branch)
              │  D   │
              └──────┘
```

## Structure pass

**Axis: is control flow explicit and checkpointed?** aptkit's control is *implicit* — it lives in a `for turn` loop with `break` conditions (`run-agent-loop.ts:98`), and state is the in-memory `messages` array, gone when the run ends. A graph makes control *explicit* (you define the nodes and edges) and state *durable* (checkpointed between nodes). The seam: implicit-loop-with-ephemeral-state (aptkit) vs explicit-graph-with-checkpointed-state (graph orchestration).

## How it works

### Move 1 — the mental model

A state machine — the same shape you use for a multi-step form's UI states (`idle → filling → submitting → success/error`), except the state is the shared agent context and the transitions are agent turns. You define the graph; the model moves through it.

```
  Graph orchestration = a state machine over agent turns

  state: { context, step }
    ┌──────┐  edge   ┌──────┐  conditional edge  ┌──────┐
    │ plan │ ──────► │ act  │ ──────────────────►│ done │
    └──────┘         └──┬───┘  (if not done)     └──────┘
                        └────────► loop back to act
    (state CHECKPOINTED between nodes → pause for human, resume)
```

### Move 2 — aptkit's implicit loop vs an explicit graph

**What aptkit has: an implicit loop.** `runAgentLoop` is a `for turn in 0..maxTurns` with `break` on the success exit and the budget exit baked into the condition (`run-agent-loop.ts:98-102`). The "graph" is two implicit nodes — *call model* and *run tools* — with edges hardcoded as control flow. State is the `messages` array, in-memory, discarded at the end.

```typescript
// packages/runtime/src/run-agent-loop.ts:98 — the implicit "graph"
for (let turn = 0; turn < maxTurns; turn += 1) {
  // node: call model
  const response = await model.complete({...});
  if (toolUses.length === 0) { finalText = text; break; }  // edge: → done
  // node: run tools, then implicit edge back to top
}
```

**What a graph would add: explicit nodes, conditional edges, checkpoints.** You'd define `plan`, `retrieve`, `synthesize`, `human_review` as named nodes, with conditional edges (`if confidence < threshold → human_review`). The payoffs aptkit can't get today:
- **Human-in-the-loop pause.** Checkpoint state before a gated action, surface it for approval, resume. aptkit's loop runs start-to-finish with no pause point — it can't stop mid-run for a human and resume.
- **Inspectability.** A graph is a diagram you can render; aptkit's control flow is a `for` loop you have to read.
- **Resumability.** Checkpointed state survives a crash; aptkit's `messages` array doesn't.

**The interesting part: aptkit's trace is half a graph already.** Its `CapabilityEvent` stream (`step`, `tool_call_start/end`) records the transitions a graph would make explicit — so aptkit can *replay* a run (the replay-eval pipeline) even though it can't *pause* one. It has the observation half of graph orchestration (the trace) without the control half (checkpointed pause/resume).

### Move 3 — the principle

Graph orchestration's win is debuggability and human-in-the-loop pauses; its cost is up-front structure (you define the graph instead of letting the model freewheel). aptkit chose the freewheel — an implicit loop with a budget — because its tasks run start-to-finish without needing a human pause. The day a task needs a human approval gate mid-run, the implicit loop can't do it and a graph becomes the right refactor. The trace already gives aptkit the observability half.

## Primary diagram

```
  aptkit's implicit loop vs an explicit graph

  APTKIT (implicit):                  GRAPH (would-be):
  for turn:                           ┌─plan─┐→┌─retrieve─┐→┌─synth─┐
    call model ─┐                       │         │ conditional   │
    tools? ─yes─┘ loop                  │         ▼ (low conf)     │
    no → break (done)                   │    ┌─human_review─┐      │
  state = messages (ephemeral)          │    (checkpoint, pause,   │
                                        │     resume)              │
  trace = CapabilityEvent ◄─────────────┘ aptkit HAS this half
  (observation without pause/resume control)
```

## Elaborate

Graph orchestration (LangGraph and similar) emerged because freewheeling agent loops are hard to debug and impossible to pause for human review. Modeling the agent as a state machine with checkpointed state solves both — and lets you express supervisor-worker, pipeline, and debate as one inspectable formalism. aptkit deliberately stayed with the implicit loop because its tasks don't need a mid-run human gate, and the replay trace gives it post-hoc inspectability. The honest gap: no pause/resume, no human-in-the-loop checkpoint. That's the capability a graph would unlock.

## Interview defense

**Q: Do you use a graph orchestration framework?**
No — my control flow is an implicit `for` loop in `runAgentLoop`, with state as an in-memory messages array. A graph would make the nodes and edges explicit and checkpoint state between them, which buys two things I don't have: a human-in-the-loop pause (checkpoint before a gated action, resume after approval) and resumability across a crash. I haven't needed them — my tasks run start-to-finish. Interestingly, my trace stream already gives me the *observation* half of a graph; I just can't pause and resume.

```
  implicit loop + ephemeral state (aptkit)
    vs explicit nodes + checkpointed state (graph: pause/resume/inspect)
```
*Anchor: I have the trace (observability) without the checkpoint (pause/resume control).*

**Q: When would you adopt a graph?**
The first task that needs a human approval gate mid-run. My loop runs to completion with no pause point, so it physically can't stop for a human and resume — a checkpointed graph is the right refactor there.

## See also

- `02-agent-loop-skeleton.md` — the implicit loop a graph would make explicit
- `04-agent-infrastructure/05-guardrails-and-control.md` — the human-in-the-loop gate a graph enables
- `04-agent-infrastructure/04-agent-evaluation.md` — the trace that's aptkit's observability half
