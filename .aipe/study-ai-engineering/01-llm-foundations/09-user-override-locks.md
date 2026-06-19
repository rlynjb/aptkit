# User-override locks — don't let the model clobber a human edit

**Industry names:** override lock, `_overridden_at` / `manually_set`, write-protection flag · *Industry standard* · **NOT exercised in AptKit — taught as foundation**

## Zoom out, then zoom in

When a model classifies or fills a field, and a human later corrects it, the next
re-classification will happily overwrite the human's correction — unless something
stops it. The override lock is that something: a flag that says "a person set this;
don't touch it." AptKit doesn't have this pattern, and it's worth being precise
about *why*. Here's where it *would* sit in an app that persisted agent output.

```
  Zoom out — where an override lock would live (NOT in AptKit)

  ┌─ Host app (hypothetical — AptKit is a toolkit, no persistence) ──┐
  │  user edits a field in the UI → sets _overridden_at              │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  persisted to a store AptKit doesn't have
  ┌─ Stored record ────────────────▼──────────────────────────────────┐
  │  { intent, value, _overridden_at? }  ←★ THE LOCK would live here ★ │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  re-run agent → wants to write
  ┌─ AptKit (stateless: classify, don't persist) ─▼────────────────────┐
  │  classifyIntent / agent loop — returns a value, owns no store      │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: an override lock is a write-guard on a model-populated field. The model
may *propose* a value, but if a human has already set it (the lock is present),
the model's new value is discarded or shelved, not written. **AptKit never reaches
this pattern** because it's a stateless toolkit — its data is file- and
stream-shaped (trace events, replay artifacts), there's no database, and no
user-editable persisted field for the model to clobber. So this file teaches the
foundation and shows where the lock would belong if a host app gave AptKit's
outputs a home.

## Structure pass

**Layers.** In a host app that used the pattern: the *write source* (the model,
proposing a value) and the *stored field* (which carries the lock). AptKit only
has the first; it produces values and hands them back, owning no stored field.

**Axis — control: who is allowed to write this field?** Trace it across a
re-classification. Without a lock: the model always wins — the latest write
overwrites everything, including a human's correction. With a lock: control flips
based on a flag — if `_overridden_at` is set, the *human* owns the field and the
model's write is rejected; if not, the model may write. The lock is the thing that
makes control conditional instead of last-writer-wins.

**Seam.** The seam is the write itself: `shouldWrite(record, newValue)`. On one
side, a model eager to update. On the other, a stored value that may be
human-owned. The lock check at that seam is what turns a blind overwrite into a
guarded one. **AptKit has no such write seam** — its classifiers return a value and
the caller decides what to do with it.

## How it works

You've guarded a config write with "don't overwrite if the user customized it" —
or seen a form field that won't auto-update once you've typed in it. An override
lock is that, applied to a model-populated field: the model proposes, but a human's
prior edit wins.

### Move 1 — the mental model

A flag turns last-writer-wins into human-wins. The model checks the flag before
writing; the human's edit *sets* the flag.

```
  The override lock — a flag gates the write

   human edits field ──► set _overridden_at = now   (human claims the field)

   model re-classifies ──► proposes newValue
        │
        ▼
   _overridden_at set? ── yes ──► DISCARD newValue (human wins)
        │ no
        ▼
   write newValue (model may own it until a human claims it)
```

The flag is the entire mechanism. Without it, every model run is a blind
overwrite; with it, the model defers to any field a human has touched.

### Move 2 — the load-bearing skeleton

Strip it to the kernel that's still the pattern:

```
  Kernel — the guarded write (pseudocode)

  function applyClassification(record, modelValue):
    if record._overridden_at != null:        // ← THE LOCK
      return record                          // human owns it; drop the proposal
    record.value         = modelValue
    record.classified_at = now
    return record

  function applyHumanEdit(record, humanValue):
    record.value          = humanValue
    record._overridden_at = now              // ← human SETS the lock
    return record
