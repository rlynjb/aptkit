# 07 — Clocks, Coordination, and Leadership

**Industry names:** wall-clock vs logical clock · ordering events · happens-before · leader election · lease · split-brain — *Industry standard.*

## Zoom out, then zoom in

This file is half real, half curriculum. The **real** half: the trace orders events
by a timestamp captured at emit, which is the repo's one genuine "use a clock to
order events that raced" decision (file 06 introduced it; here's the full why). The
**curriculum** half: leader election, leases, and split-brain — all `not yet
exercised`, because there's only ever one writer.

```
  Zoom out — where time is used to order things

  ┌─ App: runAgentLoop ─────────────────────────────────────────────────┐
  │  timestamp() = new Date().toISOString()  ── captured AT EMIT          │ ← the real clock use
  │  emit({ ..., timestamp })                                            │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ written into created_at
  ┌─ Postgres: agents.messages ──▼───────────────────────────────────────┐
  │  ORDER BY created_at  ← reconstructs emit order despite racing inserts │ ← we are here
  │                                                                        │
  │  ┌╌ leader election ╌┐  ┌╌ lease ╌┐  ┌╌ split-brain ╌┐  NOT YET        │
  │  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  └╌╌╌╌╌╌╌╌╌┘  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  (one writer)   │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: in a distributed system, **you cannot trust a clock to order events across
machines** — two machines' clocks drift, so machine A's "10:00:00.5" might really be
before machine B's "10:00:00.4". That's why distributed systems use *logical* clocks
(counters that encode "happened-before") instead of wall time. aptkit gets away with
*wall* time for one specific reason — all timestamps come from **one machine** — and
recognizing *why* that's safe here (and when it would stop being safe) is the lesson.

## Structure pass

**Layers.** Event creation (one machine's clock) → buffer → ordering at read
(`ORDER BY created_at`).

**Axis — trace `whose clock decides order?` across the system.**

```
  Axis — "whose clock stamps this event?" — and is that safe?

  ┌─ emit in runAgentLoop ─────────────────────┐
  │  timestamp() — ONE machine's Date.now()     │  → single clock source ✓
  └──────────────────────┬──────────────────────┘
       ┌─────────────────▼────────────────────────┐
       │ written to created_at on insert           │  → still that one machine's time ✓
       └─────────────────┬────────────────────────┘
            ┌────────────▼──────────────────────────┐
            │ (if a SECOND machine emitted events)   │  → two clocks, drift → WRONG order
            └─────────────────────────────────────────┘     NOT YET EXERCISED
```

**Seam.** The safety hinges on a single seam: *all* timestamps originate on one
machine, so they share one clock and are totally ordered. The instant a second
machine emits events into the same `agents.messages` table, the wall-clock ordering
becomes unreliable (clock drift) and you'd need logical clocks. The seam between
"one clock" and "many clocks" is where wall time stops working — and aptkit is firmly
on the safe side, which is why the simple approach is correct.

## How it works

### Move 1 — the mental model: a timestamp is a position, and positions must come from one ruler

You measure two lengths with the same ruler and you can compare them. Measure them
with two *different* rulers that disagree, and the comparison is meaningless. A
timestamp is a position on a timeline; comparing positions is only valid if they came
from the *same clock*. Wall-clock ordering works when there's one ruler; it breaks
when there are two that drift.

```
  The clock-ordering kernel — one ruler vs two rulers

  ONE machine (aptkit today):
    e1 @ 10:00:00.100   e2 @ 10:00:00.150   e3 @ 10:00:00.200
    ORDER BY timestamp → e1, e2, e3   ✓  (same ruler → comparable)

  TWO machines (not yet exercised):
    machine A clock:  e1 @ 10:00:00.100
    machine B clock:  e2 @ 10:00:00.090   ← B's clock is 60ms behind A's!
    ORDER BY timestamp → e2, e1   ✗  (e2 looks earlier but really happened LATER)
