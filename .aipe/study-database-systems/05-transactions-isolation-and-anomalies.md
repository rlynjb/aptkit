# Transactions, Isolation, and Anomalies

**Industry name:** ACID transactions / isolation levels / atomicity boundary · *Industry standard*

## Zoom out — where transactions wrap

buffr uses explicit transactions in exactly two places. Knowing *which two*
— and which operations are left *outside* a transaction — is the lesson:

```
  Zoom out — transaction boundaries in buffr

  ┌─ Application (buffr) ──────────────────────────────────────┐
  │  runMigration()    ─► begin / DDL / commit  (migrate.ts:8) │
  │  PgVectorStore.upsert ─► begin / N inserts / commit        │ ← we are here
  │                          (pg-vector-store.ts:40-64)        │
  │                                                            │
  │  indexDocumentRow  ─► INSERT documents  (no txn)           │
  │                       then upsert()     (its own txn)      │ ← the seam
  │  persistMessage    ─► single INSERT      (no explicit txn) │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — what this file covers

The question: **what's atomic, what isn't, and which isolation level does
buffr run under?** Verdict first: the per-document chunk write is atomic; the
document-plus-chunks operation is *not*; and the isolation level is Postgres's
default Read Committed, never set anywhere.

## Structure pass

**Layers.** Statement (one `INSERT`, atomic on its own) → explicit
transaction (`begin`/`commit` wrapping several statements) → the logical
operation the application *intends* (which may span more than one
transaction).

**Axis — trace "is this all-or-nothing?" up the layers.**

```
  One question up the layers: "all-or-nothing?"

  one INSERT chunk            → yes (every statement is atomic)
  upsert(all chunks of a doc) → yes (begin/commit wraps the loop)
  index a document            → NO  (documents row in TXN A,
   (documents row + chunks)        chunks in TXN B — two txns)

  the atomicity guarantee FLIPS at the document boundary:
  inside one upsert it holds; across the document write it breaks
```

**Seam.** The load-bearing seam is `indexDocumentRow` (`runtime.ts:5-18`):
it writes the `documents` row, then calls `pipeline.index()` (the upsert) as
a separate transaction. The atomicity axis flips right there — that's the
boundary where "all-or-nothing" stops being true.

## How it works

### Move 1 — the mental model

A transaction is the same idea as wrapping several state updates so a React
component never renders a half-updated store — either all the updates land or
none do. In SQL it's `begin ... commit`, and the "render a half-state"
failure becomes "leave the database half-written after a crash."

```
  The atomicity kernel (begin/commit/rollback)

  begin                          ← open a transaction
    INSERT chunk 0               ┐
    INSERT chunk 1               │ all buffered against the same snapshot
    ...                          │
    INSERT chunk N               ┘
  commit                         ← all become visible at once, durably
    │
    └─ on any error: rollback    ← none of them happened
```

Name each part by what breaks without it:
- Drop **begin/commit** → each insert auto-commits on its own; a crash
  mid-loop leaves *some* chunks written. The document is half-indexed.
- Drop **rollback on error** → a failed insert mid-loop leaves the earlier
  inserts committed. Same half-written corruption.

### Move 2 — the moving parts

**The atomic upsert — what buffr gets right.**

```ts
// buffr/src/pg-vector-store.ts:40-64 (the skeleton)
const client = await this.pool.connect();   // one connection for the txn
try {
  await client.query('begin');
  for (const c of chunks) {
    await client.query(`insert into agents.chunks (...) on conflict (id) do update ...`);
  }
  await client.query('commit');             // all chunks land together
} catch (err) {
  await client.query('rollback');           // or none do
  throw err;
} finally {
  client.release();                         // give the connection back
}
```

Read the load-bearing details. The whole loop runs on **one pooled
connection** (`pool.connect()`, not `pool.query()`) — a transaction is
connection-scoped, so you must hold one connection across `begin`→`commit`.
The `finally { client.release() }` returns it to the pool no matter what.
And the `on conflict (id) do update` makes each insert an *upsert*, so
re-indexing the same document overwrites its chunks rather than erroring on
the PK — re-indexing is safe to retry. This is solid: a document's chunks are
all-or-nothing.

**The non-atomic document write — the anomaly buffr can hit.**

```
  index a document — two transactions, a gap between (runtime.ts:11-17)

  ┌─ TXN A ──────────────────┐
  │ INSERT into documents     │  ← commits independently
  └───────────┬───────────────┘
              │  ← CRASH HERE
              ▼
  ┌─ TXN B (upsert) ─────────┐
  │ begin; INSERT chunks; commit │  ← never runs if we crashed above
  └───────────────────────────┘

  result after a crash in the gap:
    a documents row exists  +  zero chunks for it
    → the dropped FK (001_agents_schema.sql:16) means nothing complains
