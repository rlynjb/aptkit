# Model selection

> industry name: **model selection** · type: **modeling decision**

Here's the thing nobody tells you in a bootcamp: the hard part of modeling isn't picking the fanciest architecture. It's deciding *whether you even need* the fancy one. Model selection is the discipline of training more than one candidate, comparing them honestly on the same held-out data, and then — this is the part that takes a senior to do — picking the *simpler* model when the numbers are close. We're starting on new ground here: aptkit trains no model, so nothing below is shipped code. This is the playbook you'll run the first time aptkit needs a real classifier.

## Zoom out, then zoom in

Model selection is not a stage you add to the pipeline — it's a *fork* that sits at the modeling step, where you instantiate two (or more) learners and let them race. Everything upstream (data, features) is shared; everything downstream (deploy) only sees the winner.

Pipeline placement (★ = model selection lives here)

```
┌──────────┐   ┌────────────┐   ┌─────────────────────┐   ┌──────────────┐   ┌─────────┐
│  Data    │──▶│  Features  │──▶│  Train / Val / Test │──▶│    Model     │──▶│ Deploy  │
│  (raw)   │   │ (engineer) │   │   (the split)       │   │ (the learner)│   │ (serve) │
└──────────┘   └────────────┘   └─────────────────────┘   └──────────────┘   └─────────┘
                                          │                       ★
                                          │              ┌────────┴─────────┐
                                          │              │ MODEL SELECTION  │
                                          ▼              │  fork happens    │
                                  same val split ───────▶│  here            │
                                  feeds BOTH             └──────────────────┘
                                  candidates
```

The fork lives at the Model step but it *reaches back* to the val split — both candidates must be judged on the identical rows, or the comparison is meaningless. Notice Deploy only has one arrow into it: exactly one model survives. The whole exercise exists to make that single arrow a defensible choice rather than a vibe.

## Structure pass

Lay model selection out along one axis — increasing model complexity — and the seams jump out:

```
Increasing complexity / capacity  ──────────────────────────────────────────▶

  ┌─────────────────┐   seam A    ┌──────────────────┐   seam B   ┌──────────────────┐
  │   BASELINE      │             │   STRONG MODEL   │            │  DEEP / EXOTIC   │
  │ logistic reg.   │  is the     │ gradient-boosted │  is the    │ neural net,      │
  │ (linear)        │  lift worth │ trees (XGBoost / │  extra     │ transformer, …   │
  │                 │  the cost?  │ LightGBM)        │  lift real?│                  │
  └─────────────────┘             └──────────────────┘            └──────────────────┘
     cheap to serve                  more accurate                   often overkill
     trivial to debug                handles non-linearity           hard to debug
     easy to calibrate               needs more tuning               easy to overfit
```

- **Seam A** is the one you'll actually argue about: does the gradient-boosted tree beat logistic regression by enough to justify being harder to serve, debug, and calibrate?
- **Seam B** is the trap. People jump to deep models because they're exciting. The rule: you don't cross a seam until the model on its left has been beaten *decisively* on the val set.

The axis is complexity, not accuracy. They correlate, but the senior move is to treat every step right as a *debt* you take on — operational, cognitive, calibration — and demand the accuracy gain pay it off.

## How it works

### Move 1 — Mental model: the bake-off

Think of it as a bake-off where every entrant is judged by the *same* taster on the *same* plate. The plate is your validation split. You don't let the GBT taste a different plate than logistic regression — same rows, same metric, same day.

Bake-off pattern

```
                         ┌─────────────────────────┐
        train split ────▶│  fit Baseline (LR)      │───┐
                         └─────────────────────────┘   │
                         ┌─────────────────────────┐   │     ┌───────────────────┐
        train split ────▶│  fit Strong (GBT)       │───┼────▶│  SAME val split   │
                         └─────────────────────────┘   │     │  same metric      │
                         ┌─────────────────────────┐   │     └─────────┬─────────┘
        train split ────▶│  fit … (optional more)  │───┘               │
                         └─────────────────────────┘                   ▼
                                                            ┌────────────────────────┐
                                                            │ compare → pick SIMPLER  │
                                                            │ if scores are close     │
                                                            └────────────────────────┘
```

The "same val split" box is the load-bearing one. If each model gets fit *and* judged on its own random split, you're comparing luck, not models.

### Move 2 — Step by step

