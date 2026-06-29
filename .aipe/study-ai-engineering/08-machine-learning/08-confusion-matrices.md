# Reading a confusion matrix

**Subtitle:** rows = true, cols = predicted, diagonal = correct · *Industry standard*

## Zoom out, then zoom in

aptkit has no trained classifier, so the layers diagram below is the *generic*
supervised pipeline. The confusion matrix lives entirely inside the starred
EVAL box — it is the lens you put on the test set after `f` predicts. Everything
above it produces the predictions; the matrix only reads them.

```
  Zoom out — where the confusion matrix sits (generic; aptkit has none)

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  labeled rows: (input, TRUE class y)                           │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ featurize + fit (files 01–04)
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  fitted classifier: f(X) → ŷ  (predicted class)                │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ run on held-out test
  ┌─ Eval layer ──────────────▼─────────────────────────────────────┐
  │  ★ confusion matrix: tally (y, ŷ) pairs into a grid ★          │
  │     ↳ derive precision / recall / F1 per class                 │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. A confusion matrix is not a metric — it is the *raw tally* every
metric is computed from. You run the fitted model on the test set, and for each
example you get a pair: the true class and the predicted class. The matrix is
just a grid counting how often each `(true, predicted)` pair happened. Accuracy,
precision, recall, F1 — all of them are arithmetic on this one grid. Learn to
read the grid and the metrics stop being formulas to memorize.

## Structure pass

**Layers.** Predictions → tally grid → per-class rates → single summary number.
Each layer throws away detail: the grid loses example identity, the rates
collapse a row/column to a fraction, the summary collapses all classes to one
scalar. Read in the *other* direction when debugging — start from the bad
number and walk back to the cell.

**Axis — where does an error land in the matrix?** Every mistake is an
off-diagonal cell. The grid tells you not just *that* you were wrong but *how*:
"true class A predicted as B" is a specific cell. A model with 90% accuracy can
be useless if all its errors cluster in one cell — the matrix shows that;
accuracy alone hides it.

**Seam.** The load-bearing boundary is the **convention**: rows are the truth,
columns are the prediction, the diagonal is correct. Swap the axes and every
formula below inverts (precision becomes recall). aptkit's nearest real artifact
— `scoreDetections` — encodes the same seam without drawing a grid: it returns
`matched` (diagonal), `missed` (a column of misses), `unexpected` (a row of
false alarms).

## How it works

### Move 1 — the mental model

You already have a confusion matrix in this repo — it's just not drawn as a
grid. `scoreDetections` (`packages/evals/src/detection-scorer.ts`) compares a set
of *expected* items against a set of *got* items and returns three buckets:

```
  scoreDetections → {matched, missed, unexpected}   (the confusion, un-gridded)

  expected (truth)        got (prediction)
  ┌──────────┐            ┌──────────┐
  │  A B C   │            │  A   C D │
  └────┬─────┘            └────┬─────┘
       │                       │
       ▼                       ▼
   matched   = A, C   → on the diagonal   (true positives)
   missed    = B      → truth, not got    (false negatives)
   unexpected= D      → got, not truth    (false positives)
```

That is a confusion matrix with the boring cell deleted. `matched` ≈ true
positives, `missed` ≈ false negatives, `unexpected` ≈ false positives. The only
thing missing is the true-negative cell — and for set-style detection there's no
finite "everything you correctly left out," so you drop it. Hold that mapping;
the rest of this file just gives the buckets a grid and a vocabulary.

### Move 2 — building and reading the matrix

**The 2x2 case — one class vs the rest.** Start with a binary classifier: a
learned reranker deciding *relevant* (positive) or *not* (negative) for each
candidate document. Run it on the test set, tally every `(true, predicted)` pair
into a 2x2 grid. Rows are truth, columns are prediction:

```
  Confusion matrix — learned reranker, "is this doc relevant?"  (N = 100)

                      PREDICTED
                  relevant   not
              ┌───────────┬───────────┐
   T  relevant│  TP = 40  │  FN = 10  │   row sum = 50 actually-relevant
   R          ├───────────┼───────────┤
   U  not     │  FP = 15  │  TN = 35  │   row sum = 50 actually-not
   E          └───────────┴───────────┘
                  ▲
                  diagonal (TP, TN) = 75 correct → accuracy = 75/100 = 0.75
