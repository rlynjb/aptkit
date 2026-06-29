# 08 — Few-shot prompting

**Subtitle:** few-shot prompting — examples constrain format harder than
instructions (Industry standard)

## Zoom out, then zoom in

Examples constrain output more tightly than instructions do. Tell a model
"return concise JSON" and it interprets "concise"; *show* it three exemplars
and it pattern-matches the shape. aptkit has a structural slot for this — and
deliberately, honestly, mostly doesn't use it for agent prompts. Where
few-shot genuinely lands here is calibrating the rubric judge.

```
  Zoom out — the examples slot, and where it actually feeds

  ┌─ Source layer ──────────────────────────────────────────────┐
  │  ★ PromptPackage.examples[] ★  { input, expectedContains }    │ ← we are here
  │     packages/prompts/src/types.ts:7                           │
  └─────────────┬──────────────────────────────┬─────────────────┘
                │ NOT spliced into prompt       │ DOES feed
                ▼                                ▼
  ┌─ Prompt assembly ──────────┐   ┌─ Eval layer ─────────────────┐
  │ renderPromptTemplate only   │   │ expectedContains assertions  │
  │ substitutes {var}           │   │ + rubric calibrationExamples │
  │ → examples never rendered   │   │   (THESE are few-shot)       │
  └─────────────────────────────┘   └──────────────────────────────┘
```

Zooming in: few-shot is putting worked examples in the prompt so the model
imitates them. The pattern's strength is format-locking — examples pin the
output shape better than any adjective. Its cost is tokens: every example
eats context budget. And its honest status in aptkit: the agent prompts use
*instructions and inline format specs* instead of spliced examples, while
the rubric judge uses true few-shot calibration.

## Structure pass

**Layers.** Source (the `examples[]` slot) → assembly (which ignores it) →
eval (which consumes it).

**Axis — do these examples reach the model as prompt content?** Trace it:

```
  Axis: "does this example end up in the text the model sees?"

  PromptPackage.examples[]      → NO  (renderPromptTemplate ignores it)
  expectedContains arrays       → NO  (they're eval assertions)
  rubric calibrationExamples    → YES (rubric-judge.ts:126 renders them)
  inline format spec in prompt  → YES (it IS the prompt text)
```

**Seam.** The load-bearing boundary is between *the examples slot* and *the
rendered prompt*. They look connected — both live on a prompt-shaped type —
but nothing crosses that seam for agent prompts. Recognizing that the slot
is an eval fixture, not prompt content, is the whole lesson.

## How it works

You know how a TypeScript example in a doc comment doesn't actually run —
it's there for the reader, not the compiler? aptkit's `PromptPackage.examples`
are like that for the *agent* prompts: present for the eval harness, not fed
to the model. Let's walk what's real and what's a slot.

### Step 1 — the slot exists, typed and populated

Every prompt package declares examples:

```ts
// packages/prompts/src/query.ts:79
examples: [
  {
    name: 'revenue-by-state',
    input: { question: 'What was revenue by state in the last 30 days?',
             intent: 'monitoring' },
    expectedContains: ['SP', 'RJ', 'MG'],   // ← Brazilian states = eval assertion
  },
],
```

That `expectedContains` is the tell. It's not an exemplar output for the
model to imitate — it's a list of strings the eval expects to find in the
*answer*. This is a test fixture wearing a prompt-shaped field.

### Step 2 — assembly ignores it

`renderPromptTemplate` only does `{var}` substitution:

```ts
// packages/prompts/src/types.ts:24
export function renderPromptTemplate(template, variables): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, name) =>
    variables[name] === undefined ? match : variables[name]);
}
```

Nothing iterates `examples[]` into the prompt string. The query agent builds
its system text from the template plus `{schema}`/`{intent}`/`{project_id}`
(`query-agent.ts:79`) — the examples never enter. So for agent prompts,
few-shot-as-spliced-examples is `not yet exercised`. The slot is real; the
splice is not.

### Step 3 — what aptkit uses INSTEAD: inline format specs

The agent prompts don't go example-free — they constrain format with inline
*specifications* rather than worked examples. The recommendation prompt
enumerates the exact object shape:

```ts
// packages/prompts/src/recommendation.ts:54
Each object must have:
- title: string
- bloomreachFeature: scenario | segment | campaign | voucher | experiment
- estimatedImpact: string OR { range: string, rangeUsd?: {...}, assumption }
```

And the query prompt gives tool-call *templates* (EQL query forms) rather
than full input/output pairs (`query.ts:30`). These are a lighter-weight
cousin of few-shot: they pin format with a spec instead of paying the token
cost of full exemplars. It's a defensible call for a token-tight local model
(concept 4) — but it forgoes the format-locking power of real examples.

### Step 4 — where few-shot is REAL: the rubric judge

The one place worked examples genuinely enter a prompt is the rubric judge's
calibration, and it's done exactly right:

```ts
// packages/evals/src/rubric-judge.ts:125
const examples = rubric.calibrationExamples?.length
  ? `\nCalibration examples. Use these only to anchor the scoring scale; do not
     repeat them.\n${rubric.calibrationExamples
       .map((ex) => `Input:\n${ex.input}\nExpected:\n${ex.expected}`).join('\n\n')}`
  : '';
```

