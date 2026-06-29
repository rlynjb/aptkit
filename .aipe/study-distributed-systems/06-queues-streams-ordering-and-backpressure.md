# 06 — Queues, Streams, Ordering, and Backpressure

**Industry names:** message queue · event stream · ordering guarantees · backpressure · poison message · consumer group. **Type:** Industry standard.

## Zoom out, then zoom in

There's no broker — no Kafka, no Redis Streams, no SQS. **Queue infrastructure is `not yet exercised`.** But the repo *does* produce a real **event stream** — the trace events — and serializes it as NDJSON. So the streaming-and-ordering half of this topic is grounded; the broker-and-consumer-group half is honestly absent.

```
  Zoom out — a stream the repo has, a broker it doesn't

  ┌─ App (producer) ────────────────────────────────────────────────┐
  │  runAgentLoop → trace.emit(CapabilityEvent)  ★ the stream ★       │ ← we are here
  └───────────────┬──────────────────────────────┬──────────────────┘
       NDJSON      │                    persisted │
  ┌───────────────▼──────────┐        ┌───────────▼──────────────────┐
  │ Studio (Vite middleware)  │        │ SupabaseTraceSink → messages  │
  │  reads NDJSON, replays    │        │  created_at = emit timestamp  │
  └───────────────────────────┘        └───────────────────────────────┘

  ┄┄ not yet exercised: a broker between producer and consumer,
     consumer groups, offsets, poison-message handling, backpressure ┄┄
```

Zoom in: a **stream** is an ordered sequence of events a producer emits and a consumer reads. A **queue** adds a durable buffer *between* them so the producer can outrun the consumer without either blocking. The repo emits a stream synchronously (`trace.emit` is a function call, not an enqueue) — so there's no buffer, no consumer lag, and no backpressure, because producer and consumer are the same thread. That's the key realization: the repo has a stream's *ordering* concerns without a queue's *decoupling* concerns.

## Structure pass — layers, one axis, the seams

**Layers:** producer (`runAgentLoop` emitting events) → serialization (NDJSON) → consumers (Studio replay, `SupabaseTraceSink`).

**The one axis: *how is order established and preserved?*** Trace it from emission to recovery:

```
  "what guarantees event order at this stage?"  — traced along the stream

  ┌──────────────────────────────────────────────┐
  │ trace.emit() calls   order = CALL order        │  in-process, single thread:
  │  (run-agent-loop.ts)  (program order)          │  total order, free
  └────────────────────┬──────────────────────────┘
       ┌───────────────▼──────────────────────────┐
       │ NDJSON serialization  order = LINE order   │  append order preserved
       │                                            │  in the byte stream
       └───────────────┬──────────────────────────┘
             ┌─────────▼──────────────────────────┐
             │ SupabaseTraceSink INSERT            │  rows may RACE on insert →
             │  order recovered by created_at      │  ORDER BY created_at restores it
             └─────────────────────────────────────┘
```

Order is free in-process (one thread, program order), preserved in the byte stream (line order), and *recovered* at the database by an explicit emit-timestamp. That last flip is the load-bearing one — and it's the seam.

**The seam:** the `SupabaseTraceSink` boundary (`buffr/src/supabase-trace-sink.ts`). Ordering changes from *implicit* (program/line order) to *needs-reconstruction* (rows can land out of order under concurrency, so order is carried in a column, not in arrival).

## How it works

### Move 1 — the mental model

You know a stream from an array you `.push()` to and read back in order, and you know NDJSON from line-delimited logs — each line one JSON object. The repo's trace is exactly that: emit appends an event, the consumer reads events in the order they were appended.

```
  The stream kernel — append-ordered events, one consumer-readable line each

  producer:  emit(e0) → emit(e1) → emit(e2)
                │         │         │
                ▼         ▼         ▼
  NDJSON:    {…e0…}\n  {…e1…}\n  {…e2…}\n     ← line order = emit order
                                              ← each line independently parseable
```

The kernel: **append-ordered events + a self-delimiting wire format.** Drop the delimiter (one giant JSON array) and you can't stream incrementally — the consumer must wait for the whole thing. NDJSON's `\n`-per-record is what lets Studio render events as they arrive.

### Move 2 — walking the mechanism

