# The Agent Loop Skeleton

**Project-specific (the kernel) · industry standard (the pattern).** "The agent loop," "the tool-use loop," "the ReAct kernel." Type label: load-bearing skeleton.

## Zoom out, then zoom in

Six agents in aptkit. They look different on the surface — one answers questions over a knowledge base, one proposes recommendations, one scores against a rubric. Underneath, they are **the same loop with a different step function**. That loop is `runAgentLoop`, and it lives in exactly one place.

```
  Zoom out — runAgentLoop is the shared substrate

  ┌─ Agent layer (6 capabilities) ──────────────────────────┐
  │  rag-query · recommendation · anomaly-monitoring ·       │
  │  diagnostic-investigation · query · rubric-improvement   │
  └───────────────────────────┬──────────────────────────────┘
                              │ every one calls
  ┌─ Runtime layer ───────────▼──────────────────────────────┐
  │  ★ runAgentLoop ★   packages/runtime/src/run-agent-loop.ts│ ← we are here
  │  the only agent loop in the repo                          │
  └───────────────────────────┬──────────────────────────────┘
                              │ depends only on
  ┌─ Contract layer ──────────▼──────────────────────────────┐
  │  ModelProvider.complete() · ToolExecutor.callTool()       │
  └────────────────────────────────────────────────────────────┘
```

Isolate the kernel once, here, and the other reasoning-pattern files can refer back to it instead of re-deriving it. Chains-vs-agents answered *is there a loop*; this file answers *what's in the loop, and which parts are load-bearing*.

## Structure pass

**Layers:** caller config → loop body → tool execution. **Axis: what bounds the run?** Trace termination across the loop and the surprise is that there are *two* exits, not one.

```
  "what stops the run?" — traced through runAgentLoop

  ┌──────────────────────────────────────────────┐
  │ success exit: model emits no tool_use block   │  → LLM decides it's done
  │ run-agent-loop.ts:132                         │
  └──────────────────────────────────────────────┘
  ┌──────────────────────────────────────────────┐
  │ budget exit: turn === maxTurns-1 OR            │  → CODE forces a stop
  │ toolCalls.length >= maxToolCalls               │
  │ run-agent-loop.ts:101-102                     │
  └──────────────────────────────────────────────┘
```

**The seam that matters** is the budget exit — it's where control is *taken back* from the model. The model can cycle tool calls indefinitely; nothing in its incentive structure says "stop now." The cap is the code reasserting control. People forget this exit exists, and an agent shipped without it burns tokens in a silent loop.

## How it works (load-bearing skeleton)

### Move 1 — the mental model

You know how BFS is just `queue + visited set + dequeue/expand/enqueue + terminate-when-empty`? Strip any one part and it breaks in a named way (no visited set → infinite revisit on a cycle). The agent loop has the same property: four parts, each named by what breaks without it.

```
  The kernel — this IS the whole pattern

  runLoop(state, tools):
    while not done:
      action = step(state)           # ← the single LLM call (the "smart" part)
      if action.is_final:            # ← success exit
        return action.output
      result = execute(action, tools)# ← harness runs the tool, not the model
      state  = accumulate(state, result)   # ← what makes it a loop, not N calls
      if budget_exceeded(state):     # ← budget exit (the one people forget)
        return forced_synthesis(state)
```

### Move 2 — the four load-bearing parts, in aptkit's code

**Part 1 — state (accumulate). Without it: every turn is amnesiac; you have N independent calls, not a loop.** State is the `messages` array. Each turn pushes the assistant's response and the tool results back onto it, so the next `model.complete` sees the whole history.

```typescript
// packages/runtime/src/run-agent-loop.ts:94, 124, 189
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
// ...each turn:
messages.push({ role: 'assistant', content: response.content }); // line 124
// ...after running tools:
messages.push({ role: 'user', content: toolResults });            // line 189
```

Drop the pushes and the model re-asks the same question every turn — it never sees what its last tool call returned. The accumulation IS the loop.

**Part 2 — step (the single LLM call). Without it: nothing chooses the next action.** This is the only "smart" part; everything else is plumbing.

```typescript
// packages/runtime/src/run-agent-loop.ts:103
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,  // ← tools withheld on the final turn
  maxTokens,
});
```

One call per turn. It returns content blocks; some are text, some are `tool_use`. The loop reads those blocks to decide what happens next — it never parses free text for intent.

**Part 3 — execute (run the tool, feed the result back). The model emits *intent*; the harness runs it.** The model never touches the tool directly — that boundary IS the control and safety story.

```typescript
// packages/runtime/src/run-agent-loop.ts:159-187
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
// ... on throw, the error becomes a tool_result with isError, not a crash:
resultContent = truncate(JSON.stringify({ error: message }));   // line 167
toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: resultContent,
                   ...(isError ? { isError: true } : {}) });    // line 181
```

Note the failure handling: a thrown tool error is *caught and turned into an observation*, not propagated. The model sees `{ error: ... }` and can route around it — this is the hook that per-tool circuit breaking (SECTION E) would plug into. Also note `truncate` (line 54): tool results are capped at 16k chars so one fat result can't blow the context window.

**Part 4 — termination (TWO exits, both required). This is the part people forget.**

```typescript
// SUCCESS exit — model returns no tool_use blocks, so it's answering:
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) { finalText = text; break; }   // line 132

// BUDGET exit — forced before the call, by capping the loop:
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;  // line 101-102
```

