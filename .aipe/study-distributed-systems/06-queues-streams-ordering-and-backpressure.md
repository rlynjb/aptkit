# 06 — Queues, streams, ordering, backpressure

**Industry name(s):** message queues / event streams / consumer groups / message
ordering / poison messages (DLQ) / backpressure. **Type:** Industry standard.
**Status in AptKit:** `not yet exercised` (no broker, no async hand-off);
the in-process turn loop and the NDJSON trace stream are the closest shapes.

## Zoom out, then zoom in

AptKit has no message broker, no queue, no consumer group, no async producer/
consumer split. Everything is synchronous and in-process. The two shapes that
*rhyme* with this topic: the agent loop processing turns in strict order (a
synchronous, in-memory "queue of one"), and the NDJSON trace that streams events
out — but that's a one-way log, not a queue with consumers and acks.

```
  Zoom out — where queues would live (none here)

  ┌─ UI layer (Studio) ──────────────────────────────────────────┐
  │  NDJSON stream of trace events ── one-way log, NOT a queue     │ ← stream analog
  └─────────────────────────────┬────────────────────────────────┘
                               │ in-process, synchronous
  ┌─ Service layer ─────────────▼────────────────────────────────┐
  │  runAgentLoop ── strict in-order turns ── "queue of one"       │ ← ordering analog
  └───────────────────────────────────────────────────────────────┘

  no broker · no consumer group · no DLQ · no backpressure · no async hand-off
```

Zoom in: a **queue** decouples a producer from a consumer in time — the producer
drops a message and moves on; the consumer picks it up later. That decoupling
buys you load smoothing and retries, and it forces you to confront **ordering**
(do messages arrive in order?), **poison messages** (one bad message blocking the
queue), and **backpressure** (what happens when the producer outruns the
consumer?). AptKit does none of this because nothing is async — the "consumer" is
the same call stack as the "producer."

## Structure pass — layers, axis, seam

Trace the **control axis** — "who drives the next unit of work, and when?":

```
  "who drives the next unit, and when?" — down the layers

  ┌────────────────────────────────────────────┐
  │ agent turn loop                             │ → SYNCHRONOUS: the loop drives the
  │                                             │   next turn immediately. no waiting
  │                                             │   queue, no separate consumer.
  └────────────────────┬───────────────────────┘
      ┌────────────────▼─────────────────────────┐
      │ NDJSON trace stream                        │ → PUSH: producer writes events as
      │                                            │   they happen; reader consumes live.
      │                                            │   one-way, no ack, no replay-on-fail
      └────────────────────────────────────────────┘
```

There's no producer/consumer seam because there's no time-decoupling anywhere —
the control axis never flips from "caller drives" to "queue drives." That
absence is the whole finding: a synchronous system has no queue problems because
it has no queue.

## How it works

### Move 1 — the mental model: a buffer between two speeds

You know the shape from a debounced input or a `ReadableStream` with
backpressure: a buffer sits between something fast and something slow. A queue is
that buffer made durable and remote — the producer enqueues, the consumer
dequeues at its own pace.

```
  The queue kernel (general) — decouple producer from consumer in time

  producer ──enqueue──► [ m1 | m2 | m3 | ... ] ──dequeue──► consumer
                              the buffer                      (slower)
                         absorbs bursts                  acks each message
                                                         on success
```

Three parts, each breaking something if removed:

- **The buffer** — without it, a burst of work overwhelms the consumer
  immediately (no smoothing).
- **The ack** — without it, the queue can't tell a processed message from a lost
  one; a crash mid-process either drops work (at-most-once) or replays it
  (at-least-once → needs idempotency, see `03`).
- **Backpressure** — without it, an unbounded buffer grows until it runs out of
  memory; the producer must be *told to slow down* when the queue fills.

### Move 2 — the analogs, and the absences

**Analog 1: ordering, via the synchronous turn loop.** The agent loop processes
turns in strict sequence — turn N+1 can't start until turn N's tool results are
appended. That's total ordering for free, because there's no concurrency to
reorder anything. A real queue has to *work* for ordering (partition keys,
single-consumer-per-partition); AptKit gets it by being synchronous.

```
  In-order turns — total ordering for free (synchronous)

  turn 0 ──► tool results appended ──► turn 1 ──► ... ──► turn N
       strictly sequential. no message can overtake another because there's
       no queue and no concurrency. ordering is a non-problem here.
```

**Analog 2: streaming, via NDJSON.** Trace events are written to an NDJSON stream
as they occur and consumed live by Studio. It's a *stream* in the loose sense —
ordered, append-only — but it's one-way: no consumer ack, no redelivery on
failure, no offset to resume from. It's a log you tail, not a queue you process.

```
  NDJSON trace — a one-way log, not a queue

  loop emits: step → tool_call_start → tool_call_end → model_usage → ...
                            │ written as newline-delimited JSON
                            ▼
  Studio reads the stream live (display only) — no ack, no replay, no DLQ
```

**The absences (`not yet exercised`), each with its trigger:**

- **Message queue / broker:** none. *Trigger: making agent runs async — enqueue
  a run, process it on a worker, return a job id.*
