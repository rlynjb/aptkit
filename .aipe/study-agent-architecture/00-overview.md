# Agent Architecture — aptkit

The one-page orientation. Read this first; everything else zooms in.

## The shape this codebase matches

aptkit is **single-agent-per-capability**. There is exactly one agent loop in the repo — `runAgentLoop` (`packages/runtime/src/run-agent-loop.ts`) — and six agents instantiate it, each as a self-contained capability with its own prompt, tool allowlist, loop budget, and output validator. There is **no multi-agent orchestration in aptkit**: the analytics agents (recommendation, anomaly-monitoring, diagnostic-investigation, query, rubric-improvement) do not call each other, do not share state, and do not hand off. They are six separate single-agent capabilities that happen to live in one monorepo.

```
  Where aptkit sits on the three shapes

  ┌─ workflow / chain ──────────────────────────────┐
  │  engineer writes the steps; LLM fills slots      │
  └──────────────────────────────────────────────────┘
  ┌─ single-agent ──────────────────────────────────┐
  │  ★ APTKIT IS HERE ★                              │ ← we are here
  │  one runAgentLoop; model picks the tool & when   │
  │  to stop; 6 capabilities, each one actor          │
  └──────────────────────────────────────────────────┘
  ┌─ multi-agent ───────────────────────────────────┐
  │  many coordinating agents in a topology          │
  │  not yet exercised in aptkit (the 3-stage        │
  │  monitor→investigate→recommend pipeline lives in │
  │  the sibling blooming_insights repo)             │
  └──────────────────────────────────────────────────┘
```

That single-agent placement weights this guide. SECTION A (reasoning patterns) and SECTION B (agentic retrieval) carry the load, because that is what the code exercises. SECTION C (multi-agent) is taught as study material with honest `not yet exercised` markers — the topologies aptkit *could* adopt, and the refactor each would cost.

## The one loop everything hangs on

Every agent in aptkit is the same kernel with a different step function:

```
  runAgentLoop — the kernel all 6 agents share
                 packages/runtime/src/run-agent-loop.ts:76

  ┌──────────────────────────────────────────────────┐
  │  for turn in 0..maxTurns:                         │
  │    forceFinal = last turn OR budget spent         │
  │    response = model.complete({ tools unless       │
  │                                forceFinal })       │  ← step
  │    if no tool_use blocks: finalText = text; break │  ← success exit
  │    for each tool_use: tools.callTool(...)         │  ← execute
  │    messages.push(tool results)                    │  ← accumulate
  │  (loop ends at maxTurns)                          │  ← budget exit
  └──────────────────────────────────────────────────┘
```

The two things that make this a *shipped* loop, not a demo:
- **The forced final synthesis turn** (`run-agent-loop.ts:101-108`). On the last turn — or once `maxToolCalls` is spent — the loop strips the tool schemas and appends a synthesis instruction, so the model is forced to answer with what it has instead of asking for one more query. This is the most load-bearing mechanic in the repo.
- **The budget exit** (`maxTurns`, `maxToolCalls`). Nothing guarantees the model ever stops on its own; the caps are the part of the skeleton that bounds the run.

## The standout pattern: agentic retrieval

The most interesting agent-architecture decision in aptkit is that **retrieval is a tool, not a prompt-splice**. `search_knowledge_base` (`packages/retrieval/src/search-knowledge-base-tool.ts:43`) is registered as a `ModelTool`; the model calls it when it judges it needs grounding. The model owns the *when*; the loop owns the *budget*. The `rag-query` agent (`packages/agents/rag-query/src/rag-query-agent.ts`) is the capstone instance — read SECTION B for the full walk.

## Reading order

```
  A → B → C → D → E → F → patterns-in-this-codebase

  A  reasoning-patterns      the loop kernel + ReAct + routing (what aptkit IS)
  B  agentic-retrieval       retrieval-as-a-tool (the standout)
  C  multi-agent             study material; not yet exercised in aptkit
  D  agent-infrastructure    context, memory tiers, tool/MCP, eval, guardrails
  E  production-serving      cross-turn cache, fan-out, per-tool breaking
  F  system-design templates aptkit reframed as interview answers
```

`agent-patterns-in-this-codebase.md` (root) is the table of what aptkit actually runs. Start there if you want the inventory before the theory.

## Honest gaps (named, not hidden)

- **No multi-agent orchestration in aptkit.** No supervisor, no handoff, no agent-to-agent message passing.
- **No planner / replanning.** Plan-and-execute is not implemented; the loop is ReAct-shaped.
- **No reflexion loop except rubric-improvement**, which is a self-judging *agentic improvement* loop, not a draft→critique→revise loop over its own answer.
- **Memory is built but not wired into any agent.** `@aptkit/memory` (`createConversationMemory`, `search_memory` tool) exists and reuses the retrieval contracts, but no aptkit agent loop calls it. Studio lists it in its catalog; buffr's session runtime is the intended consumer. Marked `not yet exercised` throughout.

## See also

- `study-ai-engineering/` — ReAct mechanics, RAG mechanics, tool-calling, agent memory two-layer split, single-call serving
- `study-prompt-engineering/` — the prompt-level mechanics under the agents' system templates
- `study-system-design/` — provider/retrieval abstraction seams, replay-centric evaluation
