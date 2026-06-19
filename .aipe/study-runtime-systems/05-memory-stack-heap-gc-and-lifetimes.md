# 05 — Memory: Stack, Heap, GC, and Lifetimes

**Industry name:** memory model / allocation + garbage collection · *Industry standard*

## Zoom out, then zoom in

Where does the memory a run touches live, how long does it live, and what bounds its growth? This concept sits at the runtime layer, under every allocation the agent loop makes.

```
  Zoom out — where a run's memory lives

  ┌─ Application layer ──────────────────────────────────────────┐
  │  runAgentLoop allocates: messages[], toolCalls[], strings     │
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Runtime layer (V8) ─────▼───────────────────────────────────┐
  │  ★ stack (call frames) + heap (objects) + GC ★               │ ← we are here
  │     no manual free; lifetimes = reachability                 │
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Bounds layer ───────────▼───────────────────────────────────┐
  │  MAX_TOOL_RESULT_CHARS, maxTokens, maxTurns cap the growth   │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: in a manual-memory language you ask "who frees this?" In V8 you ask a different question — "what keeps this *reachable*?" Memory lives as long as something references it; when the last reference drops, GC reclaims it on its own schedule. For AptKit the interesting question isn't *whether* memory is freed (it always is, eventually) but *how big the live set gets during a run* — and that's governed by the same budgets that bound the loop. Memory pressure here is the `messages` array growing each turn, capped by `maxTurns` and `MAX_TOOL_RESULT_CHARS`.

## Structure pass

**Layers.** Application allocations → V8 stack/heap → the budgets that bound them.

**Axis — "what determines this memory's lifetime?"**

```
  One question down the layers: "when is this reclaimed?"

  ┌─ stack (call frames) ───────┐  when the function returns
  │  turn, response, toolUses   │  (or the await resumes past it)
  └──────────────┬───────────────┘
       ┌─────────▼──────────────────┐ when no longer reachable —
       │  heap (messages[], strings) │ i.e. when the run completes
       └─────────┬──────────────────┘ and the closure is dropped
           ┌─────▼────────────────────┐ never auto-grows past the
           │  bounded by budgets       │ budget: maxTurns × capped tool result
           └──────────────────────────┘
```

The lifetime answer sharpens as you descend: stack frames die at return, heap objects die at unreachability, and the *total* a run can hold is capped by budgets. That last point is the one that matters — without the caps, a runaway agent could grow `messages` without bound.

**Seams.** The seam is the `await` inside a long-lived loop: across an `await`, the function's locals (and the closure holding `messages`) stay alive on the heap because the suspended continuation references them. A run that's parked at `await model.complete()` is holding its entire `messages` history live. The bound on that history is the load-bearing detail.

## How it works

### Move 1 — the mental model

You know that a React component's state lives as long as the component is mounted, and gets GC'd after unmount when nothing references it. A run's `messages` array is the same: it lives as long as the `runAgentLoop` invocation is on the stack (or suspended at an await), and is reclaimed once the function returns and the closure is dropped. Strategy: **reachability-based lifetimes + budget-bounded growth.**

```
  The memory kernel — growth per turn, bounded by budgets

  turn 0:  messages = [user]                          ← small
  turn 1:  messages = [user, assistant, toolResults]  ← grows
  turn 2:  messages = [..., assistant, toolResults]   ← grows
   ...                                                 (each tool result
  turn N:  capped at maxTurns turns                     truncated to 16KB)
       │
       └─ peak live set ≈ maxTurns × (assistant text + Σ capped tool results)
          GC reclaims it all once runAgentLoop returns
