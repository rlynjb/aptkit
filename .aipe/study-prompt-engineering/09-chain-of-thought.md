# 09 — Chain-of-thought

**Industry name(s):** chain-of-thought / reasoning prompting / structured
reasoning. **Type:** Industry standard.

## Zoom out, then zoom in

Some tasks need the model to reason step by step before answering; some don't, and
asking for reasoning there just burns tokens. AptKit's diagnostic agent is the
reasoning case — it must generate competing hypotheses, test them, and conclude.
Its intent classifier is the opposite — one word, no reasoning. Look at where
reasoning is asked for and where it's banned.

```
  Zoom out — where reasoning is invited vs suppressed

  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  ★ diagnostic → "Generate 2-3 hypotheses before the first ★  │ ← reasoning invited
  │     tool call" + hypothesesConsidered[] in output            │
  │  intent classify → "Reply with ONLY the one word"            │ ← reasoning suppressed
  └───────────────────────────┬──────────────────────────────────┘
                             │  reasoning lands in a JSON field, not loose prose
  ┌─ Runtime/Eval layer ─────▼──────────────────────────────────┐
  │  hypothesesConsidered drives confidence inference            │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: when a task is multi-step, prompt for the reasoning —
but capture it in a *structured field*, not free prose, so you keep both the
reasoning and a parseable answer. When a task is a simple lookup or classifier,
skip reasoning entirely. The diagnostic agent's `hypothesesConsidered` array is
chain-of-thought made structured and gradeable.

## Structure pass

**Layers.** Two: the *reasoning request* (the prompt's "generate hypotheses first"
step) and the *captured reasoning* (the `hypothesesConsidered` field in the typed
output).

**Axis — held constant: "does this task benefit from explicit reasoning?"**

```
  One question across tasks: reason explicitly or not?

  ┌─ diagnostic ──────────────┐  → YES: multi-step, hypotheses tested → CoT helps
  │ "2-3 hypotheses first"    │
  └───────────────────────────┘
  ┌─ intent classify ─────────┐  → NO: one-word lookup → CoT wastes tokens
  │ "ONLY the one word"       │
  └───────────────────────────┘
  ┌─ recommendation ──────────┐  → MIXED: reason from diagnosis, but output is the actions
```

**Seam — reasoning into a field.** The load-bearing seam is where reasoning meets
output. In the diagnostic agent it flips from "think freely" to "but emit your
thinking as `hypothesesConsidered`, not loose prose." That seam is what lets you
have reasoning *and* a structured answer the parser can read.

## How it works

#### Move 1 — the mental model

You already separate working notes from the final commit message: the scratch
thinking helps you, but the commit message is the artifact. Chain-of-thought with
structured output does the same — the reasoning helps the model, but you capture
it in a named field instead of letting it pollute the answer you parse.

```
  Reasoning into a structured field — the pattern

  prompt: "Generate hypotheses, test them, then conclude."
        │
        ▼  model reasons...
  output: { conclusion, evidence,
            hypothesesConsidered: [ {hypothesis, supported, reasoning} ] }
                                       │
                                       └─ the reasoning lives HERE, parseable,
                                          not in loose prose before the JSON
```

#### Move 2 — the walkthrough

**Prompt for reasoning when the task is multi-step.** The diagnostic prompt's
"Recommended approach" is an explicit CoT scaffold: "1. Generate 2-3 hypotheses
before the first tool call. 2. Query to falsify each hypothesis. 3. ... 4. Conclude
with the hypothesis that best fits." This forces the model to reason before acting,
which for root-cause investigation measurably improves the conclusion. **Breaks if
missing:** the model jumps to the first plausible cause without considering
alternatives — the single-hypothesis trap.

```
  CoT scaffold — reason before acting

  1. hypotheses first  →  2. query to falsify  →  3. locate the change in time
                                                →  4. conclude with best fit
        │
        └─ step 1 BEFORE any tool call is the load-bearing part: it forces
           consideration of alternatives, not commitment to the first guess