- **Consumer groups / offsets:** none. *Trigger: multiple workers sharing one
  queue.*
- **Poison messages / DLQ:** none. *Trigger: a durable queue where a malformed
  message could be redelivered forever — you need a dead-letter queue to quarantine
  it after N failures.*
- **Backpressure:** none. *Trigger: a producer that can enqueue faster than the
  consumer drains — you need a bounded buffer + a "slow down" signal.*

### Move 3 — the principle

**A queue is a time machine for work — and every benefit it buys (smoothing,
retries, decoupling) comes with a problem to solve (ordering, poison messages,
backpressure).** Synchronous systems like AptKit dodge all of it by never
decoupling producer from consumer. The senior instinct: don't add a queue for
its buzzword value; add it only when you genuinely need to decouple two
components in *time*, and be ready to own ordering and backpressure when you do.

## Primary diagram

```
  Queue/stream landscape — AptKit's position

  SYNCHRONOUS (AptKit) ─────────── ASYNC QUEUE ─────────── EVENT STREAM
   in-order turn loop                                       (Kafka-style)
   one-way NDJSON log                                        partitions, offsets,
      ▲                                                      consumer groups
      │                                                          ▲
   here: no decoupling,                                  not yet exercised
   ordering & backpressure          not yet exercised     (trigger: durable
   are NON-problems                 (trigger: async         event log + replay)
                                     run hand-off)
```

## Implementation in codebase

**Use cases.** The in-order turn loop runs in every agent. The NDJSON trace
streams during live runs and is persisted into replay artifacts.

**In-order turns — ordering for free.**

```
  packages/runtime/src/run-agent-loop.ts  (lines 98, 189)

  for (let turn = 0; turn < maxTurns; turn += 1) {   ← strictly sequential turns
    ...
    messages.push({ role: 'user', content: toolResults });  ← turn N's output feeds N+1
  }
       │
       └─ no concurrency → no reordering → total ordering with zero machinery.
          a real queue would need partition keys to guarantee this.
```

**The trace as a one-way log.**

```
  packages/runtime/src/events.ts  (lines 1-28)

  type CapabilityEvent = step | tool_call_start | tool_call_end
                       | model_usage | warning | error   ← the event vocabulary
  type CapabilityTraceSink = { emit(event: CapabilityEvent): void };  ← push-only sink
       │
       └─ emit() is fire-and-forget — no ack, no backpressure, no redelivery.
          it's a log you append to, not a queue you consume with guarantees.
```

The NDJSON stream helpers (in `packages/runtime`) serialize these events
newline-delimited; the Studio Vite middleware (`apps/studio`) tails them for
display. No consumer offset, no DLQ, no broker.

**`not yet exercised`:** no broker dependency in any `package.json` (no Kafka,
no Redis, no SQS, no RabbitMQ client), no worker process, no async job table.

## Elaborate

The ordering-vs-throughput tension is the heart of stream systems: Kafka gives
you total order only *within a partition*, trading global ordering for parallel
throughput — and choosing the partition key is the same hard problem as choosing
a shard key (`05`). Backpressure as a first-class concept comes from Reactive
Streams / TCP flow control: the consumer signals capacity upstream so the
producer doesn't overrun it. The dead-letter queue is the operational answer to
poison messages — the one malformed message that, without a DLQ, gets redelivered
forever and wedges the whole consumer. AptKit has none of these because it never
decouples in time; Rein's `me.md` explicitly names hot-path queue infra (Kafka,
Redis Streams) as the gap, so this file teaches the foundation without
pretending the repo exercises it.

## Interview defense

**Q: "How does your system handle message ordering and backpressure?"**

"It doesn't need to — it's fully synchronous. The agent loop processes turns in
strict order on one call stack, so ordering is free and there's no queue to
overflow. The trace is a one-way NDJSON log, not a queue: no acks, no offsets, no
DLQ. The day we make runs async with a worker, ordering and backpressure become
real problems and I'd reach for partition keys and a bounded buffer."

```
  synchronous loop → ordering free, no backpressure problem
  add async worker  → need partition keys (order) + bounded buffer (backpressure)
```

**Q: "What's a poison message and when would AptKit get one?"**

"A message that fails processing every time and, in an at-least-once queue, gets
redelivered forever — wedging the consumer. You quarantine it in a dead-letter
queue after N failures. AptKit can't have one today: no durable queue, no
redelivery. It's `not yet exercised` until there's an async run queue."

## Validate

1. **Reconstruct:** Name the three load-bearing parts of a queue and what breaks
   if each is removed.
2. **Explain:** Why does AptKit get total message ordering "for free"
   (`run-agent-loop.ts:98,189`)?
3. **Apply:** You make agent runs async (enqueue → worker). Name three new
   problems you've just signed up for.
4. **Defend:** Argue that the synchronous design is correct for a library, and
   name the exact trigger that justifies adding a broker.

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — why at-least-once
  queues need idempotent consumers.
- `05-replication-partitioning-and-quorums.md` — partition keys, shared with
  stream partitioning.
- `study-runtime-systems` — the synchronous loop and NDJSON streaming mechanics.
