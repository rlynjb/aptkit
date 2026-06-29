# WAL, Durability, and Recovery

**Industry name:** write-ahead log / durability / crash recovery / PITR · *Industry standard*

## Zoom out — where durability is manufactured

"The data is saved" is a guarantee made at the very bottom of the stack, by
the write-ahead log. buffr never touches it — it inherits it from Supabase's
managed Postgres. Here's the boundary:

```
  Zoom out — the durability boundary

  ┌─ Application (buffr) ──────────────────────────────────────┐
  │  upsert() ─► commit   (pg-vector-store.ts:58)              │
  │  the moment commit RETURNS, buffr treats data as saved     │
  └───────────────────────────┬────────────────────────────────┘
                              │ commit
  ┌─ Durability boundary (Postgres) ─────▼─────────────────────┐
  │  ★ WAL: append change record, fsync to disk ★             │ ← we are here
  │  THEN commit returns → durable across crash               │
  └───────────────────────────┬────────────────────────────────┘
                              │ managed by
  ┌─ Operations (Supabase) ───▼────────────────────────────────┐
  │  WAL archiving · automated backups · PITR — all inherited  │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — what this file covers

The question: **when `commit` returns, what is actually guaranteed, and what's
buffr's recovery story if the database dies?** Verdict: durability is real and
strong, but it's *entirely* Supabase-managed — buffr has zero recovery code,
has never run a restore, and its only durability-relevant decision is
"best-effort" on the memory write.

## Structure pass

**Layers.** The commit (what buffr calls) → the WAL fsync (what makes commit
durable) → backup/PITR (what survives losing the disk entirely).

**Axis — trace "what survives a crash at this point?"**

```
  One question down the layers: "survives a crash?"

  buffr in-memory state (InMemoryVectorStore) → NO, dies with process
  buffr commit not yet returned               → NO, may roll back
  Postgres commit returned (WAL fsync'd)      → YES, survives process crash
  Supabase backup / PITR                      → YES, survives disk loss

  durability appears exactly at the WAL fsync; everything above it
  is volatile, everything at-or-below it survives
```

**Seam.** The seam is **`commit` returning** (`pg-vector-store.ts:58`). Before
it returns, the write is volatile; after, it's WAL-durable. buffr's entire
durability contract is "I trust that commit-return means fsync'd" — which is
true on default Postgres, and which buffr never configures or verifies.

## How it works

### Move 1 — the mental model

A write-ahead log is the same discipline as an append-only event log before
you mutate state: you write "I am about to do X" to a durable append-only file
and fsync it, *then* you change the actual data pages. If you crash, replaying
the log rebuilds the change. The rule in the name: the log write happens
*ahead* of the data write.

```
  WAL — log first, then data (the durability kernel)

  commit a transaction:
    1. append change records to the WAL          ┐ sequential write,
    2. fsync the WAL to disk                      ┘ cheap (append-only)
    3. NOW commit returns to buffr  ◄──── durable point
    4. (later) flush dirty data pages to the heap   lazy, batched

  crash after step 2 → replay WAL on restart, redo the change
  crash before step 2 → transaction is simply lost (never committed)
```

Name each part by what breaks without it:
- Drop the **fsync (step 2)** → commit returns but the change is only in OS
  cache; a power loss loses an "acknowledged" write. This is the difference
  between `synchronous_commit on` (default) and `off`.
- Drop **WAL-before-data ordering** → a crash mid-data-write leaves a torn
  page with no log to repair it. The "write-ahead" ordering is the whole point.

### Move 2 — the moving parts

**Commit is buffr's only durability call.** The single line that means
"durable" is `await client.query('commit')` (`pg-vector-store.ts:58`) and its
twin in `migrate.ts:14`. buffr never sets `synchronous_commit`, never tunes
`wal_level`, never configures `fsync` (`not yet exercised`). So it runs
defaults: `synchronous_commit = on`, meaning commit doesn't return until the
WAL record is fsync'd. The consequence buffr relies on without saying so: when
`upsert` resolves, the document's chunks survive a process crash or a laptop
power loss. That's a real guarantee — and it's entirely a default.

**The volatile store has no durability at all — by design.** aptkit's
`InMemoryVectorStore` keeps chunks in a `Map`
(`in-memory-vector-store.ts:12`). There is no WAL, no fsync, no file. Restart
the process and the whole corpus is gone. That's not a bug — it's the toy
adapter, explicitly "build the whole pipeline with zero cloud"
(`in-memory-vector-store.ts:3-8`). The durability story is the *entire*
difference between the two `VectorStore` adapters: same contract, and one
fsyncs to a WAL while the other forgets on exit. This is the cleanest possible
illustration that durability is an *adapter* property, not a contract one —
the `VectorStore` type promises a resolved Promise, never a durable byte.

**The best-effort memory write — a deliberate durability *downgrade*.**

```ts
// buffr/src/session.ts:64-69
try {
  await memory.remember({ conversationId, question, answer });
} catch {
  // swallow: memory is best-effort, the turn already succeeded
}
```

This is the one place buffr makes an explicit durability decision, and it
chooses *less* durability on purpose. The user's answer is already returned;
persisting the exchange into the memory store is wrapped in a swallowed
`try/catch`. If that write fails (Postgres hiccup, connection drop), the turn
still succeeds and the memory is silently lost. The tradeoff, named: a
memory-write failure must never cost the user the answer they already have. So
conversation memory is durable *when it succeeds* and simply absent when it
doesn't — at-most-once, not exactly-once.

**Recovery — Supabase's job, never rehearsed.** buffr has no backup script, no
restore path, no PITR configuration in either repo (`not yet exercised`).
Recovery is whatever Supabase's managed Postgres provides: automated daily
backups and, on paid tiers, point-in-time recovery via WAL archiving. The
honest gap: **buffr has never run a restore.** A backup you've never restored
is a hypothesis, not a guarantee. The migration story is forward-only —
`migrate.ts` runs `001_agents_schema.sql` in one transaction
(`migrate.ts:8-20`), and there's no down-migration, no schema-version table.
Re-running is safe because the DDL is all `if not exists` /
`drop constraint if exists` (idempotent), but there's no rollback path for a
bad migration beyond restoring a backup nobody has tested.

### Move 3 — the principle

Durability is manufactured at one specific instant — the WAL fsync that
happens before `commit` returns — and everything above that line is volatile.
The two things that bite teams aren't the WAL (the engine handles it); they're
(1) treating an *acknowledged* write as durable when `synchronous_commit` is
off, and (2) owning backups you've never restored. buffr is safe on the first
(it runs the durable default) and exposed on the second (managed backups,
never drilled). The deliberate move worth copying is the best-effort memory
write: when a write genuinely doesn't need to be durable, say so in the code
and swallow its failure on purpose — don't let a non-critical write take down
a critical response.

## Primary diagram

```
  Durability recap — buffr

  WRITE PATH                              DURABILITY POINT
  ──────────                              ────────────────
  upsert: begin                           commit returns
    INSERT chunks ───────────────────►    after WAL fsync (synchronous_commit
  commit  ──────────────────────────►       = on, the untouched default)
                                          → survives process crash + power loss

  TWO ADAPTERS, OPPOSITE DURABILITY
  InMemoryVectorStore (aptkit) → Map, no WAL → dies with the process
  PgVectorStore (buffr)        → WAL-backed   → durable on commit

  BEST-EFFORT (deliberate downgrade)
  memory.remember() in try/catch → swallow failure (session.ts:64)
  → at-most-once; answer never lost to a memory-write failure

  RECOVERY → Supabase-managed backups / PITR, NEVER restored (not exercised)
  MIGRATIONS → forward-only, idempotent DDL, no down path (migrate.ts)
```

## Elaborate

WAL is the mechanism behind both crash recovery *and* replication (`08`): the
same log that redoes changes after a crash is the stream a replica consumes to
stay current. So "buffr never configures WAL" also means "buffr has no
replication" — they're the same untouched substrate. The reason a single-user
laptop runtime gets away with zero durability engineering is that Supabase's
defaults are genuinely good: durable commits and automated backups out of the
box. The discipline you'd add before trusting it with anything irreplaceable
is a single, unglamorous practice — actually restore a backup into a scratch
database and confirm the row counts. Until you've done that once, your
recovery plan is untested.

## Interview defense

**Q: When your upsert resolves, is the data durable?**
Yes — `commit` returns only after the WAL record is fsync'd, because
`synchronous_commit` is on (the default; buffr never changes it). So a
committed document survives a process crash or power loss. The in-memory
adapter, same contract, has no WAL and loses everything on restart —
durability is an adapter property, not a contract one.

```
  commit → WAL fsync → durable point → returns
```

**Q: What's your recovery story?**
Honestly, it's Supabase's managed backups and PITR — and I've never run a
restore. That's the gap: an untested backup is a hypothesis. Migrations are
forward-only and idempotent (`if not exists` DDL), so re-running is safe, but
a bad migration's only rollback is a backup nobody has drilled. First thing
I'd fix before trusting it with real data is a restore rehearsal.

**Anchor:** "Durable on commit via the WAL default; recovery is managed and
never rehearsed — and the memory write is best-effort on purpose."

## See also

- `05-transactions-isolation-and-anomalies.md` — what `commit` covers atomically.
- `08-replication-and-read-consistency.md` — the WAL as a replication stream (not exercised).
- `01-database-systems-map.md` — the two adapters' opposite durability.
- study-distributed-systems — best-effort vs exactly-once on the memory write.