```

Read the cells out loud, always *true-then-predicted*:
- **TP = 40** — truly relevant, called relevant. Correct.
- **FN = 10** — truly relevant, called not. A *miss* (you let a good doc slip).
- **FP = 15** — truly not, called relevant. A *false alarm* (you surfaced junk).
- **TN = 35** — truly not, called not. Correct.

**Derive precision.** Precision answers "when the model said *relevant*, how
often was it right?" That is the *predicted-relevant column*: TP over the whole
column.

```
  Precision — read DOWN the predicted-positive column

                  PREDICTED relevant
              ┌───────────┐
   relevant   │  TP = 40  │ ┐
              ├───────────┤ ├─ everything the model CALLED relevant
   not        │  FP = 15  │ ┘
              └───────────┘
   precision = TP / (TP + FP) = 40 / (40 + 15) = 40/55 = 0.73
```

**Derive recall.** Recall answers "of the truly relevant docs, how many did we
catch?" That is the *actually-relevant row*: TP over the whole row.

```
  Recall — read ACROSS the actually-positive row

                  relevant    not
              ┌───────────┬───────────┐
   relevant   │  TP = 40  │  FN = 10  │  ← everything that IS relevant
              └───────────┴───────────┘
   recall = TP / (TP + FN) = 40 / (40 + 10) = 40/50 = 0.80
```

Precision walks a column, recall walks a row, and they share the TP corner.
That shared corner is why you can't read one without fixing the other —
push the threshold to call everything relevant and recall hits 1.0 while
precision collapses.

**Derive F1.** Precision and recall trade off, so you fold them into one number
with the *harmonic* mean — harmonic, not arithmetic, so a model can't game it by
being great at one and terrible at the other.

```
  F1 — harmonic mean punishes imbalance

   F1 = 2 · (precision · recall) / (precision + recall)
      = 2 · (0.73 · 0.80) / (0.73 + 0.80)
      = 2 · 0.584 / 1.53
      = 1.168 / 1.53
      = 0.76

   arithmetic mean would be 0.765 — close here because P and R are close.
   if P = 0.95, R = 0.10:  arithmetic = 0.525   F1 = 0.18  ◄ harmonic exposes it
```

**The multiclass case — the 3-intent classifier.** aptkit's `intent.ts`
(`packages/agents/query/src/intent.ts`) sorts a query into three classes:
`monitoring`, `diagnostic`, `recommendation`. A learned version of that
classifier produces a 3x3 matrix — same rule, rows = true, cols = predicted,
diagonal = correct. Suppose 90 labeled test queries, 30 per true class:

```
  Confusion matrix — learned 3-class intent classifier  (N = 90)

                          PREDICTED
                  monitor  diag   recommend │ row sum (true count)
              ┌─────────┬───────┬───────────┤
   monitor    │   25 ★  │   3   │     2     │   30
   T          ├─────────┼───────┼───────────┤
   R diag     │    4    │  22 ★ │     4     │   30
   U          ├─────────┼───────┼───────────┤
   E recommend│    1    │   6   │    23 ★   │   30
              └─────────┴───────┴───────────┘
   col sum:       30       31        29        = 90
   diagonal (★) = 25 + 22 + 23 = 70 correct → accuracy = 70/90 = 0.78
