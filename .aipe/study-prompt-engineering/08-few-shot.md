# 08 — Few-shot prompting

**Industry name(s):** few-shot / in-context examples / calibration examples.
**Type:** Industry standard.

## Zoom out, then zoom in

Examples constrain output more than instructions do. AptKit carries examples in
three forms: the typed `examples[]` on every prompt package, worked query recipes
inline in the query system prompt, and calibration examples on the rubric judge.
Look at where they live.

```
  Zoom out — three places examples live

  ┌─ Prompt layer (packages/prompts) ───────────────────────────┐
  │  ★ PromptPackage.examples[] : { input, expectedContains } ★  │ ← typed examples
  │  QUERY_PROMPT inline "Tool catalog reminders" (EQL recipes)  │ ← in-prose examples
  └───────────────────────────┬──────────────────────────────────┘
  ┌─ Eval layer (packages/evals) ▼──────────────────────────────┐
  │  ★ RubricDefinition.calibrationExamples : {input, expected} ★│ ← judge calibration
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: show, don't only tell. An instruction ("query
period-over-period") is abstract; an example (`compare two windows, anchoring
execution_time if needed`) is concrete. Examples pin the *form* of the output in a
way prose can't. The cost is tokens — every example is context you pay for on
every call.

## Structure pass

**Layers.** Two: the *declared* examples (typed `PromptExample[]` /
`calibrationExamples`, structured metadata) and the *embedded* examples (worked
recipes written directly into the system prompt prose).

**Axis — held constant: "what does this example pin?"**

```
  One question across the example forms: what gets pinned?

  ┌─ PromptPackage.examples[] ┐  → INPUT→expectedContains (eval seed; see 05)
  ┌─ inline query recipes ────┐  → OUTPUT FORM (how to phrase an EQL query)
  ┌─ calibrationExamples ─────┐  → SCORING SCALE (what a 2 vs a 4 looks like)
```

**Seam — declared vs embedded.** The load-bearing distinction: declared examples
are metadata the harness can read (and turn into regression cases); embedded
examples are tokens the model reads at inference. They serve different masters —
the harness vs the model — and AptKit uses both.

## How it works

#### Move 1 — the mental model

You already know that a code review comment with a concrete diff lands better than
"make it cleaner." Vague instruction vs worked example. Few-shot is the worked
example, given to the model. Three good examples teach the output form better than
twenty lines of describing it.

```
  Few-shot — examples constrain more than instructions

  instruction only:   "Phrase a period-over-period query."   → model improvises form
  + worked example:   "compare two windows, anchoring        → model copies the form
                       execution_time if needed"
                              │
                              └─ the example is the constraint; prose is the hint
```

#### Move 2 — the walkthrough

**Typed examples on the package — the eval seed.** Each `PromptPackage` carries
`examples: PromptExample[]`, where each is `{ name, input, expectedContains? }`.
The query package's example is `{ question: 'What was revenue by state...',
intent: 'monitoring', expectedContains: ['SP', 'RJ', 'MG'] }`. These are dual-use:
they document the prompt's intended behavior *and* seed the regression suite (05) —
`expectedContains` is a checkable assertion. **Breaks if missing:** the prompt has
no executable record of "this input should produce that," so you can't tell a
regression from a change.

```
  PromptExample — documentation + checkable assertion

  { input: { question: 'revenue by state...', intent: 'monitoring' },
    expectedContains: ['SP', 'RJ', 'MG'] }
        │
        ├─ as docs:   shows what this prompt is for
        └─ as eval:   the answer MUST contain these tokens → regression catch
