# 05 · Transactions, Isolation, and Anomalies

**Industry name(s):** ACID transactions, isolation levels, read/write anomalies. **Type:** Industry standard.

## Zoom out, then zoom in

You know "all-or-nothing" from a form submit that should either fully save or not touch the DB at all. That's atomicity. This repo has exactly one place that reaches for it — the multi-chunk upsert — and everything else runs on Postgres's default isolation without ever naming it.

```
  Zoom out — where transactions live

  ┌─ Pipeline (aptkit) ────────────────────────────────────┐
  │  store.upsert(chunks)   — no transaction concept here   │
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Store layer ──────────────▼────────────────────────────┐
  │  InMemory: no transaction — single-threaded JS tick      │
  │  Postgres: ★ begin / commit / rollback per upsert ★      │ ← we are here
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Postgres ─────────────────▼────────────────────────────┐
  │  READ COMMITTED (default) · MVCC snapshots               │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **the transaction boundary** — the span where a set of writes is atomic and isolated. buffr draws exactly one: a document's chunks all land or none do. aptkit draws none (it doesn't need to — see below). And the isolation *level* — what one transaction can see of another's in-flight writes — is whatever Postgres defaults to: READ COMMITTED. No code sets it, so no stronger guarantee is claimed.

## The structure pass

**Layers.** The transaction matters at the store layer only. Above it, the pipeline and tools issue logical operations ("index this document") with no transactional vocabulary. Below it, buffr wraps the physical writes; aptkit relies on the JS event loop.

**Axis — trace "what's the atomic unit, and what can a concurrent reader see mid-write?":**

```
  One question across the stores: "what is atomic, and what's visible mid-write?"

  ┌─ InMemory ──────────────────────────┐
  │  atomic unit: the whole upsert call  │ → JS is single-threaded; the loop
  │  visible mid-write: N/A              │   runs to completion in one tick,
  │                                      │   no other code interleaves
  └──────────────────────────────────────┘
  ┌─ Postgres (PgVectorStore) ──────────┐
  │  atomic unit: ONE document's chunks  │ → begin..commit; rollback on error
  │  visible mid-write: nothing (other   │   READ COMMITTED: a reader sees only
  │  txns see pre-commit state)          │   committed rows, never the half-loop
  └──────────────────────────────────────┘
```

**Seam.** The boundary is `begin`/`commit` in `PgVectorStore.upsert`. Inside it: a multi-row loop that's atomic. Outside it: the document-text insert into `agents.documents` and the chunk insert are **separate operations** — the FK was dropped (01), so there's no transaction spanning "write the document row" and "write its chunks." That's the anomaly surface: document and chunks can drift apart.

## How it works

### Move 1 — the mental model

A transaction is a `try/finally` with teeth: everything between `begin` and `commit` either all happens or the `rollback` in the `catch` undoes it. You've written the JS shape a hundred times; the database version adds durability and isolation on top.

```
  The transaction kernel — begin, body, commit-or-rollback

   begin
     │
     ├─ INSERT chunk 0
     ├─ INSERT chunk 1        ← if ANY throws here...
     ├─ INSERT chunk 2
     │
   commit   ──────────────►  all chunks durable, visible together
     │
   (on throw) rollback ────►  NONE of the chunks exist; clean slate
