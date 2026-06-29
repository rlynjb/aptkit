# The CapabilityEvent trace

*Industry names: structured event log · application-level tracing · the "trace" in observability. Type: project-specific (a discriminated-union event stream).*

## Zoom out — where this lives

This is the spine. Everything else in this guide is a *reader* of the thing built here. Before you can debug an aptkit agent, you have to know that there's exactly one channel its behavior flows through.

```
  Zoom out — the event spine and its readers

  ┌─ Runtime layer (packages/runtime) ──────────────────────────────┐
  │   ★ CapabilityEvent + runAgentLoop emits it ★   ← we are here   │
  │   events.ts:1-24        run-agent-loop.ts:112-179               │
  └───────────────────────────┬─────────────────────────────────────┘
                              │  one CapabilityEvent[] stream
        ┌─────────────────────┼─────────────────────────┐
        ▼                     ▼                         ▼
  ┌─ Studio UI ──┐   ┌─ buffr / Storage ───┐   ┌─ Runtime (derived) ─┐
  │ TracePanel   │   │ SupabaseTraceSink    │   │ summarizeUsage()    │
  │ visual replay│   │ → Postgres rows      │   │ tokens + cost       │
  └──────────────┘   └──────────────────────┘   └─────────────────────┘
```

The agent loop doesn't log. It doesn't `console.log("calling tool X")`. It emits a typed event and moves on. That single design choice is why one array can power a visual debugger, a durable audit log, and a cost ledger without any of them knowing about the others.

## Zoom in — what it is

A `CapabilityEvent` is one typed record describing one consequential moment in an agent run: a model turn finished, the assistant said something, a tool started, a tool ended, tokens were spent, something went wrong. The agent loop emits a sequence of them; a `CapabilityTraceSink` consumes them. That's the whole contract.

The question it answers: *what did the agent actually do, in what order, with what inputs and outputs?* — which is the only question that matters when an agent misbehaves, because the bug is almost always a decision the model made mid-run.

## How it works

### Move 1 — the mental model

You already know the shape of this: it's a Redux action log. Each action is a plain typed object with a discriminating `type` field, you append them to an array as things happen, and later you can replay the array to reconstruct exactly what occurred. A `CapabilityEvent` is that action; the trace is the action log; the sinks are the subscribers.

```
  The pattern — append-only typed event stream

  agent loop running...
     │  turn finishes        ──► emit { type:'model_usage', ... }   ┐
     │  assistant text       ──► emit { type:'step', ... }          │
     │  tool starts          ──► emit { type:'tool_call_start',... }├─► sink.emit()
     │  tool ends            ──► emit { type:'tool_call_end', ... } │   (one at a time,
     │  recovery fails       ──► emit { type:'warning', ... }       │    in order)
     ▼                                                              ┘
  every event carries: type · capabilityId · timestamp
```

The reader paraphrases this six weeks later as: *one append-only list of typed records, every record stamped with who emitted it and when.*

### Move 2 — the load-bearing skeleton

This pattern has a real kernel. Strip it to the irreducible core and name each part by what breaks without it.

**Part 1 — the discriminated union (the `type` tag).** Every event is one of six shapes, distinguished by a string `type`. Here's the actual definition, `packages/runtime/src/events.ts:1-24`:

```ts
export type CapabilityEvent =
  | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
  | { type: 'tool_call_start'; capabilityId: string; toolName: string; args: unknown; timestamp: string }
  | { type: 'tool_call_end'; capabilityId: string; toolName: string; result?: unknown;
      error?: string; durationMs: number; timestamp: string }
  | { type: 'model_usage'; capabilityId: string; provider: string; model: string;
      inputTokens?: number; outputTokens?: number; estimated?: boolean; timestamp: string }
  | { type: 'warning'; capabilityId: string; message: string; timestamp: string }
  | { type: 'error'; capabilityId: string; message: string; timestamp: string };
```

What breaks if you remove the `type` tag: every reader collapses. The Studio `TracePanel` branches on `event.type` (`components.tsx:312-320`); the SupabaseTraceSink `switch`es on it (`supabase-trace-sink.ts:56-84`); `summarizeUsage` filters on it (`usage-ledger.ts:28`). The tag is the join key between producer and three independent consumers. This is why it's a union and not six separate callbacks — *one* stream, narrowed at the reader.

**Part 2 — the sink contract (`emit`).** The loop never holds the trace. It calls a sink it was handed:

```ts
// events.ts:26-28
export type CapabilityTraceSink = {
  emit(event: CapabilityEvent): void;   // sync, returns void — fire and forget
};
```

What breaks without it: the loop would have to *be* the storage, and you couldn't swap an in-memory array (Studio) for a Postgres writer (buffr) without rewriting the loop. The sink is the seam. Note the signature — `emit` returns `void`, synchronously. A sink that needs to do async I/O (buffr's does) must queue internally and flush later; it cannot block the loop. That constraint shapes `03`.

**Part 3 — the emit points inside the loop.** The loop is where events are born. Walk the hot path, `packages/runtime/src/run-agent-loop.ts`:

```ts
// :111-122 — after every model.complete(), if usage came back:
if (response.usage) {
  trace?.emit({ type: 'model_usage', capabilityId, provider: model.id,
    model: response.model ?? model.defaultModel ?? 'unknown',
    inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens,
    estimated: response.usage.estimated, timestamp: timestamp() });
}
// :128 — assistant text becomes a step
if (text) trace?.emit({ type: 'step', capabilityId, role: 'assistant', content: text, timestamp: timestamp() });
// :147-153 — BEFORE the tool runs, record the ARGS (this is the line that solved the war story)
trace?.emit({ type: 'tool_call_start', capabilityId, toolName: toolUse.name,
  args: toolUse.input, timestamp: timestamp() });
// :171-179 — AFTER, record result OR error, plus how long it took
trace?.emit({ type: 'tool_call_end', capabilityId, toolName: toolUse.name,
  result: toolCall.result, error: toolCall.error, durationMs: toolCall.durationMs ?? 0,
  timestamp: timestamp() });
```

