# 03 — Multi-Agent Orchestration

The question this sub-section answers: *what changes when one agent is no
longer enough, and how do several agents coordinate without melting down.* You
already know the single-agent loop (`01-reasoning-patterns/`). This is the
newer ground. Read it slowly — it is the load-bearing material of the guide.

## Anchor: multi-agent — but read this disclaimer first

**AptKit is single-agent.** One kernel (`packages/runtime/src/run-agent-loop.ts`)
wrapped by five independent ReAct loops. There is no orchestrator, no LLM
planner choosing which agent runs, no supervisor delegating to workers, no
agent spawning sub-agents, no autonomous negotiation. So most of this
sub-section is **taught but not exercised**: you get the topology, the mental
model, an honest "Not yet exercised" marker on the in-codebase block, and a
pointer to where you'd build it.

There is exactly **one** exception, and it is real: the
`monitor → diagnose → recommend` **sequential pipeline** is *latent*. It exists
in the **data contracts** — the input types chain `Anomaly → Diagnosis →
Recommendation` — but no running code chains all three end to end. That one
file (`03-sequential-pipeline.md`) goes deep. The rest teach the pattern, then
tell you the truth.

This split is the senior-grade move. A staff engineer who can say "we
deliberately stayed single-agent because nothing has earned the 2-5x
coordination tax, and here's the exact failure that would change my mind" is
worth more than one who reaches for a swarm on day one. `01-when-not-to-go-
multi-agent.md` is that argument, and AptKit is its worked example.

## The map: topologies as a layered family

Every topology here is a different answer to "how do agents pass work and
results to each other." They stack from cheapest to most general.

```
  The multi-agent topology family (cheap/rigid at top, general/expensive at bottom)

  ┌─ NOT multi-agent ────────────────────────────────────────────────┐
  │  single-agent ReAct loop          ← AptKit lives here (all 5)     │
  │  01-when-not-to-go-multi-agent.md ← the gate you cross to leave    │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  cross only on a decomposable failure
  ┌─ Static wiring (you write the edges) ─────────────────────────────┐
  │  03-sequential-pipeline  A → B → C   ← LATENT in AptKit (real!)   │
  │  04-parallel-fan-out     A,B,C ∥ → merge                          │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  add a coordinator that decides at runtime
  ┌─ Dynamic wiring (a coordinator decides) ──────────────────────────┐
  │  02-supervisor-worker    boss → workers → boss                    │
  │  05-debate-verifier      producer ⇄ critic                        │
  │  06-swarm-handoff        peer → peer → peer (no boss)             │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  make the wiring itself a data structure
  ┌─ The inspectable superset ────────────────────────────────────────┐
  │  07-graph-orchestration  nodes + edges + checkpoints              │
  │     (every topology above is a special case of a graph)           │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  cross-cutting: how do they SHARE data?
  ┌─ The substrate ───────────────────────────────────────────────────┐
  │  08-shared-state-vs-message-passing  blackboard vs typed handoff  │
  │  09-coordination-failure-modes       what breaks + AptKit's bounds │
  └────────────────────────────────────────────────────────────────────┘
```

Read top to bottom. The gate file first (when *not* to). Then the pipeline
(the real one). Then the rest as a tour of options you can reach for, ending
with the two cross-cutting files that apply to all of them.

## Reading order

```
  01-when-not-to-go-multi-agent.md   ★ the escalation gate — read FIRST
        │   (AptKit is the worked example of correctly staying single)
        ▼
  03-sequential-pipeline.md          ★ THE deep one — latent, real, grounded
        │   (current isolated agents → future thin orchestrator)
        ▼
  04-parallel-fan-out.md             Promise.all + merge; independent subtasks only
        │
        ▼
  02-supervisor-worker.md            boss delegates; tools-style vs handoff-style
        │
        ▼
  05-debate-verifier-critic.md       producer ⇄ critic; self-critique is NOT this
        │
        ▼
  06-swarm-handoff.md                peer handoff; the infinite-handoff failure
        │
        ▼
  07-graph-orchestration.md          state machine; the inspectable superset
        │
        ├──▶ 08-shared-state-and-message-passing.md   blackboard vs typed handoff
        │
        ▼
  09-coordination-failure-modes.md   the failure table + the bounds AptKit already has
```

## Files

- **[01-when-not-to-go-multi-agent.md](01-when-not-to-go-multi-agent.md)** — the
  decision gate. Build a single-agent baseline, measure it, escalate only on a
  *decomposable* failure. The 2-5x coordination tax. AptKit is the example of
  correctly staying single-agent.
- **[02-supervisor-worker.md](02-supervisor-worker.md)** — a boss agent
  delegating to workers. Tools-style (workers are callable tools) vs
  handoff-style (workers run autonomously). Not yet exercised.
- **[03-sequential-pipeline.md](03-sequential-pipeline.md)** — the latent
  `scan → investigate → propose` pipeline, grounded in the real `Anomaly →
  Diagnosis → Recommendation` type chain. Current isolated state vs the thin
  orchestrator that would chain it, and how little has to change.
- **[04-parallel-fan-out.md](04-parallel-fan-out.md)** — `Promise.all` over
  independent subtasks, then a merge. Why the three pipeline *stages* can't
  fan out (they're dependent), but multiple *anomalies* could.
- **[05-debate-verifier-critic.md](05-debate-verifier-critic.md)** — a producer
  and a critic. Why the rubric-improvement agent is *single-agent self-critique*,
  not a two-agent debate. Different-model-family critic for blind-spot coverage.
- **[06-swarm-handoff.md](06-swarm-handoff.md)** — peers handing off with no
  boss. The infinite-handoff failure. Not yet exercised.
- **[07-graph-orchestration.md](07-graph-orchestration.md)** — nodes, edges,
  checkpoints. The inspectable superset every other topology reduces to. The
  latent pipeline as a 3-node graph.
- **[08-shared-state-and-message-passing.md](08-shared-state-and-message-passing.md)** —
  blackboard vs message passing. AptKit's latent pipeline is *message passing*
  by construction, because the contracts are typed.
- **[09-coordination-failure-modes.md](09-coordination-failure-modes.md)** — the
  failure table (infinite handoff, tool-call cascade, context bloat, synthesis
  failure, cost blowup) and which AptKit controls already bound each one, even
  single-agent.

## See also

- `../00-overview.md` — the whole system in one diagram
- `../agent-patterns-in-this-codebase.md` — the patterns table with file:line
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop kernel these
  topologies would coordinate
- `../04-agent-infrastructure/05-guardrails-and-control.md` — the control
  envelope (budgets, policy, validators) that doubles as coordination control
- `../06-orchestration-system-design-templates/` — SECTION F: the three
  build-it templates where these topologies become concrete designs
- `.aipe/study-ai-engineering/04-agents-and-tool-use/` — single-agent and
  tool-calling mechanics (not re-taught here)
