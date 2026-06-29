# 13 — Forbidden patterns and rotating formulas

**Industry name:** output diversity / anti-repetition / formula rotation — *Project-specific*

## Zoom out, then zoom in

Run the same generative chain for the same user a dozen times and you'll notice
it: every output sounds the same. "Great question! Here's a breakdown…" opener
every time, the same three-bullet rhythm, the same closer. LLMs converge on
phrasings. For a one-shot classifier nobody cares; for a chain that generates
content *repeatedly* for the same user, the sameness reads as robotic. The fix is
mechanical: explicitly forbid the openings that recur, and *rotate* a set of
formulas across runs so consecutive outputs differ. In aptkit the rotation
*mechanism* exists in the content workflow (angle round-robin); a forbidden-phrase
*list* in a prompt is `not yet exercised`.

```
  Zoom out — where repetition gets fought

  ┌─ Authoring ───────────────────────────────────────────────┐
  │  (no forbidden-openings list in any prompt — the gap)      │ ← we are here
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Workflow (the rotation mechanism) ─▼──────────────────────┐
  │  workflows/content-generation-workflow.ts                  │
  │    planContentVariant: angle = angles[variantIndex % len]  │
  │    → round-robins ANGLES across variants (anti-sameness)   │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the repo's anti-repetition lever is *angle rotation* at the workflow
level — each generated variant is assigned a different "angle" by round-robin
(`planContentVariant`, `content-generation-workflow.ts:155`). That's the
structural cousin of a prompt-level forbidden-openings list: instead of telling
one prompt "don't start the same way," it varies the *framing* across calls.

## The structure pass

**Layers:** the rotation source (the set of angles/formulas) → the selector (which
one this run gets) → the prompt (forbids recurrence) → the output (should differ
from the last).

**Axis — does this run differ from the previous run?** That's the property
rotation defends:

```
  Axis: "will run N look different from run N-1?"

  ┌─ Workflow rotation (SHIPPED) ─┐  seam  ┌─ Prompt forbidden-list (NOT) ─┐
  │ angle = angles[idx % len]     │ ══╪══► │ "do NOT open with: <phrases>" │
  │ → framing rotates per variant │ flips  │ → phrasing forced to vary      │
  │ content-gen-workflow.ts:155   │        │   not yet exercised            │
  └───────────────────────────────┘        └────────────────────────────────┘
```

**Seam:** the variant-index boundary — the modular arithmetic that maps run number
to angle. **What breaks without rotation:** every variant of a section gets the
same angle, the model converges on one phrasing, and you've generated N copies of
the same thing wearing slightly different words.

## How it works

### Move 1 — the mental model

You already round-robin things in code — load balancing across servers, cycling
through a palette of colors so adjacent chart bars differ. Formula rotation is
round-robin applied to *prompt framing*: keep a small set of angles, and assign
the next one each run by index modulo set size, so consecutive outputs are forced
onto different framings.

```
  Pattern — round-robin angle rotation

  angles = [A, B, C]
  variant 0 → angles[0 % 3] = A
  variant 1 → angles[1 % 3] = B
  variant 2 → angles[2 % 3] = C
  variant 3 → angles[3 % 3] = A   ← cycles, but adjacent variants always differ
```

### Move 2 — walking the rotation

**The angle round-robin (the shipped mechanism).** `planContentVariant`
(`content-generation-workflow.ts:139`) assigns each variant both a section and an
angle by modular index:

```
  Inline annotation — content-generation-workflow.ts:148 planContentVariant

  const sectionIndex = options.variantIndex % options.sections.length;  ← cycle sections
  return {
    ...,
    section: options.sections[sectionIndex],
    angle: options.angles[options.variantIndex % options.angles.length], ← cycle ANGLES
  };
  // → variant N and variant N+1 get DIFFERENT angles (until the set wraps)
