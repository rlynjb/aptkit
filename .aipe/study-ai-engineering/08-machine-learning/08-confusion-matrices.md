# Confusion matrices

> Industry name: **confusion matrix** · type: classifier evaluation primitive · **the one file in this sub-section that touches real aptkit code**

Every other file here is new ground — aptkit trains no model. This one is different. The confusion matrix is the parent of a metric aptkit already ships: `scorePrecisionAtK`. So we'll teach the matrix straight, then show you the real `precision-at-k.ts` and prove that precision@k is the ranked-retrieval cousin of classifier precision. Same instinct, different denominator.

## Zoom out, then zoom in

★ A classifier emits a prediction; the confusion matrix is where you find out what that prediction was *worth*. It sits at the very end of the pipeline — after the model has scored every example — and it's the only place per-class truth lives. Accuracy is a single number that hides the matrix; the matrix is the number with its lies removed.

```
Generic supervised-ML pipeline — where the confusion matrix lives
┌──────────┐   ┌───────────┐   ┌──────────────┐   ┌────────┐   ┌─────────────────────┐
│  Data    │ → │ Features  │ → │ Train/Val/   │ → │ Model  │ → │ EVALUATION          │
│ (labeled │   │ (engineer)│   │ Test (split) │   │ (fit)  │   │  ★ confusion matrix │
│  rows)   │   │           │   │              │   │        │   │  → precision/recall │
└──────────┘   └───────────┘   └──────────────┘   └────────┘   └─────────────────────┘
                                                                          │
                                                                          ▼
                                                          per-class precision · recall · F1
```

The matrix is downstream of everything. A great model with a misread matrix ships a bad decision threshold; a mediocre model with a well-read matrix ships honestly.

## Structure pass

One axis: **predicted vs actual**, crossed. For binary classification that's a 2×2 grid; for N classes it's N×N. The seams:

- **Rows = actual class** (ground truth). **Columns = predicted class** (what the model said).
- **Diagonal = correct** (predicted == actual). **Off-diagonal = errors**, and *which* off-diagonal cell tells you the *kind* of error.
- The four named cells of the binary case — **TP, FP, FN, TN** — are the atoms every downstream metric is built from. Precision and recall are just two different ratios over those atoms.

## How it works

### Move 1 — the mental model

The matrix is a **sorting tray**. Every test example drops into exactly one cell, sorted by (what it really was, what you guessed). Once everything is sorted, you read ratios off the tray.

```
Binary confusion matrix — the sorting tray
                    PREDICTED
                 │  Positive  │  Negative  │
        ─────────┼────────────┼────────────┤
  A   Positive   │    TP      │    FN      │  ← actual positives
  C              │ (caught)   │ (missed)   │
  T   ───────────┼────────────┼────────────┤
  U   Negative   │    FP      │    TN      │  ← actual negatives
  A              │ (false     │ (correct   │
  L              │  alarm)    │  reject)   │
        ─────────┴────────────┴────────────┘
                 ↑ flagged    ↑ not flagged

  precision = TP / (TP + FP)   "of what I flagged, how much was right"
  recall    = TP / (TP + FN)   "of what was really there, how much did I catch"
  F1        = 2·P·R / (P + R)  "harmonic mean — punishes a lopsided pair"
```

Precision lives in the **left column** (everything you flagged positive). Recall lives in the **top row** (everything that truly was positive). They share TP and pull in opposite directions: flag more aggressively and recall climbs while precision usually drops.

### Move 2 — step by step, and the aptkit bridge

**Part A — reading per-class precision/recall off an N×N matrix.** For multi-class, you read one class at a time by collapsing to "this class vs everything else." For class *i*: precision = matrix[i][i] / (sum of column i); recall = matrix[i][i] / (sum of row i).

```
3-class matrix — reading class "squat" (per-class collapse)
                  PREDICTED
              │ squat │ lunge │ idle │  row sum
   ───────────┼───────┼───────┼──────┤
A   squat     │  40 ★ │   5   │   5  │   50   ← recall denom (row)
C   lunge     │   8   │  30   │   2  │   40
T   idle      │  12   │   3   │  85  │  100
U   ───────────┼───────┼───────┼──────┤
A   col sum    │  60 ↑ │  38   │  92  │
L              precision denom (col)

  squat precision = 40 / 60 = 0.67   (20 non-squats sneaked into the squat column)
  squat recall    = 40 / 50 = 0.80   (10 real squats leaked to lunge/idle)
  squat F1        = 2·0.67·0.80 / (0.67+0.80) ≈ 0.73
```

The off-diagonal *direction* is diagnostic: 12 idles predicted as squats means your "squat" boundary is grabbing rest poses — a threshold or feature problem, not a global "accuracy" problem.

