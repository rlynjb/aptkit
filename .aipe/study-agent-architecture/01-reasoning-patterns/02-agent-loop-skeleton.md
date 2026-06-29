# The Agent Loop Skeleton

**Industry term:** the agent loop / control loop (`runAgentLoop`). *Industry standard.*

## Zoom out, then zoom in

This is the file the rest of the guide refers back to, so let's get it exactly right. Chains-vs-agents answered *is there a loop at all.* This file answers *what is in the loop, and which parts are load-bearing.* Every named pattern below — ReAct, plan-and-execute, reflexion — and every multi-agent topology in SECTION C is this same skeleton with a different step function. Learn it once here.

```
  Zoom out — the loop is the whole Runtime layer's job

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  6 agents call runAgentLoop with their prompt + tools + caps │
  └───────────────────────────────┬──────────────────────────────┘
                                   │ runAgentLoop(options)
  ┌─ Runtime layer (packages/runtime/src/run-agent-loop.ts) ──▼──┐
  │  ★ THE SKELETON ★                                            │ ← we are here
  │  for turn in 0..maxTurns:                                    │
  │    step → execute tools → accumulate → terminate?            │
  └──────────┬─────────────────────────────────┬─────────────────┘
             │ model.complete()                 │ tools.callTool()
  ┌─ Provider ▼─────┐               ┌─ Tools ▼──────────────────┐
  │ ModelProvider   │               │ ToolExecutor.callTool     │
  └─────────────────┘               └───────────────────────────┘
```

Zoom in: there's one `runAgentLoop` function in the entire repo. Six agents call it. It is 150 lines and it is the single most load-bearing piece of agent code in aptkit. We're going to isolate its kernel and name each part by what breaks when it's missing.

## The structure pass

**Layers.** Outer: the `for` loop over turns. Inner: one turn (a model call plus tool execution).

**Axis: control — who decides the next move, and who decides to stop?** Trace it down.

```
  "who decides?" — held constant down the loop's layers

  ┌───────────────────────────────────────┐
  │ outer: the for-loop (fixed turn budget)│  → CODE decides the cap
  └───────────────────────────────────────┘
      ┌─────────────────────────────────────┐
      │ inner: model.complete (per turn)    │  → MODEL decides next action
      └─────────────────────────────────────┘
          ┌─────────────────────────────────┐
          │ innermost: tools.callTool       │  → TOOL runs, returns a result
          └─────────────────────────────────┘

  the answer flips at each altitude — that contrast IS the skeleton
```

**The seam.** The model emits *intent* (a `tool_use` block); the loop runs the tool and feeds the result back. The model never touches the tool directly. That boundary is the entire control and safety story — it's why a least-privilege tool policy can constrain what the model can reach.

## How it works — the load-bearing skeleton

**Use case:** every aptkit agent. `rag-query` runs the loop to decide whether to search; `recommendation` runs it to gather evidence across tools; `rubric-improvement` runs it to pull judgment history. Same kernel, different step function and budget.

### Move 1 — the kernel (this is the whole pattern)

Here's the smallest thing that is still an agent loop — nothing removed it can survive losing:

```
  runLoop(state, tools):
    while not done:
      action = step(state)            # the model picks the next move
      if action.is_final:             # TERMINATION exit 1: success
        return action.output
      result = execute(action, tools) # the harness runs the tool
      state  = update(state, result)  # accumulate the observation
      if budget_exceeded(state):      # TERMINATION exit 2: hard stop
        return fallback(state)
```

That's it. Four load-bearing parts. We'll name each by what breaks when it's gone.

### Move 2 — name each part by what breaks

**state (accumulate).** Without it, every turn is amnesiac — you'd have N independent calls, not a loop. State is the thing that *makes* it a loop. In aptkit, state is the growing `messages` array:

```ts
// run-agent-loop.ts:94 — state is the message history
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
// ...each turn appends the assistant turn and the tool results:
messages.push({ role: 'assistant', content: response.content });  // :124
messages.push({ role: 'user', content: toolResults });            // :189
```

Strip those `push` calls and the model re-answers turn one forever, never seeing what it retrieved.

**step (the single model call).** Without it, nothing chooses the next action. This is the only "smart" part; everything else is plumbing.

```ts
// run-agent-loop.ts:103 — the one smart call per turn
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,  // ← tools withheld on the final turn
  maxTokens,
  signal,
});
```

**execute (run the tool, feed the result back).** The model emits intent; the harness runs it. Look at the boundary — the model's `tool_use` block becomes a real call, and only the *result* goes back into state:

```ts
// run-agent-loop.ts:159 — intent → execution → observation
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
toolCall.result = result;
resultContent = truncate(JSON.stringify(result));   // :162 — capped at 16k chars
// ...the result is pushed back as a tool_result block (:181)
```

That `truncate` (16,000 chars, `run-agent-loop.ts:52`) is the first hint of production hardening sitting on the skeleton — a runaway tool result can't blow the context window.

**termination — TWO exits, both required.** This is the part people forget, and naming both is the point of this file.

```
  Termination — two exits, the second is the one people forget

  success exit ─► model returns text with no tool_use → break
                  (run-agent-loop.ts:132)

  budget exit  ─► turn == maxTurns-1  OR  toolCalls >= maxToolCalls
                  → forceFinal: withhold tools, demand an answer
                  (run-agent-loop.ts:101-102)
```

