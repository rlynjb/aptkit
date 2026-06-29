# 08 — Few-shot prompting

**Industry name:** few-shot / in-context examples — *Industry standard*

## Zoom out, then zoom in

Here's a thing that took me too long to internalize: **examples constrain output
more than instructions do.** You can write three paragraphs telling a model the
exact format you want and it'll still wander; show it two examples in that format
and it locks on. The catch — examples cost context tokens, and 3–5 good ones beat
20 mediocre ones every time. In aptkit the few-shot *slot* exists in the prompt
package, but it's worth being honest up front: the examples are currently eval
anchors, not yet spliced into the prompt string.

```
  Zoom out — where examples live (and don't)

  ┌─ Authoring ───────────────────────────────────────────────┐
  │  PromptPackage.examples[]  (types.ts:7 PromptExample)      │ ← we are here
  │    query.ts:79  revenue-by-state {input, expectedContains} │
  │    diagnostic.ts:75  voucher-dropoff-diagnosis             │
  │  rubric-judge.ts: calibrationExamples (SPLICED into prompt)│
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Assembly ────────────────▼────────────────────────────────┐
  │  renderPromptTemplate({schema, intent})  — examples NOT     │
  │  injected into the agent system strings (the honest gap)    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: there are two camps in this repo. The agent packages have an
`examples[]` array that documents intent and feeds evals but **does not** get
rendered into the prompt. The rubric judge *does* splice `calibrationExamples`
into its judging prompt (`rubric-judge.ts:125`) — that's the one place few-shot
is genuinely wired.

## The structure pass

**Layers:** the example definition (data on the package) → the splice (does it
enter the prompt string?) → the model (does it imitate?).

**Axis — does this example reach the model?** This is the axis that exposes the
gap:

```
  Axis: "does this example enter the prompt sent to the model?"

  ┌─ rubric-judge calibrationExamples ─┐  seam  ┌─ agent examples[] ──────┐
  │ SPLICED into system prompt          │ ══╪══► │ NOT spliced — used for  │
  │ (rubric-judge.ts:125)               │ flips  │ evals/docs only         │
  │ → model sees them, anchors scale    │        │ → model never sees them │
  └─────────────────────────────────────┘        └──────────────────────────┘
```

**Seam:** the splice step. In the rubric judge the examples cross into the prompt
string; in the agents they don't. **What this means concretely:** the agents rely
on *instructions* (the `## Output` shape) to constrain format, not examples —
which works because the shape is explicit, but it's strictly weaker than
showing examples would be. The `PromptExample` slot (`types.ts:7`) is the
foundation for closing this gap; the wiring is `not yet exercised`.

## How it works

### Move 1 — the mental model

You already know that a unit test communicates a function's contract better than
its doc comment — the example input/output is unambiguous in a way prose isn't. A
few-shot example is that for a model: show the exact transformation you want, and
the model pattern-matches to it harder than it parses your instructions.

```
  Pattern — few-shot in the prompt

  system: "Classify the query. Examples:
    Input: 'what changed last week?'  → monitoring     ← example 1
    Input: 'why did revenue drop?'    → diagnostic     ← example 2
    Input: 'what should I do?'        → recommendation" ← example 3
  user: <the real query>
  → model imitates the demonstrated mapping
```

### Move 2 — walking the two camps

**Camp 1 — calibration examples that ARE spliced (the rubric judge).**
`buildRubricJudgeSystemPrompt` (`rubric-judge.ts:125`) renders
`calibrationExamples` straight into the system prompt:

```
  Inline annotation — rubric-judge.ts:125 calibration splice

  const examples = rubric.calibrationExamples?.length
    ? `\nCalibration examples. Use these only to anchor the scoring scale;
        do not repeat them.\n${... map(e => `Input:\n${e.input}\nExpected:\n${e.expected}`)}`
    : '';
  // → the model SEES these examples and anchors its scoring to them
```

Two production-grade details: the guard *"Use these only to anchor the scoring
scale; do not repeat them"* stops the classic few-shot failure where the model
parrots an example back as its answer; and `calibrationExamples` is optional —
when absent the splice is empty (`rubric-judge.ts:129`). This is few-shot doing
the job instructions can't: pinning a subjective scoring scale to concrete
anchors.

