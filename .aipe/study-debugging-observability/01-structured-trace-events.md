# Structured trace events

*Industry name(s): structured event logging / typed telemetry / a discriminated-union
event stream. Type label: Industry standard (the AptKit shape is project-specific).*

## Zoom out, then zoom in

You know how a `fetch()` either resolves, rejects, or sits in a loading state, and you
can switch on which one happened? An agent run has the same idea, but with six states
instead of three, and it emits one every time something happens. That stream of typed
events is the entire observability story.

```
  Zoom out — where the trace event lives

  ┌─ Studio UI layer (apps/studio) ─────────────────────────────┐
  │  TracePanel · ProviderStatusPanel  ── render events          │
  └───────────────────────────────▲─────────────────────────────┘
                                   │  CapabilityEvent[]
  ┌─ Runtime layer (packages/runtime) ──────────────────────────┐
  │  runAgentLoop()  ──►  ★ trace.emit(CapabilityEvent) ★        │ ← we are here
  │                       events.ts: the typed union + sink      │
  └───────────────────────────────┬─────────────────────────────┘
                                   │  serialized
  ┌─ Persistence / transport ───────────────────────────────────┐
  │  NDJSON line  ·  artifact.trace[]  ·  derived metrics        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **discriminated union emitted through a sink interface.** One
type, `CapabilityEvent`, with an arm per kind of thing that can happen in a run. One
interface, `CapabilityTraceSink`, with a single `emit(event)` method. The agent loop
holds a reference to the sink and calls `emit` at every consequential moment. The
question it answers: *what did the agent do, in what order, at what cost?*

## The structure pass

**Layers.** Three: the *emitter* (the agent loop, which knows when things happen), the
*contract* (the event union + sink interface, which knows the shape), and the
*consumers* (metrics, NDJSON, UI, artifact — which read the shape without knowing how
it was produced).

**One axis — "who knows the event's shape?"** Trace it across the layers:

```
  axis = "who knows the shape of a trace event?"

  ┌─ emitter (run-agent-loop) ─┐  knows WHEN to emit, fills the fields
  │  trace?.emit({ type:... }) │
  └──────────────┬─────────────┘
                 │  seam: the CapabilityEvent union  ← shape is frozen here
  ┌─ consumers ──▼─────────────┐  know the SHAPE, not the emitter
  │ summarizeUsage / TracePanel│  switch on event.type
  └────────────────────────────┘
```

**The seam that matters: the `CapabilityEvent` union itself.** That's where the contract
lives. The emitter depends on the union's shape; every consumer depends on the union's
shape; neither depends on the other. Add a new consumer (a CSV exporter, a different
dashboard) and you touch nothing in the loop. Change the union and *everything* ripples
— which is exactly why the project context lists `CapabilityEvent` as a load-bearing
must-not-change contract. The sink interface is a second, smaller seam: `emit` is
fire-and-forget and synchronous, so the loop never awaits observability.

## How it works

### Move 1 — the mental model

The shape is a tagged union plus a one-method observer. Every event is an object whose
`type` field tells you which arm it is and therefore which other fields it carries.
The loop pushes events into a sink; the sink fans them out. That's it.

```
  The pattern — six-arm tagged union, one sink

         ┌──────────────────────────────────────────┐
         │            CapabilityEvent                 │
         │  type: 'step'           → role, content    │
         │  type: 'tool_call_start'→ toolName, args   │
         │  type: 'tool_call_end'  → toolName, result,│
         │                           error, durationMs│
         │  type: 'model_usage'    → provider, model, │
         │                           in/outTokens     │
         │  type: 'warning'        → message          │
         │  type: 'error'          → message          │
         │  (all arms)             → capabilityId, ts  │
         └─────────────────┬──────────────────────────┘
                           │  emit(event)
                    ┌──────▼──────┐
                    │ TraceSink   │  one method, fire-and-forget
                    └─────────────┘
