# 07 · WAL, Durability, and Recovery

**Industry name(s):** write-ahead log, fsync durability, crash recovery, backups/PITR. **Type:** Industry standard.

## Zoom out, then zoom in

"Durable" means: the user got a success response, then the power died, and the data is still there. You know the failure it prevents — the optimistic UI update that never actually saved. This repo has the cleanest possible illustration of durability because it has *both poles*: a store with zero durability (aptkit's Map) and a store with full WAL durability (buffr's Postgres), behind the same interface.

```
  Zoom out — where durability is won or lost

  ┌─ Store layer ──────────────────────────────────────────┐
  │  InMemory: commit == Map.set in RAM → ZERO durability    │
  │  Postgres: commit == WAL write + fsync → DURABLE         │ ← we are here
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Postgres engine ──────────▼────────────────────────────┐
  │  ★ WAL (write-ahead log) → fsync → checkpoint → heap ★   │
  │  crash recovery replays WAL · Supabase backups           │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **the durability boundary** — the exact moment a write survives a crash. In aptkit that moment never arrives (it's all RAM). In buffr it's the `commit` in the upsert transaction, which forces a WAL flush to disk. The recovery side — what happens after a crash, and whether there's a tested restore path — is where the honest gaps live.

## The structure pass

**Layers.** Durability is decided at the store layer and enforced by the engine. Above it, the pipeline gets a resolved promise from `upsert` and assumes "it's saved" — but what "saved" *means* differs completely between the two stores.

**Axis — trace "what does a resolved `upsert()` promise actually guarantee?":**

```
  One question across the stores: "upsert resolved — now what survives a crash?"

  ┌─ InMemoryVectorStore ───────────────┐
  │  resolved = Map.set returned         │ → survives nothing; process exit = total loss
  └──────────────────────────────────────┘
  ┌─ PgVectorStore → Postgres ──────────┐
  │  resolved = commit returned          │ → WAL record fsync'd to disk;
  │                                      │   survives crash, recovered by WAL replay
  └──────────────────────────────────────┘

  same resolved promise, opposite durability — the caller can't tell which from the type
```

**Seam.** The boundary is the `commit` inside `PgVectorStore.upsert` (05). In aptkit there is no commit — `upsert` resolves the instant the loop of `Map.set` finishes. The promise's *type* is identical (`Promise<void>`); the durability behind it is night and day. That's the seam: the contract hides whether a write is durable.

## How it works

### Move 1 — the mental model

WAL is the append-only log you'd reach for to make any in-memory thing crash-safe: before you change the real data structure, append "here's what I'm about to do" to a log and `fsync` it. If you crash, replay the log on restart. Postgres does exactly this — the heap pages are the "real data," the WAL is the "about to do" log, and `commit` is the point the log is forced to disk.

```
  WAL durability — log first, fsync, then the heap catches up

  commit:
    1. append WAL record  ──────►  [ WAL on disk ]   ◄ fsync HERE = durable point
    2. return success to caller       │
    3. (later) checkpoint flushes      ▼
       dirty heap pages to disk    [ heap pages ]    ← lag behind WAL; that's fine

  crash before step 3?  →  on restart, REPLAY WAL onto heap → no data lost
```

The kernel parts: the **WAL append + fsync** is what makes commit durable (lose it and a crash loses committed data); the **checkpoint** lazily reconciles heap to WAL (lose it and the WAL grows unbounded); **recovery replay** rebuilds the heap from the WAL after a crash (lose it and an unclean shutdown corrupts data).

### Move 2 — the walkthrough

**aptkit: the durability floor — none.** The in-memory store's "write" is a map assignment, and its `upsert` resolves immediately:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:18-23
async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);          // lives in V8 heap, that's the whole lifecycle
  }
}                                              // promise resolves → "saved" means "in RAM"
```

There is no log, no disk, no fsync. The instant the process exits — clean or crash — every chunk is gone. This is correct for its job (tests, demos, the Studio in-browser RAG which uses `InMemoryVectorStore` with a fake embedder per `context.md`), and it's the perfect contrast: a store where `commit` has no meaning because there's nothing below RAM.

**buffr: commit forces the WAL.** The durability point is the `commit` in the upsert transaction (the same one from 05):

```ts
// buffr/src/pg-vector-store.ts:43-58
await client.query('begin');
for (const c of chunks) { await client.query(`insert ... on conflict ...`, [...]); }
await client.query('commit');                  // ◄ THIS forces the WAL record to fsync
```

When `commit` returns, Postgres has written the transaction's WAL records and `fsync`'d them to disk (under the default `synchronous_commit = on`). The heap pages holding the actual chunk rows may still be dirty in memory — they get flushed at the next checkpoint — but that's fine: if the box loses power one millisecond after `commit` returns, recovery replays the WAL and the chunks reappear. The promise resolving from `commit` is a *real* durability guarantee, unlike aptkit's.

