# Replication and Read Consistency

**Industry name:** streaming replication / read replicas / replica lag / stale reads · *Industry standard*

## Zoom out — where replication would sit (but doesn't)

This is the most honest file in the guide: buffr has **no replication**. One
Supabase primary, one connection pool, every read and write hitting the same
node. Here's the shape — with the box that *doesn't exist* drawn dashed so you
can see the gap:

```
  Zoom out — buffr's topology (single primary)

  ┌─ Application (buffr) ──────────────────────────────────────┐
  │  createPool(DATABASE_URL)  (db.ts:5) — one pool, one URL    │
  └───────────────────────────┬────────────────────────────────┘
                              │ reads AND writes
  ┌─ Primary (Supabase Postgres) ────────▼─────────────────────┐
  │  ★ the only node — reads + writes both land here ★         │ ← we are here
  └────────────────────────────────────────────────────────────┘
            ┊  (would stream WAL to...)
  ┌─ Read replica ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┐
  ┊  DOES NOT EXIST — not yet exercised             ┊
  └┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┘
```

## Zoom in — what this file covers

The question: **does buffr ever read stale data from a replica?** Answer: no,
because there is no replica — every read is read-your-writes consistent by
construction. This file teaches what replication *would* introduce, so you can
recognize the consistency problems buffr has *avoided* by staying single-node,
and name when they'd appear.

## Structure pass

**Layers.** Single-primary (what buffr runs) → primary + async replicas (what
buffr would grow into). The consistency model flips entirely between them.

**Axis — trace "can a read see a write that already committed?"**

```
  One question across topologies: "read-your-writes?"

  single primary (buffr today)  → ALWAYS. write commits, next read sees it.
  primary + sync replica        → yes, but writes are slower (wait for replica)
  primary + async replica       → NO guarantee. replica lags; a read routed
   (route reads to replica)        there can miss a just-committed write

  buffr sits at the leftmost column — strongest consistency, zero
  config — precisely because it never added a replica
```

**Seam.** The seam *would be* the read-routing decision — "send this read to
the primary or a replica?" — and it does not exist in buffr. There's one pool,
one URL (`db.ts:5`), so every read goes to the writer. The consistency
question never arises because the routing seam was never created.

## How it works

### Move 1 — the mental model

Replication is the same idea as a cache that follows a source of truth: the
primary is canonical, replicas are copies kept current by replaying the
primary's change stream (the WAL, → `07`). The catch is the same as any cache
— the copy can be *behind*. Read from a lagging replica right after a write and
you see the old value: a stale read.

```
  Async replication — and where staleness enters

  ┌─ Primary ─┐  WAL stream   ┌─ Replica ─┐
  │ write X=2 │ ────────────► │ X=1 still │  ← replica hasn't applied
  │ commit    │  (lag: ms-s)  │           │     the WAL record yet
  └─────┬─────┘               └─────┬─────┘
        │ read X → 2 (fresh)        │ read X → 1 (STALE)
        ▼                           ▼
   read-your-writes            broken read-your-writes

  buffr only ever has the LEFT node, so only the fresh read exists
```

### Move 2 — the moving parts

**One pool, one node — the whole topology.** buffr's data access is a single
`pg.Pool` over a single `DATABASE_URL`:

```ts
// buffr/src/db.ts:1-6
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}
//   ^ one URL → one primary. No read-replica URL, no routing logic,
//     no "reads here, writes there" split anywhere in buffr.
```

A connection pool is *not* replication — it's several connections to the
*same* node. The vector search (`pg-vector-store.ts:67`) and the chunk upsert
(`pg-vector-store.ts:38`) both draw from this one pool, both hit the primary.
The consequence: index a document, then search — the search always sees the
just-written chunks. Read-your-writes holds for free.

**Read consistency buffr gets for free.** Because there's one node:

```
  buffr's read-your-writes — guaranteed by topology, not config

  session.ask(q):
    persistMessage(user turn)   ─► primary   (commit)
    agent.answer(q)
      └ search_knowledge_base   ─► primary   ← sees every prior commit
    memory.remember(turn)       ─► primary   (commit)
    next ask() recalls it       ─► primary   ← memory is immediately findable
```