```

### Move 2 — walking the mechanism

**The stack holds the call frames; it's shallow here.** `runAgentLoop` → `model.complete` → SDK is a handful of frames deep. There's no deep recursion (the loop is iterative `for`, not recursive). The recovery path (`runRecoveryTurn`) adds one more frame, not a recursive descent. No stack-overflow risk.

**The heap holds the long-lived objects — chiefly the `messages` array.** Each turn appends an assistant message and a user message of tool results. This array is the dominant allocation and the thing that grows. It lives on the heap, referenced by the running (or suspended) `runAgentLoop` closure.

```
  Heap growth per turn — what gets appended

  messages.push({ role: 'assistant', content: response.content }) ← per turn
  messages.push({ role: 'user', content: toolResults })           ← per turn
       │
       └─ each toolResult.content is truncate(JSON.stringify(result)),
          capped at MAX_TOOL_RESULT_CHARS = 16_000 chars, so one tool
          result can't balloon the array with a megabyte payload
```

**Truncation is the memory bound on a single tool result.** Without `truncate`, a tool returning a 10MB JSON blob would put 10MB into `messages`, then re-send it to the model every subsequent turn (cost *and* memory). The 16KB cap means each tool result contributes at most ~16KB to the live set, and the synchronous `JSON.stringify` that produces it also stays cheap (ties back to `03`: short synchronous spans).

```
  Without vs with the truncation bound

  no cap:   tool returns 10MB ─► messages holds 10MB ─► resent every turn
  16KB cap: tool returns 10MB ─► truncate to 16KB ─► messages holds 16KB
            "...[truncated]" appended so the model knows it was cut
```

**GC reclaims the run's memory when it returns.** Once `runAgentLoop` resolves its `AgentRunResult`, the `messages` array, the `toolCalls` records, and all intermediate strings become unreachable (the caller keeps only the small result). V8's generational GC collects them. There's no manual free, no object pool, no `Buffer` reuse — and at this scale none is needed.

**The streaming path keeps almost nothing live.** `decodeNdjsonStream` holds only a `buffer` string of the current partial line, not the whole stream. As records are yielded and consumed, prior chunks are GC'd. This is the opposite of buffering the entire response — memory stays flat regardless of stream length.

```
  Streaming memory — flat, not proportional to stream size

  buffer holds: only the bytes since the last newline
  yield record ─► consumer uses it ─► record GC'd
       │
       └─ a 10,000-event stream never holds 10,000 events in memory at once;
          peak ≈ one partial line + one record
```

### Move 3 — the principle

In a GC runtime, memory management *is* lifetime management: you don't free, you drop references and let growth be bounded by design. The two bounds that keep AptKit's live set small are the same ones from the loop — `maxTurns` caps how many messages accumulate, `MAX_TOOL_RESULT_CHARS` caps how big each one gets — plus the streaming decoder that refuses to hold the whole stream. The discipline isn't "free memory"; it's "bound what stays reachable."

## Primary diagram

```
  Memory lifetimes — stack, heap, bounds, GC

  ┌─ Stack (shallow, per-frame) ─────────────────────────────────┐
  │  runAgentLoop → model.complete → SDK  (handful of frames)    │
  │  locals: turn, response, toolUses — die when frame returns   │
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Heap (the live set) ────▼───────────────────────────────────┐
  │  messages[]  ── grows per turn, capped by maxTurns           │
  │  toolCalls[] ── one record per tool call                     │
  │  strings     ── each tool result capped at 16KB (truncate)   │
  │  stream buffer ── only current partial line (flat)           │
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Bounds + GC ────────────▼───────────────────────────────────┐
  │  peak ≈ maxTurns × (text + Σ 16KB results)                   │
  │  reclaimed when runAgentLoop returns (reachability drops)    │
  └───────────────────────────────────────────────────────────────┘
       NO manual free · NO object pool · NO Buffer reuse (none needed)
