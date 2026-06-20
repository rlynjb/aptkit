# Bounded agent loop — the terminating ReAct kernel

**Industry names:** ReAct loop / tool-use loop / agentic loop with a budget. **Type:** Industry standard (the budget discipline is project-specific hardening).

## Zoom out, then zoom in

This is the engine room. Every one of the six agents — including the new `rag-query` capstone — is a thin wrapper around this one function. Find it in the runtime band — everything above it is configuration, everything below it is the provider seam.

```
  Zoom out — where the loop lives

  ┌─ Capability layer — packages/agents/* ──────────────────┐
  │  agent.scan() / .propose() / .investigate() / .answer()  │
  │      each builds a config and calls ↓                    │
  └───────────────────────────┬──────────────────────────────┘
                              │  runAgentLoop({ model, tools, maxTurns, ... })
  ┌─ Runtime core ────────────▼──────────────────────────────┐
  │  ★ runAgentLoop ★  ← the bounded ReAct kernel             │ ← we are here
  │      emits CapabilityEvent[] as it runs                   │
  └───────────────────────────┬──────────────────────────────┘
                              │  model.complete() per turn
  ┌─ Provider layer ──────────▼──────────────────────────────┐
  │  whichever ModelProvider was passed in                   │
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. You know the shape already if you've ever written a polling loop with a retry cap: `while not done and attempts < max: try again`. The agent loop is that, where "try again" means "ask the model what to do next, run the tools it asked for, feed the results back." The pattern is **ReAct — Reason + Act in a cycle** — and the thing that makes *this* implementation worth studying is that it's **bounded**: it cannot run forever, and on its last legal turn it forces the model to stop reasoning and produce an answer.

## Structure pass

**Layers:** the loop has two nested control levels — the *outer* loop (code decides how many turns are allowed) and the *inner* turn (the LLM decides what to do this turn). Hold one axis across them.

**Axis — who decides control flow?**

```
  "who decides what happens next?" — traced down the loop

  ┌─ outer: the for-loop ─────────────┐   → CODE decides
  │  turn < maxTurns, budget check    │     (the hard ceiling)
  └─────────────────┬──────────────────┘
        ┌───────────▼─────────────────┐ → LLM decides
        │ inner: model.complete()     │   (emit tool calls,
        │  returns tool_use or text   │    or stop)
        └───────────┬─────────────────┘
              ┌──────▼──────────────┐  → TOOL runs
              │ registry.callTool() │    (deterministic)
              └─────────────────────┘
```

The answer flips at each level — that contrast is the lesson. Code owns the *budget*; the LLM owns the *choice within the budget*; the tool just executes. The seam where it matters most is the boundary between outer and inner: code lets the LLM steer, but only for a bounded number of turns, and on the final turn code yanks the steering wheel back by removing the tools. Hand off to How it works.

## How it works

#### Move 1 — the mental model

The shape is a loop with a frontier of pending work, a budget, and a forced exit. You've built this: BFS dequeues a node, expands it, enqueues neighbors, and *terminates when the frontier is empty or a limit is hit*. The agent loop is structurally identical — each turn it "expands" by calling the model, the model's tool requests are the new frontier, and it terminates when the model stops requesting tools OR the turn budget runs out.

```
  The bounded ReAct kernel

   turn = 0
   ┌──────────────────────────────────────────────┐
   │  while turn < maxTurns:                        │
   │     forceFinal = (last turn) OR (tool budget   │
   │                   spent)                        │
   │     resp = model.complete(                      │
   │              tools = forceFinal ? none : tools) │ ← tools stripped
   │     if resp has no tool calls:  break  ◄────────┼── normal exit
   │     run each tool, append results               │
   │     turn += 1                                    │
   └──────────────────────────────────────────────┘
   parse finalText → maybe one recovery turn
```

The two exits are the whole story: **normal exit** (model stopped calling tools, line "break") and **forced exit** (budget ran out, so `forceFinal` strips the tools and the model *must* answer). The forced exit is the load-bearing part most people forget.

#### Move 2 — the step-by-step walkthrough

**Seed the conversation.** Before the loop, one user message is pushed: the agent's prompt. The bridge: it's exactly like initializing a BFS frontier with the start node before the loop runs.

```
  initial state
  messages = [ { role: 'user', content: userPrompt } ]
  toolCalls = []
  finalText = ''
