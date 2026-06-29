# LLM-as-judge bias

> Position / verbosity / self-preference (Industry standard)

The moment you use a model to grade output, you inherit the grader's biases. Three are well-documented: position (the judge favors whichever answer it saw first), verbosity (longer answers look more thorough, so they score higher), and self-preference (a model rates its own family's output above others). The dangerous one is self-preference, because it's *circular* — Gemma grading Gemma is asking the suspect to mark their own exam. aptkit's `RubricJudge` defeats exactly that one, structurally, by making the judge model an injected dependency. The other two are `not yet exercised` — and you should say so.

## Zoom out, then zoom in

The judge sits between an output and a verdict, and three biases distort the verdict on the way through. Position and verbosity are *prompt-shaped* — they come from how you present the candidates. Self-preference is *model-shaped* — it comes from which model you picked to judge. aptkit addresses the model-shaped one at the seam and leaves the prompt-shaped ones open.

```
Three biases on the path from output to verdict (LAYERS)

  output(s)
     │
     ▼  ┌──────────────────────────────────────────────┐
        │ POSITION bias    favors what it saw first      │ prompt-shaped
        │ aptkit: not yet exercised                      │ (gap)
        ├──────────────────────────────────────────────┤
        │ VERBOSITY bias   favors the longer answer       │ prompt-shaped
        │ aptkit: not yet exercised                      │ (gap)
        ├──────────────────────────────────────────────┤
        │ ★ SELF-PREFERENCE  favors its own model family │ MODEL-shaped
        │ aptkit: DEFEATED by injecting a different family│ (addressed)
        └──────────────────────────────────────────────┘
     │
     ▼
  verdict
```

The one bias aptkit closes is the one with teeth — self-preference — and it closes it at the dependency seam, not with a clever prompt.

## Structure pass

One axis: **where the bias is introduced, and therefore where you'd fix it**.

- **Position bias** — introduced in the *prompt* (which candidate comes first). Fix: randomize order across runs, or grade each candidate independently. Lives in `buildRubricJudgeUserPrompt` (`rubric-judge.ts:163-168`). `not yet exercised`.
- **Verbosity bias** — introduced in the *candidate text* (length reads as quality). Fix: make length an explicit rubric dimension so the judge scores it deliberately instead of being fooled by it. Lives in the rubric definition (`RubricDimension`, 14-19). `not yet exercised`.
- **Self-preference bias** — introduced in the *choice of judge model*. Fix: use a different model family as judge than the one that produced the output. aptkit makes the judge model a constructor parameter (`rubric-judge.ts:60, ~73-86`), so the *caller* supplies it — and the intended pairing is Claude judging Gemma.

The seam that matters: `model: ModelProvider` is injected, not constructed inside the judge. That single design choice is the entire self-preference defense.

## How it works

**Move 1 — the mental model.** Don't let the suspect grade their own exam. If Gemma wrote the answer, a *different* family — Claude — should grade it. The code can't force you to pick a different family; what it does is make the judge model a slot you fill from outside, so picking a different family is trivial.

```
The anti-circular seam (PATTERN)

  Gemma (local) ──produces──► output ─────┐
                                          ▼
                              ┌───────────────────────┐
                              │  RubricJudge           │
                              │  model: ModelProvider  │◄── INJECTED by caller
                              │           ▲            │
                              └───────────│────────────┘
                                          │
  Claude (Anthropic) ─────────────────────┘  different family = no self-preference

  the SEAM enables it; the CALLER must actually pick a different family
```

**Move 2 — walk the pieces.**

**The judge model is a parameter, not a hardcoded dependency.** This is the whole defense, and it's one line of design.

```
rubric-judge.ts (~60, 80-87)                 why it matters
  type RubricJudgeOptions = {
    model: ModelProvider;   ───────────────  the judge is SUPPLIED, not inferred
    rubric, capabilityId?, ...
  }
  constructor(options) {
    this.model = options.model;  ──────────  caller decides the family
  }
```

`packages/evals/src/rubric-judge.ts:60` declares `model: ModelProvider` in the options; the constructor (80-87) just stores it. Nothing inside the judge knows or cares which model produced the subject. That ignorance is the feature — it's what lets you pair Claude-as-judge with Gemma-as-author. Honest caveat: the code *enables* anti-circular judging; it does not *enforce* a different family. If a caller injects Gemma to judge Gemma, the code won't stop them. The defense is the seam plus caller discipline.

**The rubric is structured, which is where verbosity *could* be neutralized.** Right now the rubric scores meaning, not length — but length isn't a named dimension, so the judge can still be implicitly swayed by it.

```
rubric-judge.ts (107-161, 170-224)           the lever you'd pull for verbosity
  buildRubricJudgeSystemPrompt(rubric):
    "Score meaning and evidence,       ─────  explicitly de-emphasizes style (147)
     not style preferences..."
  createRubricJudgmentValidator:
    each dimension score in [min,max]  ─────  per-dimension bounds (195-198)
    verdict ∈ allowed list             ─────  (202)
```

