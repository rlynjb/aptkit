# Class imbalance

> industry name: **class imbalance** · type: **evaluation/training pitfall**

This is the pitfall that has burned more ML engineers than any other, because it doesn't crash, doesn't error, and produces a number that looks *great*. You train a fraud detector, it reports 95% accuracy, you ship it, and it has never once flagged fraud — because 95% of transactions are legit and "always say legit" is a 95%-accurate model that does nothing. Class imbalance is what happens when one class dominates the data, and the trap is trusting accuracy when it's quietly lying to you. New ground: aptkit trains no model and computes no metrics, so this is the playbook, not a code tour.

## Zoom out, then zoom in

Imbalance isn't one stage — it leaks across three. It originates in **Data** (the raw class distribution is skewed), it must be *handled* during **Train** (weights, sampling), and it must be *measured correctly* at evaluation (the val/test read). Miss it at any of the three and the other two can't save you.

Pipeline placement (★ = where imbalance bites)

```
┌──────────┐   ┌────────────┐   ┌─────────────────────┐   ┌──────────────┐   ┌─────────┐
│  Data    │──▶│  Features  │──▶│  Train / Val / Test │──▶│    Model     │──▶│ Deploy  │
│  ★ skew  │   │            │   │   ★ measure right   │   │              │   │         │
│  born    │   │            │   │   ★ handle in train │   │              │   │         │
└──────────┘   └────────────┘   └─────────────────────┘   └──────────────┘   └─────────┘
     │                                    ▲
     │  95% negative / 5% positive        │  the same skew must survive
     └────────────────────────────────────┘  into val/test — never balance test
```

The key insight from the diagram: imbalance is born in Data but is *fought* in Train and *exposed* in evaluation. And critically — you may rebalance the *training* data, but the val/test split must keep the real-world skew, or your reported metric won't predict production.

## Structure pass

Lay it out along one axis — where in the pipeline you intervene — and the seams are clear:

```
  WHERE YOU INTERVENE  ──────────────────────────────────────────────────────▶

  ┌───────────────────┐  seam A  ┌───────────────────┐  seam B  ┌────────────────────┐
  │ DATA-LEVEL        │          │ TRAINING-LEVEL    │          │ DECISION-LEVEL     │
  │ oversample,       │          │ class weights,    │          │ threshold tuning   │
  │ undersample,      │          │ focal loss        │          │ (move the cutoff)  │
  │ SMOTE             │          │                   │          │                    │
  └───────────────────┘          └───────────────────┘          └────────────────────┘
    changes the data              changes the loss               changes the readout
    (risk: overfit copies)        (no new data needed)           (cheapest, post-hoc)
```

- **Seam A** separates "make the data look balanced" from "tell the loss function to care more about the rare class." Data-level changes the inputs; training-level changes the objective.
- **Seam B** separates training from the decision threshold. Threshold tuning is the cheapest intervention and the one people forget — you don't always need a new model, sometimes you just move the cutoff from 0.5 to 0.2.

These compose. You can class-weight *and* threshold-tune. But the first thing to fix isn't any of these — it's the *metric*, because a wrong metric hides whether anything you did worked.

## How it works

### Move 1 — Mental model: the lazy student

Picture a student taking a true/false test where 95% of answers are "false." A lazy student who writes "false" on every line scores 95% and learns nothing. Accuracy rewards the lazy student. You need a metric that asks "but how did you do on the *true* questions?" — that's recall on the rare class.

The lie pattern

```
                 ┌─────────────────────────────────────────┐
   model:        │  predict "negative" for EVERYTHING       │
   "always neg"  └─────────────────────┬───────────────────┘
                                       │
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                         ▼
      ┌───────────────┐       ┌────────────────┐       ┌──────────────────┐
      │ accuracy 95%  │       │ rare-class      │       │ macro-F1 ≈ 0.49  │
      │  LOOKS GREAT  │       │ recall = 0%     │       │  TELLS THE TRUTH │
      └───────────────┘       └────────────────┘       └──────────────────┘
            LIAR                  the real story            honest summary
```

Same model, three numbers, wildly different stories. The job is to stop reading the leftmost box.

### Move 2 — Step by step

**Part 1: Detect the imbalance before you trust any score.** Count classes first. If the majority class is >80%, accuracy is on the suspect list.

Class census

