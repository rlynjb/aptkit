# 05 — Transactions, isolation, and anomalies

**Subtitle:** ACID / isolation levels / read-write anomalies — *Industry
standard* (taught), *status: not yet exercised; analog: single-file write +
read-time validation* (in-repo)

---

## Zoom out, then zoom in

A transaction is the promise that a group of reads and writes either all
happen or none do, and that concurrent transactions don't see each other's
half-finished work. That promise is what lets you move money between two rows
without losing it. AptKit makes no such promise — there is no `BEGIN`, no
`COMMIT`, no rollback, and no isolation level, because there's nothing that
spans more than one file write. This file teaches what transactions and
isolation actually guarantee, then shows precisely why AptKit doesn't need
them *yet* and the single change that would create the need.

```
  Zoom out — where a "transaction" would sit (but doesn't)

  ┌─ Service layer ───────────────────────────────────────────┐
  │  /api/replay/save → ONE writeFile()                       │ ← we are here:
  │  promote:replay  → read 2 files, write 1 (no BEGIN/COMMIT) │   no txn wraps these
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ───────────▼───────────────────────────────┐
  │  filesystem: each write is its own all-or-nothing-ish op   │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question: *what consistency does AptKit guarantee across a
write, and what would break it?* Today: each save is a single `writeFile`,
which the OS makes roughly atomic per-file, and each record is immutable once
written — so there's no multi-step transaction to get half-done and no
in-place update to race on. The integrity check (`assertReplayArtifactShape`)
is a constraint, but it runs at read time, not as part of a commit. That's the
gap to understand.

---

## Structure pass

The layers: the **logical operation** (save a run / promote a baseline) and
the **physical writes** it decomposes into. Axis to hold constant:
**atomicity — if the process dies mid-operation, what state is left behind?**

```
  One axis — "what survives a crash mid-operation?" — across operations

  ┌───────────────────────────────────────────┐
  │ save a run: ONE writeFile                 │  → crash before: nothing written
  └───────────────────────────────────────────┘    crash during: a partial file
                                                    (no temp+rename guard)
      ┌───────────────────────────────────────┐
      │ promote: read 2, write 1 new file     │  → crash during: source files
      └───────────────────────────────────────┘    intact (only reads); output
                                                    may be partial/absent
      ┌───────────────────────────────────────┐
      │ a HYPOTHETICAL update spanning 2 files│  → crash during: ONE updated,
      └───────────────────────────────────────┘    one not — TORN STATE.
                                                    This is what AptKit avoids
                                                    by never doing it.

  the seam: as soon as one logical operation touches two files, you cross from
  "no transaction needed" to "you need a transaction or you get torn state."
```

The load-bearing seam is the multi-file boundary. AptKit stays on the safe
side of it by construction: every logical write is a single new file. Cross
that seam — make one save update two files, or update a file in place under
concurrency — and you've created the exact problem transactions exist to
solve.

---

## How it works

### Move 1 — the mental model

You know how React's `setState` batches updates so the UI never renders a
half-applied state? A transaction is that guarantee for storage: a batch of
writes commits as one indivisible step, and readers either see all of it or
none. The mental model is **ACID — Atomicity (all-or-nothing), Consistency
(constraints hold across the batch), Isolation (concurrent batches don't see
each other's middle), Durability (committed survives a crash).**

```
  the real mechanism: a transaction brackets writes into one atomic unit

   BEGIN ──────────────────────────────────────► COMMIT
     │   write A      write B      write C          │
     │   (debit)      (credit)     (log)            │
     └─ readers see the OLD world ────────────────► readers see the NEW world
        (nothing in between is visible)             (all three, together)

   crash anywhere before COMMIT → ROLLBACK → as if BEGIN never happened