**Part B — the bridge: precision@k is classifier precision over a ranked list.** A ranked retriever doesn't emit TP/FP per row; it emits an *ordered* list and you keep the top *k*. But the question is identical: *of the k things I surfaced, how many were right?* That's precision with the denominator pinned to k. aptkit ships exactly this. Real code:

```ts
// packages/evals/src/precision-at-k.ts  — Case A: this metric EXISTS in aptkit

// scorePrecisionAtK, lines 47-57
export function scorePrecisionAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = Math.min(k, retrievedIds.length); // ← denominator = what you FLAGGED (top-k)
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k); // ← TP among the flagged
  return { ok: true, score: matched / total, matched, total }; // ← matched/total == TP/(TP+FP)
}

// scoreRecallAtK, lines 68-78
export function scoreRecallAtK(
  retrievedIds: readonly string[],
  relevantIds: ReadonlySet<string>,
  k: number,
): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = relevantIds.size; // ← denominator = ALL that was truly relevant (TP+FN)
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k);
  return { ok: true, score: matched / total, matched, total }; // ← matched/total == TP/(TP+FN)
}
```

Line up the denominators with the tray above and the equivalence is exact:

```
The bridge — same atoms, swapped denominator
   classifier precision        precision@k (precision-at-k.ts:53,56)
   ┌────────────────────┐      ┌──────────────────────────────────┐
   │ TP / (TP + FP)      │  ≡   │ matched / min(k, retrieved.len)   │
   │ "of flagged, right" │      │ "of top-k surfaced, relevant"     │
   └────────────────────┘      └──────────────────────────────────┘

   classifier recall            recall@k (precision-at-k.ts:74,76)
   ┌────────────────────┐      ┌──────────────────────────────────┐
   │ TP / (TP + FN)      │  ≡   │ matched / |relevantIds|           │
   │ "of real, caught"   │      │ "of all relevant, surfaced"       │
   └────────────────────┘      └──────────────────────────────────┘

   matched  == TP         (countDistinctHits, lines 27-34)
   min(k,…)  == TP + FP    (the top-k window IS the flagged set)
   |relevant|== TP + FN    (the full relevant set IS the actual positives)
```

aptkit's `total = Math.min(k, retrievedIds.length)` is precision's "don't penalize a short list" guard — the same reason you never divide precision by a denominator that includes rows you never flagged. And `ok: false` on a zero denominator is the matrix's own degenerate case: an empty column has no precision to report.

So: the *confusion matrix itself* is **not yet exercised in aptkit** — there is no learned classifier emitting per-class cells. But its two most-used ratios already live in `precision-at-k.ts`, evaluating ranked retrieval. The exercise below closes the gap by giving aptkit a real confusion-matrix scorer alongside the precision@k one.

### Move 3 — the principle

**Never report a single accuracy number for a multi-class or imbalanced problem.** The matrix is the source of truth; precision, recall, and F1 are *views* of it. Pick the view that matches the cost of the error you actually fear — and notice that aptkit already chose its view (precision@k vs recall@k) for retrieval. A classifier deserves the same deliberate choice.

## Primary diagram

```
From matrix to decision — the full read
   ┌─────────────────────────────────────────────────────────────┐
   │ 1. Build N×N tray: sort every test example by (actual, pred)  │
   └───────────────────────────┬─────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ 2. Per class i:  precision = M[i][i]/colSum(i)                 │
   │                  recall    = M[i][i]/rowSum(i)                 │
   │                  F1        = 2PR/(P+R)                         │
   └───────────────────────────┬─────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ 3. Aggregate:  macro-F1 = mean of per-class F1 (each class    │
   │                equal weight → exposes the rare-class failure) │
   └───────────────────────────┬─────────────────────────────────┘
                               ▼
   ┌─────────────────────────────────────────────────────────────┐
   │ 4. Read the OFF-DIAGONAL: which class is eating which?        │
   │    → that cell names the fix (threshold / feature / data)     │
   └───────────────────────────────────────────────────────────────┘

   aptkit today: step 2's precision/recall already shipped for RANKED lists
   in precision-at-k.ts. The N×N tray (steps 1,3,4) is the new ground.
```

## Elaborate

A few things that bite people:

