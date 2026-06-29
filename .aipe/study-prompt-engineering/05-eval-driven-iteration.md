# 05 — Eval-driven prompt iteration

**Subtitle:** eval-driven iteration — golden set, regression suite, score
before vibes (Industry standard)

## Zoom out, then zoom in

This is the concept that separates a senior from a junior more sharply than
any other. A junior iterates a prompt by vibes — "the response feels better
now." A senior iterates against an eval set with a number. aptkit is built
around this: its entire backbone is live run → artifact → eval → promote to
fixture → deterministic replay. The eval layer is not a side feature; it's
the loop that gates every prompt change.

```
  Zoom out — the eval layer closing the loop

  ┌─ Runtime ───────────────────────────────────────────────────┐
  │  agent run → output + trace                                  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ artifact (JSON on disk)
  ┌─ ★ Eval layer ★ ──────────▼───────────────────────────────────┐
  │  ★ rubric-judge (Claude judges Gemma)                         │ ← we are here
  │  ★ precision@k / recall@k (retrieval)                         │
  │  ★ structural-diff, detection-scorer, replay-runner           │
  └───────────────────────────┬──────────────────────────────────┘
                              │ promote passing run → fixture
  ┌─ Regression layer ────────▼───────────────────────────────────┐
  │  FixtureModelProvider replays recorded responses, forever      │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: eval-driven iteration is the loop *change prompt → run evals →
diff scores → keep the change only if it improved without regressing*. The
golden set is your hand-curated truth; the regression suite is every
production failure added back as a permanent test. You write the eval
*before* you iterate the prompt, because otherwise you're optimizing a
target you can't see.

## Structure pass

**Layers.** Runtime (produces an artifact) → eval (scores it) → regression
(freezes a passing artifact as a replayable fixture).

**Axis — what decides whether a prompt change ships?** Trace it:

```
  Axis: "what authority approves a prompt change?"

  junior loop      → the engineer's gut ("feels better")     ✗
  golden set       → a score on hand-curated cases           ✓
  regression suite → no drop on any past-failure case        ✓
  promoted fixture → deterministic replay matches baseline   ✓
```

**Seam.** The load-bearing boundary is *judge model vs subject model*. The
rubric judge is Claude scoring Gemma's output — the trust flips across that
seam: you trust the judge's score more than you trust the subject's
self-report. That asymmetry is the whole point of LLM-as-judge.

## How it works

You already trust a test suite over your own reading of a diff — you don't
merge because the code "looks right," you merge because the tests pass.
Eval-driven prompt iteration is that exact reflex applied to prompts. Let's
walk the kernel.

### The kernel — change, score, gate

```
  Eval-driven iteration — the load-bearing loop

  ┌──────────────────────────────────────────────────────┐
  │  1. WRITE THE EVAL FIRST (golden + regression cases)  │
  │  ┌────────────────────────────────────────────────┐  │
  │  │ 2. change the prompt                             │  │
  │  │ 3. run the eval set → scores                     │  │
  │  │ 4. diff vs baseline                              │  │
  │  │      improved AND no regression? ── yes ─► keep  │  │
  │  │                                    └─ no ─► revert│  │
  │  └────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────┘
```

Each part by what breaks without it:

- **Eval written first.** Drop it and you iterate toward a target you're
  inventing as you go — the "4/5 rubric that measured the wrong thing for
  six months" failure.
- **Run on a *set*, not one case.** Drop it and you overfit to the one
  example you're staring at.
- **Diff vs baseline.** Drop it and you can't tell improvement from noise.
- **No-regression gate.** Drop it and you ship the "better average, worse
  critical edge case" change — the most dangerous one, because the average
  looks good.

### Step 1 — the golden set lives as fixtures

aptkit's golden cases are recorded `ModelResponse[]` replayed deterministically
by a `FixtureModelProvider` (per the project's data model). A passing live
run gets *promoted* to a timestamped fixture — an auto-generated correctness
baseline. The must-not-change rule is explicit: editing a promoted fixture
changes test meaning, so they're regenerated via `promote:replay`, never
hand-edited. That's the golden set as a frozen, version-controlled artifact.

### Step 2 — the rubric judge (LLM-as-judge), done carefully

When the output is open-ended prose you can't string-match, you score it
with another model. aptkit's `RubricJudge` is the careful version — it
doesn't ask "is this good?", it scores defined dimensions on defined scales
with an allowlisted verdict:

```ts
// packages/evals/src/rubric-judge.ts:143 (buildRubricJudgeSystemPrompt)
'You are a rubric judge for: ' + rubric.title,
'Score the subject against the rubric. Score meaning and evidence, not style',
'  preferences unless the rubric asks for style.',
'Never rewrite the subject. Return one highest-leverage fix, not a list.',
'Allowed verdicts:', verdicts,
'Output JSON only. ... Use exactly this shape:', JSON.stringify(outputShape),
```

Three production-grade moves in that prompt: "score meaning and evidence,
not style" (judges drift toward rewarding verbose, pretty output — this
fights it), "never rewrite the subject" (a judge that rewrites stops being a
judge), and a *structured* judgment with a validated score range
(`createRubricJudgmentValidator`, concept 2). The judge's output is itself a
structured-output contract. And it's run through `generateStructured`
(`rubric-judge.ts:93`) so a malformed judgment retries instead of crashing
the eval.

```
  Layers-and-hops — LLM-as-judge, trust flipping across the seam

  ┌─ Subject ────────┐ hop 1: output text  ┌─ Judge (Claude) ────┐
  │ Gemma agent run   │ ──────────────────► │ RubricJudge          │
  │ (best-effort)     │                     │ scores dims + verdict│
  └───────────────────┘ hop 2: rubric +     └──────────┬───────────┘
                          calibration examples          │ hop 3: validated
                                                         ▼ RubricJudgment JSON
                                              ┌─ Eval result ──────┐
                                              │ score + one fix     │
                                              └─────────────────────┘
