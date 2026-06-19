# 06 — Locks, MVCC, and concurrency control

**Subtitle:** Pessimistic locking / optimistic concurrency / MVCC — *Industry
standard* (taught), *status: not yet exercised; analog: append-only writes +
in-memory single-reader cursor* (in-repo)

---

## Zoom out, then zoom in

Concurrency control is how a database lets many readers and writers touch the
same data without stepping on each other — locks that block, or MVCC that
hands each reader its own snapshot version. AptKit has neither, and it doesn't
need them, for a reason worth understanding precisely: it never has two
writers contending for the same record. This file teaches locks and MVCC as
the two answers to "concurrent access to mutable state," then shows how
AptKit dodges the question entirely by making state immutable per record.

```
  Zoom out — where concurrency control would sit (but doesn't)

  ┌─ Service layer ───────────────────────────────────────────┐
  │  many save requests → each writes a DIFFERENT file        │ ← we are here:
  │  many list requests → each reads independently            │   no shared mutable
  │  replay → ONE in-memory cursor, single-threaded           │   record exists
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ───────────▼───────────────────────────────┐
  │  filesystem: no two writers ever target the same file     │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question: *what stops two operations from corrupting shared
state?* Answer: there is no shared mutable state to corrupt. Writes are
append-only to unique filenames; the only stateful object, the
`FixtureModelProvider`'s `index` cursor, lives inside a single agent run on
one thread. So concurrency control is `not yet exercised` — and the file's job
is to show you exactly what would force it in.

---

## Structure pass

The layers: **on-disk records** (the artifacts and fixtures) and the
**in-memory cursor** (the replay provider's `index`). Axis to hold constant:
**contention — can two actors mutate the same thing at the same time?**

```
  One axis — "can two actors mutate the same thing?" — across layers

  ┌───────────────────────────────────────────┐
  │ on-disk record (a .json file)             │  → NO: each write is a new file;
  └───────────────────────────────────────────┘    no two writers share a target
      ┌───────────────────────────────────────┐
      │ in-memory cursor (provider.index)     │  → NO: lives inside one agent
      └───────────────────────────────────────┘    run, single-threaded, not shared
      ┌───────────────────────────────────────┐
      │ HYPOTHETICAL shared mutable file      │  → YES: this is where you'd need
      └───────────────────────────────────────┘    a lock or MVCC. Not present.

  the seam: contention only appears if you introduce a shared mutable target.
  Today every mutable thing is single-owner, so there's nothing to control.
```

The load-bearing seam is "single-owner mutable state" vs "shared mutable
state." Everything mutable in AptKit is single-owner (a cursor inside one run)
or immutable (a written file). Cross into shared-mutable — a counter file two
requests both increment, an in-place artifact edit — and you've created the
need for the locks or MVCC this file teaches.

---

## How it works

### Move 1 — the mental model

You know optimistic UI updates: you apply a change locally, send it, and if
the server rejects it you roll back — versus a pessimistic spinner that blocks
input until the server confirms. That's the exact split in concurrency
control. The mental model: **two strategies for shared mutable state —
pessimistic (lock it so no one else can touch it while I work) or optimistic
(let everyone proceed, detect conflicts at write time, retry the loser).**

```
  the two strategies for the same race

  PESSIMISTIC (locks)            OPTIMISTIC (version check / MVCC)
  ───────────────────            ─────────────────────────────────
  T1: LOCK row ─┐                T1: read row v5 ─┐
  T2: wait...   │ blocked        T2: read row v5  │ both proceed
  T1: write     │                T1: write if v==5 → v6 ✓
  T1: UNLOCK ◄──┘                T2: write if v==5 → CONFLICT, retry on v6
  no conflict, but contention    no blocking, but retries under contention
