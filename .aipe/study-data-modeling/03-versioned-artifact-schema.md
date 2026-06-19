# versioned artifact schema

**Industry name(s):** schema versioning / schema-on-read with a version tag; the relational cousin is the migration version. **Type label:** Industry standard (versioning); the migration itself is `not yet exercised` in this repo.

## Zoom out, then zoom in

You know how a database has a `schema_migrations` table recording which migration version the DB is at, so the app knows whether the columns it expects exist? AptKit has exactly one byte of that idea: `schemaVersion: 1` stamped on every replay artifact. It's the entire migration story of the repo — and it's a story where no migration has happened yet.

```
  Zoom out — where the version tag sits

  ┌─ WRITE side (Studio, scripts) ──────────────────────┐
  │  build artifact → set schemaVersion: 1              │
  │     replay-artifacts.ts:25, replay-model-...mjs:68  │
  └───────────────────────────┬─────────────────────────┘
                              │  *.json on disk
  ┌─ STORED (artifacts/replays/*.json) ────────────────▼┐
  │  { "schemaVersion": 1, "capabilityId": ..., ... }   │ ← we are here
  └───────────────────────────┬─────────────────────────┘
                              │  read back
  ┌─ READ side (evals, Studio loader) ─────────────────▼┐
  │  if schemaVersion !== 1 → reject                    │
  │     assertions.ts:83-85, vite.config.ts:1503        │
  └───────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **schema-on-read versioning** — the stored data declares which schema it was written against, and the reader checks that declaration before trusting the shape. The question it answers: when a persisted shape can change over time, how does a reader know whether the file in front of it is a shape it understands?

## Structure pass

**Layers.** Three: the *writer* (stamps the version), the *stored file* (carries the version), the *reader* (gates on the version). The version is a contract that travels with the data across time, not across a network.

**Axis — trace "what happens to an old file when the schema changes?":**

```
  axis: "if the schema changes, what happens to existing files?"

  ┌─ today (only v1 exists) ─┐  seam: a v2 ships  ┌─ after v2 ─┐
  │  reader: schemaVersion   │ ═══════╪══════════► │  v1 files  │
  │  must === 1, else throw  │   (the gate flips   │  now throw │
  │  every file passes       │    from pass→fail)  │  unless    │
  └──────────────────────────┘                     │  migrated  │
                                                    └────────────┘
```

**Seam.** The version-check is the load-bearing joint. Right now it's `=== 1`: a *hard equality gate*. That's the most important fact about AptKit's migration story — the read side does not say "version ≥ 1" or "I can handle 1 or 2," it says "must be exactly 1, else fail." The day a `schemaVersion: 2` is needed, every reader is a one-line change away from rejecting all the v1 files on disk. The migration discipline this file teaches exists to make that transition survivable.

## How it works

### Move 1 — the mental model

Schema-on-read versioning is the inverse of a database migration. A DB migrates the *data* to match the new schema (alter the table, backfill the columns). Schema-on-read leaves old data alone and makes the *reader* smart enough to handle multiple versions.

```
  The pattern — version travels with the data, reader branches on it

  write:  data + schemaVersion:N  ─────►  file on disk
                                            │
  read:   ┌─ version === current? ──── yes ─┴─► trust the shape
          └─ older version?  ──── (today: throw)
                                  (mature: upgrade-on-read → current shape)
```

The kernel: a version field + a read-time branch on it. Strip the version field and the reader has no way to tell a v1 file from a v2 file — it would parse a stale shape as if it were current and read garbage. That's the part that breaks if it's missing.

### Move 2 — the walkthrough

**The version stamp (write side).** Every artifact is constructed with `schemaVersion: 1` hard-coded. Bridge: it's the same as a serializer writing a format-version byte at the top of a binary file. It's not derived from anything — it's the writer asserting "I wrote this in the v1 shape."

**The hard-equality gate (read side).** Two readers check it, both with `!== 1`:

```
  the gate, today (execution trace)

  file = { schemaVersion: 1, ... }
    assertions.ts:83 → output.schemaVersion !== 1 ? push issue : ok
                       1 !== 1 → false → PASS

  file = { schemaVersion: 0, ... }   (hypothetical old file)
    1-check → 0 !== 1 → true → ISSUE "expected schemaVersion 1"
    vite.config.ts:1503 → throw 'artifact schemaVersion must be 1'
                          → the file is unreadable, full stop