```

The diagonal is still "correct." Every off-diagonal cell now names a *specific*
confusion — e.g. 6 `recommendation` queries got predicted as `diagnostic` (true
row `recommend`, predicted column `diag`). That single cell is the most
actionable thing in the grid: it tells you exactly which two classes the model
muddles.

**Per-class precision/recall — one class at a time.** For each class, collapse
the 3x3 into a 2x2 "this class vs the rest." Take `diagnostic`:

```
  Per-class for "diagnostic" — its column and its row

   precision_diag = diagonal cell / its COLUMN sum
                  = 22 / (3 + 22 + 6) = 22 / 31 = 0.71
                    (of everything CALLED diagnostic, 71% truly were)

   recall_diag    = diagonal cell / its ROW sum
                  = 22 / (4 + 22 + 4) = 22 / 30 = 0.73
                    (of everything that IS diagnostic, 73% were caught)
```

Do it for all three:

```
  class         precision           recall
  monitor       25/30 = 0.83        25/30 = 0.83
  diagnostic    22/31 = 0.71        22/30 = 0.73
  recommend     23/29 = 0.79        23/30 = 0.77
```

**Macro vs micro average.** You now have three precisions; collapse them to one
number two different ways, and the choice is a *political* one about which class
counts.

```
  Macro — average the per-class rates, every class equal weight

   macro-precision = (0.83 + 0.71 + 0.79) / 3 = 0.78
   macro-recall    = (0.83 + 0.73 + 0.77) / 3 = 0.78
   macro-F1        = harmonic(0.78, 0.78)     ≈ 0.78
     ↳ a tiny rare class counts as much as a huge common one

  Micro — pool all cells first, every EXAMPLE equal weight

   micro = total diagonal / total examples = 70 / 90 = 0.78
     ↳ for single-label multiclass, micro-precision = micro-recall = accuracy
     ↳ dominated by whichever class has the most examples
```

Here the classes are balanced (30 each) so macro ≈ micro. The numbers diverge
the moment classes are imbalanced — which is the whole point of file 05. Reach
for macro when small classes matter (a rare `recommendation` intent you can't
afford to miss); reach for micro when you only care about aggregate hit rate.

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study
ground. The closest real artifacts are `scoreDetections`
(`packages/evals/src/detection-scorer.ts`), whose `matched`/`missed`/`unexpected`
*is* a confusion split into TP/FN/FP, and `scorePrecisionAtK`/`scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts`), the ranked-retrieval cousins of the
precision/recall you just derived.

### Move 3 — the principle

A confusion matrix is the *evidence*; every metric is a *summary* of it.
Summaries lie by omission — accuracy hides which class fails, a single F1 hides
which two classes the model confuses. Always look at the grid before you trust
the scalar, and when a number is bad, walk back to the off-diagonal cell that
produced it. The cell tells you what to fix; the scalar only tells you that
something is broken.

## Primary diagram

```
  From predictions to one number — and what each step discards

  test predictions            tally                 collapse           collapse
  (y, ŷ) pairs                grid                  per class          to scalar
  ┌──────────────┐    ┌──────────────────┐    ┌──────────────┐    ┌──────────┐
  │ (mon, mon)   │    │      PREDICTED   │    │ prec_mon=.83 │    │ macro-F1 │
  │ (diag, rec)  │──► │ T ┌──┬──┬──┐     │──► │ prec_diag=.71│──► │  = 0.78  │
  │ (rec, diag)  │    │ R │25│ 3│ 2│     │    │ rec_diag =.73│    └──────────┘
  │     …        │    │ U ├──┼──┼──┤     │    │     …        │    │     OR
  └──────────────┘    │ E │ 4│22│ 4│ ★   │    └──────────────┘    ┌──────────┐
                      │   ├──┼──┼──┤     │                        │ micro    │
   rows = TRUTH       │   │ 1│ 6│23│     │     diagonal = correct │ = 70/90  │
   cols = PREDICTED   └──────────────────┘     ★ = right answers  │ = 0.78   │
                                                                  └──────────┘
   each → loses        the grid keeps          a fraction per      one weighting
   example identity    full error structure    row & column        choice of "fair"
