# 04 — Consistency Models and Staleness

**Industry names:** consistency models · stale reads · read-your-writes · eventual consistency / convergence · the two-cache problem. **Type:** Industry standard.

## Zoom out, then zoom in

There's a real staleness seam in the repo, and it's not in Postgres — it's between the *in-memory* vector store and the *durable* one. The same `VectorStore` contract has two implementations with two completely different consistency profiles.

```
  Zoom out — two implementations of one contract, two consistency stories

  ┌─ App ──────────────────────────────────────────────────────────┐
  │  RetrievalPipeline  ──depends on──►  VectorStore (the contract)  │
  └───────────────┬──────────────────────────────┬──────────────────┘
       in aptkit  │                    in buffr   │
  ┌───────────────▼──────────┐        ┌───────────▼──────────────────┐
  │ ★ InMemoryVectorStore ★   │        │ PgVectorStore → Postgres      │ ← we are here
  │  strongly consistent      │        │  durable; read-after-write    │   (both ends)
  │  (one process, one array) │        │  from a connection pool       │
  │  but VOLATILE & private   │        │  shared across processes      │
  └───────────────────────────┘        └───────────────────────────────┘
```

Zoom in: a **consistency model** is the contract for *what a read is allowed to return* relative to recent writes. The strongest, **read-your-writes**, says: if you wrote it, you'll read it back. The in-memory store gives you that trivially — it's one array in one process, a write is instantly visible to the next read. Postgres gives you read-your-writes *too*, but only because the repo talks to a single primary; add a read replica and that guarantee evaporates. The interesting question is what changes between the two, and what would change if a replica appeared.

## Structure pass — layers, one axis, the seams

**Layers:** the read path — caller → `VectorStore.search` → (in-memory array | Postgres via pool).

**The one axis: *can a read return data older than my last write?*** Trace it:

```
  "can a read miss my own recent write?"  — traced across the stores

  ┌──────────────────────────────────────────────┐
  │ InMemoryVectorStore   write → push to array → │  NO — same array,
  │                       read → scan same array  │  instant visibility
  └────────────────────┬──────────────────────────┘
       ┌───────────────▼──────────────────────────┐
       │ PgVectorStore → single primary            │  NO (today) — one writer,
       │  write commits → next read sees it        │  one reader, same node
       └───────────────┬──────────────────────────┘
             ┌─────────▼──────────────────────────┐
             │ PgVectorStore → + a READ REPLICA    │  YES — replica lags;
             │  (not yet exercised)                │  read may miss the write
             └─────────────────────────────────────┘
```

The answer is "no" until a replica enters the picture, and then it becomes "yes." That third row is `not yet exercised`, but naming it is the point: the read-your-writes guarantee the repo enjoys is an *accident of single-node topology*, not a property the code enforces.

**The seam:** the `VectorStore` contract boundary. Consistency *and* durability flip across it — in-memory is consistent-but-volatile, Postgres is consistent-and-durable. Same interface, opposite failure profiles. (Durability mechanics — WAL, fsync — belong to `study-database-systems`; here we care only about what a *read* can observe.)

## How it works

### Move 1 — the mental model

You know this from running two browser tabs against the same app: tab A writes, tab B still shows the old value until it refetches. That gap — write happened, this reader hasn't seen it yet — is *staleness*. A consistency model is the promise about how big that gap can be and who's exempt from it.

```
  The staleness kernel — the window between write and visible-everywhere

  write at t0 ──────────────────────────────────────────────►
              │                                       │
              │◄──── staleness window ────────────────►│
              │                                        │
   the writer reads here:  sees it (read-your-writes)  │
   another reader here:    may still see the old value ┘
```

The kernel: **a write becomes visible at different times to different readers.** Collapse all readers onto one copy of the data (one array, one primary) and the window is zero — that's strong consistency, and that's what the repo has. Add copies (replicas, caches) and the window opens.

### Move 2 — walking the mechanism

**Part 1 — the in-memory store: strong, but private and volatile.** `InMemoryVectorStore` (`packages/retrieval`) is a cosine scan over a plain array. A write (`upsert`) mutates the array; the next `search` scans the mutated array. There is exactly one copy, in one process, so read-your-writes is automatic and the staleness window is zero. The catch isn't consistency — it's the other two: the data is **private** to that process (no other node can read it) and **volatile** (gone on crash). It's a perfect consistency story for a useless-across-boundaries store. That's why it's the test/preview double, not the system of record (`context.md`).

**Part 2 — Postgres through a pool: read-your-writes, today.** buffr's `PgVectorStore` acquires a client from a `pg.Pool` and queries a single primary:

```typescript
// buffr/src/db.ts
export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });   // single primary, default pool
}
```

Because every read and every write hit the *same* primary, a committed write is visible to the next read. Read-your-writes holds. But notice *why* it holds — topology, not code. Nothing in `PgVectorStore` would notice if reads were routed to a lagging replica; it just runs SQL.

There's a subtler consistency point at the pool itself. A connection pool hands you *a* connection, not a *specific* one. Within a single committed transaction that's fine. But "write on connection A, immediately read on connection B" only sees the write because A *committed* before B read — the visibility is anchored to the commit, not the connection. The repo's writes commit before returning (`pg-vector-store.ts:58` `commit`), so this is safe; it's worth knowing that the pool, not just the database, is part of the consistency picture.