```

**Capture the reasoning in a field, not loose prose.** The diagnostic output shape
has `hypothesesConsidered: [{ hypothesis, supported, reasoning }]`. The model's
step-by-step thinking goes *there*, structured, while `conclusion` holds the
answer. This is the interaction with output validation: you want reasoning AND a
parseable answer, so the reasoning becomes a field. **Breaks if missing:** loose
chain-of-thought prose before the JSON either gets parsed as garbage or forces you
to choose between reasoning and structure.

**The reasoning becomes a gradeable signal.** Because hypotheses are structured,
the diagnostic agent infers confidence from them: high confidence requires at least
one supported hypothesis AND every hypothesis tested (non-empty reasoning); errors
during tool calls downgrade high to medium. The captured reasoning isn't just for
the model — it drives a downstream decision. **Breaks if missing:** confidence
would be the model's self-report, not derived from whether it actually tested its
hypotheses.

```
  hypothesesConsidered drives confidence

  supported >= 1 AND all tested  → high
  supported >= 1                 → medium
  none supported                 → low
  (any tool error)               → downgrade high → medium
        │
        └─ structured reasoning is auditable; the code checks the model's work
```

**Suppress reasoning for classifiers.** The intent classifier says "Reply with
ONLY the one word" and caps `maxTokens` at 16. No reasoning, no preamble — a
one-word lookup doesn't benefit from CoT, and asking for it would waste tokens and
risk a verbose answer the parser has to strip. **Breaks if missing:** a classifier
that "thinks out loud" returns "Well, this seems like a diagnostic question
because..." and your `parseIntent` keyword match gets noisier.

#### Move 2.5 — current state vs the modern caveat

```
  Then (CoT as explicit prompt)        Now (frontier models)
  ────────────────────────────        ──────────────────────
  "think step by step" required        models do CoT internally
  cheaper models still need it         reasoning models reason unprompted
  diagnostic scaffold = explicit CoT   the scaffold still shapes the OUTPUT structure
```

The modern caveat the spec names: frontier models do chain-of-thought internally
now, so asking for it explicitly is less necessary than it was for the *quality* of
reasoning. But the diagnostic agent's scaffold earns its place anyway — it's not
just asking the model to think, it's *structuring what the model emits*
(`hypothesesConsidered`), which a model's internal reasoning doesn't give you. The
scaffold survives the model upgrade because it shapes output, not just cognition.

#### Move 3 — the principle

Reason explicitly only where the task is multi-step, and when you do, capture the
reasoning in a structured field so you keep both the thinking and a parseable
answer. For lookups and classifiers, suppress reasoning — it's pure token cost. On
frontier models the quality benefit of explicit CoT shrinks, but the
output-structuring benefit (reasoning as a field) does not.

## Primary diagram

The diagnostic agent's structured CoT, end to end.

```
  Diagnostic agent — structured chain-of-thought

  prompt scaffold:
    "1. Generate 2-3 hypotheses before the first tool call
     2. Query to falsify each   3. locate change in time   4. conclude"
        │
        ▼  bounded tool loop (maxToolCalls 6)
  output (validated):
    { conclusion: "...",
      evidence: ["..."],
      hypothesesConsidered: [ {hypothesis, supported, reasoning} ] }  ← CoT captured here
        │
        ▼  diagnosisConfidence(diagnosis)
    supported≥1 & all tested → high  | supported≥1 → medium | else low
        │  (any tool error → downgrade high→medium)
        ▼
    Diagnosis { ..., confidence }
```

## Implementation in codebase

**Use cases.** The diagnostic agent is the structured-CoT case. The intent
classifier is the suppressed-reasoning case. Recommendation reasons internally but
outputs only the actions.

The CoT scaffold in the diagnostic prompt:

```
  packages/prompts/src/diagnostic.ts  (lines 16–21)

  Recommended approach:
  1. Generate 2-3 hypotheses before the first tool call.
  2. Query to falsify each hypothesis.
  3. Spend one call locating when the change happened with a time-series query...
  4. Conclude with the hypothesis that best fits the evidence.
       │
       └─ step 1 "before the first tool call" forces consideration of alternatives.
          This is CoT as an explicit scaffold, not a vibe.
```

The structured reasoning field in the output contract:

```
  packages/prompts/src/diagnostic.ts  (lines 30–38)

  { "conclusion": "string", "evidence": ["string"],
    "hypothesesConsidered": [ { "hypothesis": "string", "supported": true, "reasoning": "string" } ],
    ... }
       │
       └─ reasoning lives in a field, parseable, not as loose prose. This is the
          reasoning-AND-structure interaction (02) made concrete.
