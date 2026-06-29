# 08 · Replication and Read Consistency

**Industry name(s):** streaming replication, read replicas, replication lag, stale reads, failover. **Type:** Industry standard.

## Zoom out, then zoom in

Replication is "keep a second copy of the database so reads can scale and a failover has somewhere to go." You know the read-your-own-write problem from frontend: you POST an update, immediately GET, and the GET hits a stale cache that hasn't seen your write. Replication lag is that exact problem at the database tier. The headline here is short and honest: **buffr uses one Postgres endpoint, one connection pool, no replicas.** So this file teaches the mechanism and names precisely where it would attach — almost all of it is `not yet exercised`.

```
  Zoom out — where replication would sit (but doesn't, yet)

  ┌─ Application (buffr) ──────────────────────────────────┐
  │  one pg.Pool → one DATABASE_URL → one Postgres endpoint │
  └────────────────────────────┬────────────────────────────┘
                               │  every read AND write
  ┌─ Postgres (Supabase) ──────▼────────────────────────────┐
  │  PRIMARY (single)                                        │ ← we are here
  │  ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ │
  │  read replica(s): NONE wired (Supabase could provide)    │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **read consistency under replication** — when you have copies, which copy does a read hit, and how stale can it be? buffr's answer today is trivially strong: there's one copy, so every read is up-to-date, no lag, no stale reads. That simplicity is a *choice* (single-tenant laptop runtime), and the file's job is to show what changes the moment a replica appears.

## The structure pass

**Layers.** Replication concerns three altitudes: the connection layer (how many endpoints the app talks to — buffr: one), the routing layer (which reads go to a replica — buffr: none), and the engine (WAL streaming from primary to replica — buffr: not configured).

**Axis — trace "how fresh is a read, and where does it go?":**

```
  One question down the layers: "read freshness and destination?"

  ┌─ connection (buffr) ────────────────────┐
  │  one pg.Pool, one DATABASE_URL           │ → all reads hit the PRIMARY
  └──────────────────────────────────────────┘
  ┌─ routing ────────────────────────────────┐
  │  no read/write split                      │ → no routing decision exists
  └──────────────────────────────────────────┘
  ┌─ engine ─────────────────────────────────┐
  │  no replica → no WAL stream → no lag      │ → reads ALWAYS fresh (trivially)
  └──────────────────────────────────────────┘

  freshness is perfect BECAUSE there is one copy — not because lag is handled
```

**Seam.** The boundary that *would* matter is the read/write split — the routing decision "send this read to a replica or the primary." It doesn't exist in buffr (one pool, `buffr/src/db.ts:4-6`). Naming the absent seam is the lesson: the moment you add a replica, that seam appears, and with it the stale-read problem.

## How it works

### Move 1 — the mental model

Replication is the WAL (07) put to a second use: instead of only replaying the log locally for crash recovery, *stream* it to another Postgres that replays it to stay a copy. The replica is always slightly behind — it's replaying a log that's still being written — and that gap is replication lag.

```
  Streaming replication — the WAL as a feed to a copy

  PRIMARY                                    REPLICA
  ┌──────────────┐  WAL stream (async)       ┌──────────────┐
  │ writes commit│ ────────────────────────► │ replays WAL  │
  │ WAL appended │                           │ stays behind │
  └──────────────┘                           └──────────────┘
       ▲                                          ▲
   writes go here                          reads CAN go here
                                           but see state from
                                           "lag" milliseconds ago  ◄ stale-read window
```

The kernel: **the replica replays the primary's WAL and is always `lag` behind.** A read routed to the replica sees the database as of `now - lag`. Read your own write through a replica inside that window, and you don't see your write — the canonical stale read.

### Move 2 — the walkthrough

**The single endpoint — one pool, everything.** buffr's entire connection story is one function:

```ts
// buffr/src/db.ts:4-6
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });   // ONE url, ONE pool
}
```

One `DATABASE_URL` (`config.ts:11`), one `pg.Pool`, shared by every read and every write. The chat session creates exactly one pool and holds it for the session lifetime (`buffr/src/session.ts:39, 72-74`). Searches, upserts, message inserts, profile reads — all go through this single pool to the single primary. There is no second connection string, no replica URL, no read-only pool. So there is no routing decision to get wrong, and no lag to reason about: **every read is strongly consistent because there's only one copy.**

**Read-your-own-write — currently free, the moment a replica appears it's not.** The session's flow is read-after-write heavy: index a document, then immediately search it; remember a turn, then recall it next turn (`session.ts:60-70`). Today that's safe — the search hits the same primary the upsert committed to, so it sees the write. Trace what breaks if you add a replica and route searches to it:

```
  Layers-and-hops — read-your-own-write, today vs with a replica

  TODAY (one primary)                      WITH A REPLICA (hypothetical)
  ┌─ session ─┐ upsert → PRIMARY           ┌─ session ─┐ upsert → PRIMARY
  │           │ search → PRIMARY ✓ fresh   │           │ search → REPLICA
  └───────────┘                            └───────────┘          │
                                                      lag window ▼
                                            REPLICA hasn't replayed the upsert yet
                                            → search returns ZERO hits for the doc
                                              just indexed  ◄ stale read = silent RAG miss