**Part 1: Establish the baseline first.** Before you touch a tree, fit logistic regression. It's your floor. Any model that can't beat a linear model on your data is telling you something — usually that your features are weak or your signal is thin.

Baseline-first ordering

```
   START
     │
     ▼
  ┌──────────────────┐    no    ┌────────────────────────────┐
  │ Did LR beat the  │─────────▶│ STOP. Fix features/data.    │
  │ majority-class   │          │ A fancy model won't save a  │
  │ guess?           │          │ broken feature set.         │
  └──────────────────┘          └────────────────────────────┘
     │ yes
     ▼
  proceed to strong model
```

**Part 2: Train the strong model on the same data.** Fit the gradient-boosted tree on the identical train split. Tune it lightly — don't let GBT get 200 rounds of tuning while LR got none; that's a rigged race.

```python
# PSEUDOCODE — not yet exercised in aptkit (aptkit trains no model today)
baseline = LogisticRegression().fit(X_train, y_train)
strong   = GradientBoostedTrees(n_estimators=..., max_depth=...).fit(X_train, y_train)

# judge BOTH on the identical val split, identical metric
score_lr  = macro_f1(y_val, baseline.predict(X_val))
score_gbt = macro_f1(y_val, strong.predict(X_val))
```

**Part 3: Apply the close-call rule.** Compute the gap. If GBT beats LR by a margin that's within noise (rule of thumb: smaller than the spread you'd see across a few val folds), pick LR. Simpler wins ties.

Decision gate

```
  gap = score_gbt − score_lr
  ┌───────────────────────────────────────────────────────────┐
  │  gap ≤ noise band   ──▶  SHIP LR     (cheaper, debuggable)  │
  │  gap >  noise band  ──▶  SHIP GBT    (lift is real)         │
  └───────────────────────────────────────────────────────────┘
            ▲
            │ "noise band" = variation across val folds, not zero
```

> **Not yet exercised in aptkit.** There is no `LogisticRegression`, no `GradientBoostedTrees`, no train/val split, and no model registry anywhere in `packages/`. The pseudocode above is the shape you'd build, not a description of existing code.

### Move 3 — The principle

**Complexity is a loan, and accuracy is the only currency that repays it.** A model you can't explain, calibrate, or cheaply serve costs you every day it's in production. Make the strong model *earn* its place by beating the baseline by a margin you can defend in a postmortem — not by being more impressive in a slide.

## Primary diagram

The full selection loop, end to end:

```
                          MODEL SELECTION — full loop
  ┌──────────────┐
  │  train split │──────────────┬───────────────────────┐
  └──────────────┘              │                        │
                                ▼                        ▼
                    ┌─────────────────────┐   ┌─────────────────────┐
                    │ Baseline: LR        │   │ Strong: GBT         │
                    │ fit on train        │   │ fit on train        │
                    └──────────┬──────────┘   └──────────┬──────────┘
                               │                         │
        ┌──────────────┐       │   same val split        │
        │  val split   │───────┴────────────┬────────────┘
        └──────────────┘                    │
                                            ▼
                              ┌───────────────────────────┐
                              │ same metric (macro-F1)     │
                              │ score_lr vs score_gbt      │
                              └─────────────┬─────────────┘
                                            ▼
                              ┌───────────────────────────┐
                              │ gap ≤ noise? ── yes ──▶ LR │
                              │              ── no  ──▶ GBT│
                              └─────────────┬─────────────┘
                                            ▼
                              ┌───────────────────────────┐
                              │ TEST split (touch ONCE,    │
                              │ only the winner)           │
                              └───────────────────────────┘
```

The test split appears only at the bottom and only for the winner — you never select *on* test, or you've burned your last honest estimate of generalization.

## Elaborate

A few things that bite people:

- **Don't tune on the test set.** Selection happens on *val*. Test is touched once, at the end, by the winner only. Tune on test and your reported number is a fantasy.
- **Calibration is a hidden cost of GBT.** Tree ensembles give you ranked scores that aren't true probabilities out of the box. If downstream code thresholds on "probability > 0.7", LR's outputs are closer to calibrated for free; GBT needs Platt scaling or isotonic regression. Factor that into the close-call decision.
- **A tiny gap on a tiny val set is noise.** With 200 val rows, a 1% F1 difference is meaningless. Bigger val set or cross-validation before you trust a small gap.
- **"Simpler" includes operational simplicity.** LR is a dot product you can run in a line of code on-device. GBT needs the ensemble shipped and a runtime. On constrained targets that gap alone can decide it.