```

The reasoning driving a real decision — confidence inference:

```
  packages/agents/diagnostic-investigation/src/diagnostic-agent.ts  (lines 82–98)

  const diagnosis = parsed ?? FALLBACK_DIAGNOSIS;
  const confidence = diagnosisConfidence(diagnosis);
  const hadErrors = toolCalls.some((call) => call.error);
  return { ...diagnosis, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence };
  ...
  export function diagnosisConfidence(diagnosis: Diagnosis): 'high'|'medium'|'low' {
    const hypotheses = diagnosis.hypothesesConsidered ?? [];
    const supported = hypotheses.filter((item) => item.supported).length;
    const tested = hypotheses.filter((item) => item.reasoning.trim().length > 0).length;
    if (supported >= 1 && tested === hypotheses.length) return 'high';   ← audits the CoT
    if (supported >= 1) return 'medium';
    return 'low';
  }
       │
       └─ confidence is DERIVED from whether the model tested its hypotheses, not
          self-reported. Structured reasoning is what makes that audit possible.
```

The opposite — reasoning suppressed for the classifier:

```
  packages/agents/query/src/intent.ts  (lines 17–23)

  system: 'Classify the user query as exactly one word: monitoring (...),
           diagnostic (...), or recommendation (...). Reply with ONLY the one word.',
  messages: [{ role: 'user', content: query }],
  maxTokens: 16,   ← no room to ramble; reasoning would be pure waste here
       │
       └─ a one-word lookup gains nothing from CoT. maxTokens 16 enforces brevity.
```

## Elaborate

The diagnostic agent is a textbook case of why CoT survived the move to reasoning
models: the value isn't only "the model thinks better when asked to," it's "I get
the model's reasoning as structured data I can audit." `diagnosisConfidence` reads
the `hypothesesConsidered` array and downgrades confidence when hypotheses weren't
tested — that audit is impossible if the reasoning is loose prose or hidden inside
the model's internal chain. So even as frontier models reason unprompted, the
*output-structuring* half of this scaffold keeps earning its place.

The honest note: AptKit doesn't use a separate "thinking" field that's discarded
before parsing — the reasoning is load-bearing data (`hypothesesConsidered`),
which is arguably better than a throwaway scratchpad. There's no use of provider
extended-thinking modes either; the CoT is plain prompt scaffolding. For the
cheaper models in the fallback chain (04), the explicit scaffold still does real
work on reasoning quality, which is another reason it's worth keeping
provider-neutral.

Where it connects: 02 (reasoning-as-a-field is structured output), 06 (the
diagnostic stage's single job is *why*, which is the reasoning-heavy stage), and 05
(the confidence inference is a deterministic scorer on the model's own reasoning).

## Interview defense

**Q: When does chain-of-thought help and when does it hurt?**
Helps on multi-step problems — root-cause diagnosis, where the diagnostic agent
generates and tests competing hypotheses before concluding. Hurts on simple
lookups and classifiers, where it's pure token cost and risks a verbose answer the
parser has to strip — so the intent classifier says "ONLY the one word" with
`maxTokens` 16. On frontier models the reasoning-quality benefit shrinks, but if I
capture reasoning in a structured field, the output-structuring benefit survives.

```
  multi-step  → CoT, captured in a field (hypothesesConsidered)
  lookup      → suppress (ONLY the one word, maxTokens 16)
```
Anchor: "diagnostic scaffold `diagnostic.ts:16`; classifier `intent.ts:19`."

**Q: Where does the reasoning go if you want it AND a parseable answer?**
Into a structured field, not loose prose. The diagnostic output is
`{ conclusion, evidence, hypothesesConsidered: [{hypothesis, supported,
reasoning}] }` — the thinking is in the array, the answer in `conclusion`. Bonus:
the code then audits it, deriving confidence from whether hypotheses were actually
tested.
Anchor: "`hypothesesConsidered` at `diagnostic.ts:33`, audited in
`diagnosisConfidence`, `diagnostic-agent.ts:89`."

## Validate

- **Reconstruct:** Draw where reasoning goes when you want both reasoning and a
  structured answer.
- **Explain:** Why does `diagnosisConfidence` (`diagnostic-agent.ts:89`) check
  `tested === hypotheses.length` rather than trusting a self-reported confidence?
- **Apply:** You're adding a step to the diagnostic scaffold. Where in
  `diagnostic.ts` does it go, and does it change the output shape?
- **Defend:** A teammate adds "think step by step" to the intent classifier.
  Argue against it using the `maxTokens: 16` constraint and the classifier's job.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — reasoning as a JSON field.
- [06-single-purpose-chains.md](06-single-purpose-chains.md) — the diagnostic stage is the reasoning-heavy one.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — confidence inference as a scorer on reasoning.
- [08-few-shot.md](08-few-shot.md) — the one-word classifier and its example.