```

### Move 2 — the parts that matter

**Pessimistic locking (absent, by design).** A lock serializes access: hold it
and others wait. The cost is contention — blocked work, and deadlock if locks
are taken in different orders. AptKit takes no locks because no two writers
share a target file; there's nothing to serialize. What would break if you
needed one and didn't have it: two requests incrementing the same counter file
would interleave read-modify-write and lose an increment (the lost update from
`05`). `not yet exercised`; trigger = a shared mutable file.

**Optimistic concurrency / version checks (absent).** The optimistic answer:
attach a version to each row, let everyone read and compute, and at write time
accept only if the version is unchanged — otherwise the writer retries. AptKit
has a `schemaVersion` field (always `1`), but it's a *schema* version for shape
validation, not a *row* version for conflict detection — nothing does
compare-and-swap on it. So optimistic concurrency is `not yet exercised`;
trigger = concurrent updates to one record where last-writer-wins is
unacceptable.

**MVCC (absent, but determinism gives the same benefit).** MVCC keeps multiple
versions of a row so a reader gets a consistent snapshot without blocking
writers — readers never wait for writers, writers never wait for readers.
AptKit gets the *reader-never-blocked* benefit for a different reason: records
are immutable, so a reader of a file is never racing a writer of that same
file (the writer is creating a *different* file). It's not version-chained
MVCC; it's "every record is its own permanent version." The version chain that
MVCC maintains is replaced by an ever-growing directory of immutable files.

```
  MVCC's version chain vs AptKit's immutable directory

  MVCC (one logical row, many versions):
     row#42 ─► v3 ─► v4 ─► v5(committed) ─► v6(uncommitted)
                              ▲ reader started here sees v5

  AptKit (no logical row; every write is a new permanent record):
     2026-..-16-45-...json  ┐
     2026-..-16-53-...json  │ all permanent, all visible, none supersedes
     2026-..-19-29-...json  ┘ another. A reader always sees a stable file.
```

**The one piece of genuine in-memory state: the cursor.** The
`FixtureModelProvider` holds `private index = 0` and advances it on each
`complete()` call. This is mutable state — but it's owned by exactly one agent
run, mutated single-threaded, and discarded when the run ends. There's no
shared access, so no control is needed. What would break it: sharing one
provider instance across concurrent runs would make two runs advance the same
cursor and read each other's responses. The code never does this — each
`runReplay` constructs a fresh provider.

### Move 3 — the principle

Concurrency control is the tax you pay for *shared mutable state*. The two ways
to avoid the tax entirely are (a) don't share — give each actor its own copy or
its own target, and (b) don't mutate — append new versions instead of changing
old ones. AptKit does both: unique-filename writes (don't share a target) and
immutable records (don't mutate). The generalizable rule: **before reaching for
locks or MVCC, ask whether you can make the state immutable or unshared —
because the cheapest concurrency control is having no contention to control.**

---

## Primary diagram

```
  AptKit concurrency model — no contention by construction

  ┌─ writers ─────────────────────────────────────────────────┐
  │  save A ─► writeFile(name_A.json)  ┐                       │
  │  save B ─► writeFile(name_B.json)  │ disjoint targets:     │
  │  save C ─► writeFile(name_C.json)  ┘ no lock, no conflict  │
  └────────────────────────────────────────────────────────────┘
  ┌─ readers ─────────────────────────────────────────────────┐
  │  list/eval ─► read immutable files ─► never blocked        │
  │              (a file never changes under you)              │
  └────────────────────────────────────────────────────────────┘
  ┌─ the one mutable cell ────────────────────────────────────┐
  │  FixtureModelProvider.index ─► single-owner, single-thread │
  │  (fresh instance per run; never shared) → no control needed│
  └────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** Concurrency control would be reached for if two Studio saves
