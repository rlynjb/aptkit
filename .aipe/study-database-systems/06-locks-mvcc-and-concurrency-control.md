# Locks, MVCC, and Concurrency Control

**Industry name:** multi-version concurrency control / row locks / optimistic vs pessimistic · *Industry standard*

## Zoom out — where concurrency actually happens

buffr is single-user, so concurrency is *latent*, not exercised. But the
machinery is real and inherited from Postgres. The one place writes can
collide is the chunk upsert's `on conflict`:

```
  Zoom out — concurrency control in buffr

  ┌─ Application (buffr) ──────────────────────────────────────┐
  │  one chat session  ─► one pg pool (db.ts:5)                │
  │  trace sink        ─► queued inserts, flushed in parallel  │ ← Promise.all
  │                       (supabase-trace-sink.ts:91)          │
  └───────────────────────────┬────────────────────────────────┘
                              │ pg pool (multiple connections)
  ┌─ Concurrency control (Postgres) ─────▼─────────────────────┐
  │  ★ MVCC: readers don't block writers ★                    │ ← we are here
  │  row locks on UPDATE / on conflict do update              │
  │  Read Committed snapshots                                 │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — what this file covers

The question: **when two operations touch the same row, who waits and who
wins?** Verdict: buffr almost never hits this because it's single-user, but
its trace sink fires N inserts in parallel (`Promise.all`), and MVCC is what
makes that safe without buffr writing a single lock.

## Structure pass

**Layers.** The reader's snapshot (MVCC, lock-free) on one level; the
writer's row lock (taken on `UPDATE`/`on conflict do update`) on another.

**Axis — trace "who blocks whom?" across reads and writes.**

```
  One question across operations: "who waits?"

  reader vs reader   → nobody waits (snapshots)
  reader vs writer   → nobody waits (MVCC: reader sees old version)
  writer vs writer   → the second waits for a row lock, same row only

  the answer flips only at writer-vs-writer-on-the-same-row;
  every other pairing is lock-free under MVCC
```

**Seam.** The seam is **the row lock taken by `on conflict (id) do update`**
(`pg-vector-store.ts:50`). That's the only place two buffr operations could
serialize — two writers upserting the *same* chunk id. Everything else MVCC
keeps lock-free.

## How it works

### Move 1 — the mental model

You know how React's `useState` gives each render its own snapshot of state —
a closure over the value at that render, immune to a later `setState`? MVCC
is that idea in the database: each transaction reads from a consistent
snapshot, and a concurrent writer creates a *new version* of the row rather
than mutating the one the reader sees. Readers never block writers; writers
never block readers.

```
  MVCC — one row, two versions, two readers

  T1 (writer)               row "doc#3"            T2 (reader, started earlier)
  ──────────                ───────────            ──────────────────────────
  UPDATE doc#3      ──►  version A (xmax=T1) ◄──── still sees version A
                        version B (xmin=T1)        (its snapshot predates T1)
  commit            ──►  new readers see B          T2 reads A, unblocked

  the writer never waited for the reader; the reader never saw a half-write
```

### Move 2 — the moving parts

**MVCC versioning — the `xmin`/`xmax` header.** Recall from `02` that every
heap tuple carries hidden `xmin` (creating txn) and `xmax` (deleting/replacing
txn) columns. That pair *is* MVCC: an `UPDATE` doesn't overwrite a row, it
marks the old version's `xmax` and writes a new tuple with a fresh `xmin`. A
reader's snapshot decides which version it can see. buffr writes none of this
— it's automatic on every `INSERT`/`UPDATE` it issues. The consequence: the
vector search (`pg-vector-store.ts:67`) never blocks, never waits on a writer,
because it reads a snapshot.

**The one lock buffr can take — `on conflict do update`.**

```ts
// buffr/src/pg-vector-store.ts:48-54
`insert into agents.chunks (...) values (...)
 on conflict (id) do update set ...`
//   ^ if the row exists, this becomes an UPDATE, which takes a
//     ROW-EXCLUSIVE lock on that single row until the txn commits
```

If two transactions upsert the *same* chunk id at once, the second blocks on
the first's row lock until it commits, then proceeds (under Read Committed, it
re-reads and applies its update). This is **pessimistic** locking — the engine
takes the lock eagerly on write. buffr never hits the contention because
chunk ids are deterministic (`<docId>#<index>`) and one user indexes one
document at a time. *Observed*: no concurrent indexer exists; the lock is
correct-but-idle.

