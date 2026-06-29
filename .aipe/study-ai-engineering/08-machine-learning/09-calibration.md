# Calibration

> calibration · probability quality

Blunt version first: aptkit trains no model, so it produces no probabilities to calibrate. There's no classifier, no scorer, no threshold anywhere in `packages/`. This is new ground — study material and a buildable exercise, not a description of shipped aptkit code. I'll flag `not yet exercised in aptkit` at the spots where you might otherwise assume there's running code.

The intuition you already own from contrl: your rep counter fired when a confidence-ish signal crossed a threshold. The question calibration asks is the one you'd eventually have to answer for any such gate — *when the model says 0.8, is it actually right 80% of the time?* If not, your threshold is built on sand. A confusion matrix read at a threshold (see `08-confusion-matrices.md`) only means something if the probability behind that threshold means something.

## Zoom out, then zoom in

Calibration sits at the Val/Test step, but it's really a post-processing layer between the trained Model and Deploy. The model emits raw scores; calibration corrects them so a score *reads* as a probability.

```
Generic supervised-ML pipeline · where calibration sits
┌────────┐  ┌──────────┐  ┌────────────────────┐  ┌─────────┐  ┌────────┐
│  Data  │─▶│ Features │─▶│  Train / Val / Test │─▶│  Model  │─▶│ Deploy │
└────────┘  └──────────┘  └──────────┬─────────┘  └─────────┘  └────────┘
                                     │
                          ┌──────────▼───────────┐
                          │ ★ CALIBRATION         │
                          │   fit a correction on │
                          │   VAL, measure on TEST │
                          │   raw score → true p   │
                          └───────────────────────┘
   raw model score ─────────────────────▶ confident-looking but maybe wrong
   calibrated score ───────────────────▶ 0.8 actually means 80% right
```

Two things to notice. First, calibration is fit on a held-out validation split and *measured* on test — fit it on training data and you're grading your own homework. Second, it does not change the model's *ranking* of examples; it only re-maps the score axis so the numbers are trustworthy. A model can rank perfectly (great AUC) and still be wildly uncalibrated.

## Structure pass

Put predicted probability on one axis and observed frequency on the other. Calibration is entirely about whether those two agree.

```
Reliability axis · predicted vs observed
 observed
 frequency
   1.0 ┤                                  ╱  ◀── perfect calibration
       │                               ╱       (the diagonal y = x)
   0.8 ┤                            ╱   ●        ● = a bin of predictions
       │                         ╱       ╲       below line = OVERCONFIDENT
   0.6 ┤                      ╱        ●          (says 0.8, right 0.6 of time)
       │                   ╱       ●
   0.4 ┤                ╱      ●
       │             ╱     ●                above line = UNDERCONFIDENT
   0.2 ┤          ╱    ●
       │       ╱
   0.0 ┼────┬────┬────┬────┬────┬────▶ predicted probability
       0   0.2  0.4  0.6  0.8  1.0
```

The diagonal is the only thing you want. Each dot is a *bin*: take all predictions near, say, 0.8, and ask what fraction were actually positive. On the diagonal means calibrated. Below the diagonal means overconfident — the classic failure of boosted trees and deep nets, which push scores toward 0 and 1. The gap between the dots and the diagonal, weighted by how many predictions land in each bin, is the headline number: Expected Calibration Error.

## How it works

### Move 1 — the mental model

The mental model: **calibration is a thermometer correction.** The model is a thermometer that reads consistently but is off by a varying amount. You don't replace the thermometer; you fit a correction curve so its readings match reality.

```
Pattern · raw score → calibration map → trustworthy probability
 raw score s ─▶ ┌────────────────────┐ ─▶ calibrated p
                │ monotonic mapping   │
                │ g(s) fit on VAL     │
                │ (Platt or isotonic) │
                └────────────────────┘
                ranking PRESERVED  (g is monotonic ↑)
                only the NUMBER changes, not the order
```

