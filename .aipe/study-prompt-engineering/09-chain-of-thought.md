# 09 — Chain-of-thought (CoT)

**Subtitle:** chain-of-thought — step-by-step reasoning, and where to put it
(Industry standard)

## Zoom out, then zoom in

Ask a model to reason step by step before answering and it solves multi-step
problems better. But reasoning is prose, and prose pollutes a structured
output. aptkit's move is the modern one: when you want both reasoning *and* a
machine-readable answer, the reasoning goes in a *field* of the structured
output — a `reasoning` key — not in free-form text that the parser then has
to fight.

```
  Zoom out — reasoning captured as a structured field

  ┌─ Capability ────────────────────────────────────────────────┐
  │  diagnostic agent → Diagnosis with confidence inference       │ ← we are here
  │  rubric judge     → RubricJudgment { ..., reasoning? }        │
  └───────────────────────────┬──────────────────────────────────┘
                              │ generateStructured
  ┌─ Validate ────────────────▼───────────────────────────────────┐
  │  reasoning is a STRING FIELD in the schema, validated alongside │
  │  the answer — not free prose competing with the JSON           │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: chain-of-thought is the prompt pattern "think before you answer."
It helps on multi-step problems and wastes tokens on simple lookups. The
modern caveat: frontier models reason internally now, so asking explicitly
matters less for them and more for cheaper local models like Gemma. And the
key engineering move: keep the reasoning *inside* the structured contract.

## Structure pass

**Layers.** Prompt (asks for reasoning) → model (produces it) → validator
(captures it as a typed field).

**Axis — where does the reasoning text end up?** Trace it:

```
  Axis: "where does the model's reasoning live in the output?"

  naive CoT       → free prose BEFORE the JSON → parser must skip it  ✗
  structured CoT  → a "reasoning" field IN the JSON → validated       ✓
  no CoT (lookup) → no reasoning at all → cheapest                    ✓
```

**Seam.** The boundary between *reasoning as prose* and *reasoning as a
field* is the load-bearing one. On the prose side, reasoning competes with
the structured answer and forces the parser to skip a prefix (the
output-mode mismatch from concept 7). On the field side, reasoning is just
another validated key. Crossing that seam is what makes CoT compatible with
structured output.

## How it works

You know how you'd return `{ result, debugInfo }` from a function instead of
`console.log`-ing the debug info into the same stream as the result?
Structured chain-of-thought is that: the reasoning gets its own field
instead of being smeared into the answer text. Let's walk it.

### Step 1 — the reasoning field in the schema

aptkit's judgment type carries an optional `reasoning` field right alongside
the verdict:

```ts
// packages/evals/src/rubric-judge.ts:46
export type RubricJudgment = {
  dimensions: Record<string, RubricDimensionScore>;  // each: { score, reason }
  verdict: string;
  fix: string;
  reasoning?: string;        // ← CoT captured as a field, not prose
};
```

And the per-dimension `reason` field (`rubric-judge.ts:41`) is reasoning at a
finer grain — the model justifies each score in its own slot. The validator
checks `reasoning` is a string when present (`rubric-judge.ts:206`). So the
reasoning is part of the validated contract, not a free-text prefix the
parser has to navigate around.

### Step 2 — the prompt elicits reasoning into the field

The judge's output shape, built in the system prompt, includes the
`reasoning` key explicitly so the model knows where to put its thinking:

```ts
// packages/evals/src/rubric-judge.ts:135
const outputShape = {
  dimensions: dimensionShape,   // { dimId: { score, reason } }
  verdict: ...,
  fix: '',
  reasoning: '',                // ← the model fills this with its CoT
};
// :158  'Output JSON only. ... Use exactly this shape:' + JSON.stringify(outputShape)
```

```
  Pattern — CoT routed into a field

  prompt: "Use exactly this shape: { dimensions:{...,reason}, verdict,
                                     fix, reasoning }"
            │
            ▼
  model thinks → writes reasoning INTO the "reasoning" key
            │
            ▼
  validator: reasoning is a string? ✓   verdict in allowlist? ✓
            │
            ▼
  one parse, no prose-prefix to skip — CoT + structure coexist
```

The per-dimension `reason` is the CoT made *useful*: not just "I thought
about it" but a justification attached to each score, which is what makes the
judgment auditable.

### Step 3 — when CoT helps vs hurts, in this repo

```
  Comparison — CoT cost/benefit by capability

  intent classifier (intent.ts) → SIMPLE LOOKUP
    one of three words, maxTokens:16 → CoT would WASTE tokens, skip it  ✗
  diagnostic agent → MULTI-STEP (hypothesis-tested Diagnosis)
    benefits from step-by-step reasoning → CoT helps                    ✓
  rubric judge → MULTI-STEP scoring
    reasoning field justifies each score → CoT helps, captured in field ✓
