# The structured event log (the `CapabilityEvent` trace)

**Industry name(s):** structured event log / event-sourced trace / structured
logging. **Type:** Industry standard (the event-source-the-execution pattern;
the local shape is project-specific).

## Zoom out, then zoom in

Every other observability mechanism in this repo hangs off one thing: a typed
stream of events the agent loop emits as it runs. Studio renders it, buffr
persists it, the cost ledger sums it. Before any of that, it's just a loop
writing structured records.

```
  Zoom out — where the trace lives

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  runAgentLoop()  ──emits──►  ★ CapabilityEvent stream ★      │ ← we are here
  │  run-agent-loop.ts            (events.ts)                    │
  └───────────────────────────────────┬──────────────────────────┘
                                       │ trace.emit(event)
                                       │ (CapabilityTraceSink interface)
        ┌──────────────────────────────┼──────────────────────────┐
        ▼                               ▼                          ▼
  ┌─ UI (Studio) ─┐            ┌─ Cost ledger ─┐         ┌─ Storage (buffr) ─┐
  │ TracePanel    │            │ summarizeUsage │         │ SupabaseTraceSink  │
  └───────────────┘            └────────────────┘         └───────────────────┘
```

Zoom in: the thing in the starred box is a discriminated union — six event
shapes that together describe everything the agent did. It answers one
question: *what happened, in what order, with what data?* That's the entire job
of an event log. Get this right and the consumers are trivial; get it wrong and
no amount of dashboards saves you.

## The structure pass