```

This is correct *and* brittle. Correct: a malformed or stale file is rejected loudly rather than misread. Brittle: there is no upgrade path — an old version doesn't get migrated, it gets refused.

**What's missing (the migration that hasn't happened).** A mature versioning story has three more parts AptKit doesn't have yet:

```
  what a real v1→v2 migration needs (none of this exists yet)

  ┌─ 1. upgrade-on-read ─┐   migrate(v1) → v2 shape in memory
  ┌─ 2. range-accept ────┐   reader handles {1, 2}, not ===2
  ┌─ 3. backfill plan ───┐   what's the new field's value for old files?
```

The reason AptKit can get away with none of it: artifacts are *disposable*. They're regenerated from fixtures on demand (`replay:promoted` scripts). If the schema changed, you'd delete the old artifacts and re-run, rather than migrate them. That's a legitimate strategy — but only because the data is reproducible. The moment an artifact held something you couldn't regenerate, the hard gate would become a liability.

**Where versioning is a foundation, not a fact.** This is the honest part: AptKit has the *seam* for migrations (the version field, the gate) but has never run one. `schemaVersion` has only ever been `1`. So treat this as the place where, if you grow the artifact shape, you already have the hook — but you'd be writing the migration discipline for the first time.

### Move 2.5 — current state vs future state

```
  Phase A (now)                    Phase B (after a shape change)
  ─────────────────                ──────────────────────────────
  schemaVersion: 1 only            schemaVersion: 1 and 2 coexist
  reader: === 1 (hard gate)        reader: migrate(v1)→v2, accept both
  old files: none exist            old files: upgraded on read OR
  migration: never run               regenerated from fixtures
  cost of change: edit the gate    cost of change: write migrate(),
                                     decide backfill for new fields,
                                     relax === to a range check
```

What *doesn't* have to change in Phase B: the writers (they just stamp `2`), the fixtures (inputs are version-agnostic), and the whole eval structure. The migration is localized to the read gate plus one `migrate()` function — which is the payoff of having put the version field there from day one.

### Move 3 — the principle

A version field is cheap insurance you buy before you need it. It costs one integer at write time and one comparison at read time, and it's the difference between "old data is unreadable garbage" and "old data is a known earlier shape I can upgrade." **The version doesn't make migration free — it makes migration *possible*. The discipline you owe it is to upgrade-on-read rather than hard-reject, before you ship the first breaking change.**

## Primary diagram

The version's full lifecycle across write, store, and read, with the hard gate marked.

```
  schemaVersion — lifecycle and the brittle gate

  WRITE                STORE                    READ
  ─────                ─────                    ────
  Studio / scripts     artifacts/replays/       evals + Studio loader
  ┌──────────────┐     ┌──────────────────┐     ┌─────────────────────┐
  │ schemaVersion│ ──► │ {"schemaVersion": │ ──► │ if !== 1 → REJECT   │
  │   : 1         │     │   1, ...}         │     │ (assertions.ts:83,  │
  │ (hard-coded)  │     │ (immutable file)  │     │  vite.config:1503)  │
  └──────────────┘     └──────────────────┘     └─────────┬───────────┘
                                                  ┌────────▼──────────┐
                       MISSING for real migration │ no upgrade-on-read│
                                                   │ no range accept   │
                                                   │ no backfill plan  │
                                                   └───────────────────┘
```

## Implementation in codebase

**Use cases in AptKit.** Every replay artifact written — by Studio (`apps/studio/src/replay-artifacts.ts`), by the recommendation replay script (`scripts/replay-model-recommendation.mjs`) — stamps `schemaVersion: 1`. Every reader that promotes or evaluates an artifact gates on it first. It's the guard that stops a malformed or future-shaped artifact from being silently misread as current.

**Write side** — `apps/studio/src/replay-artifacts.ts:25` (and `:77`, `:127`, `:176` for each capability), `scripts/replay-model-recommendation.mjs:68`:

```
  replay-artifacts.ts:25
    schemaVersion: 1,        ← hard-coded; the writer asserts the shape version
         │
         └─ four times in this file, once per capability artifact builder —
            all four agree on 1, which is what makes "=== 1" a valid gate
```

**Read side, the assertion** — `packages/evals/src/assertions.ts:83-85`:

```
  assertions.ts:83-85
    if (output.schemaVersion !== 1) {
      issues.push({ path:'schemaVersion', message:'expected schemaVersion 1' });
    }
         │
         └─ a soft gate: it records an issue (the artifact is "not promotable")
            rather than throwing. Used by promotion, which collects all issues
            before deciding (promote-replay-to-fixture.mjs:34-37)
