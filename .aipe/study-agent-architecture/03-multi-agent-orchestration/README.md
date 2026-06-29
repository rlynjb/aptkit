# C — Multi-Agent Orchestration

Everything above one agent. This is the load-bearing new material — taught as new ground, not a refresher.

Anchor: multi-agent (primary).

**aptkit does not do this.** It is single-agent-per-capability: six independent loops, no supervisor, no agent-to-agent handoff, no shared blackboard. So every topology file here is study material with `In this codebase` marked "Not yet implemented," and the system design templates in SECTION F carry the concrete refactor.

**The reader has shipped this, though.** A 3-stage monitor → investigate → recommend pipeline with typed handoffs exists in a sibling project (LoomiConnect / blooming-insights) — referenced throughout as the multi-agent shape you've already built. aptkit *extracted the single-agent capabilities* from that lineage; the orchestration stayed in the app.

Read `01-when-not-to-go-multi-agent.md` first — the single most important multi-agent decision is whether to be multi-agent at all, and aptkit's answer is "not yet."

## Files

1. [01-when-not-to-go-multi-agent.md](01-when-not-to-go-multi-agent.md) — **read first.** The escalation gate. aptkit hasn't crossed it.
2. [02-supervisor-worker.md](02-supervisor-worker.md) — the most common, most useful topology.
3. [03-sequential-pipeline.md](03-sequential-pipeline.md) — output of one agent feeds the next. The shape the reader shipped in blooming-insights.
4. [04-parallel-fan-out.md](04-parallel-fan-out.md) — independent subtasks concurrently, then merge.
5. [05-debate-verifier-critic.md](05-debate-verifier-critic.md) — agents argue or critique to refine.
6. [06-swarm-handoff.md](06-swarm-handoff.md) — peer-to-peer control transfer, no boss.
7. [07-graph-orchestration.md](07-graph-orchestration.md) — control flow as an explicit, checkpointed state machine.
8. [08-shared-state-and-message-passing.md](08-shared-state-and-message-passing.md) — how agents communicate.
9. [09-coordination-failure-modes.md](09-coordination-failure-modes.md) — the failures that only exist above one agent.
