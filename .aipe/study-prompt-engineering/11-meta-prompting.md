# 11 — Meta-prompting

**Industry name(s):** meta-prompting / prompt generation / programmatic prompt
assembly. **Type:** Industry standard. **Status in this repo: partial — code
generates prompts; no LLM-writes-prompts loop.**

## Zoom out, then zoom in

Meta-prompting has two senses. One: using an LLM to write or improve a prompt for
another LLM call. Two: code that programmatically assembles a prompt from
structured data. AptKit does the second extensively (the rubric judge builds its
entire prompt from a `RubricDefinition`) and does *not* do the first. Look at
where prompt-assembly lives.

```
  Zoom out — code assembles prompts from data

  ┌─ Eval layer (packages/evals) ───────────────────────────────┐
  │  ★ buildRubricJudgeSystemPrompt(rubric) → full prompt ★      │ ← code builds prompt
  │  RubricDefinition (dimensions, scale, verdicts) → prompt text │
  └───────────────────────────┬──────────────────────────────────┘
  ┌─ Agent layer ────────────▼──────────────────────────────────┐
  │  buildRubricImprovementSystemPrompt(rubric) — same pattern   │
  │  ✗ no LLM-drafts-a-prompt loop anywhere                       │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern AptKit *does* use: a typed `RubricDefinition` is the
single source of truth, and `buildRubricJudgeSystemPrompt` deterministically
renders it into a system prompt — dimensions formatted, scale enumerated, output
shape generated from the definition. The prompt is *derived*, not handwritten. The
pattern it *doesn't* use: asking an LLM to draft or refine a prompt.

## Structure pass

**Layers.** Two: the *definition* (typed `RubricDefinition` — the data) and the
*assembled prompt* (the string `buildRubricJudgeSystemPrompt` produces from it).

**Axis — held constant: "who authored this prompt text?"**

```
  One question across the senses of meta-prompting:

  ┌─ rubric judge prompt ─────┐  → CODE authored it from RubricDefinition (present)
  │ buildRubricJudgeSystem..  │
  ┌─ output shape in prompt ──┐  → CODE generated it from dimensions (present)
  │ JSON.stringify(outputShape)│
  ┌─ LLM-drafted prompt ──────┐  → a model would author it (ABSENT)
```

**Seam — definition → prompt.** The load-bearing seam is
`buildRubricJudgeSystemPrompt(rubric)`. On one side, structured typed data; on the
other, a rendered prompt string. The axis (authorship) is "code, deterministically"
on both sides — there's no model in this loop. That determinism is the strength:
change the `RubricDefinition` and the prompt changes in lockstep, no drift.

## How it works

#### Move 1 — the mental model

You already generate code from a schema — a Zod schema produces a validator, an
OpenAPI spec produces a client. Programmatic meta-prompting is that: a structured
definition produces a prompt. The definition is the source of truth; the prompt is
a derived artifact you never hand-edit.

```
  Programmatic meta-prompting — definition is the source

  RubricDefinition { dimensions, scale, verdicts, checks, calibration }
        │  buildRubricJudgeSystemPrompt(rubric)
        ▼
  "You are a rubric judge for: <title>.
   Rubric dimensions: <id> <label>: <desc>\n  1 = ...\n  5 = ...
   Allowed verdicts: - pass: ...
   Output JSON only. Use exactly this shape: {generated from dimensions}"
        │
        └─ change the definition → the prompt regenerates. No handwritten drift.
```

#### Move 2 — the walkthrough

**The definition is the single source of truth.** `RubricDefinition` carries
`dimensions` (each with an id, label, description, and a labeled score scale),
`verdicts`, optional `checks`, and `calibrationExamples`. Everything the judge needs
is structured data. **Breaks if missing:** you'd hand-write the prompt per rubric,
and the prompt and the validator (which also reads the definition) would drift apart.

**The prompt is assembled deterministically.** `buildRubricJudgeSystemPrompt` maps
each dimension to a formatted block, enumerates the scale, lists verdicts, appends
calibration examples, and — the clever part — generates the *output shape* from the
dimensions themselves: `Object.fromEntries(dimensions.map(d => [d.id, {score: 0,
reason: ''}]))`. The prompt's "use exactly this shape" example is computed from the
same definition the validator uses. **Breaks if missing:** the prompt's claimed
output shape and the validator's expected shape could disagree — the worst kind of
silent bug.

```
  Output shape generated from the definition — single source

  dimensions: [{id:'accuracy'}, {id:'grounding'}]
        │  Object.fromEntries(map → [id, {score:0, reason:''}])
        ▼
  outputShape = { dimensions: {accuracy:{score:0,reason:''},
                               grounding:{score:0,reason:''}}, verdict, fix }
        │
        └─ the SAME definition feeds the prompt's example AND the validator's
           field checks → they cannot drift. That's the payoff of code-as-author.