```

**Read side, the hard gate** — `apps/studio/src/vite.config.ts:1503`:

```
  vite.config.ts:1503
    if (value.schemaVersion !== 1) throw new Error('artifact schemaVersion must be 1');
         │
         └─ a hard gate: the Studio loader throws outright. This is the line
            that turns into "all v1 files unreadable" the day v2 ships, unless
            a migration is written first
```

The type also pins it — `apps/studio/src/types.ts:167` declares `schemaVersion: 1` as a *literal type* (not `number`), so the compiler itself refuses any other value at write time. That's the write-side half of the same gate.

## Elaborate

Schema-on-read versioning comes from the world of message formats and event stores — Protobuf field numbers, Avro schema registries, Kafka topic schema evolution. The shared idea: data outlives the code that wrote it, so the data must self-describe its version and the reader must tolerate more than one. AptKit has the self-description (`schemaVersion`) but not yet the tolerance (the `=== 1` gate).

The connection to the rest of the guide: the artifact whose version this is gets its shape from `01-type-as-schema.md` (the typed artifact) and `02-tagged-union-event-log.md` (the trace inside it). Adding a 7th event variant (Move 2 in `02`) is precisely the kind of change that should bump this version. And the promoted fixtures of `04-fixture-promotion-lifecycle.md` are *derived from* versioned artifacts — promotion only runs on a v1 artifact that passes the gate.

## Interview defense

**Q: Does AptKit have a migration story?**
"A minimal one — `schemaVersion: 1` on every replay artifact, checked at read time. That's schema-on-read versioning: the data declares its version, the reader gates on it. Honestly, it's a reserved seam, not an exercised one — it's never been incremented, and the read check is a hard `=== 1`, so there's no upgrade-on-read yet. The reason that's survivable is that artifacts are regenerable from fixtures, so an old shape gets deleted-and-rebuilt rather than migrated."

```
  schemaVersion: 1  ─stamped─►  file  ─gated (=== 1)─►  reader
  no migration has run; the field is the hook, not the history
```

Anchor: *the version field is migration insurance bought before it's needed.*

**Q: What breaks the day you ship schemaVersion 2?**
"Every reader that does `!== 1` — `assertions.ts:83` and `vite.config.ts:1503` — would reject every existing v1 file. The fix is to relax the equality gate to a range and add an upgrade-on-read `migrate(v1)→v2` so old files are read as the current shape. Because artifacts are regenerable here, the cheaper option is often to delete and re-run from fixtures. But for non-regenerable data, upgrade-on-read is the discipline, and the version field is what makes it possible."

Anchor: *a hard `=== version` gate is correct until the first breaking change, then it's a liability — relax to upgrade-on-read first.*

**Q: The part people forget?**
"That a version field with no upgrade path isn't a migration story — it's a rejection story. The field alone buys you nothing unless the reader can branch on it. AptKit has the field and the rejection; it doesn't yet have the upgrade. Naming that gap honestly is the signal you understand migrations, versus just having seen a version column."

## Validate

1. **Reconstruct.** Name the two read-side checks and which is soft vs hard. (`assertions.ts:83` pushes an issue — soft; `vite.config.ts:1503` throws — hard.)
2. **Explain.** Why can AptKit get away with a hard `=== 1` gate and no upgrade-on-read? (Artifacts are regenerable from fixtures; old shapes are deleted-and-rebuilt, not migrated.)
3. **Apply.** You add a `costEstimate` required field to the artifact. Walk the v1→v2 migration: bump the writer to `2`, relax both readers to accept `{1,2}`, write `migrate(v1)` that supplies a default `costEstimate`, decide the backfill value for old files.
4. **Defend.** Argue that putting `schemaVersion` on the artifact from day one was worth it, even though it's still `1`. (One integer of cost; without it, the first shape change has no hook and old files become unidentifiable.)

## See also

- `01-type-as-schema.md` / `02-tagged-union-event-log.md` — the artifact shape this version protects.
- `04-fixture-promotion-lifecycle.md` — promotion runs only on a version-gated artifact.
- `05-structural-diff-integrity.md` — the `schemaVersion` check is one rule among the integrity layer's constraints.
- `audit.md` — Lens 5 (migrations and evolution).
- `study-system-design` → storage choice — when to move artifacts off the filesystem (where real migrations begin).
