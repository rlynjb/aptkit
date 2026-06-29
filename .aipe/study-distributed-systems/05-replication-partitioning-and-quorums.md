# 05 — Replication, Partitioning, and Quorums

**Industry names:** replication · sharding / partitioning · partition key · quorum (R + W > N) · failover · the connection pool as a bounded resource — *Industry standard.*

## Zoom out, then zoom in

This is the most `not yet exercised` file in the guide, and the honest move is to
say so up front: aptkit has **no replication, no shards, no quorum.** There is one
Postgres and one in-memory store. But there are two real things to study — the
**connection pool** (a bounded shared resource that behaves like a tiny distributed
system) and the **`app_id` column** (a partition key that's already there, just
operating on a single node). The rest is curriculum: named, mapped to where it would
attach, and labelled honestly.

```
  Zoom out — what's real vs what's curriculum

  ┌─ buffr process ─────────────────────────────────────────────────────┐
  │  pg.Pool ──── REAL: a bounded set of connections, shared concurrently │ ← study this
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ TCP (N connections)
  ┌─ Supabase Postgres (ONE node) ▼──────────────────────────────────────┐
  │  agents.chunks WHERE app_id = $2  ── REAL: app_id is a partition key  │ ← study this
  │                                       (logical; single-node today)    │
  │  ┌─ replica? ─┐  ┌─ shard 2? ─┐  ┌─ quorum? ─┐                         │
  │  │ NOT YET    │  │ NOT YET    │  │ NOT YET   │  ← curriculum only      │
  │  └────────────┘  └────────────┘  └───────────┘                         │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: **replication** keeps N copies of the data so a copy can fail; **partitioning**
splits the data across nodes so no one node holds it all; **quorum** is the rule
(`R + W > N`) that lets a majority of replicas agree without all of them being up.
None of these exist here — but `app_id` shows you what a partition *key* looks like
before you have multiple partitions, and the pool shows you bounded-resource
contention, which is the same shape as a quorum running out of available nodes.

## Structure pass

**Layers.** Caller concurrency → pool (bounded connections) → single Postgres node →
(hypothetical) replicas/shards.

**Axis — trace `how many independent copies must agree?` down the layers.**

```
  Axis — "how many copies/nodes must cooperate for this op?" — top to bottom

  ┌─ a chunk write ────────────────────────────┐
  │  needs: ONE connection from the pool        │  → 1 of N connections (real contention)
  └──────────────────────┬──────────────────────┘
       ┌─────────────────▼────────────────────────┐
       │ that connection → ONE Postgres node       │  → 1 node (no replicas to agree)
       └─────────────────┬────────────────────────┘
            ┌────────────▼──────────────────────────┐
            │ (if replicated) → quorum of replicas   │  → NOT YET EXERCISED
            └─────────────────────────────────────────┘
```

**Seam.** The only place "how many must cooperate?" is greater than one today is the
*pool*: a write needs one of N connections, and if all N are checked out, it waits.
That's the real, studyable contention. Everything below it is single-copy, so the
answer collapses to "one" — which is exactly why quorums are `not yet exercised`.

## How it works

### Move 1 — the mental model: the pool is a bounded pile of borrowable connections

You've built this shape: a fixed number of resources, borrowers take one, use it,
return it; if none are free, borrowers wait. A connection pool is exactly that for
TCP connections to Postgres.

```
  The pool kernel — borrow, use, return; wait when empty

  pool: [ conn1 ][ conn2 ][ conn3 ]   (N = 3, say)

  caller A ──borrow──► conn1 ──query──► release ──► back in pool
  caller B ──borrow──► conn2 ──query──► release
  caller C ──borrow──► conn3 ──query──► release
  caller D ──borrow──► (none free) ──► WAITS until A/B/C release
                                         └─ if nobody releases → D hangs (pool exhaustion)
