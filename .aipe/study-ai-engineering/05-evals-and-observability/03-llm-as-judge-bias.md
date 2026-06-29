# LLM-as-judge bias

**Subtitle:** Rubric judging and the three judge biases · Claude-judges-Gemma anti-circular design · *Industry standard (self-preference mitigated structurally; position/verbosity `not yet exercised`)*

## Zoom out, then zoom in

When the output is free-form, you reach the top rung of the eval ladder: a model
judges another model. It's powerful and it's dangerous, because a judge is a model
and models are biased. aptkit's judge lives in `rubric-judge.ts`, and its single
most important design decision isn't in the code at all — it's *which model* you
point it at.

```
  Zoom out — where the judge sits, and the biases around it

  ┌─ RubricJudge.judge (rubric-judge.ts) ─────────────────────┐
  │  generateStructured → { dimensions, verdict, fix }        │
  │  validated against the rubric's own score ranges          │
  └───────────────────────────┬───────────────────────────────┘
                              │ subject to score
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   POSITION bias         VERBOSITY bias        SELF-PREFERENCE bias
   prefers first-shown   prefers longer        prefers own family
   (not yet exercised)   (not yet exercised)   ★ MITIGATED: Claude judges Gemma ★
```

Now zoom in. Two of these three biases aptkit doesn't address yet — and it says
so. But the third, self-preference, it kills *structurally*: the intended setup is
**Claude (the anthropic provider) judging Gemma's outputs.** A judge from a
different model family can't prefer its own outputs, because none of the outputs
are its own. That's the move worth understanding — bias mitigation by
architecture, not by prompt.

## Structure pass

**Layers.** A capability produces a subject → `RubricJudge` builds a system prompt
from a `RubricDefinition` → the *judge model* scores it → a validator rejects
anything outside the rubric's own rules.

**Axis — trust.** Trace how far you trust the judge's output. You don't trust the
raw verdict at all — `createRubricJudgmentValidator` (`rubric-judge.ts:170`)
rejects scores outside each dimension's `[min,max]` and verdicts the rubric never
declared. And you don't trust the judge to be its own family: the trust boundary
is drawn at *model family*, with a different family on each side
(Claude judging, Gemma judged). Trust is granted only after the structural
boundary and the validator both pass.

**Seam.** The `model: ModelProvider` field on `RubricJudgeOptions`
(`rubric-judge.ts:60`). The judge takes a provider as a *parameter*. That seam is
the whole anti-circular design: because the judge model is injected, you point it
at a different family than the one under test, and self-preference has nothing to
grab.

## How it works

### Move 1 — the mental model

A judge model is a **code reviewer who's biased in three predictable ways.**
Picture a reviewer who (1) rubber-stamps the first PR they see and nitpicks the
rest (position), (2) approves the longer diff because it "looks more thorough"
(verbosity), and (3) approves code written in their own style and dings everyone
else's (self-preference). You wouldn't ban the reviewer — you'd *design around*
the biases: shuffle review order, judge by correctness not line count, and get a
reviewer from a different team for the call that matters.

```
  Biased reviewer  ─analogy─►  biased judge model

  rubber-stamps first PR     ─►   position bias  → randomize order
  approves the longer diff   ─►   verbosity bias → cap/score length
  approves own coding style  ─►   self-preference → different reviewer/family
```

aptkit hires the reviewer from a different team for the third one — that's the
Claude-judges-Gemma design. The first two it hasn't fixed yet.

### Move 2 — the judge, the validator, and the three biases

**The rubric and the anti-rewrite instruction.** The judge scores a subject
against a `RubricDefinition` — dimensions with score scales, allowed verdicts,
optional boolean checks, and calibration examples (`rubric-judge.ts:31`). The
system prompt is explicit about scoring *meaning*, not style, and never editing the
subject (`rubric-judge.ts:147`):

```ts
'Score the subject against the rubric. Score meaning and evidence, not style preferences unless the rubric asks for style.',
'Never rewrite the subject. Return one highest-leverage fix, not a list.',
```

"Score meaning and evidence, not style" is a direct shot at verbosity/style bias —
a prompt-level nudge. "Never rewrite the subject" keeps the judge a judge, not a
co-author. One fix, not a list, keeps the output actionable.

