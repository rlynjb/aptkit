# 06 · Locks, MVCC, and Concurrency Control

**Industry name(s):** multi-version concurrency control, row locks, optimistic vs pessimistic concurrency. **Type:** Industry standard.

## Zoom out, then zoom in

You know the race condition shape from frontend: two `setState` calls based on stale state, last-write-wins, one update lost. Databases solve that with concurrency control — and the headline is that buffr leans entirely on Postgres's MVCC defaults without writing a single lock or retry. So this file is mostly "here's the machinery you're inheriting and not touching."

```
  Zoom out — where concurrency control lives

  ┌─ Application (buffr) ──────────────────────────────────┐
  │  upsert (one writer) · search (readers) · persistMessage│
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Store / SQL layer ────────▼────────────────────────────┐
  │  on conflict do update · no explicit locks, no retries   │
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Postgres engine ──────────▼────────────────────────────┐
  │  ★ MVCC: row versions, snapshots, vacuum ★               │ ← we are here
  │  implicit row locks on UPDATE                            │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **MVCC** — how Postgres lets readers and writers not block each other by keeping *multiple versions* of a row. The code's relationship to it is almost entirely passive: `on conflict do update` creates a new row version, readers get a consistent snapshot, vacuum cleans up dead versions. No `select ... for update`, no advisory locks, no optimistic-concurrency version column, no retry loop. The interesting question is what's safe *because* of MVCC and what's exposed *because* the code does nothing extra.

## The structure pass

**Layers.** Concurrency shows up at three altitudes: the application (how many writers/readers actually run), the SQL (what locks a statement implicitly takes), and the engine (MVCC versioning and snapshots). The code only acts at the first; the rest is inherited.

**Axis — trace "what happens when two operations touch the same row at once?":**

```
  One question down the layers: "two ops, same row — who wins, who waits?"

  ┌─ application ───────────────────────────┐
  │  today: effectively single-writer        │ → contention rarely arises
  │  (manual indexing, one chat session)      │
  └───────────────────────────────────────────┘
  ┌─ SQL ────────────────────────────────────┐
  │  INSERT ... ON CONFLICT DO UPDATE         │ → takes a row lock on the
  │                                           │   conflicting row for the update
  └───────────────────────────────────────────┘
  ┌─ engine (MVCC) ──────────────────────────┐
  │  reader: snapshot, sees old version       │ → readers DON'T block writers,
  │  writer: new version, old marked dead     │   writers DON'T block readers
  └───────────────────────────────────────────┘
