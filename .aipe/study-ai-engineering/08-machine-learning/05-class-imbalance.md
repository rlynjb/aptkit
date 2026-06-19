# When the rare class is the whole point (class imbalance)

**Industry names:** class imbalance, skewed classes, the accuracy paradox, macro-F1 · *Industry standard*

## Zoom out, then zoom in

Anomalies are, by definition, rare. So is fraud, so is churn, so is a defective
part on a line. The thing you most want a classifier to catch is the thing it
sees least. That single fact breaks the most natural metric in the world —
accuracy — and most of this file is about why, and what you reach for instead.
Here's where the concept sits in the supervised pipeline you met in `01`.

```
  Zoom out — where class imbalance bites the pipeline

  ┌─ data ──────────────────────────────────────────────────┐
  │  raw labeled events: 99,000 "normal", 1,000 "anomaly"    │
  └───────────────────────────┬───────────────────────────────┘
                              │ split (03)
  ┌─ train ────────────────────▼──────────────────────────────┐
  │  learner minimizes loss → easiest win is "predict normal"  │
  └───────────────────────────┬───────────────────────────────┘
                              │ evaluate
  ┌─ metric ───────────────────▼──────────────────────────────┐
  │  ★ accuracy says 99% — and it is LYING ←── THIS CONCEPT    │
  │     macro-F1 says 50% — and it is telling the truth        │
  └────────────────────────────────────────────────────────────┘
```

Zoom in: imbalance is not a bug in the data, it is the *nature* of the problem.
You don't fix it by collecting until it's balanced (you can't manufacture rare
events). You fix it on two fronts — the **metric** you trust and the **training
signal** you feed. The pattern is: stop optimizing the majority into the ground,
and start counting the minority as if it mattered as much, because it does.

## Structure pass

**Layers.** Two layers move here. The *measurement* layer (which numbers you
report and believe) and the *training* layer (how you make the learner care
about the rare class). They are independent — you can fix one and forget the
other, and people do, which is how you get a model that scores beautifully on
the wrong metric.

**Axis — trace one example through both layers.** Take one anomaly event in a
99:1 dataset. At the *measurement* layer it contributes 1/100,000th of accuracy
but a full half of macro-F1. At the *training* layer it contributes 1/100th of
the default loss but, under class weighting, as much as 100 normal events. Same
event, wildly different leverage depending on which knob you turned.

**Seams.** The load-bearing seam is the choice of *what gets averaged*.
Micro-averaging (pool every prediction, then score) lets the majority dominate;
macro-averaging (score each class, then average the scores) gives the rare class
an equal vote. That averaging choice is where the truth lives or dies.

## How it works

You already know this shape from software, even if not by this name. Think of a
test suite where 99% of cases are the happy path and 1% are the edge cases that
actually break in production. A suite that's green because it only exercises the
happy path is *exactly* a 99%-accurate model on imbalanced data: the number is
high and it tells you nothing about the cases you care about.

### Move 1 — the mental model

The mental model is a 2×2 box: confusion matrix. Every prediction lands in one
of four cells, and the four cells are not equally cheap to get wrong.

```
  PATTERN — the confusion matrix (binary: anomaly vs normal)

                    │ predicted ANOMALY │ predicted NORMAL │
  ──────────────────┼───────────────────┼──────────────────┤
   actual ANOMALY   │  TP  (caught it)   │  FN (MISSED it)  │ ← the costly miss
  ──────────────────┼───────────────────┼──────────────────┤
   actual NORMAL    │  FP (false alarm)  │  TN (correct)    │
  ──────────────────┴───────────────────┴──────────────────┘

   Accuracy = (TP + TN) / everything
            = swamped by TN when NORMAL is 99% of the data
```

Accuracy adds TP and TN and divides by the total. When TN dwarfs everything, a
model that never predicts anomaly at all (TP = 0, FN = all anomalies) still
scores ~99%. The metric is structurally blind to the cell you care about most:
FN, the missed anomaly.