```

**Each turn: compute the budget verdict.** At the top of every iteration, two booleans get computed before anything is sent. `budgetSpent` = "have we already made `maxToolCalls` tool calls?" `forceFinal` = "is this the last allowed turn OR is the budget spent?" The bridge: this is the retry-cap check at the top of a polling loop, but it decides *capability*, not just continuation.

```
  Execution trace — a 3-turn run, maxTurns=8, maxToolCalls=2

  turn 0: budgetSpent=F  forceFinal=F  → send WITH tools  → model: call tool A
  turn 1: budgetSpent=F  forceFinal=F  → send WITH tools  → model: call tool B
  turn 2: budgetSpent=T  forceFinal=T  → send NO tools    → model: final answer
          (toolCalls.length == 2 == maxToolCalls → budget spent → force synthesis)
```

**Send the request — tools present or stripped.** If `forceFinal` is false, the model gets the tool schemas and can request more tool calls. If `forceFinal` is true, `tools` is passed as `undefined` and the system prompt gets a synthesis instruction appended — the model *cannot* call a tool, so it has to write an answer. The boundary condition: without stripping the tools on the final turn, a model that loves calling tools would hit `maxTurns`, return one last tool request, and the loop would exit with *no answer*. Stripping the tools is what guarantees a final synthesis.

```
  Layers-and-hops — one turn crossing into the provider

  ┌─ loop (runtime) ──┐ hop 1: complete({tools: forceFinal? none : tools})
  │ budget verdict    │ ─────────────────────────────────────────────────►┐
  └───────────────────┘                                                    │
  ┌─ loop (runtime) ──┐ hop 4: response.content (text + tool_use blocks)   ▼
  │ inspect content   │ ◄───────────────────────────────────  ┌─ ModelProvider ┐
  └─────────┬─────────┘                                        │ complete()     │
       hop 2│ no tool calls? → break (normal exit)             └────────────────┘
       hop 3│ tool calls? → registry.callTool each, append as user message
            ▼
       (loop continues)