```

**Seam.** The boundary is `on conflict (id) do update`. That single clause is where an implicit row lock is taken and a new row version is written. Everything below it (snapshots, dead-tuple cleanup) is MVCC the code never names. Above it, the application's effective single-writer pattern is what keeps the absence of explicit concurrency control from mattering — yet.

## How it works

### Move 1 — the mental model

MVCC is git for rows: an `UPDATE` doesn't overwrite in place, it writes a *new version* and marks the old one dead, and each transaction reads from a *snapshot* — the set of versions committed as of when it started. Readers see a consistent past; the writer builds the future; nobody blocks on a read.

```
  MVCC — one row, versions over time, snapshots per reader

  row "guide.md#3":
    v1 (committed t=1) ──┐
    v2 (committed t=5) ──┤◄── writer's UPDATE created v2, marked v1 dead
                         │
   reader A (snapshot t=3) ──► sees v1  (its snapshot predates v2's commit)
   reader B (snapshot t=6) ──► sees v2  (commits before its snapshot)
                         │
   VACUUM later ─────────┘──► physically removes dead v1 once no snapshot needs it
```

The kernel: **a write creates a version, a read picks the version visible to its snapshot, vacuum reclaims dead versions.** Drop vacuum and dead versions pile up (bloat); drop snapshots and readers see torn writes.

### Move 2 — the walkthrough

**The only write that mutates an existing row — `on conflict do update`.** This is where MVCC actually engages:

```ts
// buffr/src/pg-vector-store.ts:48-54
`insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
 values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
 on conflict (id) do update set
   document_id = excluded.document_id, app_id = excluded.app_id,
   chunk_index = excluded.chunk_index, content = excluded.content,
   embedding = excluded.embedding, embedding_model = excluded.embedding_model,
   meta = excluded.meta`
```

Walk what happens on a conflict. Postgres finds the existing row by the `id` primary key, takes an **implicit row-level lock** on it (a `FOR UPDATE`-style lock, automatic — the code doesn't ask), and writes a **new row version** with the updated values, marking the old version dead. Concurrent *readers* hit by this row see the old version until commit (their snapshot), so a search running during a re-index never sees a half-updated chunk. That safety is free, courtesy of MVCC — the code does nothing to earn it.

**The dead-version cost — bloat, unmanaged.** Every re-index of a document `do update`s its chunks, and every update leaves a dead row version *plus* dead HNSW index entries. Postgres `autovacuum` reclaims these in the background — but there's no vacuum strategy, no `vacuum` call, no autovacuum tuning anywhere in buffr. For a frequently re-indexed corpus, dead-tuple **bloat** in both the heap and the HNSW index is a real cost. It's **`not yet exercised`** — the corpus is small and re-indexed rarely, so bloat hasn't bitten — but it's the MVCC tax the code is silently accruing.

**What's NOT here — and why it's fine today.** Search for concurrency primitives in buffr and you find none:

- **No `select ... for update`** — no pessimistic locking of a row before a read-modify-write.
- **No version/`xmin`-based optimistic concurrency** — no "update where version = N" with a retry.
- **No serialization-failure retry loop** — under READ COMMITTED (05) there are no serialization failures to retry; the loop would matter only at `serializable`.
- **No advisory locks** — nothing coordinates two processes.

This is safe *because the system is effectively single-writer*: indexing is a manual operation and a chat session is one writer appending messages. There's no concurrent read-modify-write on the same row, so the lost-update anomaly that would demand optimistic concurrency simply doesn't arise. The honest framing: concurrency control is **`not yet exercised`** because concurrency itself barely happens — not because it was solved.

**The one genuinely concurrent path — and its non-DB race.** The trace sink writes are concurrent at the JS level, but the race lives outside the database:

```ts
// buffr/src/supabase-trace-sink.ts:53,87-93  — emit() is sync, fires inserts without awaiting
emit(event) { ... this.push(persistMessage(...)); }   // queues a promise, returns immediately
async flush() { await Promise.all(this.pending); }    // all message inserts race to complete
```

Multiple `persistMessage` inserts into `agents.messages` are in flight at once (`Promise.all`). Postgres handles these fine — separate rows, no contention, MVCC isolates them. But their *commit order* is nondeterministic, which is why the code persists the **event timestamp into `created_at`** (`supabase-trace-sink.ts:30, 48` comment) — so replay orders by `created_at`, not by the racing insert order. That's the one place the code actively compensates for concurrency, and it does it with a *data* fix (store the order), not a *lock*. Smart: a lock would serialize the writes and lose the throughput; storing the timestamp keeps them concurrent and recovers order at read time.

```
  Layers-and-hops — concurrent trace inserts, order recovered by data not locks

  ┌─ agent loop (aptkit) ─┐ emit(e1) emit(e2) emit(e3)  ┌─ SupabaseTraceSink ─┐
  │ runAgentLoop          │ ───────────────────────────►│ push 3 promises     │
  └───────────────────────┘  (sync, no await)           └─────────┬───────────┘
                                              flush(): Promise.all │ 3 INSERTs race
                                                                   ▼
                                              ┌─ agents.messages (Postgres) ──┐
                                              │ rows commit in ANY order       │
                                              │ created_at = event.timestamp   │ ◄ order recovered here
                                              └────────────────────────────────┘
```

### Move 3 — the principle

MVCC gives you reader/writer non-blocking for free, and that free guarantee is doing all the concurrency work in this codebase. The code adds nothing — no locks, no retries — and gets away with it because it's effectively single-writer. The one real concurrency it has (racing trace inserts) it solves by *storing the order as data* rather than serializing with a lock. The general lesson: the cheapest concurrency control is the concurrency you don't have, and the next-cheapest is recovering order from a timestamp instead of taking a lock.

## Primary diagram

```
  Full concurrency picture — inherited MVCC, no explicit control

  ┌─ what Postgres MVCC gives buffr for free ──────────────────────┐
  │  on conflict do update  → implicit row lock + NEW row version  │
  │  readers                → snapshot isolation, see old version  │
  │  readers ⟂ writers      → neither blocks the other             │
  │  dead versions          → autovacuum (UNTUNED → bloat risk)    │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ what the code does NOT do ────────────────────────────────────┐
  │  FOR UPDATE · optimistic version column · retry loop · advisory │
  │  locks   →   ALL NOT EXERCISED (effectively single-writer)     │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ the one active compensation ──────────────────────────────────┐
  │  racing trace inserts → store event.timestamp in created_at,    │
  │  recover order at read time (data fix, not a lock)              │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

MVCC is Postgres's defining concurrency mechanism (vs lock-based systems that block readers behind writers); the cost it imposes is dead-tuple bloat and the need for vacuum, which is the thing to watch first if re-indexing frequency climbs. The HNSW index compounds this — vector index bloat from churned embeddings is a known pgvector operational concern, and it's the most likely first real concurrency-adjacent issue this system would hit. If buffr ever runs concurrent indexers, the lost-update exposure on `on conflict do update` (two writers updating the same chunk) appears, and the move is `repeatable read` + a serialization-failure retry, or an application-level version check. Read next: 05 for the isolation level these versions are read under, 07 for how committed versions become durable.

## Interview defense

**Q: How do you prevent a search from seeing a half-updated chunk during re-indexing?**

```
  re-index writer            search reader
  ┌──────────────┐           ┌──────────────┐
  │ UPDATE chunk │ new ver   │ snapshot@start│ → sees OLD version,
  │ (row locked) │ ────────► │ reads old     │   never the in-flight write
  └──────────────┘           └──────────────┘   (MVCC, free)
```

Answer: "I don't do anything — MVCC handles it. `on conflict do update` writes a new row version and takes an implicit row lock, but the search reads from its snapshot, so it sees the old committed version until the update commits. Readers and writers don't block each other. The code adds no locks because it doesn't need to." Anchor: *MVCC gives reader/writer non-blocking for free; the code rides it.*

**Q: You have no locks or retries. When does that break?**

Answer: "When the system stops being single-writer. Today indexing is manual and a chat session is one writer, so there's no concurrent read-modify-write on a row — the lost-update anomaly never arises. If I ran concurrent indexers doing `on conflict do update` on the same chunk, last-writer-wins would silently lose an update under READ COMMITTED. The fix is `repeatable read` plus a serialization-failure retry, or a version column. It's `not yet exercised` because concurrency barely happens, not because it's solved." Anchor: *the cheapest concurrency control is having no concurrency — name that honestly.*

**Q: You mentioned a real race — the trace sink. How's it handled?**

Answer: "`emit()` is synchronous and fires message inserts without awaiting, so multiple inserts into `agents.messages` race under `Promise.all` in `flush()`. They commit in nondeterministic order. Instead of serializing with a lock, the code stores the event's own timestamp in `created_at` (`supabase-trace-sink.ts`) and replay orders by that — recovering order from data, not a lock, so the writes stay concurrent." Anchor: *recover order from a timestamp, don't take a lock.*

## See also

- `05-transactions-isolation-and-anomalies.md` — the READ COMMITTED level these versions are read under.
- `07-wal-durability-and-recovery.md` — how a committed version becomes durable.
- `03-btree-hash-and-secondary-indexes.md` — the HNSW index that also accrues bloat.
- study-distributed-systems — the racing trace inserts and best-effort writes.
