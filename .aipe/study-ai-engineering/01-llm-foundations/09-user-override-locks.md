# User-override locks — when the human wins over the model

**Subtitle:** intent_overridden_at · human edits beat model writes · *Project-specific*

> **Status: Not yet implemented.** aptkit has no `_overridden_at` field anywhere.
> This file teaches the pattern, shows where it would live in buffr, and makes
> building it the main exercise. The diagrams describe the target design, not
> current code.

## Zoom out, then zoom in

Before the model writes back to a field a human can also edit, you need a rule for
who wins. That rule is a lock — and today it's missing.

```
  Zoom out — where the override lock would sit

  ┌─ Capability (classifier / enricher) ────────────────────────┐
  │  wants to write an inferred value (intent, tag, summary)    │
  └───────────────────────────┬─────────────────────────────────┘
                              │ before write: check the lock
  ┌─ Persistence (buffr) ─────▼─────────────────────────────────┐
  │  ★ field + intent_source + intent_overridden_at ★           │ ← would live here
  └───────────────────────────┬─────────────────────────────────┘
                              │ SQL update (guarded)
  ┌─ Storage ─────────────────▼─────────────────────────────────┐
  │  agents.profiles / agents.messages — content + updated_at   │
  └──────────────────────────────────────────────────────────────┘
```

Models love to overwrite. Re-run a classifier and it cheerfully replaces whatever
was there — including a value a human deliberately corrected. The override lock is
a tiny piece of provenance: record *who* last set the field and *when the human
touched it*, then teach the writer to never clobber a human edit. It's the
difference between "the AI keeps undoing my fix" and a system that respects the
person in the loop.

## Structure pass

**Layers.** Writer (model output) → guard (checks the lock) → row (field +
`intent_source` + `intent_overridden_at`) → storage.

**Axis — authority.** Trace who's allowed to write the field. Without a lock, the
last writer wins — usually the model, because it runs on every re-index. With a
lock, authority is explicit: if `intent_overridden_at` is set, the human holds the
field and the model must back off. The axis flips from "newest write wins" to
"human write wins."

**Seam.** The guard before the write. Below it, a dumb `UPDATE`. Above it, a
policy: "only write if no human override, or if this write is itself the human's."
The lock field is the state that seam reads.

## How it works

### Move 1 — the mental model

You know optimistic UI with a dirty flag — once the user edits a field, you stop
syncing the server value over their keystrokes? The override lock is a dirty flag
that *persists*: `intent_overridden_at` is "the human touched this," and the model
checks it the way your form checks `isDirty` before accepting a server update.

```
  the dirty-flag pattern, persisted

  field + intent_source ('model'|'user') + intent_overridden_at (timestamp|null)
                                  │
  model write ─► is intent_overridden_at set? ─yes─► SKIP (human owns it)
                                              └no──► write, source='model'
  human write ─► always write, source='user', stamp intent_overridden_at = now()
```

### Move 2 — the moving parts

