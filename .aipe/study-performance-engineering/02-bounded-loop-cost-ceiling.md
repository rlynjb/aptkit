# Bounded loop cost ceiling

**Industry name:** bounded iteration / hard iteration budget on an agentic loop · **Type:** Industry standard (agent systems)

The cap that turns an open-ended "let the model decide when it's done" loop into a worst-case cost you can name before you run it.

---

## Zoom out, then zoom in

An agent loop is a `while`-ish loop where each iteration is a network round-trip to a language model, and the model decides whether to keep going. Without a ceiling, that loop's cost and latency are unbounded by construction — the model could call tools forever. The ceiling is what makes the worst case a number.

```
  Zoom out — where the ceiling lives

  ┌─ Agent layer ─────────────────────────────────────────────┐
  │  RecommendationAgent / QueryAgent / RagQueryAgent ...      │
  │     each passes maxTurns + maxToolCalls into ↓             │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Runtime layer ───────────▼───────────────────────────────┐
  │  runAgentLoop:  for (turn = 0; turn < maxTurns; turn++)    │ ← we are here
  │     ★ the ceiling: maxTurns, maxToolCalls, maxTokens ★     │
  └───────────────────────────┬───────────────────────────────┘
                              │ await model.complete() per turn
  ┌─ Provider layer ──────────▼───────────────────────────────┐
  │  Anthropic / OpenAI / Gemma — one HTTP round-trip per turn │
  └────────────────────────────────────────────────────────────┘
```

The loop lives in `runAgentLoop` (`packages/runtime/src/run-agent-loop.ts`); each agent injects its own ceiling. The thing to see is that **the most expensive operation in the whole system — a model round-trip — happens once per loop iteration**, so capping iterations *is* capping cost and tail latency in one move.

## The structure pass

Trace **the cost axis — "how many model round-trips can this run cost?"** down the layers.

```
  Axis: "how many round-trips can one run cost?"  — held constant down the stack

  ┌───────────────────────────────────────────────┐
  │ agent: sets maxTurns=6, maxToolCalls=4         │  → ceiling is DECLARED here
  └───────────────────────────────────────────────┘
      ┌─────────────────────────────────────────────┐
      │ runAgentLoop: for turn < maxTurns            │  → ceiling is ENFORCED here
      └─────────────────────────────────────────────┘
          ┌─────────────────────────────────────────┐
          │ model.complete(): 1 HTTP round-trip      │  → ceiling has NO say here
          └─────────────────────────────────────────┘

  same axis, three answers: declared → enforced → opaque
```

- **Layers:** agent (declares the budget) → runtime loop (enforces it) → provider (one round-trip, oblivious).
- **Axis:** round-trips-per-run. It is *set* at the agent, *enforced* by the loop counter, and *invisible* to the provider.
- **Seam:** the `RunAgentLoopOptions` boundary (`run-agent-loop.ts:35-50`) — where an agent hands its budget to the loop. The cost axis flips across it from "policy" (agent's choice) to "mechanism" (loop's counter).

## How it works

#### Move 1 — the mental model

You know the bug where a `while` loop with a bad exit condition spins forever and pins a CPU. The agent loop has the same failure mode, except each spin costs a model API call — money and seconds, not just cycles. The fix is the oldest one in the book: a `for` loop with a hard upper bound, not a `while` that trusts the body to stop.

```
  Pattern — the bounded loop kernel

  turn 0 ─► model.complete() ─► tool_use? ──yes──► run tools ─┐
                                   │                           │
                                   no                          │ loop back,
                                   ▼                           │ turn++
                              finalText, break                 │
                                                               ▼
  ... ─► turn == maxTurns-1  OR  toolCalls >= maxToolCalls ─► FORCE FINAL
            (drop tools from the request, demand the answer)
```

Two ceilings, not one: `maxTurns` caps iterations, `maxToolCalls` caps total tool invocations across all turns. Either one tripping flips the loop into a forced-synthesis turn — the single most important mechanic here, because it is what guarantees the loop produces an *answer* instead of just *stopping*.

#### Move 2 — the load-bearing skeleton

The kernel is small. Strip it to the parts that, removed, change the cost guarantee:

**The counter — `for (turn = 0; turn < maxTurns; turn++)`.** This is the ceiling. Remove it (make it a `while (true)`) and the only thing stopping the loop is the model choosing not to call a tool — unbounded by construction.

```ts
// packages/runtime/src/run-agent-loop.ts:98-102
for (let turn = 0; turn < maxTurns; turn += 1) {   // ← the hard ceiling
  signal?.throwIfAborted();                          //   cancellation seam (runtime-systems)
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal = turn === maxTurns - 1 || budgetSpent;   // ← either ceiling trips this
```

**The tool-call budget — `toolCalls.length >= maxToolCalls`.** A second, independent ceiling. `maxTurns` alone is not enough because one turn can issue several tool calls (the loop runs every `tool_use` block in `response.content`, line 139). `maxToolCalls` bounds the *total work* regardless of how the model packs it into turns. Remove it and a single turn could fan out to dozens of tool calls under the turn cap.

**The forced-synthesis turn — `forceFinal`.** When either ceiling is about to trip, the next request drops the tools (`tools: forceFinal ? undefined : toolSchemas`, line 106) and, if a synthesis instruction is set, appends "you have NO more tool calls available… do not say you need more queries" (`buildSynthesisInstruction`, line 72-74). This is the load-bearing part people forget. Without it, hitting the ceiling just exits the loop with whatever half-finished state existed — often an empty `finalText`. With it, the last turn is spent *forcing the model to answer with what it has*. The ceiling becomes a graceful degrade, not a cliff.