### Move 2 — the load-bearing skeleton

Two moving parts: *measure honestly*, then *train so the honest measure goes up*.

**Precision and recall — split the question in two.** Accuracy asks one fused
question. Precision and recall ask two separate ones, and the rare class needs
both.

```
  Precision vs recall — two different anxieties

   Precision = TP / (TP + FP)   "of what I FLAGGED, how much was real?"
                                 ↑ punished by false alarms

   Recall    = TP / (TP + FN)   "of what was REAL, how much did I CATCH?"
                                 ↑ punished by misses
```

```
  pseudocode — the two ratios from the matrix
  precision = TP / (TP + FP)        # high → few false alarms
  recall    = TP / (TP + FN)        # high → few misses
  # an all-NORMAL model: recall = 0/(0+FN) = 0.  Caught instantly.
```

The all-negative model has recall 0 on the anomaly class — the metric exposes in
one number what 99% accuracy hid. The two ratios trade off: flag everything and
recall hits 1.0 while precision craters; flag nothing risky and precision climbs
while recall dies.

**Macro-F1 — give the rare class an equal vote.** F1 is the harmonic mean of
precision and recall (harmonic, not arithmetic, so you can't paper over a zero —
if either is 0, F1 is 0). Then you average F1 *per class*.

```
  Macro-F1 — per-class F1, then a flat average

   F1_class = 2 · (P · R) / (P + R)        # one number per class

   F1(normal)  = 0.99   (easy, abundant)
   F1(anomaly) = 0.00   (model never catches it)
                         │
                         ▼  MACRO: average the per-class F1s, unweighted
   macro-F1 = (0.99 + 0.00) / 2 = 0.495    ← the rare class drags it down

   (contrast MICRO-F1: pools all predictions → ≈ 0.99, hides the failure)
```

```
  pseudocode — macro vs micro averaging
  per_class_f1 = [ f1(c) for c in classes ]
  macro_f1 = mean(per_class_f1)            # each class weighs the same
  micro_f1 = f1(pool_all_TP_FP_FN())       # each PREDICTION weighs the same
  # imbalanced data: report macro. micro just re-launders accuracy.
```

Macro-averaging is the seam from the structure pass made concrete: each class
contributes one F1, and the average is flat, so the 1,000-event anomaly class
counts exactly as much as the 99,000-event normal class.

**The training-side fixes — make the learner care.** Honest measurement tells
you the model is bad at the rare class. Three standard levers make it less bad,
each attacking a different part of the loss.

```
  Three fixes, where each one acts

   class weights ──► multiply each example's loss by 1/freq(its class).
                     A rare-class miss now costs ~99× a common-class miss.
                     (No data changes; the LOSS changes.)

   resampling ─────► change the DATA the learner sees:
        oversample minority  → duplicate / synthesize anomaly rows
        undersample majority → drop normal rows
        SMOTE → synthesize NEW minority points by interpolating between
                an anomaly and its nearest anomaly neighbors (not copies)

   focal loss ─────► down-weight EASY examples (ones already classified
                     confidently) so gradient attention flows to the hard,
                     usually-minority cases.  loss ·= (1 − p_correct)^γ
```

```
  pseudocode — the three levers
  # 1. class weights (cheapest, try first)
  loss_i = base_loss_i * (total / (n_classes * count[class_i]))

  # 2. SMOTE (synthesize, don't duplicate — duplicates overfit)
  for each minority point x:
      nn = random nearest minority neighbor of x
      x_new = x + rand(0,1) * (nn - x)      # a point on the segment between

  # 3. focal loss (let γ tune how hard "hard" must be)
  focal_i = (1 - p_correct_i) ** gamma * cross_entropy_i
```

