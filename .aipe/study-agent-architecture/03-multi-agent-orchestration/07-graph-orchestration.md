# 07 — Graph Orchestration

> Make the wiring itself a data structure: nodes are agents/steps, edges are
> transitions, and the whole flow is an inspectable graph with checkpoints. The
> superset — every other topology is a special case of a graph. Not exercised in
> AptKit, but the latent pipeline is a clean 3-node graph waiting to be drawn.

## Zoom out

Every topology so far is a *fixed shape*: pipelines are a line, fan-out is a
star, supervisor-worker is a hub, swarm is a free-for-all. Graph orchestration
stops hardcoding the shape and makes it *data* — an explicit set of nodes and
edges you can read, draw, checkpoint, and resume. A pipeline is a graph with one
edge per node. A fan-out is a graph with parallel edges. A swarm is a graph
where every node connects to every other. So graph orchestration isn't a
*different* topology — it's the *language all the others are written in*.

```
  Graph orchestration as layers

  ┌─ Topology layer (the others, as special cases) ───────────────────┐
  │  pipeline = line graph · fan-out = star · swarm = complete graph   │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  all expressible as ↓
  ┌─ Graph layer (the superset) ──────────────────────────────────────┐
  │  NODES (agents/steps) + EDGES (transitions, possibly conditional)  │
  │  + a SHARED STATE the graph threads through nodes                  │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  made durable by ↓
  ┌─ Checkpoint layer ────────────────────────────────────────────────┐
  │  persist state at each node → resume / retry / inspect / time-travel│
  └────────────────────────────────────────────────────────────────────┘
```

The checkpoint layer is what makes graphs production-grade: because the flow is
explicit data, you can save state at any node and resume from there.

## Structure pass

The axis is **how explicit the control flow is**. Hardcoded `.then()` chains
hide the flow in code; a graph makes the flow a value you can inspect. The seams
are the edges — each transition is a named, possibly-conditional, possibly-
checkpointed boundary.

```
  The explicitness axis

  HARDCODED FLOW                       GRAPH (flow-as-data)
  ────────────────────────►            ◄──────────────────────────────
  control flow lives in code           control flow is a node/edge structure
  can't inspect mid-run                 can dump the graph + current node
  no resume (rerun from start)          checkpoint per node → resume anywhere
  conditional branches = if/else        conditional EDGES (declared, visible)
  → AptKit's agents today               → what you build for durability/inspection
```

The payoff of moving right: a stuck run isn't a black box. You can see *which
node* it's on, *what state* it holds, and resume from the last good checkpoint
instead of rerunning everything.

## How it works

### Move 1 — the mental model

The mental model is a **multi-step form's state machine** — the thing you've
built whenever a form has steps, validation gates between them, conditional
branches, and a back button.

```
  The multi-step-form state-machine mental model (the topology IS this picture)

         ┌─────────┐  valid   ┌──────────┐  needs review  ┌─────────┐
   ──►   │ step 1   │ ───────► │ step 2    │ ─────────────► │ review   │
         │ (node)   │          │ (node)    │ ◄── revise ─── │ (node)   │
         └─────────┘          └──────────┘                 └────┬─────┘
              ▲                                          submit │
              └────────── "back" edge ──────────────────────────┘
   nodes = form steps · edges = transitions (some conditional) ·
   form state = the shared object threaded through · saved draft = checkpoint
```

For a frontend reader: this is *exactly* a checkout flow or a multi-step
onboarding wizard. Each step is a node. "If the card is declined, go to the
payment-fix step" is a conditional edge. The form's data object is the shared
state every step reads and writes. Saving a draft so the user can resume
tomorrow is a checkpoint. A graph-orchestrated agent system is that same machine
where each step happens to be an agent loop instead of a `<FormStep>`.

### Move 2 — step by step

**Step 1 — declare nodes and edges (the flow as data).**

```
  graph = { nodes: {...}, edges: [...] }   ← the flow is a VALUE, not code
  ┌─────────┐   edge(cond)   ┌─────────┐
  │ node A   │ ────────────► │ node B   │
  └─────────┘                └─────────┘
```

```
graph = {
  nodes: { scan, investigate, propose },
  edges: [
    { from: scan,        to: investigate, when: anomalies.nonEmpty },
    { from: scan,        to: END,         when: anomalies.empty },
    { from: investigate, to: propose },
    { from: propose,     to: END },
  ],
}
```

**Step 2 — run the graph: a node executes, the engine picks the next edge.**

```
  run: state ──► node executes ──► engine evaluates edges ──► next node
  ┌──────────┐        ┌────────────────────┐
  │ run node  │ ─────► │ pick edge whose     │ ─► next node | END
  │ (agent)   │        │ condition matches   │
  └──────────┘        └────────────────────┘
```

```
runGraph(graph, initialState):
  node, state = graph.entry, initialState
  while node != END:
    state = node.run(state)               # an agent loop
    checkpoint(node, state)               # ★ persist for resume/inspect
    node = pick_edge(graph, node, state)  # conditional transition
  return state
```

**Step 3 — checkpoint and (optionally) resume.**

```
  checkpoint: (node, state) ──► durable store
  resume: load(node, state) ──► continue from that node, not from start
```

### Move 3 — the principle

The graph's value is that the *flow becomes inspectable and resumable*. Because
transitions are declared data, you can render the graph, see exactly which node
a run died on, and restart from the last checkpoint instead of from zero. The
cost is ceremony — for a three-step line, a full graph engine is overkill;
you'd just write the `.then()` chain. The principle: reach for a graph when you
need *conditional branching*, *loop-back* (retry an earlier node), or
*durability* (resume a long/expensive run). If the flow is a fixed line with no
branches and no need to resume, a pipeline is honest and a graph is
over-engineering.

