# The ReAct Pattern
*ReAct · reason-act-observe loop (Industry standard)*

ReAct is Thought → Action → Observation, repeated until the model is satisfied. You already know this loop — it's BFS over a state graph. Each turn the model is standing on a node (the current message history), it expands one edge (calls a tool), and the observation it gets back is the new node it lands on. The frontier is the conversation. The goal test is "does the model still want a tool?" When it doesn't, you've found your answer. `runAgentLoop` is that BFS, and once you see it that way the code stops being mysterious.

The Thought is the model's reasoning text. The Action is a `tool_use` block. The Observation is the tool's result, fed back as a `user` message so the model sees it on the next turn. aptkit runs exactly this — and the part that makes it production-safe rather than a demo is one mechanic most people skip: the **forced synthesis turn**. Hold that thought.

## Zoom out, then zoom in

One turn of the loop is one BFS expansion. Here's the cycle.

```
ReAct = BFS expansion, one turn at a time
┌───────────────────────────────────────────────────────────────┐
│  current node = message history                                 │
│        │                                                        │
│        ▼                                                        │
│   model.complete()  ──►  THOUGHT (text) + ACTION (tool_use)     │
│        │                                                        │
│        │  no tool_use? ──► GOAL REACHED ──► return finalText ★  │
│        ▼                                                        │
│   callTool(action)  ──►  OBSERVATION (result)                   │
│        │                                                        │
│        ▼                                                        │
│   append observation as user message  ──► new node, loop ↑      │
└───────────────────────────────────────────────────────────────┘
```

The ★ — "no tool_use → goal reached" — is the goal test of your BFS. The model decides it by simply not asking for another tool. Everything else is bookkeeping: take the action, get the observation, grow the frontier (the message list), expand again. The bound is `maxTurns`: a BFS with a depth limit.

## Structure pass

Trace **state** through one turn and watch where the frontier grows.

State is the `messages` array. It starts as one node: `[{ role: 'user', content: userPrompt }]` (`run-agent-loop.ts:94`). Each turn appends. The model's reply (thought + actions) is pushed as an `assistant` message (`:124`). Then — and this is the seam — every tool's result is collected and pushed back as a *single* `user` message (`:189`). So the message list grows by exactly two entries per tool-using turn: one assistant (thought+action), one user (observations). That's the BFS frontier expanding by one layer.

The flip happens at `:131-135`: if the assistant message carried no `tool_use` blocks, the frontier stops growing and `finalText = text; break`. Goal reached. The model expanded zero edges, which is its way of saying "I'm at the answer."

## How it works

### Move 1 — the mental model

Thought-Action-Observation maps one-to-one onto three lines of the loop body: `complete` (thought+action), `callTool` (act), and the `messages.push` of the result (observation).

```
The kernel: three lines = T / A / O
  response = await model.complete(...)        // THOUGHT + ACTION
  result   = await tools.callTool(name, in)   // ACT (touch the world)
  messages.push({ role:'user', content: result })  // OBSERVATION (back to model)
```

### Move 2 — the moving parts. Load-bearing skeleton: name what breaks if removed.

**Thought + Action — the model's turn.** Remove it (stop reading `response.content`) and there's no decision; the loop is blind. The thought is the text blocks, the action is the `tool_use` blocks. aptkit splits them apart.

```
response.content = [ {type:'text', ...}, {type:'tool_use', ...} ]
                     └─ THOUGHT ─┘        └─ ACTION ─┘
```

```ts
// packages/runtime/src/run-agent-loop.ts:124-135
messages.push({ role: 'assistant', content: response.content });   // record the turn
const text = textFromContent(response.content);                    // THOUGHT
if (text) trace?.emit({ type: 'step', capabilityId, role: 'assistant', content: text, /*...*/ });
const toolUses = toolUsesFromContent(response.content);            // ACTION(s)
if (toolUses.length === 0) { finalText = text; break; }           // ◄── GOAL TEST
```

**Action → Observation — touch the world, feed it back.** Remove the feed-back (`:189`) and the model never sees the result; it'd re-issue the same action every turn. The observation closing the loop is what makes it *reasoning*, not repetition.

```ts
// packages/runtime/src/run-agent-loop.ts:159-189
const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal }); // ACT
// ...
toolResults.push({ type: 'tool_result', toolUseId: toolUse.id, content: resultContent }); // pack obs
// ... after all tool uses in this turn:
messages.push({ role: 'user', content: toolResults });  // ◄── OBSERVATION re-enters as next input
```

**The forced synthesis turn — the most load-bearing mechanic.** Remove it and a model that keeps wanting tools at the budget edge produces *nothing* — it asks for a tool on the last allowed turn, you can't grant it, and you return empty. The fix: on the final turn (or once the tool budget is spent), aptkit *disables tools* and *injects a synthesis instruction* so the model is forced to answer with what it has.