Class weights are the cheap first move — no data surgery, just reweight the loss.
SMOTE is the data move — synthesize plausible new minority points rather than
copy existing ones (copies just teach the model those exact rows). Focal loss is
the gradient move — born in object detection, where a million easy background
boxes drown out the few real objects, the same shape as a million normal events
drowning out the anomalies.

### Move 3 — the principle

Imbalance is solved on two fronts that must agree. Measure with macro-F1 (or
per-class precision/recall) so the rare class has an equal vote; train with
weights, resampling, or focal loss so the learner spends its effort where the
cost is. Pick a metric that can be fooled by predicting the majority, and no
training fix can save you — you'll optimize the model straight into the lie.

## Primary diagram

The full path: from the matrix, through the two honest ratios, to macro-F1, with
the three training fixes feeding back into the model.

```
  Class imbalance — full recap

   labeled data (99 normal : 1 anomaly)
         │
         ▼
   model predictions ──► CONFUSION MATRIX ──┬─ TP ─┬─ FP
                                            ├─ FN ─┴─ TN
         │                                  │
         │                ┌─────────────────┴─────────────────┐
         ▼                ▼                                   ▼
   accuracy = (TP+TN)/all          precision = TP/(TP+FP)   recall = TP/(TP+FN)
   ✗ LIES at 99%                        │                      │
                                        └────────┬─────────────┘
                                                 ▼
                                   F1 per class = 2PR/(P+R)
                                                 ▼
                                   ★ MACRO-F1 = flat avg of per-class F1
                                                 │
                            ┌────────────────────┘
                            ▼  if macro-F1 low, attack the training signal:
            ┌───────────────┼────────────────┐
            ▼               ▼                 ▼
       class weights    resample / SMOTE   focal loss
       (reweight loss)  (reshape data)     (down-weight easy)
            └───────────────┴────────────────┘
                            │ retrain
                            ▼ (loop until macro-F1 acceptable)
                       better minority recall
```

## Implementation in codebase

**Not yet implemented in AptKit — AptKit ships no trained model**, so there is no
class balance to tune, no loss to reweight, and no SMOTE to run. The nearest
honest analog: the anomaly-monitoring agent
(`packages/agents/anomaly-monitoring/src/monitoring-agent.ts`) is the place where
the *rare class is the whole point* — its job is to surface the anomaly, the
minority event — but it is an LLM driven by hand-authored thresholds over ~10
ecommerce categories (`packages/agents/anomaly-monitoring/src/categories.ts`),
with no learned decision boundary and no training distribution to be imbalanced.
The one buildable slice lives in `packages/evals/`, where
`detection-scorer.ts` already counts matched / missed / unexpected detections —
exactly the TP / FN / FP cells a macro-F1 would average over.

## Elaborate

The "accuracy paradox" is old folklore made rigorous; precision/recall come from
information retrieval, and F1 is van Rijsbergen's harmonic mean of the two.
SMOTE (Chawla et al., 2002) is the canonical synthetic-oversampling paper. Focal
loss (Lin et al., 2017, "RetinaNet") came out of dense object detection, where
the foreground/background imbalance is brutal — the same shape as anomaly vs
normal, which is why it transfers.

You touched the supervised-pipeline shape once, on-device, doing CV pose
landmarking with MediaPipe — that pipeline didn't fight class imbalance because
landmark regression isn't a rare-class problem, but the moment you frame *"is
this pose a fall?"* as a classifier, this whole file lands on you.

Read-next: `08-confusion-matrices.md` (the matrix as an artifact you actually
build over the anomaly agent), `09-calibration.md` (a model can have good recall
and still output untrustworthy probabilities), `15-drift-detection.md` (label
shift can *change* your class balance after deployment).

## Project exercises