The mapping `g` is monotonic on purpose: it can squash or stretch the score axis but can never reorder two examples. That's why your AUC is untouched and only the meaning of the number improves.

### Move 2 — the steps

**Step A — bin and measure (the reliability diagram + ECE).** Sort predictions into bins by predicted probability. For each bin, compute the average predicted prob and the actual positive rate. Plot one against the other; sum the weighted gaps for ECE.

```
Binning · 10 equal-width bins
predictions ─▶ [0.0–0.1][0.1–0.2]...[0.9–1.0]
each bin:  avg_pred  vs  actual_positive_rate
ECE = Σ over bins ( bin_size / N ) × | avg_pred − actual_rate |
```

```python
# not yet exercised in aptkit — no probabilities are produced anywhere in packages/
def ece(probs, labels, n_bins=10):
    edges = linspace(0, 1, n_bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        mask = (probs > lo) & (probs <= hi)
        if mask.sum() == 0: continue
        conf = probs[mask].mean()          # avg predicted prob in bin
        acc  = labels[mask].mean()         # actual positive rate in bin
        total += (mask.sum() / len(probs)) * abs(conf - acc)
    return total
```

**Step B — fit a correction (Platt scaling).** Fit a one-parameter logistic regression from raw scores to labels on the validation split. Cheap, smooth, great when miscalibration is roughly sigmoidal.

```
Platt scaling · squash with a fitted sigmoid
raw score s ─▶ p = sigmoid(a·s + b)   (a, b fit on VAL labels)
              ▲
        2 parameters, low variance, can underfit weird shapes
```

```python
# not yet exercised in aptkit
a, b = fit_logistic(val_scores, val_labels)   # 2 params
calibrated = sigmoid(a * raw_scores + b)
```

**Step C — fit a correction (isotonic regression).** When the miscalibration isn't a clean sigmoid, fit a non-parametric monotonic step function instead. More flexible, but needs more validation data or it overfits.

```
Isotonic · monotonic step function, free shape
p
1│              ┌────────
 │         ┌────┘
 │    ┌────┘
0│────┘
 └──────────────────▶ raw score
  fits any monotonic shape; hungrier for data than Platt
```

```python
# not yet exercised in aptkit
iso = IsotonicRegression(out_of_bounds="clip")
iso.fit(val_scores, val_labels)
calibrated = iso.predict(raw_scores)
```

### Move 3 — the principle

The principle: **a probability is a promise about the future, and calibration is whether you keep it.** Ranking tells you *order*; calibration tells you the *number* is honest. Any decision made at a threshold — fire/don't fire, alert/don't alert — is only as trustworthy as the calibration behind the score.

## Primary diagram

```
Calibration · fit, correct, verify
        TRAIN split            VAL split              TEST split
            │                     │                      │
            ▼                     ▼                      ▼
     ┌────────────┐       ┌──────────────┐       ┌──────────────┐
     │ train model│       │ raw scores   │       │ raw scores   │
     └─────┬──────┘       │ + labels     │       │ + labels     │
           │              └──────┬───────┘       └──────┬───────┘
           │ raw scores          │ fit g                │ apply g
           └────────────────────▶│ (Platt / isotonic)   │
                                  ▼                      ▼
                           ┌────────────┐      ┌──────────────────┐
                           │ mapping g  │─────▶│ calibrated scores │
                           └────────────┘      └────────┬─────────┘
                                                        ▼
                                            reliability diagram + ECE
                                            (measured on TEST, never VAL)
```

Fit on val, verify on test. The mapping `g` is the only artifact that ships alongside the model.

## Elaborate

