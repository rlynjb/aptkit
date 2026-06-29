# 04 — Bounded agent loop

**Industry name(s):** ReAct loop / tool-use agent loop / bounded reasoning loop.
**Type:** Industry standard (with a project-specific budget + synthesis hardening).

## Zoom out, then zoom in

This is the engine every agent runs on. One function, `runAgentLoop`, sits in the
runtime layer and turns "a model + some tools + a question" into "a grounded answer,"
without ever looping forever or spending an unbounded amount of money.

```
  Zoom out — where the loop lives

  ┌─ agents layer ───────────────────────────────────────────┐
  │ RagQueryAgent.answer() → runAgentLoop({ maxTurns, ... })  │
  └───────────────────────────────┬──────────────────────────┘
  ┌─ runtime layer ──────────────▼───────────────────────────┐
  │ ★ runAgentLoop — alternates model.complete() and tool.callTool()  │ ← here
  │   bounded by maxTurns + maxToolCalls; forced synthesis turn │
  └──────────┬──────────────────────────────────┬─────────────┘
             │ model.complete()                  │ tools.callTool()
  ┌─ providers ▼┐                    ┌─ retrieval/tools ▼┐
  │ gemma / ... │                    │ search_knowledge_base│
  └─────────────┘                    └─────────────────────┘
```

The question: *how do you let a model decide its own next step — search, search
again, answer — while guaranteeing the loop terminates, the cost is capped, and a
failing tool doesn't crash the run?* The answer is a `for` loop with three budgets
and a forced ending. Here's the kernel.

## Structure pass

**Layers:** agent (sets the budget) → `runAgentLoop` (enforces it) → model + tools
(do the work).

**Axis traced — *who decides the next step?***

```
  One axis — "who chooses what happens next?" — traced down

  ┌─ agent.answer() ─────────┐   CODE decides the budget (maxTurns 6, calls 4).
  └──────────┬────────────────┘
  ┌─ runAgentLoop body ──────▼┐  CODE decides when to STOP; MODEL decides each step.
  └──────────┬────────────────┘
  ┌─ each turn ───────────────▼┐  MODEL decides: call a tool, or answer.
  └────────────────────────────┘  control flips between code and model at the loop edge.
```

**Seam:** the loop boundary itself. *Outside* the loop, code owns control (the
budget is fixed, not negotiable). *Inside* a turn, the model owns control (it picks
the tool, or stops). That flip — code enforces the envelope, model acts freely
within it — is the whole design.

## How it works

### Move 1 — the mental model

You know a `while` loop with a guard condition and a `break`. This is that, where
the loop body is "ask the model what to do, do it, feed the result back," and the
guard is a turn counter. The one twist: the *last* allowed turn strips the tools away
and forces a text answer, so the loop can't end mid-thought with the model still
trying to call a tool it isn't allowed to.

```
  The loop kernel — the shape to reconstruct from memory

  messages = [user question]
  for turn in 0..maxTurns:                     ← hard iteration bound
     forceFinal = (last turn) or (tool budget spent)
     resp = model.complete(tools = forceFinal ? none : toolSchemas)
     append resp to messages
     toolUses = tool_use blocks in resp
     if none:  finalText = text; break          ← model chose to answer → done
     for each toolUse: run it, append tool_result (errors caught, not thrown)
     append tool_results to messages            ← loop continues
```

### Move 2 — the load-bearing skeleton

The kernel has four parts. Name each by what breaks without it.

**Part 1 — the iteration bound (`maxTurns`).** The `for turn` loop caps total model
round-trips (`run-agent-loop.ts:98`, default 8; RAG agent sets 6).
**What breaks if removed:** a model that keeps deciding to call a tool loops forever
and burns unbounded tokens. This is the single most important mechanic — it's what
makes the loop *bounded*.

**Part 2 — the tool-call budget (`maxToolCalls`).** A second, independent cap on how
many tools may run regardless of turns (`run-agent-loop.ts:101`).
**What breaks if removed:** within the turn budget a model could fan out many tool
calls per turn; this caps total tool work and total cost.

```ts
// packages/runtime/src/run-agent-loop.ts:101 — the two budgets, checked each turn
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
```

**Part 3 — the forced synthesis turn.** When `forceFinal` is true, the loop calls the
model with `tools: undefined` and appends a `synthesisInstruction` to the system
prompt (`run-agent-loop.ts:103`). The instruction is blunt: *"You have NO more tool
calls available. ... Do not say you need more queries."* (`buildSynthesisInstruction`,
`run-agent-loop.ts:72`).
**What breaks if removed:** the loop hits its budget while the model is still trying
to search, and you get back "I need to search again" instead of an answer. This is the
most *surprising* part of the design and the reason it's there: a weak local model,
left to its own devices, will keep asking for more retrieval forever. The forced turn
*takes the tools away* so the only move left is to answer. The RAG agent wires this
explicitly (`rag-query-agent.ts:77`): "Now answer the question directly and concisely,
citing the sources you retrieved."

```
  Why the forced turn exists — the trap it avoids

  without it:  budget hit → model still has tools → "let me search more" → dead end
  with it:     budget hit → tools removed → model MUST emit text → real answer
                            ▲
              forceFinal flips tools to undefined — control returns to code
```

**Part 4 — per-tool failure containment.** Each tool call is wrapped in `try/catch`
(`run-agent-loop.ts:158`); a throw becomes a `tool_result` with `isError:true` fed
back to the model, not an exception that aborts the run.
**What breaks if removed:** one flaky tool kills the entire agent run instead of
letting the model see the error and adapt. This is hardening, not skeleton — the loop
is still a loop without it — but it's what makes the loop *reliable*.

