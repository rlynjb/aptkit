# Study — Agent Architecture (aptkit)

Reasoning patterns, agentic retrieval, and the orchestration topologies above one agent — grounded in aptkit's real code.

**The one-line shape:** aptkit is single-agent-per-capability. One loop (`runAgentLoop`), six capabilities, retrieval as a tool. No multi-agent orchestration in this repo.

## Reading order

Read across sub-sections A → B → C → D → E → F. Within a sub-section most files are self-contained.

1. **[00-overview.md](00-overview.md)** — start here. The whole system in one diagram, the verdict, the honest gaps.
2. **[01-reasoning-patterns/](01-reasoning-patterns/)** — how one model thinks. The loop skeleton is the kernel everything else refers back to.
3. **[02-agentic-retrieval/](02-agentic-retrieval/)** — retrieval as a control loop the agent drives. aptkit's headline pattern.
4. **[03-multi-agent-orchestration/](03-multi-agent-orchestration/)** — everything above one agent. New ground; aptkit does not do this yet.
5. **[04-agent-infrastructure/](04-agent-infrastructure/)** — context, memory, tool calling, eval, guardrails.
6. **[05-production-serving/](05-production-serving/)** — what serving becomes once the unit is a loop, not a call.
7. **[06-orchestration-system-design-templates/](06-orchestration-system-design-templates/)** — this repo reframed as interview answers.
8. **[agent-patterns-in-this-codebase.md](agent-patterns-in-this-codebase.md)** — the patterns aptkit actually instantiates, as a table.

## Cross-links to sibling guides

- Single-agent mechanics (ReAct Thought-Action-Observation, tool-calling, RAG/embeddings/chunking, agent memory two-layer split, LLM-as-judge, single-call serving): `.aipe/study-ai-engineering/` — this guide cross-references rather than re-teaches those.
- Prompt-level self-critique and system-prompt construction: `.aipe/study-prompt-engineering/`.
- Boundaries, state ownership, failure handling, the provider/retrieval seams: `.aipe/study-system-design/`.
