# Chains vs Agents — the boundary

**Industry standard.** "Workflow vs agent," "static chain vs autonomous loop." Type label: pattern boundary.

## Zoom out, then zoom in

Before any reasoning pattern, the first question: is there a loop at all? Here's where that boundary sits in aptkit.

```
  Zoom out — the control-flow boundary in aptkit

  ┌─ Caller layer (a capability's public method) ────────┐
  │  RagQueryAgent.answer()   RecommendationAgent.propose│
  │  classifyIntent()  ← a CHAIN step (one call, no loop)│
  └───────────────────────────┬──────────────────────────┘
                              │ hands a system prompt + tools
  ┌─ Loop layer ──────────────▼──────────────────────────┐
  │  ★ runAgentLoop ★  ← the AGENT: model picks next move │ ← we are here
  │  run-agent-loop.ts:76                                 │
  └───────────────────────────┬──────────────────────────┘
                              │ emits tool-call intent
  ┌─ Tool layer ──────────────▼──────────────────────────┐
  │  ToolRegistry.callTool — the harness runs it          │
  └───────────────────────────────────────────────────────┘
```

The distinction is structural. In a **chain**, you the engineer wrote the steps; the model fills a slot but never chooses what comes next. In an **agent**, the model writes the steps at runtime — it decides which tool to call and when to stop. aptkit has both, and the cleanest way to see the line is `classifyIntent` (a chain) calling into `runAgentLoop` (an agent).

## Structure pass

**Layers:** caller → loop → tool. **Axis to trace: who decides control flow?** Hold that one question constant and watch the answer flip as you descend.

```
  "who decides control flow?" — traced down aptkit's layers

  ┌───────────────────────────────────────┐
  │ caller: classifyIntent (query agent)  │  → CODE decides (one call,
  │ query/src/intent.ts:13                │     fixed: classify then route)
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ loop: runAgentLoop                  │  → LLM decides (picks tool,
      │ run-agent-loop.ts:98                │     picks when to stop)
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ tool: callTool                  │  → TOOL just runs
          └─────────────────────────────────┘
```

**The seam that matters** is between caller and loop: control flips from CODE to LLM. That's load-bearing — it's the boundary where you hand the steering wheel to the model. `classifyIntent` deliberately stays a chain (you don't want the router to freewheel); `answer()` hands off to the loop because the retrieval path can't be predicted.

## How it works

### Move 1 — the mental model

You know how a `fetch()` chain is `.then().then().then()` — you wrote every link, the data just flows through? That's a chain. Now picture a `while` loop where the *condition and the body* are chosen by something else on every iteration — you wrote the loop, but not what it does each pass. That's an agent.

```
  Chain (engineer writes the steps) vs Agent (model writes them)

  CHAIN:  input → [classify] → [route] → output
                  ▲ you wrote this order; LLM fills each slot

  AGENT:  ┌─────────────────────────────────────┐
          │  Reason  → model picks next action   │
          │     │                                │
          │     ▼                                │
          │  Act     → call a tool               │
          │     │                                │
          │     ▼                                │
          │  Observe → read result               │
          │     └──── loop or stop (model/budget)│
          └─────────────────────────────────────┘
```

### Move 2 — the walkthrough

**The chain in aptkit: `classifyIntent`.** The query agent first runs a fixed classify-then-route step. One model call, no tools, no loop — the model fills a single slot (one word), and *your code* decides what happens with it.

```typescript
// packages/agents/query/src/intent.ts:13
const response = await model.complete({
  system: 'Classify the user query as exactly one word: monitoring / diagnostic / recommendation...',
  messages: [{ role: 'user', content: query }],
  maxTokens: 16,            // ← tiny budget: this is a slot-fill, not a reasoning loop
});
return parseIntent(text);   // ← intent.ts:4 — YOUR code maps the word to a route
```

The model never sees a tool here. It can't decide to "search first" or "ask a clarifying question." It fills the slot; the chain moves on. That's the whole point of using a chain for routing — it's deterministic and cheap.

**The agent in aptkit: `runAgentLoop`.** Contrast `RagQueryAgent.answer()` — it hands the model a tool schema and a loop, and the model decides whether and when to call `search_knowledge_base`.

```typescript
// packages/agents/rag-query/src/rag-query-agent.ts:66
const { finalText } = await runAgentLoop({
  model: this.options.model,
  tools: this.options.tools,          // ← the model can now act
  toolSchemas,                         // ← it's told what's available
  maxTurns: 6, maxToolCalls: 4,        // ← but the LOOP owns the budget
  synthesisInstruction: buildSynthesisInstruction(...),
});
```

The model owns *when* to search; the loop owns *how many times*. That split is the agent. **The boundary condition that breaks people:** if you give an agent no budget exit, it can loop tool calls forever — the model has no obligation to ever stop. aptkit's `maxTurns`/`maxToolCalls` are not optional polish; they're what makes the agent shippable. (Full treatment in `02-agent-loop-skeleton.md`.)

### Move 3 — the principle

Use a chain when you know the steps in advance; use an agent when the steps depend on what the model finds. The cost of an agent is unpredictability — variable step count, variable cost, harder debugging. aptkit pays that cost exactly where it's worth it (retrieval, multi-tool investigation) and refuses to pay it where it isn't (intent classification stays a chain).

## Primary diagram

```
  aptkit's chain→agent handoff, end to end

  ┌─ Caller (query agent) ───────────────────────────────┐
  │  classifyIntent  ──one call, no tools──►  intent word │  CHAIN
  │  parseIntent(word)  ──►  pick which agent to run       │
  └───────────────────────────┬──────────────────────────┘
                              │ control flips here (the seam)
  ┌─ Loop (runAgentLoop) ─────▼──────────────────────────┐
  │  model.complete(tools) ⇄ callTool  ⇄ accumulate       │  AGENT
  │  exit on: no tool_use (success) OR maxTurns (budget)  │
  └───────────────────────────────────────────────────────┘
```

## Elaborate

The chains-vs-agents line is the entry point to the whole reasoning-pattern family: every pattern below (ReAct, plan-and-execute, reflexion) is a way of structuring what happens *inside* the loop. aptkit lands firmly on the agent side for its capabilities, but it's disciplined about it — the cheap, predictable parts (intent routing, dimension validation) stay as code, not as model decisions.

## Interview defense

**Q: Is aptkit a workflow or an agent system?**
Single-agent. One loop, `runAgentLoop`, six capabilities on top of it. The model picks the tool and picks when to stop; that's the agent signature. But I keep the router (`classifyIntent`) as a deterministic chain step — you don't hand the steering wheel to the model for a job a one-word classification solves.

```
  caller (CODE decides) ═══seam═══► loop (LLM decides)
  classifyIntent                    runAgentLoop
```
*Anchor: the line is "who chooses the next step." Code in the router, model in the loop.*

**Q: Why not make routing an agent too?**
Cost and debuggability. An agent router adds variable latency and a larger failure surface for a job that a single classify call does deterministically. I'd only escalate it to an agent if classification started failing on ambiguous queries that need a tool to disambiguate.

## See also

- `02-agent-loop-skeleton.md` — the kernel the agent side runs
- `07-routing.md` — the chain-side router in full
- `study-ai-engineering/04-agents-and-tool-use/01-agents-vs-chains.md` — the mechanics walk (cross-ref)