The episodic memory loop (`session.ts:60-71`) depends on this without stating
it: `remember` writes to the store, and a *future* turn's
`search_knowledge_base` must find it. On a single primary that's automatic. On
an async replica, a memory written one turn could be missing from the next
turn's recall if that read hit a lagging replica — the conversation would
"forget" something it just learned. buffr never risks this because it never
splits reads off the primary.

**What replication would cost — named, not invented.** If buffr ever needed
read replicas (it doesn't — single user), three problems arrive at once, and
the code would have to answer each:

- **Replica lag** — async replicas trail the primary by milliseconds to
  seconds. The vector search routed to a replica could miss freshly indexed
  chunks.
- **Stale reads / read-your-writes breakage** — the memory-recall loop above
  breaks unless writes-then-reads are pinned to the primary or the session is
  sticky.
- **Failover** — if the primary dies and a replica is promoted, any writes
  that hadn't replicated are lost (with async). buffr's best-effort memory
  write (`07`) already tolerates loss; the chunk upserts would not.

All three are `not yet exercised`. The right framing: buffr has the *strongest*
read consistency a Postgres app can have, and it got there by not scaling out.
That's a legitimate choice for a single-user laptop runtime — you don't add
replicas you don't need just to practice the consistency problems they bring.

**Failover and HA — Supabase's territory.** Whatever high-availability
Supabase provides (standby promotion, connection re-routing) is managed and
unconfigured by buffr (`not yet exercised`). buffr's only resilience code is
the pool itself reconnecting and the best-effort memory swallow — there's no
retry-on-failover, no read-replica fallback, no health check. At single-user
scale, a primary outage simply means the CLI errors and the user retries.

### Move 3 — the principle

Replication trades read scalability for consistency: more nodes to read from,
but now a read can be stale and a failover can lose un-replicated writes.
Read-your-writes — "after I commit, my next read sees it" — is free on a single
primary and becomes something you have to *engineer* (sticky sessions, primary
pinning, sync replicas) the moment you scale reads out. The instinct worth
keeping: don't add replicas to look scalable. Add them when read load actually
demands it, and budget for the consistency work that comes with them.

## Primary diagram

```
  Replication recap — buffr

  WHAT EXISTS                          WHAT DOESN'T (not yet exercised)
  ───────────                          ───────────────────────────────
  one pg.Pool (db.ts:5)                read replicas
  one DATABASE_URL                     read/write routing seam
  one Supabase primary                 replica-lag handling
  reads + writes → same node           stale-read mitigation
                                       failover/promotion logic
  CONSISTENCY buffr HAS                 sync-vs-async replica choice
  ─────────────────────
  read-your-writes (free, by topology)
  memory recall always sees prior remember()
  no stale reads possible — there's nowhere stale to read from
```

## Elaborate

This file is mostly about a problem buffr doesn't have, and that's the point: a
study guide that invents a replication tier to look complete would be lying.
The single-primary choice is the same instinct as AdvntrCue colocating vector
and relational data in one Postgres — keep the topology flat until load forces
your hand, because every node you add is a consistency boundary you now own.
The bridge to distributed systems (the neighboring guide): replica lag is just
the CAP tradeoff made concrete — under a partition you pick the stale read
(availability) or the blocked read (consistency), and async replication has
silently chosen availability for you. buffr sidesteps the whole tradeoff by
having one node, which is the most honest thing a single-user app can do.

## Interview defense

**Q: How do you handle replica lag and stale reads?**
I don't have to — buffr is a single Supabase primary, one connection pool, one
URL. Every read and write hits the same node, so read-your-writes is free: I
index a doc and the next search sees it; I `remember` a turn and the next turn
recalls it. There's nowhere stale to read from.

```
  one pool → one primary → reads + writes same node → no staleness
```

**Q: What breaks if you add read replicas?**
Three things at once: the vector search could miss freshly indexed chunks off
a lagging replica; the conversation-memory recall loop breaks read-your-writes
unless I pin writes-then-reads to the primary; and async failover could lose
un-replicated writes. I'd only take that on when read load demanded it — not to
look scalable.

**Anchor:** "Single primary, so read-your-writes is free — I avoided every
replication consistency problem by not having replicas I don't need."

## See also

- `07-wal-durability-and-recovery.md` — the WAL stream replicas would consume.
- `06-locks-mvcc-and-concurrency-control.md` — single-node concurrency, no cross-replica coordination.
- study-distributed-systems — replica lag as the CAP tradeoff made concrete.
- study-system-design — when buffr's topology would need to scale out.