```

## Elaborate

The hard-won lesson is that the matrix is a *debugging* tool, not a reporting
tool. Teams ship the macro-F1 to a dashboard and never look at the grid — then
miss that 80% of their errors are one class predicted as its neighbor, a fix a
single feature could make. The discipline: when a metric moves, open the matrix
and find the cell that moved with it. The same instinct already exists in this
repo's eval layer — `scoreDetections` hands you `missed` and `unexpected`
separately precisely so you can see *which kind* of error grew, not just that
the score dropped. A confusion matrix is that idea generalized to N classes.
File 05 (class imbalance) is why macro and micro diverge; file 09 (calibration)
is the next question after "is it right?" — namely "does its *confidence* mean
anything?"

## Project exercises

### Build a confusion matrix from scoreDetections output

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a small function that takes the `{matched, missed,
  unexpected}` result from `scoreDetections` and renders it as a labeled 2x2-ish
  grid (TP/FN/FP, with TN marked N/A), then prints derived precision, recall,
  and F1.
- **Why it earns its place:** makes the matched/missed/unexpected → TP/FN/FP
  mapping concrete in code, which is the exact bridge interviewers probe.
- **Files to touch:** `packages/evals/src/detection-scorer.ts` (read only, no
  change), new `packages/evals/test/confusion-from-detections.test.ts`.
- **Done when:** `node --test` passes asserting precision/recall/F1 computed from
  a fixed `{matched, missed, unexpected}` example match hand-calculated values.
- **Estimated effort:** `<1hr`

### Score a 3-class intent classifier into a 3x3 matrix

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that runs `parseIntent`
  (`packages/agents/query/src/intent.ts`) over a small hand-labeled set of
  queries tagged with one of `monitoring`/`diagnostic`/`recommendation`, tallies
  `(true, predicted)` into a 3x3 grid, and reports per-class precision/recall
  plus macro-F1 and micro accuracy.
- **Why it earns its place:** exercises the full multiclass path — building the
  grid, collapsing per class, and choosing macro vs micro — against a real
  aptkit classifier instead of a toy.
- **Files to touch:** `packages/agents/query/src/intent.ts` (read only), new
  `/Users/rein/Public/buffr/eval/intent-confusion.ts` and a small
  `/Users/rein/Public/buffr/eval/intent-labels.json` of `{query, true}` rows.
- **Done when:** the script prints a 3x3 grid whose diagonal sum / total equals
  the printed micro accuracy, and macro-F1 is the harmonic mean of averaged
  per-class precision/recall.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Walk me through reading a confusion matrix and getting precision and
recall out of it."**
Rows are the true class, columns are the predicted class, the diagonal is
correct. For one class: precision is the diagonal cell over its *column* sum
("when I said this class, how often right?"); recall is the diagonal cell over
its *row* sum ("of all that truly are this class, how many did I catch?").
Precision walks a column, recall walks a row, they share the TP corner.

```
              PREDICTED pos
          ┌───────────┐
   pos    │  TP       │ recall = TP / row    (walk →)
          │  FN       │
          └───────────┘
   precision = TP / col (walk ▼)   ── they meet at TP
```
*Anchor: rows = true, cols = predicted; precision is a column, recall is a row.*

**Q: "Macro vs micro F1 — when does it matter and which do you pick?"**
Macro averages the per-class scores so every class counts equally; micro pools
all cells so every *example* counts equally (for single-label multiclass, micro
= accuracy). They agree when classes are balanced and diverge under imbalance.
Pick macro when a rare class matters as much as a common one; pick micro when
you only care about aggregate hit rate.

```
  balanced classes:   macro ≈ micro
  rare class fails:    macro DROPS sharply   ← it weights the rare class fully
                       micro barely moves    ← dominated by the big class
```
*Anchor: macro weights classes equally, micro weights examples equally.*

## See also

- `01-supervised-pipeline.md` — produces the predictions the matrix tallies
- `05-class-imbalance.md` — why macro and micro F1 diverge
- `09-calibration.md` — the next question after "is it right?": "is its
  confidence honest?"
- `05-evals-and-observability/` — how aptkit grades outputs today
  (`scoreDetections`, `scorePrecisionAtK`)