- **Macro vs micro.** Macro-F1 averages per-class F1 with equal weight, so a rare class can't hide behind a common one — this is the metric you want the moment classes are imbalanced (see `05-class-imbalance.md`). Micro-F1 pools all TP/FP/FN first and effectively reweights by frequency, so it tracks accuracy and *re-hides* the rare class. Default to macro when you care about every class.
- **The matrix is threshold-dependent.** A 2×2 matrix is a snapshot at one decision threshold. Move the threshold and every cell moves. That's why calibration (`09-calibration.md`) and threshold tuning matter: the matrix you report should be at the threshold you'll actually deploy.
- **aptkit's `RetrievalScoreResult.ok` is the lesson generalized.** It separates "metric is undefined" (zero denominator) from "metric is 0" (you flagged things, none were right). A confusion-matrix scorer needs the same discipline: an empty column is *undefined* precision, not *zero* precision. Most naive implementations collapse the two and report 0, which silently poisons macro-F1.
- **In contrl terms** (prose only — different repo): the rep counter's "is this frame a squat-bottom?" decision is exactly a per-class confusion problem. A false positive double-counts a rep; a false negative drops one. Reading *that* matrix per movement is how you'd find which pose the on-device classifier confuses, rather than trusting one accuracy figure across all movements.

## Project exercises

### Per-class F1 + confusion-matrix scorer (Phase 3 ML evals)

- **Exercise ID:** `EX-ML-08a`
- **What to build:** A `scoreConfusionMatrix(predicted, actual, classes)` function that returns the N×N matrix plus per-class precision/recall/F1 and macro-F1, mirroring the `RetrievalScoreResult` shape (`ok`/`score`/per-cell counts) so it sits naturally beside `scorePrecisionAtK`.
- **Why it earns its place:** It turns the precision@k bridge into a first-class classifier scorer and gives aptkit the one ML-eval primitive every downstream concept (imbalance, calibration, drift) reads from. It's the smallest real step from "ranked retrieval metric" to "learned classifier metric."
- **Files to touch:** Case B (new): `packages/evals/src/confusion-matrix.ts`; export it from `packages/evals/src/index.ts`; test in `packages/evals/src/confusion-matrix.test.ts`. Reuse `RetrievalScoreResult`'s `ok` convention from the existing `precision-at-k.ts`.
- **Done when:** A 3-class fixture produces correct per-class precision/recall/F1 and macro-F1; an empty column yields `ok: false` (undefined, not 0); macro-F1 excludes undefined classes rather than treating them as 0.
- **Estimated effort:** `1–4hr`

### Ranked-classifier eval: precision@k *per class* (Phase 3 ML evals)

- **Exercise ID:** `EX-ML-08b`
- **What to build:** A thin adapter that takes a multi-class ranker's top-k output and computes per-class precision@k/recall@k by calling the *existing* `scorePrecisionAtK`/`scoreRecallAtK` once per class, then macro-averages — proving the two scorers compose into a confusion-style report without rewriting them.
- **Why it earns its place:** It demonstrates you understand the bridge isn't a coincidence: the shipped retrieval scorers *are* per-class classifier scorers when you partition by class. Cheap, and it documents the equivalence in code.
- **Files to touch:** Case B (new): `packages/evals/src/per-class-precision-at-k.ts`, importing `scorePrecisionAtK`/`scoreRecallAtK` from the existing `precision-at-k.ts`.
- **Done when:** Per-class scores match the diagonal/row/column ratios of `scoreConfusionMatrix` from `EX-ML-08a` on the same fixture.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Your model reports 94% accuracy. Why won't I let you ship on that number?**

```
   accuracy 94%  ──hides──▶  ┌─────────────────────────┐
                             │ rare class recall = 0.10 │  ← the matrix shows it
                             └─────────────────────────┘
```

Anchor: accuracy is one number summed over the diagonal; the off-diagonal is where the cost lives. I read per-class recall off the confusion matrix — the same way aptkit reports recall@k separately from precision@k instead of one blended score.

**Q: How is precision@k related to the precision you'd read off a confusion matrix?**

```
   TP/(TP+FP)  ≡  matched / min(k, retrieved)   ← precision-at-k.ts:53,55
```

Anchor: identical ratio, the denominator is just "the top-k window" instead of "all flagged rows." aptkit's `scorePrecisionAtK` is classifier precision with the flagged set pinned to k.

**Q: A class has zero predictions. What's its precision?**

```
   column sum = 0  →  precision undefined  →  ok:false (not score 0)
```

Anchor: undefined, not zero — the same distinction `precision-at-k.ts` draws with its `NOT_WELL_FORMED` guard on a zero denominator. Folding it to 0 silently drags macro-F1 down.

## See also

- [05-class-imbalance.md](./05-class-imbalance.md) — why accuracy lies; macro-F1 reads off this matrix.
- [09-calibration.md](./09-calibration.md) — the matrix is threshold-dependent; calibration fixes the threshold honestly.
- [01-supervised-pipeline.md](./01-supervised-pipeline.md) — where evaluation sits in the pipeline.
- [14-training-run-logging.md](./14-training-run-logging.md) — log the confusion matrix per run.
- [README.md](./README.md) — sub-section map and the bridge note.