```

The kernel parts, each named by what breaks without it: lose `begin` and each insert auto-commits individually (partial document on a mid-loop crash); lose `rollback` and a failed insert leaves the earlier chunks orphaned; lose `commit` and nothing persists. All three are present in buffr.

### Move 2 — the walkthrough

**The one real transaction — atomic per document.** This is the entire transactional surface of the codebase:

```ts
// buffr/src/pg-vector-store.ts:40-65
const client = await this.pool.connect();           // dedicated connection for the txn
try {
  await client.query('begin');                      // open the transaction
  for (const c of chunks) {
    ...
    await client.query(`insert into agents.chunks (...) on conflict (id) do update set ...`, [...]);
  }
  await client.query('commit');                     // all chunks land together
} catch (err) {
  await client.query('rollback');                   // any failure → none land
  throw err;
} finally {
  client.release();                                 // return the connection to the pool
}
```

Walk it. `pool.connect()` pulls a *dedicated* connection — transactions are connection-scoped, so you can't `begin` on the pool and run inserts on arbitrary pooled connections. `begin` opens it. The loop inserts every chunk. `commit` makes them all durable and visible at once. If insert #7 of 50 throws, `rollback` erases chunks 0–6 — the document's vectors are all-or-nothing. `finally` releases the connection back to the pool no matter what. This is correct, minimal, textbook atomicity for the unit "one document's chunks."

**The migration runner uses the same pattern.** Schema changes are also atomic:

```ts
// buffr/src/migrate.ts:8-20
await client.query('begin');
await client.query(sql);                            // the whole 001_agents_schema.sql
await client.query('commit');
// catch → rollback; finally → release
```

The entire schema script runs in one transaction — partial schema application is impossible. Same kernel, applied to DDL.

**The isolation level is never set — so it's READ COMMITTED.** Search every `query` call in buffr: none issue `set transaction isolation level`. Postgres's default is **READ COMMITTED**, so that's what every transaction here runs at. What that buys: a statement sees only data committed *before the statement began*. What it does *not* prevent: non-repeatable reads (re-read the same row mid-transaction, get a different value if another txn committed in between) and phantom reads (a range query returns new rows on re-run). For this workload — single-writer upserts, search reads that don't re-read — READ COMMITTED is enough, and nobody claimed more. No `serializable`, no `repeatable read`, no `select ... for update`: **`not yet exercised`**.

**The anomaly that IS reachable — document/chunk drift.** Here's the real exposure, and it comes straight from the dropped FK (01). Indexing a document is *two* unrelated writes:

```
  Layers-and-hops — the NON-atomic span across documents and chunks

  ┌─ application (buffr) ─┐
  │ 1. INSERT agents.documents row   ──┐   (one statement, its own implicit txn)
  │                                    │   ★ NO transaction spans these two ★
  │ 2. PgVectorStore.upsert(chunks) ───┘   (begin..commit — its own txn)
  └────────────────────────────────────┘
        │
        ▼ if the process dies between 1 and 2:
   a documents row exists with ZERO chunks  — or chunks exist with no documents row
   (the dropped FK means the engine won't catch either)
```

Because there's no FK and no enclosing transaction across "insert the document" and "insert the chunks," a crash between them leaves the two tables inconsistent — orphan chunks or a chunk-less document — and Postgres won't complain. The per-document upsert transaction protects the *chunks among themselves*, not the *document-to-chunks* relationship. That's the deliberate cost of parity (01) showing up as a consistency anomaly. Today it's tolerable because indexing is a manual, low-frequency, single-writer operation; it becomes a real bug under concurrent or automated indexing.

### Move 3 — the principle

A transaction is only as wide as you draw it, and READ COMMITTED is what you get when you draw none around isolation. buffr draws the boundary tightly around "one document's chunks" and accepts that the document-to-chunks link sits outside any transaction — a direct consequence of dropping the FK for contract parity. The general lesson: atomicity protects exactly the span you wrap, and every guarantee you don't explicitly request defaults to the engine's weakest acceptable one.

## Primary diagram

```
  Full transaction picture — what's atomic, what isn't

  ┌─ ATOMIC (one txn each) ────────────────────────────────────────┐
  │  PgVectorStore.upsert:  begin → INSERT chunk×m → commit/rollback│
  │  migrate.runMigration:  begin → run whole schema → commit       │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ NOT ATOMIC (no spanning txn) ─────────────────────────────────┐
  │  INSERT documents row    ─┐  crash here → orphans               │
  │  upsert(chunks)          ─┘  (FK dropped → engine won't catch)  │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ ISOLATION ────────────────────────────────────────────────────┐
  │  READ COMMITTED (Postgres default — never set in code)          │
  │  serializable / repeatable read / FOR UPDATE: NOT EXERCISED     │
  └─────────────────────────────────────────────────────────────────┘
  ┌─ aptkit InMemory: no txn — single JS tick is the atomic unit ──┐
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

ACID's "A" and "I" are what this file covers; "D" (durability) is 07 and "C" (consistency) leans on the constraints the FK *would* have enforced (data-modeling). The interesting historical note is that buffr *had* a `chunks_document_id_fkey` and explicitly dropped it (`001_agents_schema.sql:26-27`) — so the document/chunk anomaly is a known, accepted trade, not an oversight. If automated re-indexing ever runs concurrently, the move is either to restore a deferred FK (`deferrable initially deferred`, checked at commit) or to wrap document+chunk writes in one transaction at the application layer — both reintroduce the spanning boundary the contract gave up. Read next: 06 for the locking and MVCC under READ COMMITTED, 07 for durability.

## Interview defense

**Q: What's atomic in this system, and what isn't?**

```
  atomic:    [ begin → chunk0..chunkM → commit ]   ← one document's vectors
  NOT atomic: INSERT documents  ╳  upsert chunks    ← no txn spans them
                                 (FK dropped)
```

Answer: "One document's chunks are atomic — `begin/commit/rollback` around the insert loop (`pg-vector-store.ts:40-65`), so a mid-loop failure rolls back every chunk. What's *not* atomic is the document row plus its chunks: they're separate writes with no spanning transaction, and the FK was dropped for contract parity, so a crash between them leaves orphans and the engine won't catch it. It's an accepted trade today because indexing is single-writer and manual." Anchor: *atomic per document, not across document-and-chunks.*

**Q: What isolation level do you run at?**

Answer: "READ COMMITTED — the Postgres default, because the code never sets one. That's the honest answer: no `set transaction isolation level` anywhere. It's fine for this workload — single-writer upserts, search reads that don't re-read rows, so non-repeatable reads and phantoms don't bite. If I added a read-modify-write on the same row under concurrency, I'd reach for `repeatable read` or `select ... for update`." Anchor: *no level set means READ COMMITTED — name the default, don't pretend it's stronger.*

## See also

- `01-database-systems-map.md` — the dropped FK that creates the cross-table anomaly.
- `06-locks-mvcc-and-concurrency-control.md` — what READ COMMITTED does under concurrency.
- `07-wal-durability-and-recovery.md` — the "D" that commit triggers.
- study-data-modeling — the FK decision and integrity constraints.
- study-distributed-systems — the best-effort writes (memory, trace flush) outside any txn.
