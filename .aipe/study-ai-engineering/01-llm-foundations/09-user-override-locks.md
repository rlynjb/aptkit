# User-override locks

User-override locks · the `_overridden_at` pattern (Industry standard)

When an LLM generates a field and a human corrects it, the next re-run must not clobber the correction. The pattern: every machine-writable field a user can edit gets a companion timestamp — `_overridden_at` — and the generator skips any field whose timestamp is set. aptkit core is a *library*; it doesn't own persistent user-editable state, so this is **not yet exercised** in aptkit itself. The editable state lives downstream, in buffr's `agents` schema. The pattern still matters — here's the whole thing.

## Zoom out, then zoom in

aptkit generates; buffr stores and lets humans edit. The lock belongs at the storage boundary, which aptkit doesn't have.

```
where the override lock belongs (NOT in aptkit core)
┌─────────────────────────────────────────────┐
│ buffr — agents schema (Postgres)              │  owns editable rows
│   ★ field + field_overridden_at (the LOCK)    │  ← pattern lives HERE
├─────────────────────────────────────────────┤
│ aptkit — generates values (stateless lib)     │  no persistent state to lock
├─────────────────────────────────────────────┤
│ ModelProvider.complete()                       │
└─────────────────────────────────────────────┘
```

The pattern is "last-writer-wins, but the human is the privileged writer." The question: *how do I re-run the model without overwriting what a person fixed?* You've hit this in any optimistic-UI form — local edits vs a refetch that would stomp them. The answer is the same: mark the human's write, and make the automated write yield to it.

## Structure pass

Two writers compete for one field: the LLM (frequent, automated) and the human (rare, authoritative). Trace the **trust** axis — whose write wins.

```
TRUST axis — who is allowed to overwrite this field?
Writer          frequency     authority    on conflict
──────────────────────────────────────────────────────────
LLM re-run      every run     low          MUST yield ←★ seam
Human edit      rare          high         always wins, sets *_overridden_at

The lock:  if field_overridden_at IS NOT NULL → LLM skips this field
```

The seam is the LLM write path. Without the lock, last-writer-wins means the *machine* wins (it runs constantly), silently erasing human corrections. The `_overridden_at` flag flips the rule: a set timestamp makes the field read-only to the generator. Trust inverts at exactly that check.

## How it works

**Mental model.** A per-field dirty bit, but it's a timestamp so you also get an audit trail. Generation reads the flag and routes: locked field → leave it; unlocked field → write the fresh value. Human edit sets the flag.

```
The override lock — one field's lifecycle
  LLM generates  → field = "Acme Inc", field_overridden_at = NULL
        │
  human edits    → field = "Acme Corp", field_overridden_at = now()  ← LOCKED
        │
  LLM re-runs    → field_overridden_at set? ─yes─▶ SKIP (keep "Acme Corp")
                                            └no──▶ overwrite
```

**The schema shape (buffr, where it would live).** buffr's `agents` schema already owns the editable rows — profiles, messages, documents — but does *not* yet carry override columns. Here's the existing shape and where the lock attaches.

```sql
-- buffr/sql/001_agents_schema.sql:52-58  (agents.profiles — editable, NO lock yet)
create table if not exists agents.profiles (
  id uuid primary key default gen_random_uuid(),
  app_id text not null default 'laptop',
  user_id text,
  content text not null,          -- LLM-generated AND human-editable → needs a lock
  updated_at timestamptz not null default now()
);
-- the pattern adds:  content_overridden_at timestamptz   (null = LLM owns it)
```

`content` is exactly the kind of field both writers touch: aptkit's `injectProfile` (`packages/context/src/profile-injector.ts:25-38`) reads/derives profile content, and a human may correct it. `updated_at` alone can't distinguish "machine touched it" from "human touched it" — that's why you need a *separate* override timestamp, not just the existing one.

**The write-path guard (pseudocode — not yet exercised in aptkit).** The generator consults the lock before writing each field.

```
// where buffr would gate the LLM write
for each generated field in row:
  if row[field + '_overridden_at'] is not null:
      skip            // human owns it — do not clobber
  else:
      row[field] = generated_value   // machine owns it — refresh

// where the human edit sets the lock
on user edit of field:
  row[field] = user_value
  row[field + '_overridden_at'] = now()   // claim it for the human
```

**Why aptkit core can't hold this.** aptkit is stateless by design — `complete()` returns and forgets (see `01-what-an-llm-is.md`), capabilities produce values and hand them off. There's no row, no `updated_at` aptkit owns, so there's nothing to lock. The lock is inherently a property of *persisted, editable* state, and that's buffr's job. Putting it in aptkit would mean aptkit grew a database, which it deliberately doesn't have. So the honest status: the pattern is understood, the column lives downstream, **not yet exercised** in aptkit.