```ts
// packages/runtime/src/run-agent-loop.ts:103-109
const response = await model.complete({              // ← the one expensive op, once per turn
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,        // ← drop tools on the forced turn
  maxTokens,                                          //   per-turn output cap (default 4096)
  signal,
});
```

**Optional hardening (not skeleton):** `maxTokens` caps output *size* per turn (cost per call, line 88); `MAX_TOOL_RESULT_CHARS = 16_000` truncates tool results before they re-enter the context (line 52-57, stops a huge tool output from blowing the next turn's input cost); the `recoveryPrompt` path (line 195-199) is a *correctness* retry, not a cost mechanism. These harden the per-turn cost; the loop counter is what bounds the *number* of turns.

#### Move 2.5 — what the ceiling buys, per agent

Each agent picks its own ceiling, and the numbers encode a cost decision:

```
  Per-agent ceilings (file:line) — worst-case round-trips

  recommendation   maxTurns 6, maxToolCalls 4   recommendation-agent.ts:86-87
  rag-query        maxTurns 6, maxToolCalls 4   rag-query-agent.ts:75-76
  rubric-improve   maxTurns 6, maxToolCalls 3   rubric-improvement-agent.ts:75-76
  query            maxTurns 8, maxToolCalls 6   query-agent.ts:94-95
  anomaly-monitor  maxTurns 8, maxToolCalls 6   monitoring-agent.ts:76-77
  diagnostic       maxTurns 8, maxToolCalls 6   diagnostic-agent.ts:73-74
  loop default     maxTurns 8, maxTokens 4096   run-agent-loop.ts:87-88
```

Worst case for the recommendation agent is **6 model round-trips, ≤4 tool calls, ≤4096 output tokens each** — a number you can multiply by per-token price to get a hard cost ceiling per run *before running it*. That is the payoff: the budget is knowable in advance.

#### Move 3 — the principle

When each loop iteration costs a network round-trip, the loop bound *is* the cost bound and the tail-latency bound. Don't trust the body to terminate — cap the iterations, and make hitting the cap a forced graceful finish rather than an abrupt exit. The ceiling without the forced-synthesis turn is half a pattern; together they turn an unbounded agentic loop into a run with a worst case you can price.

## Primary diagram

```
  The bounded loop — full picture

  agent declares: maxTurns, maxToolCalls, maxTokens
        │
        ▼
  ┌─ runAgentLoop ────────────────────────────────────────────────┐
  │  for turn in 0..maxTurns:                                       │
  │     budgetSpent = toolCalls >= maxToolCalls                     │
  │     forceFinal  = (turn == last) OR budgetSpent                 │
  │                                                                 │
  │     ┌─────────────────────────────────────────────────────┐   │
  │     │ await model.complete(                                 │   │ ← 1 round-trip
  │     │   tools = forceFinal ? none : toolSchemas,            │   │   (the cost unit)
  │     │   system += forceFinal ? synthesisInstruction : '' )  │   │
  │     └─────────────────────────────────────────────────────┘   │
  │     emit model_usage(inputTokens, outputTokens)  ───────────────┼─► token ledger
  │                                                                 │   (03-...)
  │     no tool_use → finalText, break                              │
  │     tool_use    → run tools (≤ maxToolCalls total), loop        │
  └─────────────────────────────────────────────────────────────────┘

  worst case = maxTurns round-trips × maxTokens output  → a priceable number
```

## Elaborate

The hard iteration budget is the defining safety property of production agent loops — it is what separates a shippable ReAct loop from a demo that can run up an unbounded bill. The forced-synthesis turn is the part that distinguishes a *good* implementation: many agent loops cap iterations but exit empty-handed on the cap; this one spends the last turn extracting an answer. The token-accounting side of the same loop (the `model_usage` events emitted at line 111-122) is what turns the bounded count into an actual measured cost — covered in `03-token-cost-accounting.md`.

What this loop does *not* have: backpressure across concurrent runs. The ceiling bounds one run's cost; nothing bounds how many runs execute at once (`audit.md` red flag #7). The per-run ceiling and the missing cross-run limiter are different problems.

## Interview defense

**Q: How do you stop an agent loop from running forever or running up the bill?**
A hard iteration ceiling — `for turn < maxTurns`, plus an independent `maxToolCalls` total — not a `while` that trusts the model. Each turn is one model round-trip, so the turn cap *is* the cost cap. The recommendation agent's worst case is 6 round-trips × 4096 output tokens — a number I can price before running.

```
  for turn < maxTurns:           ← caps iterations
    if toolCalls >= maxToolCalls  ← caps total tool work
       OR turn == last:
       forceFinal → drop tools, demand the answer
```
Anchor: "the loop bound is the cost bound."

**Q: What's the part people forget?**
The forced-synthesis turn. Hitting the ceiling can't just exit the loop — that leaves you with no answer. The last turn drops the tools and instructs the model to answer with what it has. The ceiling becomes a graceful degrade, not a cliff. That's `forceFinal` flipping the request at `run-agent-loop.ts:102-106`.

Anchor: "cap the turns, but spend the last one forcing an answer."

## See also

- `03-token-cost-accounting.md` — turning the bounded turns into measured cost
- `04-embedding-batching.md` — the other per-call cost in a run
- `audit.md` — Lens 1 (ceilings as budget), Lens 3 (serial round-trips = tail latency), Lens 8 (red flag #7)
- `study-runtime-systems` — the event loop, `AbortSignal` cancellation threaded through the loop
