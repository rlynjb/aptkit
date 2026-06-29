# 07 — Clocks, Coordination, and Leadership

**Industry names:** physical vs logical clocks · wall-clock skew · happens-before / Lamport clocks · leader election · lease · split-brain. **Type:** Industry standard.

## Zoom out, then zoom in

Leadership, leases, and consensus are **`not yet exercised`** — single writer, no election, no lock. What the repo *does* use is **physical wall-clock timestamps** (`new Date().toISOString()`) for ordering, and the lesson is exactly *why that's safe here* and *exactly when it would stop being safe.*

```
  Zoom out — clocks the repo uses, coordination it doesn't

  ┌─ App (single process) ──────────────────────────────────────────┐
  │  timestamp() = new Date().toISOString()  ★ physical clock ★      │ ← we are here
  │  used for: CapabilityEvent ordering, created_at on messages      │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │ writes
  ┌─ Storage ──────────────────────── ▼─────────────────────────────┐
  │  agents.messages ORDER BY created_at  (single-clock source)      │
  │                                                                   │
  │  ┄┄ not yet exercised: leader election, leases, distributed       │
  │     locks, split-brain prevention — there's only one writer ┄┄   │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: in a distributed system, **there is no single "now."** Each node's wall clock drifts independently, so a timestamp from node A is not comparable to one from node B — B's clock might be 200ms ahead. **Leader election** and **leases** exist to designate one node as "the decider" so you don't need clocks to agree. The repo dodges all of this by having *one* clock source and *one* writer. That's not a gap to apologize for — it's the correct design for a single-process tool. The skill is knowing it's a property of the topology, not a guarantee.

## Structure pass — layers, one axis, the seams

**Layers:** event emission (one process, one clock) → persistence (`created_at` from that clock) → ordering reads (`ORDER BY created_at`).

**The one axis: *how many independent clocks contribute to this order?*** Trace it:

```
  "how many clocks decide this ordering?"  — traced down

  ┌──────────────────────────────────────────────┐
  │ timestamp() in runAgentLoop   ONE clock        │  monotonic-enough within
  │                               (this process)   │  one process → safe order
  └────────────────────┬──────────────────────────┘
       ┌───────────────▼──────────────────────────┐
       │ created_at on agents.messages  ONE clock   │  still the app's clock →
       │  (the app stamps it, not the DB)           │  order is meaningful
       └───────────────┬──────────────────────────┘
             ┌─────────▼──────────────────────────┐
             │ TWO+ writer processes (not yet      │  clocks drift → timestamp
             │  exercised)                          │  order LIES → need logical clocks
             └─────────────────────────────────────┘
