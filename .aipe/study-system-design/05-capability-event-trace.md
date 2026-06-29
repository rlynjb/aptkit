# 05 — Capability event trace

**Industry name(s):** structured event stream / observability sink / trace
emitter. **Type:** Industry standard (a project-specific event schema).

## Zoom out, then zoom in

One observability contract, three completely different destinations. The agent loop
emits a stream of typed events as it runs; *where* those events go — a browser over
NDJSON, a Postgres table, or nowhere — is the consumer's choice, and the loop never
knows which.

```
  Zoom out — where the trace seam lives

  ┌─ runtime: runAgentLoop emits CapabilityEvent ─────────────────────┐
  │  step · tool_call_start · tool_call_end · model_usage · warning · error
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ trace?.emit(event)  (CapabilityTraceSink)
                ┌─────────────────┼──────────────────┐
                ▼                 ▼                  ▼
  ┌─ Studio (UI) ──┐   ┌─ buffr (deployment) ┐   ┌─ tests/none ─┐
  │ NDJSON stream  │   │ SupabaseTraceSink →  │   │ in-mem array │ ← here:
  │ → browser live │   │ agents.messages (PG) │   │ or undefined │   one
  └────────────────┘   └──────────────────────┘   └──────────────┘   contract,
                                                                      three sinks
```

The question: *how does the agent loop become observable — live in a UI, durable in
Postgres, or silent in a test — without the loop carrying any logging code for any of
those?* The answer is the same seam pattern again: emit to a contract, let the
consumer supply the sink. Here's the mechanism.

## Structure pass

**Layers:** `runAgentLoop` (emitter) → `CapabilityTraceSink` contract → sinks
(Studio NDJSON, buffr Postgres, in-memory/none).

**Axis traced — *where does an event end up?***

```
  One axis — "where does an emitted event land?" — traced across sinks

  ┌─ runAgentLoop ─────────┐   doesn't know. calls trace?.emit() and moves on.
  └──────────┬──────────────┘
  ┌─ CapabilityTraceSink ──▼┐  a type. one method: emit(event): void.
  └──────────┬──────────────┘
  ┌─ the sink ──────────────▼┐  Studio→browser | buffr→PG row | test→array
  └──────────────────────────┘  destination flips entirely; emitter unchanged.
```

**Seam:** the `CapabilityTraceSink` boundary. The *destination* of an event flips
across it while the emit call stays identical. The emitter is decoupled from
durability, transport, and format all at once.

## How it works

### Move 1 — the mental model

You've used this shape: a logging interface where `console.log`, a file writer, and a
remote collector all satisfy `log(msg)`, and the calling code picks one at startup.
`CapabilityTraceSink` is that, with a *typed* event instead of a string — a
discriminated union the consumer pattern-matches on.

```
  The trace seam — emit once, fan to any sink

  runAgentLoop ──emit(event)──► CapabilityTraceSink (one method)
                                      │
                  ┌───────────────────┼───────────────────┐
                  ▼                   ▼                   ▼
            Studio NDJSON       buffr Postgres        in-memory
            res.write(JSON+\n)  insert into messages  array.push
```

### Move 2 — the walkthrough

**The event schema is a discriminated union.** Six variants, each tagged by `type`,
each carrying `capabilityId` + ISO `timestamp` (`events.ts:1`):

```ts
// packages/runtime/src/events.ts:1 (the union, abridged)
export type CapabilityEvent =
  | { type: 'step';            role: string; content: string; ... }
  | { type: 'tool_call_start'; toolName: string; args: unknown; ... }
  | { type: 'tool_call_end';   toolName: string; result?: unknown; error?: string; durationMs: number; ... }
  | { type: 'model_usage';     provider: string; model: string; inputTokens?: number; outputTokens?: number; ... }
  | { type: 'warning';         message: string; ... }
  | { type: 'error';           message: string; ... };
export type CapabilityTraceSink = { emit(event: CapabilityEvent): void };  // :26
```

**What breaks if missing:** without a typed union, every sink would parse loosely-
typed log lines and the loop would have to format strings. The union means a sink
`switch`es on `type` and the compiler checks it handled every variant.

**The emitter is the loop, and `emit` is fire-and-forget.** The loop calls
`trace?.emit(...)` synchronously at each interesting moment (`run-agent-loop.ts:112`
for `model_usage`, `:128` for `step`, `:147`/`:171` for tool start/end). The `?.`
matters: trace is *optional* — pass nothing and the loop runs silently. And `emit`
returns `void`, not a promise — the contract is **synchronous**, so the loop never
awaits the sink. **What breaks if `emit` were async:** the loop would block on
durability, coupling its latency to the database. Keeping it sync is a deliberate
design choice that pushes the async problem onto the sink.

**Sink 1 — Studio streams NDJSON to the browser.** Studio's Vite middleware runs the
real agent and gives it a sink whose `emit` writes each event as one JSON line to the
HTTP response (`apps/studio/vite.config.ts:541` builds the sink, `:901` sets
`content-type: application/x-ndjson`). The browser reads the stream and renders the
trajectory live.

```
  Layers-and-hops — Studio trace, server to browser

  ┌─ browser ─────┐  hop1: POST /api/stream/replay   ┌─ Vite middleware ─┐
  │ AgentReplay   │ ────────────────────────────────►│ runReplay(fixture) │
  │ Shell         │                                   │ agent + trace sink │
  │               │  hop3: read NDJSON line-by-line   └─────────┬──────────┘
  │ render trace  │◄──────────────────────────────────────────┘
  └───────────────┘  hop2: per event → res.write(JSON.stringify(event)+'\n')
                              application/x-ndjson
```