- **Accuracy and calibration are orthogonal.** A model can be 95% accurate and badly calibrated, or 60% accurate and perfectly calibrated. They answer different questions: "how often right?" vs "are the confidence numbers honest?" You need both, separately.
- **Deep nets and boosted trees are confidently wrong.** Modern deep nets are notoriously overconfident — softmax pushes mass to the extremes. Boosted trees do the same. Linear/logistic models tend to be better calibrated out of the box. If your backbone is deep, assume you need calibration.
- **ECE hides where the error is.** A single ECE number can look fine while a specific bin (say the high-confidence 0.9–1.0 bin, the one you act on) is badly off. Always look at the diagram, not just the scalar — exactly the way you'd never trust a single accuracy number over the confusion matrix.
- **Temperature scaling is the deep-net special case.** A one-parameter softmax temperature is the multi-class cousin of Platt scaling — cheap, preserves ranking, and usually enough for neural nets.
- **Calibration drifts.** It's fit on a data distribution; when the world shifts, the calibration shifts too. Re-measure ECE periodically the way you'd re-measure any production metric.

## Project exercises

### EX-ML-09a — Reliability-diagram + ECE scorer

- **Exercise ID:** EX-ML-09a (sits in the Phase 3 ML-evals track, alongside the confusion-matrix scorer — same family: ways to grade a probabilistic output before it ever drives a decision).
- **What to build:** A pure scorer that takes arrays of predicted probabilities and binary labels and returns (1) binned reliability data ready to render, (2) an ECE scalar, and (3) the per-bin gaps so a caller can see *where* the miscalibration lives. Add a tiny ASCII reliability-diagram renderer so it's inspectable without a plotting stack.
- **Why it earns its place:** It makes "is this 0.8 trustworthy?" a measurable, testable quantity instead of a vibe — and it's the natural partner to any LLM-judge or classifier score aptkit might later emit through its evals package.
- **Files to touch:** Case B (new) — `packages/evals/src/calibration/reliability.ts` (binning + ECE + per-bin gaps), `packages/evals/src/calibration/ascii-diagram.ts` (the text reliability plot), `packages/evals/src/calibration/reliability.test.ts` (assert ECE = 0 for a perfectly calibrated synthetic set, and a known nonzero value for a deliberately overconfident one).
- **Done when:** Feeding a perfectly calibrated synthetic dataset returns ECE ≈ 0, feeding an overconfident one returns a positive ECE matching a hand-computed value, and the ASCII diagram shows dots below the diagonal for the overconfident case.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: A model has great AUC but users complain its confidence numbers are meaningless. How is that possible?**

```
AUC = ranking quality        calibration = number honesty
  ▲ separates + from −          ▲ does 0.8 mean 80%?
  │ can be perfect              │ can be terrible
  └── orthogonal ───────────────┘  at the same time
```

AUC only measures whether positives rank above negatives — it's invariant to any monotonic squashing of the score. So a model can rank flawlessly and still emit scores that don't match observed frequencies. Anchor: in contrl the rep gate fired on a threshold; if the underlying confidence had been uncalibrated, "0.8 confidence" would've been a number I couldn't reason about.

**Q: Platt scaling or isotonic regression — how do you choose?**

```
miscalibration shape ── sigmoidal ──▶ Platt   (2 params, robust, can underfit)
                     └─ irregular ──▶ isotonic (free shape, data-hungry, can overfit)
val data scarce ─────────────────────▶ lean Platt
val data plenty ─────────────────────▶ isotonic is safe
```

Platt fits a 2-parameter sigmoid — cheap and stable, but it assumes the miscalibration is roughly sigmoidal. Isotonic fits any monotonic shape but needs enough validation data or it overfits the calibration curve itself. Scarce val data → Platt; plenty → isotonic. Anchor: I'd reach for the simpler Platt first, same instinct as preferring a debuggable linear head in transfer learning.

## See also

- [Transfer learning](./07-transfer-learning.md)
- [Confusion matrices](./08-confusion-matrices.md)
- [Recommender systems](./10-recommender-systems.md)
- [Cold start](./11-cold-start.md)
