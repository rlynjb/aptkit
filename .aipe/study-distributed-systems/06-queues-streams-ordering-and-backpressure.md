# 06 — Queues, Streams, Ordering, and Backpressure

**Industry names:** in-process work queue · event stream (NDJSON) · ordering guarantees · backpressure · poison message · fan-in / batched flush — *Industry standard.*

## Zoom out, then zoom in

There is no Kafka, no Redis Streams, no message broker here — that's `not yet
exercised`. But there are two real stream-shaped things worth studying: the
**NDJSON trace stream** (the agent emits events that flow to the Studio UI or to
Postgres) and the **`pending[]` write queue** inside `SupabaseTraceSink` (sync
emits buffered, then drained by `flush()`). Both raise the core stream questions:
ordering, backpressure, and what happens to a bad message.

```
  Zoom out — the two stream-shaped things in the repo

  ┌─ App: runAgentLoop ─────────────────────────────────────────────────┐
  │  emit(CapabilityEvent) ── synchronous, in-order ──┐                  │ ← producer
  └────────────────────────────────────────────────────┼─────────────────┘
                                                        │
            ┌───────────────────────────────────────────┴──────────────┐
            ▼ (aptkit)                                                  ▼ (buffr)
  ┌─ NDJSON stream → Studio UI ─┐              ┌─ SupabaseTraceSink.pending[] ─┐
  │  one JSON object per line    │              │  push() each event's write,   │ ← we are here
  │  ordered by emit             │              │  then flush() drains them all │
  └──────────────────────────────┘              └───────────────┬───────────────┘
                                                                │ Promise.all (racing inserts!)
                                                  ┌─ agents.messages ────────────┐
                                                  │  order rebuilt from created_at│
                                                  └───────────────────────────────┘
```

Zoom in: a **stream** is an ordered sequence of events a producer emits and a
consumer processes. The hard questions are always the same three — does the consumer
see events *in order*? what happens when the producer outruns the consumer
(**backpressure**)? and what happens to one event the consumer *can't* process (a
**poison message**)? aptkit answers the first with a clever timestamp trick and
mostly dodges the other two — which is fine at its scale, and exactly what to name.

## Structure pass

**Layers.** Producer (agent emits) → buffer (`pending[]` / NDJSON line buffer) →
consumer (Postgres insert / Studio render).

**Axis — trace `is order preserved?` from producer to consumer.**

```
  Axis — "is emit order == consumer order?" — producer to consumer

  ┌─ producer: emit(event) ────────────────────┐
  │  synchronous, single-threaded → emit order  │  → STRICTLY ordered at the source ✓
  │  is the truth                               │
  └──────────────────────┬──────────────────────┘
       ┌─────────────────▼────────────────────────┐
       │ buffer: pending[] (array, push order)     │  → push order == emit order ✓
       └─────────────────┬────────────────────────┘
            ┌────────────▼──────────────────────────┐
            │ consumer: Promise.all(pending) inserts │  → INSERT order is a RACE ✗
            └─────────────────────────────────────────┘     (fixed by created_at, see below)
```

**Seam.** Order is preserved at the producer and in the buffer, then *lost* at the
consumer — `Promise.all` fires all the inserts concurrently, so whichever Postgres
write wins the race lands first. The seam where order breaks is the concurrent
flush. The fix doesn't restore insert order; it makes insert order *irrelevant* by
carrying the emit timestamp into the row. That's the lesson, and it's
file 07's subject too.

## How it works

### Move 1 — the mental model: a stream is a conveyor belt; order is the belt's promise

You know this from the event loop: callbacks queued in order, drained in order. A
trace stream is a conveyor belt of events — the agent drops events on in the order
they happen, and *something* downstream picks them up. The whole design question is
whether the picking-up preserves the dropping-on order.

```
  The stream kernel — produce in order, buffer, drain

  producer:  e1 ─► e2 ─► e3 ─► e4   (emit order = ground truth)
                  │
                  ▼  push into buffer
  buffer:   [ e1, e2, e3, e4 ]      (array preserves order)
                  │
                  ▼  drain
  consumer:  ?? depends on HOW you drain ??
             sequential await → e1,e2,e3,e4  (order kept)
             Promise.all      → e?,e?,e?,e?  (order RACED) ← aptkit does this