```
  Rubric judge — meaning over style

  subject + RubricDefinition ─► system prompt:
     "score meaning, not style" + "never rewrite" + "one fix"
                              │ generateStructured
                              ▼
     { dimensions:{id:{score,reason}}, verdict, fix, reasoning? }
```

**The validator — distrust the judge's own output.** A judge can return an
out-of-range score or invent a verdict. `createRubricJudgmentValidator` computes
each dimension's allowed range from the rubric's own scale and rejects anything
outside it (`rubric-judge.ts:195`):

```ts
const range = scoreRanges.get(id);
if (range && (score.score < range.min || score.score > range.max)) {
  return { ok: false, error: `dimensions.${id}.score must be between ${range.min} and ${range.max}` };
}
// ...and an unknown verdict is rejected outright:
if (typeof value.verdict !== 'string' || !verdicts.has(value.verdict)) {
  return { ok: false, error: 'judgment.verdict is not allowed by the rubric' };
}
```

The rubric defines the legal score space; the validator enforces it. A judge that
scores 7 on a 1–5 dimension fails validation rather than corrupting the eval.

```
  Validator — the rubric polices its own judge

  judge output ─► score in [min,max]?  ─no─► reject
                  verdict in allowed?   ─no─► reject
                  checks all boolean?   ─no─► reject
                       │ yes
                       ▼
                  trusted RubricJudgment
```

**Bias 1 — self-preference (MITIGATED, structurally).** A judge prefers outputs
from its own model family. aptkit's mitigation isn't a prompt — it's the
architecture: Claude judges Gemma. Because the judge model is an injected
`ModelProvider` (`rubric-judge.ts:60`), you point it at the anthropic provider
while the subject came from Gemma. The judge *cannot* prefer its own outputs
because none of the outputs are its own. Different family on each side, by
construction.

```
  Self-preference — killed by family separation

  Gemma (subject) ─────────►  RubricJudge(model = Claude)  ─────► verdict
       │ different families on each side                       │
       └── judge has no "own output" to favor ────────────────┘
                       structural mitigation, not a prompt
```

**Bias 2 — position bias (`not yet exercised`).** A judge shown two options
prefers whichever came first. The fix is to randomize order (and ideally judge
both orderings and average). `rubric-judge.ts` scores *one* subject at a time
against a rubric — there's no pairwise A/B path and no order randomization. If you
extend it to compare two subjects, you'd have to add the shuffle. Today: not
addressed.

**Bias 3 — verbosity bias (`not yet exercised`).** A judge rates a longer answer
higher even when it's padded. The mitigations are to cap subject length or make
length an explicit scored dimension. The "score meaning, not style" instruction
points the right direction, but there's no length cap and no length dimension in
the rubric machinery — so a verbose subject can still win on impression. Today:
nudged in the prompt, not enforced.

```
  The two unmitigated biases

  POSITION:  first-shown wins      → fix = randomize order   (not yet exercised)
  VERBOSITY: longer wins           → fix = cap/score length  (not yet exercised)
             ("score meaning" prompt nudges, but nothing enforces it)
```

### Move 3 — the principle

An LLM judge is a measuring instrument with known, predictable bias — so you
mitigate the bias *structurally* where you can and at least *name* it where you
can't. aptkit's strongest move is using a different model family as the judge,
which removes self-preference by construction rather than hoping a prompt fixes
it. Pair that with a validator that enforces the rubric's own score space, and the
judge can't drift out of bounds. The honest part is admitting position and
verbosity aren't handled — a judge you over-trust is worse than no judge, because
it launders a biased opinion as a score.

## Primary diagram

```
  LLM-as-judge in aptkit — the three biases and their status

  ┌─ RubricJudge (rubric-judge.ts) ───────────────────────────────────────┐
  │  system prompt: "score meaning, not style" · "never rewrite" · one fix │
  │  model: ModelProvider  ◄── injected → point at a DIFFERENT family      │
  └───────────────┬──────────────────────────────────────▲────────────────┘
                  │ generateStructured                    │ validated
                  ▼                                        │
  Gemma subject ──► Claude judge ──► { dimensions, verdict, fix } ──► validator
                                                                    (score in range?
                                                                     verdict allowed?)
  ───────────────────────────────────────────────────────────────────────────
  SELF-PREFERENCE  ✓ mitigated structurally (Claude judges Gemma)
  POSITION         ✗ not yet exercised (no order randomization)
  VERBOSITY        ✗ not yet exercised (prompt nudge only, no length cap/dimension)
```