```

**Name each part by what breaks without it:**

- **`_overridden_at` (the flag).** Drop it and there's nothing to check — every
  model run overwrites the human's correction. This is the whole pattern; it's a
  nullable timestamp (or boolean) that means "a human owns this." A timestamp is
  better than a boolean because it also records *when*, which helps with audit and
  with "re-lock after N days" policies.
- **The check before the model write.** Drop it and the flag exists but does
  nothing — the model writes regardless. The check is where the flag becomes
  load-bearing.
- **The set on human edit.** Drop it and the human's edit never claims the field,
  so the next model run overwrites it anyway. The human edit must *both* write the
  value *and* set the lock.

**Skeleton vs. hardening.** The kernel is flag + check + set. Hardening on top:
storing *who* overrode (not just when), an "unlock" action to hand a field back to
the model, and a re-lock-expiry policy. But all of it — including the kernel —
**presupposes a persisted, mutable, human-editable field**, which is exactly the
thing AptKit does not have.

### Move 2.5 — current state vs. future state

This is a built-vs-absent comparison where the honest answer is "absent, by
architecture."

```
  Phase A (AptKit today) vs. Phase B (a host app with persistence)

  ┌─ Phase A: AptKit (stateless toolkit) ─┐  ┌─ Phase B: host app persists output ─┐
  │ classifyIntent → returns Intent        │  │ stores { intent, _overridden_at? }  │
  │ caller decides what to do; no store    │  │ user can edit intent in a UI        │
  │ no persisted field → NOTHING TO LOCK   │  │ re-run checks the lock before write │
  │ data is file/stream-shaped (traces)    │  │ override lock lives in the host's   │
  │                                        │  │   schema, NOT in AptKit              │
  └────────────────────────────────────────┘  └──────────────────────────────────────┘

  what AptKit would NOT need to change: its classifiers/agents still just
  RETURN values. The lock is the host app's responsibility at its write seam.