```
  Layers-and-hops — write then read across pooled connections

  ┌─ App ────────────────┐  hop 1: upsert + COMMIT   ┌─ Postgres ─────┐
  │ PgVectorStore.upsert  │ ─────(conn A)───────────► │  primary       │
  │   client = pool.connect()                         │  row committed │
  └───────────┬───────────┘                           └────────────────┘
       hop 2  │ search (conn B from pool)             ┌─ Postgres ─────┐
              └──────────────────────────────────────► │  reads committed│  ✓ sees the write
                                                       └────────────────┘   BECAUSE A committed
```

**Part 3 — the two-store divergence (the real staleness in the repo).** Here's the staleness that *actually exists* today. The memory engine (`@aptkit/memory`) and retrieval share the same `VectorStore` contract. In aptkit's Studio/test path they bind to `InMemoryVectorStore`; in buffr they bind to `PgVectorStore`. If you ran *both* — an in-memory store for a session and Postgres as the durable copy — you'd have two copies of "the corpus" that diverge: the in-memory one has session writes the durable one hasn't received, and a process restart loses them. The repo sidesteps this by binding *one* store at wiring time (the store is injected — `context.md`), so there's no live two-copy divergence today. But the contract *permits* it, and that's the latent two-cache problem: the day you add an in-memory read cache *in front of* Postgres for speed, you've created a staleness window you must now invalidate.

**Part 4 — eventual consistency / convergence — `not yet exercised`.** The repo has no replicas, so there's no replica lag to converge. Where it *would* attach: the chunk corpus is convergent by construction (the idempotent upsert from `03` means re-running ingestion makes all copies agree), so if you ever replicated it, the data model is already friendly to eventual consistency — the upsert is the convergence operation. Naming that is the payoff: **the same key that gives you idempotency would give you convergence if you replicated.**

### Move 3 — the principle

Consistency is a property of *topology plus protocol*, not of code you can read in one file. The repo reads as strongly consistent, but that's because it talks to one copy of each thing. The instinct to build: every time you add a *copy* — a replica, a cache, a second store behind the same contract — you create a staleness window, and you must answer "who is allowed to read stale, and how do they catch up?" The repo's honest answer today is "no copies, so no window," and the discipline is to keep noticing the moment that stops being true.

## Primary diagram

The consistency profile of every read path in one frame.

```
  Consistency map — what each read can observe

  ┌─ App process ──────────────────────────────────────────────────┐
  │  InMemoryVectorStore   1 copy, 1 process                        │
  │    read-your-writes: YES (zero window) · volatile · private     │
  └──────────────────────────────────┬──────────────────────────────┘
                                     │ VectorStore contract (same interface)
  ┌─ Storage ──────────────────────── ▼─────────────────────────────┐
  │  PgVectorStore → pg.Pool → SINGLE PRIMARY                       │
  │    read-your-writes: YES (writes commit before return)          │
  │    durable · shared across processes                            │
  │                                                                 │
  │  ┄┄┄ + read replica (not yet exercised) ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
  │    read-your-writes: NO — replica lag opens a staleness window  │
  │    convergence operation already exists: the idempotent upsert  │
  └──────────────────────────────────────────────────────────────────┘
```

## Elaborate

The consistency spectrum runs from *linearizable* (every read sees the latest write, as if there were one copy and one clock) down through *read-your-writes*, *monotonic reads*, and *eventual* (replicas agree given enough quiet time). The famous result is that you trade consistency for availability and latency under partition — the CAP and PACELC theorems (→ `07` touches the clock side). The repo sits at the strong end purely because it's single-copy; it has paid none of the price because it has bought none of the scale.

The two-cache problem ("there are only two hard things in computer science: cache invalidation and naming things") is the practical face of this. The repo avoids it by having one authoritative store and treating the in-memory one as a non-authoritative double. The moment a cache sits *between* the app and Postgres to speed reads, you inherit the hardest problem in the field — and the right time to learn it is before you add the cache, not after it serves stale data in production.

## Interview defense

**Q: "What consistency does your retrieval store give you?"**
"Read-your-writes, but for a topology reason, not a code reason. In aptkit it's one in-memory array — zero staleness window, also volatile and private. In buffr it's a single Postgres primary behind a `pg.Pool`; writes commit before the call returns, so the next read sees them. The honest caveat: that guarantee is single-node. Route reads to a replica and it becomes eventual — and notably the convergence operation already exists, because the chunk upsert is idempotent on a deterministic key."

```
  one copy → strong;  add a replica → eventual
  but the idempotent upsert is already the convergence op
```

Anchor: *strong consistency here is an accident of single-copy topology, not an enforced invariant.*

**Q: "Where's the staleness risk?"**
"Not inside Postgres — between the two `VectorStore` implementations. The contract permits an in-memory copy and a durable copy to diverge; the repo dodges it by injecting exactly one store at wiring time. The risk materializes the day someone puts an in-memory cache in front of Postgres for read latency — that's the classic two-cache invalidation problem."

Anchor: *the staleness seam is the contract boundary, and it's dormant only because one store is bound at a time.*

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — the upsert that doubles as the convergence operation
- `05-replication-partitioning-and-quorums.md` — what adding a replica actually entails
- `01-distributed-system-map.md` — where the two stores sit on the map
- `study-database-systems` — isolation levels, MVCC, and durability beneath the read
- `study-system-design` — the canonical-local-with-cloud-mirror shape (buffr) where staleness lives architecturally