**Optimistic concurrency — buffr has none, and that's a real gap.** There is
no version column, no `where updated_at = $expected`, no compare-and-swap
anywhere. The profiles and conversations tables (`001_agents_schema.sql:52,32`)
have `updated_at`/`created_at` but nothing reads them to detect a concurrent
write. So buffr can't do "update only if nobody changed this since I read it."
`not yet exercised`. When it would matter: if two sessions ever edited the
same `profiles` row, the last write would silently win (lost update). At
single-user scale, there's only ever one writer, so there's nothing to lose.

**The parallel trace flush — the closest thing to real concurrency.**

```ts
// buffr/src/supabase-trace-sink.ts:87-93
private push(p: Promise<void>): void { this.pending.push(p); }
async flush(): Promise<void> { await Promise.all(this.pending); }
//   ^ all queued message inserts fire concurrently across pool connections
```

This is the one place buffr genuinely runs concurrent statements: every
`CapabilityEvent` from a run queues an `INSERT into agents.messages`, and
`flush()` awaits them all in parallel via the pool. They're independent
inserts of *different* rows (each a new message), so there's no row contention
— MVCC and the pool handle them with no coordination from buffr. The one
ordering risk is handled deliberately: the event timestamp is persisted into
`created_at` (`supabase-trace-sink.ts:30,82`) so replay order follows emit
order, *not* the race between the parallel inserts. That's the author noticing
the concurrency and pinning order with data instead of locks.

### Move 3 — the principle

MVCC is why you can run a read-heavy workload without readers and writers ever
fighting — the database keeps old row versions so a reader's snapshot stays
consistent while writers move on. The only place you take a lock is
writer-versus-writer on the same row, and the only place buffr could hit that
is a same-id upsert it never actually races. The lesson for when you *do* have
concurrent writers: decide pessimistic (lock the row) vs optimistic (version
column + retry) deliberately — buffr did neither, because single-user means
the question never comes up.

## Primary diagram

```
  Concurrency control recap — buffr

  ┌─ MVCC (automatic, every row) ─────────────────────────────┐
  │  xmin/xmax on each tuple → UPDATE writes a new version    │
  │  readers read a snapshot → never block on writers         │
  │  vector search never waits                                │
  └────────────────────────────────────────────────────────────┘

  ┌─ Pessimistic lock (the one buffr can take) ───────────────┐
  │  on conflict (id) do update → row-exclusive lock          │
  │  same chunk id, two writers → second waits (never raced)  │
  └────────────────────────────────────────────────────────────┘

  ┌─ Optimistic concurrency ──────────────────────────────────┐
  │  NONE. no version column, no CAS → not yet exercised      │
  │  multi-writer profiles edit = silent lost update          │
  └────────────────────────────────────────────────────────────┘

  ┌─ Parallel writes (the real concurrency) ──────────────────┐
  │  trace flush: Promise.all of independent message inserts  │
  │  no row contention; order pinned via created_at, not locks│
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

Postgres's MVCC is the reason it's a strong default for read-heavy workloads
and the reason a vector-search workload like buffr's barely thinks about
concurrency — search is a read, reads take snapshots, snapshots don't lock.
The cost MVCC pays is dead tuples (old versions) that `VACUUM` must reclaim;
buffr inherits Supabase's autovacuum and never touches it (`not yet
exercised`). The bridge to your own work: the `Promise.all` trace flush is the
same fan-out shape as a parallel `fetch()` batch in a React app — independent
async operations with no shared mutable target — and it's safe for the same
reason: nobody's writing the same thing.

## Interview defense

**Q: Do your readers block your writers?**
No — Postgres MVCC. Every row carries `xmin`/`xmax`; an update writes a new
version, and a reader reads from its snapshot, so the vector search never waits
on a concurrent write. The only lock buffr can take is row-exclusive on an
`on conflict do update` for the same chunk id — which single-user access never
actually races.

```
  reader → snapshot (lock-free) | writer → new version + row lock
```

**Q: Optimistic or pessimistic concurrency?**
Neither, deliberately — it's single-user. The `on conflict` path is
pessimistic if it ever contends, but there's no version-column optimistic
scheme. If two sessions edited the same profile row I'd have a lost update;
that's the gap I'd close with a version column before going multi-user.

**Anchor:** "MVCC makes every read lock-free; the only lock is same-row
writer-vs-writer, which single-user buffr never races."

## See also

- `02-records-pages-and-storage-layout.md` — the xmin/xmax tuple header MVCC rides on.
- `05-transactions-isolation-and-anomalies.md` — Read Committed, the snapshot rule.
- `08-replication-and-read-consistency.md` — concurrency across replicas (not exercised).
- study-distributed-systems — the parallel trace flush as coordination.