```ts
// packages/runtime/src/run-agent-loop.ts:158 — failure stays inside the loop
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  resultContent = truncate(JSON.stringify(result));        // 16k char cap, run-agent-loop.ts:52
} catch (error) {
  isError = true;
  resultContent = truncate(JSON.stringify({ error: error.message }));  // fed back, not thrown
}
```

**The trace + cancellation, threaded through.** Every turn emits `CapabilityEvent`s
(`step`, `tool_call_start`/`_end`, `model_usage`) into the optional `trace` sink
(`run-agent-loop.ts:112`) — see `05-capability-event-trace.md`. And
`signal?.throwIfAborted()` runs at the top of every turn (`run-agent-loop.ts:99`),
so an aborted run stops at the next turn boundary rather than after the budget.

**Separate skeleton from hardening.** Skeleton: the iteration bound + the
"no-tool-use means done" break + the forced synthesis turn. Hardening: the tool-call
budget (a second bound), per-tool try/catch, result truncation, the recovery turn
(`run-agent-loop.ts:204`, one last no-tools attempt when structured parsing fails).
Saying which is which is the lesson — the bound and the forced ending are what make
it *the pattern*; the rest makes it survive production.

### Move 3 — the principle

An agent loop is a `while` loop where the body's next step is chosen by a model, so
the *only* thing standing between you and an infinite, unbounded-cost run is the
budget you wrap around it — and the forced ending that converts "out of budget" into
"answer now" instead of "give up." Code owns the envelope; the model acts inside it.

## Primary diagram

The full loop, one turn unrolled, with both budgets and the forced ending.

```
  Bounded agent loop — full picture (RAG agent: maxTurns 6, maxToolCalls 4)

  agent.answer(question)
        │
        ▼
  messages = [ user: question ]
  ┌──────────────── for turn = 0 .. maxTurns-1 ─────────────────┐
  │  budgetSpent = toolCalls ≥ maxToolCalls                      │
  │  forceFinal  = (turn == last) OR budgetSpent                 │
  │        │                                                     │
  │        ▼                                                     │
  │  resp = model.complete({ tools: forceFinal ? none : schemas, │
  │                          system: forceFinal ? +synthesis : system })
  │        │  emit model_usage + step events → trace             │
  │        ▼                                                     │
  │  tool_use blocks?                                            │
  │    NO  → finalText = text ──────────────────────────► break │
  │    YES → for each: try callTool → tool_result               │
  │           (error caught → {error}, isError:true)            │
  │           emit tool_call_start/_end → trace                 │
  │           append tool_results → messages ──── loop ─────────┤
  └──────────────────────────────────────────────────────────────┘
        │
        ▼  optional: parseResult; if null → one recovery turn
  return { finalText, toolCalls, parsed }
```

## Elaborate

This is the ReAct pattern (reason + act, interleaved) with the production hardening
that distinguishes a toy from a shippable loop. The original ReAct paper has no
budget — it assumes the model stops on its own. Real loops over weak models can't
assume that, which is why the iteration bound and forced synthesis turn are the
load-bearing additions here. The `maxToolCalls` + forced-final pairing is the
project-specific bit: it exists because a local Gemma, asked to retrieve, will
happily ask to retrieve forever (`rag-query-agent.ts:77` is the antidote in prose).

The reasoning-pattern view of this loop — when to use ReAct vs a fixed pipeline,
multi-agent orchestration — belongs to **`study-agent-architecture`** and
**`study-ai-engineering`**. This file treats the loop purely as an *architectural
boundary*: the place where control flips between code and model, bounded.

## Interview defense

**Q: What stops an agent loop from running forever?**
Two independent budgets — `maxTurns` (total model round-trips) and `maxToolCalls`
(total tool work) — checked at the top of every turn, plus a forced final turn that
strips tools so the model *must* answer (`run-agent-loop.ts:101`). The turn bound is
the one that guarantees termination; the rest caps cost. Anchor: *the iteration
bound is the load-bearing part people forget — a loop without it isn't bounded, it's
hopeful.*

```
  for turn in 0..maxTurns:   ← termination guarantee lives here
     if last turn: tools = none   ← forces an answer, not a give-up
```

**Q: Why the forced synthesis turn — isn't `maxTurns` enough?**
No. `maxTurns` stops the loop, but if the model's last act inside the budget is *"I
need to search more,"* you return that, not an answer. The forced turn removes the
tools and demands text (`buildSynthesisInstruction`), converting "out of budget"
into "answer with what you have." Anchor: *take the tools away on the last turn so
the only legal move is to answer.*

**Q: What happens when a tool throws mid-loop?**
It's caught, serialized as `{ error }` with `isError:true`, and fed back as a normal
`tool_result` (`run-agent-loop.ts:158`). The model sees the failure and can adapt; the
run doesn't crash. Anchor: *a tool failure is data the model reacts to, not an
exception that aborts the run.*

## See also

- `01-provider-neutral-model-seam.md` — the `model.complete()` the loop calls.
- `02-retrieval-contracts-as-the-swap-point.md` — the search tool the loop reaches.
- `05-capability-event-trace.md` — the events every turn emits.
- **`study-agent-architecture`** / **`study-ai-engineering`** — the loop as an AI
  reasoning pattern.
- **`study-runtime-systems`** — `AbortSignal` cancellation and the event-loop model.
