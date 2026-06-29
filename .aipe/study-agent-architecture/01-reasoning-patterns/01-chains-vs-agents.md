# Chains vs Agents — the boundary

**Industry term:** chain / workflow vs agent (autonomous loop). *Industry standard.*

## Zoom out, then zoom in

Okay — here's the whole question before we touch a line of code. Every LLM feature you build sits on one side of a single line: did *you* write the order of steps, or does the *model* pick the next step at runtime? That's the chains-vs-agents boundary, and it's the entry point to every reasoning pattern in this sub-section.

```
  Zoom out — the boundary inside the Capability layer

  ┌─ Capability layer (packages/agents/*) ──────────────────────┐
  │                                                              │
  │   ★ THE BOUNDARY ★                                           │ ← we are here
  │   left of it:  CODE decides the step order  (chain)          │
  │   right of it: MODEL decides the next action (agent)         │
  │                                                              │
  └───────────────────────────────┬──────────────────────────────┘
                                   │ runAgentLoop → model.complete()
  ┌─ Runtime layer (packages/runtime) ──▼───────────────────────┐
  │  the agent loop — only reached when you're on the right side │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit is almost entirely on the *right* side. Every capability hands control to the model through `runAgentLoop`. But the distinction matters because the model's prompt can *constrain* the loop so hard it behaves like a chain — and aptkit does exactly that in places. The boundary is real even when one side is wearing the other's clothes.

## The structure pass

**Layers.** Two: the capability (outer, where the order is decided) and the loop (inner, where a single step runs).

**The axis to trace: who decides control flow?** Hold that one question constant.

```
  "who decides control flow?" — traced across the boundary

  ┌─ chain ──────────┐   seam    ┌─ agent ───────────┐
  │ CODE decides     │ ═══╪═════► │ MODEL decides     │
  │ step1→step2→step3│ (it flips) │ next action / stop │
  └──────────────────┘           └───────────────────┘
         ▲                                ▲
         └──── same axis, two answers ────┘
```

**The seam.** The flip happens at the call into `runAgentLoop`. Above it, the engineer's code runs in a fixed order. Below it, the model emits the next action and the loop obeys. That boundary is load-bearing: it's where unpredictability enters the system.

## How it works

**Use case in aptkit:** the recommendation flow looks like a chain from a distance — a host app runs anomaly-monitoring, then diagnostic-investigation, then recommendation in that fixed order. But each *stage* is an agent: inside `RecommendationAgent.propose` the model decides which of 13 read-only tools to call and when to stop. So the system is a hybrid — a chain on the outside, a loop inside each box. That's the most common production shape, and it's the one to recognize on sight.

### Move 1 — the mental model

You already know the shape from frontend. A chain is a `.then()` chain of single-purpose functions: `validate().then(transform).then(save)`. You wrote the order; each function fills its slot. An agent is a `while` loop where the body asks a model "what now?" each iteration — like a reducer whose next action comes from outside your code.

```
  Chain (engineer writes the steps):
    Input → Step 1 → Step 2 → Step 3 → Output
            (model fills each slot; never chooses what comes next)

  Agent (model writes the steps at runtime):
  ┌───────────────────────────────────────────────┐
  │              Agent control loop                │
  │   ┌─────────┐                                  │
  │   │ Reason  │ ← model decides next action      │
  │   └────┬────┘                                  │
  │        ▼                                       │
  │   ┌─────────┐                                  │
  │   │ Act     │ ← call a tool                    │
  │   └────┬────┘                                  │
  │        ▼                                       │
  │   ┌─────────────┐                              │
  │   │ Observe     │ ← read result                │
  │   └────┬────────┘                              │
  │        └──────────── loop or stop              │
  └───────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Where aptkit puts the model in control.** Look at `RagQueryAgent.answer` (`packages/agents/rag-query/src/rag-query-agent.ts:62`). The agent never says "step 1: search, step 2: answer." It hands the model a tool and a system prompt and lets the loop run:

```ts
// rag-query-agent.ts:66 — control handed to the model
const { finalText } = await runAgentLoop({
  model: this.options.model,
  tools: this.options.tools,
  system: this.system,        // "Always call search_knowledge_base first..."
  userPrompt: question,
  toolSchemas,                // the tools the model MAY pick from
  maxTurns: 6,                // ...but bounded
  maxToolCalls: 4,
});
```

The model decides whether to search, what query to search with, whether to search again, and when to stop and answer. That's the agent side.

**Where the prompt drags it back toward a chain.** The system prompt says *"Always call the search_knowledge_base tool first before answering."* That's the engineer reaching across the boundary to pin the first step. The model still *could* answer without searching, but the prompt strongly orders it. This is the hybrid in miniature: structurally an agent, behaviorally near-chain on turn one. Name it honestly in an interview — "we left it an agent but constrained the first move in the prompt, accepting that the model can still deviate."

**The decision rule, concretely.** Use a chain when you know the steps in advance and they don't depend on what the model finds. Use an agent when the steps depend on the result of earlier steps. aptkit's recommendation agent is an agent because it can't know up front which of the 13 tools will have the evidence it needs — it has to look, then decide what to look at next.

### Move 3 — the principle

The cost of an agent is unpredictability: variable step count, variable cost, harder debugging. You pay that cost only when the path genuinely can't be written ahead of time. When it can, a chain is cheaper, more debuggable, and more honest. The mistake is reaching for an agent because it sounds advanced — the senior move is choosing a chain when a chain is enough.

## Primary diagram

```
  The boundary, with aptkit's hybrid marked

  ┌─ Host app (outside aptkit) ─────────────────────────────────┐
  │  monitor() → investigate() → recommend()   ← CODE order      │  CHAIN
  └───────┬───────────────┬───────────────────┬──────────────────┘
          ▼               ▼                    ▼
     ┌─────────┐     ┌─────────┐         ┌─────────┐
     │ anomaly │     │diagnostic│        │recommend│   each box:
     │  agent  │     │  agent   │        │  agent  │   runAgentLoop
     └────┬────┘     └────┬─────┘        └────┬────┘   ← MODEL order
          │ model picks tools, decides when to stop    AGENT (inside)
          ▼                                            
   ┌──────────────────────────────────────────────────┐
   │  runtime: runAgentLoop (packages/runtime)          │
   └────────────────────────────────────────────────────┘
```

## Elaborate

The chains-vs-agents line is the oldest distinction in agent design and the one people get wrong most often. The "agents" framing got popular because autonomous loops demo well; the production reality is that most shipped LLM systems are chains with one or two agentic stages. aptkit reflects that: a fixed outer sequence, agentic stages inside. Every other file in this sub-section (`02-agent-loop-skeleton` onward) is a way of structuring what happens *inside* the loop once you've decided to be on the agent side.

## Interview defense

**Q: Is aptkit's recommendation flow a chain or an agent?**

It's the hybrid — a chain outside, a loop inside each stage.

```
  outer: CODE fixes monitor → investigate → recommend   (chain)
  inner: each stage = runAgentLoop, model picks tools    (agent)
```

The host app fixes the three-stage order; that's a chain. But inside `RecommendationAgent.propose` the model freely picks among 13 tools and decides when to stop — that's an agent. Calling it purely one or the other misses the design.

*Anchor: chain outside, loop inside — name both altitudes.*

**Q: When would you NOT use an agent here?**

When the steps are known. If recommendation always needed exactly "fetch segments, then fetch campaigns, then format," I'd write that as three function calls and drop the loop — cheaper, deterministic, debuggable. The loop earns its cost only because the agent can't know which evidence it needs until it looks.

*Anchor: agent cost is unpredictability; pay it only when the path can't be pre-written.*

## See also

- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — what's inside the loop once you're on the agent side.
- [03-react.md](03-react.md) — the specific reasoning pattern aptkit's loop runs.
- ReAct Thought-Action-Observation mechanics: `.aipe/study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md`.
- The provider/tool seams this boundary sits on: `.aipe/study-system-design/`.
