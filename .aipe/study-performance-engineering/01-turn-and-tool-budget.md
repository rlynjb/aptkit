# Turn-and-Tool Budget

*Industry names: bounded agent loop, iteration cap, work budget,
forced-termination synthesis. Type: Industry standard (agentic loop
control).*

## Zoom out, then zoom in

For an LLM agent, the thing that costs money and time isn't a CPU loop —
it's the count of model round-trips. This pattern is the governor on
that count. It lives in the runtime, between the agent and the provider.

```
  Zoom out — where the budget sits

  ┌─ Agent layer ──────────────────────────────────────┐
  │  RecommendationAgent.propose(...) → runAgentLoop()  │
  └──────────────────────────┬──────────────────────────┘
                            │  bounded by maxTurns / maxToolCalls
  ┌─ Runtime layer ─────────▼───────────────────────────┐
  │  ★ THE LOOP ★  for turn in 0..maxTurns:             │ ← we are here
  │     decide: offer tools, or force final answer?     │
  └──────────────────────────┬──────────────────────────┘
                            │  at most one billed call per turn
  ┌─ Provider layer ────────▼───────────────────────────┐
  │  model.complete()  →  Anthropic / OpenAI (billed)   │
  └──────────────────────────────────────────────────────┘
```

Zoom in: it's a `for` loop with a hard upper bound and one twist — on
the final allowed iteration it changes the request so the model *cannot*
keep working. That twist is the whole reason the worst case is bounded.

## The structure pass

**Layers:** agent (sets the budget numbers) → runtime loop (enforces
them) → provider (does the billed work).

**Axis — cost (billed round-trips per run):** trace it down the layers
and watch where control over cost flips.

```
  One axis — "who controls how many billed calls happen?" — down the layers

  ┌─ Agent ─────────────────────────┐
  │ declares maxTurns=6, maxTool=4  │  → sets the ceiling
  └────────────────┬────────────────┘
       seam: the budget numbers cross into the loop
  ┌─ Runtime loop ─▼────────────────┐
  │ counts turns, counts tool calls │  → ENFORCES the ceiling
  │ forces final answer at the edge │     (control lives here)
  └────────────────┬────────────────┘
       seam: tools present? → flips to tools absent
  ┌─ Provider ─────▼────────────────┐
  │ runs whatever it's asked        │  → no control; just bills
  └─────────────────────────────────┘
```

**The seam that matters:** the boundary inside the loop where `tools:
toolSchemas` flips to `tools: undefined`. Before that seam the model can
choose to call a tool (and spend another turn); after it, the model can
only emit text. The cost-control answer flips across that single line —
that's the load-bearing joint.

## How it works

You know how a `while` loop with no exit condition will spin forever if
the body never makes the condition false? An agent loop has exactly that
risk: the model can keep deciding "I need one more tool call" on every
turn. The fix is the same fix you'd reach for in any unbounded loop —
**a hard counter that terminates regardless of what the body wants** —
plus one extra move that makes the *last* iteration productive instead
of wasted.

### Move 1 — the mental model: a bounded loop with a forced exit

```
  The kernel — bounded loop + forced-final edge

  turn 0 ──► complete(tools offered) ──► tool calls? ──yes──► run tools, loop
                                              │ no
                                              ▼ final text, break
  turn 1 ──► complete(tools offered) ──► ...
  ...
  turn N-1 (or budget spent) ──► FORCE FINAL:
            complete(tools = NONE, + "you have no more tool calls")
                                              │
                                              ▼ model must answer → break
```

The shape: iterate up to a ceiling; on each turn either the model
answers (done) or asks for tools (run them, continue); on the last
allowed turn, remove the tools so the model is forced to answer.

### Move 2 — the step-by-step walkthrough

**The turn counter (the part that guarantees termination).** The loop
is `for (turn = 0; turn < maxTurns; turn++)`. This is the load-bearing
part: drop it and a model that always requests a tool runs forever,
billing you on every turn. The counter is what makes the worst-case bill
a fixed, knowable number before the run even starts.

```
  Turn counter — the hard bound

  maxTurns = 6
  ┌────┬────┬────┬────┬────┬────┐
  │ t0 │ t1 │ t2 │ t3 │ t4 │ t5 │  ← cannot exceed 6 billed calls
  └────┴────┴────┴────┴────┴────┘
                            ▲
                            └─ t5 is the forced-final turn
```