**Camp 2 — examples that are NOT spliced (the agents).** `query.ts:79` defines a
`revenue-by-state` example with `expectedContains: ['SP','RJ','MG']`;
`diagnostic.ts:75` defines `voucher-dropoff-diagnosis`. These feed evals (the
`expectedContains` is an assertion target, concept 05) and document the prompt's
intent — but `renderPromptTemplate` never injects them into the system string.
**What this costs:** the agents constrain format with instructions alone. For the
classifier that's fine (the output space is three words); for format-sensitive
generation it leaves the strongest constraint unused.

**When to use few-shot vs not.** Use it for classifiers and format-sensitive
tasks (the intent classifier would be a textbook fit — and note it currently uses
zero-shot instructions, `intent.ts:19`). Skip it for open-ended generation where
examples would bias the model toward imitating the examples instead of answering.
The cost is always tokens: every example sits in the static prefix and is re-sent
every call (concept 04), so 3–5 sharp examples beat a pile of mediocre ones.

**The interaction with structured output.** A few-shot example can *be* the
structured form itself — show one complete, valid JSON object and the model
imitates the shape better than a schema description alone. The diagnostic prompt
gestures at this by embedding a literal shape (`diagnostic.ts:30`), which is
halfway between an instruction and an example.

### Move 3 — the principle

**Examples are the highest-bandwidth way to constrain a model — and the most
expensive in tokens.** Reach for them when the output is format-sensitive and the
format is hard to describe; skip them when instructions suffice or when imitation
would distort an open-ended answer. In this repo the lesson is also a roadmap:
the slot exists, one consumer uses it well (the judge), and the agents are a
clean place to wire it.

## Primary diagram

```
  Few-shot in aptkit — two camps, one seam

  PromptExample {input, expectedContains}   (types.ts:7)
        │
        ├──► CAMP 1: rubric-judge calibrationExamples
        │       SPLICED into system prompt (rubric-judge.ts:125)
        │       "anchor the scale; do not repeat them"
        │       → model imitates ✓
        │
        └──► CAMP 2: agent examples[] (query.ts:79, diagnostic.ts:75)
                feeds evals via expectedContains (concept 05)
                NOT spliced into the prompt → model never sees ✗
                (the honest gap: few-shot-as-infra not yet exercised)
```

## Elaborate

The few-shot result (Brown et al., GPT-3) is the finding that models do
in-context learning from examples without weight updates — the examples *are* the
training signal for that one call. The practitioner refinements since: example
*ordering* matters (recency bias toward the last example), example *diversity*
matters more than count, and for classifiers the label distribution in your
examples can bias the output. The "do not repeat the examples" guard in the
rubric judge is the operational counter to the parroting failure mode. The honest
gap here — a curated, versioned example *library* feeding the agents — is the
infrastructure most mature prompt systems grow; this repo has the type for it
(`PromptExample`) but not the wiring.

## Interview defense

**Q: When do examples beat instructions?** When the output is format-sensitive
and the format is easier to show than describe — classifiers, structured shapes,
specific styles. Examples constrain harder because the model pattern-matches to
them. The cost is tokens (every example is re-sent each call), so 3–5 sharp ones
beat 20 mediocre ones.

```
  instruction: "classify into 3 categories"   ← weaker constraint
  + 3 examples of the exact mapping            ← stronger constraint
  cost: examples live in the re-sent prefix
```
*Anchor: `rubric-judge.ts:125` (spliced calibration) vs `query.ts:79` (unspliced).*

**Q: The part people forget?** The **anti-parroting guard**. Drop in examples and
a model will sometimes return an example verbatim instead of solving the real
input. The rubric judge defends this explicitly ("do not repeat them"). Few-shot
without that guard is a footgun on subjective tasks.

## See also

- `02-structured-outputs.md` — an example can be the structured shape itself.
- `04-token-budgeting.md` — examples are a re-sent prefix cost.
- `05-eval-driven-iteration.md` — `expectedContains` makes examples eval anchors.
- `06-single-purpose-chains.md` — the classifier is a textbook few-shot candidate.
