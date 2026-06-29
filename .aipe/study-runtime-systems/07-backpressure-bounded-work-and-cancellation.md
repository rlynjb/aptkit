# Backpressure, Bounded Work, and Cancellation

**Subtitle:** bounded loops / cooperative cancellation (the `AbortSignal`) / graceful shutdown — *the bounded agent loop* (Industry standard, project term).

## Zoom out, then zoom in

This is where aptkit's runtime design is strongest *and* where its biggest honest gap lives. Verdict first: aptkit bounds work **within a single agent run** beautifully — a hard turn cap, a hard tool-call cap, a forced final turn, and an `AbortSignal` threaded through every await. But it does **nothing** to bound work *across* runs — no concurrency limiter, no queue, no backpressure — and it has **no graceful shutdown** (no `SIGTERM` handler). The bounds are vertical (inside one loop), not horizontal (across many loops).

```
  Zoom out — where work is bounded in the runtime

  ┌─ Capability layer ──────────────────────────────┐
  │  agent.answer() — configures the bounds          │
  └───────────────────────┬───────────────────────────┘
  ┌─ Runtime layer ───────▼──────────────────────────┐
  │  ★ runAgentLoop ★                                 │ ← THIS CONCEPT
  │   maxTurns · maxToolCalls · forced synthesis turn │   the bounding kernel
  │   signal.throwIfAborted() at every await          │
  └───────────────────────┬───────────────────────────┘
  ┌─ MISSING ─────────────▼──────────────────────────┐
  │  no limiter · no queue · no backpressure ·        │   not yet exercised
  │  no SIGTERM handler                                │
  └────────────────────────────────────────────────────┘
```

**Zoom in.** Three mechanisms carry the bounding, all inside `runAgentLoop`: the iteration budget (you cannot loop forever), the forced final synthesis turn (the model is *made* to answer when the budget runs out), and cooperative cancellation (a caller can stop the loop mid-flight). The most load-bearing is the forced synthesis turn — it's what turns "budget exhausted" from a thrown error into a useful answer. The biggest surprise is that cancellation is wired everywhere but *shutdown* is wired nowhere — and that's a deliberate consequence of aptkit being a library, not a service.

## The structure pass

Trace the axis **"what stops this work?"** across the levels.

```
  One axis — "what stops the work?" — by level

  ┌─ within one turn ────────────┐   the AbortSignal
  │  signal.throwIfAborted()      │   → caller cancels → loop throws, unwinds
  └──────────────┬─────────────────┘
  ┌─ across turns (one run) ─────┐   maxTurns / maxToolCalls + forced synthesis
  │  the for-loop budget          │   → budget hit → final answer forced
  └──────────────┬─────────────────┘
  ┌─ across runs (the system) ───┐   NOTHING — no limiter, no queue
  │  concurrency control          │   → unbounded; nothing throttles parallel runs
  └───────────────────────────────┘
  ┌─ process lifetime ───────────┐   NOTHING — no SIGTERM handler
  │  graceful shutdown            │   → in-flight work not drained on stop
  └───────────────────────────────┘
```

Two seams flip the axis:

- **Seam 1 — "one run" → "many runs."** Inside a run, work is rigorously bounded. Across runs, there's no bound at all — fire a thousand `agent.answer()` calls and a thousand loops run, each making its own `fetch`es, with nothing to limit concurrency. The flip is **bounded → unbounded**. → this is the backpressure gap.
- **Seam 2 — "running" → "stopping."** A *caller* can cancel a run via the signal, but the *process* can't stop a run on `SIGTERM` because nobody listens for it. The flip is **caller-cancellable → not-process-cancellable**. Both gaps trace to the same root: aptkit doesn't own the process or the dispatch (`01-runtime-map.md`).

## How it works

### Move 1 — the mental model