**The principle.** When two writers share a field and one is authoritative-but-rare, give the authoritative write a marker and make the frequent write yield to it. A bare `updated_at` is insufficient — it records *when*, not *who/whether-human*. The `_overridden_at` companion column encodes intent ("a human claimed this"), which is what the generator must respect. Same idea as a `pinned` flag, a manual-override switch, or git's "ours" merge strategy on a specific path.

## Primary diagram

The full lifecycle across the aptkit/buffr boundary — generation, human override, and the re-run that respects it.

```
User-override lock — across the boundary
  APTKIT (stateless)              BUFFR agents schema (stateful)
  ────────────────                ──────────────────────────────
  generate content ─── write ───▶ profiles.content = "...", 
                                  content_overridden_at = NULL
                                          │
                          HUMAN edits ────┤
                                          ▼
                                  content = "fixed",
                                  content_overridden_at = now()  ★ LOCK
                                          │
  re-run generate ─── write? ───▶ overridden_at set?
                                   yes ─▶ SKIP (keep human's "fixed")
                                   no  ─▶ overwrite
```

aptkit always tries to write; buffr's lock decides whether the write lands.

## Elaborate

This is a conflict-resolution policy — a coarse cousin of CRDTs and operational transforms, but for the human-vs-machine case where you don't merge, you just let the human win. It's also the data-modeling expression of "source of truth": the `_overridden_at` flag says "for this field, the human is now the source." Adjacent patterns: optimistic locking (version columns), soft-delete tombstones, and the `dirty`/`pristine` state machines you've used in form libraries. The deeper architecture note (aptkit = stateless toolkit, buffr = the stateful body holding the `agents` schema) is in the personal-agent-architecture memory. Read `01-what-an-llm-is.md` for why aptkit is stateless, and `04-structured-outputs.md` for how the values that get locked are generated.

## Project exercises

### Add `*_overridden_at` columns and the write guard in buffr

- **Exercise ID:** `EX-LLM-09a`
- **What to build:** This is unbuilt (Case B) — build the lock where it belongs. Add `content_overridden_at timestamptz` to `agents.profiles` (and the same companion to any other LLM-generated, human-editable field), then implement the write-path guard: the generation path skips fields whose `_overridden_at` is set, and the human-edit path sets it to `now()`.
- **Why it earns its place:** Phase 1's data-meets-LLM lesson is that re-running a generator must not erase human corrections — and that aptkit (stateless) can't own this, so you learn the aptkit/buffr split firsthand. You'll implement the trust inversion in the one place state actually lives.
- **Files to touch:** `buffr/sql/001_agents_schema.sql` (52-58 `agents.profiles`); the buffr write path that calls aptkit's generation; reference aptkit's read side `packages/context/src/profile-injector.ts` (25-38). Do not add state to aptkit core.
- **Done when:** editing a profile sets `content_overridden_at`, a subsequent generation run leaves that field untouched, and an un-overridden field still refreshes on re-run.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: You re-run the LLM nightly — why doesn't it erase what users fixed?**

```
  field_overridden_at = NULL  → LLM owns it  → overwrite freely
  field_overridden_at = now() → human owns it → LLM SKIPS
                                                 (human is privileged writer)
```

Each editable field has an `_overridden_at` companion; a set timestamp makes the generator skip that field. Last-writer-wins, but the human is the privileged writer. Anchor: *a set override timestamp makes the field read-only to the model.*

**Q: Why not just use the existing `updated_at`?**

```
  updated_at      → WHEN it changed   (machine writes bump it too)
  overridden_at   → WHETHER a HUMAN claimed it  ← the bit you actually need
```

`updated_at` records *when*, not *who* — the machine's own writes bump it, so it can't distinguish a human correction from a re-generation. You need a separate flag that encodes human intent. Anchor: *updated_at is a clock; overridden_at is a claim.*

**Q: Why isn't this in aptkit core?**

```
  aptkit:  complete() → value → forget   (stateless, no rows to lock)
  buffr:   agents schema → persisted editable rows  ← the lock lives here
```

Because the lock is a property of persisted editable state, and aptkit is a stateless library with no rows of its own — that state lives in buffr's `agents` schema. Anchor: *you can only lock state you own; aptkit owns none.*

## See also

- [`01-what-an-llm-is.md`](./01-what-an-llm-is.md) — why aptkit is stateless.
- [`04-structured-outputs.md`](./04-structured-outputs.md) — how the locked values are generated.
- [`08-provider-abstraction.md`](./08-provider-abstraction.md) — aptkit-as-library, the same separation-of-concerns instinct.