**Part 1 — the producer: synchronous emit, no buffer.** Events come from `trace?.emit(...)` calls scattered through `runAgentLoop` (`run-agent-loop.ts`): `step` (:127), `model_usage` (:111), `tool_call_start` (:147), `tool_call_end` (:171), `warning` (:220), plus `error`. Each is a discriminated-union `CapabilityEvent` (`runtime/src/events.ts:1-24`) carrying a `capabilityId` and an ISO `timestamp`. Crucially, `emit` is a *synchronous call* — there's no queue between the loop and the sink. The loop produces; the sink consumes; same call stack, same thread. So there is no producer/consumer decoupling and, by extension, no consumer lag and no backpressure. The stream's *ordering* matters; its *buffering* doesn't exist.

```typescript
// packages/runtime/src/events.ts:1-9  (the event stream's element type)
export type CapabilityEvent =
  | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
  | { type: 'tool_call_start'; capabilityId: string; toolName: string; args: unknown; timestamp: string }
  | { type: 'tool_call_end'; capabilityId: string; toolName: string; result?: unknown;
      error?: string; durationMs: number; timestamp: string }
  // … model_usage | warning | error — all carry capabilityId + ISO timestamp
```

The `timestamp` field is the load-bearing part: it's stamped *at emit time* (`timestamp()` → `new Date().toISOString()`, `events.ts:30`), not at persist time. That's what makes order recoverable downstream.

**Part 2 — the wire format: NDJSON, ordered by lines.** The events serialize to NDJSON (newline-delimited JSON) — `context.md` confirms the trace is "streamed/persisted as NDJSON," and Studio's Vite middleware streams it. Line order in the byte stream is emit order, because the producer is single-threaded and appends. A consumer reading the file top-to-bottom reconstructs the exact sequence.

**Part 3 — the ordering recovery at the database (the real distributed-systems move).** Here's where it gets interesting. When `SupabaseTraceSink` persists events to `agents.messages`, multiple inserts can be in flight, and rows don't necessarily *land* in emit order under concurrency. The sink defends against this by persisting the *emit* timestamp into `created_at`:

```sql
-- buffr/src/supabase-trace-sink.ts:27-36  (persistMessage)
insert into agents.messages
  (conversation_id, role, content, tool_calls, tool_results, model, tokens_used, created_at)
values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()));
                                              -- ↑ $8 = the event's emit timestamp
```

Read the last column: `coalesce($8::timestamptz, now())`. The `$8` parameter is the event's *own* emit timestamp (captured as `at` from `event.timestamp`, `supabase-trace-sink.ts:53-85`). If it's present, the row records *when the event happened*, not when the INSERT committed. So even if two inserts race and commit out of order, `ORDER BY created_at` recovers the true emit sequence. The `coalesce(..., now())` fallback means a missing timestamp degrades to server-clock insert time — a reasonable last resort.

```
  Layers-and-hops — racing inserts, order recovered by emit timestamp

  ┌─ App (one thread) ──────┐  emit e0 @ t0, e1 @ t1   ┌─ SupabaseTraceSink ─┐
  │ runAgentLoop            │ ─────(in order)────────► │ INSERT, created_at  │
  │                         │                          │   = emit timestamp  │
  └─────────────────────────┘                          └──────────┬──────────┘
                                                                  │ concurrent
                          rows may COMMIT out of order ──────────►│ INSERTs
                                                       ┌──────────▼──────────┐
                                                       │ agents.messages     │
                                                       │ SELECT … ORDER BY    │  ← true emit
                                                       │   created_at        │     order restored
                                                       └─────────────────────┘
```

This is a small but genuine instance of the distributed-systems principle: **don't trust arrival order; carry order in the data.** It's the same reason event-sourced systems stamp every event with a sequence number or timestamp at the source.

**Part 4 — backpressure, poison messages, consumer groups — `not yet exercised`.** All three need a broker the repo doesn't have:
- **Backpressure** — when a consumer can't keep up, the system must slow the producer (block, drop, or buffer-then-spill). The repo's emit is synchronous, so there's nothing to back up — the "consumer" runs inline. Attach point: the day trace persistence becomes async (a real queue to Supabase), a slow DB would need to push back on the loop.
- **Poison message** — an event that crashes the consumer every time it's processed, blocking the queue. The trace sink *should* swallow its own failures (a failed trace insert must not fail the agent turn — a property `study-debugging-observability` owns), so a "poison" trace event is contained by being best-effort. There's no dead-letter queue because there's no queue.
- **Consumer groups / offsets** — multiple consumers splitting a partitioned stream, each tracking its position. Not applicable: one producer, inline consumers, no offset to commit.