```

**Embedded recipes — pinning the output form.** The query system prompt embeds
worked examples directly in prose, under "Tool catalog reminders": `select count
event purchase in last 7 days`, `select sum event purchase.total_price in last 7
days`, `select count event purchase by customer.country grouping top 5...`. These
aren't metadata — they're tokens the model reads to learn the EQL dialect's exact
form. **Breaks if missing:** the model invents plausible-but-wrong query syntax
(the prompt even has a hard rule against "unsupported customer-matching EQL
clauses" — examples are the positive version of that guard).

```
  Embedded few-shot — teach the dialect by example

  prompt prose:
    "### EQL-shaped analytics
     - Count one event: select count event purchase in last 7 days
     - Sum a numeric property: select sum event purchase.total_price in last 7 days"
        │
        └─ the model learns the dialect's form from examples, not from a grammar spec
```

**Calibration examples on the judge — pinning the scale.** The rubric judge takes
`calibrationExamples: { input, expected }[]` and injects them with an explicit
instruction: "Use these only to anchor the scoring scale; do not repeat them."
This is few-shot for a *scorer* — the examples pin what each score level looks
like so the judge doesn't drift. **Breaks if missing:** the judge's 1–5 scale
means something different run to run (the LLM-judge blind-spot problem from 05).

**The interaction with structured output.** A few-shot example can *be* the
structured form itself — show one well-formed JSON object and the model copies the
shape. AptKit leans on this implicitly: the diagnostic prompt embeds a full JSON
shape as its example output. **The cost, always:** examples are context tokens
paid on every call (04). Three sharp examples beat twenty mediocre ones — more
examples is more cost and, past a few, diminishing constraint.

#### Move 3 — the principle

Show the form; don't only describe it. Use few-shot for format-sensitive tasks
(dialects, classifiers, structured shapes) and skip it for open-ended generation
where examples would over-constrain. Keep the set small and sharp — every example
is a token you pay for forever.

## Primary diagram

The three example forms and what each one serves.

```
  Few-shot in AptKit — three forms, two audiences

  ┌─ for the HARNESS (metadata) ─────────────────────────────────┐
  │ PromptPackage.examples[] { input, expectedContains }          │
  │   → seeds regression suite (05), documents intent             │
  └────────────────────────────────────────────────────────────────┘
  ┌─ for the MODEL (tokens at inference) ────────────────────────┐
  │ inline EQL recipes in QUERY_PROMPT  → pins query dialect form │
  │ embedded JSON shape in DIAGNOSTIC_PROMPT → pins output shape  │
  │ rubric calibrationExamples          → pins the scoring scale  │
  └────────────────────────────────────────────────────────────────┘
                 cost: every model-facing example = context tokens (04)
```

## Implementation in codebase

**Use cases.** The query agent uses embedded EQL recipes (dialect-sensitive). The
rubric judge uses calibration examples (scale-sensitive). Every package carries
typed `examples[]` that double as regression seeds.

The typed example with a checkable assertion:

```
  packages/prompts/src/query.ts  (lines 79–88)

  examples: [
    { name: 'revenue-by-state',
      input: { question: 'What was revenue by state in the last 30 days?',
               intent: 'monitoring' },
      expectedContains: ['SP', 'RJ', 'MG'] },   ← checkable: answer must contain these
  ],
       │
       └─ dual-use: documents the prompt AND becomes a regression assertion (05).
```

The embedded EQL recipes — few-shot for the model, pinning the dialect:

```
  packages/prompts/src/query.ts  (lines 30–36)

  ## Tool catalog reminders
  ### EQL-shaped analytics
  - Count one event: select count event purchase in last 7 days
  - Sum a numeric property: select sum event purchase.total_price in last 7 days
  - Segment by dimension: select count event purchase by customer.country grouping top 5...
       │
       └─ these are tokens the model reads to learn the EQL form. Without them it
          invents syntax — which is exactly what the "unsupported clauses" hard rule
          (query.ts:16) tries to prevent. Examples are the positive guard.
