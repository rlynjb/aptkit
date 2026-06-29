# Agent Architecture — aptkit (index)

Reasoning patterns, agentic retrieval, and multi-agent orchestration, grounded in aptkit's real code. aptkit is a **single-agent-per-capability** codebase: one shared loop (`runAgentLoop`), six agents, retrieval exposed as a tool. Multi-agent topologies are taught as study material with honest `not yet exercised` markers.

Sibling guides: `study-ai-engineering/` (what one model/agent does), `study-prompt-engineering/` (the prompt layer), `study-system-design/` (the architecture seams). This guide owns everything *above* one agent's mechanics — the loop shape, retrieval-as-control-loop, and the topologies aptkit could grow into.

## Reading order

```
  A → B → C → D → E → F  →  agent-patterns-in-this-codebase.md
```

- **00-overview.md** — start here. The shape match, the one loop, the standout pattern, the gaps.
- **agent-patterns-in-this-codebase.md** — the inventory: what aptkit actually runs.

### 01-reasoning-patterns/ — Anchor: single-agent (primary)
What aptkit *is*. The loop kernel and the patterns that run inside it.
- `01-chains-vs-agents.md`
- `02-agent-loop-skeleton.md` — the kernel all 6 agents share
- `03-react.md`
- `04-plan-and-execute.md` — not yet exercised
- `05-reflexion-self-critique.md` — rubric-improvement is the closest instance
- `06-tree-of-thoughts.md` — not yet exercised
- `07-routing.md` — the query agent's intent classifier

### 02-agentic-retrieval/ — Anchor: single-agent (primary)
The standout. Retrieval as a tool the model drives, not a prompt-splice.
- `01-agentic-rag.md` — the rag-query agent
- `02-self-corrective-rag.md` — minTopK floor + matchesFilter guard (partial)
- `03-retrieval-routing.md` — not yet exercised

### 03-multi-agent-orchestration/ — Anchor: multi-agent. Not yet exercised in aptkit.
Study material. The topologies aptkit could adopt; the sibling pipeline the reader has shipped.
- `01-when-not-to-go-multi-agent.md`
- `02-supervisor-worker.md` · `03-sequential-pipeline.md` · `04-parallel-fan-out.md`
- `05-debate-verifier-critic.md` · `06-swarm-handoff.md` · `07-graph-orchestration.md`
- `08-shared-state-and-message-passing.md` · `09-coordination-failure-modes.md`

### 04-agent-infrastructure/ — Anchor: single-agent + multi-agent
The cross-cutting disciplines aptkit actually invests in.
- `01-context-engineering.md` — injectProfile + schemaSummary
- `02-agent-memory-tiers.md` — @aptkit/memory (built, not wired)
- `03-tool-calling-and-mcp.md` — ToolRegistry + policy + Gemma emulation
- `04-agent-evaluation.md` — replay-centric eval, precision@k
- `05-guardrails-and-control.md` — the control envelope

### 05-production-serving/ — Anchor: single-agent + multi-agent
What single-call serving becomes once the unit is a loop.
- `01-cross-turn-caching.md` · `02-fan-out-backpressure.md` · `03-per-tool-circuit-breaking.md`

### 06-orchestration-system-design-templates/ — Anchor: interview templates
aptkit reframed as the answer to "design an agentic X."
- `01-multi-agent-research-assistant.md` · `02-agentic-support-system.md` · `03-agentic-coding-system.md`