```

### Move 2 — walking the mechanism

**Step 1 — the clock is read once, at emit, on one machine.** `timestamp()` is the
whole clock abstraction — a single function, one source:

```ts
// packages/runtime/src/events.ts:30-32
export function timestamp(): string {
  return new Date().toISOString();   // ← one machine's wall clock, ISO-8601 (sortable as text)
}
```

Every `emit` calls this *at the moment the event happens*, inside the single-threaded
loop. Because it's one machine and one thread, successive calls are monotonic-enough
in practice and totally ordered. ISO-8601 strings also sort lexicographically in the
same order as chronologically, so `ORDER BY created_at` on a text/timestamp column
just works.

**Step 2 — the timestamp travels with the event and becomes the row's position.**
This is the file-06 fix, viewed as a clock decision. The emit-time stamp is carried
all the way into `created_at` so the *racing inserts* don't decide order — the
*clock at emit* does:

```ts
// buffr/src/supabase-trace-sink.ts:53 + persistMessage:26-30
const at = event.timestamp;                           // ← emit-time stamp, not insert-time
// persistMessage:
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
//   values (..., coalesce($8::timestamptz, now()))    // ← prefer emit time; fall back to now()
```

The annotation that matters: `coalesce($8, now())` prefers the *emit* timestamp and
only falls back to the *server's* `now()` if the event somehow lacked one. That
preference is the correctness choice — it means order is decided by *when the event
happened*, not by *when its insert happened to land*. The comment in the file says it
exactly: "replay order matches emit order rather than the race between concurrent
flush inserts."

**Step 3 — why wall-clock is enough here (and the line where it isn't).** This is the
honest boundary. aptkit uses *wall* time, not a *logical* clock (Lamport timestamp,
vector clock), and that's correct because:

```
  Comparison — wall clock here vs logical clock when you'd need one

  condition                         aptkit today          would force logical clocks
  ────────────────────────────────  ───────────────────   ──────────────────────────────
  who stamps events?                ONE machine           two+ machines (clock drift)
  ordering basis                    Date.now() at emit    happens-before counters
  safe?                             YES (single clock)    wall time WRONG under drift
  what it'd look like               created_at ISO        per-event sequence/Lamport ts
```

A logical clock (a counter that increments on each event and on each message
received) encodes *happens-before* without trusting wall time — it's what you reach
for the moment two machines must agree on order. aptkit doesn't need it because there
is exactly one event source. Naming this is the signal: "I used wall time *because*
it's single-source; I'd switch to logical clocks the moment a second writer appeared."

**Step 4 — leadership: there's only one writer, so there's nothing to elect.**
Leader election, leases, and split-brain are all `not yet exercised`, and the reason
is structural:

```
  Layers-and-hops — why no leader is needed (and where one would attach)

  ┌─ ONE buffr process ─┐   the ONLY writer    ┌─ Postgres ─┐
  │  ChatSession.ask()  │ ───────────────────► │  messages  │
  │  (single writer)    │                      │  chunks    │
  └─────────────────────┘                      └────────────┘
       no second writer → no contention → no leader to elect → no split-brain

  IF buffr ran N indexer workers competing to index the same docs:
  ┌─ worker 1 ─┐  ┌─ worker 2 ─┐  ┌─ worker 3 ─┐
  │  who indexes which doc?     │  → THEN you need a lease / leader to avoid
  └─────────────┘  └────────────┘  └────────────┘    double-work and split-brain