The contrl anchor: in contrl, the rep-counter logic on top of MediaPipe pose landmarks started as a deliberately dumb threshold-on-joint-angle rule — the equivalent of a baseline. That dumb rule was the right call: it shipped, it ran on-device at frame rate, and it was debuggable when a rep miscounted. A heavier learned classifier would only have earned its place by *clearly* beating that threshold on real reps — and for a lot of exercises, it wouldn't have. Same instinct: prove the simple thing is insufficient before you reach for the complex one.

## Project exercises

### Build a model-comparison harness

- **Exercise ID:** EX-ML-04a — slots into Phase 2C (first real modeling work in aptkit), before any Phase 3 ML-evals reporting layer exists.
- **What to build:** A harness that takes a single train/val split, fits both a logistic-regression baseline and a gradient-boosted tree, scores both on the *same* val split with the *same* metric, and prints a side-by-side table plus the gap and a recommended pick.
- **Why it earns its place:** It forces the baseline-first discipline into code so it can't be skipped under deadline pressure. Every future modeling task in aptkit gets a reusable "did the fancy model actually win?" gate instead of an ad-hoc notebook.
- **Files to touch:** Case B (new) — `packages/ml-evals/src/model-compare.ts` (harness + table), `packages/ml-evals/src/splits.ts` (deterministic train/val split), `packages/ml-evals/package.json` (new package manifest). No existing aptkit file is touched; there is no ML code today.
- **Done when:** Given a labeled dataset fixture, running the harness prints both models' macro-F1 on the identical val rows, the numeric gap, and a one-line "ship LR" / "ship GBT" recommendation driven by a configurable noise band.
- **Estimated effort:** 1–2 days

### Add a calibration column to the comparison

- **Exercise ID:** EX-ML-04b — extends EX-ML-04a; still Phase 2C, lays groundwork the Phase 5 ML-hardening pass will lean on.
- **What to build:** Extend the harness to also report a calibration metric (e.g. expected calibration error) per model, so the close-call decision can account for GBT's miscalibration cost, not just accuracy.
- **Why it earns its place:** Makes the "GBT needs Platt scaling" gotcha visible at selection time instead of discovering it in production when a threshold misbehaves.
- **Files to touch:** Case B (new) — `packages/ml-evals/src/calibration.ts` (ECE + reliability bins), and a new column in `packages/ml-evals/src/model-compare.ts`.
- **Done when:** The comparison table shows macro-F1 *and* calibration error side by side for both models, and the doc-comment explains why a better-F1 model can still be the worse pick.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: Your GBT beats your logistic regression by 0.5% F1. Which do you ship?**

```
  LR ──── 0.910 F1 ┐
                   ├─ gap = 0.005  ──▶ within fold-to-fold noise?
  GBT ─── 0.915 F1 ┘                   ──▶ YES ──▶ ship LR
```

Logistic regression. A half-point inside the noise band doesn't pay for GBT's serving cost, calibration work, and debugging difficulty. Anchor: *complexity is a loan; that gain doesn't repay it.*

**Q: Why even bother with the baseline if you suspect the tree will win?**

```
  no baseline ──▶ "GBT got 0.91" ──▶ 0.91 of WHAT? could be a broken signal
  baseline    ──▶ "majority guess 0.85, LR 0.89, GBT 0.91" ──▶ each step justified
```

The baseline is your yardstick. Without it, you can't tell whether 0.91 is excellent or barely better than guessing. Anchor: *a number without a floor under it isn't evidence.*

**Q: How do you keep the comparison honest?**

```
  ┌────────────┐     ┌────────────┐     ┌────────────┐
  │ same train │ ──▶ │ same val   │ ──▶ │ same metric│   select on VAL only,
  └────────────┘     └────────────┘     └────────────┘   touch TEST once
```

Identical train data, identical val rows, identical metric, and selection done strictly on val with test reserved for the winner's final read. Anchor: *change one variable at a time or you're measuring luck.*

## See also

- [`05-class-imbalance.md`](./05-class-imbalance.md) — why the metric you select on can lie to you
- [`06-domain-gap.md`](./06-domain-gap.md) — why the val score won't survive deployment if distributions shift
- [`08-confusion-matrices.md`](./08-confusion-matrices.md) — the one file here with real aptkit code; the per-class view behind the metrics you compare on