The boundary condition that everyone trips on: **`trace` is optional** (`trace?.emit`). Pass no sink and the loop runs identically but emits nothing — observability is opt-in, zero-cost when off. The flip side is the trap: if a caller forgets to pass a sink, the run is invisible and there's no warning that it is.

**Part 4 — the timestamp (`timestamp()`).** Every event is stamped at emit time with `new Date().toISOString()` (`events.ts:30-32`).

What breaks without it: ordering. In-memory (Studio) the array order is already correct, so the timestamp looks redundant. But the moment a sink writes asynchronously to a database — buffr fires N concurrent inserts — the *insert* order races, and only the emit-time timestamp recovers the true sequence (`supabase-trace-sink.ts:27-37` persists it into `created_at`). The timestamp is load-bearing precisely because of the async sink contract in Part 2.

#### Optional hardening (not the skeleton)

- **NDJSON serialization + a runtime guard.** `encodeCapabilityEvent` (`ndjson-stream.ts:36`) writes one event per line; `isCapabilityEvent` (`:41-62`) validates a decoded record matches the union before trusting it. This is what lets the trace cross a wire (Studio streams it from a Vite middleware) and survive a corrupt line. Not the kernel — the kernel is the in-process emit — but the hardening that makes the stream durable.
- **16k truncation** of tool results (`run-agent-loop.ts:52-57`) keeps one giant result from bloating the message history. A guard, not the kernel.

### Move 3 — the principle

**Make behavior a typed value, not a side effect.** A `console.log` is a side effect — it goes to one place, in one format, and you can't re-read it as data. A `CapabilityEvent` is a value: it's typed, it's appendable, it's serializable, and *every consumer narrows the same stream to its own need*. The instant your behavior is a value instead of a print statement, observability stops being something you bolt on and becomes something you read. That's the whole move, and it's why this codebase has no logger.

## Primary diagram

The full spine, every box and hop labelled.

```
  CapabilityEvent trace — producer, contract, three consumers

  ┌─ Runtime: runAgentLoop (run-agent-loop.ts) ───────────────────────────┐
  │  for each turn:                                                        │
  │    model.complete() ─► emit model_usage (:112) ─► emit step (:128)     │
  │    for each tool_use:                                                  │
  │      emit tool_call_start{args} (:147) ─► run tool ─► emit             │
  │      tool_call_end{result|error, durationMs} (:171)                    │
  └──────────────────────────────┬────────────────────────────────────────┘
                                 │ sink.emit(event)   [CapabilityTraceSink, void]
       ┌──────────────────────────┼───────────────────────────────┐
       ▼                          ▼                               ▼
  ┌─ apps/studio ────┐  ┌─ buffr (Postgres) ──────┐  ┌─ runtime/usage-ledger ─┐
  │ in-memory array  │  │ queue → flush() → rows   │  │ summarizeUsage(trace)  │
  │ TracePanel render│  │ agents.messages, ordered │  │ tokens, turns, cost    │
  │ (02)             │  │ by event timestamp (03)  │  │ (06)                   │
  └──────────────────┘  └──────────────────────────┘  └────────────────────────┘
```

## Elaborate

The discriminated-union-as-event-log is older than observability tooling — it's the shape of Redux actions, of event sourcing, of the Elm architecture, of any CQRS read model. What aptkit does is recognize that *an agent run is a stream of events* in exactly the same way a UI session is, and reuse the pattern. The payoff is that the three readers were written independently, at different times, in different packages and even different repos (Studio in `apps/`, the sink in buffr), and none of them required touching the loop. That's the test of a good seam: new consumers cost nothing.

The interesting tension: this is *application-level* tracing, not *distributed* tracing. There's no `traceId` to stitch a request across services because there's only one service. When buffr grows into a multi-user server, the missing field is exactly `traceId` — and adding it is a one-field extension to the union, propagated through the same `emit` calls. The pattern doesn't have to change; the schema grows.

## Interview defense

**Q: How does your agent loop do observability without a logging library?**

It emits a typed event stream instead of logging. One discriminated union, `CapabilityEvent`, with six variants — step, tool_call_start, tool_call_end, model_usage, warning, error. The loop calls `sink.emit(event)` at each consequential point and never holds the events itself.

```
  loop ──emit(typed event)──► sink (an interface)
                                │
              ┌─────────────────┼─────────────┐
              ▼                 ▼             ▼
          visual UI        Postgres       cost ledger
```

One-line anchor: *behavior is a typed value on one stream, not a side effect — so every consumer narrows the same stream to its own need.*

**Q: What's the part people forget?**

The timestamp on every event. In memory it looks redundant — array order is already right. But the sink contract makes `emit` synchronous and `void`, so a durable sink has to write asynchronously, and concurrent inserts race. The emit-time ISO timestamp is the only thing that recovers true order. Forget it and your durable trajectory replays out of order. That's the load-bearing detail that proves you built it.

## See also

- `02-trace-replay-as-debugger.md` — the Studio consumer (visual).
- `03-persisted-trajectory-backward-read.md` — the buffr consumer (durable) and why the timestamp matters.
- `06-model-usage-accounting.md` — the derived consumer (cost).
- `04-silent-empty-result-blind-spot.md` — the one boundary that *doesn't* emit.