**Layers.** Two: the *emitter* (the loop, which decides what's worth recording)
and the *sink* (whatever consumes events, behind one interface). They never know
each other's identity.

**Axis — trace it on `control`: who decides what gets observed?**

```
  One question down the layers: "who decides what's recorded?"

  ┌─────────────────────────────────────┐
  │ emitter: runAgentLoop                │  → THE LOOP decides
  │   chooses which boundaries emit      │    (instrumentation points
  └──────────────────┬───────────────────┘     are baked into the loop)
                     │  trace.emit(event)
  ┌──────────────────▼───────────────────┐
  │ sink: CapabilityTraceSink.emit()     │  → THE SINK decides
  │   chooses what to DO with each event │    (render? persist? drop?)
  └──────────────────────────────────────┘

  the answer flips at the interface — that flip IS the seam
```

**Seam.** The `CapabilityTraceSink` interface (`events.ts:26-28`). On the
emitter's side, control over *what is observable* is fixed in the loop. On the
sink's side, control over *what observation means* is open — a sink can render,
persist, count, or no-op. The axis (who controls behavior) flips across this
boundary, which is exactly what makes it the load-bearing seam: you swap the
entire observability backend by passing a different `trace` object, and the loop
doesn't change one line.

## How it works

### Move 1 — the mental model

You already know event sourcing in miniature: a Redux store doesn't store the
current screen, it stores the *actions* that produced it, and you can replay
them to rebuild any state. Same idea here. The loop doesn't store "the agent's
final state" — it emits the *events* that produced it, in order, and any
consumer rebuilds whatever view it wants from that stream.

```
  The pattern — emit an ordered event stream, rebuild views from it

      runAgentLoop turn
   ┌────────────────────────────────────┐
   │  model.complete() ──► response      │
   │       │                             │
   │       ├─emit─► model_usage  (tokens)│
   │       ├─emit─► step         (text)  │
   │       └─for each tool_use:          │
   │            emit─► tool_call_start   │
   │            run tool                 │
   │            emit─► tool_call_end     │
   └────────────────────────────────────┘
              │  append-only, in emit order
              ▼
   [ model_usage, step, tool_call_start, tool_call_end, model_usage, step, ... ]
              │
       any consumer folds this stream into its own view
   (UI tree │ token sum │ Postgres rows) — none mutate it
```

The stream is append-only and ordered. That ordering is the whole reason
backward root-cause analysis works (see `04`). Lose the order and you lose the
causal chain.

### Move 2 — the step-by-step walkthrough

**The event union — six shapes, one discriminant.** The trace is a TypeScript
discriminated union. Each member has a `type` literal that tells a consumer
which fields are present. This is the searchable-fields property of structured
logging, enforced by the compiler.

```typescript
// packages/runtime/src/events.ts:1-24
export type CapabilityEvent =
  | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
  | { type: 'tool_call_start'; capabilityId: string; toolName: string; args: unknown; timestamp: string }
  | { type: 'tool_call_end'; capabilityId: string; toolName: string;
      result?: unknown; error?: string; durationMs: number; timestamp: string }
  | { type: 'model_usage'; capabilityId: string; provider: string; model: string;
      inputTokens?: number; outputTokens?: number; estimated?: boolean; timestamp: string }
  | { type: 'warning'; capabilityId: string; message: string; timestamp: string }
  | { type: 'error'; capabilityId: string; message: string; timestamp: string };
```

Read the shared fields first: **every** event carries `capabilityId` (which run
is this?) and `timestamp` (when, as an ISO string). Those two are the
correlation and ordering keys. Then each variant adds its own payload — a
`step` carries `content`, a `tool_call_start` carries `args` (the *cause* of a
tool's behavior), a `tool_call_end` carries `result`, `error`, and `durationMs`
(the *effect* plus latency). The `args`/`result` split across start and end
events is deliberate: it's what lets you see what a tool was *asked* versus what
it *returned* — the heart of the war story.

**The sink interface — one method.** A consumer is anything with an `emit`:

```typescript
// packages/runtime/src/events.ts:26-32
export type CapabilityTraceSink = {
  emit(event: CapabilityEvent): void;
};
export function timestamp(): string {
  return new Date().toISOString();
}
```

`emit` returns `void` and is synchronous — that's a contract the emitter relies
on (the loop never awaits a sink). buffr's durable sink works around that by
queuing writes and awaiting them in a separate `flush()` after the run (see
`03`). The `timestamp()` helper is shared so every event uses the same ISO
format.

**Where the loop emits — the instrumentation points.** The loop decides what's
observable by calling `trace?.emit(...)` at fixed boundaries. The `?.` is load-
bearing: `trace` is optional, so an uninstrumented run is legal and free.

```typescript
// packages/runtime/src/run-agent-loop.ts — the four emission points per turn
// 1. after every model turn that reports usage (111-122)
if (response.usage) {
  trace?.emit({ type: 'model_usage', capabilityId, provider: model.id,
    model: response.model ?? model.defaultModel ?? 'unknown',
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    estimated: response.usage.estimated, timestamp: timestamp() });
}
// 2. when the assistant produces text (127-129)
if (text) trace?.emit({ type: 'step', capabilityId, role: 'assistant', content: text, timestamp: timestamp() });
// 3. before a tool runs — captures the ARGS (147-153)
trace?.emit({ type: 'tool_call_start', capabilityId, toolName: toolUse.name,
  args: toolUse.input, timestamp: timestamp() });
// 4. after a tool runs — captures result, error, durationMs (171-179)
trace?.emit({ type: 'tool_call_end', capabilityId, toolName: toolUse.name,
  result: toolCall.result, error: toolCall.error,
  durationMs: toolCall.durationMs ?? 0, timestamp: timestamp() });
```

Notice point 3 fires *before* the tool runs and point 4 *after*. The args are
recorded even if the tool then throws — which is why a hallucinated filter is
visible in the trace even though it produced an empty (not error) result.

### Move 2 variant — the load-bearing skeleton

Strip the trace to its irreducible kernel and name each part by what breaks
without it:

```
  Kernel of a structured event log

  1. discriminated event type   ── what happened, machine-readable
  2. ordering key (timestamp)   ── what happened WHEN / in what order
  3. correlation key (capabilityId) ── which run this belongs to
  4. a sink interface           ── decouples "record" from "do something with it"
```

- **Drop the discriminant** and consumers can't tell a `step` from a `warning`
  without parsing prose — you've reinvented unstructured logs.
- **Drop the ordering key** and backward root-cause analysis dies; you can't
  reconstruct the causal chain, only the unordered bag of what happened.
- **Drop the correlation key** and two concurrent runs interleave into noise.
- **Drop the sink interface** and the loop is welded to one backend — no swap
  between dev-UI and Postgres, no free uninstrumented runs.

**Skeleton vs hardening.** The four above are the skeleton. Optional hardening
the repo adds on top: NDJSON serialization for streaming (`ndjson-stream.ts`),
the `estimated` flag on usage (honest about token estimates), and buffr's
queue-and-flush for async durability. None of those are the *pattern* — they're
production polish.

### Move 3 — the principle

Log *events*, not *messages*. A message (`"tool returned 0 results"`) is a
string a human reads once; an event (`{type:'tool_call_end', result:[], ...}`)
is a record a machine can render, sum, persist, query, and replay. The moment
your log is typed and ordered, the same stream serves debugging, cost
accounting, and durable audit with no extra plumbing — which is exactly why this
one mechanism is the entire observability story for the repo.

## Primary diagram

```
  The CapabilityEvent trace — full picture

  ┌─ Runtime layer: runAgentLoop (run-agent-loop.ts) ─────────────────────┐
  │                                                                       │
  │  for each turn (max maxTurns):                                        │
  │    model.complete()                                                   │
  │      ├─emit─► model_usage  {provider, model, in/outTokens, estimated} │
  │      └─emit─► step         {role:'assistant', content}                │
  │    for each tool_use in response:                                     │
  │      ├─emit─► tool_call_start {toolName, args}   ◄── the CAUSE        │
  │      │   run tool (try/catch)                                         │
  │      └─emit─► tool_call_end   {toolName, result, error, durationMs}   │
  │                                                  ◄── the EFFECT        │
  │  recovery turn fails ──emit─► warning {message}                       │
  │                                                                       │
  └───────────────────────────────┬───────────────────────────────────────┘
                                   │  CapabilityTraceSink.emit(event)   ── the seam
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                           ▼
  ┌─ Studio UI ──┐         ┌─ Usage ledger ──┐        ┌─ Storage (buffr) ──┐
  │ collect →    │         │ fold model_usage │        │ SupabaseTraceSink   │
  │ TracePanel   │         │ → token/cost     │        │ → agents.messages   │
  │ (visual tree)│         │ (per run)        │        │ (durable, queryable)│
  └──────────────┘         └──────────────────┘        └────────────────────┘
```

## Elaborate

Event sourcing comes out of accounting (a ledger is append-only events) and
arrived in software through CQRS and Kafka-style log architectures. The insight
the repo borrows is the cheap one: you don't need a log *broker* to get the
benefit — you need typed, ordered events and an interface to consume them. At
single-process scale that's a TypeScript union and a one-method interface, no
infrastructure.

The discriminated union is the TypeScript expression of a *tagged union* / *sum
type* — the same shape you'd write as an `enum`-keyed variant in Rust or a
sealed class hierarchy in Kotlin. If you've pattern-matched on a Redux action's
`type`, you've consumed exactly this shape.

Read next: `02-trace-fan-out-three-consumers.md` (the three readers),
`04-reading-the-trajectory-backward.md` (using the order for root cause).

## Interview defense

**Q: Why an event union instead of just calling a logger?**
A logger gives you strings; this gives you records. Because each event is typed
and ordered, the *same* stream drives a visual replay, a token-cost sum, and a
durable Postgres trail with zero extra code — the consumers just fold the stream
differently.

```
  one stream ──► [ render ] [ sum ] [ persist ]   ← three views, no replumbing
```

**Q: What's the one part people forget?**
The ordering key. People remember to type their events and forget the
`timestamp` is what makes the *causal chain* recoverable. Without ordering you
have an unordered bag of facts; with it you can read the trajectory backward
from the symptom to the cause — which is how the one real incident here got
solved. Anchor: `events.ts:1-24`, every variant carries `timestamp`.

**Q: Why is `emit` synchronous and `void`?**
So the hot loop never blocks on observation. A durable sink that needs async I/O
queues the write and flushes after the run (buffr's pattern) — the contract
keeps instrumentation off the critical path.

## See also

- `02-trace-fan-out-three-consumers.md` — the three sinks reading this stream.
- `03-durable-trajectory-supabase-sink.md` — the production reader.
- `05-deterministic-replay-reproduction.md` — the trace as a reproduction seed.
- `audit.md` lens 1, 3, 5 — observability map, structured logs, lifecycles.
