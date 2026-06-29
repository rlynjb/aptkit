# Graph Orchestration

**Industry term:** graph orchestration (control flow as an explicit, checkpointed state machine). *Industry standard.*

## Zoom out, then zoom in

Control flow as an explicit state machine — nodes, edges, conditional transitions, checkpointed state. This is the topology that makes the others inspectable. aptkit does not use a graph framework; its control flow is the imperative `for` loop in `runAgentLoop`.

```
  Zoom out — not built; aptkit's control flow is an imperative loop

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  runAgentLoop: a for-loop, not a node/edge graph             │ ← we are here
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet implemented in aptkit.** There's no graph definition, no conditional edges, no checkpoint/resume. The loop's control flow is plain TypeScript. This file teaches the graph model and names what it would buy aptkit (and what it would cost).

## How it works

**Use case it would fit:** any aptkit flow that needs a human-in-the-loop pause — e.g. recommendation pausing for human approval before a high-stakes action, then resuming. Graphs make pause/resume natural; an imperative loop doesn't.

### Move 1 — the topology

It's a state machine — the same shape you'd use for a multi-step form's UI states, except the state is the shared agent context and the transitions are agent turns.

```
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

### Move 2 — the walkthrough

**A graph makes the other topologies inspectable.** Supervisor-worker, pipeline, and debate can all be expressed as a graph with explicit state, conditional edges, and checkpointing. The win is two-fold: you can *see* the control flow as data (a graph you can render), and you can *pause* at a node for human review and resume later — because the state is checkpointed, not trapped in a call stack.

**Where aptkit's imperative loop falls short.** `runAgentLoop` is a `for` loop with the state in a local `messages` array. You can't pause it mid-run, persist the state, and resume next week — the state lives in the call stack, not a checkpoint store. For aptkit's short, synchronous agent runs that's fine. For a long-running approval flow it isn't, and a graph is the fix.

**What aptkit DOES have that's graph-adjacent.** The `CapabilityEvent` trace (`step`, `tool_call_start/end`, `model_usage`) is an *observability* record of the flow — you can replay what happened. But it's a log, not a resumable state machine: you can see the path taken, you can't re-enter it at node B. The trace is the inspection half of graph orchestration without the checkpoint-resume half.

**What it would cost aptkit.** Adopting a graph framework (or building a minimal node/edge runner) plus a checkpoint store for the shared state. That's a significant rewrite of `runAgentLoop`'s control flow. **Not yet implemented**, and only justified if a capability needed human-in-the-loop pause/resume.

### Move 3 — the principle

A graph is a state machine where the state is the shared agent context and the transitions are agent turns. It buys debuggability (control flow as inspectable data) and human-in-the-loop pauses (checkpointed, resumable state), at the cost of up-front structure — you define the graph instead of letting the model freewheel. aptkit's imperative loop trades that structure for simplicity, correct for short synchronous runs.

## Primary diagram

```
  Graph orchestration vs aptkit's imperative loop

  graph:   nodes + conditional edges + CHECKPOINTED state
           → render the flow, pause at a node for human review, resume
           (the inspectable form of every other topology)

  aptkit:  runAgentLoop = for-loop; state in a local messages[] array
           → CapabilityEvent trace records the path (inspect)
           → but NOT resumable (no checkpoint store)
  (Not yet implemented)
```

## Elaborate

Graph orchestration (the model LangGraph and similar frameworks popularized) won mindshare because it solved the two hardest multi-agent problems at once: observability (the flow is a graph you can draw) and human-in-the-loop (checkpoint at a node, get approval, resume). The cost is that you give up the model's freewheeling and commit to an explicit structure up front. aptkit's `CapabilityEvent` trace is the observability half done cheaply (a log of the path); the resumable-checkpoint half is the work a graph would add, justified only by a pause/resume requirement aptkit doesn't have yet.

## Interview defense

**Q: aptkit uses a plain loop, not a graph framework. When would you switch?**

When a capability needs to pause for human approval and resume later. An imperative loop keeps state in the call stack — you can't checkpoint and re-enter it. A graph keeps state in a checkpoint store, so you can pause at a node, get sign-off, and resume. aptkit's runs are short and synchronous, so the loop is the right call; a human-in-the-loop approval flow would flip that.

```
  loop:  state in call stack  → can't pause/resume   (fine for short runs)
  graph: state checkpointed    → pause at node, resume (human-in-the-loop)
```

*Anchor: the graph's payoff is checkpointed, resumable state — reach for it when you need a human-in-the-loop pause, not before.*

## See also

- [../01-reasoning-patterns/02-agent-loop-skeleton.md](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the imperative loop a graph would replace.
- [08-shared-state-and-message-passing.md](08-shared-state-and-message-passing.md) — the state a graph checkpoints.
- [../04-agent-infrastructure/05-guardrails-and-control.md](../04-agent-infrastructure/05-guardrails-and-control.md) — the human-in-the-loop gate graphs enable.
