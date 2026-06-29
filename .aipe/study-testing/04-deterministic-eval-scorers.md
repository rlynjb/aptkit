# Deterministic eval scorers

**Subtitle:** Table-driven testing / oracle testing with hand-computed expected
values — *Industry-standard*. This is where **testing meets evaluation**.

## Zoom out, then zoom in

aptkit ships an *evaluation* toolkit — precision@k, detection scoring,
structural-diff, an LLM-as-judge. Those tools grade *probabilistic* model
output, which is study-ai-engineering's territory. But the scorers themselves
are *deterministic functions*, and their tests are pure testing: known input,
hand-computed expected value, `assert.equal`. This file is about that half —
how you unit-test the thing that does the grading.

```
  Zoom out — the eval scorers, and which half is tested where

  ┌─ Eval layer (@aptkit/evals) ──────────────────────────────────┐
  │  scorePrecisionAtK · scoreRecallAtK · scoreDetections          │
  │  evaluateStructuralDiff · RubricJudge validator                │
  │  ★ deterministic functions ★  ← TESTED HERE                   │
  └───────────────────────────────┬────────────────────────────────┘
                                  │  used to grade
  ┌─ Model output (probabilistic) ▼────────────────────────────────┐
  │  "is the retrieval good? is the answer grounded?"              │
  │  ← EVALUATED in study-ai-engineering (not a pass/fail unit test)│
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: the seam from the README, made concrete. `scorePrecisionAtK(ranking,
relevant, 3)` is a pure function — same inputs, same output, forever. So its
test computes the answer by hand (`2/3`) and asserts it. The *use* of that
function on a real model's retrieval is evaluation; the *function* is testing.

## Structure pass

**Layers:** the scorer (pure function) → its test (known input + oracle) → its
production use (grading model output, elsewhere).

**Axis — determinism: "is the assertion 'equals X' or 'good enough'?":**

```
  One axis: "what kind of assertion?"

  ┌─ scorer fn ───────────┐   pure: f(input) is constant
  └───────────┬───────────┘
              │  seam ═══════ ◄── the determinism line
  ┌─ test    ▼────────────┐   "equals 2/3"  → TESTING (here)
  └───────────┬───────────┘
  ┌─ prod use ▼───────────┐   "score >= 0.8 didn't regress"
  │  grade a model         │   → EVALUATION (study-ai-engineering)
  └────────────────────────┘
```

**The seam:** the determinism line. The same `scorePrecisionAtK` sits on both
sides — below the seam its output is a hand-checkable constant (test it), above
it the input is a stochastic model's ranking (evaluate with it).

## How it works

### Move 1 — the mental model

Table-driven testing with an oracle: you pick inputs whose correct output you
can compute by hand, then assert the function reproduces your arithmetic. You
do this with any pure utility — a date formatter, a currency rounder. A scorer
is just a pure utility whose output happens to be a quality metric.

```
  Oracle test — hand-compute the answer, assert the function matches

   known input                     hand-computed oracle
   ┌──────────────────────────┐    ┌──────────────────────────┐
   │ ranking = [a,b,c,d,e]     │    │ top-3 = [a,b,c]           │
   │ relevant = {a,c,e,z}      │ ─► │ hits = {a,c} → 2          │
   │ k = 3                     │    │ precision = 2/3           │
   └──────────────────────────┘    └──────────────────────────┘
                                    assert.equal(result.score, 2/3)
```

The strategy in one sentence: **pick inputs you can grade by hand, assert the
scorer's arithmetic.**

### Move 2 — the walkthrough

**Precision@k: one known ranking, many hand-computed cases.**
`precision-at-k.test.ts` fixes `ranking = ['a','b','c','d','e']` and
`relevant = {a,c,e,z}`, then walks the denominator's edge behavior:

```ts
// packages/evals/test/precision-at-k.test.ts:10
// top-3 = [a,b,c]; hits = {a,c} => matched 2, total min(3,5)=3
const result = scorePrecisionAtK(ranking, relevant, 3);
assert.equal(result.matched, 2);
assert.equal(result.total, 3);
assert.equal(result.score, 2 / 3);
```

The comment *is* the oracle — the arithmetic is shown so the assertion is
auditable. The interesting cases are the degenerate ones: `k > retrieved`
caps the denominator at the actual count (`:19`, total = `min(10,5) = 5`);
duplicate ids count once (`:28`); and the "not well-formed" guards return
`{ ok: false, score: 0 }` rather than `NaN` for `k <= 0` (`:37`) and empty
retrieval (`:52`). Those guards are the difference between a metric that
degrades gracefully and one that poisons an eval summary with `NaN`.

**Detection scorer: full match, partial match, unexpected.**
`detection-scorer.test.ts:21` asserts a full match scores `1` with the exact
`matched` list; `:36` asserts a partial match scores a *specific fraction*
(`0.25`) with the `missed` items and the issue paths
(`['expectations.minCount', 'expectations.requiredCategories',
'expectations.requiredScopes']`); `:54` asserts `unexpected` categories are
tracked when a `maxCount` is exceeded. The fractional score is hand-computed
and pinned — not "roughly partial," but exactly `0.25`.

**Structural-diff: the assertion DSL, both green and red.**
`structural-diff.test.ts:29` runs six check types (`equals`, `number` with
tolerance, `arrayCount`, `containsText`, `arrayIncludes`) against a known
subject and asserts `issues == []`. Then `:43` runs the *failing* variants and
asserts the exact set of failing paths comes back in order. Testing both the
pass and the fail of an assertion library is what proves it actually checks
something — a checker that always returns `ok: true` would pass the green test
and silently rot.

**Rubric judge: the harness, not the judgment.** `rubric-judge.test.ts` is the
clearest example of the seam. It tests:
- the prompt is built generically (`:86`, `assert.doesNotMatch(/D1 OBSERVATION/)`
  — no hardcoded Dryrun dimensions);
- the validator rejects an out-of-rubric verdict and an out-of-range score with
  exact error strings (`:96`);
- the judge runs through `generateStructured`, emits exactly one `model_usage`
  trace event, and retries malformed output (`:131`, `:156`).

It uses a `ScriptedProvider` returning canned judgments — so it tests the
*deterministic machinery around the judge*. It does **not** test "is Claude a
good judge of Gemma?" That probabilistic question is study-ai-engineering's
LLM-as-judge discussion. The line is explicit and correct.

```
  Layers-and-hops — same scorer, two contexts

  ┌─ Test ───────────┐ hop1: scorePrecisionAtK   ┌─ scorer (pure) ─┐
  │  known ranking    │ ─────────────────────────►│  count hits /   │
  │  hand-computed     │ hop2: score (a constant) ◄│  denominator    │
  │  oracle            │                           └─────────────────┘
  └───────────────────┘                                   ▲
  ┌─ Prod (elsewhere) ┐ hop3: scorePrecisionAtK           │
  │  model's ranking   │ ──────────────────────────────────┘  same fn,
  │  → "did it regress?"│  (study-ai-engineering)               stochastic input
  └────────────────────┘