```

### Move 2 — the parts that matter

**Atomicity.** A transaction's first promise: all writes land or none do. A
single `writeFile` gets a *weak* version of this for free — POSIX makes a
single write of a small file unlikely to interleave with another writer's
file, and AptKit writes distinct filenames so two writers never target the
same file. What breaks without true atomicity: a crash *during* the
`writeFile` can leave a truncated, invalid JSON file on disk. AptKit doesn't
guard against this (no temp-file-and-`rename`), so the durability story in
`07` is where this bites. For now, atomicity across *multiple* files is `not
yet exercised` — nothing requires it.

**Consistency (constraints).** A transaction must leave the database obeying
its constraints. AptKit's "constraints" are the shape assertions
(`assertReplayArtifactShape`), but here's the critical difference: a database
checks constraints *as part of the commit and rejects the write if they
fail*. AptKit checks shape *at read time* — `/api/replay/save` runs only the
lightweight `normalizeReplayArtifact`, so a malformed-but-normalizable
artifact can persist and only fail later when something evals it. The
constraint exists; its enforcement is deferred.

```
  WHERE the constraint is enforced — the key difference

  database:   write → CHECK constraint → reject if bad → commit
                                │
                                └─ bad data never lands

  AptKit:     /api/replay/save → normalize (partial check) → writeFile
              ...later...
              read → assertReplayArtifactShape → bad data found HERE
                                │
                                └─ bad data already on disk; caught on read
```

**Isolation.** A transaction's promise that concurrent transactions don't see
each other's uncommitted writes. AptKit has *no concurrent writers to the same
record* — each save is a new file — so there are no read-write or write-write
anomalies to isolate against. Isolation levels (read-committed, repeatable-read,
serializable) are `not yet exercised`. The trigger: two processes update the
*same* file, or one logical update spans files that another reader interleaves
with.

**The anomalies you'd see if you crossed the seam.** Worth naming so you
recognize them: *lost update* (two writers read a file, both modify, both
write back, one clobbers the other), *dirty read* (a reader sees a write that
later rolls back), *write skew* (two transactions each read a consistent
state and write changes that together violate an invariant). AptKit's
append-only-new-file pattern sidesteps all three — you can't lose an update to
a file nobody updates in place. That's not isolation; it's avoiding the
situation isolation manages.

### Move 3 — the principle

Transactions and isolation are the price of *mutable, shared* state. AptKit
pays nothing because its state is *immutable and unshared per record* — write
once, never update, unique filenames. The generalizable rule: **if you make
every write produce a new immutable record instead of mutating an existing
one, you delete an entire class of concurrency bugs without a single lock or
transaction.** The cost is that you can't express "update this thing" — and
the moment a feature needs that, you've signed up for transactions.

---

## Primary diagram

```
  AptKit "transaction" model — single-file, write-once, read-time check

  ┌─ a "save" (the whole transaction) ────────────────────────┐
  │  build artifact in memory                                 │
  │       │                                                   │
  │       ▼                                                   │
  │  normalizeReplayArtifact()   ← partial write-time check   │
  │       │                       (schemaVersion, ids, trace) │
  │       ▼                                                   │
  │  writeFile(unique-name.json) ← one atomic-ish op, no fsync│
  └────────────────────────────────────────────────────────────┘
                    │  (no rollback, no lock, no isolation level)
                    ▼
  ┌─ later, on READ ──────────────────────────────────────────┐
  │  assertReplayArtifactShape() ← the FULL constraint check,  │
  │                                deferred to read time       │
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The "transaction" is every save and every promotion. The
deferred constraint check fires on every eval (`npm run eval:replays`) and
every Studio listing. The lost-update anomaly is *avoided* everywhere because
no code path updates a file in place.

**The whole "transaction" — a single write** —
`apps/studio/vite.config.ts:372-378`:

```
  const artifact = normalizeReplayArtifact(body.artifact); ← partial constraint
                                                              check (throws → 400)
  const outDir = resolve(workspaceRoot(), 'artifacts/replays');
  await mkdir(outDir, { recursive: true });
  const path = join(outDir, `${formatTimestamp(...)}-${slugify(...)}-studio.json`);
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8'); ← COMMIT
       │                                                                      (the only
       │                                                                       durable step)
       └─ no BEGIN, no rollback. If this throws after a partial write, the
          partial file stays. Unique filename means it can't clobber another save.
```

**The deferred constraint** — `packages/evals/src/assertions.ts:58-72,114-117`:

