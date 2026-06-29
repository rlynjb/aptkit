# 03 — Multi-Agent Orchestration

**Anchor: multi-agent (primary). Not yet exercised in aptkit — this is the load-bearing new material, taught as study ground.**

Everything *above* one agent. aptkit does **not** run a multi-agent orchestration: its six agents are separate single-agent capabilities that don't call each other, don't share state, and don't hand off. So every file here marks `In this codebase` honestly as not-yet-exercised, and the SECTION F templates carry the refactor that would adopt each topology.

**The reader's portfolio anchor.** A 3-stage `monitor → investigate → recommend` pipeline *does* exist — in the sibling hackathon project **blooming_insights** (`../blooming_insights/lib/agents/`), which aptkit's analytics agents were extracted from. The migration plan (`docs/blooming-insights-aptkit-core-migration-plan.md`) documents it: blooming_insights composes monitoring → diagnostic → recommendation agents, and consumes `@aptkit/core` as it migrates. That sibling is the multi-agent example the reader has shipped — but aptkit itself, the toolkit, is single-agent-per-capability. Keep that line sharp: the *packages* are single-agent; the *consuming app* sequences them.

Read `01-when-not-to-go-multi-agent.md` first — it's the most important multi-agent decision. Then the topologies as shapes:

1. `01-when-not-to-go-multi-agent.md` — the escalation gate
2. `02-supervisor-worker.md` — the most useful topology
3. `03-sequential-pipeline.md` — the shape blooming_insights actually uses
4. `04-parallel-fan-out.md`
5. `05-debate-verifier-critic.md`
6. `06-swarm-handoff.md`
7. `07-graph-orchestration.md`
8. `08-shared-state-and-message-passing.md`
9. `09-coordination-failure-modes.md`
