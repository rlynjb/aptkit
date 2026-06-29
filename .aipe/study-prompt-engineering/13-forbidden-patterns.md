# 13 — Forbidden patterns and rotating formulas

**Subtitle:** forbidden patterns / rotating formulas — fight convergence in
repeated generation (Project-specific)

## Zoom out, then zoom in

Run the same generative chain for the same user over and over and the outputs
start to sound identical — same openings, same cadence, same crutch phrases.
The fix is to explicitly forbid the convergent phrasings and rotate through
formulas. aptkit's closest live mechanism is the content-generation
workflow's round-robin *variant angles* — convergence-fighting at the
structure level — but an explicit forbidden-openings list is `not yet
exercised`.

```
  Zoom out — convergence-fighting lives in the content workflow

  ┌─ Workflow layer ────────────────────────────────────────────┐
  │  ★ ensureGeneratedContent: round-robin ANGLES per variant ★   │ ← we are here
  │     packages/workflows/src/content-generation-workflow.ts     │
  │     forces variety by ROTATING the angle, not the phrasing    │
  └───────────────────────────┬──────────────────────────────────┘
                              │ per-variant plan
  ┌─ Generation ──────────────▼───────────────────────────────────┐
  │  generator(plan) → one variant for { section, angle }         │
  │  explicit forbidden-openings list → NOT YET EXERCISED         │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: the concept is that LLMs converge on phrasings — a caption chain
run ten times produces ten variants that all open "In this stunning..." The
mechanism is to enumerate forbidden openings and rotate through a set of
formulas so each run is forced onto a different track. This matters for any
generative chain run repeatedly for the same user; it doesn't matter for
one-shot classifiers or structured outputs.

## Structure pass

**Layers.** Workflow (plans variants) → generation (produces one per plan) →
output (the variants a user sees together).

**Axis — what forces two outputs from the same source to differ?** Trace it:

```
  Axis: "what makes variant N differ from variant N-1?"

  nothing (naive)        → same prompt → convergent phrasing      ✗
  rotate the ANGLE       → variantIndex % angles → different lens  ✓ (built)
  rotate the SECTION     → variantIndex % sections → different src ✓ (built)
  forbid prior OPENINGS  → enumerate banned phrasings              ✗ (not built)
  rotate FORMULAS        → cycle through structural templates      ✗ (not built)
```

**Seam.** The load-bearing boundary is between *forcing variety structurally*
(rotate the input — angle, section) and *forbidding convergence in phrasing*
(ban the openings the model keeps reaching for). aptkit lives on the
structural side. The phrasing side — the explicit forbidden list — is the
unbuilt half.

## How it works

You know how a round-robin scheduler hands each request to the next worker so
no one worker gets everything? aptkit fights output convergence the same way:
it round-robins each content variant onto the next *angle*, so consecutive
variants are forced to approach the source from different lenses. Let's walk
the built mechanism and name the unbuilt one.

### Step 1 — the built mechanism: round-robin angles

The content workflow plans each variant by cycling through angles and
sections with modular arithmetic:

```ts
// packages/workflows/src/content-generation-workflow.ts:139 (planContentVariant)
const sectionIndex = options.variantIndex % options.sections.length;
return {
  sourceHash: options.sourceHash,
  variantIndex: options.variantIndex,
  sectionIndex,
  section: options.sections[sectionIndex],
  angle: options.angles[options.variantIndex % options.angles.length],  // ← rotation
};
```

```
  Execution trace — round-robin angles (4 variants, 2 angles, 3 sections)

  variantIndex │ angle (idx % 2) │ section (idx % 3)
  ─────────────┼─────────────────┼──────────────────
       0       │  angles[0]      │  sections[0]
       1       │  angles[1]      │  sections[1]
       2       │  angles[0]      │  sections[2]
       3       │  angles[1]      │  sections[0]
                 └─ angle alternates → forces a different lens each variant
```

Each variant's plan carries a *different* angle, and the generator gets that
angle in its prompt context (`content-generation-workflow.ts:111` traces
"generating {angle.label} for section..."). So convergence is fought by
varying the *input lens*, not by policing the output text. This is the
rotation pattern applied one level up from phrasing.

### Step 2 — the workflow also skips dead variants

A secondary anti-convergence guard: if the generator returns `null` (a
variant it couldn't make useful), the workflow skips it and tries the next
index, bounded by `maxSkips`:

```ts
// packages/workflows/src/content-generation-workflow.ts:116
if (item === null) {
  skipped.push(plan);
  // trace a warning, continue to the next variantIndex
  continue;
}
```

That keeps the output set from including degenerate near-duplicates — a
bounded version of "reject and re-roll." It's variety hygiene, not phrasing
control, but it's in the same spirit.

### Step 3 — the unbuilt half: forbidden openings and rotating formulas

What's `not yet exercised`: an explicit list of banned openings and a set of
rotating structural formulas in the prompt. The pattern would look like this
(pseudocode — no such code exists in the repo):

```
  Forbidden-openings + rotating-formula (NOT YET EXERCISED in aptkit)

  // in the generation prompt, per variant:
  forbiddenOpenings = previousVariants.map(v => firstSentence(v))
  prompt += "Do NOT open with any of: " + forbiddenOpenings.join(", ")
  prompt += "Use formula #" + (variantIndex % FORMULAS.length) + ": "
          + FORMULAS[variantIndex % FORMULAS.length]
  // FORMULAS = ["question-hook", "stat-lead", "scene-set", "contrarian"]
