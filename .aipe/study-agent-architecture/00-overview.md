# Agent Architecture — aptkit

The one-page orientation. Read this first, then the sub-section READMEs in order.

## The verdict up front

aptkit is a **single-agent-per-capability** codebase. There is exactly one reasoning loop — the agent loop / ReAct loop (`runAgentLoop`, `packages/runtime/src/run-agent-loop.ts`) — and every capability is one instance of it wearing a different prompt, tool allowlist, loop budget, and output validator. There are 6 such capabilities. There is **no multi-agent orchestration** in this repo: no supervisor delegating to workers, no agent-to-agent handoff, no shared blackboard between agents. The analytics agents (recommendation, anomaly-monitoring, diagnostic-investigation) are *separate single-agent capabilities*, not a coordinated topology — a host app calls them in sequence, but no aptkit code makes one agent invoke another.

The headline pattern worth studying here is **agentic retrieval**: retrieval is a tool the model decides to call (`search_knowledge_base`, `packages/retrieval/src/search-knowledge-base-tool.ts`), not a prompt-splice the engineer wires in front of generation. The model owns the *when*; the loop owns the *budget*. That split is the spine of this whole guide.

## The whole system in one diagram

The agent loop sits in the Service layer, between provider-neutral models below it and capability-specific validators above it.

```
  aptkit agent architecture — where the loop lives

  ┌─ Capability layer (packages/agents/*) ──────────────────────┐
  │  6 agents = prompt package + tool policy + loop config       │
  │  + output validator. Each calls runAgentLoop once per run.   │
  │  rag-query · recommendation · anomaly-monitoring ·           │
  │  diagnostic-investigation · query · rubric-improvement       │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  runAgentLoop(options)
  ┌─ Runtime layer (packages/runtime) ──▼───────────────────────┐
  │  ★ THE AGENT LOOP ★  step → execute tool → accumulate →      │ ← we are here
  │  terminate (maxTurns / maxToolCalls + forced synthesis turn) │
  └──────────┬─────────────────────────────────┬─────────────────┘
             │ model.complete()                 │ tools.callTool()
  ┌─ Provider layer ▼──────────┐   ┌─ Tools layer ▼──────────────┐
  │ ModelProvider adapters:    │   │ ToolRegistry + ToolPolicy   │
  │ anthropic · openai · gemma │   │ filterToolsForPolicy        │
  │ (local, emulates tools) ·  │   │ (least-privilege allowlist) │
  │ fallback · local guard     │   └──────────┬──────────────────┘
  └────────────────────────────┘              │ search_knowledge_base
                                   ┌─ Retrieval layer ▼───────────┐
                                   │ EmbeddingProvider + VectorStore│
                                   │ (RAG pipeline; memory reuses   │
                                   │  the same two contracts)       │
                                   └────────────────────────────────┘
```

## What this repo actually exercises

| Sub-section | Coverage in aptkit |
| --- | --- |
| A — Reasoning patterns | **Live.** ReAct loop with a forced final synthesis turn; routing lives in the query agent's intent classifier. Plan-and-execute / reflexion / ToT: study material, not built. |
| B — Agentic retrieval | **Live, headline.** `search_knowledge_base` as an agent tool; minTopK floor + hallucination-tolerant filter harden a weak local model. |
| C — Multi-agent orchestration | **Not built in aptkit.** Covered as new ground. The reader shipped a 3-stage monitor→investigate→recommend pipeline with typed handoffs in a sibling project (LoomiConnect / blooming-insights); aptkit is single-agent-per-capability. |
| D — Agent infrastructure | **Live.** Context engineering (`injectProfile`), tool calling + emulation (gemma), agent memory (built, not yet wired into an aptkit agent), guardrails (the loop's caps). Eval is replay-centric. |
| E — Production serving | **Partial.** Tool-result truncation is in; cross-turn caching / fan-out backpressure / per-tool circuit breaking are not yet exercised. |
| F — System design templates | All three generated as interview framings of this repo. |

## Reading order

A → B → C → D → E → F. Start with `01-reasoning-patterns/02-agent-loop-skeleton.md` — it is the kernel every other file refers back to.

## Honest gaps (named, not invented)

- No planner / replanning loop. The loop re-decides per turn (ReAct), it does not build a plan up front.
- No agent-to-agent handoff anywhere in aptkit.
- No reflection / self-critique loop, except `rubric-improvement`, which is an agentic *improvement* loop over a scored subject — close to reflexion in shape but pointed at an external subject, not the agent's own output.
- Agent memory (`@aptkit/memory`) is built and tested but **not yet wired into any aptkit agent** — buffr's session runtime is the intended consumer. Marked `not yet exercised` throughout.
- Cross-turn caching, fan-out backpressure, per-tool circuit breaking: `not yet exercised`.