```

A leader exists to make *one* node the decision-maker when *many* could act. With one
writer, the question never arises. Split-brain — two nodes both believing they're the
leader and diverging — requires two would-be leaders; there's one. This stays
curriculum until buffr runs multiple workers that contend for the same write
authority (e.g., a pool of indexers), at which point a lease (a time-bounded,
renewable claim on "I am the indexer") is the lightweight answer.

### Move 3 — the principle

Time in distributed systems has two jobs that people conflate: **timeout** (a budget,
file 02 — "how long until I give up?") and **ordering** (a position — "what happened
before what?"). For timeouts, any local clock works. For ordering *across machines*,
wall clocks fail because they drift, so you use logical clocks that encode
happens-before. aptkit needs ordering but has one clock source, so wall time is a
valid logical clock *by accident of being single-source*. The principle: **wall-clock
ordering is correct exactly when all events share one clock; the moment they don't,
you need a logical clock or a single coordinator.**

## Primary diagram

```
  Clocks in aptkit — one clock orders everything; no leader needed

  ┌─ ONE machine, ONE thread: runAgentLoop ─────────────────────────────┐
  │  timestamp() = Date.now()  ── single clock source, totally ordered ✓ │
  │  emit({ ..., timestamp })                                            │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ created_at = coalesce(emit_ts, now())
  ┌─ Postgres: agents.messages ──▼───────────────────────────────────────┐
  │  ORDER BY created_at → emit order, immune to insert race ✓            │
  └─────────────────────────────────────────────────────────────────────┘

  NOT YET (all require ≥2 competing actors):
  ┌╌ leader election ╌┐ ┌╌ lease ╌┐ ┌╌ split-brain ╌┐ ┌╌ logical/vector clocks ╌┐
  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ └╌╌╌╌╌╌╌╌╌┘ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘ └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
   would attach if buffr ran multiple writers/workers contending for the same data
```

## Elaborate

The wall-clock-vs-logical-clock distinction is one of the most clarifying ideas in
distributed systems, and aptkit is a clean place to see *why* single-source wall time
is safe. Lamport's "Time, Clocks, and the Ordering of Events" (1978) is the origin:
the insight that physical time can't order distributed events, so you need a logical
counter that captures *causality* (if A sends a message that B receives, A's event
happened-before B's). Vector clocks extend this to detect *concurrent* (causally
unordered) events. aptkit needs neither because its events form a single sequential
chain on one machine — but the `created_at`-prefer-emit-time choice is genuinely the
same *kind* of thinking: don't let the physical mechanism (insert arrival) decide
logical order; attach the logical position to the event.

Leases deserve a mention because they're the pragmatic, real-world face of "leader
election" most engineers actually touch: a lease is a lock with a TTL — you hold "I'm
the indexer" for 30 seconds, renew it, and if you die, it expires and someone else
takes over. It avoids the split-brain trap of a lock with no expiry (holder dies →
lock held forever). It would be the first coordination primitive buffr reached for if
it scaled to multiple workers — far before full Raft/Paxos consensus.

## Interview defense

**Q: "You order trace events by timestamp — isn't that unsafe in distributed
systems?"**
"It would be if the timestamps came from multiple machines, because clock drift makes
cross-machine wall-clock ordering unreliable. But here every timestamp comes from one
machine, one thread — `timestamp()` in `events.ts` — so they share a single clock and
are totally ordered. That's why I can safely write the emit time into `created_at` and
`ORDER BY created_at` to recover emit order despite the inserts racing. The instant a
second machine emitted into the same table, I'd switch to logical clocks — but
single-source wall time is correct, not lucky."

```
  sketch

  ONE clock → timestamp() at emit → created_at → ORDER BY created_at = emit order ✓
  TWO clocks (drift) → wall time wrong → need Lamport/vector clocks
```

**Q: "Do you need leader election?"** — the honest answer:
"No, and the reason is structural: there's one writer. Leader election exists to pick
one decision-maker when many could act; with a single buffr process writing, there's
no contention to arbitrate and no split-brain to prevent. It'd become relevant if I
ran multiple indexer workers competing to index the same documents — then I'd reach
for a *lease* (a TTL'd claim) long before full consensus, because a lease handles the
'holder died' case that a plain lock can't."

*Anchor:* one clock source makes wall-time ordering valid; one writer makes leader
election unnecessary; both flip the moment a second actor appears.

## See also

- `06-queues-streams-ordering-and-backpressure.md` — the racing-inserts problem this clock solves
- `02-partial-failure-timeouts-and-retries.md` — time's *other* job: timeouts, not ordering
- `05-replication-partitioning-and-quorums.md` — multiple writers is where leadership attaches
- **study-database-systems** — `timestamptz`, `now()`, and how Postgres orders rows
```