```

This is a real **write skew / partial-write anomaly**, and the dropped
foreign key is what lets it pass silently. With a hard FK from `chunks` to
`documents`, this exact split wouldn't even be expressible the same way — but
the FK was dropped *on purpose* to keep the `VectorStore.upsert` contract
clean (it knows nothing about a documents row, → `00`, `01`). So buffr trades
"documents and chunks can never drift" for "the storage contract stays a
drop-in." The cost is named, not hidden: a crash between the two writes leaves
an orphan documents row. The fix if it ever matters: wrap both in one
transaction in `indexDocumentRow`, passing the client down into the pipeline
— which would mean the pipeline takes a transaction handle, a contract
change. buffr judged the orphan acceptable for a single-user reindex. `not
yet exercised` — no recovery code handles this.

**Isolation level — Read Committed, by inheritance.** buffr never issues
`set transaction isolation level` anywhere (`not yet exercised`). So every
transaction runs at Postgres's default: **Read Committed**. What that buys and
what it doesn't:

```
  Read Committed (Postgres default, what buffr runs)

  each STATEMENT sees a fresh snapshot of committed data
    → no dirty reads (never sees uncommitted rows)
    → DOES allow non-repeatable reads: the same SELECT twice
      in one txn can return different rows if another txn committed between
    → DOES allow phantom reads

  buffr's upsert is single-writer-per-doc and reads nothing it
  re-reads, so these anomalies don't bite — but it's by luck of
  the access pattern, not by a chosen isolation level
```

The honest read: Read Committed is the right default for buffr because its
write transactions don't read-then-write the same rows and there's
effectively one writer (a single-user laptop). If buffr ever did
read-modify-write inside a transaction under concurrency, Read Committed's
non-repeatable reads would start to matter and you'd reach for
`REPEATABLE READ` or explicit locking (→ `06`).

### Move 3 — the principle

Atomicity is a property of a *transaction boundary*, and the bug is almost
never inside the boundary — it's the operation that quietly spans *two*
boundaries. buffr's upsert is correctly atomic; the anomaly is the document
write that lives in one transaction and the chunk write in another, with a
crash-gap between them. When you reason about a write path, the question
isn't "is there a transaction" — it's "does *one* transaction cover the whole
logical operation."

## Primary diagram

```
  Transactions recap — buffr

  ATOMIC (one txn covers the operation)        NOT ATOMIC (two txns)
  ─────────────────────────────────────        ─────────────────────
  upsert(chunks of one doc):                    index a document:
    begin                                         INSERT documents   TXN A
      INSERT chunk 0..N (on conflict update)      └ crash gap ─┐
    commit  / rollback on error                   upsert chunks TXN B
    one pooled connection, released in finally

  isolation level: Read Committed (Postgres default, never set)
    no dirty reads · allows non-repeatable + phantom reads
    safe here only because writes don't re-read rows under concurrency
```

## Elaborate

ACID's "A" (atomicity) and "I" (isolation) are the two this file touches; "C"
(consistency) is partly *given away* here via the dropped FK, and "D"
(durability) is `07`. The pattern buffr follows — explicit `begin/commit`
with rollback in a `try/catch/finally` on a pooled connection — is the
canonical Node `pg` transaction idiom, and it appears identically in
`migrate.ts:8-20` for DDL. What's missing is any *defense* against the
two-transaction gap, because at single-user scale the gap is a reindex away
from being fixed by hand. The instant buffr had concurrent indexers or a
multi-step write that must not half-apply, the move is to thread one
transaction through the whole logical operation.

## Interview defense

**Q: Is indexing a document atomic?**
Half of it. The chunk write is — `upsert` wraps all of a document's chunks in
one `begin/commit` on a single connection, with rollback on error. But the
*documents* row is written in a separate transaction before that, so a crash
between them orphans the documents row. The dropped FK lets that pass
silently.

```
  INSERT documents (TXN A) ──gap──► upsert chunks (TXN B)
                            crash here = orphan row
```

**Q: What isolation level, and why?**
Read Committed — Postgres's default, never explicitly set. It's fine here
because the write transactions don't read-then-write the same rows and
there's effectively one writer. Under concurrent read-modify-write I'd move
to Repeatable Read or take explicit locks.

**Anchor:** "Atomic per document's chunks; not atomic across the document row
and its chunks — and the dropped FK is why nothing complains."

## See also

- `06-locks-mvcc-and-concurrency-control.md` — what Read Committed rests on (MVCC).
- `07-wal-durability-and-recovery.md` — what `commit` actually durably guarantees.
- `01-database-systems-map.md` — the two-transaction index path, mapped.
- study-data-modeling — the dropped-FK decision as a schema call.