```

## Implementation in codebase

**Use cases.** You reason about memory when a long agent run worries you (it can't grow unbounded — `maxTurns` caps it), when a tool might return something huge (it's truncated to 16KB), or when streaming a long trace (the decoder stays flat). The context-window guard (`local`) is the explicit *pre-flight* check that the live message set won't exceed a token budget before even calling the model.

**Code side by side.**

The truncation bound on each tool result:

```
  packages/runtime/src/run-agent-loop.ts (lines 52–57, 162)

  const MAX_TOOL_RESULT_CHARS = 16_000;
  function truncate(value: string): string {
    if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
    return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`; ← marker so model knows
  }
  ...
  resultContent = truncate(JSON.stringify(result)); ← bounds heap + sync stringify cost
       │
       └─ without this, a fat tool result lives in messages AND is resent every
          turn — memory and token cost both blow up
```

The flat streaming buffer:

```
  packages/runtime/src/ndjson-stream.ts (lines 107–119)

  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });  ← holds only partial line(s)
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + newlineLength); ← consumed bytes dropped → GC
      yield decodeNdjsonLine(line, ...);
    }
  }
       │
       └─ buffer never accumulates the whole stream; peak memory is one partial line
```

The pre-flight memory/token guard:

```
  packages/providers/local/src/context-window-guard.ts (lines 57–70)

  async complete(request) {
    request.signal?.throwIfAborted();
    const estimate = estimateContextWindow(request, this.options); ← SYNC, before any I/O
    if (!estimate.ok) {
      this.options.trace?.emit({ type: 'warning', ... });
      throw new ContextWindowExceededError(estimate);  ← refuse rather than overflow
    }
    return this.provider.complete(request);
  }
       │
       └─ estimates input tokens from message char length (≈ chars/3) and refuses
          if it exceeds the local model's budget — a synchronous gate on the live set
```

## Elaborate

GC-managed memory is the default expectation for a TypeScript/Node engineer, so the interesting content here isn't "how does V8 GC work" (generational, mark-sweep) but "what bounds the live set" — and the answer is the budgets, which is why this file leans on `07`. The context-window guard is a neat artifact: it's a *synchronous, pre-flight* estimate (`estimateModelRequestTokens` sums message text and divides by `charsPerToken`) that gates the awaited call — bounding memory/cost *before* spending it. That pattern — estimate cheaply and synchronously, then decide whether to do the expensive async thing — generalizes well. `not yet exercised`: manual memory management, object pooling, arena/slab allocation, `Buffer` reuse, explicit GC tuning (`--max-old-space-size`). None present; the workload's live set is small and short-lived enough that V8 defaults are fine.

## Interview defense

**Q: "Can a long agent run grow memory without bound?"**

```
  messages grows per turn ──► bounded by maxTurns (≤ 8, recommendation 6)
  each tool result        ──► bounded by MAX_TOOL_RESULT_CHARS (16KB)
  peak live set           ──► maxTurns × (text + Σ 16KB) — finite
  reclaimed               ──► when runAgentLoop returns
```

Answer: "No. Two independent bounds cap it: `maxTurns` limits how many message rounds accumulate, and `MAX_TOOL_RESULT_CHARS` truncates each tool result to 16KB so one fat payload can't balloon the array. It's reclaimed by GC when the run returns." Anchor: `run-agent-loop.ts:52,87,162`. The part people forget: the same truncation that bounds memory also bounds the *resent* token cost every subsequent turn.

**Q: "Does streaming a 10k-event trace hold 10k events in memory?"** No — `decodeNdjsonStream` holds only the current partial line; consumed records are dropped and GC'd. Peak is ~one line. Anchor: `ndjson-stream.ts:108,119`.

## Validate

1. **Reconstruct:** Sketch `messages` growth across turns and mark the two bounds (`maxTurns`, 16KB truncate).
2. **Explain:** Why is the streaming buffer flat regardless of stream length? (Consumed bytes are sliced off and become unreachable — `ndjson-stream.ts:119`.)
3. **Apply:** A tool returns 5MB of JSON. How much lands in `messages`, and what's the second cost avoided? (~16KB; avoids resending 5MB every turn — `run-agent-loop.ts:162`.)
4. **Defend:** Explain why the context guard checks token estimate *synchronously before* the await, and what it buys (`context-window-guard.ts:57–68`).

## See also

- `03-event-loop-and-async-io.md` — why a suspended-at-await closure stays live.
- `07-backpressure-bounded-work-and-cancellation.md` — the budgets that bound the live set.
- `.aipe/study-performance-engineering/` *(when generated)* — measuring the live set and token cost.
