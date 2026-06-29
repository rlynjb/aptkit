# The ReAct pattern

**Subtitle:** Reason + Act (thought / action / observation) · the loop's iteration shape · *Industry standard (aptkit's loop IS this)*

## Zoom out, then zoom in

ReAct is the pattern where a model alternates *reasoning* (think about what to do)
and *acting* (call a tool), reading each tool's result as an *observation* before
the next thought. It's not a library aptkit imports — it's the literal shape of one
turn in `runAgentLoop`. Every iteration is one Thought → Action → Observation step,
and the trace events make that trajectory something you can *see* in Studio.

```
  Zoom out — ReAct is the loop's iteration shape

  ┌─ runAgentLoop (run-agent-loop.ts) ─────────────────────────────┐
  │  for turn in 0..maxTurns:                                       │
  │    ★ THOUGHT  — model text (emitted as a 'step' event) ★        │ ← we are here
  │    ★ ACTION   — tool_use block → callTool ★                     │
  │    ★ OBSERVE  — tool_result appended as the next message ★      │
  │  (forced-synthesis turn ends the loop with a final answer)      │
  └─────────────────────────────────────────────────────────────────┘
```

Now zoom in. The original ReAct paper interleaved free-text reasoning traces with
actions. aptkit gets the same structure for free from native-style tool calling:
the model's text *is* the thought, the `tool_use` block *is* the action, the
`tool_result` message *is* the observation the model reads next turn. You don't
prompt "Thought:/Action:/Observation:" — the loop's three moves already are ReAct.

## Structure pass

**Layers.** Loop (drives turns) → model (produces thought + action) → tool
(produces observation) → trace sink (records each move as an event).

**Axis — state of the conversation across turns.** What carries from one turn to
the next? Trace it: the `messages` array is the state. A thought + action gets
pushed as an `assistant` message (`run-agent-loop.ts:124`); the observation gets
pushed as a `user` message holding `tool_result` blocks (`run-agent-loop.ts:189`).
Next turn, `model.complete` sees the whole array — so the observation *becomes
input* to the next thought. The axis "how does an observation reach the next
reasoning step?" flips at the `messages.push` of the tool result.

**Seam.** `messages.push({ role: 'user', content: toolResults })`
(`run-agent-loop.ts:189`). Before it, the observation is just a returned value;
after it, it's part of the conversation the model reasons over. That push is what
closes ReAct's act → observe → think loop.

## How it works

### Move 1 — the mental model

You know a REPL: read input, evaluate it, print the result, loop — and the printed
result informs what you type next. ReAct is a REPL where the *model* is the user. It
"types" a thought and a tool call (read), the loop runs the tool (eval), the result
goes back into the transcript (print), and the model reads it to decide the next
line (loop). The conversation transcript is the REPL's accumulating session state.

```
  ReAct ≈ a REPL with the model as the user

  model types:  thought + tool call      ← read
       │
  loop runs:    callTool(...)             ← eval
       │
  result back:  appended to transcript    ← print
       │
  model reads transcript → next thought   ← loop
```

### Move 2 — one turn, three moves

**Move A — Thought (model text → a `step` event).** The model's natural-language
output is the reasoning trace. The loop extracts it and emits it as a `step` trace
event so the thought is observable (`run-agent-loop.ts:126`):

```ts
const text = textFromContent(response.content);
if (text) {
  trace?.emit({ type: 'step', capabilityId, role: 'assistant', content: text, timestamp: timestamp() });
}
```

That `step` event is the Thought made visible. In Studio it's the line that shows
*why* the model is about to call the tool it calls.

```
  Thought — model text becomes a visible step

  model.complete ─► response.content ─► textFromContent
                                            │ text?
                                            ▼
                                   emit {type:'step', content: <reasoning>}
```

**Move B — Action (tool_use block → callTool).** The model's `tool_use` blocks are
the actions. The loop pulls them out and runs each one, bracketing it with
`tool_call_start`/`tool_call_end` events (`run-agent-loop.ts:131`):