raced the same file (they can't — unique names) or if one provider instance
were shared across runs (it isn't — fresh per run). Neither happens, so there's
no lock/MVCC code to point at. The honest implementation evidence is the
*absence-by-construction*: the unique filename and the per-run provider.

**Why writers don't contend — unique target** —
`apps/studio/vite.config.ts:376`:

```
  const path = join(outDir,
    `${formatTimestamp(new Date(artifact.createdAt))}-${slugify(artifact.fixture.id)}-${slugify(artifact.provider.id)}-studio.json`);
       │
       └─ millisecond timestamp + slug → effectively unique per save. Two
          concurrent saves write two different files, so there is no shared
          write target and therefore no write-write conflict to lock against.
```

**The one mutable cell, and why it's safe** — `fixture-provider.ts:7-17`:

```
  export class FixtureModelProvider implements ModelProvider {
    private index = 0;                       ← mutable state...
    constructor(private readonly responses: ModelResponse[]) {}
    async complete(request) {
      this.requests.push(request);
      const response = this.responses[this.index];
      this.index += 1;                       ← ...mutated here, every call
      if (!response) throw new Error(`fixture model exhausted ...`);
      return response;
    }
  }
       │
       └─ this index is the only "row version cursor" in the repo. It's safe
          without a lock because every run builds its OWN provider — see the
          next snippet.
```

**Fresh provider per run — no sharing** — `apps/studio/vite.config.ts:756`:

```
  function createModelProvider(fixture, mode, trace) {
    if (mode === 'fixture') return new FixtureModelProvider(fixture.modelResponses);
                                  │
                                  └─ a NEW instance per replay. The cursor is
                                     never shared across concurrent runs, so the
                                     single mutable cell stays single-owner.
  }
```

---

## Elaborate

Locks, MVCC, and optimistic concurrency are three answers to one question:
what happens when two transactions want the same mutable datum at once?
Postgres and most modern engines lean on MVCC because it lets reads and writes
proceed without blocking each other, at the cost of keeping old row versions
around (and vacuuming them). The deep idea AptKit borrows — without any of the
machinery — is immutability: if a record never changes, a reader never needs a
snapshot because the only version *is* the snapshot. Event-sourced systems and
Git's object store work the same way. Rein's mutable-state projects (buffr's
local-canonical-plus-cloud-mirror, AdvntrCue's session memory in Postgres) are
where real concurrency control would live; AptKit is deliberately on the
immutable side.

The trigger to introduce concurrency control: introduce a shared mutable
target — a counter, an in-place artifact edit, a manifest file two requests
update — or run agents concurrently sharing one provider. Any of those
recreates the contention this file's mechanisms exist to manage. Until then,
"no locks" is the correct answer, not a missing feature.

---

## Interview defense

**Q: "No locks, no MVCC — how do concurrent writes stay correct?"**

> There's no contention to control. Writes go to unique-named files, so two
> writers never share a target — no write-write conflict, nothing to lock. Reads
> hit immutable files, so a reader is never racing a writer of the same record,
> which gives me the reader-never-blocks property of MVCC without a version
> chain. The only mutable state is a per-run response cursor inside one agent,
> single-threaded and never shared. The cheapest concurrency control is having
> no shared mutable state.

```
  unique filenames  → no shared write target → no lock needed
  immutable records → reader never races writer → MVCC's benefit, free
```

**Anchor:** "Immutability replaces MVCC here — `fixture-provider.ts:13` is the
only mutable cell, and it's single-owner."

---

## Validate

1. **Reconstruct:** Draw the pessimistic-lock timeline and the optimistic /
   MVCC timeline for two writers, then explain why AptKit has neither.
2. **Explain:** Why is `FixtureModelProvider.index` safe to mutate without a
   lock? Tie it to `vite.config.ts:756`.
3. **Apply:** You add a `views-count.json` that every replay increments. What
   anomaly appears under concurrent requests, and which control fixes it?
4. **Defend:** Argue why "no concurrency control" is correct for AptKit today
   and name the single change that would make it wrong.

---

## See also

- `05-transactions-isolation-and-anomalies.md` — the anomalies locks/MVCC prevent
- `08-replication-and-read-consistency.md` — the cursor as the deterministic read
- `07-wal-durability-and-recovery.md` — durability of those immutable writes
- `study-system-design` → where shared mutable state would enter the system