```

The intent classifier is the clean negative example: it has a 16-token
budget and picks one of three words. Asking it to reason step by step would
blow the budget and add nothing — a lookup doesn't need a chain of thought.
The diagnostic and judge tasks are genuinely multi-step, so reasoning earns
its tokens there.

### Step 4 — the modern caveat: internal reasoning

Frontier models now do chain-of-thought internally — you don't always have
to ask. But aptkit's headline provider is Gemma, a local model
(`gemma-provider.ts:47`, `gemma2:9b`), which benefits more from explicit
reasoning than a frontier model does. So the calculus here leans toward
keeping explicit reasoning fields: the cheaper the model, the more an
explicit "reason about each dimension" instruction buys you. This is the
provider seam (from the overview) showing up again — the same prompt
technique pays off differently depending on the model under it.

### The principle

**Chain-of-thought trades tokens for accuracy on multi-step tasks, and the
engineering move is to capture the reasoning in a structured field so it
coexists with the machine-readable answer instead of fighting it.** Skip it
on lookups; use it on multi-step work; and never let the reasoning escape
into free prose that the parser then has to skip — give it a `reasoning` key.
The cheaper your model, the more explicit CoT earns its place.

## Primary diagram

CoT routed into a field, contrasted with the prose-prefix anti-pattern.

```
  Chain-of-thought in aptkit — field, not prefix

  ANTI-PATTERN (prose prefix):
    "Let me think... [paragraph] ```json {answer} ```"
     └─ parser must skip prose, output-mode-mismatch risk (concept 7)

  aptkit (reasoning as a field):
  ┌─ prompt ────────────────────────────────────────────────────┐
  │  "Use exactly this shape: { dimensions:{score,reason},        │
  │     verdict, fix, reasoning }"                                │
  └────────────────────────────┬──────────────────────────────────┘
                              │ model fills reasoning + reason keys
  ┌─ validated RubricJudgment ▼───────────────────────────────────┐
  │  { dimensions: { quality: { score:4, reason:"..." } },        │
  │    verdict:"pass", fix:"...", reasoning:"..." }               │
  │  reasoning + answer in ONE validated object                   │
  └────────────────────────────────────────────────────────────────┘
   skip CoT entirely for lookups (intent classifier, mt:16)
```

## Elaborate

The chain-of-thought line of work (Wei et al., "chain-of-thought prompting")
showed that eliciting intermediate reasoning improves multi-step accuracy.
The follow-on insight that matters for production is structural: free-form
reasoning conflicts with structured output, so you route it into a field. The
OpenAI and Anthropic guidance both converge on this — put scratch-work in a
designated place, return the answer in the schema.

The modern wrinkle is reasoning models that think internally before
answering. For those, an explicit "think step by step" is often redundant.
But a toolkit built around a *local* model can't assume that capability, so
aptkit's explicit `reasoning`/`reason` fields are the right hedge — they help
the weak model and don't hurt the strong one. This connects to evals (concept
5): the per-dimension `reason` is what makes a judge's score auditable and
its failures diagnosable.

## Interview defense

**Q: You want both reasoning and a structured answer. How do you prompt for
it?**

Put the reasoning in a field of the schema — a `reasoning` key, or a `reason`
per sub-decision — not in free prose before the JSON. Free-form reasoning
collides with the structured output: the parser has to skip a prose prefix,
which is exactly the output-mode mismatch failure. A reasoning *field* is
just another validated string, and it coexists with the answer in one parse.

```
  reasoning as prose prefix → parser skips it → fragile
  reasoning as a schema field → validated alongside the answer → clean
```

Anchor: "aptkit's `RubricJudgment` has a `reasoning` field and a per-dimension
`reason`; the prompt hands the model the exact output shape including those
keys (`rubric-judge.ts:135`)."

**Q: When do you NOT use chain-of-thought?**

On simple lookups and tight classifiers, where it wastes tokens for no
accuracy gain. aptkit's intent classifier picks one of three words on a
16-token budget — asking it to reason would blow the budget and add nothing.
The modern caveat too: frontier models reason internally, so explicit CoT
matters less for them and more for cheap local models like Gemma.

Anchor: "Intent classifier, `maxTokens:16` — a lookup, no CoT. Diagnostic and
judge are multi-step, so reasoning earns its tokens there."

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the structured
  contract the reasoning field lives in
- [07-output-mode-mismatch.md](07-output-mode-mismatch.md) — what happens
  when reasoning escapes into prose
- [04-token-budgeting.md](04-token-budgeting.md) — CoT's token cost
- [10-self-critique.md](10-self-critique.md) — reasoning as the input to a
  self-review step