```

The `type` field is the discriminant. Once you've narrowed on it, TypeScript (and you)
know exactly which fields exist. There's no "maybe it has a `durationMs`" — a
`tool_call_end` *always* has one, a `model_usage` *never* does.

### Move 2 — the walkthrough

**The common envelope: `capabilityId` + `timestamp`.** Every arm, no matter the type,
carries these two. `capabilityId` is the correlation key — it ties a burst of events to
one capability (`anomaly-monitoring-agent`, say). `timestamp` is an ISO string from a
single helper so the format never drifts. Bridge from what you know: it's like every
log line in a structured logger carrying the same `requestId` and `time` columns — the
fields you can always filter on. What breaks without them: you couldn't group events by
run, and you couldn't order or time them. They're the load-bearing part of the
envelope.

```
  Every event, regardless of type, carries the envelope

  { type: <discriminant>, capabilityId: "...", timestamp: "2026-...Z", ...arm-specific }
                                  │                    │
                          correlation key       ordering + latency
```

**The `model_usage` arm — the cost/turn signal.** Emitted once per model completion. It
carries `provider`, `model`, optional `inputTokens` / `outputTokens`, and an `estimated`
flag. This is the *only* arm the metrics layer reads. Bridge: think of it as the
"this turn cost N tokens" receipt printed after every model call. What breaks without
it: no token count, no cost estimate, no turn count — the entire metrics file goes dark.

**The `step` arm — the model's reasoning made visible.** Emitted whenever the model
produces assistant text. It carries `role` and `content`. This is how you read *what the
model decided* in plain language. Bridge: it's the assistant message bubble, captured.

**The `tool_call_start` / `tool_call_end` pair — the causal chain.** Start carries the
`args` the model chose; end carries the `result` (or `error`) and `durationMs`. They
bracket a tool execution. Bridge: a request log with a start line and a completion line
that includes the response and the latency. What breaks without the pair: you'd see the
model decide to call a tool but never learn what it got back — the causal chain snaps.

```
  Layers-and-hops — a tool call, bracketed by two events

  ┌─ agent loop ──┐  emit tool_call_start(args)   ┌─ trace sink ─┐
  │               │ ─────────────────────────────►│ event #1     │
  │ callTool(...) │                               └──────────────┘
  │      │        │
  │      ▼        │  callTool returns {result,     ┌──────────────┐
  │  tool exec    │  durationMs}                   │              │
  │      │        │  emit tool_call_end(result,    │ event #2     │
  │      ▼        │ ───── error?, durationMs) ─────►│ (has timing) │
  └───────────────┘                               └──────────────┘
```

**The `warning` / `error` arms — degradation and failure.** Both carry just a `message`.
`warning` is emitted by the fallback chain and the context guard (see
`05-degradation-warning-traces.md`); `error` is the terminal-failure arm. Bridge: the
`console.warn` / `console.error` of this system, except typed and in the same stream as
everything else, so a degradation event sits in causal order next to the tool call it
affected.

### Move 2 variant — the load-bearing skeleton

Strip `CapabilityEvent` to its irreducible core:

```
  the kernel:  discriminant (type) + correlation (capabilityId) + ordering (timestamp)
               + one arm per observable action