```ts
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) { finalText = text; break; }   // no action → the thought IS the answer
for (const toolUse of toolUses) {
  trace?.emit({ type: 'tool_call_start', capabilityId, toolName: toolUse.name, args: toolUse.input, ... });
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  trace?.emit({ type: 'tool_call_end', capabilityId, toolName: toolUse.name, result, durationMs, ... });
}
```

Note the branch: *no* `tool_use` block means the model chose not to act — its
thought is the final answer, and the loop breaks. Action is optional; reasoning
isn't.

```
  Action — tool_use block drives a tool call

  toolUsesFromContent(content)
       │ none                          │ ≥1
       ▼                               ▼
  finalText = text; break        tool_call_start ─► callTool ─► tool_call_end
  (thought was the answer)            (the Action, traced both ends)
```

**Move C — Observation (tool_result → next message).** The tool's output becomes a
`tool_result` block appended to `messages`, so the *next* `model.complete` reads it
(`run-agent-loop.ts:181`):

```ts
toolResults.push({
  type: 'tool_result',
  toolUseId: toolUse.id,
  content: resultContent,                    // truncated JSON of the result (or the error)
  ...(isError ? { isError: true } : {}),
});
// ...after the loop over tool uses:
messages.push({ role: 'user', content: toolResults });   // ← the observation enters the transcript
```

This single push is the heart of ReAct: it turns a returned value into something the
model reasons over next turn. An *error* observation works the same way (it carries
`isError: true`), so a failed action becomes feedback the model reads — that's
recovery riding on the observation step (see `06-error-recovery.md`).

```
  Observation — result re-enters the conversation

  callTool result (or error) ─► tool_result block ─► messages.push (role:user)
                                                          │
                                                          ▼
                                       next turn: model.complete sees it ─► next Thought
```

**The trajectory you can see.** Because every move emits an event, the whole ReAct
trajectory is a stream. The `CapabilityEvent` union — `step`, `tool_call_start`,
`tool_call_end`, `model_usage` (`events.ts:1`) — is streamed as NDJSON and rendered
in Studio, so you watch thought → action → observation unfold per turn:

```
  The trace IS the ReAct trajectory (Studio view)

  step           ── "I should search the knowledge base for ORM setup"   (Thought)
  tool_call_start── search_knowledge_base {query:"ORM setup"}            (Action)
  tool_call_end  ── 4 chunks, 120ms                                      (Observation)
  step           ── "The docs say to run migrate; let me answer"         (Thought)
  (no tool_use)  ── final text                                          (Stop)
```

### Move 3 — the principle

ReAct is just "let the model see the consequence of its action before its next
action" — and the cheapest way to implement it is to append the result as a message.
aptkit doesn't reinvent the pattern; it *falls out* of native-style tool calling
plus a message array. The engineering value is making each move a trace event so the
trajectory is debuggable: when an agent gives a wrong answer, you replay the
thought/action/observation sequence and see exactly which observation it
misread or which action it skipped. The forced-synthesis turn (tools dropped on the
last iteration) is what ends the ReAct loop with an answer instead of another action.

## Primary diagram

```
  ReAct in runAgentLoop — one turn, three traced moves

  ┌─ turn ─────────────────────────────────────────────────────────────────┐
  │  model.complete(messages, tools)                                         │
  │        │                                                                 │
  │        ├─ THOUGHT:  text  ──────────────► emit 'step'                    │
  │        │                                                                 │
  │        ├─ ACTION:   tool_use? ─none─► finalText=text; break (stop)       │
  │        │                  │ ≥1                                           │
  │        │                  ▼                                              │
  │        │            'tool_call_start' ─► callTool ─► 'tool_call_end'     │
  │        │                                                                 │
  │        └─ OBSERVE:  tool_result ─► messages.push(role:user) ─────────────┼─┐
  └─────────────────────────────────────────────────────────────────────────┘ │
        ▲  next turn reads the observation as input ──────────────────────────┘
        bounded by maxTurns; final turn drops tools → forced synthesis ends it
```