```

**Emit trace events as you go.** After each `complete()`, a `model_usage` event is emitted (provider, model, token counts). Assistant text emits a `step` event. Each tool call emits `tool_call_start` and `tool_call_end` (with duration and any error). The bridge: these are structured logs, but typed and streamed — the trace *is* the observability record. → consumed by `07-ndjson-stream-handoff.md`.

**Run the tools, feed results back.** If the model requested tools, each is executed via the registry, and the results are pushed as a single `user` message of `tool_result` blocks. The bridge: this is the "enqueue the neighbors" step of BFS — the tool results become the next turn's context.

**After the loop: parse, then maybe recover.** Once the loop exits with `finalText`, an optional `parseResult` extracts structured output. If that returns null and a `recoveryPrompt` is configured, one *more* bare model call (no tools) tries to coax a parseable answer. Recovery failure emits a warning, not a crash. → retry mechanics also live in `structured-generation.ts` (see audit lens 6).

#### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** A frontier (the `messages` array) + a turn loop with a hard ceiling (`for turn < maxTurns`) + a per-turn model call + a termination test (no tool calls) + a forced-final-turn that strips tools. Remove the prose around it and that's still the pattern.

2. **Name each part by what breaks if removed.**
   - Remove the **`maxTurns` ceiling** → a model that keeps calling tools loops forever (or until it burns your entire budget / rate limit). This is the agent-loop equivalent of BFS without an empty-frontier check — it never terminates on a "cyclic" conversation.
   - Remove the **`maxToolCalls` budget** → bounded turns, but each turn could request many tools; cost is unbounded within a turn.
   - Remove the **tool-stripping on `forceFinal`** → the loop terminates, but the last turn might be one more tool request, so you exit with no answer. This is the subtle one.
   - Remove the **`tool_result` feed-back** → the model never sees what its tools returned; it can't reason over results. ReAct collapses to a single shot.

3. **Skeleton vs hardening.** Skeleton: the bounded loop, the termination test, the forced synthesis. Hardening: trace events, the recovery turn, abort-signal checks (`signal?.throwIfAborted()` each turn), the usage ledger. The agent could run without any hardening; it could not run correctly without the bound or the forced synthesis.

The interview payoff: name the **forced synthesis turn** (tool-stripping on the last legal turn). Anyone can say "we cap the iterations." The signal that you *built* an agent loop is knowing that capping iterations alone leaves you with a loop that can terminate holding a tool request and no answer — and that stripping the tools on the final turn is what guarantees you always get a synthesized response.

#### Move 3 — the principle

Hand control to the model, but keep the budget. An agent loop is a deliberate tension: the LLM gets to decide *what* to do each turn, but code decides *how many* turns and *forces* a final answer when the budget runs out. Unbounded autonomy is how you get a $400 API bill from an infinite tool-call loop; the bound is the whole reason this is safe to ship.

## Primary diagram

The full recap — outer budget, inner turn, two exits, the recovery tail.

```
  Bounded agent loop — full picture

  ┌─ runtime: runAgentLoop ──────────────────────────────────────────┐
  │  messages = [user: prompt]                                        │
  │                                                                   │
  │  ┌─ for turn in 0..maxTurns ──────────────────────────────────┐  │
  │  │  forceFinal = (turn == last) OR (toolCalls >= maxToolCalls) │  │
  │  │           │                                                 │  │
  │  │           ▼  complete(tools = forceFinal ? none : tools)    │  │
  │  │   ┌─ ModelProvider.complete ─┐ ──► emit model_usage event   │  │
  │  │   └───────────┬───────────────┘                             │  │
  │  │      no tools?─┤── yes ─► finalText = text; BREAK ◄─ exit 1  │  │
  │  │               │  no                                          │  │
  │  │               ▼  registry.callTool each (emit start/end)     │  │
  │  │        append tool_result as user message; turn++            │  │
  │  └──────────────────────────────────────────┬──────────────────┘  │
  │     budget exhausted ─► forceFinal stripped tools ─► synthesize    │
  │                                              │  ◄─ exit 2 (forced)  │
  │                                              ▼                      │
  │  parsed = parseResult(finalText)                                   │
  │  if null and recoveryPrompt → ONE bare recovery call               │
  │  return { finalText, toolCalls, parsed }                           │
  └────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** All six agents are this loop with different config. Anomaly monitoring runs it with `maxTurns: 8, maxToolCalls: 6` to scan metrics and return `Anomaly[]`. Recommendation runs it tighter (`maxTurns: 6, maxToolCalls: 4`) to propose ≤3 recommendations. Query runs it and takes the raw `finalText`. The newest, `rag-query`, runs it with `maxTurns: 6, maxToolCalls: 4` and a single retrieval tool (`packages/agents/rag-query/src/rag-query-agent.ts:66-80`). Every agent passes a `synthesisInstruction` so the forced-final turn produces the right shape (`packages/agents/*/src/*.ts`, the `buildSynthesisInstruction(...)` calls at e.g. `recommendation-agent.ts:88`, `monitoring-agent.ts:78`).

**The loop kernel** — `packages/runtime/src/run-agent-loop.ts` (lines 87–135):

```
  maxTurns = 8, maxTokens = 4096                          ← lines 87-88, defaults

  for (let turn = 0; turn < maxTurns; turn += 1) {        ← line 98, the ceiling
    signal?.throwIfAborted();                             ← line 99, cancellation
    const budgetSpent =
      maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  ← line 101
    const forceFinal = turn === maxTurns - 1 || budgetSpent;          ← line 102
    const response = await model.complete({
      system: forceFinal && synthesisInstruction
        ? `${system}\n\n${synthesisInstruction}` : system,            ← line 104
      messages,
      tools: forceFinal ? undefined : toolSchemas,                    ← line 106
      maxTokens, signal,
    });
       │
       └─ Lines 101-106 ARE the budget discipline. Line 102 computes the forced
          exit; line 106 STRIPS the tools on that turn so the model must answer;
          line 104 appends the synthesis instruction. Remove line 106 and the
          loop can terminate holding a tool request with no synthesized answer.
```

**The normal exit** — `packages/runtime/src/run-agent-loop.ts` (lines 132–135):