```

- **Drop the `type` discriminant** → consumers can't tell a tool call from a token
  receipt; the union collapses into untyped soup and every consumer needs runtime
  guesswork. (`isCapabilityEvent` in `ndjson-stream.ts` exists precisely to re-establish
  the discriminant after JSON round-trips lose the types.)
- **Drop `capabilityId`** → events can't be grouped by run/capability; correlation dies.
- **Drop `timestamp`** → no ordering across a serialized stream, no latency from deltas.
- **Drop an arm** → that action becomes invisible. Drop `tool_call_end` and you see
  tools start but never see what they returned.

**Skeleton vs hardening:** the union + envelope + sink is the skeleton. The `estimated`
flag on `model_usage`, the `error` field on `tool_call_end`, the 16k truncation upstream
— those are hardening. You could ship the pattern without them and still explain a run.

### Move 3 — the principle

The win isn't "logging." It's that **the observable surface of the system is a typed
contract, not a string.** Because every event is a known shape, every downstream use —
metrics, dashboard, snapshot, replay, secret-scan — reads structured fields instead of
parsing prose. A free-text log forces every consumer to re-parse; a typed event union
lets each consumer `switch` on `type` and trust the fields. That single decision is what
makes the rest of this guide possible.

## Primary diagram

The whole pattern, one frame: emitter on the left, the frozen union in the middle, the
fan-out of consumers on the right.

```
  Structured trace events — emit, contract, fan-out

  ┌─ Runtime: run-agent-loop.ts ──────┐
  │ each turn      → emit model_usage  │
  │ assistant text → emit step         │        ┌── summarizeUsage()  → tokens/cost
  │ tool start     → emit tool_call_*  │        │   (usage-ledger.ts)
  │ degradation    → emit warning      │        │
  │ failure        → emit error        │        ├── encodeCapabilityEvent() → NDJSON
  └───────────────┬────────────────────┘        │   (ndjson-stream.ts) → live UI
                  │ trace.emit(event)            │
                  ▼                              ├── artifact.trace[] → replay snapshot
        ┌───────────────────────────┐           │   (artifacts/replays/*.json)
        │ CapabilityTraceSink.emit() │ ──────────┤
        │ event: CapabilityEvent     │           └── isCapabilityEvent() guard
        │ (the frozen union, events.ts)           │   re-establishes types after JSON
        └─────────────────────────────┘
   Network / Provider boundary is crossed by the providers, which emit warning events
   into the SAME sink — degradation lands in causal order in the same stream.
```

## Implementation in codebase

**Use cases in this repo.** Every agent run emits this stream. The `AnomalyMonitoringAgent`,
`DiagnosticInvestigationAgent`, `QueryAgent`, `RecommendationAgent`, and
`RubricImprovementAgent` all receive a `trace` sink and pass it to `runAgentLoop`. Studio
renders the stream live in `TracePanel`; the eval CLI scans it; the artifact embeds it.
The single reason all of those work without per-agent observability code is that the
agent loop emits the events centrally.

**The union — `packages/runtime/src/events.ts:1-32`:**

```
  events.ts (lines 1-32)

  export type CapabilityEvent =
    | { type: 'step'; capabilityId; role; content; timestamp }      ← model reasoning
    | { type: 'tool_call_start'; capabilityId; toolName; args; ts }  ← chosen args
    | { type: 'tool_call_end'; ...; result?; error?; durationMs; ts} ← result + latency
    | { type: 'model_usage'; ...; inputTokens?; outputTokens?;       ← the cost receipt
        estimated?; ts }
    | { type: 'warning'; capabilityId; message; timestamp }          ← degradation
    | { type: 'error'; capabilityId; message; timestamp };           ← terminal failure

  export type CapabilityTraceSink = { emit(event: CapabilityEvent): void };  ← the seam

  export function timestamp(): string { return new Date().toISOString(); }   ← one source
        │
        └─ every arm shares capabilityId + timestamp; durationMs lives ONLY on
           tool_call_end; tokens live ONLY on model_usage. The discriminant (type)
           is what lets a consumer know which fields are present.
```

**The emit points — `packages/runtime/src/run-agent-loop.ts`:**

```
  run-agent-loop.ts — where each event is emitted

  :111  if (response.usage)                       ← only emit a receipt if usage exists
  :112    trace?.emit({ type: 'model_usage',      ← one per completion
            provider: model.id, model: ...,
            inputTokens, outputTokens, estimated, timestamp() });

  :127  if (text)                                 ← only emit a step if there was text
  :128    trace?.emit({ type: 'step', role: 'assistant', content: text, ... });

  :147  trace?.emit({ type: 'tool_call_start',    ← BEFORE the call, with the chosen args
          toolName: toolUse.name, args: toolUse.input, ... });
        ...
  :171  trace?.emit({ type: 'tool_call_end',      ← AFTER, with result/error + durationMs
          toolName, result: toolCall.result, error: toolCall.error,
          durationMs: toolCall.durationMs ?? 0, ... });
        │
        └─ trace is OPTIONAL (trace?.emit) — observability is never load-bearing for
           correctness. The loop runs identically with no sink attached; you just lose
           the evidence. That's the right coupling: emit is fire-and-forget.
```

The `?.` on every `trace?.emit` is the load-bearing detail to notice — the agent loop
treats observability as strictly additive. Remove the sink and the agent still produces
the same answer; you just can't see how.

## Elaborate

This pattern is the typed-event-log idea that structured loggers (`pino`, `bunyan`)
reach for, but pushed all the way into the type system. Most structured loggers emit a
JSON object with a `level` and arbitrary fields; AptKit instead fixes the *set* of event
shapes as a closed union, which is stronger: the compiler enforces that every consumer
handles every arm, and a malformed event can't typecheck. The cost is rigidity — adding
a new kind of event means editing the union and rippling through consumers (hence the
must-not-change contract). For a toolkit with one team and one process, that rigidity
buys correctness; for a sprawling service with many emitters, you'd want the looser
key/value shape so teams add fields independently. Read `04-live-trace-stream.md` next
for what happens to these events when they leave the process, and
`03-usage-metrics-ledger.md` for how `model_usage` becomes money.

## Interview defense

**Q: Why a discriminated union instead of one event type with optional fields?**
Because the discriminant lets every consumer know which fields are present without
runtime guards inside the process, and it makes illegal states unrepresentable — a
`model_usage` event can't accidentally carry a `durationMs`. The trade is rigidity:
adding an arm ripples to every consumer.

```
  one event w/ optionals          tagged union
  { type, toolName?, tokens?,     | { type:'tool_call_end'; durationMs }
    durationMs?, result? }        | { type:'model_usage'; tokens }
  every consumer guards           consumer switches once, fields are guaranteed
```

Anchor: `events.ts:1-24`.

**Q: The agent loop calls `trace?.emit` with an optional chain everywhere. Why?**
Because observability must never change the answer. The loop produces identical output
with or without a sink; the sink only collects evidence. Making `trace` optional encodes
"this is additive" in the type. Anchor: `run-agent-loop.ts:111-179`.

**Q: What's the load-bearing part people forget?**
The envelope — `capabilityId` + `timestamp` on *every* arm. Forget the timestamp and you
lose ordering and latency-from-deltas once the stream is serialized; forget the
`capabilityId` and you can't group events by run. The arms get the attention, but the
envelope is what makes the stream a *trace* and not a pile. Anchor: `events.ts:2-24`,
`timestamp()` at `:30-32`.

## Validate

1. **Reconstruct:** from memory, list the six arms of `CapabilityEvent` and the field
   unique to each (e.g. `durationMs` → `tool_call_end`, tokens → `model_usage`). Check
   against `events.ts:1-24`.
2. **Explain:** why is `trace?.emit` optional-chained at every call site in
   `run-agent-loop.ts:111-179`? What does that say about how observability is coupled to
   correctness?
3. **Apply to a scenario:** a run reports the wrong final answer. Which arm tells you the
   model's last reasoning (`step`), which tells you what a tool returned
   (`tool_call_end.result`), and which tells you a provider degraded (`warning`)? Trace
   the order you'd read them.
4. **Defend the decision:** the project context lists `CapabilityEvent` as
   must-not-change. Argue why the rigidity of a closed union is worth it here, and name
   the one situation (many independent emitters) where you'd loosen it.

## See also

- `00-overview.md` — the pipeline this primitive feeds.
- `03-usage-metrics-ledger.md` — what `model_usage` becomes.
- `04-live-trace-stream.md` — these events serialized as NDJSON to the UI.
- `05-degradation-warning-traces.md` — who emits the `warning` arm and why.
- `02-replay-artifact-as-snapshot.md` — the trace persisted as a whole-run snapshot.