```

The load-bearing realization: a buffer keeps order, but *how you drain it* decides
whether the consumer sees order. Drain sequentially and order survives; drain
concurrently for speed and you trade order away — unless each event carries its own
position.

### Move 2 — walking the mechanism

**Step 1 — the producer emits synchronously, in order.** The agent loop calls
`trace.emit()` at each step, and emit is *synchronous by contract* — it returns
immediately, so the loop never blocks on the sink:

```ts
// packages/runtime/src/run-agent-loop.ts:147-179 (the emit calls, in loop order)
trace?.emit({ type: 'tool_call_start', capabilityId, toolName, args, timestamp: timestamp() });
// ... run the tool ...
trace?.emit({ type: 'tool_call_end', capabilityId, toolName, result, error, durationMs, timestamp: timestamp() });
```

Single-threaded, sequential — so the *emit order* is the ground truth for "what
happened when." `start` always emits before its `end`. This ordering is free here
because there's one producer and JS is single-threaded; it's the consumer side that
gets interesting.

**Step 2 — the buffer: a sync emit that queues an async write.** Here's the clever
contract bridge. aptkit's sink must be *synchronous* (`emit(): void`), but a Postgres
write is *async*. The `SupabaseTraceSink` reconciles them by pushing the write
*promise* into an array and returning immediately:

```ts
// buffr/src/supabase-trace-sink.ts:49-93
export class SupabaseTraceSink implements CapabilityTraceSink {
  private readonly pending: Promise<void>[] = [];      // ← the in-process "queue"

  emit(event: CapabilityEvent): void {                 // ← sync: satisfies aptkit's contract
    switch (event.type) {
      case 'step':
        this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
        // ↑ persistMessage returns a Promise; we push it, don't await it
        return;
      // ... one case per CapabilityEvent variant ...
    }
  }
  private push(p: Promise<void>): void { this.pending.push(p); }

  async flush(): Promise<void> {
    await Promise.all(this.pending);                   // ← drain CONCURRENTLY → inserts race
  }
}
```

The annotation that matters: `emit` doesn't await — it *fires* the write and stashes
the promise. So emits are non-blocking (the agent runs at full speed), and the writes
happen in the background. Then `flush()` (called once after the turn, in
`session.ts:63`) awaits them all. This is a fan-in: many emits, one drain.

**Step 3 — the ordering problem `Promise.all` creates, and the timestamp fix.**
`Promise.all` starts every pending write concurrently. Postgres applies them in
whatever order they arrive — a *race*. Without intervention, `tool_call_end` could
land in the table *before* its `tool_call_start`. The fix (called out in the sink's
own comment) is to stop relying on insert order entirely:

```ts
// buffr/src/supabase-trace-sink.ts:53-55, and persistMessage:26-30
const at = event.timestamp;                            // ← the EMIT-time ISO timestamp
// ...persistMessage writes it into created_at:
//   values (..., coalesce($8::timestamptz, now()))    ← created_at = emit time, NOT insert time
```

Now replay orders by `created_at` (emit order), and the insert race is *irrelevant* —
whoever wins the race, the row carries its true position. This is the single best
piece of distributed-systems engineering in the two repos: it converts an ordering
problem into a non-problem by attaching a logical position to each event instead of
trusting physical arrival order. (The clocks angle is file 07.)

**Step 4 — what's NOT handled: backpressure and poison messages.**

```
  Layers-and-hops — backpressure: who slows down when the consumer can't keep up?

  ┌─ producer (agent) ─┐  emit, emit, emit...   ┌─ pending[] ─┐   inserts...  ┌─ Postgres ─┐
  │  never blocks       │ ─────────────────────► │ grows       │ ────────────► │ may lag    │
  │  (emit is sync)     │                        │ UNBOUNDED   │               │            │
  └─────────────────────┘                        └─────────────┘               └────────────┘
       ▲                                              ▲
       └─ no signal flows back ──────────────────────┘
          if Postgres is slow, pending[] just grows; nobody is told to slow down