```

The load-bearing part is the *wait*: when the pool is empty, the borrower blocks. A
leaked connection (borrowed, never released) permanently shrinks the pool; leak all N
and the whole app deadlocks waiting for a connection that's never coming back.

### Move 2 — walking the mechanism

**Step 1 — the pool is created once, shared across the session.** buffr makes one
pool per process and threads it everywhere:

```ts
// buffr/src/db.ts:4-6
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });   // ← default max (10) connections
}
```

One pool, default size. Every `PgVectorStore` query and every `SupabaseTraceSink`
insert borrows from this same pile. Note what's *not* set: no explicit `max`, no
`connectionTimeoutMillis`. So under enough concurrent writes the pool can exhaust,
and a borrower with no timeout waits indefinitely — the same "no deadline" hazard as
the Ollama call, one layer down. (→ this is finding territory; see `09`.)

**Step 2 — the upsert checks out one connection for a transaction.** This is the one
place a connection is held across *multiple* queries, which makes it the one place a
leak would hurt most:

```ts
// buffr/src/pg-vector-store.ts:40-64
const client = await this.pool.connect();   // ← BORROW one connection
try {
  await client.query('begin');               // ← multi-statement: held for the whole txn
  for (const c of chunks) { await client.query(`insert ... on conflict ...`, [...]); }
  await client.query('commit');
} catch (err) {
  await client.query('rollback');
  throw err;
} finally {
  client.release();                          // ← RETURN it — in finally, so even an error returns it
}
```

The `finally { client.release() }` is the load-bearing line. It's the thing that
prevents the leak: no matter how the try-block exits — success, thrown error,
rollback — the connection goes back in the pool. Drop that `finally` and one failed
upsert permanently burns one connection; enough failures exhaust the pool and the
app wedges. This is correct, and it's the single most important defensive line in the
buffr storage code.

**Step 3 — the partition key that's already here: `app_id`.** Every query is scoped
by `app_id`:

```ts
// buffr/src/pg-vector-store.ts:70-77 (the search)
`select id, content, ..., 1 - (embedding <=> $1::vector) as score
   from agents.chunks
  where app_id = $2                          -- ← THE PARTITION KEY (logical)
  order by embedding <=> $1::vector
  limit $3`
```

`app_id` is a partition key in the *design* sense even though there's one physical
node: it cleanly divides the data so that one app's chunks never mix with another's.
The day this needs to scale, `app_id` is the natural shard key — route app A's data
to shard 1, app B's to shard 2, and the query already carries the routing column.
That's the value of choosing a partition key early: the *physical* partitioning is
deferred, but the *logical* boundary is already enforced. The data is "pre-sharded"
on a single node.

### Move 2.5 — current state vs scaled state

```
  Phase A: today (single node)            Phase B: if buffr scaled
  ──────────────────────────────          ──────────────────────────────────
  one Postgres node                       primary + read replica(s)
  pool → that one node                    pool → primary for writes,
  app_id = logical partition                     replica(s) for reads (search)
  no quorum (1 copy, trivially "agrees")  quorum: R + W > N for replica reads
                                          app_id → physical shard key
  what holds: idempotent upsert,          what BREAKS: read-your-writes (file 04),
   the pool, the transaction               adds replica lag + failover + quorum
