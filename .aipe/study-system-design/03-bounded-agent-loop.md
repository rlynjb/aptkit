# 03 — Bounded agent loop (budget + forced synthesis)

> **Subtitle:** Bounded ReAct loop / Reason-act loop with a hard budget —
> *Industry standard (ReAct), repo-specific hardening.* The loop is the
> orchestrator, the model is the planner, the tools are the actuators. The
> bound + forced-synthesis turn are the repo's own discipline on top of ReAct.

## Zoom out — where this sits

Every agent runs through one function: `runAgentLoop`. It's the engine between
a capability and the model port — it asks the model what to do, runs the tools
the model asks for, feeds results back, and repeats. The thing that makes it
*safe* is that it can't run forever and can't end without producing an answer.

```
  Zoom out — the loop in the stack

  ┌─ Capability layer (agents) ───────────────────────────────┐
  │  recommendation (maxTurns 6) · rag-query · query · …       │  configures the loop
  └───────────────────────────┬────────────────────────────────┘
                              │ runAgentLoop({ model, tools, maxTurns, maxToolCalls, synthesisInstruction })
  ┌─ Runtime ─────────────────▼────────────────────────────────┐
  │  ★ runAgentLoop ★  packages/runtime/src/run-agent-loop.ts:76│ ← we are here
  │  for turn in 0..maxTurns: complete() → run tools → repeat   │
  └──────────┬────────────────────────────┬─────────────────────┘
             │ model.complete()            │ tools.callTool()
             ▼                             ▼
        ModelProvider (01)          ToolExecutor (search_knowledge_base, 02)
```

The loop is generic — it has no idea whether it's making recommendations or
answering a RAG query. Each agent injects its model, its allowlisted tools,
its budget, and its parser. The loop just turns the crank.

## Structure pass — layers, axis, seam

Layers nest: the **pipeline** (the agent's fixed config — same every run), the
**loop** (turn iteration), the **turn** (one model call + its tool calls).
Trace one axis — **who decides what happens next** — down the nesting:

```
  axis traced: "who decides the next step?"  (this is the hybrid that trips people up)

  ┌─ outer: the agent config ──────────┐   CODE decides — maxTurns, which tools, the budget
  └──────────────┬──────────────────────┘
       seam ═════╪═════  ← control flips: fixed config → free choice
  ┌─ inner: the per-turn loop ──────────┐   the MODEL decides — search again, or answer?
  └──────────────┬──────────────────────┘
       seam ═════╪═════  ← control flips back: free choice → forced
  ┌─ innermost: the LAST turn ──────────┐   CODE decides — tools removed, synthesis forced
  └─────────────────────────────────────┘
```

The verdict, stated first: **it's a hybrid — pipeline outside, free loop in the
middle, forced synthesis at the floor.** The outer layer fixes the budget, the
inner layer hands control to the model, and the innermost turn yanks it back to
guarantee an answer. The two seams (where control flips) are the whole design.

## How it works

### Move 1 — the mental model

You know a `while` loop with a guard condition. This is that, where the "should
I keep going" question is answered partly by the model (does it want another
tool call?) and partly by a hard turn counter the model can't override.

```
  the pattern — bounded loop with a forced final turn

  turn 0 ─► complete(tools=[...]) ─┬─ tool_use? ─► run tools ─► feed results ─► turn 1
                                   └─ text only ─► DONE (model chose to stop)
  ...
  turn N-1 (or budget spent) ─► complete(tools=UNDEFINED, system+="no more calls")
                                   └─► text ─► DONE (forced synthesis — must answer)
```

The model can stop early by just answering. If it doesn't, the counter stops
it — and the last turn removes the tools so it *has* to synthesize.

### Move 2 — the loop, one moving part at a time

**The turn counter — the outer bound** (`run-agent-loop.ts:98`):

```ts
for (let turn = 0; turn < maxTurns; turn += 1) {   // maxTurns default 8; recommendation sets 6
  signal?.throwIfAborted();                          // cancellation checked every turn
```

A plain bounded `for`. `maxTurns` defaults to 8 (`run-agent-loop.ts:87`); the
recommendation agent overrides to 6. This is the part that guarantees
termination — without it, a model that keeps requesting tools loops forever.

**The forced-synthesis switch — the most load-bearing line** (lines 101-109):

```ts
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;   // last turn OR budget exhausted
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  tools: forceFinal ? undefined : toolSchemas,             // ← tools REMOVED on the final turn
  messages, maxTokens, signal,
});
```