```
  count labels
  ┌──────────────────────────────┐
  │ negative: 9500   ███████████  │
  │ positive:  500   █            │   ratio 19:1 → accuracy is suspect
  └──────────────────────────────┘
```

**Part 2: Switch to honest metrics.** Macro-F1 (averages F1 across classes, so the rare class counts equally), per-class recall (catches "never predicts positive"), and the confusion matrix (the ground truth behind all of it — see `08-confusion-matrices.md`).

```python
# PSEUDOCODE — not yet exercised in aptkit (no metrics layer exists)
acc        = accuracy(y_true, y_pred)          # the liar
macro_f1   = mean(f1_per_class(y_true, y_pred)) # honest summary
recall_pos = recall(y_true, y_pred, cls="positive")  # catches the lazy student
cm         = confusion_matrix(y_true, y_pred)   # the source of truth
```

**Part 3: Mitigate, then re-measure.** Apply class weights / oversampling / SMOTE / focal loss / threshold tuning — then re-run the *honest* metrics on the val set that still carries real-world skew.

Mitigation → re-measure loop

```
  ┌──────────────┐   ┌────────────────────┐   ┌─────────────────────┐
  │ pick lever:  │──▶│ retrain or re-      │──▶│ re-measure on val   │
  │ weights /    │   │ threshold           │   │ (REAL skew kept)    │
  │ SMOTE / etc. │   └────────────────────┘   └──────────┬──────────┘
  └──────────────┘            ▲                           │
                              │   recall up? precision     │
                              └───  still acceptable? ──────┘
                                    if no, pick another lever
```

> **Not yet exercised in aptkit.** There is no `accuracy`, `macro_f1`, `recall`, class-weighting, SMOTE, or focal loss anywhere in `packages/`. aptkit has no labeled dataset, no training loop, and no metrics module. The above is the shape to build.

### Move 3 — The principle

**Match the metric to the cost of being wrong.** When one class is rare *and* matters (fraud, disease, a missed rep), accuracy averages it into invisibility. Pick metrics that refuse to let the rare class disappear — macro-F1 and per-class recall — and only then judge whether a mitigation worked.

## Primary diagram

The full imbalance-aware evaluation flow:

```
                       CLASS-IMBALANCE-AWARE EVALUATION
  ┌──────────────────┐
  │ raw data         │  count classes ──▶ ratio 19:1 ──▶ FLAG: accuracy suspect
  └────────┬─────────┘
           │
           ▼
  ┌──────────────────────────────┐       ┌──────────────────────────────┐
  │ TRAIN split                  │       │ VAL / TEST split             │
  │ (may rebalance: weights /    │       │ KEEP real 19:1 skew —        │
  │  SMOTE / oversample)         │       │ never balance this           │
  └──────────┬───────────────────┘       └──────────────┬───────────────┘
             │                                            │
             ▼                                            ▼
       fit model                              ┌────────────────────────────┐
             │                                │ predict on val               │
             └───────────────────────────────▶ │                            │
                                              └──────────────┬───────────────┘
                                                             ▼
                              ┌───────────────────────────────────────────────┐
                              │ REPORT (honest):                               │
                              │  • accuracy        ← show, but flag as liar    │
                              │  • macro-F1        ← headline number           │
                              │  • per-class recall← catches the lazy model    │
                              │  • confusion matrix← the source of truth       │
                              └───────────────────────────────────────────────┘
```

The two split boxes carry the whole lesson: rebalance *train* if you like, but the val/test split keeps the real skew, because that's the world you'll deploy into.

## Elaborate

What trips people up:

- **Balancing the test set is self-deception.** If you oversample positives into the test set, your reported recall is measured on a world that doesn't exist. Rebalance train only.
- **SMOTE synthesizes, it doesn't conjure signal.** SMOTE interpolates between rare examples to create new ones. It can help, but on high-dimensional or image-like data it often makes nonsense points. Try class weights first — they're simpler and need no new data.
- **Precision and recall trade off.** Threshold tuning that lifts recall usually drops precision. Decide which error is costlier *before* you tune. Missing fraud vs. annoying a customer with a false flag — that's a product call, not a math one.
- **Macro vs. weighted F1.** Macro-F1 averages classes equally (rare class gets a full vote). Weighted F1 weights by class size — which quietly re-buries the rare class. For imbalance, you almost always want *macro*.