```
  Pattern — few-shot done right (the judge)

  ┌─ calibration examples ─────────────────────────────┐
  │ Input: <a sample subject>                           │
  │ Expected: <the correct score/verdict for it>        │
  │ ... 2-5 of these ...                                │
  │ + "Use these ONLY to anchor the scale; don't repeat"│ ← anti-leak guard
  └─────────────────────────────────────────────────────┘
   the judge sees how to score by EXAMPLE, not just by rubric text
```

This is textbook few-shot: input/expected pairs that pin the judge's scoring
scale, capped small, with an explicit instruction not to parrot them. Three
to five good calibration examples anchor a judge far better than a paragraph
describing the scale — because the model pattern-matches the examples.

### Step 5 — when to use few-shot, when not

```
  Comparison — few-shot fit by task

  classifiers / format-sensitive  → USE (examples lock the format)
    e.g. the intent classifier WOULD benefit from 3 labeled examples
  rubric judges                   → USE (calibration — aptkit does this)
  open-ended generation           → SKIP (examples narrow creativity)
    e.g. the query agent's prose answer — instructions suffice
```

The rule: 3–5 good examples beat 20 mediocre ones (more examples = more
tokens and more chance of overfitting the model to incidental patterns). And
few-shot interacts with structured output (concept 2) — a single example can
*be* the structured JSON form itself, doubling as a format spec and a
schema demonstration.

### The principle

**Examples constrain output more tightly than instructions, at the cost of
tokens — so use them where format-locking matters (classifiers, judges) and
skip them for open-ended generation.** aptkit's honest position is
instructive: it format-locks with inline specs for token economy and reserves
true few-shot for the one place imitation matters most — calibrating an
LLM judge. The slot on `PromptPackage` is an eval fixture, not prompt content;
knowing that gap is the difference between reading the type and reading the
code.

## Primary diagram

The examples slot, the two paths out of it, and the real few-shot use.

```
  Few-shot in aptkit — slot vs reality

  ┌─ PromptPackage.examples[] ──────────────────────────────────┐
  │  { name, input, expectedContains }   ← eval fixture shape    │
  └─────────────┬───────────────────────────────┬────────────────┘
   spliced into │ NO                       feeds │ YES
   the prompt?  ▼                                ▼
  ┌─ Agent prompt ─────────────┐   ┌─ Eval ────────────────────────┐
  │ instructions + inline       │   │ expectedContains assertions   │
  │ format specs (not examples) │   │                               │
  │ → few-shot NOT YET EXERCISED│   └───────────────────────────────┘
  └─────────────────────────────┘
  ┌─ Rubric judge (REAL few-shot) ──────────────────────────────┐
  │  calibrationExamples → Input/Expected pairs rendered into    │
  │  the judge's system prompt + "anchor only, don't repeat"     │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Few-shot prompting is the oldest reliable technique in the field — the GPT-3
paper's "language models are few-shot learners" is the origin, and it remains
the most dependable way to pin output format. The modern caveat: as models
got more instruction-following, inline specs ("return an object with fields
x, y, z") often suffice for format, which is the bet aptkit makes for its
agent prompts.

Where few-shot stays irreplaceable is *calibration* of subjective tasks — a
judge, a classifier with fuzzy boundaries — because a scale is far easier to
demonstrate than to describe. That's exactly the one place aptkit reaches for
it (`rubric-judge.ts`). The token-cost tradeoff connects directly to concept
4: on a small local window, every example is budget you're not spending on
retrieved context.

## Interview defense

**Q: Why do examples constrain output better than instructions?**

Instructions are interpreted — "concise" means different things to the model
than to you. Examples are imitated — the model pattern-matches the shape,
length, and format of what you showed it. That's why few-shot is the
reliable lever for format-sensitive tasks like classifiers and judges. The
cost is tokens, so cap it at 3–5 strong examples; 20 mediocre ones overfit
and blow the budget.

```
  "be concise" → model interprets → varies
  <3 example outputs> → model imitates → locks the shape
```

Anchor: "aptkit reserves real few-shot for the rubric judge —
`calibrationExamples` rendered as Input/Expected pairs with 'anchor only,
don't repeat.' The agent prompts use inline format specs instead, to save a
local model's token budget."

**Q: aptkit's `PromptPackage` has an `examples` field. Is the repo doing
few-shot?**

Not for agent prompts. `renderPromptTemplate` only substitutes `{var}` — it
never iterates `examples[]` into the prompt. Those examples carry
`expectedContains`, which are eval assertions; they're test fixtures, not
prompt content. The slot exists, the splice doesn't. The one true few-shot
use is the judge's calibration examples.

Anchor: "Slot in `types.ts:7`, never rendered — eval fixture, not few-shot.
Real few-shot lives in `rubric-judge.ts:126`."

## See also

- [01-anatomy.md](01-anatomy.md) — the examples section of the prompt
  anatomy
- [02-structured-outputs.md](02-structured-outputs.md) — an example can
  double as a schema demonstration
- [04-token-budgeting.md](04-token-budgeting.md) — examples cost context
  budget
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — where the
  `examples` slot actually feeds
