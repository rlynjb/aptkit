# Class imbalance

**Subtitle:** when one class dwarfs the other and accuracy stops meaning anything · *Language-agnostic*

## Zoom out, then zoom in

aptkit has no trained classifier, so the layers below are the *generic*
supervised pipeline again — but this file only cares about two boxes: the
**model** that emits predictions and the **metric** that grades them. The
starred box is where imbalance bites. It does not corrupt your data or your
features; it quietly poisons the *score you read off the test set*, so a useless
model looks excellent.

```
  Zoom out — where imbalance bites (generic pipeline; aptkit has none)

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  raw rows + LABELS — but 99% are class 0, 1% are class 1        │ ◄ skew starts here
  └───────────────────────────┬─────────────────────────────────────┘
                              │ features
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  numeric X, label vector y (still 99:1)                         │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ split (stratified, file 03)
  ┌─ Split layer ─────────────▼─────────────────────────────────────┐
  │  train · val · test  (each must keep the 99:1 ratio)            │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit + score
  ┌─ Model + Metric layer ────▼─────────────────────────────────────┐
  │  ★ f(X) → ŷ, graded by a metric ★  ACCURACY LIES HERE           │ ◄ the trap
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. The danger is not exotic. A model that learns *nothing* and predicts
the majority class for every row scores 99% accuracy on 99:1 data — and catches
zero of the cases you actually built it for. The fix is never a fancier model
first; it's a metric that can't be fooled, then a handful of training-time
levers. An LLM person meets this the moment they grade retrieval: one relevant
doc against a corpus of thousands is the same 1:N skew.

## Structure pass

**Layers.** Data → features → split → model → metric. Imbalance is born in the
data layer (the class ratio), travels untouched through features and split, and
detonates at the metric layer. Every layer must *preserve* the ratio honestly
(stratified split) so the test score reflects production.

**Axis — where does the metric lie?** Trace what a single number hides. Accuracy
aggregates over all rows, so it is dominated by the majority class — it answers
"how often am I right?" when the question you actually have is "how many of the
rare cases did I catch, and at what cost in false alarms?" Per-class recall and
per-class precision refuse to aggregate; macro-F1 averages the classes *equally*
instead of by population. The axis is **does this metric weight by row count
(lies under skew) or by class (survives skew)?**

**Seam.** The load-bearing boundary is the **decision threshold** — the line
that turns a continuous score `p ∈ [0,1]` into a hard label. Defaulting it to
`0.5` is an unexamined choice. Above the seam: your model emits calibrated-ish
probabilities. Below it: a business decision about how many false positives a
true positive is worth. On imbalanced data, `0.5` is almost always the wrong
line, and moving it (on validation data, never test) is the cheapest lever you
have.

## How it works

### Move 1 — the mental model

You already grade retrieval in this repo, and you already refuse to use accuracy
for it. `scorePrecisionAtK` and `scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts`) never divide by the corpus size — they
divide by `min(k, retrieved)` and by `|relevantIds|`. That is not an accident.
A query has *one* relevant doc against thousands of irrelevant ones; "accuracy
over the corpus" would be 99.9%+ for a retriever that returns garbage, because
it gets all the irrelevant docs "right" by leaving them out. Classification on a
99:1 dataset is the identical problem wearing different clothes.

```
  Pattern — the same 1:N skew, two surfaces

  RETRIEVAL                          CLASSIFICATION
  1 relevant doc                     1% positive class
  ───────────────                    ────────────────
  ╔═══╗ · · · · · · · · ·            ╔═╗ · · · · · · · · ·
  ║ ★ ║ thousands irrelevant         ║+║ 99 negatives
  ╚═══╝ · · · · · · · · ·            ╚═╝ · · · · · · · · ·
        │                                  │
        ▼ accuracy over all = ~99.9%       ▼ accuracy over all = ~99%
        ▼ and MEANINGLESS                  ▼ and MEANINGLESS
  use precision@k / recall@k         use macro-F1 / per-class recall / PR-AUC
   (graded on the rare set)           (graded per class, not per row)
```

You don't *write* a new metric for the classifier. You reach for the same family
the retrieval evals already use: ones that score the rare class on its own terms.

### Move 2 — accuracy lies, and what to use instead

**Part A — watch accuracy lie.** Take a fraud detector: 10,000 transactions, 100
fraudulent. A model that predicts "not fraud" for *everything* — a constant
function, zero learning — produces this confusion matrix:

```
  Confusion matrix — the "predict all negative" model

                 predicted
                 neg        pos
              ┌──────────┬──────────┐
   actual neg │  9 900   │     0    │  ← TN          (all correct, for free)
              │  (TN)    │   (FP)   │
              ├──────────┼──────────┤
   actual pos │    100   │     0    │  ← FN          (every fraud MISSED)
              │  (FN)    │   (TP)   │
              └──────────┴──────────┘

   accuracy = (TN + TP) / total = (9900 + 0) / 10000 = 99.0%   ← looks great
   recall(pos) = TP / (TP + FN)  = 0 / 100            = 0.0%   ← catches nothing