```

The calibration examples in the rubric anchor the scoring scale and carry an
explicit instruction not to repeat them (`rubric-judge.ts:126`) — that's
few-shot used to calibrate a *judge*, the one place few-shot examples
genuinely enter a prompt in this repo (see concept 8).

### Step 3 — deterministic retrieval scorers for the gate

Not every eval needs a model. For retrieval changes, aptkit uses pure
arithmetic scorers — precision@k and recall@k:

```ts
// packages/evals/src/precision-at-k.ts:47
export function scorePrecisionAtK(retrievedIds, relevantIds, k): RetrievalScoreResult {
  if (k <= 0) return NOT_WELL_FORMED;
  const total = Math.min(k, retrievedIds.length);
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total };
}
```

These gate prompt-and-retrieval changes with a number you can diff across
versions: tweak the retrieval prompt or `top_k`, re-score, keep the change
only if precision held. Note the careful `ok` semantics — `ok:false` means
the metric is *undefined* (k≤0, empty input), not "bad score." A real 0 is
still `ok:true`. That distinction stops a malformed eval from masquerading
as a failing one.

### Step 4 — the no-regression gate via replay

The `replay-runner` batches recorded artifacts through the evals and
produces a `ReplayArtifactEvalSummary`. That's the no-regression gate: every
promoted fixture is re-scored on every change, so a prompt edit that fixes
case A but breaks case B shows up as a drop on B. The structural-diff and
detection-scorer assertions catch shape regressions deterministically. This
is the suite that turns "I think it's better" into "scores up on the golden
set, no drop on any regression case."

### The principle

**Skipping evals isn't faster — it's slower, because you iterate in
circles.** Vibes can't distinguish a real improvement from noise, and they
can't catch the better-average-worse-edge-case change. Write the eval first,
score every change against a set, gate on no-regression. The discipline is
non-negotiable for production prompt work, and it's the literal architecture
of this repo.

## Primary diagram

The full eval-driven loop, every stage labelled.

```
  Eval-driven prompt iteration in aptkit

  ┌─ Author ────────────────────────────────────────────────────┐
  │  WRITE EVAL FIRST: golden cases + past-failure regressions    │
  └────────────────────────────┬──────────────────────────────────┘
                              │ change the prompt
  ┌─ Run ─────────────────────▼───────────────────────────────────┐
  │  live run → artifact { capabilityId, provider, output, trace } │
  └────────────────────────────┬──────────────────────────────────┘
                              │ score
  ┌─ Eval ────────────────────▼───────────────────────────────────┐
  │  rubric-judge (Claude→Gemma) | precision@k/recall@k | diff     │
  │  → ReplayArtifactEvalSummary (a number per case)              │
  └────────────────────────────┬──────────────────────────────────┘
                              │ improved + no regression?
  ┌─ Gate ────────────────────▼───────────────────────────────────┐
  │  yes → promote run to fixture (frozen baseline, replay forever)│
  │  no  → revert the prompt change                                │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

Hamel Husain's writing on evals is the canonical reference here — the
insistence that you cannot improve what you don't measure, that LLM-as-judge
must be calibrated and constrained, and that the regression suite is built
from real failures, not imagined ones. aptkit's rubric judge reads like a
direct application: defined dimensions, a no-rewrite rule, calibration
examples, a validated structured verdict.

The deeper architectural point is that aptkit makes evals *cheap to run* by
recording real runs as fixtures and replaying them deterministically with
`FixtureModelProvider`. That's what makes the gate practical — you re-score
the whole golden set on every change without re-paying for model calls. The
full replay-centric testing backbone is walked in **study-testing**; this
concept is the prompt-iteration view of it.

## Interview defense

**Q: How do you know a prompt change is actually better?**

You don't read the output and decide — you score it against an eval set. A
golden set of hand-curated cases for the target behavior, plus a regression
suite of every past production failure. Change the prompt, run the set, diff
the scores, keep the change only if it improved *without* regressing any
case. Write the eval before touching the prompt, or you're optimizing an
invisible target.

```
  vibes:  read output → "feels better" → ship → regress in prod
  evals:  score set → diff → no-regression gate → ship with a number
```

Anchor: "aptkit's backbone is run → artifact → eval → promote → replay. The
rubric judge scores defined dimensions, not 'is this good,' and runs through
`generateStructured` so a bad judgment retries."

**Q: When is LLM-as-judge appropriate, and how do you keep it honest?**

When the output is open-ended prose you can't deterministically string-match.
Keep it honest by scoring defined dimensions on defined scales (not a vibe
score), forbidding the judge from rewriting the subject, anchoring with
calibration examples, and validating the verdict against an allowlist. For
anything you *can* score arithmetically — like retrieval — use a
deterministic scorer (precision@k) instead.

Anchor: "Claude judges Gemma in aptkit; `rubric-judge.ts:147` says 'score
meaning and evidence, not style' and 'never rewrite the subject.'"

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the judge's verdict
  is itself a validated structured output
- [03-prompts-as-code.md](03-prompts-as-code.md) — versioning is only useful
  with evals to compare versions
- [08-few-shot.md](08-few-shot.md) — calibration examples are where few-shot
  genuinely enters a prompt here
- study-testing — the full replay-centric eval backbone