**The tool-call budget (the early brake).** Separate from the turn
count, the loop tracks how many tool calls have been made. When
`toolCalls.length >= maxToolCalls`, the budget is "spent" and the next
turn is forced to be final — even if turns remain. Why two separate
counters? A turn can request multiple tools at once, so tool calls can
outrun turns. The tool-call budget caps *retrieval work* (the expensive,
context-inflating part); the turn budget caps *round-trips*. Drop the
tool-call budget and the model could gather far more data than you want
to pay to stuff back into context.

```
  Two independent brakes

  forceFinal = (turn == maxTurns - 1)   ← ran out of turns
            OR (toolCalls >= maxToolCalls) ← ran out of tool budget

  whichever trips first ends the gathering phase
```

**The forced-synthesis turn (the tail cap — the most important part).**
When `forceFinal` is true, the loop does two things in the same request:
it sets `tools: undefined` (so no tool can be offered) and it prepends a
synthesis instruction to the system prompt ("you have NO more tool calls
available… do not say you need more queries"). Bridge from what you know:
it's like disabling a button in the UI so the user *can't* take the
action you don't want — except here the "button" is the model's ability
to call a tool. With tools removed from the request, the model's only
legal output is text. That's what caps the tail: without it, the model
could spend its final turn asking for data it will never get and return
nothing, making you pay for the whole run with no answer.

```
  The seam, made concrete — one request, tools flip off

  normal turn:        complete({ system,            tools: toolSchemas })
                                                     └─ model MAY call a tool

  forced-final turn:  complete({ system + synthesis, tools: undefined })
                                  └─ "no more calls"  └─ model CANNOT call a tool
                                                         → must answer
```

**The recovery turn (optional hardening, not skeleton).** After the
loop, if the final text didn't parse into the expected shape and a
`recoveryPrompt` is provided, the runtime makes one more clean call
("output ONLY the structured answer… never ask for more data") at a
reduced 2048-token budget. This is hardening layered on top — it salvages
a malformed answer without re-running the whole gathering phase. It's not
part of the kernel; an agent with no `parseResult` never reaches it.

### Move 3 — the principle

**An agent loop is only safe to ship once its worst case is a number you
can write down.** The turn counter makes the bill bounded; the
forced-synthesis turn makes the bounded bill *productive* instead of a
wasted spend. The general lesson: when control flow is delegated to a
model, the surrounding code must own the termination guarantee — the
model decides *what* to do, but the loop decides *when to stop*.

## Primary diagram

The full picture: budget set by the agent, enforced by the loop, with
the forced-final edge that caps the tail.

```
  Turn-and-tool budget — full recap

  ┌─ Agent layer ─────────────────────────────────────────────┐
  │ maxTurns=6, maxToolCalls=4, synthesisInstruction="..."     │
  └───────────────────────────────┬────────────────────────────┘
                                  ▼
  ┌─ Runtime: runAgentLoop ───────────────────────────────────┐
  │                                                            │
  │  for turn = 0 .. maxTurns-1:                               │
  │     budgetSpent = toolCalls >= maxToolCalls                │
  │     forceFinal  = (turn == last) OR budgetSpent            │
  │                                                            │
  │     response = complete({                                  │
  │        system: forceFinal ? system+synthesis : system,    │
  │        tools:  forceFinal ? undefined : toolSchemas,  ◄────┼── the seam
  │        maxTokens                                           │
  │     })                                                     │
  │     emit model_usage(inputTokens, outputTokens) ──────────┼──► cost ledger
  │                                                            │
  │     if no tool_use blocks: finalText = text; BREAK         │
  │     else: run tools (truncate results @16k), loop          │
  └───────────────────────────────┬────────────────────────────┘
                                  ▼
  ┌─ Provider layer ──────────────────────────────────────────┐
  │ at most maxTurns billed model.complete() calls per run    │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every agent in the repo runs through this loop:
recommendation (`maxTurns: 6`, `maxToolCalls: 4`), monitoring,
diagnostic, and query (all `8`/`6`), rubric-improvement (`6`/`3`). The
numbers are tuned per capability — recommendation needs less gathering
(it's handed a diagnosis), monitoring/query scan more (they explore a
workspace).

**Code — the loop control, `packages/runtime/src/run-agent-loop.ts:98-135`:**

```
for (let turn = 0; turn < maxTurns; turn += 1) {         ← hard turn bound
  signal?.throwIfAborted();                              ← cancellation point

  const budgetSpent =
    maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  ← tool brake
  const forceFinal = turn === maxTurns - 1 || budgetSpent;          ← either brake → final

  const response = await model.complete({
    system: forceFinal && synthesisInstruction              ← synthesis prompt
      ? `${system}\n\n${synthesisInstruction}` : system,       only on forced turn
    messages,
    tools: forceFinal ? undefined : toolSchemas,            ← THE SEAM: tools off
    maxTokens,                                                 on forced turn
    signal,
  });
  ...
  const toolUses = toolUsesFromContent(response.content);
  if (toolUses.length === 0) {                            ← model answered, no tools
    finalText = text;
    break;                                                ← normal exit
  }
       │
       └─ if the model could STILL call a tool on the last turn, a run
          could spend every turn gathering and return no answer — the
          `tools: undefined` flip is what removes that failure (load-bearing)
}
```

**Code — the synthesis instruction builder,
`packages/runtime/src/run-agent-loop.ts:72-74`:**

```
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
                │                                              │
                └─ tells the model the gathering phase is over └─ blocks the
                   (belt) — the `tools: undefined` is the suspenders     "one more query" stall
}
```

**Code — where an agent sets its budget,
`packages/agents/recommendation/src/recommendation-agent.ts:86-90`:**

```
maxTurns: 6,                ← at most 6 billed round-trips for this capability
maxToolCalls: 4,            ← at most 4 retrieval calls before forced synthesis
synthesisInstruction: buildSynthesisInstruction(
  'Stop querying now and output your final answer. Respond with ONLY a JSON array ...',
),                          ← the per-capability "wrap it up" instruction
```

## Elaborate

This is the standard hardening of the ReAct / tool-use loop. The naive
version is "loop until the model stops calling tools," which has no
termination guarantee — a known way to burn an API budget. Production
agent frameworks all add an iteration cap; the forced-synthesis turn is
the refinement that converts "we stopped you" into "we stopped you *and*
got an answer." It pairs with the cost ledger
(**02-token-cost-ledger.md**) which measures what the budget actually
spent, and with the context-window guard
(**03-context-window-preflight-guard.md**) which bounds the *size* of
each turn rather than the *count*. For the execution-model mechanics of
the loop itself (the `AbortSignal`, the message accumulation), see
**study-runtime-systems**.

## Interview defense

**Q: Your agent calls an LLM in a loop. How do you stop it from running
up an unbounded bill?**

Two counters and a forced exit. A hard `maxTurns` cap on round-trips, a
separate `maxToolCalls` cap on retrieval, and — the part people forget —
on the final allowed turn I remove the tools from the request entirely
so the model *can't* ask for more work; it can only answer.

```
  for turn < maxTurns:
     forceFinal = last turn OR tool budget spent
     complete(tools = forceFinal ? NONE : toolSchemas)  ← tools off → must answer
     no tool calls? → done