```ts
// packages/runtime/src/run-agent-loop.ts:101-109
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;            // ◄── the trigger
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,   // ◄── tools REMOVED on the forced turn
  maxTokens,
  signal,
});
```

`buildSynthesisInstruction` (`:72-74`) phrases it bluntly: `"You have NO more tool calls available. ... Do not say you need more queries."` Without this, ReAct degrades into a model perpetually asking for one more lookup it can't have.

### Move 3 — the principle

ReAct works because the observation re-enters the context — the model reasons over the *result* of its last action, not just its plan. But an unbounded ReAct loop is a liability. The bound (`maxTurns`) plus the forced synthesis (tools off + "answer now") turns an open-ended search into a guaranteed-terminating one that always produces output. Demos skip the forced turn; production can't.

## Primary diagram

```
runAgentLoop as ReAct — full trace of the rag-query agent
┌──────────────────────────────────────────────────────────────────────────┐
│ turn 0  THOUGHT "I should search the KB"                                   │
│         ACTION  tool_use search_knowledge_base{query:"..."}                │
│         OBSERVE result chunks ──► pushed as user message                   │
│           ▼                                                                │
│ turn 1  THOUGHT "chunks thin, refine"                                      │
│         ACTION  tool_use search_knowledge_base{query:"...v2"}              │
│         OBSERVE better chunks ──► pushed as user message                   │
│           ▼                                                                │
│ ...                                                                        │
│ turn N  forceFinal = (turn==maxTurns-1) OR (toolCalls>=maxToolCalls)       │
│         tools DISABLED + synthesisInstruction injected                     │
│         THOUGHT only, no ACTION ──► finalText, break  ★ guaranteed answer  │
└──────────────────────────────────────────────────────────────────────────┘
   maxTurns: 6   maxToolCalls: 4   (rag-query agent)
```

## Elaborate

aptkit's ReAct has no scratchpad-style explicit "Thought:" prefix the way the original paper formats it — the thought is just the text blocks in the assistant message, and the action is structured `tool_use`, not parsed-from-text (except on Gemma, where it's reconstructed — see `02-tool-calling.md`). The trace sink (`trace?.emit({ type: 'step', ... })` at `:128`) is where the reasoning becomes observable; without a sink wired, the thoughts happen but aren't recorded. Honest gap: there's no detection of the model repeating the *same* action across turns — only the `maxToolCalls` budget stops a stuck loop (see `06-error-recovery.md`).

## Project exercises

### Log the full Thought/Action/Observation trace to CapabilityEvents

- **Exercise ID:** `EX-REACT-03a`
- **What to build:** Wire a `CapabilityTraceSink` into one agent's `runAgentLoop` call and capture a complete T/A/O trace for a real query — thought text, each tool name + args, each observation — as structured `CapabilityEvents`, then render the trace. This is the observability rep inside Phase 4.
- **Why it earns its place:** ReAct is invisible until you log it. Seeing your own agent's turns is how you debug a loop that "answers wrong" — you watch which observation it ignored. The sink hooks already exist (`run-agent-loop.ts:128,147,171`); this exercise is about consuming them end to end.
- **Files to touch:** `packages/agents/rag-query/src/rag-query-agent.ts` (pass `trace`), `packages/runtime/src/events.ts` (the sink contract).
- **Done when:** Running one question prints an ordered T → A → O transcript per turn, including the forced-synthesis final turn, with no tool_use on the last entry.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Walk me through one turn of your agent's ReAct loop.**

```
complete → (thought + tool_use) → callTool → result → push as user msg → repeat
```

A: `model.complete` returns text (thought) and `tool_use` blocks (actions). I dispatch each via `callTool`, pack results as `tool_result`, and push them as a single user message — that's the observation re-entering context. Next turn the model reasons over it. The loop breaks when the model emits no tool_use, which is its goal test. Anchor: `run-agent-loop.ts:131` — no tool uses means done.

**Q: What stops the loop from never answering?**

```
forceFinal: turn==maxTurns-1 OR budgetSpent → tools OFF + "answer now"
```

A: The forced synthesis turn. On the last allowed turn — or once `maxToolCalls` is spent — I strip the tools array and inject a synthesis instruction telling the model it has no calls left and must answer. That guarantees output even when the model would otherwise keep asking to search. It's the mechanic people forget. Anchor: `run-agent-loop.ts:101-109`.

## See also

- [02-tool-calling.md](02-tool-calling.md) — how the Action (`tool_use`) is produced, natively or emulated.
- [01-agents-vs-chains.md](01-agents-vs-chains.md) — the loop condition the model owns.
- [06-error-recovery.md](06-error-recovery.md) — forceFinal and the budget in the full failure table.