**Recovery — inherited, untested.** Crash recovery (WAL replay on restart) is automatic in Postgres; buffr does nothing to configure or invoke it, and relies on it implicitly. The backup/restore side is **Supabase-managed**: Supabase takes the backups, owns PITR (point-in-time recovery) on its plan tier, and runs the WAL archiving. buffr's code contains:

- **No backup invocation** — no `pg_dump`, no backup scheduling in the repo.
- **No restore drill** — no documented or scripted "restore from backup and verify" path.
- **No `synchronous_commit` setting** — durability is whatever the Supabase default is (`on`).

So the durability guarantee is *real* but **the recovery path is `not yet exercised`** — nobody has restored this database from a backup and confirmed the corpus comes back intact. "We have backups" (Supabase does) is not "we have tested restore" (nobody has). That gap is the honest durability finding.

**The migration is durable too, transactionally.** The schema apply (`migrate.ts`, 05) commits in one transaction, so the WAL makes the schema durable atomically — you can't get a half-applied, half-durable schema. Same mechanism, applied to DDL.

```
  Layers-and-hops — a chunk upsert reaching the durability point (buffr)

  ┌─ PgVectorStore ─┐ hop 1: INSERT × m         ┌─ Postgres ──────────────┐
  │ upsert (txn)    │ ─────────────────────────►│ rows in shared buffers  │
  └─────────────────┘ hop 2: COMMIT ───────────►│ append WAL → FSYNC      │ ◄ DURABLE here
                      hop 3: success ◄────────── │       │                 │
                                                 │       ▼ (later)         │
                                                 │ checkpoint → heap disk  │
                                                 └─────────┬───────────────┘
                                          crash? ──────────┘ restart → WAL replay
```

### Move 3 — the principle

Durability is the moment a write survives a crash, and that moment is `commit` forcing the WAL to disk — not the moment your `upsert` promise resolves, because the same promise type sits over a store (the Map) where it means nothing. And "we have backups" is a different claim from "we have a tested restore": the first is a property of your provider, the second is a property you only know by exercising it. The general lesson: durability is a guarantee you must locate precisely (the fsync) and a recovery path you must *test*, not assume.

## Primary diagram

```
  Full durability picture — two poles behind one contract

  ┌─ aptkit InMemoryVectorStore ──┐      ┌─ buffr Postgres (Supabase) ────────────┐
  │ upsert → Map.set → resolve    │      │ upsert → begin..commit                  │
  │ NO log, NO disk, NO fsync     │      │   commit → WAL append → FSYNC (durable) │
  │ durability: ZERO              │      │   checkpoint → heap pages → disk        │
  │ restart = total loss          │      │   crash → restart → WAL REPLAY          │
  │ (correct for tests/Studio)    │      │ backups/PITR: Supabase-managed          │
  └────────────────────────────────┘     │ tested restore path: NOT EXERCISED      │
                                          │ synchronous_commit: default (on)        │
                                          └──────────────────────────────────────────┘
   same Promise<void> type · opposite durability · caller can't tell from the contract
```

## Elaborate

Write-ahead logging is the foundation of every ACID database's "D"; the subtlety people miss is that durability is configurable — `synchronous_commit = off` trades a small data-loss window for throughput, and buffr leaves it at the safe default. The genuinely actionable gap is the untested restore: Supabase's managed backups are real, but a restore that's never been run is a restore you don't know works. A one-time drill — restore to a scratch database, re-run a search, confirm the corpus and recall — converts an assumption into a verified property, and it's the single highest-value durability task here. Read next: 05 for the commit that triggers the WAL, 08 for what replicas add (and what stale reads cost), 09 for the restore gap ranked.

## Interview defense

**Q: When is a write durable in this system?**

```
  upsert resolves  ≠  durable          commit returns  =  durable
  (could be the Map — RAM only)        (WAL fsync'd to disk)
```

Answer: "At `commit`, when Postgres fsyncs the WAL record to disk — `synchronous_commit` is the default `on`, so commit doesn't return until the log is on disk. The trap is the contract: `upsert` returns `Promise<void>` in both stores, but in `InMemoryVectorStore` that resolves the moment a `Map.set` finishes — zero durability. Same promise type, opposite guarantee. Durability lives at the fsync, not at the promise." Anchor: *the fsync at commit is the durability point; the resolved promise isn't.*

**Q: You're on Supabase — so you're covered for data loss?**

Answer: "For *backups*, yes — Supabase manages backups and PITR. For *recovery*, honestly no: there's no tested restore path. Nobody has restored this database from a backup and confirmed the corpus and recall come back. 'We have backups' and 'we have a tested restore' are different claims. The highest-value durability task is a one-time restore drill to a scratch DB." Anchor: *backups are not recovery until you've restored once.*

## See also

- `05-transactions-isolation-and-anomalies.md` — the commit that forces the WAL.
- `08-replication-and-read-consistency.md` — replicas that consume the WAL stream.
- `01-database-systems-map.md` — the durability boundary at the pg.Pool hop.
- `09-database-systems-red-flags-audit.md` — the untested-restore risk, ranked.
