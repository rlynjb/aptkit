# Detection scoring (matched / missed / unexpected)

**Industry names:** precision/recall scoring · classification eval · set-overlap
scoring. **Type:** Industry standard (information-retrieval eval, applied to anomaly
detection).

## Zoom out, then zoom in

```
  Zoom out — detection scoring sits one notch past pass/fail

  ┌─ Eval layer (packages/evals) ─────────────────────────────┐
  │  structural-diff.ts   → pass/fail shape (02-)              │
  │  detection-scorer.ts  → FRACTIONAL score + sets           │ ← ★ here ★
  │  rubric-judge.ts      → LLM-as-judge prose score          │
  └─────────────────────────────┬─────────────────────────────┘
                                │ scores
  ┌─ Anomaly monitoring agent ──▼─────────────────────────────┐
  │  scans metrics → list of anomalies (category/metric/scope) │
  └────────────────────────────────────────────────────────────┘
```

You know how a search results test isn't "did we return the exact list" but "did we
find the docs we expected, and did we surface junk we shouldn't have"? That's
precision/recall. The anomaly detector has the same shape: it returns a *set* of
detected anomalies, and "correct" isn't byte-equality — it's "did it catch the ones
that matter (recall), and not flag noise (precision)?" That's the pattern:
**score the overlap between detected and expected as matched/missed/unexpected,
plus a fractional score** — not a hard equal.

## Structure pass

**Layers:** expectations (what should be found) → scorer (set overlap) →
result (score + three lists + issues).

**Axis — strictness (pass/fail vs degree):** trace it across the eval layer.

```
  One question across the eval siblings: "binary or graded?"

  ┌─ structural-diff ────┐  BINARY — ok = no issues
  └──────────┬───────────┘
  ┌─ detection-scorer ───▼┐  GRADED — score ∈ [0,1], partial credit
  └──────────┬────────────┘
  ┌─ rubric-judge ───────▼┐  GRADED + subjective — a model assigns the score
  └────────────────────────┘
```

**The seam:** between structural-diff and detection-scorer. Strictness flips: shape
assertion is all-or-nothing; detection scoring tolerates partial correctness and
*reports the degree*. That's the step from deterministic assertion toward
evaluation — still deterministic (no model call), but graded instead of binary.

## How it works

### Move 1 — the mental model

```
  Set overlap — three buckets

   expected:  { revenue_drop, inventory_spike }
   detected:  { revenue_drop, conversion_drop }

   matched    = expected ∩ detected  = { revenue_drop }      ← recall numerator
   missed     = expected − detected  = { inventory_spike }   ← recall gap
   unexpected = detected − expected  = { conversion_drop }   ← precision gap
```

The strategy: **partition the two sets into hit / miss / surprise, then turn the
counts into a score.** It's precision/recall without the formula ceremony — the
three lists *are* the diagnostic.

### Move 2 — step by step

**Step 1 — flatten expectations into requirements.** Each of
`requiredCategories`/`requiredMetrics`/`requiredScopes`/`requiredSeverities` becomes
a tagged requirement `{ kind, value }`. So a single loop can check every dimension
uniformly.

```
  expectations → requirement list

  { requiredCategories: ['revenue_drop'], requiredScopes: ['SP'] }
    → [ {kind:'category', value:'revenue_drop'}, {kind:'scope', value:'SP'} ]
```

**Step 2 — check count bounds.** `minCount` / `maxCount` against `detections.length`.
A miss here pushes an issue tagged `expectations.minCount` or `.maxCount`. This is
the precision/recall floor: too few detections fails recall, too many fails
precision.

**Step 3 — match each requirement.** For each requirement, does *some* detection
satisfy it? Category/metric/severity match by equality; scope matches by
`scope.includes(value)`. Matched → `matched[]`; not → `missed[]` plus an issue.

```
  matchesRequirement loop

  requirement {kind:'scope', value:'SP'}
    detections.some(d => d.scope?.includes('SP'))  → true  → matched
  requirement {kind:'category', value:'inventory_spike'}
    detections.some(d => d.category === 'inventory_spike') → false → missed + issue
```

**Step 4 — find the unexpected.** Only when category expectations exist: any detected
category NOT in `requiredCategories` is `unexpected`. The guard
(`expectedCategories.size > 0`) is the boundary — with no expected categories, you
can't call anything unexpected, so the list stays empty rather than flagging
everything.

**Step 5 — compute the fractional score.** `score = (requirementCount - failedCount)
/ requirementCount`, clamped to ≥ 0. `requirementCount` includes the count-bound
checks. So 1 of 4 requirements met with a count miss gives a partial score, not 0.

```
  score example (from the real test)

  expectations: minCount 3, requiredCategories [revenue_drop, inventory_spike],
                requiredScopes [MG]
  requirementCount = 3 (reqs) + 1 (minCount) = 4
  failed: minCount (only 2 detections), inventory_spike, MG = 3
  score = (4 - 3) / 4 = 0.25
```

### Move 3 — the principle

When the output is a *set*, correctness has two independent failure modes — missing
what you wanted (recall) and surfacing what you didn't (precision). A single
pass/fail hides which one broke. Reporting matched/missed/unexpected separately,
plus a graded score, tells you *how* it regressed, not just *that* it did.