```

**The same pattern repeats — self-similarity.** The rubric-improvement agent's
`buildRubricImprovementSystemPrompt` does the identical thing: render the rubric
into a prompt, generate the output shape from the definition. One pattern, two
occurrences — name it once. **Breaks if missing:** two hand-written prompts that
slowly diverge in their output contracts.

**What's absent — LLM-drafted prompts.** No code path asks a model "write me a
prompt for X." The workflow the spec describes (human writes the goal, LLM drafts
the prompt, human reviews and edits, prompt enters the codebase) doesn't happen
here — and given the prompts-as-code discipline (03), that's defensible: every
prompt is a reviewed, versioned literal, which is the opposite of an
LLM-drafted-on-the-fly prompt.

#### Move 3 — the principle

The strong, low-risk form of meta-prompting is *code generates the prompt from a
typed definition* — it removes drift between the prompt and the validation it
implies. The risky form is *an LLM generates the prompt*, which is fine for initial
drafting but produces prompts that read like model output instead of engineering
specs. AptKit chose the deterministic form, which fits its versioned-prompts
discipline.

## Primary diagram

The full definition → prompt + validator assembly, showing the single source.

```
  Rubric meta-prompting — one definition, two derived artifacts

  ┌─ RubricDefinition (typed source of truth) ───────────────────┐
  │  dimensions[{id,label,desc,scale}], verdicts, checks, examples│
  └───────────────┬──────────────────────────────┬───────────────┘
                  │ buildRubricJudgeSystemPrompt   │ createRubricJudgmentValidator
                  ▼                                ▼
        system prompt string              field/range validator
        (dimensions + scale +             (scores in [min,max],
         generated output shape)           verdict allowed)
                  │                                │
                  └──────── cannot drift ──────────┘
                    (both computed from the same definition)
```

## Implementation in codebase

**Use cases.** The rubric judge and the rubric-improvement agent both assemble
their prompts from a `RubricDefinition`. No agent asks a model to write a prompt.

The prompt assembled from the definition:

```
  packages/evals/src/rubric-judge.ts  (lines 107–160, excerpt)

  export function buildRubricJudgeSystemPrompt(rubric: RubricDefinition): string {
    const dimensions = rubric.dimensions.map((dimension) => {
      const scale = dimension.scale.map((level) => `  ${level.score} = ${level.description}`).join('\n');
      return `${dimension.id} ${dimension.label}: ${dimension.description}\n${scale}`;
    }).join('\n\n');
    ...
    return [ `You are a rubric judge for: ${rubric.title}.`, rubric.task,
             'Rubric dimensions:', dimensions, 'Allowed verdicts:', verdicts,
             'Output JSON only. ... Use exactly this shape:', JSON.stringify(outputShape),
    ].filter(Boolean).join('\n');
  }
       │
       └─ the prompt is DERIVED from the definition, not handwritten. Add a
          dimension to the rubric and this prompt grows a scored block automatically.
```

The output shape generated from the same definition the validator uses:

```
  packages/evals/src/rubric-judge.ts  (lines 131–141)

  const dimensionShape = Object.fromEntries(
    rubric.dimensions.map((dimension) => [dimension.id, { score: 0, reason: '' }]),
  );
  const outputShape = { dimensions: dimensionShape,
    ...(rubric.checks?.length ? { checks: checkShape } : {}),
    verdict: rubric.verdicts[0]?.verdict ?? 'pass', fix: '', reasoning: '' };
       │
       └─ this shape is shown to the model AS the contract; the validator
          (createRubricJudgmentValidator) checks the SAME definition. Single source
          → prompt and validator cannot disagree.
