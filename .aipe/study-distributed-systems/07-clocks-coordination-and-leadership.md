# 07 — Clocks, coordination, leadership

**Industry name(s):** physical vs logical clocks / Lamport timestamps / vector
clocks / leases / leader election / split-brain. **Type:** Industry standard.
**Status in AptKit:** `not yet exercised` (no coordination, no leadership);
ISO wall-clock timestamps on events are the only time machinery, and they're
display-only.

## Zoom out, then zoom in

AptKit has no coordination problem because it has no concurrent writers and no
multiple processes to coordinate. The only time-related code is the ISO
timestamp stamped on each trace event — wall-clock time, used for ordering the
log *for humans*, never for deciding causality or breaking ties between nodes.

```
  Zoom out — where coordination would live (none here)

  ┌─ Service layer (one process, no concurrent writers) ─────────┐
  │  timestamp() ── ISO wall-clock on each CapabilityEvent         │ ← only time use
  │  (display ordering only — never used to decide who wins)       │
  └───────────────────────────────────────────────────────────────┘

  no logical clocks · no leases · no leader election · no split-brain risk
```

Zoom in: in a distributed system you can't trust wall clocks — they drift, and
two nodes' clocks disagree, so you can't use a timestamp to decide which of two
events "happened first." **Logical clocks** (Lamport timestamps, vector clocks)
solve this by counting *causality* instead of time. **Leases** and **leader
election** solve a different problem: when N nodes must agree on *one* coordinator
(who's the primary?), and the nightmare is **split-brain** — two nodes both
believing they're the leader. AptKit has one process, so there's no "who's in
charge" question and no clock-disagreement question.

## Structure pass — layers, axis, seam

Trace the **control axis** — "who decides, and how is that decision agreed?":

```
  "who decides, and how is it agreed?" — down the layers

  ┌────────────────────────────────────────────┐
  │ the single process                          │ → IT decides everything. no peer
  │                                             │   to agree with → no election.
  └────────────────────┬───────────────────────┘
      ┌────────────────▼─────────────────────────┐
      │ event timestamps (ISO wall-clock)          │ → used to ORDER the log for
      │                                            │   display. never to break ties
      │                                            │   between nodes (there are none).
      └────────────────────────────────────────────┘
```

No seam flips here: control never moves between peers, time never has to
reconcile between clocks. The single-process design makes both the leadership
question and the clock-trust question vanish.

## How it works

### Move 1 — the mental model: counting causality, not time

You know wall-clock time from `Date.now()`. The distributed twist: two machines'
`Date.now()` disagree (clock skew), so if node A stamps an event at 10:00:01 and
node B stamps one at 10:00:00, you *cannot* conclude B happened first — B's clock
might just be slow. Lamport's fix: each node keeps a counter, increments it on
every event, and on receiving a message takes `max(local, received) + 1`. The
counter respects causality even when clocks lie.

```
  Lamport clock — counting causality (general)

  node A:  e1(1) ── send ──► node B
  node B:  e2(1), receives msg(1) → clock = max(1,1)+1 = 2 ── e3(3)

  rule: if A causally-precedes B, then clock(A) < clock(B).
  (the converse isn't guaranteed — that's what vector clocks add.)
```

The load-bearing insight people forget: **a logical clock orders causally-related
events correctly but says nothing about concurrent ones** — that's deliberate,
and it's why wall-clock timestamps are dangerous as tie-breakers across nodes.

### Move 2 — the analog, and the absences

**The analog: wall-clock timestamps, used safely because there's one clock.**
Every `CapabilityEvent` carries an ISO timestamp from a single process's clock.
Because there's exactly one clock, the timestamps *are* a valid total order — no
skew between nodes to worry about. AptKit can use naive wall-clock time precisely
because it's not distributed; the moment a second process stamps events, those
timestamps stop being comparable and you'd need logical clocks.

```
  One clock → timestamps are safe (AptKit)

  process: e1(10:00:01) → e2(10:00:02) → e3(10:00:03)
       one monotonic source → total order is real, not an illusion.
       (with two processes, this breaks: their clocks disagree.)
```

**The absences (`not yet exercised`), each with its trigger:**

- **Logical / vector clocks:** none. *Trigger: ≥2 processes generating events
  that must be causally ordered.*
- **Leases (time-bounded locks):** none. *Trigger: a resource only one node may
  hold at a time, where the holder might crash.*
- **Leader election:** none. *Trigger: ≥2 processes that must agree on a single
  coordinator (e.g. one worker that owns a queue partition).*
- **Split-brain prevention (fencing, quorum):** none. *Trigger: a leader-elected
  system where a network partition could let two nodes both claim leadership.*

### Move 3 — the principle

**Wall-clock time is a lie across nodes; coordination is about agreeing despite
that lie.** A single-process system gets to trust its clock and skip coordination
entirely — there's no one to disagree with. The senior instinct: the second you
have two nodes that both write or both want to be in charge, stop trusting
timestamps for ordering and stop assuming "obviously one of them is the leader" —
you now need logical clocks and a real election protocol, or you'll ship a
split-brain bug.

## Primary diagram

```
  Coordination landscape — AptKit's position

  ONE PROCESS (AptKit) ──────── LOGICAL CLOCKS ──────── LEADER ELECTION
   wall-clock timestamps                                 (Raft/ZooKeeper)
   are a valid total order                               leases, fencing,
      ▲                                                  split-brain defense
      │                                                       ▲
   here: one clock, one                              not yet exercised
   decider → no skew, no         not yet exercised    (trigger: ≥2 nodes
   election, no split-brain      (trigger: ≥2 event    agreeing on one leader)
                                  sources to order)
```

## Implementation in codebase

**Use cases.** Timestamps are stamped on every trace event for display ordering
in Studio and in persisted artifacts.

**The only time machinery — wall-clock, display-only.**

```
  packages/runtime/src/events.ts  (lines 30-32)

  export function timestamp(): string {
    return new Date().toISOString();   ← single-process wall clock, ISO 8601
  }
       │
       └─ used at run-agent-loop.ts:120,128,152,178 and in fallback/context-guard
          warnings. it ORDERS the log for humans. it is NEVER compared across nodes
          to decide causality — because there's only one node stamping it.
```

Sample call sites that stamp it: `run-agent-loop.ts:120` (model_usage),
`:128` (step), `:152` (tool_call_start), `:178` (tool_call_end);
`fallback-provider.ts:82` (warning); `context-window-guard.ts:65` (warning).

**`not yet exercised`:** no lock library, no `etcd`/`ZooKeeper`/`Consul` client,
no lease logic, no election code, no fencing tokens anywhere in the repo.

## Elaborate

Lamport's 1978 "Time, Clocks, and the Ordering of Events" is the foundational
paper of the field — it's where the happens-before relation comes from. Vector
clocks extend it to detect *concurrency* (two events with no causal link), which
Lamport timestamps can't. Leader election protocols (Paxos, Raft, the Bully
algorithm) and the split-brain defenses around them (fencing tokens, quorum-based
leadership) are the machinery behind every replicated database's "who's the
primary" answer. AptKit needs none of it — and Rein's `me.md` names exactly this
("multi-region," "load balancing under sustained traffic") as the unbuilt
territory — so this file teaches the foundation and is honest that the repo's only
time code is a single-process `Date.now()`.