```

The takeaway is *what doesn't have to change*: the idempotent upsert, the
per-document transaction, and the `app_id` scoping all survive the move to replicas
and shards unchanged. What scaling *adds* is the staleness and coordination cost —
which is precisely why you don't pay it until you must.

### Move 3 — the principle

Replication and partitioning are answers to two different questions:
**availability** ("survive a node dying" → replication, keep copies) and
**capacity** ("hold more than one node can" → partitioning, split the data). Quorum
(`R + W > N`) is how replicas stay consistent without needing *all* of them up — a
majority overlap guarantees reads and writes intersect. aptkit needs none of these
yet because one node has the availability and capacity it needs. The skill is
recognizing *which* problem you actually have before reaching for the mechanism — and
choosing a partition key (`app_id`) early so the door stays open.

## Primary diagram

```
  Replication/partitioning in aptkit — one node, one real bounded resource

  ┌─ buffr process ─────────────────────────────────────────────────────┐
  │  concurrent callers ──► pg.Pool [ c1 ][ c2 ]...[ cN ]  ← REAL: bounded │
  │                            │ borrow/release (finally!)                 │
  └────────────────────────────┼─────────────────────────────────────────┘
                               │ TCP
  ┌─ Supabase Postgres (ONE node) ▼──────────────────────────────────────┐
  │  agents.chunks  WHERE app_id = $2   ← REAL: logical partition key      │
  │                                                                        │
  │  ┌╌ replica (NOT YET) ╌┐  ┌╌ shard 2 (NOT YET) ╌┐  ┌╌ quorum (NOT YET)╌┐│
  │  ┊ would add staleness ┊  ┊ would use app_id    ┊  ┊ R+W>N agreement  ┊│
  │  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘  └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘│
  └─────────────────────────────────────────────────────────────────────┘

  studyable today: the pool (bounded), the app_id partition key.
  curriculum only: replicas, shards, quorum, failover.
```

## Elaborate

The connection pool is genuinely a miniature distributed-systems object and deserves
the study time: it's a bounded resource shared by concurrent consumers with a
queueing discipline, and pool exhaustion is one of the most common production
incidents in any DB-backed service. The mechanics you learn here — borrow, hold for a
transaction, release in `finally`, the danger of a leak, the need for a checkout
timeout — transfer directly to thread pools, worker pools, semaphores, and rate
limiters.

Quorum (`R + W > N`) is worth understanding even though it's `not yet exercised`,
because it's the elegant core of every replicated datastore: if writes go to a
majority and reads come from a majority, the two majorities must overlap in at least
one node, so a read always sees the latest acknowledged write. It's why Dynamo-style
systems can tolerate node failures without losing consistency. It would attach here
only if buffr ran multiple Postgres replicas with read traffic spread across them —
at which point `app_id` becomes the shard key and the staleness from file 04 becomes
real.

## Interview defense

**Q: "How do you scale this?"**
"Today I don't need to — one Postgres node has the capacity and availability buffr
needs, so there's no replication, sharding, or quorum, and I won't pretend otherwise.
What I *did* do is leave the door open: every query is scoped by `app_id`, which is a
clean partition key, so physical sharding later is a routing change, not a data
remodel. The one bounded resource I do reason about is the connection pool — it's the
real contention point, and the `finally { client.release() }` in `PgVectorStore` is
what keeps a failed upsert from leaking a connection and eventually wedging the pool."

```
  sketch

  pool [c1..cN] ← borrow/RELEASE-in-finally (the real bounded resource)
  agents.chunks WHERE app_id=$2 ← partition key, ready to become a shard key
  replicas/quorum ← NOT YET; would add staleness (file 04) — the cost of scaling
```

**Q: "What does quorum buy you and why don't you have it?"** — the honest answer:
"Quorum (`R + W > N`) lets a majority of replicas agree so the system survives a
minority being down while staying consistent — reads and writes always overlap in at
least one node. I don't have it because I have one copy of the data; there's nothing
to form a majority of. It would matter the moment I replicated Postgres for
availability, and that's also when read-your-writes would start to break — so I'd be
buying consistency-under-failure at the cost of fresh-read simplicity."

*Anchor:* one node, no quorum; the pool + `finally release` is the real bounded-
resource lesson; `app_id` is the partition key already in place.

## See also

- `04-consistency-models-and-staleness.md` — replica lag is where staleness would enter
- `02-partial-failure-timeouts-and-retries.md` — pool checkout needs a timeout, like the Ollama call
- **study-database-systems** — pgvector index, MVCC, what a single Postgres node does inside
- **study-system-design** — why one node was the right call (local-first, single user)
```