**Sink 2 — buffr persists every variant to Postgres.** `SupabaseTraceSink`
(`supabase-trace-sink.ts:49`) `implements CapabilityTraceSink`. Its `emit` `switch`es
on the event type and writes a row to `agents.messages` — and the comment
(`supabase-trace-sink.ts:39`) is the lesson: it persists *every* variant, including
tool-call args (the cause), `durationMs`, errors, and token usage, which an earlier
version dropped. The async-vs-sync tension is resolved here: `emit` queues a promise,
and the run calls `flush()` after (`session.ts:63`).

```ts
// buffr/src/supabase-trace-sink.ts:53 (abridged)
emit(event: CapabilityEvent): void {
  switch (event.type) {
    case 'step':            this.push(persistMessage(pool, convId, event.role, event.content, { createdAt: event.timestamp })); return;
    case 'tool_call_start': this.push(persistMessage(pool, convId, 'tool_call', event.toolName, { toolCalls: { toolName: event.toolName, args: event.args }, ... })); return;
    case 'tool_call_end':   this.push(persistMessage(pool, convId, 'tool',  event.toolName, { toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, ... })); return;
    case 'model_usage':     this.push(persistMessage(pool, convId, 'model_usage', '', { model: `${event.provider}/${event.model}`, tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), ... })); return;
    case 'warning': case 'error': this.push(persistMessage(pool, convId, event.type, event.message, ...)); return;
  }
}
async flush() { await Promise.all(this.pending); }   // :91 — sync emit, async drain
```

The `created_at` is set from the *event* timestamp, not server `now()`
(`supabase-trace-sink.ts:30`), so replay order matches emit order rather than the
race between concurrent flush inserts — a small but real ordering guarantee.

**Sink 3 — nothing.** In a unit test or a plain library call, you pass no sink. The
`trace?.` makes every emit a no-op. Same loop code, zero observability overhead.

### Move 3 — the principle

Make observability a *contract the caller fills*, not code baked into the thing being
observed. The emitter decides *what's worth recording* (the event schema); the sink
decides *what recording means* (a pixel, a row, nothing). Keeping `emit` synchronous
and `void` is the move that keeps the emitter's latency independent of the sink's —
the async problem belongs to whoever chose a slow destination.

## Primary diagram

The full trace seam: one emitter, one contract, three sinks.

```
  Capability event trace — full picture

  ┌─ runtime: runAgentLoop ────────────────────────────────────────────┐
  │ emits per turn: step · tool_call_start · tool_call_end ·            │
  │                 model_usage · warning · error                      │
  │ trace?.emit(event)   — synchronous, void, optional                 │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │ CapabilityTraceSink { emit(event): void }
            ┌──────────────────────┼───────────────────────┐
            ▼                      ▼                       ▼
  ┌─ Studio (dev UI) ──┐  ┌─ buffr SupabaseTraceSink ─┐  ┌─ tests / library ┐
  │ emit → res.write(  │  │ emit → push(persistMessage)│  │ no sink passed:  │
  │  JSON + '\n')      │  │ flush() → Promise.all      │  │ trace?. = no-op  │
  │ application/x-ndjson│ │ → agents.messages (PG)     │  │                  │
  │ → browser renders  │  │ created_at = event ts      │  │                  │
  └────────────────────┘  └────────────────────────────┘  └──────────────────┘
```

## Elaborate

This is the observer/sink pattern, and the typed discriminated union is what raises
it above ad-hoc logging — the schema *is* the API between emitter and every sink, so
adding a sink is a `switch`, not a parser. The sync `emit` + async `flush` split in
buffr is the standard answer to "I have a synchronous emit contract but a slow durable
sink": buffer the writes, drain once. The event-timestamp-as-`created_at` detail is a
quiet correctness fix — without it, concurrent inserts would reorder the trajectory.

Cross-links: the events are emitted *by* the loop in `04-bounded-agent-loop.md`; the
buffr sink is one of the slots filled in `03-library-vs-deployment-split.md`. The
*operational* side — what to alert on, how to debug from a trace — belongs to
**`study-debugging-observability`**.

## Interview defense

**Q: Why is `emit` synchronous and `void`?**
So the agent loop never blocks on or awaits the sink — its latency stays independent
of where the trace goes. A slow durable destination is the *sink's* problem to solve
(buffr buffers and `flush()`es), not the emitter's. Anchor: *sync emit, async drain —
the emitter doesn't pay for the destination's slowness.*

```
  loop: emit() ──fire & forget──► sink buffers ──run ends──► flush() drains
```

**Q: What's the load-bearing part people forget?**
That the event is a *typed discriminated union*, not a log string. That's what lets a
new sink exhaustively `switch` on `type` with compiler checking, and what let buffr
catch that it was dropping `tool_call` args and `model_usage` tokens
(`supabase-trace-sink.ts:39`). Anchor: *the schema is the API; a dropped variant is a
compile-or-review catch, not a silent gap.*

**Q: How does the same loop run live in a UI and durable in production?**
Three sinks behind one contract: Studio's writes NDJSON to the HTTP response, buffr's
writes Postgres rows, a test passes none. The loop code is identical in all three —
it only ever calls `trace?.emit`. Anchor: *one emitter, three destinations, zero loop
changes.*

## See also

- `04-bounded-agent-loop.md` — where the events are emitted.
- `03-library-vs-deployment-split.md` — buffr's sink as a filled slot.
- `06-fixture-replay-evals.md` — the trace is part of the replay artifact.
- **`study-debugging-observability`** — operating and debugging from the trace.