```

Calibration examples on the judge, with the don't-repeat instruction:

```
  packages/evals/src/rubric-judge.ts  (lines 125–129)

  const examples = rubric.calibrationExamples?.length
    ? `\nCalibration examples. Use these only to anchor the scoring scale; do not repeat them.\n${
        rubric.calibrationExamples.map((e) => `Input:\n${e.input}\nExpected:\n${e.expected}`).join('\n\n')}\n`
    : '';
       │
       └─ few-shot for a scorer: the examples pin what a given score looks like, so
          the judge's scale doesn't drift between runs (the 05 blind-spot fight).
```

The example-as-structured-shape, embedded in the diagnostic prompt:

```
  packages/prompts/src/diagnostic.ts  (lines 28–38)

  Return ONLY a JSON object in a ```json fenced block with this shape:
  { "conclusion": "string", "evidence": ["string"],
    "hypothesesConsidered": [ { "hypothesis": "string", "supported": true, "reasoning": "string" } ],
    ... }
       │
       └─ the example IS the output contract — one well-formed object the model
          copies. This is few-shot and structured-output (02) in one move.
```

## Elaborate

The declared-vs-embedded split is worth internalizing: `examples[]` on the package
is metadata your *harness* reads (to build regression cases), while the recipes in
the prompt prose are tokens your *model* reads (to learn the form). They're not
redundant — they serve different consumers. AptKit could close a small gap here:
the typed `examples[]` aren't automatically injected into the prompt as few-shot
*and* the recipes in prose aren't automatically turned into eval cases. The two
example systems are parallel, not unified. Unifying them — one example that's both
shown to the model and checked by the harness — is a clean improvement.

The cost discipline matters most for the embedded examples: they're paid on every
call (04), so the query prompt's handful of recipes is the right size. Twenty
recipes would bloat the system prompt, eat the token budget, and — past a few —
add little constraint. The literature (OpenAI cookbook, Anthropic guide) is
consistent: 3–5 sharp examples, not a wall of them.

Where it connects: 02 (an example can be the structured shape itself), 05
(`expectedContains` is the regression seed; calibration examples anchor the judge),
and 09 (for a classifier, the example pins the one-word output — see intent
classification).

## Interview defense

**Q: When do you reach for few-shot, and when don't you?**
Reach for it on format-sensitive tasks: dialects (the EQL query form), classifiers
(one-word intent), and structured shapes (a JSON object the model copies).
Examples pin the output form better than any instruction. Skip it for open-ended
generation, where examples over-constrain, and watch the cost — examples are
context tokens paid on every call, so 3–5 sharp ones beat twenty mediocre.

```
  format-sensitive → few-shot (pin the form)
  open-ended       → skip (don't over-constrain)
              cost: every example = tokens, forever
```
Anchor: "embedded EQL recipes at `query.ts:30`; calibration examples at
`rubric-judge.ts:125`."

**Q: What's the difference between the two example systems in this repo?**
Audience. `PromptPackage.examples[]` is metadata the harness reads to seed
regression cases (`expectedContains` is checkable). The recipes in the prompt prose
are tokens the model reads at inference to learn the form. Same word, different
consumer — and in this repo they're parallel, not unified, which is a gap worth
closing.
Anchor: "`examples[]` at `query.ts:79` (harness) vs inline recipes at `query.ts:30`
(model)."

## Validate

- **Reconstruct:** Name the three forms examples take in this repo and which
  audience each serves.
- **Explain:** Why does the rubric judge tell the model "do not repeat them" about
  calibration examples (`rubric-judge.ts:126`)? What failure does that prevent?
- **Apply:** You're adding a new EQL operation the model gets wrong. Do you add a
  hard rule or an embedded example, and why? (Where, in `query.ts`?)
- **Defend:** A teammate wants to add twelve more EQL recipes "to be thorough."
  Argue the token-cost and diminishing-constraint case for keeping it to a few.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — an example as the structured shape.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — `expectedContains` as regression seed; calibration anchors the judge.
- [04-token-budgeting.md](04-token-budgeting.md) — examples cost tokens on every call.
- [09-chain-of-thought.md](09-chain-of-thought.md) — the one-word classifier example.