You've built the safe version of this without naming it: a retry loop with `for (let i = 0; i < maxRetries; i++)` instead of `while (true)`. The bound is the `maxRetries`. An agent loop is the same shape with higher stakes — a confused model can ask for "one more search" indefinitely, so the loop *must* have a hard ceiling, and it must have a plan for what happens when the ceiling is hit. The plan can't be "throw" (you'd have nothing to show the user); it has to be "make the model answer now."

```
  The bounded-loop kernel — budget + escape + cancellation

        ┌─ for turn = 0 .. maxTurns ──────────────────────┐
        │  signal.throwIfAborted()   ← caller can stop here │
        │  budgetSpent = toolCalls >= maxToolCalls          │
        │  forceFinal = lastTurn OR budgetSpent             │
        │       │                                           │
        │  if forceFinal: strip tools, add synthesis nudge  │ ← the escape
        │  call model                                       │
        │  no tool calls? → finalText, break                │
        │  else run tools, loop                             │
        └───────────────────────────────────────────────────┘
```

Named by what breaks if each part is removed:
- **`maxTurns` / `maxToolCalls`** — remove the budget and a model that keeps emitting tool calls loops forever, burning tokens and never returning. This is the non-termination bug the budget exists to kill.
- **The forced synthesis turn** — remove it and the loop *terminates* at the budget but returns empty or half-finished text, because the model's last act was asking for more data, not answering. This is the most-forgotten part and the most load-bearing.
- **`signal.throwIfAborted()`** — remove it and a cancelled request keeps running to completion anyway, wasting work and (worse) the model spend the caller tried to stop.

### Move 2 — the three mechanisms, walked

**The iteration budget — two ceilings, checked every turn.** The loop computes whether the budget is spent on each pass:

```ts
// packages/runtime/src/run-agent-loop.ts:98-109
for (let turn = 0; turn < maxTurns; turn += 1) {       // ceiling 1: turns
  signal?.throwIfAborted();
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // ceiling 2
  const forceFinal = turn === maxTurns - 1 || budgetSpent;
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,        // ← tools STRIPPED on final
    maxTokens,
    signal,
  });
```

Each agent picks its own numbers: rag-query `6/4` (`rag-query-agent.ts:75-76`), query and monitoring `8/6` (`query-agent.ts:94-95`, `monitoring-agent.ts:76-77`), recommendation `6/4`, rubric `6/3`. Two independent ceilings: even if `maxTurns` isn't reached, hitting `maxToolCalls` flips `forceFinal`. The loop *cannot* run past `maxTurns` iterations, full stop.

**The forced synthesis turn — the escape that produces an answer.** This is the mechanic to spotlight. When `forceFinal` is true, two things change in the model call: `tools: forceFinal ? undefined : toolSchemas` *removes the tools entirely*, and the system prompt gets the synthesis instruction appended. The model literally cannot call a tool — there are none in the request — so it must produce text.

```ts
// packages/runtime/src/run-agent-loop.ts:72-74  (the nudge)
export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}
// rag-query-agent.ts:77-79 supplies the middle:
//   'Now answer the question directly and concisely, citing the sources you retrieved.'
```

```
  Execution trace — the budget driving to a forced answer (rag-query, maxToolCalls 4)

  turn 0:  forceFinal? no  → tools offered → model calls search (toolCalls=1)
  turn 1:  forceFinal? no  → tools offered → model calls search (toolCalls=2)
  turn 2:  forceFinal? no  → model calls search (toolCalls=3)
  turn 3:  forceFinal? no  → model calls search (toolCalls=4)
  turn 4:  budgetSpent! (4>=4) → forceFinal → tools STRIPPED + synthesis nudge
           → model has no tools → MUST answer → finalText, loop ends
```

This is why the budget is safe to set low: hitting it doesn't fail, it *forces a grounded answer from what's already retrieved*. The belt-and-suspenders backup is the recovery turn (`run-agent-loop.ts:192-228`): if `parseResult` still returns null after the loop, one more isolated call runs with a "conclude now, output only the structured answer" system prompt. Two layers ensuring the loop always yields something usable.

**Cooperative cancellation — the signal threaded end to end.** A caller passes an `AbortSignal`; aptkit checks it at every await boundary so a cancel takes effect promptly instead of after the current model call finishes.

```
  Layers-and-hops — the AbortSignal threaded through one turn

  ┌─ caller ─────────┐  passes signal
  │  controller.abort()│ ───────────────────────────────────────┐
  └───────────────────┘                                         │
  ┌─ runAgentLoop ───┐  throwIfAborted() at loop top (:99) ◄─────┤
  │  await model ─────┼─► provider: throwIfAborted() (gemma :53,:63)
  │                   │   fallback :52 · context-guard :58       │
  │  await callTool ──┼─► registry: throwIfAborted() (:55) ──────┤
  │                   │   embedder: throwIfAborted() (:51)        │
  └───────────────────┘   ndjson stream: throwIfAborted() (:112,:123)
```

The pattern is uniform: `signal?.throwIfAborted()` at the top of the turn loop (`run-agent-loop.ts:99`), again inside every provider before and after the network call, inside the tool registry, the embedder, and the NDJSON decoder. The signal is even *forwarded into `fetch`* (`gemma-provider.ts:73`, `ollama-embedding-provider.ts:55`), so an abort tears down the in-flight HTTP request itself, not just the JS loop around it. And abort is distinguished from real failures: the fallback provider re-throws an abort instead of trying the next provider (`fallback-provider.ts:65`), and structured-generation re-throws it instead of returning a failure result (`structured-generation.ts:76`). That's correct — a cancellation isn't a provider failure to recover from.

**The gaps — backpressure and shutdown.** Here's the honest part:

```
  Comparison — what's bounded vs. what isn't

  BOUNDED (within a run)              NOT BOUNDED (across runs / lifetime)
  ─────────────────────               ────────────────────────────────────
  maxTurns ≤ 8           ┐            concurrency limiter      → none
  maxToolCalls           ├ present     queue / backpressure     → none
  forced synthesis turn  │            SIGTERM/SIGINT handler   → none
  AbortSignal everywhere ┘            in-flight drain on stop   → none
```

There is **no concurrency limiter and no queue** — nothing stops a caller from launching arbitrarily many `runAgentLoop`s at once, each opening its own Ollama `fetch`. Backpressure (slowing intake when downstream is saturated) is `not yet exercised`. And there is **no `SIGTERM`/`SIGINT` handler** in any product package — on process stop, in-flight runs are killed mid-await with no draining. Both gaps are real, and both are deliberate: aptkit doesn't own the process or the request dispatch, so the limiter, the queue, and the shutdown handler belong to the consumer (buffr). The cancellation primitive aptkit *does* provide (`AbortSignal`) is exactly the hook a graceful shutdown would use — buffr would abort in-flight signals on `SIGTERM`. aptkit built the cooperative half; the process-owning half is buffr's.

### Move 3 — the principle

Any loop driven by a model needs a hard budget *and* a defined terminal behavior — the budget alone prevents non-termination, but only the forced-final turn turns "budget hit" into "useful answer." That's the transferable lesson: bounding work isn't just "stop at N," it's "stop at N *with a plan for what to return*." And cancellation should be cooperative and pervasive — a signal checked at every await — so it's prompt and so it tears down I/O, not just JS. The backpressure and shutdown gaps teach the inverse: a library bounds *its own* work but can't bound the *system's* work or own the process; those bounds live with whoever owns the lifecycle.

## Primary diagram

```
  Bounded work and cancellation in aptkit — complete

  ┌─ runAgentLoop (the bounding kernel) ──────────────────────────┐
  │  for turn 0..maxTurns:                                         │
  │    signal.throwIfAborted()  ◄── caller cancels (cooperative)   │
  │    budgetSpent = toolCalls >= maxToolCalls                     │
  │    forceFinal  = lastTurn OR budgetSpent                       │
  │       │                                                        │
  │    forceFinal → STRIP tools + synthesis nudge → model MUST     │
  │                 answer ──────────────────────► finalText       │
  │    else → run tools, loop                                      │
  │  (+ recovery turn if parse still fails)                        │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ signal forwarded into fetch
                          ┌────────▼─────────┐
                          │ Ollama (abort     │  in-flight request torn down
                          │ tears down socket)│
                          └───────────────────┘

  NOT IN APTKIT (consumer/buffr's job): concurrency limiter,
  queue/backpressure, SIGTERM handler, in-flight drain.   ← not yet exercised
```

## Elaborate

The bounded agent loop with a forced synthesis turn is the canonical safe shape for any LLM-driven control flow — it's the agent-systems version of "never write `while(true)` without a break condition you can prove is reached." The forced-final turn is the part most implementations forget, and it's why naively-built agents either loop forever or return half-thoughts. Cancellation via `AbortSignal` is the web-platform standard (the same object that cancels a `fetch` or a DOM event listener), threaded here through the whole call tree the way `context.Context` is in Go — a single token that propagates "stop now" everywhere. The missing pieces — a limiter (think a semaphore capping concurrent runs), a queue with backpressure, and a `SIGTERM` drain — are exactly the operational scaffolding a *service* adds around a library; their absence is the correct boundary for aptkit and the correct to-do for buffr. → `study-distributed-systems` for partial-failure handling across runs, `study-performance-engineering` for where a limiter protects throughput.

## Interview defense

**Q: What stops aptkit's agent loop from running forever?**
Two hard ceilings checked every turn — `maxTurns` (≤ 8) and `maxToolCalls` — plus a forced synthesis turn. When either budget is hit, the loop strips the tools out of the model request and appends a "you have no more tool calls, answer now" instruction, so the model *can't* ask for more data and must produce a grounded answer. The budget prevents non-termination; the forced turn makes termination *useful*.

```
  budget hit → strip tools + synthesis nudge → model must answer (not error out)
```
*Anchor: bounding work means "stop at N *with a plan for what to return*," not just "stop."*

**Q: How does cancellation work, and what's missing?**
Cooperative `AbortSignal`, threaded through every await — the loop, every provider, the tool registry, the embedder, the NDJSON stream — and forwarded into the `fetch` itself, so an abort tears down the live HTTP request. Aborts are distinguished from failures (the fallback chain re-throws them instead of retrying). What's missing: no `SIGTERM` handler and no concurrency limiter or queue. Those are deliberate — aptkit is a library and doesn't own the process or the dispatch; buffr does, and it'd use aptkit's `AbortSignal` to drain in-flight runs on shutdown.

## See also

- `01-runtime-map.md` — why aptkit doesn't own the process (the root of both gaps)
- `02-processes-threads-and-tasks.md` — the task fan-out a limiter would bound
- `03-event-loop-and-async-io.md` — the awaits where the signal is checked
- `study-distributed-systems` — partial failure and coordination across runs
- `study-performance-engineering` — throughput and where a limiter protects it