In aptkit both live in the same place. The success exit:

```ts
// run-agent-loop.ts:131 — no tool calls means the model is done
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {
  finalText = text;
  break;
}
```

The budget exit is aptkit's sharpest move — it doesn't just stop, it forces a final answer:

```ts
// run-agent-loop.ts:101 — the forced synthesis turn
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
// when forceFinal: tools are withheld (tools: undefined) AND a synthesis
// instruction is appended ("You have NO more tool calls available...")
```

Here's why that matters concretely: nothing guarantees the model ever reaches the success exit on its own — a weak local model can cycle tool calls indefinitely. So on the last allowed turn aptkit *removes the tools* and appends `buildSynthesisInstruction` (`run-agent-loop.ts:72`): *"You have NO more tool calls available... Do not say you need more queries."* The model is structurally unable to call another tool and is told to answer now. The budget exit isn't bolt-on hardening — it's part of the skeleton. Ship the loop without it and you burn tokens in a silent loop.

**The optional hardening (not skeleton).** Everything past those four parts is hardening layered on top:
- tool-result truncation (`:52`) — keeps one tool from flooding the window.
- the recovery turn (`run-agent-loop.ts:204`) — if the final text doesn't parse into the required output, run one more constrained call with a recovery prompt. Used by recommendation and rubric-improvement.
- trace emission (`step`, `tool_call_start/end`, `model_usage`) — observability, not control.

Naming which is skeleton and which is hardening *is* the lesson.

### Move 2.5 — single-turn vs multi-turn

These aren't two patterns. They're the same kernel with a different iteration count. A one-pass detector exits the `while` after one step; rag-query runs it up to 6 times. aptkit sets the count per capability: `rag-query` uses `maxTurns: 6, maxToolCalls: 4`; `rubric-improvement` uses `maxTurns: 6, maxToolCalls: 3`. Same `runAgentLoop`, different budget.

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination needs **both** a success condition and a hard budget. The bridge to SECTION C: multi-agent is not a new primitive — it's N of this skeleton composed. And it's only "N independent loops merged" when the agents are genuinely independent. The moment one agent needs another's output, you're traversing a dependency DAG with an orchestrator and a merge strategy, not running N copies of one loop. aptkit composes zero of these today; the skeleton is the unit it would compose with.

## Primary diagram

```
  runAgentLoop — the full skeleton, one frame
  (packages/runtime/src/run-agent-loop.ts)

  user prompt ─► messages[]  (STATE — accumulates every turn)
                    │
       ┌────────────▼─────────── for turn in 0..maxTurns ──────────┐
       │                                                            │
       │  forceFinal = (turn == last) OR (toolCalls >= maxToolCalls)│  BUDGET
       │                    │                                       │  exit
       │   model.complete({ messages, tools: forceFinal?∅:schemas })│  STEP
       │                    │                                       │
       │        ┌───────────▼───────────┐                          │
       │        │ any tool_use blocks?  │                          │
       │        └───┬───────────────┬───┘                          │
       │         no │            yes│                              │
       │   finalText│               ▼  tools.callTool() ──► result │  EXECUTE
       │     break ◄┘     push assistant + tool_result into messages│
       │  (SUCCESS exit)            (accumulate, loop)              │
       └────────────────────────────────────────────────────────────┘
                    │
       parseResult? ─► recovery turn on parse failure (hardening)
                    │
                    ▼  { finalText, toolCalls, parsed }
```

## Elaborate

The loop skeleton is one instance of the load-bearing-skeleton lens — BFS (frontier + visited + termination), a rate limiter (counter + window + reset), and a retry policy are others. You've built BFS in `Graph.ts`; the move is identical here: isolate the kernel, name the part people forget (BFS's empty-frontier termination; the agent loop's hard budget), separate it from path-compression-style hardening. The agent loop's "visited set" equivalent is the turn counter — the thing that guarantees termination on an adversarial input.

## Interview defense

**Q: Walk me through the minimal agent loop.**

```
  step → execute → accumulate → terminate
  (model)  (tool)   (state)     (BOTH exits)
```

The model picks an action, the harness runs it, the result accumulates into state, and you check termination. Termination is two exits: the model signaling done, and a hard budget. The budget is the one people forget — nothing guarantees the model ever stops on its own.

*Anchor: name the hard budget unprompted — it's the signal you shipped a loop, not read about one.*

**Q: What does aptkit do when the budget runs out?**

It forces a final synthesis turn. On the last allowed turn it withholds the tools entirely (`tools: undefined`) and appends "You have NO more tool calls available — answer now." The model is structurally unable to loop further.

```
  budget hit → withhold tools + "answer now" → guaranteed final text
```

*Anchor: the forced synthesis turn is aptkit's most important loop mechanic — termination that produces an answer, not just a stop.*

## See also

- [01-chains-vs-agents.md](01-chains-vs-agents.md) — whether to have a loop at all.
- [03-react.md](03-react.md) — the step function aptkit plugs into this skeleton.
- [../04-agent-infrastructure/05-guardrails-and-control.md](../04-agent-infrastructure/05-guardrails-and-control.md) — the full control envelope around the loop.
- ReAct Thought-Action-Observation mechanics: `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`.