## Primary diagram

The latent pipeline drawn as a 3-node graph — showing the conditional edge and a
checkpoint that the straight pipeline (file 03) can't express.

```
  AptKit's latent pipeline AS a graph (the superset view)

                    ┌──────────────────────────────────────────┐
                    │  shared state: { anomaly?, diagnosis?, recs? } │
                    └──────────────────────────────────────────┘
                                       │ threaded through
    ┌──────────┐  anomalies empty                         ┌─────┐
    │  scan     │ ─────────────────────────────────────►  │ END │
    │  (node)   │                                          └─────┘
    └────┬─────┘  anomalies non-empty                        ▲
         ▼  [checkpoint]                                      │
    ┌──────────────┐        ┌──────────┐  recs               │
    │ investigate   │ ────► │ propose   │ ────────────────────┘
    │ (node)        │        │ (node)    │  [checkpoint each node]
    └──────────────┘        └──────────┘
   conditional edge (empty → END) and per-node checkpoints are things a
   straight pipeline can't express — that's when you graduate to a graph
```

## Implementation in this codebase

**Not yet exercised.** AptKit has no graph engine, no nodes/edges structure, and
no checkpointing — its agents run as isolated single loops with no declared flow
between them.

The grounding worth keeping: the latent sequential pipeline (file 03) is the
obvious *first* graph. Its three nodes are real today —
`scan()` (`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:57`),
`investigate(anomaly)` (`packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:55`),
`propose(anomaly, diagnosis)` (`packages/agents/recommendation/src/recommendation-agent.ts:64`).
Expressed as a graph, you'd gain exactly the two things a straight pipeline
can't do: the conditional edge "no anomalies → END" (instead of an `if` buried
in the orchestrator) and a checkpoint after `scan` so an expensive
`investigate`/`propose` run can resume without re-scanning. For three fixed
nodes that's arguably over-engineering — which is *why* AptKit would start with
the plain pipeline and only graduate to a graph when branching or resume becomes
necessary.

The honest one-liner: no graph orchestration exists; the latent pipeline is the
clean 3-node graph it would become *if* it needed conditional branching or
checkpointed resume. The SECTION F templates
(`../06-orchestration-system-design-templates/`) treat the graph build.

## Elaborate

The trap with graphs is the opposite of the trap with swarms: where swarm is too
little structure, a graph engine for a simple flow is too much. A line of three
fixed steps does not need a node/edge DSL, a checkpoint store, and a graph
runner — it needs three `await`s. The graph earns its complexity the moment the
flow stops being a line: a retry edge ("diagnosis was low-confidence → loop back
and gather more"), a branch ("critical anomaly → escalate node; minor → standard
node"), or a durability need ("this run costs $5 in tokens, checkpoint it so a
crash doesn't redo everything"). Until one of those shows up, the graph is
ceremony.

The deepest idea here is the "inspectable superset" framing. Once you see that a
pipeline, a fan-out, a supervisor, and a swarm are all just graphs with
different edge patterns, you stop arguing about *which topology* and start
asking *what edges does this flow actually need* — fixed forward edges
(pipeline), parallel edges (fan-out), hub edges (supervisor), or arbitrary edges
with a cycle guard (swarm). The graph is the unifying vocabulary.

## Interview defense

**Q: "Would you build the diagnostic pipeline as a graph?"**

"Not yet — it's three fixed nodes in a line with one branch (no anomalies →
stop), so a straight pipeline plus one `if` is honest and a graph engine would
be ceremony. I'd graduate to a graph the moment the flow needs something a line
can't express: a conditional branch like 'critical anomaly escalates to a
different node,' a loop-back like 'low-confidence diagnosis → gather more,' or
durability — checkpoint after the cheap `scan` so an expensive `investigate` run
can resume without re-scanning. The nice part is the graph is the *superset*:
the pipeline, a fan-out over anomalies, even a swarm are all just graphs with
different edges, so the migration is drawing the edges I already have, plus the
new conditional one and per-node checkpoints."

```
  The one-line defense
  fixed line → pipeline ; needs branch/loop-back/resume → graph (the superset)
```

Anchor: `monitoring-agent.ts:57`, `diagnostic-agent.ts:55`,
`recommendation-agent.ts:64` (the three nodes); the conditional "empty → END"
edge and per-node checkpoints are the graph-only capabilities.

## Validate your understanding

1. **Spot the nodes.** Identify the three would-be graph nodes:
   `scan()` (`monitoring-agent.ts:57`), `investigate` (`diagnostic-agent.ts:55`),
   `propose` (`recommendation-agent.ts:64`).

2. **Spot the graph-only edge.** What transition can a graph express that a
   straight pipeline can't cleanly? (The conditional "no anomalies → END" edge,
   and any loop-back/checkpoint.)

3. **Judge the over-engineering.** For three fixed nodes with one branch, is a
   full graph engine justified? (No — a pipeline + one `if` is honest. Graph
   earns its keep at branch/loop-back/resume.)

4. **See the superset.** Express fan-out (file 04) and swarm (file 06) as graphs.
   (Fan-out = star: one node with parallel edges to N nodes then a merge node.
   Swarm = complete graph with a hop-count guard on the edges.)

## See also

- `03-sequential-pipeline.md` — the line graph; the right tool until you need a
  branch or resume
- `04-parallel-fan-out.md` — the star graph
- `06-swarm-handoff.md` — the complete graph (with a cycle guard)
- `08-shared-state-and-message-passing.md` — what the graph threads through its
  nodes
- `09-coordination-failure-modes.md` — checkpoints as the recovery story for
  failed runs
- `../06-orchestration-system-design-templates/` — SECTION F: the graph build
  template