## Interview defense

**Q: "How do you order events in your system? Can you trust the timestamps?"**

"Yes — but only because it's single-process. There's one clock stamping every
event, so the ISO timestamps are a valid total order. That trust *evaporates* the
moment a second process stamps events: clock skew means I couldn't compare them,
and I'd switch to Lamport or vector clocks to order by causality instead of
time."

```
  one clock  → timestamps = real total order (AptKit)
  two clocks → timestamps lie → need logical clocks (counting causality)
```

**Q: "What's split-brain and could AptKit have it?"**

"Two nodes both believing they're the leader after a partition — they both act as
primary and corrupt state. AptKit can't have it: one process, no leadership
question, no election. It's `not yet exercised` until there are ≥2 nodes
electing a coordinator, at which point I'd need fencing tokens or quorum-based
leadership to prevent it."

## Validate

1. **Reconstruct:** State the Lamport clock update rule and what guarantee it
   gives (and doesn't).
2. **Explain:** Why is it safe for AptKit to use wall-clock `Date.now()`
   timestamps for ordering (`events.ts:30-32`) when a distributed system can't?
3. **Apply:** You split the agent loop into a coordinator + N workers. What two
   coordination problems appear, and what defends against split-brain?
4. **Defend:** Argue that single-process design eliminates both the clock-trust
   and the leadership problem, citing where the only timestamp lives.

## See also

- `05-replication-partitioning-and-quorums.md` — leader/follower replication, the
  home of leader election.
- `03-idempotency-deduplication-and-delivery-semantics.md` — the event log the
  timestamps order.
- `study-runtime-systems` — single-process execution and time.