```

There is **no backpressure**: `emit` always succeeds instantly, so if Postgres is
slow, `pending[]` grows without bound and memory grows with it. At aptkit's scale
(one agent run, a few dozen events) this never bites — the buffer is tiny and bounded
by the turn. But it's the textbook gap: a real queue has a *bounded* size and pushes
back (blocks or drops) when full. And there's **no poison-message handling**: if one
`persistMessage` rejects, `Promise.all` rejects the whole `flush()`, and that throws
out of `ask` — one bad event fails the entire turn's trace persistence rather than
being isolated and skipped. Both are correct trades *at this scale* and would need
attention only if the trace volume grew or the writes moved to a real broker.

### Move 3 — the principle

Ordering, backpressure, and poison handling are the three questions every stream
must answer, and you can answer each one *cheaply* if you understand what you're
trading. aptkit answers ordering brilliantly (carry the position with the event, so
the consumer never has to preserve it) and *defers* backpressure and poison handling
by keeping the queue small and per-turn. The general principle: **don't trust the
transport to preserve order — make each message self-positioning.** A logical
timestamp or sequence number on every event means you can drain as fast and as
concurrently as you like and still reconstruct the truth.

## Primary diagram

```
  The trace stream — sync emit, buffered, concurrent drain, order via timestamp

  ┌─ Producer: runAgentLoop (single-threaded) ──────────────────────────┐
  │  emit(e, timestamp=NOW)  e1 → e2 → e3 ... in emit order ✓            │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ emit() is SYNC — never blocks (no backpressure)
  ┌─ Buffer: SupabaseTraceSink.pending[] ─▼──────────────────────────────┐
  │  push(persistMessage(...))  → [ p1, p2, p3, ... ]  (unbounded)        │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ flush(): Promise.all → inserts RACE
  ┌─ Consumer: agents.messages ──▼───────────────────────────────────────┐
  │  insert order = nondeterministic, BUT created_at = emit timestamp     │
  │  → replay ORDER BY created_at → emit order recovered ✓                │
  │  gaps: no backpressure (pending grows), no poison isolation (1 bad    │
  │        write fails the whole flush)                                   │
  └─────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The sync-emit / async-write split is a beautifully pragmatic answer to an impedance
mismatch: aptkit's `CapabilityTraceSink` contract is sync (so the core never depends
on a durable store), but durability is async. Buffering promises and draining once is
the bridge. The risk it accepts — unbounded `pending[]` — is the same risk every
"fire and forget then flush" buffer accepts; real systems bound it with a max size
and a flush threshold (flush every N events or every T ms), which is exactly what a
log shipper or a metrics agent does.

The poison-message gap is worth naming because it's a classic stream failure: in a
real broker, one un-processable message shouldn't block or fail the whole stream — it
goes to a dead-letter queue and the consumer moves on. Here, one rejected insert
fails the whole `flush()`. The move, if trace volume grew, would be
`Promise.allSettled` instead of `Promise.all` — persist what you can, collect the
failures, and don't let one bad row lose the rest of the trajectory.

## Interview defense

**Q: "How do you guarantee trace events are in order if the writes race?"**
"I don't try to make the *writes* ordered — that's the trick. `SupabaseTraceSink`
fires all the inserts concurrently with `Promise.all`, so insert order is a race. But
every event carries its emit-time ISO timestamp, and that's written into
`created_at`. So replay does `ORDER BY created_at` and recovers the true emit order
regardless of which insert won. I moved the ordering guarantee from the transport to
the data — each event is self-positioning, so concurrent draining is safe."

```
  sketch

  emit(e, t=NOW) → pending[] → Promise.all (RACE) → rows with created_at=t
                                                     replay ORDER BY created_at ✓
  ordering lives on the EVENT, not the transport
```

**Q: "What breaks if the trace volume gets large?"** — the load-bearing gaps:
"Two things, both fine today and both fixable. One, no backpressure — `emit` is sync
and never blocks, so if Postgres lags, `pending[]` grows unbounded and so does
memory. A real queue bounds itself and pushes back. Two, no poison-message isolation
— `Promise.all` means one rejected insert fails the entire `flush`, losing the whole
turn's trace. I'd switch to `Promise.allSettled` and a bounded buffer with periodic
flushing. At one-agent-run scale neither bites, which is why I haven't built them."

*Anchor:* ordering via `created_at` (the win); unbounded `pending[]` and
`Promise.all`-fails-all (the deferred gaps).

## See also

- `07-clocks-coordination-and-leadership.md` — the timestamp-as-logical-position idea, in full
- `02-partial-failure-timeouts-and-retries.md` — a poison write is a per-message failure to classify
- **study-debugging-observability** — the trace as evidence; reading it back in order
- **study-runtime-systems** — the event loop, microtask ordering, `Promise.all` vs `allSettled`
```
