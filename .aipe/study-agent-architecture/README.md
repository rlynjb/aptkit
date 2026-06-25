# Study — Agent Architecture (AptKit)

Per-repo agent-architecture study guide for the AptKit monorepo. Everything
*above* one model call: the reasoning-pattern family, retrieval as a tool loop,
multi-agent orchestration (mostly latent here), the cross-cutting agent
infrastructure, and production serving for an autonomous loop.

This guide is the sibling of `study-ai-engineering` (which covers what *one*
model/agent does) and `study-prompt-engineering` (synthesis and recovery prompt
mechanics). Where those overlap, this guide cross-references rather than
re-teaches, and goes deeper on orchestration.

## The shape: single-agent

AptKit is six independent ReAct loops sharing one kernel
(`packages/runtime/src/run-agent-loop.ts`). No autonomous planner, no
supervisor, no agent-to-agent negotiation, no persistent memory. Five agents
retrieve over workspace analytics APIs; the sixth (`rag-query`) does real vector
RAG over a similarity index, driven by a local Gemma. The
"monitor → diagnose → recommend" pipeline is **latent** — connected by data
contracts, not by a live orchestrator. Read `00-overview.md` first.

## Reading order

```
  00-overview.md            ← start here: the whole system in one diagram
       │
       ▼
  01-reasoning-patterns/    ← the loop kernel + the single-agent family (the core)
       │
       ▼
  02-agentic-retrieval/     ← tool-calling as retrieval over analytics tools
       │
       ▼
  03-multi-agent-orchestration/  ← the latent pipeline + what's not yet built
       │
       ▼
  04-agent-infrastructure/  ← tool policy, coverage gate, structured output, control
       │
       ▼
  05-production-serving/    ← budgets, fallback chain, context guard under a loop
       │
       ▼
  06-orchestration-system-design-templates/  ← three interview prompts
       │
       ▼
  agent-patterns-in-this-codebase.md  ← the patterns table grounded in real files
```

## Sub-sections

- **[01-reasoning-patterns/](01-reasoning-patterns/)** — chains vs agents, the
  agent loop skeleton (`runAgentLoop`), ReAct placement, plan-and-execute,
  reflexion/self-critique (the rubric agent), tree-of-thoughts, routing (the
  query intent router).
- **[02-agentic-retrieval/](02-agentic-retrieval/)** — agentic RAG as a
  tool-calling loop: over workspace analytics tools (files 01–03), and over a
  real vector store via `rag-query` with a local Gemma + tool emulation
  (file 04). Plus self-corrective retrieval and retrieval routing.
- **[03-multi-agent-orchestration/](03-multi-agent-orchestration/)** — when not
  to go multi-agent, supervisor-worker, the latent sequential pipeline,
  parallel fan-out, debate/critic, swarm/handoff, graph orchestration, shared
  state vs message passing, coordination failure modes.
- **[04-agent-infrastructure/](04-agent-infrastructure/)** — context
  engineering, agent memory tiers, tool calling + policy + MCP, agent
  evaluation (replay artifacts), guardrails and control.
- **[05-production-serving/](05-production-serving/)** — cross-turn caching,
  fan-out backpressure, per-tool circuit breaking.
- **[06-orchestration-system-design-templates/](06-orchestration-system-design-templates/)** —
  multi-agent research assistant, agentic support/task system, agentic
  coding/build system.

## The codebase pattern file

[agent-patterns-in-this-codebase.md](agent-patterns-in-this-codebase.md) names
the exact patterns AptKit exercises, with file:line grounding.

## Honesty markers

These are real and load-bearing in the repo:
- bounded ReAct loop with two independent budgets and a forced synthesis turn
- per-capability least-privilege tool policy + pre-model coverage gate
- structured-output contract with parse + validate + one-shot recovery
- provider fallback chain + local context-window guard
- replay-artifact evaluation backbone

These are **not yet exercised** and are marked as such throughout:
- live end-to-end orchestration of the monitor → diagnose → recommend pipeline
  (the contract exists; no orchestrator runs it)
- any LLM planner/router choosing *which agent* runs (the query router picks an
  intent string, not an agent)
- supervisor-worker, parallel fan-out, debate, swarm, graph orchestration
- any *agent in this repo* that wires the episodic-memory engine — the
  `@aptkit/memory` package ships `remember`/`recall` + a `search_memory` tool, but
  no capability in `packages/agents/*` calls it; the chat CLI that does (with a
  durable `PgVectorStore`) lives in buffr (the `rag-query` vector store is still a
  read-only knowledge base, not memory)
- trajectory persistence and a multi-device "body" (deferred to a separate repo)
- cross-turn caching, fan-out backpressure, per-tool circuit breaking

Newly exercised this session (was previously "not yet"):
- **episodic-memory ENGINE shipped** — `@aptkit/memory`
  (`createConversationMemory`: `remember`/`recall` as RAG over past exchanges,
  built on the same `EmbeddingProvider` + `VectorStore` contracts as retrieval) +
  a `search_memory` tool (`createMemoryTool`). The "no cross-run memory" claim is
  now scoped: the engine exists; no agent *in this repo* wires it. See
  `04-agent-infrastructure/02-agent-memory-tiers.md`.
- **real vector retrieval** — `rag-query` does embed → ANN → ground → cite over
  `@aptkit/retrieval`; the five analytics agents still use tool-calling, not ANN
- **tool-call emulation for a weak local model** — Gemma has no native tools; the
  provider renders tools into prose and parses JSON tool calls back