```

The answer is "one clock" at every live layer, which is why physical timestamps work. The third row — two writers — is where the single-clock assumption breaks and the canon (logical clocks, leader election) becomes necessary. That's the seam.

**The seam:** the (hypothetical) second-writer boundary. As long as one process stamps all events, wall-clock ordering is sound. Add a second process emitting events with its own clock, and the seam appears: their timestamps are no longer comparable, and `ORDER BY created_at` starts lying.

## How it works

### Move 1 — the mental model

You know `Date.now()` drifts — you've seen two machines disagree on the time, and you've seen a clock jump backward when NTP corrects it. Within one process that doesn't bite, because all your timestamps come from the same clock moving (mostly) forward. Across processes it bites hard: B's "later" timestamp can be earlier than A's in real time.

```
  The clock kernel — why one clock orders and two don't

  ONE process (the repo):
    e0 @ 10:00:00.100  →  e1 @ 10:00:00.140  →  e2 @ 10:00:00.180
    same clock, increasing → timestamp order = real order ✓

  TWO processes (not yet exercised):
    proc A: eA @ 10:00:00.300   (A's clock runs 200ms fast)
    proc B: eB @ 10:00:00.180   (B's clock is correct, eB really happened FIRST)
    ORDER BY timestamp → eB, eA  ... but if A's clock is fast, this can LIE ✗
```

The kernel: **a single monotonic-enough clock totally orders its own events; independent clocks don't, because there's no shared "now."** Collapse to one clock (one process, or one designated node) and the problem vanishes.

### Move 2 — walking the mechanism

**Part 1 — the one clock the repo trusts.** Every `CapabilityEvent` gets its timestamp from one function:

```typescript
// packages/runtime/src/events.ts:30-32
export function timestamp(): string {
  return new Date().toISOString();   // physical wall clock, ISO 8601
}
```

This is a *physical* clock (wall-clock time), not a logical one. It's called all over `runAgentLoop` (`:111`, `:127`, `:147`, `:171`, `:220`) and in the providers (`fallback-provider.ts`, `context-window-guard.ts`). Because every one of those calls happens in the *same process*, they read the *same* clock, advancing forward through the run. So the timestamps totally-order the events of a run — and that order is real, not approximate. This is the safe use of a physical clock: **single source, intra-process ordering.**

**Part 2 — the clock crosses to the database, and stays the app's clock.** When `SupabaseTraceSink` persists an event, it writes the *app's* emit timestamp into `created_at` (`supabase-trace-sink.ts:30`, walked in `06`) rather than letting Postgres stamp it. That's a deliberate, correct choice for ordering: the order you care about is *emit order in the app*, and the app's clock is the authority on that. Postgres's `now()` is only the fallback (`coalesce(..., now())`). So even though the data lands in another node, the ordering clock is still the single app clock — the one-clock property is preserved across the boundary.

```
  Layers-and-hops — one clock, carried across the boundary

  ┌─ App (the one clock) ───┐  event.timestamp (app clock)  ┌─ Postgres ─────┐
  │ timestamp() →           │ ─────────────────────────────► │ created_at =   │
  │   new Date().toISOString│                                │  app's stamp,  │
  │                         │  (DB's now() only as fallback) │  not DB's      │
  └─────────────────────────┘                                └────────────────┘
       order authority stays in the app — DB doesn't get to reorder by arrival
```

**Part 3 — happens-before and logical clocks — `not yet exercised`, with the attach point.** The theory that *replaces* wall clocks across nodes is Lamport's **happens-before**: instead of "what time did this happen," you track "did A causally precede B." A **Lamport clock** is a counter each node bumps on every event and includes in every message, so the receiver can advance past it — giving you a consistent *causal* order without synchronized wall clocks. The repo needs none of this because it has one clock. Attach point: the day a second process emits events into the same `agents.messages` (e.g. buffr running two sessions concurrently with their own clocks), `ORDER BY created_at` could misorder causally-related events, and you'd reach for a sequence number assigned at a single point (the DB) or a logical clock.

**Part 4 — leader election, leases, split-brain — `not yet exercised`, with the attach point.** These exist to answer "who's allowed to act when there are many candidates."
- **Leader election** — N nodes agree on one "leader" to make decisions (so they don't conflict). The repo has one writer; there's nothing to elect.
- **Lease** — a *time-bounded* lock: "you're the leader until T, then you must renew or lose it." It's how you make leadership safe against a node that hangs (its lease expires, another takes over). Notice this is the *same missing primitive* as the timeout from `02`, viewed from the coordination side — a lease is a deadline on *authority*.
- **Split-brain** — the failure leases prevent: two nodes both believing they're leader (after a partition), both writing, corrupting state. The repo can't have split-brain because it can't have two leaders.

Attach point for all three: the day buffr runs multiple instances that must coordinate writes (e.g. a leader to own ingestion so two instances don't double-index), you'd need election + leases, and Postgres advisory locks or a coordination service (etcd/ZooKeeper-style) would back them.

### Move 3 — the principle

Wall-clock timestamps order events correctly *only within a single clock's authority*. The repo earns the right to use them because it has one process and one writer — so it gets total ordering for free and needs no coordination at all. The instinct to carry forward: **before trusting a timestamp to order distributed events, count the clocks.** One clock, trust it. Two or more, you need either a single sequencing point (let one node assign order) or logical clocks (track causality, not time). Leadership and leases are how you *create* that single authority when no single node is naturally it — and they're a deadline on authority, the coordination-side twin of the request timeout.

## Primary diagram

Every clock and coordination point, exercised and not.

```
  Clocks & coordination map

  ┌─ App process (ONE clock) ──────────────────────────────────────┐
  │  timestamp() = new Date().toISOString()  (physical wall clock)  │
  │   → CapabilityEvent.timestamp (orders a run, intra-process) ✓   │
  └──────────────────────────────────┬──────────────────────────────┘
                                     │ app's clock carried across
  ┌─ Storage ──────────────────────── ▼─────────────────────────────┐
  │  agents.messages.created_at = app stamp (DB now() = fallback)   │
  │   ORDER BY created_at → emit order, sound while ONE writer       │
  │                                                                  │
  │  ┄┄ NOT YET EXERCISED ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
  │  2+ writers → clocks drift → need logical clocks / DB sequence  │
  │  leader election · lease (= deadline on authority) · split-brain│
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason "just use timestamps" fails at scale is clock skew: even with NTP, machine clocks differ by milliseconds to seconds, and they can jump *backward* on correction. Google's Spanner famously attacked this with TrueTime — GPS and atomic clocks giving a bounded uncertainty interval — so it could use physical time for global ordering by *waiting out* the uncertainty. Everyone without an atomic clock budget uses logical clocks (Lamport, vector clocks) or a single sequencer instead.

The lease-as-deadline-on-authority framing ties this file to `02`. A request timeout bounds how long you'll *wait* for a node; a lease bounds how long a node is *trusted to lead*. Both convert "this node might be hung forever" into "this node is presumed dead after T." It's the same idea — a clock racing a hang — applied to data on one side and authority on the other. Recognizing them as the same primitive is the kind of connection that signals you actually understand the field, not just the vocabulary.

## Interview defense

**Q: "You order events by a wall-clock timestamp. Isn't that dangerous in a distributed system?"**
"It's dangerous across nodes, safe here, and I know exactly why. Every timestamp comes from one process's clock — `new Date().toISOString()` at `events.ts:30` — and `SupabaseTraceSink` persists *that* stamp into `created_at`, not the DB's. One clock totally-orders its own events, so `ORDER BY created_at` is sound. It breaks the day a second writer with its own clock emits into the same table — then I'd need a single sequencing point or a logical clock. Counting the clocks is the test."

```
  one clock → timestamp orders correctly
  two clocks → timestamps not comparable → need a sequencer / Lamport clock
```

Anchor: *count the clocks before trusting a timestamp; one clock is safe, two lie.*

**Q: "Why no leader election or locks?"**
"One writer — nothing to elect, nothing to lock against. I'd flag the connection to `02`: a lease is just a deadline on *authority*, the same way a timeout is a deadline on a *call*. The day buffr runs multiple coordinating instances — say, one must own ingestion so two don't double-index — I'd add election plus leases, backed by Postgres advisory locks or a coordination service. Today it's `not yet exercised`, and adding it now would be coordination overhead for a problem the repo doesn't have."

Anchor: *single writer means no split-brain is possible; a lease is a timeout on leadership.*

## See also

- `02-partial-failure-timeouts-and-retries.md` — the timeout is the deadline-on-a-call twin of the lease
- `06-queues-streams-ordering-and-backpressure.md` — the timestamp that recovers stream order (sound because one clock)
- `05-replication-partitioning-and-quorums.md` — failover is what leader election would back
- `study-database-systems` — Postgres advisory locks, transaction timestamps, MVCC snapshots
- `study-debugging-observability` — reading the timestamped trace to reconstruct what happened