## Elaborate

The "LLM-as-judge" literature warns about position, verbosity, and self-preference
(self-enhancement) bias; aptkit addresses exactly one and is candid about the
other two. The design choice that reads as senior is making the judge model an
injected dependency rather than hardcoding it — that one seam is what turns
"different family as judge" from a slogan into something you can actually
configure. The validator is the other quietly good move: a judge that returns a
score outside the rubric's scale, or a verdict the rubric never defined, fails
loudly instead of silently poisoning the eval. The `rubric-improvement` agent
wraps this judge (`packages/agents/rubric-improvement`). Read `02-eval-methods.md`
for why the judge is the *last* rung you reach for, and `01-llm-foundations/
08-provider-abstraction.md` for the seam that makes family-swapping possible.

## Project exercises

### Add order randomization for pairwise judging
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend `RubricJudge` (or a wrapper) to judge two subjects A/B,
  randomize which is shown first, judge both orderings, and average — neutralizing
  position bias.
- **Why it earns its place:** position bias is one of the two named biases aptkit
  doesn't handle; implementing the standard counter-the-shuffle mitigation shows
  you can move a bias from "named" to "mitigated."
- **Files to touch:** `packages/evals/src/rubric-judge.ts`,
  `packages/evals/test/`.
- **Done when:** a test with two near-identical subjects shows the verdict is
  stable regardless of input order.
- **Estimated effort:** `1–4hr`

### Make length an explicit scored dimension
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** add a rubric dimension (or a pre-check) that scores
  conciseness / penalizes padding, and/or cap subject length before judging, so a
  verbose answer can't win on impression alone.
- **Why it earns its place:** verbosity bias is the second unmitigated bias;
  turning "score meaning, not style" from a prompt nudge into an enforced
  dimension closes the gap the prompt only gestures at.
- **Files to touch:** `packages/evals/src/rubric-judge.ts`, a `RubricDefinition`
  fixture, `packages/evals/test/`.
- **Done when:** a padded subject scores lower than a concise one carrying the
  same meaning.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Your eval uses a model to judge another model. How do you trust the judge?"**
I distrust it deliberately, in two ways. Structurally: the judge model is an
injected dependency, and I point it at a *different model family* than the one
under test — Claude judging Gemma — which removes self-preference bias by
construction, because none of the outputs are the judge's own. And mechanically: a
validator enforces the rubric's own score ranges and allowed verdicts, so a judge
that scores out of range or invents a verdict fails validation instead of
corrupting the eval.

```
  Gemma subject → Claude judge (different family → no self-preference)
  → validator (score in [min,max]? verdict allowed?) → trusted
```
Anchor: *mitigate self-preference structurally — different family as judge, not a prompt.*

**Q: "Which judge biases are you NOT handling?"**
Position and verbosity. Self-preference I kill structurally. Position bias — a
judge favoring the first-shown option — I don't address because the judge scores
one subject at a time with no order randomization; if I added pairwise comparison
I'd have to shuffle and average. Verbosity bias — favoring the longer answer — I
only nudge with a "score meaning, not style" instruction; there's no length cap or
length dimension enforcing it. I'd rather name both than pretend a prompt fixed
them.

```
  self-preference ✓ structural   position ✗ (no shuffle)   verbosity ✗ (prompt nudge only)
```
Anchor: *an over-trusted judge is worse than none — name the biases you haven't fixed.*

## See also

- `02-eval-methods.md` — why the judge is the last rung on the ladder
- `01-llm-foundations/04-structured-outputs.md` — `generateStructured`, the validated output the judge rides on
- `01-llm-foundations/08-provider-abstraction.md` — the seam that lets you swap the judge's model family
- `04-llm-observability.md` — the trace the judge call emits