```
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) {        ← line 132, model stopped asking for tools
    finalText = text;
    break;                            ← line 134, normal exit
  }
       │
       └─ This is BFS's empty-frontier termination. No tool calls = nothing more
          to expand = done. The forced exit (forceFinal) is the OTHER way out,
          for when the model never stops on its own.
```

**The recovery tail** — `packages/runtime/src/run-agent-loop.ts` (lines 192–228):

```
  let parsed = null;
  if (options.parseResult) {
    parsed = options.parseResult(finalText);
    if (parsed === null && options.recoveryPrompt) {              ← lines 195
      const recoveryText =
        await runRecoveryTurn(options, options.recoveryPrompt(toolCalls));
      parsed = recoveryText === null ? null : options.parseResult(recoveryText);
    }
  }
  return { finalText, toolCalls, parsed };                        ← line 201
       │
       └─ One extra bare model call (no tools, lines 204-228) when the structured
          parse fails. Recovery errors emit a warning event but don't propagate —
          graceful degradation, not a crash.
```

## Elaborate

This is ReAct (Reason+Act, Yao et al. 2022) with a production budget bolted on. Vanilla ReAct describes the *reason → act → observe* cycle but says nothing about termination guarantees — that's exactly the part that bites you in production, where a model can get into a tool-calling loop. AptKit's contribution is the budget discipline: `maxTurns` (hard ceiling), `maxToolCalls` (cost cap), and the forced synthesis (always-an-answer guarantee).

The agent-architecture view of *what the LLM does inside the loop* (reasoning, agentic retrieval, when to call which tool) belongs to study-agent-architecture when generated — that guide owns the "reasoning pattern" lens. This guide owns the loop as a *system-design* mechanism: a bounded unit of work with a guaranteed exit, the same way a runtime's task scheduler bounds work. The runtime-execution view (the event loop, async/await, cancellation) belongs to study-runtime-systems.

Next: `05-multi-agent-pipeline.md` shows three of these loops chained, where one loop's structured output is the next loop's input.

## Interview defense

**Q: How do you keep an agent loop from running forever or blowing the budget?**

Two hard bounds plus a forced exit. `maxTurns` caps iterations; `maxToolCalls` caps total tool calls. On the last legal turn (or when the budget's spent), set `forceFinal` and *strip the tools from the request* so the model can't ask for more — it has to synthesize an answer.

```
  for turn < maxTurns:
    forceFinal = (turn == last) or (toolCalls >= maxToolCalls)
    complete(tools = forceFinal ? NONE : tools)   ← stripping tools = forced answer
    if no tool calls: break
```

Anchor: `run-agent-loop.ts:101-106` — the budget verdict and the tool-stripping.

**Q: You capped the turns. Why isn't that enough?**

Because capping turns alone lets the loop terminate on a turn where the model returned *one more tool request* — you exit with no answer. The fix is stripping the tools on the forced-final turn so the model is forced to produce text. That's the part people miss.

```
  capped only:   last turn → model: "call tool X"  → loop ends, NO answer ✗
  capped+strip:  last turn → tools removed → model must write answer ✓
```

Anchor: `run-agent-loop.ts:106` (`tools: forceFinal ? undefined : toolSchemas`).

## Validate

1. **Reconstruct.** Write the loop kernel from memory: the `for`, the `budgetSpent`/`forceFinal` computation, the tool-stripping, the no-tool-calls break. Check against `run-agent-loop.ts:98-135`.
2. **Explain.** Why are there *two* exits (normal break vs forced synthesis), and what guarantees each one provides?
3. **Apply.** The recommendation agent uses `maxTurns: 6, maxToolCalls: 4` (`recommendation-agent.ts:86-87`). Trace a run where the model calls a tool every turn — on which turn does `forceFinal` fire, and why?
4. **Defend.** A teammate wants to remove `maxToolCalls` and rely only on `maxTurns`. What specifically can go wrong, and what's the cost difference?

## See also

- `01-provider-abstraction.md` — the `complete()` the loop calls each turn.
- `03-fallback-chain.md` — what happens when that `complete()` throws.
- `04-capability-as-tool-policy.md` — where the loop's `toolSchemas` come from.
- `05-multi-agent-pipeline.md` — three of these loops chained.
- `07-ndjson-stream-handoff.md` — where the loop's emitted events go.
- `audit.md` lens 6 — the loop as the primary reliability mechanism.