*Provenance: Phase 2C — Machine learning (C2C.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case B — the concept is new ground; a real
training pipeline in AptKit is a large stretch, so this is a measurable
thought-experiment with one landable deliverable.*

### Exercise — macro-F1 over labeled anomaly-agent runs

- **Exercise ID:** `[C2C.5]` Phase 2C, class-imbalance concept
- **What to build:** Treat the anomaly-monitoring agent as a multi-class
  classifier over its ~10 categories. Hand-label a small set of replay runs with
  the categories that *should* fire, then compute per-category precision, recall,
  and the macro-F1 over those runs. Write up, as a one-paragraph thought
  experiment, what you'd change if you replaced the LLM with a trained classifier
  on imbalanced ecommerce events (which lever — weights, SMOTE, focal — and why).
- **Why it earns its place:** Having actually computed a macro-F1 over real
  detections — and being able to say why micro would lie here — is rare among
  LLM-application engineers and is the exact thing interviewers probe.
- **Files to touch:** `packages/evals/src/detection-scorer.ts` (extend the
  matched/missed/unexpected counts into per-category P/R/F1), a new test in
  `packages/evals/test/`, and a small labeled-fixture set under
  `packages/evals/`. A real training pipeline does *not* belong here — AptKit is
  not the natural home for a training loop; keep that part on paper.
- **Done when:** A test computes macro-F1 from a labeled fixture and asserts it
  against a known value, and the write-up names the imbalance lever you'd pick.
- **Estimated effort:** `4–8hr`

## Interview defense

**Q: Your model is 99% accurate on fraud detection. Are you happy?**

```
   "99% accurate"  ──►  all-NORMAL model also scores 99%
                        recall(fraud) = 0/(0+FN) = 0  ← the tell
```

"No — at 99% prevalence of the negative class, a model that predicts 'not fraud'
every time scores 99% and catches zero fraud. I'd ignore accuracy and look at
recall on the positive class and the macro-F1. Accuracy is structurally blind to
the false-negative cell, which is the only cell I care about here."
*Anchor: high accuracy on imbalanced data is the symptom, not the success.*

**Q: Macro-F1 is low because recall on the rare class is near zero. What do you
try?**

```
   cheap → costly
   class weights ──► resample/SMOTE ──► focal loss
   (reweight loss)   (reshape data)     (down-weight easy)
```

"Cheapest first: class weights, so a rare-class miss costs proportionally more in
the loss. If that's not enough, SMOTE to synthesize minority points — synthesize,
not duplicate, because duplicates just overfit those exact rows. If easy
negatives still dominate the gradient, focal loss to down-weight the confident,
easy cases. And I'd re-evaluate on macro-F1 after each, not accuracy."
*Anchor: fix the metric you trust first, then make that metric go up.*

## Validate

- **Reconstruct:** From memory, draw the 2×2 confusion matrix and write accuracy,
  precision, recall, and F1 from its cells. Then show why the all-negative model
  scores ~99% accuracy but 0 recall on the positive class.
- **Explain:** Why macro-F1 and not micro-F1 on imbalanced data? (Micro pools all
  predictions, so the majority class dominates and the number re-launders
  accuracy; macro averages per-class F1, giving the rare class an equal vote.)
- **Apply:** Pick two anomaly categories from
  `packages/agents/anomaly-monitoring/src/categories.ts` (e.g. `fraud`,
  `revenue_drop`). For a hand-labeled run set, write out which detections land in
  TP / FP / FN and compute the per-category F1.
- **Defend:** Why SMOTE over plain duplication of minority rows? (Duplicates add
  no new information and push the model to overfit those exact points; SMOTE
  interpolates new plausible points between minority neighbors, widening the
  minority region the model learns.)

## See also

- [08-confusion-matrices.md](08-confusion-matrices.md) — the matrix as a built artifact over the anomaly agent
- [09-calibration.md](09-calibration.md) — good recall ≠ trustworthy probabilities
- [04-model-selection.md](04-model-selection.md) — which learner before which loss
- [15-drift-detection.md](15-drift-detection.md) — label shift can move your class balance in prod
- [README.md](README.md) — the honest banner for this whole section
