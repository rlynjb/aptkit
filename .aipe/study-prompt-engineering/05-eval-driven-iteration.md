# 05 — Eval-driven prompt iteration

**Industry name:** eval-driven development / LLM evals — *Industry standard*

## Zoom out, then zoom in

Here's the dividing line between a junior and a senior prompt engineer: a junior
iterates by vibes — "the response feels better now." A senior iterates against an
eval set. I once watched a prompt sit at 4/5 on a rubric for six months before we
realized the rubric was measuring the wrong thing the whole time. The fix isn't
"trust the model less" — it's *write the eval before you touch the prompt*, so
every change is scored, diffed, and gated against regressions.

aptkit has the eval machinery wired as a real backbone.

```
  Zoom out — the eval loop around the prompt

  ┌─ Prompt change (the thing under test) ────────────────────┐
  │  edit PromptPackage.system in prompts/src/*.ts             │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Run → artifact ──────────▼────────────────────────────────┐
  │  live/replay run → artifacts/replays/*.json {output, eval} │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Score (this concept) ────▼────────────────────────────────┐
  │  ★ evals/structural-diff.ts — shape assertions ★           │ ← we are here
  │  ★ evals/detection-scorer.ts — required categories/scopes ★ │
  │  ★ evals/rubric-judge.ts — Claude judges meaning ★         │
  │  ★ evals/precision-at-k.ts — retrieval precision/recall ★  │
  │  evals/replay-runner.ts — batch eval → summary             │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Gate ────────────────────▼────────────────────────────────┐
  │  keep change if score up AND no regression on golden set    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the repo gives you three *kinds* of scorer, and the kind you pick is the
whole game. Rule-based (`structural-diff`, `detection-scorer`, `precision-at-k`)
for things with a checkable answer; LLM-as-judge (`rubric-judge`) for things that
need judgment. Mixing them up is how you get a 4/5 that means nothing.

## The structure pass

**Layers:** the golden set (curated cases) → the run (prompt produces output) →
the scorer (rule-based or judge) → the gate (keep/reject the change).

**Axis — is the correctness *checkable by a rule* or does it need *judgment*?**
This axis decides which scorer is valid:

```
  Axis: "can a rule check this, or does it need a judge?"

  ┌─ Deterministic correctness ─┐  seam  ┌─ Subjective quality ──────┐
  │ shape, required fields,     │ ══╪══► │ "is this answer good?"    │
  │ precision@k, detection      │ flips  │ rubric-judge (LLM judges)  │
  │ → structural-diff,          │        │ → rubric-judge.ts          │
  │   detection-scorer,         │        │                            │
  │   precision-at-k            │        │                            │
  └─────────────────────────────┘        └────────────────────────────┘
   cheap, exact, no model call            costs a model call, can drift
```

**Seam:** the boundary between rule-scored and judge-scored. It's load-bearing
because picking the wrong side breaks the eval: score a free-form answer with a
shape assertion and you measure formatting, not correctness; score retrieval
quality with an LLM judge and you've made a deterministic metric expensive and
noisy. The repo keeps them separate by file. **What breaks if you blur the seam:**
the six-months-at-4/5 problem — a judge rubric that's actually measuring the
wrong dimension, with no rule-based ground truth to catch it.

## How it works

### Move 1 — the mental model

You already write tests before you trust a refactor — red, green, refactor. An
eval set is a test suite for a prompt. The twist: LLM output isn't deterministic,
so some assertions are exact (the JSON has these fields) and some are graded (the
answer is reasonable). You write both kinds *first*, then iterate the prompt
against them.

```
  Pattern — the eval-driven iteration loop

   write eval (golden set + regression cases)
        │
        ▼
   change prompt ──► run ──► score ──► diff vs baseline
        ▲                                  │
        │                          score up & no regression?
        └──────── reject ◄── no ──┤
                  keep    ◄── yes ─┘
```

### Move 2 — walking the scorers

**Scorer 1 — shape assertions (`structural-diff.ts`).** The cheapest gate:
does the output have the required structure? The replay-artifact assertions
(`evals/assertions.ts`) and `structural-diff` check the artifact shape — fields
present, types right. **What breaks without it:** a prompt edit that changes the
output shape ships and breaks the consumer before any quality question is even
asked.

**Scorer 2 — detection scoring (`detection-scorer.ts:1`).** For the
anomaly-monitoring agent, correctness means "did it find the anomalies it
should?" `DetectionExpectations` (`detection-scorer.ts:13`) declares
`minCount`, `requiredCategories`, `requiredScopes`, `requiredSeverities`. The
scorer checks the detected set against those. This is a *recall-style* gate on a
classifier-shaped task. **What breaks without it:** a "more concise" prompt edit
that quietly drops a critical anomaly category — the exact regression the spec
warns about.

**Scorer 3 — precision@k / recall@k (`precision-at-k.ts`).** For retrieval, the
correctness question is ranked: of the top-k chunks, how many are relevant
(precision), and of all relevant chunks, how many made the top-k (recall)?

```
  Inline annotation — precision-at-k.ts:47 scorePrecisionAtK

  if (k <= 0) return NOT_WELL_FORMED;            ← ok:false when metric undefined
  const total = Math.min(k, retrievedIds.length); ← short result list not penalized
  const matched = countDistinctHits(..., k);      ← DISTINCT relevant in top-k
  return { ok: true, score: matched / total, matched, total };