```

So variant 0 might be section 1 from a "practical" angle, variant 1 section 2
from a "contrarian" angle, and so on. The `ContentAngle` (`:4`) carries a `label`
that the workflow emits in a trace step — *"generating ${plan.angle.label} for
section…"* (`:111`). **What breaks without it:** `ensureGeneratedContent` would
generate every variant from the same angle and the corpus would read as
duplicated. The round-robin is the anti-sameness guarantee.

**The variant-history awareness.** `ensureGeneratedContent`
(`content-generation-workflow.ts:63`) tracks existing variants by `variantIndex`
and a `sourceHash`, generating fresh ones starting after the last existing index
(`baseIndex`, `:92`). So rotation continues *across regenerations* — the next
batch picks up the angle cycle where the last left off, rather than restarting at
angle 0 and repeating recent framings. This is the "rotation history" the spec
points at: rotation is stateful across runs, not just within one batch.

**What's NOT here — the prompt-level forbidden list.** No prompt in the repo
contains an explicit "do not open with these phrases" or "rotate among these
formulas" instruction. The anti-repetition is purely structural (vary the angle),
not lexical (forbid the phrasing). For a chain like a caption generator the spec
imagines, you'd add to the prompt a forbidden-openings list and an enumerated set
of rotating formulas — that prompt-side lever is `not yet exercised`.

### Move 3 — the principle

**Repetition is a property of the chain, not of any single call — so the fix
lives in how you vary *across* calls, not in one cleverer prompt.** Rotation
(round-robin a set of angles/formulas, statefully across runs) and forbidden lists
(name the phrasings that recur and ban them) are the two levers; this repo ships
the structural one (angle rotation) and leaves the lexical one open. And the scope
check matters: this only applies to generative chains run repeatedly for the same
user — one-shot classifiers and structured outputs want *consistency*, not
variety, so you'd never rotate them.

## Primary diagram

```
  Forbidden patterns & rotation — shipped vs gap

  SHIPPED: angle rotation (structural anti-sameness)
  ┌────────────────────────────────────────────────────────────┐
  │ ensureGeneratedContent (workflow.ts:63)                     │
  │   baseIndex = last existing variant + 1   (stateful)        │
  │   for each new variant:                                     │
  │     angle = angles[variantIndex % angles.length]            │
  │     → adjacent variants differ; cycle continues across runs │
  └────────────────────────────────────────────────────────────┘

  GAP: prompt-level forbidden formulas        [not yet exercised]
  ┌────────────────────────────────────────────────────────────┐
  │ "Do NOT open with: 'Great question', 'Here's a breakdown'.  │
  │  Rotate among formulas: [direct answer | scenario | ...]"   │
  └────────────────────────────────────────────────────────────┘

  SCOPE: applies to repeated GENERATIVE chains only —
         never to one-shot classifiers / structured outputs
```

## Elaborate

LLMs converge on high-probability phrasings — it's the same mechanism that makes
them produce "delve" and "tapestry" — and for repeated generation that convergence
is a UX problem, not a correctness one. The two production levers: *negative
constraints* (forbidden-openings lists in the prompt — cheap, but the model
sometimes drifts back) and *rotation* (cycle a curated set of framings, the more
reliable lever because it changes the input distribution rather than asking the
model to avoid an attractor). This repo's angle round-robin is the rotation lever,
and the stateful `baseIndex` continuation (`:92`) is the detail that makes it
actually work across regenerations instead of repeating the last batch's framings.
Temperature is the crude alternative — turning it up adds variety but also adds
errors, which is why structured rotation beats just cranking temperature.

## Interview defense

**Q: A chain that generates content for one user keeps sounding the same — how do
you fix it?** Two levers. Forbidden-openings list in the prompt (ban the recurring
phrasings) and, more reliably, rotate a curated set of framings/angles across runs
by round-robin — statefully, so consecutive outputs differ. In this repo the angle
round-robin in the content workflow is the shipped version
(`planContentVariant`). Only do this for repeated generative chains, never for
classifiers, which want consistency.

```
  angles[variantIndex % len] · stateful baseIndex continuation
  → adjacent runs forced onto different framings
```
*Anchor: `planContentVariant` angle rotation (`content-generation-workflow.ts:155`);
stateful `baseIndex` (`:92`).*

**Q: The part people forget?** **Statefulness across regenerations** and **scope**.
Rotation that restarts at angle 0 every batch repeats the recent framings — the
`baseIndex` continuation fixes that. And applying anti-repetition to a classifier
is a bug: there you *want* the same input to map to the same output.

## See also

- `06-single-purpose-chains.md` — rotation lives in the content-generation chain.
- `04-token-budgeting.md` — a forbidden-formulas list is prompt-prefix cost.
- `09-chain-of-thought.md` — structured outputs (which you never rotate) vs generation.
- `05-eval-driven-iteration.md` — diversity is a property you could eval-score.
