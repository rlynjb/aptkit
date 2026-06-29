# 04 — Capability event trace (the observability seam)

> **Subtitle:** Structured event trace / Observability via an emitted event
> stream — *Industry standard.* The contract is the sink port
> (`CapabilityTraceSink`), the events are a discriminated union
> (`CapabilityEvent`), the wire format is NDJSON. Where the trace *goes* is a
> swappable adapter: Studio streams it to a browser, buffr persists it to
> Postgres.

## Zoom out — where this sits

The agent loop doesn't `console.log`. Every step it takes — a model response,
a tool call starting, token usage — it emits as a typed event to a sink. What
the sink *does* with the event is the deployment's choice: Studio streams it to
the browser as it happens; buffr writes it to a database. Same events, two
destinations, because the sink is a port.

```
  Zoom out — the trace seam in the stack

  ┌─ Runtime ───────────────────────────────────────────────────┐
  │  runAgentLoop ─► trace?.emit(CapabilityEvent)                 │  the producer
  │  packages/runtime/src/run-agent-loop.ts:112,128,147,171      │
  └───────────────────────────┬────────────────────────────────────┘
                              │ CapabilityTraceSink.emit(event)  (the port)
  ┌─ Sink port ───────────────▼────────────────────────────────────┐
  │  ★ CapabilityTraceSink ★  packages/runtime/src/events.ts:26    │ ← we are here
  └──────────────┬──────────────────────────────┬───────────────────┘
                 ▼                               ▼
  ┌─ Studio sink (dev) ────────┐    ┌─ SupabaseTraceSink (buffr) ──────┐
  │ write NDJSON to HTTP resp  │    │ persist to agents.messages etc.  │
  │ apps/studio/vite.config.ts │    │ buffr/src/supabase-trace-sink.ts │
  └────────────────────────────┘    └──────────────────────────────────┘
```

This is the same ports-and-adapters move as the model seam (`01`), applied to
*where observability data lands*. The loop produces events; it doesn't care
who consumes them.

## Structure pass — layers, axis, seam

Layers: the **producer** (the loop), the **sink port** (`CapabilityTraceSink`),
the **sink adapters** (browser stream / Postgres). Trace one axis — **what is
the data and who owns it** — across the seam:

```
  axis traced: "what does this data become past the boundary?"

  ┌─ loop (producer) ───────────┐   an in-memory typed object (CapabilityEvent)
  └──────────────┬───────────────┘
       seam ═════╪═════  ← representation flips: typed object → wire/row
  ┌─ sink adapter ▼─────────────┐   Studio: NDJSON line on an HTTP stream
  │                             │   buffr:  a row in agents.messages (durable)
  └─────────────────────────────┘
```

The seam is `emit()`. Above it, the event is a typed union the loop builds.
Below it, the representation flips — to a newline of JSON on a stream, or to a
durable Postgres row. The loop never knows which.

## How it works

### Move 1 — the mental model

You know an event emitter: code calls `emit('thing', payload)` and whoever
subscribed reacts. This is that, with one method and a *typed* payload — a
discriminated union so each event kind carries exactly its own fields.

```
  the pattern — typed events to a pluggable sink

  loop step ─► build event { type:'tool_call_start', toolName, args, timestamp }
                    │
                    ▼ trace?.emit(event)        (optional — undefined sink = no-op)
              ┌─────┴──────┐
              ▼            ▼
          NDJSON line   Postgres row
          (browser)     (buffr)
```

The `?.` matters: the sink is *optional*. No sink wired → emitting is a no-op,
and the agent runs the same. Observability is additive, never required.

### Move 2 — the parts

**The event union** (`packages/runtime/src/events.ts:1-24`) — six kinds, each
carrying `capabilityId` + ISO `timestamp`:

```ts
export type CapabilityEvent =
  | { type: 'step';            capabilityId; role; content; timestamp }      // a model text turn
  | { type: 'tool_call_start'; capabilityId; toolName; args; timestamp }     // a tool invoked
  | { type: 'tool_call_end';   capabilityId; toolName; result?; error?; durationMs; timestamp }
  | { type: 'model_usage';     capabilityId; provider; model; inputTokens?; outputTokens?; estimated?; timestamp }
  | { type: 'warning';         capabilityId; message; timestamp }
  | { type: 'error';           capabilityId; message; timestamp };
```

A discriminated union is the right shape because a consumer can `switch
(event.type)` and TypeScript narrows the fields. `model_usage` carries
`provider` + `model` (the `id` from `01`) so you can attribute cost and latency
to the exact adapter that answered.

**The port** (`events.ts:26-28`) is one method:

```ts
export type CapabilityTraceSink = { emit(event: CapabilityEvent): void };
```

**Where the loop emits** (`run-agent-loop.ts`): `model_usage` after each
completion (line 112), `step` for assistant text (line 128), `tool_call_start`
before each tool (line 147), `tool_call_end` after (line 171), `warning` in the
recovery path (line 220). Every meaningful step in the loop has a corresponding
event.