```

99% accuracy, zero fraud caught. The single aggregate number is not just
optimistic — it is actively pointing the wrong way. Optimize accuracy and the
trainer will *converge toward this exact degenerate model*, because predicting
the majority is the fastest way to be "right" most of the time.

**Part B — the metrics that survive skew.** Compute them per class and refuse to
collapse them into one population-weighted average.

```
  The imbalance-aware metric stack

  per-class precision  =  TP / (TP + FP)   "of what I flagged, how much was real?"
  per-class recall     =  TP / (TP + FN)   "of what was real, how much did I catch?"
            │
            ▼  harmonic mean, PER CLASS
  F1(class) = 2 · (P · R) / (P + R)
            │
            ▼  average the CLASSES equally (not the rows)
  macro-F1  = mean( F1(neg), F1(pos) )     ← the degenerate model scores LOW here
            │
            ▼  sweep the threshold across [0,1], plot P vs R, area under
  PR-AUC    = threshold-independent quality on the RARE class
```

Annotated pseudocode — note macro-F1 averages classes, so the rare class can no
longer hide behind the common one:

```
  # PSEUDOCODE — not aptkit code; study ground only
  def macro_f1(y_true, y_pred):
      scores = []
      for c in classes(y_true):          # treat EACH class as "the positive"
          tp = count(y_true == c and y_pred == c)
          fp = count(y_true != c and y_pred == c)
          fn = count(y_true == c and y_pred != c)
          p  = tp / (tp + fp)            # precision for class c
          r  = tp / (tp + fn)            # recall for class c
          scores.append(2 * p * r / (p + r))
      return mean(scores)                # ← classes weighted EQUALLY, ratio ignored
```

Prefer **PR-AUC over ROC-AUC** under heavy skew: ROC's x-axis (false-positive
rate) has a giant denominator of negatives, so it stays flattering even when the
positive class is a disaster. PR-AUC puts the rare class on both axes and tells
the truth.

**Part C — the four mitigations, at training time.** Once the metric is honest,
these are the levers. Each changes a different part of the pipeline.

```
  Where each mitigation acts

  ┌─ data ──────────────┐   ┌─ loss / fit ───────────┐   ┌─ decision seam ──┐
  │ RESAMPLE            │   │ CLASS WEIGHTS          │   │ THRESHOLD TUNE   │
  │ • oversample minor  │   │ • penalize rare-class  │   │ • move off 0.5   │
  │ • undersample major │   │   errors heavier       │   │   using VAL data │
  │ • SMOTE: synthesize │   │ FOCAL LOSS             │   │ • pick point on  │
  │   new minority pts  │   │ • down-weight easy     │   │   the P–R curve  │
  │   between neighbors │   │   negatives, focus on  │   │   you can defend │
  │                     │   │   hard / rare cases    │   │                  │
  └─────────────────────┘   └────────────────────────┘   └──────────────────┘
       acts on y ratio          acts on the gradient          acts on ŷ cutoff
```

- **Class weights** — tell the loss that one positive error costs as much as ~99
  negative errors. One line in most libraries (`class_weight="balanced"`); the
  fit still sees all data, just values the rare class more.
- **Resampling** — oversample the minority (duplicate or **SMOTE**: synthesize
  new minority points by interpolating between near neighbors), or undersample
  the majority (throw away common rows). Do this on **train only**, *after* the
  split — resampling before splitting leaks synthetic neighbors into test.
- **Focal loss** — reshapes the loss to down-weight easy, confidently-correct
  majority examples so the gradient is dominated by the hard, rare ones.
- **Threshold tuning** — leave the model alone; move the `0.5` cutoff. Pick the
  threshold that hits your target recall on the **validation** set, then report
  on test. This is the seam from the Structure pass.

Annotated threshold-tuning pseudocode:

```
  # PSEUDOCODE — not aptkit code; study ground only
  probs = model.predict_proba(X_val)[:, POSITIVE]   # continuous scores, not labels
  best_t = 0.5
  for t in arange(0.01, 0.99, 0.01):                # sweep on VALIDATION, never test
      preds = probs >= t
      if recall(y_val, preds) >= TARGET_RECALL:      # business floor, e.g. catch 90%
          best_t = t                                 # then take the highest-precision t
  # freeze best_t; apply it to test/prod. 0.5 was never sacred.
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study
ground. The closest real artifact is the eval layer: `scorePrecisionAtK` /
`scoreRecallAtK` (`packages/evals/src/precision-at-k.ts`) and `scoreDetections`
(`packages/evals/src/detection-scorer.ts`) already grade an inherently
imbalanced surface — retrieval and detection — with imbalance-aware metrics
rather than accuracy. They are the same medicine, applied to LLM outputs instead
of a fitted `f`.

### Move 3 — the principle