```

### Move 2 variant — the kernel

The kernel of an oracle test: **an input whose correct output you can compute
by hand + the hand-computed value asserted exactly + coverage of the degenerate
inputs.** Remove the by-hand computability (use a giant realistic dataset) and
you can't write a precise assertion — you fall back to "score is roughly high,"
which is evaluation, not testing. Remove the degenerate-input cases (`k <= 0`,
empty set, duplicates) and the scorer's worst behavior — `NaN`, divide-by-zero
— ships untested.

Optional hardening: testing the failing path of an assertion library (the red
cases in structural-diff). Not strictly the kernel, but it's what proves the
checker checks.

### Move 3 — the principle

A metric is only trustworthy if the thing computing it is itself proven correct
on inputs you can verify by hand. aptkit gets this right by drawing a hard line:
the *scorer* is unit-tested deterministically (here), and the *judgment about a
model* is evaluation (there). Confusing the two — trying to make "is the answer
good?" a pass/fail unit test — is how AI test suites become either flaky or
meaningless. Test the ruler with a known length before you measure anything
with it.

## Primary diagram

```
  Deterministic eval scorers — the determinism line

  TESTED HERE (deterministic) ──────────────── EVALUATED THERE (probabilistic)
                                       │
  scorePrecisionAtK([a..e],{a,c,e,z},3)│  scorePrecisionAtK(modelRanking, ...)
    → 2/3  (hand-computed, asserted)   │    → "didn't regress below baseline"
  scoreDetections → 0.25 partial       │  graded against a real agent's output
  evaluateStructuralDiff → exact paths │  study-ai-engineering owns this side
  RubricJudge validator → exact errors │
  RubricJudge harness (ScriptedProvider)│  "is Claude a good judge?" ← there
                                       │
  oracle: f(input) is a constant ──────┴── input is a stochastic model
```

## Elaborate

This is classic table-driven / data-driven testing with a hand-computed oracle
— the safest way to test any pure function. The reason it deserves a named
pattern file in *this* repo is the seam it straddles: aptkit's whole value
proposition includes the eval toolkit, and the discipline of testing the
scorers deterministically while reserving "is the model good?" for evaluation
is exactly the testing/eval partition this guide is organized around. Read
study-ai-engineering for the other half — how precision@k, the rubric-judge
(LLM-as-judge, anti-circular: Claude judges Gemma), and replay diffs are *used*
to evaluate model and prompt changes. This file proves the rulers are accurate;
that guide uses them to measure.

## Interview defense

**Q: How do you unit-test something that scores AI output quality?**

> You separate the scorer from the thing it scores. The scorer is a pure
> function — precision@k is just "hits in the top-k over the denominator" — so
> I test it with a known ranking and a known relevant set whose answer I
> compute by hand: top-3 of [a,b,c,d,e] against {a,c,e,z} is 2/3, assert
> exactly that. The hard cases are the degenerate ones — k <= 0, empty
> retrieval, duplicates — which return a not-well-formed result instead of NaN.
> What I *don't* turn into a unit test is "is this model's answer good" — that's
> evaluation, scored against a baseline, not asserted equal to a constant.

```
  ranking=[a,b,c,d,e], relevant={a,c,e,z}, k=3 → top3={a,b,c}, hits={a,c} → 2/3
```

Anchor: *test the ruler with a known length before you measure with it.*

**Q: Why test the failing paths of your assertion DSL?**

> Because a checker that always returns ok:true passes every green test and
> silently rots. structural-diff has both: a subject that should pass with zero
> issues, and a subject that should fail with a specific ordered list of failing
> paths. Testing the red case is what proves the checker actually checks.

Anchor: *a checker is only proven when its failing path is tested.*

## See also

- `02-fixture-replay-golden-master.md` — the artifact the eval scorers grade.
- `01-injectable-transport-seam.md` — the `ScriptedProvider` the rubric-judge
  harness uses.
- `audit.md` lens 6 (testing AI features — the deterministic/probabilistic line).
- study-ai-engineering — the *use* of these scorers to evaluate models
  (precision@k, LLM-as-judge, replay diffs). This file is the testing half;
  that guide is the evaluation half.