```

The same pattern in the rubric-improvement agent (self-similarity):

```
  packages/agents/rubric-improvement/src/rubric-improvement-agent.ts  (lines 97–149)

  export function buildRubricImprovementSystemPrompt(rubric: RubricDefinition): string {
    return [ `You are a rubric improvement agent for: ${rubric.title}.`, rubric.task,
             'Rubric:', JSON.stringify(rubric, null, 2),
             'Return JSON only. ... Use exactly this shape:', outputShape(rubric) ].join('\n');
  }
  function outputShape(rubric: RubricDefinition): string {
    const dimensions = Object.fromEntries(rubric.dimensions.map((d) => [d.id, { score: 0, reason: '' }]));
    ...
  }
       │
       └─ identical assembly pattern. One technique, two occurrences — the strongest
          form of "name it once and point at both."
```

## Project exercises

### EX-11.1 — LLM-assisted rubric drafting (the absent sense)

- **What to build:** A dev tool (a script, not a runtime agent) that takes a
  plain-English task description and asks a model to draft a `RubricDefinition`
  (dimensions, scales, verdicts), which a human then reviews and commits.
- **Why it earns its place:** Exercises the absent "LLM drafts the prompt" sense in
  the *safe* way the literature recommends — drafting, with a human review gate
  before it enters the codebase, preserving the prompts-as-code discipline (03).
- **Files to touch:** `scripts/draft-rubric.mjs` (new), reuse the
  `RubricDefinition` type from `@aptkit/evals`.
- **Done when:** running the script on "judge a customer-support reply" emits a
  valid `RubricDefinition` that type-checks and passes
  `createRubricJudgmentValidator`'s structural expectations, and the output is a
  reviewable file, not a live prompt.
- **Estimated effort:** one day.

## Elaborate

The deterministic-assembly form AptKit uses is the underrated half of
meta-prompting. The payoff isn't "the model wrote my prompt" — it's that the prompt
and the validator are computed from one typed definition, so they *cannot drift*.
That's a real production bug killed at the source: the classic "the prompt says
return field X but the validator checks for field Y" mismatch is impossible when
both derive from `rubric.dimensions`. This is the same instinct as
prompts-as-code (03), pushed one level up — not just versioning the prompt, but
generating it from a versioned schema.

The absent sense (LLM-drafts-prompts) is fine to skip in the runtime. Where it
earns its place is *authoring time* — drafting a complex rubric from a goal
description (EX-11.1) — with a human review gate so the result enters the codebase
as a reviewed, versioned literal, not an opaque model-generated string. The risk
the spec names — prompts that read like LLM output instead of engineering specs —
is exactly why the review gate is non-negotiable.

Where it connects: 03 (prompts-as-code — meta-prompting is generating that code
from a schema), 05 (the rubric judge this assembles is the LLM-as-judge), and 10
(the rubric judge is also the external critic self-critique would lean on).

## Interview defense

**Q: What's meta-prompting and which form does this repo use?**
Two forms. Code generating a prompt from structured data, and an LLM writing a
prompt for another call. This repo uses the first heavily — the rubric judge's
entire system prompt is rendered from a typed `RubricDefinition`, including the
output-shape example, which is computed from the same dimensions the validator
checks. So the prompt and the validator can't drift. It doesn't use the LLM-writes-
prompts form, which fits its versioned-prompts discipline.

```
  RubricDefinition ─┬─► buildRubricJudgeSystemPrompt → prompt
                    └─► createRubricJudgmentValidator → validator
                         both from one source → no drift
```
Anchor: "`buildRubricJudgeSystemPrompt` at `rubric-judge.ts:107`, shape generated
at `:131`."

**Q: Why generate the output-shape example instead of hand-writing it in the prompt?**
So the prompt's claimed shape and the validator's expected shape come from one
source (`rubric.dimensions`) and can't disagree. Hand-writing the example invites
the silent bug where the prompt says one shape and the validator enforces another.
Anchor: "`outputShape` from `Object.fromEntries(dimensions...)` at `rubric-judge.ts:131`."

## Validate

- **Reconstruct:** Name the two senses of meta-prompting and which one this repo
  uses.
- **Explain:** Why does generating `outputShape` from `rubric.dimensions`
  (`rubric-judge.ts:131`) prevent a prompt/validator mismatch?
- **Apply:** You add a `checks` array to a rubric. What in
  `buildRubricJudgeSystemPrompt` changes automatically, and what doesn't?
- **Defend:** Argue why the absent "LLM drafts the prompt" sense belongs at
  authoring time with a review gate, not in the runtime, given the prompts-as-code
  discipline (03).

## See also

- [03-prompts-as-code.md](03-prompts-as-code.md) — meta-prompting is generating that code from a schema.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — the assembled rubric judge.
- [10-self-critique.md](10-self-critique.md) — the rubric judge as external critic.
