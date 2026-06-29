# ReAct

**Industry standard.** "ReAct," "reason+act," "the tool-use loop." Type label: reasoning pattern (the baseline).

## Zoom out, then zoom in

ReAct is the default single-agent pattern: interleave reasoning and action until you can answer. Every aptkit agent that takes tools runs it. This file's job isn't to re-teach the Thought-Action-Observation mechanics (that's in `study-ai-engineering`) — it's *placement*: ReAct is the baseline, and aptkit hasn't escalated past it because it hasn't needed to.

```
  Zoom out — ReAct is the step-function aptkit's loop runs

  ┌─ Pattern family (SECTION A) ────────────────────────────┐
  │  ★ ReAct ★  → plan-execute → reflexion → tree-of-thoughts│ ← we are here
  │  (the baseline)  (escalate only on a named failure)      │
  └───────────────────────────┬──────────────────────────────┘
                              │ instantiated as
  ┌─ Loop layer ──────────────▼──────────────────────────────┐
  │  runAgentLoop: model.complete ⇄ callTool ⇄ accumulate     │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** the named pattern (ReAct) → the loop kernel (`02-agent-loop-skeleton.md`). **Axis: where does the reasoning live?** In ReAct, reasoning and acting are *interleaved in the same loop* — there's no separate plan phase. Trace that and the seam to plan-and-execute pops: plan-and-execute splits reasoning out front; ReAct keeps it inline. aptkit is entirely on the inline side.

## How it works

### Move 1 — the mental model

ReAct is the loop kernel from the previous file with the step function prompted to *think out loud, then act*. The model's text blocks are the reasoning; its `tool_use` blocks are the action; the `tool_result` it gets back is the observation. Same loop, no new machinery.

```
  ReAct = the loop kernel, prompted to interleave thought + action

  reason (text block) → act (tool_use) → observe (tool_result) → reason → ...
       │                                                              │
       └──────────────── until: answer, or budget exit ──────────────┘
```

### Move 2 — placement and the escalation ladder

**Where aptkit sits.** The rag-query agent is pure ReAct: its prompt tells the model to search first, then ground its answer. The model reasons about what to search, calls `search_knowledge_base`, observes the chunks, and either searches again or answers.

```typescript
// packages/agents/rag-query/src/rag-query-agent.ts:20-27 (the ReAct nudge)
'Always call the search_knowledge_base tool first to retrieve relevant',
'passages before answering. Ground every answer in the retrieved chunks and cite',
'their sources. If the knowledge base does not contain the answer, say so plainly',
```

The recommendation agent is the multi-tool version: 13 read-only tools in its allowlist (`recommendation-agent.ts:21-35`), and the model decides which to query and in what order to build evidence before proposing actions. Still ReAct — reasoning and acting interleaved, no plan phase.

**The escalation framing — why aptkit stays here.**

```
  Default to ReAct.
    │
    ├─ measure: success rate, tool-call accuracy, latency, cost
    │
    └─ escalate only when a SPECIFIC failure ReAct can't fix appears
       (none has, in aptkit — so no plan-execute, no reflexion-over-answer)
```

aptkit's escalations are *targeted*, not pattern swaps:
- A weak local model passing `top_k: 1` and starving multi-part questions → the `minTopK` floor (`search-knowledge-base-tool.ts:51`), not a planner.
- The model asking for one more query forever → the forced synthesis turn, not a reflexion loop.
- Prose instead of JSON → the recovery turn, not tree-of-thoughts.

Each fix addresses a named failure mode inside the ReAct loop. That's the senior move: identify the specific failure, patch it, don't reach for a heavier pattern.

### Move 3 — the principle

Most teams jump past ReAct prematurely. The strong prior is to start here, measure, and escalate only on a named failure. aptkit's whole agent layer is ReAct-with-targeted-hardening, and the hardening (minTopK, forced synthesis, recovery turn) is more interview-worthy than a premature jump to multi-agent would be.

## Primary diagram

```
  ReAct in aptkit — rag-query, one frame

  ┌─ system prompt: "search first, ground, cite" ───────────┐
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  reason ──► search_knowledge_base(query, top_k)  [Service→Retrieval hop]
    ▲                          │
    │                          ▼
  observe ◄── ranked chunks + citations ◄── InMemoryVectorStore
    │
    └─► enough? → answer (cited)   |   not enough? → reason again
        (budget: maxToolCalls 4, then forced synthesis)
```

## Elaborate

ReAct came from the observation that letting a model reason in text *between* actions beats forcing it to act blind. In aptkit the reasoning is implicit — the agents don't demand an explicit "Thought:" prefix; the model's prose between tool calls is the reasoning. That's the pragmatic version: you get ReAct's interleaving without the brittle output-format contract.

## Interview defense

**Q: What reasoning pattern do your agents use?**
ReAct — interleaved reason/act/observe in one loop, no separate plan phase. The rag-query agent searches then grounds; the recommendation agent queries up to 13 read-only tools to build evidence before proposing. I haven't escalated past ReAct because every failure I hit was patchable inside the loop — a top_k floor, a forced synthesis turn, a JSON recovery turn.

```
  reason ⇄ act ⇄ observe — escalate only on a named failure
```
*Anchor: "I built a ReAct baseline, measured it, patched specific failures" beats "I reached for multi-agent."*

**Q: When would you move off ReAct?**
When a failure appears that's structurally unfixable inside the loop — e.g. if planning quality, not execution, were the bottleneck (then plan-and-execute), or if I needed an independent reviewer to catch errors the producer shares blind spots on (then verifier-critic). Neither has shown up in aptkit.

## See also

- `02-agent-loop-skeleton.md` — the loop ReAct's step function runs in
- `04-plan-and-execute.md` — the first escalation, not yet exercised
- `02-agentic-retrieval/01-agentic-rag.md` — ReAct with retrieval as the tool
- `study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` — T-A-O mechanics (cross-ref)
