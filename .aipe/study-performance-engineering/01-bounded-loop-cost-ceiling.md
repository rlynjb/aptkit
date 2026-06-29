# Bounded loop cost ceiling

*Industry names: agent iteration cap / max-turns budget / forced-termination
loop. Type: Industry standard (agentic systems).*

## Zoom out, then zoom in

Every agent loop has the same failure mode: the model keeps deciding to call
one more tool, and the run never ends — burning tokens and latency with no
ceiling. The question this file answers: **what stops the agent loop from
running away, and what does that ceiling cost you?** In aptkit the answer is two
hard caps plus a forced final turn, all in `runAgentLoop`.

```
  Zoom out — where the loop sits, and what it spends

  ┌─ Agent layer (packages/agents/*) ───────────────────────────┐
  │  RagQueryAgent.answer() sets maxTurns:6, maxToolCalls:4      │
  └───────────────────────────┬──────────────────────────────────┘
                              │  options
  ┌─ Runtime layer (packages/runtime) ▼──────────────────────────┐
  │  runAgentLoop — for turn 0..maxTurns: await model.complete   │
  │                 ★ THIS CONCEPT: the cost ceiling ★           │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  one network round-trip per turn
  ┌─ Provider layer (packages/providers/*) ▼──────────────────────┐
  │  Gemma / Anthropic / OpenAI — each complete() = latency+tokens│
  └───────────────────────────────────────────────────────────────┘

  each loop turn = one model round-trip = the unit of both latency and cost.
  the cap turns "unbounded run" into a worst-case you can multiply out.
```