```
  Two exits — the success one is obvious, the budget one is load-bearing

  turn N:
    forceFinal?  ──yes──►  strip tools, append synthesis instruction
       │                   model MUST answer (budget exit)
       no
       ▼
    model.complete(with tools)
       │
    tool_use blocks?  ──no──►  finalText = text (success exit)
       │ yes
       ▼
    run tools, accumulate, next turn
```

**The most load-bearing mechanic in aptkit: the forced synthesis turn.** When `forceFinal` is true, the loop does two things (line 104, 108): it appends `synthesisInstruction` to the system prompt and it passes `tools: undefined`. Stripping the tools means the model *physically cannot* emit a tool call — its only move is to answer. The instruction (`buildSynthesisInstruction`, line 72) reinforces it: *"You have NO more tool calls available... Do not say you need more queries."* Without this, a weak model on its last turn will keep asking to search and produce nothing. This converts "ran out of budget" from a failure into a final answer.

### Move 2.5 — skeleton vs hardening

Everything past the four parts is optional hardening aptkit layers on:
- **Parse-and-recover** (`run-agent-loop.ts:192-201`): if `parseResult` returns null, run one `runRecoveryTurn` (line 204) that re-prompts for *just* the structured output using the evidence already gathered. This is how recommendation/rubric agents salvage a run where the model produced prose instead of JSON.
- **Trace emission** (`trace?.emit` throughout): `step`, `tool_call_start/end`, `model_usage` events for observability and replay. Not skeleton — the loop runs without a trace sink.
- **Result truncation** (line 54): a hardening cap on context bloat.

The kernel is the four parts. The recovery turn, the trace, the truncation are hardening. Saying which is which is the lesson.

### Move 3 — the principle

An agent is `step + execute + accumulate + terminate`, and termination needs BOTH a success condition and a hard budget. aptkit's defaults (`maxTurns = 8`, `run-agent-loop.ts:87`) bake the budget into the skeleton; the agents tighten it (rag-query: 6/4; rubric: 6/3). Naming the budget exit unprompted is the signal you've shipped an agent loop, not just read about one.

## Primary diagram

```
  runAgentLoop — the full kernel, one frame
  packages/runtime/src/run-agent-loop.ts:76

  ┌─ config (from the agent) ─────────────────────────────┐
  │  system · userPrompt · toolSchemas · maxTurns ·        │
  │  maxToolCalls · synthesisInstruction · parseResult     │
  └───────────────────────────┬────────────────────────────┘
                              ▼
  ┌─ loop body (per turn) ─────────────────────────────────┐
  │  forceFinal = lastTurn OR budgetSpent          (:101)  │
  │  response = model.complete(tools unless forceFinal)(:103)│ ← STEP
  │  messages.push(assistant)                       (:124) │ ← ACCUMULATE
  │  no tool_use? → finalText; break               (:132)  │ ← SUCCESS EXIT
  │  for tool_use: callTool → tool_result          (:159)  │ ← EXECUTE
  │  messages.push(tool results)                    (:189) │ ← ACCUMULATE
  └───────────────────────────┬────────────────────────────┘
                              │ loop ends at maxTurns      ← BUDGET EXIT
                              ▼
  ┌─ post-loop ────────────────────────────────────────────┐
  │  parseResult(finalText); null? → runRecoveryTurn (:192) │ ← hardening
  └─────────────────────────────────────────────────────────┘
```

## Elaborate

This kernel is the ReAct loop with the Thought-Action-Observation steps collapsed into provider content blocks (text = thought, tool_use = action, tool_result = observation). It's also the substrate SECTION C builds on: multi-agent is N of this skeleton composed. When the agents are genuinely independent it's "N loops merged" (fan-out); the moment one needs another's output you're traversing a dependency DAG with a supervisor and a merge strategy — not running N copies. aptkit runs N *separate* copies today (the six capabilities don't compose), so it's the simplest case.

## Interview defense

**Q: Walk me through your agent loop.**
Four parts. Step is one `model.complete` per turn. Execute runs the tool through the harness — the model emits intent, my code runs it, errors become observations not crashes. Accumulate pushes assistant + tool results onto the messages array; that's what makes it a loop. Terminate has two exits: success when the model stops emitting tool calls, and a budget exit at `maxTurns`/`maxToolCalls`.

```
  step → execute → accumulate → {success exit | budget exit}
```
*Anchor: termination needs BOTH exits. The budget one is the one people forget.*

**Q: What happens when the budget runs out mid-investigation?**
The forced synthesis turn. On the last turn I strip the tool schemas — so the model literally can't ask for another search — and append an instruction telling it to answer with what it has. That turns "out of budget" into a final answer instead of a hang. It's the single most load-bearing mechanic in the loop.

```
  forceFinal → tools: undefined + "no more queries" → model MUST answer
```
*Anchor: withholding the tools is the enforcement; the instruction is the nudge.*

**Q: How do you keep one big tool result from blowing the context window?**
`truncate` at 16k chars per result. It's hardening, not skeleton — but without it a single fat query result poisons every downstream turn.

## See also

- `01-chains-vs-agents.md` — the boundary this loop sits behind
- `03-react.md` — the loop's step function, prompted ReAct-style
- `05-guardrails-and-control.md` (SECTION D) — the budget exit as part of the control envelope
- `02-agentic-retrieval/01-agentic-rag.md` — this loop with retrieval as the tool
- `study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` — the T-A-O mechanics (cross-ref)