**Adapter A — Studio streams it** (`apps/studio/vite.config.ts`): the Vite dev
middleware runs an agent replay with an `onEvent` callback that writes each
event to the HTTP response as a newline of JSON (`content-type:
application/x-ndjson`). The browser reads the stream and renders each step as it
arrives — that's why the replay UI animates.

```
  layers-and-hops — trace crossing to the browser (Studio)

  ┌─ runtime ───────┐ hop1: emit(event)   ┌─ Vite middleware ─┐
  │ runAgentLoop    │ ──────────────────► │ onEvent callback  │
  └─────────────────┘                     └────────┬──────────┘
                              hop2: res.write(JSON + "\n")
                                                   ▼
                                       ┌─ Browser (NDJSON reader) ─┐
                                       │ render each step live      │
                                       └────────────────────────────┘
```

**Adapter B — buffr persists it** (`/Users/rein/Public/buffr/src/supabase-trace-sink.ts:49`):
`SupabaseTraceSink implements CapabilityTraceSink`. Its `emit` (lines 53-85)
routes each event kind to a durable row — `step` → a message in
`agents.messages`, `tool_call_*` → tool invocation/result rows, `model_usage` →
token counts — and a `flush()` (lines 91-93) awaits the queued writes.

```
  same events, the OTHER adapter (buffr)

  emit(event) ─► SupabaseTraceSink ─► INSERT into agents.messages / conversations
                                       durable, app_id-keyed
```

#### Move 2 variant — the load-bearing skeleton

The trace kernel: **a typed event + a single `emit` method + the
`capabilityId` correlation key**. What breaks if each goes:

- **the typed union** — gone, and consumers can't `switch` on kind; every sink
  re-parses untyped blobs. The discrimination is what makes it consumable.
- **`emit` (the port)** — gone, and the loop has to know its destination; you
  lose the swap between stream and database.
- **`capabilityId` on every event** — gone, and you can't correlate which
  events belong to which run when traces interleave. This is the field people
  forget; it's the join key.
- **`timestamp`** — gone, and you can't order or measure latency.

Hardening on top: NDJSON framing (one parseable record per line, streamable),
the optional `?.` no-op sink, `durationMs` on tool ends, `flush()` for durable
sinks.

### Move 3 — the principle

Make the loop *emit* observability as typed events to a port, and let the
deployment decide where it lands. The same event stream becomes a live
animation in a dev tool and a durable audit log in production — without the
loop knowing the difference. NDJSON is the right wire format precisely because
it's both streamable (one record at a time) and persistable (append a line).

## Primary diagram

```
  the capability-event trace, end to end

  ┌─ runtime: runAgentLoop ────────────────────────────────────────────┐
  │  step · tool_call_start · tool_call_end · model_usage · warn · error│
  │  each { capabilityId, timestamp, ...kind-specific }                 │
  └───────────────────────────┬─────────────────────────────────────────┘
                              │ trace?.emit(event)   ← optional, ?. = no-op
        seam ─────────────────┼──── (typed object → wire / row)
       ┌──────────────────────┴───────────────────────┐
       ▼                                               ▼
  ┌─ Studio sink ──────────────┐         ┌─ SupabaseTraceSink (buffr) ──────┐
  │ res.write(JSON+"\n")        │         │ INSERT agents.messages / convos  │
  │ x-ndjson → browser animates │         │ flush() awaits writes · durable  │
  └─────────────────────────────┘         └──────────────────────────────────┘
```

## Elaborate

This is structured logging / event-sourced observability with a sink
abstraction. The discriminated union is the modern TypeScript version of
"structured log lines" — typed instead of stringly-formatted. NDJSON is the
format of choice for streaming traces (each line independently parseable) and
is what tools like log shippers expect. The deeper observability discipline —
metrics, spans, incident reconstruction — belongs to
`study-debugging-observability`; this file owns only the *architectural seam*
(events emitted to a swappable sink). The cost-attribution side (the
`usage-ledger`) connects to `study-performance-engineering`.

## Interview defense

**Q: Why a sink port instead of just logging?**
Because the same event stream needs two destinations: a live NDJSON stream the
Studio browser animates, and durable Postgres rows buffr writes for audit.
Logging hardcodes the destination; a sink port lets the deployment pick. And
the sink is optional — no sink wired, emitting is a no-op, the agent runs the
same.

```
  loop ─emit─► CapabilityTraceSink ◄─implements─ { Studio stream, Supabase rows }
```
*Anchor:* "The loop emits typed events; where they land is a swappable adapter."

**Q: What field do people forget in a trace event?**
`capabilityId` — the correlation key. When multiple runs interleave on one
sink, it's the only way to reassemble which events belong to which run. Every
one of the six event kinds carries it, plus a timestamp for ordering.

```
  event { capabilityId: 'rag-query', timestamp, ... }  ← the join key
```
*Anchor:* "Every event carries `capabilityId` + timestamp — the correlation keys."

## See also

- `00-overview.md` — the trace seam on the full map
- `03-bounded-agent-loop.md` — the producer that emits the events
- `05-library-vs-deployment-split.md` — why buffr supplies the durable sink
- `07-fixture-replay-evals.md` — traces are part of the replay artifact
- `study-debugging-observability` — the broader observability discipline
- `study-performance-engineering` — `model_usage` and the cost ledger