```

This is the concrete consequence to hold onto: in a RAG system, a stale read isn't a wrong number on a dashboard — it's the model retrieving *nothing* for a document it was just told about, then confidently answering "I don't have information on that." The fix when replicas arrive is read-your-own-write routing: send reads that follow a write to the primary, or wait for the replica's LSN to catch up. None of that exists yet — **`not yet exercised`**.

**Failover — Supabase's job, untested here.** If the primary dies, a managed Supabase plan can promote a standby and the `DATABASE_URL` endpoint repoints. buffr's code does nothing for this:

- **No connection retry/reconnect logic** beyond what `pg.Pool` does by default — a failover mid-query surfaces as a connection error to the caller.
- **No health check or endpoint failover** in the app.
- **No tested failover drill.**

So failover resilience is inherited from Supabase and **`not yet exercised`** at the application layer — a mid-query failover today would propagate as an error, not a transparent retry.

**Why this is the right call now.** buffr is a *laptop runtime* (`context.md`: "Supabase-backed laptop runtime") — single user, single writer, a small corpus. A read replica would add lag and a routing seam to solve a scaling problem buffr doesn't have. One primary is the honest, correct choice for the deployment; the file's value is showing the reader the exact seam that appears the day the deployment isn't single-user anymore.

### Move 3 — the principle

Replication is the WAL stream reused to keep a copy, and the copy is always `lag` behind — which turns "read your own write" into a real hazard the instant you route reads to a replica. In a RAG system that hazard is uniquely nasty: a stale read is a retrieval *miss*, which the model launders into a confident wrong answer. The general lesson: every replica you add buys read capacity and a failover target at the cost of a new consistency seam — and you don't get to ignore that seam, you get to *route* it.

## Primary diagram

```
  Full replication picture — what exists, what would attach

  ┌─ EXISTS in buffr ──────────────────────────────────────────────┐
  │  one pg.Pool ── one DATABASE_URL ── one PRIMARY                 │
  │  all reads + writes → primary → strongly consistent, zero lag   │
  │  (correct for a single-user laptop runtime)                     │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ NOT EXERCISED (the seam that appears with a replica) ─────────┐
  │  read replica · WAL streaming · replication lag                 │
  │  read/write split routing · read-your-own-write handling        │
  │  failover promotion · reconnect/retry · failover drill          │
  │     │                                                           │
  │     └─► RAG-specific risk: stale read = retrieval MISS =        │
  │         model answers "no information" on a just-indexed doc    │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

Streaming replication is asynchronous by default (the primary doesn't wait for the replica to confirm), which is why lag exists; synchronous replication eliminates the stale-read window but adds commit latency — a tradeoff buffr never has to make at one node. The reason this file is mostly `not yet exercised` is the same reason it's honest: buffr's system-design choice (local-first, single-user) deliberately sidesteps the whole category. When that changes — multi-user, or read-heavy enough to need replicas — the first thing to design is read-your-own-write for the index→search and remember→recall paths, because those are where a stale read becomes a silent correctness bug rather than a visible one. Read next: 07 for the WAL that replication streams, study-system-design for the scaling decision, study-distributed-systems for consistency under partial failure.

## Interview defense

**Q: How do you handle replication lag and stale reads?**

```
  today: one primary → no replica → no lag → no stale reads (trivially)
  with a replica: upsert→primary, search→replica, lag window → search MISSES the doc
```

Answer: "Today I don't have to — buffr is one primary, one connection pool, so every read is strongly consistent. That's a deliberate single-user-laptop choice, not lag handling. The moment a read replica is added, the index→search and remember→recall paths become read-your-own-write hazards: a search routed to a lagging replica returns zero hits for a doc just indexed, and the model answers 'no information.' The fix is routing those reads to the primary or waiting on the replica's LSN. It's `not yet exercised` because the deployment doesn't need replicas." Anchor: *in RAG, a stale read is a retrieval miss, not a stale number.*

**Q: What happens on a database failover?**

Answer: "At the app layer, honestly nothing graceful. There's one `pg.Pool` to one endpoint; a mid-query failover surfaces as a connection error, not a transparent retry. Supabase can promote a standby and repoint the endpoint, but buffr has no reconnect logic, health check, or failover drill — so it's inherited and untested. For a laptop runtime that's acceptable; for multi-user I'd add pool-level reconnect and a tested failover." Anchor: *failover is Supabase's mechanism, untested at the app layer.*

## See also

- `07-wal-durability-and-recovery.md` — the WAL stream replication consumes.
- `01-database-systems-map.md` — the single pg.Pool endpoint.
- `09-database-systems-red-flags-audit.md` — replication gaps ranked.
- study-system-design — the local-first/single-user choice that defers replication.
- study-distributed-systems — read-your-own-write and consistency under partial failure.