The contrl anchor: contrl's rep counter has a natural imbalance baked into the data stream. Across a workout video, the vast majority of frames are "not a rep boundary" — the body is mid-motion, holding, or resting. The "rep completed" event is rare. If you'd evaluated a rep-detection model on frame-level accuracy, "this frame is not a rep boundary" would score in the high 90s while catching zero reps. The honest read was always per-event recall — did we catch the actual reps? — which is exactly the rare-class-recall instinct, applied to a body in a living room instead of a spreadsheet.

## Project exercises

### Build an imbalance-aware eval report

- **Exercise ID:** EX-ML-05a — slots into Phase 3 (the ML-evals reporting layer), building on the harness from EX-ML-04a.
- **What to build:** A report function that, given true and predicted labels, prints accuracy *flagged as unreliable when the class ratio crosses a threshold*, plus macro-F1 and per-class recall, and refuses to emit a green "pass" on accuracy alone.
- **Why it earns its place:** It bakes the "accuracy is a liar under imbalance" lesson into tooling, so no future aptkit model can be declared good on a vanity metric. It's the reporting half of model selection done honestly.
- **Files to touch:** Case B (new) — `packages/ml-evals/src/imbalance-report.ts` (the report), `packages/ml-evals/src/metrics.ts` (macro-F1, per-class recall — shared with the confusion-matrix work). No existing aptkit file is touched; aptkit has no metrics today.
- **Done when:** Feeding the report a 95%-negative fixture and an "always predicts negative" prediction prints accuracy ≈ 0.95 *with a loud unreliable flag*, macro-F1 ≈ 0.49, and positive-class recall = 0.0 — and the function returns "fail."
- **Estimated effort:** 1–4hr

### Add a threshold-tuning sweep

- **Exercise ID:** EX-ML-05b — Phase 3, with a forward link to the Phase 5 ML-hardening pass.
- **What to build:** A sweep that, given model scores on val, walks the decision threshold from 0 to 1 and reports precision/recall at each step, surfacing the threshold that maximizes macro-F1 (or hits a target recall).
- **Why it earns its place:** Threshold tuning is the cheapest imbalance lever and the one most often skipped. Making it a one-call sweep means the decision-level fix is always on the table before anyone retrains.
- **Files to touch:** Case B (new) — `packages/ml-evals/src/threshold-sweep.ts`, reusing `packages/ml-evals/src/metrics.ts`.
- **Done when:** Given val scores, the sweep prints a precision/recall table across thresholds and names the macro-F1-optimal cutoff, defaulting to 0.5 only if nothing beats it.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: Your model reports 95% accuracy on a fraud dataset. Are you happy?**

```
  accuracy 95% ──┐
                 ├─ what's the base rate? ──▶ 95% legit ──▶ "always legit" = 95% too
  fraud recall ──┘──▶ check this ──▶ 0%? then the model is useless
```

No — I'd ask the base rate immediately. If 95% of rows are legit, 95% accuracy might mean the model never catches fraud. I'd report macro-F1 and fraud-class recall instead. Anchor: *accuracy averages the rare class into invisibility.*

**Q: When do you reach for SMOTE vs. class weights?**

```
  class weights ──▶ change loss, no new data ──▶ TRY FIRST (simpler)
  SMOTE         ──▶ synthesize rare points  ──▶ try if weights aren't enough
                                                 (risky on high-dim data)
```

Class weights first — they're simpler and add no synthetic data. SMOTE only if weighting isn't enough, and never on data where interpolated points are nonsense. Anchor: *prefer the lever that adds no fake data.*

**Q: Why not just rebalance everything, train and test, so it's clean?**

```
  rebalance TRAIN ──▶ fine, helps learning
  rebalance TEST  ──▶ measures a world that doesn't exist ──▶ lie
```

Rebalancing test makes your reported recall meaningless because production won't be balanced. Rebalance train only; keep test at the real skew. Anchor: *test must mirror the world you deploy into.*

## See also

- [`04-model-selection.md`](./04-model-selection.md) — the metric you select on must be the honest one from this file
- [`06-domain-gap.md`](./06-domain-gap.md) — even an honest metric won't survive a distribution shift at deploy
- [`08-confusion-matrices.md`](./08-confusion-matrices.md) — the source of truth behind macro-F1 and per-class recall, and the one file here with real aptkit code