### Move 3 — the principle

In a single-threaded producer, order is free and you can forget about it. The instant the consumer is on the other side of a boundary — a database, a network, a broker — arrival order stops being emit order, and you must *carry order in the data* (a timestamp, a sequence number) to recover it. The repo does exactly this with `created_at`, which is the right instinct even though it has no broker. Backpressure and poison-message handling are the problems you buy *along with* a queue; the repo hasn't bought the queue, so it honestly doesn't have them.

## Primary diagram

The whole stream path, from synchronous emit to order recovery.

```
  Trace event stream — emit, serialize, persist, recover order

  ┌─ Producer (single thread) ─────────────────────────────────────┐
  │  runAgentLoop: emit step, tool_call_start/_end, model_usage,    │
  │   warning, error  — each a CapabilityEvent w/ ISO timestamp     │
  │   (no queue; emit is a synchronous call → no backpressure)      │
  └──────────────────────────────────┬──────────────────────────────┘
            ┌─────────────────────────┴───────────────────────┐
            │ NDJSON (line order = emit order)                 │
  ┌─────────▼────────────┐                       ┌─────────────▼──────────────┐
  │ Studio replay         │                       │ SupabaseTraceSink           │
  │  reads lines in order │                       │  INSERT created_at = emit ts│
  └───────────────────────┘                       │  racing inserts →           │
                                                   │  ORDER BY created_at        │
                                                   │   recovers emit order       │
                                                   └─────────────────────────────┘

  ┄┄ not yet exercised: broker · backpressure · poison/dead-letter · offsets ┄┄
```

## Elaborate

The NDJSON-streaming-plus-timestamp pattern is the lightweight cousin of event sourcing and log-based architectures (Kafka's core idea: the log *is* the source of truth, ordered by offset). The repo uses a timestamp instead of a monotonic offset, which is fine for a single producer but would break under multiple producers whose clocks disagree — that's the clock problem, and it's why real log systems assign a *broker-side* sequence number (→ `07` for why clocks alone can't order distributed events).

Backpressure is the concept worth internalizing for when buffr's trace persistence goes async: the three responses to a full buffer are *block* (slow the producer — preserves all data, risks stalling the agent), *drop* (shed load — preserves throughput, loses traces), and *spill* (buffer to disk — preserves data, adds latency). For best-effort observability, *drop* is usually right; for the agent's actual output, *block* is. Knowing which data deserves which policy is the skill.

## Interview defense

**Q: "How do you keep your trace events ordered when they hit the database?"**
"Each `CapabilityEvent` carries an ISO timestamp stamped at *emit* time, not insert time. `SupabaseTraceSink` writes it into `created_at` — `coalesce($8::timestamptz, now())` at `supabase-trace-sink.ts:30`. So even if concurrent inserts commit out of order, `ORDER BY created_at` recovers the true emit sequence. The principle: don't trust arrival order, carry order in the data."

```
  emit ts → created_at column → ORDER BY recovers order despite racing inserts
```

Anchor: *order travels in the row's timestamp, not in insert arrival order.*

**Q: "Where's your backpressure?"**
"There isn't any, honestly, and that's correct for now — `trace.emit` is a synchronous in-process call, so producer and consumer are the same thread; there's nothing to back up. Backpressure becomes real the day trace persistence goes async behind a queue, and then I'd treat observability data as droppable and the agent's actual output as block-worthy. No broker means no consumer groups or dead-letter queues either — those are `not yet exercised`."

Anchor: *no queue, so no backpressure — the producer and consumer share a thread.*

## See also

- `07-clocks-coordination-and-leadership.md` — why a timestamp orders a *single* producer but not multiple
- `03-idempotency-deduplication-and-delivery-semantics.md` — at-least-once delivery is what a real queue would give you
- `study-debugging-observability` — the trace stream as the observability backbone (this guide owns only its *ordering*)
- `study-networking` — NDJSON streaming over HTTP, chunked transfer
- `study-runtime-systems` — synchronous emit, the event loop, why there's no consumer lag