```

Anchor: `run-agent-loop.ts:98-109`, `maxTurns: 6` / `maxToolCalls: 4` in
`recommendation-agent.ts:86-87`.

**Q: Why two separate counters instead of one?**

Because one turn can request several tools at once, so tool calls outrun
turns. The turn counter bounds *round-trips* (latency + per-call cost);
the tool-call counter bounds *retrieval* (context bloat → input-token
cost). They cap different costs.

```
  turn budget  → bounds # of billed calls
  tool budget  → bounds # of data fetches stuffed back into context
```

Anchor: `run-agent-loop.ts:101`.

## Validate

1. **Reconstruct:** write the loop kernel from memory — turn counter,
   tool-call brake, forced-final flip, normal-exit break. Check against
   `run-agent-loop.ts:98-135`.
2. **Explain:** why does removing `tools` on the last turn cap the tail
   cost and not just the turn count? (Without it the model can spend its
   last turn asking for data and return nothing.)
3. **Apply:** the query agent uses `maxTurns: 8`, `maxToolCalls: 6`
   (`query-agent.ts:94-95`). What is the maximum number of billed
   `model.complete()` calls one `answer()` can make, including a possible
   recovery turn? (8 in the loop + at most 1 recovery = 9.)
4. **Defend:** a teammate wants to drop `maxToolCalls` and rely only on
   `maxTurns`. What cost regresses, and on which capability is it worst?
   (Context-token cost from unbounded gathering; worst on monitoring/query
   which scan a workspace.)

## See also

- **02-token-cost-ledger.md** — measuring what the budget spent.
- **03-context-window-preflight-guard.md** — bounding turn *size*.
- **04-fixture-replay-as-zero-cost-path.md** — running the loop for $0.
- **audit.md** — lenses 1 and 3 (budget, tail behavior).
- **study-runtime-systems** — the loop's execution model and cancellation.