```
  export function assertReplayArtifactShape(output) {
    const result = assertRequiredPaths(output, [
      'schemaVersion', 'createdAt', 'durationMs', 'provider.id', ...
      'eval.name', 'eval.ok', 'modelTurns',
    ]);                                       ← the "constraints" (required columns)
    ...
    const replayEval = output.eval;
    if (!isRecord(replayEval) || replayEval.ok !== true) {
      issues.push({ path: 'eval.ok', message: 'expected embedded replay eval to pass' });
    }                                         ← a CHECK constraint: the embedded
                                                eval must have passed
    ...
  }
       │
       └─ this is real integrity logic, but nothing calls it on the write path.
          It runs when a reader (CLI eval, Studio list, promotion) pulls the
          record back. Constraint enforcement is read-time, not commit-time.
```

**The partial write-time check** — `apps/studio/vite.config.ts:1497-1512`:

```
  function normalizeReplayArtifact(value) {
    if (value.schemaVersion !== 1) throw new Error('artifact schemaVersion must be 1');
    if (typeof value.createdAt !== 'string') throw new Error('...');
    if (!Array.isArray(value.trace)) throw new Error('artifact trace must be an array');
    ...
    return value;
  }
       │
       └─ a NOT-NULL-style guard that DOES run before writeFile. It catches
          gross malformation but not the full shape (it won't run the
          recommendation-shape sub-check). Partial commit-time constraint.
```

---

## Elaborate

ACID came from systems that had to mutate shared rows safely — banking,
inventory, anything with concurrent updates to the same datum. The anomalies
(lost update, dirty read, phantom, write skew) are all symptoms of *visibility
of intermediate state under concurrency*. AptKit avoids the entire category by
never sharing a mutable record: append-only, immutable, unique-named files.
This is the same insight behind event sourcing and immutable infrastructure —
don't update, append. Rein has built the mutable-shared-state version
elsewhere (buffr's SQLite-primary-with-Supabase-mirror has to reconcile
concurrent edits; AdvntrCue's Postgres session memory mutates rows), which is
exactly where transactions earn their keep. AptKit is the deliberate opposite:
no mutation, no transaction needed.

The trigger to introduce real transactions: any feature where one logical
change must touch two files atomically (e.g., "promote and update an index
file in the same step"), or where two processes update the same file. Until
then, transactions are correctly absent.

The *shape* of what's written (the artifact schema, `schemaVersion`) belongs
to `study-data-modeling`; this file owns only the atomicity and isolation
mechanics around the write.

---

## Interview defense

**Q: "You have no transactions. How do you avoid lost updates and corruption?"**

> By never updating in place. Every save writes a new, uniquely-named immutable
> file, so two writers never touch the same record and there's no lost-update
> race — I avoid the situation transactions manage rather than managing it.
> Where I'm honest: there's no fsync and no temp-and-rename, so a crash mid-write
> can leave a truncated file, and my full integrity check runs at *read* time,
> not commit time — a malformed artifact can sit on disk until something evals it.

```
  no in-place update → no lost-update race
  but: single writeFile (no temp+rename) → crash can leave a torn file
       constraint check is read-time (assertions.ts:58), not commit-time
```

**Anchor:** "Append-only immutable files delete the concurrency-anomaly class;
the gap is read-time constraint enforcement at `assertions.ts:58`."

---

## Validate

1. **Reconstruct:** Name the four ACID properties and, for each, say whether
   AptKit provides it and via what mechanism (or that it's absent).
2. **Explain:** Why does AptKit have no lost-update anomaly despite no locks?
   Tie it to the unique-filename write at `vite.config.ts:376`.
3. **Apply:** A new feature must "promote a fixture AND append its id to a
   manifest file" atomically. What breaks under a crash, and what would you
   reach for?
4. **Defend:** Argue why read-time constraint checking (`assertions.ts:58`) is
   acceptable here, and name the failure it permits that a commit-time check
   would prevent.

---

## See also

- `06-locks-mvcc-and-concurrency-control.md` — why no locks are needed
- `07-wal-durability-and-recovery.md` — the torn-write risk on a single writeFile
- `04-query-planning-and-execution.md` — the promotion 1×1 "join" two-file read
- `study-data-modeling` → the artifact schema the constraints check