When it's the last turn *or* the tool-call budget is spent, two things change:
the tools are removed (the model literally cannot call one) and a synthesis
instruction is appended (`buildSynthesisInstruction`, line 72: *"You have NO
more tool calls available… Do not say you need more queries."*). This is what
stops the classic failure where an agent burns its budget and then says "I need
to run one more query" instead of answering. The recommendation agent's
instruction: *"Stop querying now and output your final answer."*

**The tool-execution inner loop** (lines 139-187): for each `tool_use` block
the model emitted, call the tool, catch errors into an error tool-result, emit
trace events, push the result back into `messages`. Errors don't crash the run —
they become a tool-result the model can react to (lines 163-168).

```
  layers-and-hops — one turn crossing model → tools → back

  ┌─ loop ──────────┐ hop1: messages + tools  ┌─ ModelProvider ──┐
  │  turn iteration │ ──────────────────────► │ complete()       │
  │                 │ hop2: content blocks  ◄─│                  │
  └────────┬─────────┘  (text + tool_use[])   └──────────────────┘
           │ hop3: for each tool_use → callTool()
           ▼
  ┌─ ToolExecutor ──────────────────────────────────────────────┐
  │  run tool, catch error → tool_result (isError?)              │
  │  hop4: tool_result[] pushed back into messages ──────────────┘
  └──────► next turn
```

**The exit** (lines 131-135): if the model returns no `tool_use` blocks, it
chose to answer — capture `finalText`, break. **The recovery turn** (lines
192-228): if a `parseResult` is configured and the final text didn't parse, one
more constrained call demands *only* the structured answer.

#### Move 2 variant — the load-bearing skeleton

The irreducible loop kernel: **bounded counter + model call + tool dispatch +
forced-final exit**. What breaks if each part goes:

- **the turn bound** — gone, and a model that always requests a tool loops
  forever. This is non-negotiable; it's the termination guarantee.
- **the forced-final turn (tools removed + synthesis prompt)** — gone, and the
  agent spends its whole budget then refuses to answer ("I need more data").
  This is the part people forget and the single most important mechanic here.
- **the model call + tool dispatch** — gone, and there's no agent at all.
- **the error-to-tool-result conversion** — gone, and one throwing tool kills
  the entire run instead of letting the model route around it.

Hardening on top: the recovery turn, the `maxToolCalls` budget (separate from
turns), the 16KB tool-result truncation (line 52), the AbortSignal threading.

### Move 3 — the principle

An agent loop without a hard bound is a liability, not a feature. The discipline
is: give the model freedom in the middle (decide what to do next), but cage it
on both ends — a turn counter it can't exceed, and a final turn where the tools
disappear and an answer is mandatory.

## Primary diagram

```
  the bounded agent loop — full recap

  agent config ─► runAgentLoop ─┐
                                │  for turn 0..maxTurns (CODE-bounded)
        ┌───────────────────────▼─────────────────────────────────┐
        │ forceFinal = last turn OR maxToolCalls spent?            │
        │   no  → complete(tools=[...])  ── model free to call     │
        │   yes → complete(tools=undefined, +synthesisInstruction) │ ← forced answer
        └───────────┬───────────────────────────┬──────────────────┘
            tool_use?│                    text only / forceFinal│
                     ▼                                          ▼
            run tools (serial) ── errors → tool_result    finalText ─► parseResult
            feed results back ──► next turn                        │ null? → recovery turn
                                                                   ▼
                                                          { finalText, toolCalls, parsed }
       every step → CapabilityEvent emitted to trace sink (see 04)
```

## Elaborate

This is ReAct (reason + act) with the budget and forced-synthesis turn as the
repo's hardening. Vanilla ReAct doesn't mandate termination or a final answer —
those are exactly the production failures (runaway loops, budget-then-refuse)
this loop fixes. The loop is also where the trace is emitted (`04`) and where
the model port (`01`) and tool boundary (`02`) meet. The execution-model
details (the event loop, AbortSignal mechanics, async iteration) belong to
`study-runtime-systems`; the reasoning-pattern lineage belongs to
`study-agent-architecture`.

## Interview defense

**Q: Is this a pipeline or an agent loop?**
It's the hybrid — pipeline outside, free loop inside, forced synthesis at the
floor. Code fixes the budget and the toolset; the model freely decides whether
to call a tool or answer within that budget; and the final turn removes the
tools so an answer is guaranteed.

```
  CODE bounds (maxTurns) → MODEL decides (per turn) → CODE forces (final turn)
```
*Anchor:* "Pipeline outside, loop inside, forced synthesis at the end."

**Q: What's the mechanic people forget?**
The forced-synthesis turn — removing the tools and appending "no more calls" on
the last iteration. Without it the agent burns its budget and then says it needs
another query instead of answering. The turn counter guarantees termination;
the forced turn guarantees an *answer*.

```
  last turn: tools = undefined  +  "You have NO more tool calls. Answer now."
```
*Anchor:* "The forced-synthesis turn is the most load-bearing line in the loop."

## See also

- `00-overview.md` — the loop on the full map
- `01-provider-abstraction.md` — the `complete()` the loop calls
- `02-retrieval-as-a-tool.md` — the tool the loop dispatches
- `04-capability-event-trace.md` — what the loop emits at every step
- `study-runtime-systems` — async iteration, AbortSignal cancellation
- `study-agent-architecture` — the ReAct lineage