On imbalanced data, **the metric is the product decision.** Pick the metric
before the model: aggregate metrics (accuracy, ROC-AUC) flatter the majority and
will steer training toward a model that ignores the class you care about. Choose
per-class recall, macro-F1, and PR-AUC; then reach for weights, resampling, focal
loss, and a tuned threshold — in that order of cheapness. A learned reranker is
imbalanced *by construction* (one relevant doc per query), which is exactly why
aptkit grades retrieval with precision@k / recall@k and never with "accuracy."

## Primary diagram

The whole trap and its escape, on one surface:

```
  Imbalanced classification — the lie and the fix

  99:1 data ─► fit ─► f(X)=p ─┬─► [ p ≥ 0.5 ? ] ─► ŷ
                              │        ▲
                              │        └── THE SEAM: move this line on val data
                              ▼
                     ┌─────────────────────────────┐
            grade by │  ✗ accuracy   → 99%, LIES    │  weights by ROW count
                     │  ✓ recall(pos)→ catches rare │  per CLASS
                     │  ✓ macro-F1   → classes even │  per CLASS
                     │  ✓ PR-AUC     → rare on both  │  threshold-free
                     └─────────────────────────────┘  axes
                              │
   levers (cheap → costly):   ▼
   threshold tune ─► class weights ─► focal loss ─► resample / SMOTE
```

## Elaborate

The hard-won lesson: imbalance is a *metric and objective* problem before it is a
*data* problem. Teams reflexively reach for SMOTE first; the higher-leverage
moves are usually (1) stop reading accuracy, and (2) move the threshold. Two
subtleties trip people. First, **stratify the split** — if your test set happens
to draw few or zero positives, every per-class number becomes noise; keep the
99:1 ratio in each fold. Second, **resample inside the training fold only** —
SMOTE before the split synthesizes minority points whose neighbors land in test,
which is leakage that inflates the score exactly the way file 03 warns about.
And calibrate before you tune a threshold: if `p` isn't a real probability,
`p ≥ t` is comparing against a meaningless scale. The retrieval evals sidestep
all of this by never having a threshold-at-0.5 in the first place — they score
the rare set directly.

## Project exercises

### Prove accuracy lies on the reranker's labeled data
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that loads a labeled `(query_id, doc_id,
  is_relevant)` dataset built from buffr retrieval, then prints two scorecards
  for a baseline that labels *every* candidate "not relevant": plain accuracy
  vs. per-class recall + macro-F1. Show accuracy near 99% while positive recall
  is 0.
- **Why it earns its place:** makes the central lie concrete on *your* data, not
  a textbook toy — the fastest way to internalize why this section exists.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/imbalance-demo.ts`,
  reading `/Users/rein/Public/buffr/eval/queries.json` and
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** the script prints both scorecards and a one-line note that the
  high-accuracy baseline caught zero relevant docs.
- **Estimated effort:** `1–4hr`

### Tune the decision threshold for a learned intent classifier
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a design note + threshold-sweep pseudocode for a learned
  replacement of `packages/agents/query/src/intent.ts`, treating the rarest
  intent as the positive class. Define a target recall, sweep the threshold on a
  held-out validation slice, and pick the highest-precision threshold that meets
  it — annotated, no training required.
- **Why it earns its place:** moves the conversation from "the model" to "the
  decision seam," which is the senior framing for any imbalanced classifier.
- **Files to touch:** new
  `/Users/rein/Public/buffr/docs/intent-threshold-tuning.md`, referencing
  `/Users/rein/Public/aptkit/packages/agents/query/src/intent.ts`.
- **Done when:** the note states the target recall, shows the val-only sweep, and
  explains why `0.5` is rejected.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "A model reports 99% accuracy on a fraud dataset. Are you impressed?"**
No — that is the number a model gets for free on 99:1 data by predicting "not
fraud" for everything, catching zero fraud. I'd ask for per-class recall, macro-F1,
and the PR-AUC, because those grade the rare class on its own terms instead of
letting it hide behind the majority.

```
  predict-all-negative:  accuracy 99%  │  recall(fraud) 0%
                         ↑ lies        │  ↑ the number that matters
```
*Anchor: accuracy weights by row count, so the majority class drowns the metric.*

**Q: "Your recall on the positive class is too low. What do you change, and in
what order?"**
Cheapest first: move the decision threshold off `0.5` using validation data —
no retraining. If that's not enough, add class weights so rare-class errors cost
more, then focal loss, then resampling/SMOTE on the training fold only. I tune
the threshold on val and report on test, and I never resample before the split.

```
  threshold ─► class weights ─► focal loss ─► SMOTE (train fold only)
   no retrain                                  ↑ leakage risk if done pre-split
```
*Anchor: the threshold is a business seam, not a constant — `0.5` is a default, not a law.*

## See also

- `08-confusion-matrices.md` — TP/FP/FN/TN and the metrics derived from them
- `01-supervised-pipeline.md` — the arc this metric layer sits at the end of
- `03-train-val-test.md` — stratified splits, and why resampling happens after the split
- `05-evals-and-observability/` — how aptkit grades imbalanced surfaces today