```

The skeleton parts, named by what breaks without each:

- **The forbidden list, fed from history.** Without it the model re-opens
  with its favorite phrasing every time — the core convergence bug.
- **The rotating formula.** Without it, even varied openings can share the
  same structure. Rotating the formula forces structural variety.
- **The rotation history (per user/source).** Without persisting which
  formulas and openings were already used, rotation resets and converges
  again. aptkit has the *hook* for this — `existing` variants are passed into
  `ensureGeneratedContent` (`content-generation-workflow.ts:73`) and tracked
  by `sourceHash` — but they drive section/angle rotation, not a
  forbidden-openings list.

The `existing`/`sourceHash` tracking is the foundation the unbuilt feature
would build on: the workflow already knows what was generated before; an
explicit forbidden-openings layer would read that history into the prompt.

### Step 4 — when this matters, when it doesn't

```
  Comparison — does anti-convergence apply?

  generative chain run repeatedly for one user (captions, content variants)
                                              → YES (the content workflow)
  a one-shot classifier (intent)            → NO (one of 3 words; sameness ok)
  structured output (recommendation JSON)   → NO (schema-shaped; converge fine)
```

Anti-convergence is purely a *generative*, *repeated*, *human-facing*
concern. A classifier *should* converge — you want the same query classified
the same way every time. Forcing variety into a structured output would
corrupt it. So this discipline is scoped tightly to repeated creative
generation, which is exactly where the content workflow lives.

### The principle

**LLMs converge on phrasing under repetition, so repeated generative chains
need a forced-variety mechanism — rotate the input lens, and forbid the
openings the model keeps reaching for.** aptkit fights convergence
structurally (round-robin angles and sections, skip dead variants) and tracks
generation history by `sourceHash`, but the explicit forbidden-openings list
and rotating-formula layer are the unbuilt half. The scope is narrow: only
repeated, creative, human-facing generation — never classifiers or structured
outputs, which are *supposed* to converge.

## Primary diagram

The built structural rotation, the unbuilt phrasing controls, and the shared
history hook.

```
  Anti-convergence in aptkit — built vs not yet exercised

  ┌─ Source markdown ───────────────────────────────────────────┐
  │  split into sections; targetCount variants needed            │
  └────────────────────────────┬──────────────────────────────────┘
                              │ per variantIndex
  ┌─ BUILT: structural rotation ▼─────────────────────────────────┐
  │  angle   = angles[idx % angles.length]    ← rotate the lens   │
  │  section = sections[idx % sections.length]← rotate the source │
  │  null variant → skip, try next (bounded by maxSkips)          │
  └────────────────────────────┬──────────────────────────────────┘
                              │ existing[] tracked by sourceHash
  ┌─ NOT YET EXERCISED: phrasing control ▼────────────────────────┐
  │  forbiddenOpenings = prior variants' first lines → into prompt │
  │  rotating FORMULAS = cycle structural templates per variant    │
  │  (would read the same sourceHash history the workflow tracks)  │
  └────────────────────────────────────────────────────────────────┘
   scope: repeated creative generation ONLY — never classifiers/structured
```

## Elaborate

Output convergence is the practical cousin of "mode collapse" — under
repetition and low temperature, a model funnels toward its highest-probability
phrasings. Practitioners fight it three ways: temperature/sampling tweaks
(blunt), input rotation (what aptkit does — vary the angle so the model starts
from a different place), and explicit negative constraints (the unbuilt
forbidden-openings list). The negative-constraint approach is the most
reliable for *phrasing* specifically, because temperature affects everything
and input rotation affects content more than cadence.

aptkit's design is well-positioned to add the phrasing layer because the
convergence-fighting infrastructure — variant planning, history tracking by
`sourceHash`, dead-variant skipping — is already there. The forbidden-openings
list is a prompt-assembly addition (read history → ban prior openings), not a
new subsystem. That's the highest-leverage unbuilt feature for this concept.

## Interview defense

**Q: A caption generator run ten times produces ten captions that all sound
the same. Why, and what do you do?**

Under repetition the model funnels toward its highest-probability phrasings —
same openings, same cadence. The fix is forced variety: rotate the input lens
so each run starts from a different angle, and explicitly forbid the openings
the model keeps reaching for by feeding prior variants' first lines into the
prompt as a ban-list. Rotate through a set of structural formulas too, so
even varied openings don't share one shape. Persist the rotation history per
user, or it resets and converges again.

```
  naive: same prompt × 10 → "In this stunning..." × 10
  rotate angle + forbid prior openings + cycle formulas → 10 distinct voices
```

Anchor: "aptkit rotates angles and sections round-robin
(`planContentVariant`, `variantIndex % angles.length`) and tracks history by
`sourceHash` — the explicit forbidden-openings list is the unbuilt half it's
set up to add."

**Q: When does anti-convergence NOT apply?**

One-shot classifiers and structured outputs — they're *supposed* to converge.
You want the same query classified the same way every time, and a schema-shaped
output should look the same shape every time. Forcing variety there corrupts
correctness. The discipline is scoped strictly to repeated, creative,
human-facing generation.

Anchor: "Classifiers should converge — the intent classifier returning the
same word for the same query is correct, not a bug."

## See also

- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the content
  workflow as a single-purpose generative chain
- [08-few-shot.md](08-few-shot.md) — examples can *cause* convergence if they
  all share a phrasing
- [09-chain-of-thought.md](09-chain-of-thought.md) — structured outputs that
  should converge, not vary