```

The `ok` flag (`:13`) is the careful bit: it separates "well-formed but scored 0"
from "metric undefined (k≤0 or empty)". A real score of 0 still has `ok: true`.
This is how you gate a *retrieval* prompt or chunking change — change the prompt
that builds the query, re-score precision@k, keep it only if precision holds.

**Scorer 4 — LLM-as-judge (`rubric-judge.ts`).** When correctness needs judgment
("is this recommendation grounded and actionable?"), `RubricJudge.judge`
(`rubric-judge.ts:89`) runs a *structured* judging prompt — Claude scores the
subject against a `RubricDefinition` (dimensions with scales, allowed verdicts,
optional calibration examples). It's `generateStructured` under the hood
(`:93`), so the judgment itself is schema-validated (concept 02). **When
LLM-as-judge is appropriate:** subjective quality you can't rule-check, *and*
you've calibrated the rubric against known-good examples
(`calibrationExamples`, `rubric-judge.ts:26`). **When it's a trap:** when a rule
would do — you've added cost and drift for nothing.

```
  Inline annotation — rubric-judge.ts:146 the judging instruction

  "Score the subject against the rubric. Score meaning and evidence,
   not style preferences unless the rubric asks for style."  ← anti-style-bias
  "Never rewrite the subject. Return one highest-leverage fix, not a list."
  // calibration examples (:126): "Use these only to anchor the scoring
  //   scale; do not repeat them."  ← stops the judge parroting examples
```

**Scorer 5 — the batch runner (`replay-runner.ts`).** Wraps the above into a
batch eval over recorded artifacts → a `ReplayArtifactEvalSummary`. That's the
"run the whole golden set" step. Combined with the fixture-replay backbone (see
`../study-testing/`), a production failure becomes a promoted fixture that lives
in the regression suite *forever* — the spec's "regression suite" made real.

### Move 3 — the principle

**Write the eval before you iterate the prompt, and never let an average hide a
regression.** A prompt change that lifts the mean score while tanking one
critical edge case is a net loss you can't see without per-case diffs. The
machinery exists so iteration stops being vibes: every change is scored against a
fixed set, rule-checked where possible, judged only where necessary, and gated on
*no regression*, not just *higher average*.

## Primary diagram

The full eval backbone, scorer types separated by the seam.

```
  Eval-driven iteration — the full backbone

  GOLDEN SET (curated cases + promoted regressions)
        │  run prompt
        ▼
  ARTIFACT {output, trace}  artifacts/replays/*.json
        │
        ▼  pick scorer by the seam
  ┌─ RULE-BASED (cheap, exact) ─┐   ┌─ JUDGE (costly, subjective) ─┐
  │ structural-diff (shape)     │   │ rubric-judge (Claude scores   │
  │ detection-scorer (recall)   │   │   meaning, calibrated,        │
  │ precision-at-k (retrieval)  │   │   schema-validated output)    │
  └─────────────┬───────────────┘   └──────────────┬───────────────┘
                └─────────► replay-runner ◄─────────┘
                           batch → ReplayArtifactEvalSummary
                                    │
                                    ▼
                  GATE: score up AND no regression → keep
```

## Elaborate

Hamel Husain's writing on evals is the canonical reference here, and his core
claim is exactly this repo's structure: most teams over-invest in the LLM-judge
and under-invest in cheap rule-based checks and a real golden set. The
rubric-judge's anti-style-bias instruction (`:146`) and "don't repeat the
calibration examples" guard (`:126`) are direct counters to the two classic
LLM-judge failure modes — judging on style instead of substance, and parroting
the calibration set. The deeper discipline: an eval is a measuring instrument,
and a miscalibrated instrument (the 4/5 that meant nothing) is worse than none
because it gives false confidence. The honest gap in this repo: the evals exist
and run, but there's no *gate keyed on model version* — so a model upgrade that
regresses the golden set isn't automatically blocked (cross-link concept 03).

## Interview defense

**Q: How do you iterate a prompt without flying blind?** Write a golden set
first (20–50 hand-curated cases with expected outputs), add every production
failure back as a permanent regression case, then for each prompt change: run,
score, diff against baseline, keep only if the score improved *with no
regression*. Pick rule-based scorers for checkable correctness, LLM-judge only
for subjective quality you've calibrated.

```
  rule-based ──┊── LLM-judge
  shape/recall ┊  meaning/quality
  /precision   ┊  (calibrated)
               ┊  pick the wrong side → measure the wrong thing
```
*Anchor: `precision-at-k.ts:47`, `rubric-judge.ts:89`, `detection-scorer.ts:13`.*

**Q: The part people forget?** The **regression case from a real bug**. Averages
improve while a critical edge case silently breaks; the only defense is a fixed
golden set where every past failure is pinned forever. In this repo that's the
fixture-promotion path — a real failure becomes a permanent deterministic case.

## See also

- `02-structured-outputs.md` — the rubric judge's output is itself schema-validated.
- `03-prompts-as-code.md` — the eval gate should key on prompt version × model.
- `../study-testing/` — `02-fixture-replay-golden-master.md`,
  `04-deterministic-eval-scorers.md` for the testing-side depth.
- `../study-ai-engineering/` — the evals section of the AI-engineering guide.