The pattern: a loop with a **hard iteration budget** and a **forced synthesis
turn**. The budget bounds the worst case (you can write down "this run costs at
most N round-trips"); the synthesis turn guarantees the run *ends with an
answer* instead of looping or hanging. Together they're the only
overload-control mechanism in the repo — bounding *depth*, not concurrency.

## The structure pass

Trace the **cost** axis (round-trips × tokens) down through the loop.

```
  One axis (cost) held constant across the loop's control points

  ┌─ caller (agent) ───────────┐   sets the ceiling
  │  maxTurns=6, maxToolCalls=4│   → cost ≤ 6 round-trips
  └────────────┬───────────────┘
  ┌─ loop body (per turn) ─────▼┐   spends one unit
  │  await model.complete(...)  │   → 1 round-trip + ≤4096 out tokens
  └────────────┬────────────────┘
  ┌─ last turn (forced final) ─▼┐   spends the LAST unit, no tools
  │  tools:undefined + synthesis│   → guarantees termination
  └─────────────────────────────┘

  the ceiling is declared at the top, spent in the middle, enforced at the end
```

- **Layers:** caller declares the budget; loop body spends it; the final turn
  enforces termination.
- **Axis:** cost = number of `model.complete` calls (each a round-trip and a
  token charge).
- **Seam:** the boundary between "tools allowed" and "tools forbidden." On the
  last turn `forceFinal` flips and the tools array is dropped — control over
  *whether the agent may act* flips from the model to the loop. That flip is
  what makes the run terminate.

## How it works

#### Move 1 — the mental model

You know how a `for` loop with a fixed bound *can't* run forever, unlike a
`while (notDone)` that depends on a condition you hope flips? The agent loop is
deliberately the first kind. The model would happily keep calling tools
(`while the model wants more`), so the loop refuses to honor that past a counter.

```
  Pattern — the bounded agent loop

  turn 0 ──► model.complete ──► tool_use? ──yes──► run tools ──┐
   ▲                                                           │
   │  turn < maxTurns AND toolCalls < maxToolCalls             │
   └───────────────────────────────────────────────────────────┘
                              │ no (text only) → DONE
                              ▼
  LAST turn (turn==max-1 OR budget spent):
     forceFinal = true → tools:undefined + synthesis instruction
     model MUST answer in prose → loop breaks → DONE
```

#### Move 2 — the step-by-step walkthrough

**The two caps that bound the worst case.** Top of the loop —
`packages/runtime/src/run-agent-loop.ts:98-109`:

```ts
for (let turn = 0; turn < maxTurns; turn += 1) {       // ← hard turn ceiling
  signal?.throwIfAborted();                            //   cancellation seam
  const budgetSpent =
    maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // ← tool ceiling
  const forceFinal = turn === maxTurns - 1 || budgetSpent;          // ← either trips it
  const response = await model.complete({
    system: forceFinal && synthesisInstruction
      ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,        // ← tools REMOVED on final turn
    maxTokens,                                          //   per-call output cap (4096)
    signal,
  });
```

Two independent ceilings. `maxTurns` (default 8, rag-query sets 6 at
`rag-query-agent.ts:75`) caps total iterations. `maxToolCalls` (rag-query sets 4
at `:76`) caps *actions* — a run could hit the tool budget before the turn
budget. The worst-case cost is therefore `min(maxTurns, derived-from-maxToolCalls)`
round-trips, each charging at most `maxTokens` output. That's a number you can
multiply by per-token price to get a hard dollar ceiling per run. *That's* the
budget the audit says is "implicit" — it's enforced in code but never written
down as a target.

**The forced synthesis turn — the most load-bearing mechanic here.** When
`forceFinal` is true, two things change at once: the tools array becomes
`undefined` (the model *cannot* call a tool even if it wants to) and the
synthesis instruction is appended. `buildSynthesisInstruction` (`:72-74`):

```ts
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
```

Without this, a run that exhausted its turns would return whatever the model
last said — often "let me search again," i.e. *no answer*. The forced turn
converts the budget from a guillotine ("we cut you off mid-thought") into a
clean exit ("you're out of searches, now answer"). The rag-query agent's
synthesis text (`rag-query-agent.ts:77-79`) is "Now answer the question
directly and concisely, citing the sources you retrieved."

**How a normal turn ends early.** Most runs don't hit the cap. The loop breaks
as soon as a response has no `tool_use` blocks — `:131-135`:

```ts
const toolUses = toolUsesFromContent(response.content);
if (toolUses.length === 0) {        // model answered in prose, not a tool call
  finalText = text;
  break;                            // ← the common, cheap exit
}
```

So the cap is the *worst* case, not the typical one. The typical RAG run is:
turn 0 → search → turn 1 → answer → break. Two round-trips, well under the
ceiling.

**The boundary condition: tool results are truncated to bound prompt growth.**
Each turn appends the tool results to `messages` (`:189`), and the prompt grows
every turn. To stop a fat tool result from exploding the next prompt's token
count, results are capped — `:52-57`:

```ts
const MAX_TOOL_RESULT_CHARS = 16_000;
function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}
```

This is a *token-cost* guard hiding in plain sight: without it, a single
verbose `search_knowledge_base` result would inflate the input tokens of every
subsequent turn.

#### Move 2 variant — the load-bearing skeleton

The irreducible kernel: **(1) a counter, (2) a per-iteration check against a
fixed max, (3) a forced-termination branch that strips the agent's ability to
loop.**

- Drop the counter / max → `while (model wants more)` → unbounded run, the
  classic runaway. Cost has no ceiling.
- Drop the forced-termination branch → you cut the model off mid-reasoning and
  return a non-answer ("I need to search more"). The budget became a bug.
- Drop the early `break` on text-only responses → every run pays the full
  ceiling even when the model is done after one search. Pure waste.

Optional hardening on top of the skeleton: `maxToolCalls` (a *second*,
finer-grained ceiling), `maxTokens` per call, the 16 kB truncation, the
`signal` cancellation checks. The skeleton is the counted loop + forced exit;
everything else is tightening.

#### Move 3 — the principle

An agent loop is a `while` loop where the model writes the continue-condition —
so you must own the *off-switch* the model can't override. The hard iteration
budget is that off-switch, and the forced synthesis turn is what makes the
off-switch produce an answer instead of a stump. The generalizable rule:
**bound every loop whose termination depends on an LLM's judgment, and make the
bound terminate cleanly.** This is the repo's one real overload-control
mechanism — and note what it is *not*: it bounds how deep a single run goes, not
how many runs hit the model at once (no concurrency limiter exists — that's the
backpressure gap in the audit).

## Primary diagram

```
  The bounded loop — cost ceiling + forced termination

  ┌─ caller declares budget ────────────────────────────────────┐
  │  maxTurns=6 · maxToolCalls=4 · maxTokens=4096                │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
  ┌─ loop, turn = 0 .. maxTurns ────────────────────────────────┐
  │  forceFinal = (turn==max-1) || (toolCalls>=maxToolCalls)     │
  │     ├─ not final → tools=schemas → model may search          │
  │     │     └─ no tool_use in reply → break (cheap exit)       │
  │     └─ final    → tools=undefined + synthesis → must answer  │
  │  each iteration: 1× model.complete  (round-trip + ≤4096 tok) │
  │  tool results truncated to 16 kB before re-prompting         │
  └───────────────────────────┬──────────────────────────────────┘
                              ▼  worst case ≤ 6 round-trips, bounded $ and ms
                          finalText
```

## Elaborate

The max-turns cap is the standard answer to the agentic-loop runaway problem —
the same instinct as a recursion depth limit or a circuit breaker's failure
count. The forced-synthesis turn is the less-obvious half and the one that
separates a toy loop from a shippable one: termination must *produce output*,
not just stop. aptkit's version is provider-neutral — it works identically
whether the turn hits Gemma (which may itself spend an extra round-trip retrying
a botched tool call, `gemma-provider.ts:62-89`) or a cloud model. Read next:
`03-token-cost-accounting.md` (how the tokens each turn spends get summed and
priced) and `02-linear-scan-vs-ann-tradeoff.md` (the cost of the tool the loop
calls).

## Interview defense

**Q: How do you keep an agent loop from running forever?**

Verdict first: a hard iteration budget plus a forced final turn — not a
condition you hope the model honors. The budget (`maxTurns`, `maxToolCalls`)
caps worst-case round-trips, which is also your cost ceiling. The forced turn is
the part people forget: on the last iteration you *strip the tools array* so the
model physically can't call another tool, and you inject a "you're out of
searches, answer now" instruction so it terminates with a real answer instead of
"let me search again."

```
  sketch while you talk:

  for turn in 0..max:
     forceFinal = turn==max-1 OR toolCalls>=maxToolCalls
     complete(tools = forceFinal ? none : schemas)   ← strip tools to force end
     no tool_use? → break                            ← cheap common exit
```

One-line anchor: *"the model writes the continue-condition, so I own the
off-switch — and the off-switch ends with an answer, not a stump."*

**Q: What does a run cost, worst case?**

`min(maxTurns, maxToolCalls+1)` round-trips, each ≤ `maxTokens` output, plus the
input that grows ~linearly with turns (capped per tool result at 16 kB). Multiply
by per-token price and you have a hard dollar ceiling. The honest gap: that
ceiling is enforced but never *written down* as a budget, and no run has been
timed to know the typical case.

## See also

- `audit.md` — lens 1 (budget), lens 3 (tail behavior), red-flag #6
  (no concurrency cap — the limit this *doesn't* provide).
- `03-token-cost-accounting.md` — pricing the tokens each turn spends.
- `02-linear-scan-vs-ann-tradeoff.md` — the cost of the tool inside the loop.