```

The takeaway is the boundary: AptKit's classifiers are pure-ish value producers.
The override lock is a *persistence-layer* concern, so it belongs to whatever app
stores AptKit's outputs — not to AptKit. If you bolted persistence onto AptKit
tomorrow, you'd add the lock at the *new* write seam, and `classifyIntent` itself
wouldn't change.

### Move 3 — the principle

When a model and a human can both write the same field, the human wins by default,
and a single flag is what enforces it. The general rule: model-populated fields
need a way to mark human ownership, or auto-classification silently destroys
manual corrections — a trust-killing bug that's invisible until a user notices
their edit reverted. But the equally important lesson here is *scope*: this pattern
only exists where there's persisted, mutable, contested state. A stateless toolkit
like AptKit doesn't need it — and recognizing that a pattern *doesn't apply* is as
much a sign of understanding as applying one.

## Primary diagram

The full pattern as it would live in a host app — AptKit on the producing side, the
lock on the storing side.

```
  Override lock — full picture (host app + AptKit)

  ┌─ Human (UI) ─────────────────────────────────────────────────────┐
  │  edits field → applyHumanEdit: value = human, _overridden_at = now │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  persisted (host's store)
  ┌─ Stored record (host schema) ──▼──────────────────────────────────┐
  │  { value, classified_at, _overridden_at? }   ← THE LOCK            │
  └───────────────────────────────▲──────────────────────────────────┘
                                   │  applyClassification checks the lock
  ┌─ AptKit (stateless producer) ──┴──────────────────────────────────┐
  │  classifyIntent / agent loop → RETURNS a value; owns no store      │
  │  (so the guarded write seam does not exist inside AptKit)          │
  └─────────────────────────────────────────────────────────────────────┘

  Lock present → human wins, model proposal dropped.
  Lock absent  → model may write.
```

## Implementation in codebase

**Use cases.** None in AptKit — this is the honest part. The repo has no database,
no persisted user-editable record, and therefore no guarded write seam. Its data is
file- and stream-shaped: `CapabilityEvent` traces and replay artifacts, which are
append-only logs of what happened, not mutable fields a human and a model contest.

**The closest thing — a classifier that *returns* rather than *writes***,
`packages/agents/query/src/intent.ts:12-28`: `classifyIntent` produces an `Intent`
and hands it back to the caller. There is no record to overwrite, so there is
nothing to lock. If a host app persisted this `Intent` and let a user correct it,
*that app* would add the `_overridden_at` check at its write — and `classifyIntent`
would not change.

**Where a lock would attach in a host app (sketch, not in the repo):**

```
  hypothetical host write seam (does NOT exist in AptKit)

  const intent = await classifyIntent(model, query);   ← AptKit returns a value
       │
       ▼  host-app persistence layer (not in this repo):
  if (record._overridden_at == null) {                 ← THE LOCK, in the host
    record.intent = intent;
    record.classified_at = now();
  }                                                    ← else: keep human's intent
       │
       └─ The guard lives at the host's write, never inside AptKit. AptKit's
          job ends at returning `intent`.
```

That's the whole honest story: AptKit produces the value; the lock is a
persistence concern AptKit deliberately doesn't own.

## Elaborate

The override lock (often `_overridden_at`, `manually_set`, `is_locked`, or a
`source: 'human' | 'model'` field) is standard wherever automated population meets
manual correction — CRM lead scoring a rep can override, support-ticket
auto-categorization an agent can recategorize, recommendation tags an editor can
pin. The failure it prevents is concrete and infuriating: a user fixes a wrong
auto-label, the nightly re-classification job runs, and their fix vanishes. A
nullable timestamp is the usual implementation because it doubles as an audit
trail and supports policies like "re-enable auto-classification 30 days after the
last human edit."

AptKit doesn't exercise it for a structural reason worth stating plainly: it's a
*stateless toolkit*. It classifies, runs agent loops, scores with rubrics, and
emits traces — but it persists nothing mutable and exposes no human-editable field.
The pattern presupposes contested persisted state, and AptKit has none. That's not
a gap to fix in AptKit; it's a boundary. The Project Exercise below is therefore a
*host-app* exercise: it asks where the lock would go if AptKit's outputs were given
a persistent home, not how to retrofit one into the toolkit.

Adjacent: the classifier that produces the value a host might persist
(`07-heuristic-before-llm.md`, `03-sampling-parameters.md`); the trace events that
*are* AptKit's actual (append-only, uncontested) data shape (`05-streaming.md`,
`06-token-economics.md`).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case B — the pattern is NOT exercised; this is a
host-app exercise that adds the seam where it would live.*

### Exercise — an override-aware persistence wrapper for classified intent

- **Exercise ID:** `[C1.10]` Phase 1, user-override locks
- **What to build:** A small host-side store (in-memory is fine) that persists
  `classifyIntent`'s output per query as `{ intent, classified_at,
  _overridden_at? }`, exposes a `setHumanIntent` that writes the value *and* stamps
  `_overridden_at`, and an `applyClassification` that **skips the write when
  `_overridden_at` is set**. AptKit's `classifyIntent` stays untouched — the lock
  lives entirely in the wrapper.
- **Why it earns its place:** It makes the boundary concrete: AptKit produces, the
  host guards. Building the guard *outside* the toolkit proves you understand that
  the override lock is a persistence concern, not a model concern — and that
  recognizing where a pattern belongs is the skill.
- **Files to touch:** a new host-side module (e.g. under a demo/example dir) that
  imports `classifyIntent` from `packages/agents/query/src/intent.ts`; a unit test.
- **Done when:** A test classifies a query, records a human override, re-runs
  classification, and asserts the human value survived (the model's new value was
  discarded because `_overridden_at` was set).
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: A model re-classifies records nightly. A user corrected one yesterday. How do
you stop the job from reverting their fix?**
"An override lock — a flag that says 'a human owns this field.' I'd draw the
guard:"

```
  model proposes ─► _overridden_at set? ── yes ──► drop proposal (human wins)
                                        └ no  ──► write model value
  human edit ─► write value AND set _overridden_at
```

"A nullable `_overridden_at` timestamp on the record. The human edit both writes
the value and stamps the flag; the classification job checks the flag and skips
the write when it's set. Timestamp over boolean so it doubles as an audit trail and
supports re-lock-after-N-days." *Anchor: the model proposes; a human's prior edit
wins, enforced by one flag.*

**Q: Does AptKit do this?**
"No — and it shouldn't. AptKit is a stateless toolkit: its classifiers *return*
values, it persists nothing mutable, and it has no human-editable field to contest.
The override lock presupposes persisted, contested state, which AptKit doesn't
have — its data is append-only traces and replay artifacts. If a host app stored
AptKit's outputs, the lock would live at *that app's* write seam, and
`classifyIntent` in `intent.ts:12` wouldn't change. Recognizing the pattern doesn't
apply here is the point." *Anchor: an override lock is a persistence concern; a
stateless toolkit has nothing to lock.*

## Validate

- **Reconstruct:** Write the guarded-write kernel — the flag, the check before the
  model write, the set on human edit. (No repo file implements it; that's the
  honest answer. The closest producer is `intent.ts:12-28`, which only *returns* a
  value.)
- **Explain:** Why a nullable timestamp rather than a boolean for the lock? (It
  records *when* the human claimed the field — useful for audit and for re-lock
  expiry policies — in addition to *that* they did.)
- **Apply:** AptKit gains a persistence layer that stores classified intent. Where
  does the lock go, and does `classifyIntent` change? (At the new write seam in the
  persistence layer; `classifyIntent` stays a pure value producer —
  `intent.ts:12`.)
- **Defend:** Why doesn't AptKit need this pattern? (It's stateless — no database,
  no mutable human-editable field, data is append-only traces/artifacts; there is
  no contested write to guard. The classifiers return values rather than writing
  records — `intent.ts:28`.)

## See also

- [07-heuristic-before-llm.md](07-heuristic-before-llm.md) — `classifyIntent`, the value producer a host might persist
- [03-sampling-parameters.md](03-sampling-parameters.md) — making that classifier deterministic
- [05-streaming.md](05-streaming.md) — AptKit's actual data shape: append-only trace events
- [06-token-economics.md](06-token-economics.md) — the trace as a persisted (but uncontested) artifact