**Where it would live (and why it's absent today).** buffr's `agents.profiles`
table has `content` and `updated_at` but **no source and no override timestamp** —
so a re-enrichment can't tell a human edit from a stale model write. From
`/Users/rein/Public/buffr/sql/001_agents_schema.sql:52`:

```sql
create table if not exists agents.profiles (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  content text not null,                 -- ← the field a model OR a human may set
  updated_at timestamptz not null default now()
  -- MISSING: intent_source           text   -- 'model' | 'user'
  -- MISSING: intent_overridden_at    timestamptz
);
```

```
  today's profiles row — no provenance

  content        ─► whoever wrote last (model usually wins on re-index)
  updated_at     ─► WHEN, but not WHO or whether a human locked it
  (no way to protect a human correction)
```

`agents.messages` (`001_agents_schema.sql:40`) is the same story: `content`,
`model`, `tokens_used`, `created_at` — provenance of the *model* call, but no
human-override marker. Note honestly: this is `not yet exercised` in aptkit;
there's no `_overridden_at` field in the whole codebase.

**The two columns the pattern needs.** Add provenance and a lock to the row:

```sql
alter table agents.profiles
  add column intent_source        text not null default 'model',  -- 'model' | 'user'
  add column intent_overridden_at timestamptz;                     -- null until a human edits
```

```
  the guarded write (the rule in SQL)

  model write:
    UPDATE agents.profiles SET content=$1, intent_source='model', updated_at=now()
    WHERE id=$2 AND intent_overridden_at IS NULL;   ◄── no-op if human locked it

  human write:
    UPDATE agents.profiles SET content=$1, intent_source='user',
           intent_overridden_at=now(), updated_at=now()
    WHERE id=$2;                                     ◄── always wins, sets the lock
```

The model's UPDATE carries `WHERE intent_overridden_at IS NULL` — if the human has
set the lock, the row count comes back 0 and the model write quietly no-ops. The
human's write sets the lock. After that, the model can never overwrite without an
explicit unlock.

**The writer-side check.** Before the model write, the capability reads the lock
and decides. In aptkit's terms this is the same shape as the cheap guard in
`07-heuristic-before-llm.md` — a deterministic check gating an expensive, mutating
action.

```
  capability ─► read row ─► intent_overridden_at set?
                              yes ─► skip model write, keep human value
                              no  ─► run classifier, write with source='model'
```

### Move 3 — the principle

Persist provenance, not just values. A field a model and a human both touch needs
to record *who* and *whether the human claimed it*, and every model write must be
guarded by that lock. The cheapest correct version is one timestamp column plus a
`WHERE … IS NULL` clause — the human always wins, and you can prove it from the
row.

## Primary diagram

```
  Override lock lifecycle (target design)

  [model write] ──► intent_overridden_at IS NULL? ─yes─► write, source='model'
        ▲                         │ no
        │                         └──► NO-OP (human owns the field)
        │
  [human edit] ──► write content, source='user', intent_overridden_at = now()
        │
        └──► from now on every model write hits the lock and no-ops
   provenance columns make "who wins" a row fact, not a race
```

## Elaborate

This is human-in-the-loop provenance, the same idea as a CMS "edited by a person,
don't auto-translate" flag or a CRM "manually verified" lock. It matters most for
systems that re-run inference on a schedule — re-indexing, nightly enrichment —
where the model would otherwise silently undo corrections. buffr is the right home
because it owns the durable `agents` schema; aptkit's capabilities would consume
the guard. Read `07-heuristic-before-llm.md` for the cheap-guard-before-expensive-
action shape this reuses, and `04-structured-outputs.md` for validating the value
the model proposes before it competes with the human's.

## Project exercises

### Add the override lock to buffr's profiles table
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a migration adding `intent_source` and `intent_overridden_at`
  to `agents.profiles`, plus two guarded update paths (model write with
  `WHERE intent_overridden_at IS NULL`, human write that stamps the lock).
- **Why it earns its place:** this is the primary buildable target — it turns a
  documented gap into a working human-in-the-loop guarantee against model clobber.
- **Files to touch:** `/Users/rein/Public/buffr/sql/001_agents_schema.sql` (or a
  new `002_*.sql`), and the buffr write path that updates profiles.
- **Done when:** after a human edit sets the lock, a model write leaves `content`
  unchanged (row count 0); before the lock, the model write applies.
- **Estimated effort:** `1–4hr`

### Prove the lock with a re-enrichment test
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a test that writes a model value, then a human override, then
  re-runs the model write and asserts the human value survived and `intent_source`
  is still `'user'`.
- **Why it earns its place:** the lock is only real if a re-run can't beat it; the
  test is the receipt that the human wins.
- **Files to touch:** buffr's test suite alongside the profiles write path.
- **Done when:** the re-enrichment leaves the human value and source intact.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "A nightly classifier keeps overwriting fields users corrected. Fix it."**
Add provenance: `intent_source` and `intent_overridden_at`. The model's UPDATE
carries `WHERE intent_overridden_at IS NULL`, so once a human edit stamps the lock,
the model write no-ops. The human always wins, and the row proves who set it.

```
  human edit ─► intent_overridden_at = now()
  model write ─► WHERE intent_overridden_at IS NULL ─► 0 rows ─► no clobber
```
Anchor: *a `WHERE … IS NULL` lock makes "human wins" a row fact, not a race.*

**Q: "Does aptkit have this today?"**
No — there's no `_overridden_at` field anywhere; `agents.profiles` has only
`content` and `updated_at`, so the last writer (usually the model) wins. The
pattern is designed and would live in buffr's `agents` schema. Being honest about
the gap is the point.

```
  today:   content + updated_at        (no provenance, model clobbers)
  target:  + intent_source + intent_overridden_at  (human-locked)
```
Anchor: *not yet implemented — provenance is the missing column, buffr is the home.*

## See also

- `07-heuristic-before-llm.md` — the cheap-guard-before-write shape this reuses
- `04-structured-outputs.md` — validating the model's proposed value first
- `08-provider-abstraction.md` — the seam discipline buffr already proves