`rubric-judge.ts:147` already tells the judge to score meaning over style — a partial verbosity hedge — but there's no length dimension and no length cap. `createRubricJudgmentValidator` (170-224) enforces per-dimension score bounds (195-198) and verdict legality (202), so *if* you added a length dimension, the harness would validate it like any other.

**Position bias has no mitigation in the prompt builder.** The user prompt lays out context then subject in fixed order.

```
rubric-judge.ts (163-168)                    the gap
  buildRubricJudgeUserPrompt(input):
    `${context}Subject:\n${input.subject}`  ─ fixed order, single subject
                                              no shuffling, no A/B swap
```

`rubric-judge.ts:163-168` builds a single-subject prompt with no randomization. For pairwise judging you'd shuffle A/B order across runs; that's `not yet exercised`.

**Move 3 — the principle.** Fix bias at its source. Self-preference is model-shaped, so you fix it at the model seam — and aptkit does, by injection. Position and verbosity are prompt-shaped, so you'd fix them in the prompt builder and rubric — and aptkit hasn't. Naming which biases you've closed and which you haven't is itself the senior signal; pretending all three are handled is the junior mistake.

## Primary diagram

```
aptkit's bias scorecard

  SELF-PREFERENCE  ████████████  addressed (injected model family, rubric-judge.ts:60)
  VERBOSITY        ████░░░░░░░░  partial (rubric says "meaning not style", :147) — no length dim
  POSITION         ░░░░░░░░░░░░  not yet exercised (no order randomization, :163-168)
                   └ closed ─┘└── open ──┘
```

## Elaborate

Self-preference is the bias most worth defeating because it's silent and self-reinforcing. If your local Gemma both writes and grades, every regression looks fine to itself — the grader shares the writer's blind spots exactly. Cross-family judging breaks that: Claude has different failure modes than Gemma, so Claude *notices* Gemma's mistakes. The injection seam is what makes that pairing a config change rather than a rewrite.

The honest framing for an interview: "We structurally defeat self-preference via dependency injection — the judge model is supplied by the caller, intended as Claude judging Gemma. Position and verbosity mitigations aren't in yet; the rubric prompt de-emphasizes style but there's no order randomization or length cap." That sentence shows you know all three biases *and* the exact state of your defenses.

## Project exercises

### Add order-randomization and a length-as-rubric-dimension

- **Exercise ID:** `EX-EVAL-03a`
- **What to build:** (1) Shuffle candidate order in `buildRubricJudgeUserPrompt` for pairwise judging, seeded so it's reproducible, and average/track verdicts across both orderings; (2) add a `length`/`concision` dimension to a rubric so the judge scores verbosity deliberately instead of being swayed by it. This hardens the Phase 3 (evals) LLM-as-judge rung.
- **Why it earns its place:** It closes the two open biases on aptkit's scorecard, turning "we only defeat self-preference" into "we address all three." Both are textbook mitigations interviewers expect.
- **Files to touch:** `packages/evals/src/rubric-judge.ts` (`buildRubricJudgeUserPrompt` 163-168, `RubricDimension` 14-19, validator 170-224).
- **Done when:** the same two candidates judged in swapped order produce a stable aggregate verdict, and a deliberately padded answer scores lower on the concision dimension than a tight one.
- **Estimated effort:** `1–2 days`

### Assert cross-family judging at the call site

- **Exercise ID:** `EX-EVAL-03b`
- **What to build:** A guard or test that fails if the injected judge `ModelProvider.id` matches the author provider's family — making the "Claude judges Gemma" intent enforced, not just enabled.
- **Why it earns its place:** It turns the honest caveat ("the code doesn't enforce it") into an enforced invariant, removing the self-preference foot-gun.
- **Files to touch:** caller-side wiring around `packages/evals/src/rubric-judge.ts`; a check on `options.model.id`.
- **Done when:** wiring a same-family judge fails loudly.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Which judge bias does aptkit actually defend against, and how?**

```
  self-preference: Gemma grading Gemma = circular
  fix at the SEAM → model: ModelProvider is injected (rubric-judge.ts:60)
  caller pairs Claude (judge) with Gemma (author) = different family
```

Anchor: `rubric-judge.ts:60` — the judge model is a constructor parameter, so the caller picks the family.

**Q: Does the code force a different judge family?**

Anchor: no — `:60` *enables* it via injection; enforcement is caller responsibility. Honest gap.

**Q: What about position and verbosity bias?**

```
  position:  no order randomization (:163-168)   not yet exercised
  verbosity: prompt says "meaning not style" (:147) but no length dimension/cap
```

Anchor: `rubric-judge.ts:147` is the only verbosity hedge; both remain open.

## See also

- [02-eval-methods.md](02-eval-methods.md) — why the judge is the top, most-expensive rung.
- [01-eval-set-types.md](01-eval-set-types.md) — the sets a judge grades.
- [04-llm-observability.md](04-llm-observability.md) — recording judge verdicts in traces.