## Primary diagram

```
  Detection scoring — full picture

  detections[]          expectations
       │                     │ flatten to requirements + count bounds
       └──────────┬──────────┘
                  ▼
        for each requirement: matchesRequirement?
                  │
        ┌─────────┼──────────┐
        ▼         ▼          ▼
     matched[]  missed[]  (unexpected[] from detected categories not expected)
        │         │
        └────┬────┘
             ▼
   score = (requirementCount - failedCount) / requirementCount   ∈ [0,1]
   ok = issues.length === 0
```

## Implementation in codebase

**Use cases:**
1. Scoring the anomaly-monitoring agent's detected anomalies against an expected set
   — did it catch the revenue drop in SP, and not over-flag?
2. Graded eval where partial credit matters — a detector that finds 3 of 4 expected
   anomalies is better than one that finds 0, and the score reflects it.

**Code side by side — the score formula**
(`packages/evals/src/detection-scorer.ts`):

```
  packages/evals/src/detection-scorer.ts  (lines 71–82)

  const requirementCount = required.length
    + (minCount > 0 ? 1 : 0)
    + (expectations.maxCount !== undefined ? 1 : 0);     ← count bounds count too
  const failedCount = missed.length
    + issues.filter(i => i.path === 'expectations.minCount'
                      || i.path === 'expectations.maxCount').length;
  const score = requirementCount === 0
    ? 1                                                  ← no expectations → trivially 1
    : Math.max(0, (requirementCount - failedCount) / requirementCount);

  return { ok: issues.length === 0, score, matched, missed,
           unexpected: [...new Set(unexpected)], issues };
        │
        └─ the three sets + the graded score are the diagnostic — pass/fail alone
           wouldn't tell you whether recall or precision broke (load-bearing)
```

**Code side by side — the test that pins partial credit**
(`packages/evals/test/detection-scorer.test.ts`):

```
  packages/evals/test/detection-scorer.test.ts  (lines 36–52)

  const result = scoreDetections(detections, {
    minCount: 3,                                    ← only 2 detections → miss
    requiredCategories: ['revenue_drop', 'inventory_spike'],
    requiredScopes: ['MG'],
  });
  assert.equal(result.ok, false);
  assert.equal(result.score, 0.25);                 ← 1 of 4 → exactly 0.25
  assert.deepEqual(result.matched, ['category:revenue_drop']);
  assert.deepEqual(result.missed, ['category:inventory_spike', 'scope:MG']);
        │
        └─ pins the fractional math AND the matched/missed split — a regression
           that broke partial credit (e.g. went binary) goes red here
```

The `unexpected` tracking has its own test (`detection-scorer.test.ts:54`): with
`requiredCategories: ['revenue_drop']`, the detected `conversion_drop` lands in
`unexpected`.

## Elaborate

This is precision/recall from information retrieval, stripped to its useful core for
a small eval. AptKit doesn't compute the precision and recall *numbers* — it reports
the three sets (matched/missed/unexpected) and a single blended score, which is more
legible for a 2–5 item anomaly list than two ratios. The deliberate omission:
there's no F1 or weighting — a missed critical anomaly counts the same as a missed
minor one. For a richer eval you'd weight by severity. Accepted for now because the
detector's output is small and the three lists make the failure obvious.

Where it sits: one notch stricter-tolerant than `02-structural-shape-assertions.md`
(graded vs binary) and one notch *less* subjective than the rubric judge
(deterministic set math vs a model's opinion). It's the bridge between deterministic
testing (this guide) and probabilistic evaluation (`study-ai-engineering`).

## Interview defense

**Q: How do you test a detector whose output is a set, not a single value?**
> Score set overlap: matched (caught the expected), missed (recall gap), unexpected
> (precision gap). Turn the counts into a fractional score so partial correctness
> gets partial credit. The three lists tell you *which* failure mode hit, not just
> that something did.

```
  expected ∩ detected = matched | expected − detected = missed | detected − expected = unexpected
```
> Anchor: a set has two failure modes — missing and over-flagging. Report them
> separately.

**Q: Why a fractional score instead of pass/fail?**
> A detector finding 3 of 4 anomalies is meaningfully better than one finding 0.
> Pass/fail erases that. The graded score lets a regression show as "0.75 → 0.5"
> before it's a hard failure — earlier signal.

## Validate

1. **Reconstruct:** define matched/missed/unexpected as set operations on expected
   vs detected. Then write the score formula. Check `detection-scorer.ts:71`.
2. **Explain:** why is `unexpected` only populated when `requiredCategories` is
   non-empty? (`detection-scorer.ts:68` — the `size > 0` guard.)
3. **Apply:** the monitoring agent starts flagging a `conversion_drop` you didn't
   expect. Which list does it land in, and does it change the score? (`unexpected`;
   it does NOT lower `score` — score is driven by `missed` + count failures, so
   over-flagging shows in the list but not the number. Note that as a design gap.)
4. **Defend:** why does AptKit report three sets + one blended score instead of
   precision and recall ratios?

## See also

- `02-structural-shape-assertions.md` — the binary sibling.
- `01-replay-as-test.md` — produces the detections being scored.
- `study-ai-engineering` — where graded eval becomes the discipline.
- `audit.md` lens 6 (testing AI features, level 3).