## Elaborate

ReAct (Yao et al., 2022) showed that interleaving reasoning and acting beats either
alone — reasoning keeps the actions on track, actions ground the reasoning in real
observations. The classic implementation parses `Thought:/Action:/Observation:`
out of free text; the modern implementation (aptkit's) gets the same loop from
structured tool calls, which is more robust because the action is a typed block, not
a parsed string. The thing most people miss: the *observation* step is where
recovery and grounding both happen — the model only stays honest because it reads
the real tool output next turn. Read `01-agents-vs-chains.md` for why this loop is an
agent and not a chain, `02-tool-calling.md` for how the Action block is produced
(emulated on Gemma), and `06-error-recovery.md` for the error-as-observation path.

## Project exercises

### Render the ReAct trajectory as a turn-numbered timeline in Studio
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** group the NDJSON `CapabilityEvent` stream by turn and render
  each turn as a Thought/Action/Observation triple, so a run reads as a clear ReAct
  trace instead of a flat event list.
- **Why it earns its place:** the single most useful agent-debugging view is "what
  did it think, do, and see, per turn"; building it proves you understand the loop's
  iteration shape, not just its output.
- **Files to touch:** the Studio trace UI under `packages/studio/` (or wherever the
  NDJSON viewer lives), reading `packages/runtime/src/events.ts`.
- **Done when:** a rag-query run shows numbered turns, each with its thought, the
  tool it called, and the observation it got back.
- **Estimated effort:** `1–4hr`

### Add a `turn` index to every CapabilityEvent
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** thread the loop's `turn` counter into each emitted event so
  consumers don't have to infer turn boundaries from event ordering.
- **Why it earns its place:** making the turn explicit is the difference between a
  best-effort grouping and a reliable one; it's the small schema change that makes
  the trajectory view above trustworthy.
- **Files to touch:** `packages/runtime/src/events.ts`,
  `packages/runtime/src/run-agent-loop.ts`, `packages/runtime/test/`.
- **Done when:** every event from a multi-turn run carries the correct `turn` index
  and a test asserts thought/action/observation in one turn share it.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Is your agent a ReAct agent? Where's the thought/action/observation?"**
Yes — the loop's iteration *is* ReAct. The model's text is the Thought, emitted as a
`step` trace event. Its `tool_use` block is the Action; the loop runs it via
`callTool`, bracketed by `tool_call_start`/`tool_call_end`. The Observation is the
`tool_result` pushed back onto the `messages` array, which the next `model.complete`
reads. I don't prompt the Thought/Action/Observation strings — native-style tool
calling plus a message array gives the structure for free, and the trace makes the
trajectory visible.

```
  text → 'step' (Thought) · tool_use → callTool (Action) · tool_result → messages.push (Observation)
```
Anchor: *ReAct isn't a library — it's one turn of the loop, made observable by trace events.*

**Q: "Where exactly does the observation feed back into reasoning?"**
At `messages.push({ role: 'user', content: toolResults })`. Before that push the
tool's result is just a returned value; after it, it's part of the conversation, so
the next turn's `model.complete` sees it and reasons over it. That one line closes
the act → observe → think loop. It's also where a tool *error* re-enters — the
error is appended as a `tool_result` with `isError: true`, so a failed action becomes
feedback the model can recover from.

```
  result/error → tool_result block → messages.push → next turn reads it → next Thought
```
Anchor: *the observation becomes the next reasoning step at the tool_result push — that's the loop closing.*

## See also

- `01-agents-vs-chains.md` — why this loop is an agent
- `02-tool-calling.md` — how the Action (tool_use block) is produced
- `06-error-recovery.md` — the error-as-observation recovery path
- `04-tool-routing.md` — which actions the model is allowed to take
- `05-evals-and-observability/` — reading the trajectory to debug a bad answer
