# Domain gap

> industry name: **domain gap** / **distribution shift** · type: **generalization failure**

This is the failure that makes engineers distrust ML, because the model was *good* — 94% on the test set, signed off, shipped — and then it quietly fell apart in the wild and no alarm went off. Domain gap is the mismatch between the distribution you trained on and the distribution you actually run on. Nothing throws. The model just gets quietly, steadily wrong. New ground again: aptkit trains no model and ships no inference path, so everything here is the playbook, not a code tour — though this is the failure mode I'd anchor hardest to your contrl experience.

## Zoom out, then zoom in

Domain gap is unique among the concepts in this section: it's the only one that lives in the *seam between* two pipeline runs — the training pipeline and the deployment pipeline. It's not a stage; it's the gap that opens when the Data at train time and the Data at inference time were drawn from different worlds.

Pipeline placement (★ = the gap between two pipelines)

```
  TRAIN-TIME PIPELINE                              INFERENCE-TIME PIPELINE
  ┌────────┐  ┌──────────┐  ┌────────┐             ┌────────┐  ┌──────────┐  ┌────────┐
  │ Data   │─▶│ Features │─▶│ Model  │──── ships ──▶│ Model  │─▶│ Features │◀─│ Data   │
  │ (gym,  │  │          │  │ fit    │             │ (same  │  │          │  │ (living│
  │  clean)│  │          │  │        │             │ weights)│ │          │  │  room) │
  └────┬───┘  └──────────┘  └────────┘             └────────┘  └──────────┘  └───┬────┘
       │                                                                          │
       │  distribution P_train                          distribution P_deploy    │
       └──────────────────────────────────────★─────────────────────────────────┘
                                    DOMAIN GAP = P_train ≠ P_deploy
```

The diagram's whole point: the model weights are *identical* on both sides — the gap isn't in the model, it's in the data feeding it. The model learned the shape of P_train; when P_deploy has a different shape, the model is confidently applying the wrong map.

## Structure pass

Lay the gap out along one axis — *what* shifted — and the seams sort the failure into named buckets:

```
  WHAT SHIFTED  ──────────────────────────────────────────────────────────────▶

  ┌────────────────────┐  seam A  ┌────────────────────┐  seam B  ┌──────────────────────┐
  │ COVARIATE SHIFT    │          │ LABEL SHIFT        │          │ CONCEPT DRIFT        │
  │ inputs change      │          │ class mix changes  │          │ input→label mapping  │
  │ P(x) differs       │          │ P(y) differs       │          │ P(y|x) itself moves  │
  │ (gym→living room)  │          │ (rare class rarer) │          │ (rules changed)      │
  └────────────────────┘          └────────────────────┘          └──────────────────────┘
     fixable by                      fixable by                     hardest — model is now
     normalization,                  re-weighting                   wrong about the world;
     augmentation                                                    needs new labels
```

- **Seam A** separates "the inputs look different" (covariate shift — your contrl case) from "the class proportions changed" (label shift).
- **Seam B** is the cliff. Concept drift means the *relationship* between input and label moved — the thing the model learned is no longer true. Normalization can't save you; you need fresh labeled data from the new world. (That ongoing-monitoring problem is drift detection — see file 15.)

Most deployment surprises are covariate shift, which is the good news: it's the most fixable. The contrl case lives squarely in seam A.

## How it works

### Move 1 — Mental model: the home-court map

A model is a map of the territory it trained on. Deploy it somewhere the territory differs and the map is still confidently drawn — it just points to the wrong places. The model doesn't *know* it's lost.

The home-court pattern

```
                TRAIN WORLD (home court)            DEPLOY WORLD (away game)
              ┌───────────────────────┐           ┌───────────────────────┐
              │  bright, side angle,   │           │  dim, weird angle,     │
              │  fit subjects,         │  ── ❌ ──▶ │  baggy clothes,        │
              │  clean landmarks       │           │  noisy landmarks       │
              └───────────────────────┘           └───────────────────────┘
                        │                                     │
                        ▼                                     ▼
              model is calibrated here          model applies SAME rules here
              (accuracy looks great)            (accuracy silently collapses)
                                                 no error thrown ⚠
```

The danger isn't that the model fails loudly. It's that it keeps returning confident answers that are wrong, and your test-set metric — measured on the home court — never warned you.

### Move 2 — Step by step

**Part 1: Characterize both distributions.** You can't detect a gap you never measured. Summarize the train distribution (per-feature means, ranges, key stats) and do the same on a sample of real deploy data.

Distribution fingerprints

```
  feature: landmark_brightness
  TRAIN  ┤  mean 0.72  ████████████░░░░  range [0.5, 0.9]
  DEPLOY ┤  mean 0.31  ████░░░░░░░░░░░░  range [0.1, 0.5]
                                          ▲ shifted left → covariate shift
```

**Part 2: Compare and quantify the gap.** Put the two fingerprints side by side and measure the distance per feature (population stability index, KL divergence, or even a simple mean/std delta to start). Flag features that moved.

```python
# PSEUDOCODE — not yet exercised in aptkit (no model, no inference data)
train_stats  = summarize(X_train)          # per-feature mean, std, range
deploy_stats = summarize(X_deploy_sample)  # same features, real-world sample
for f in features:
    gap[f] = distance(train_stats[f], deploy_stats[f])  # PSI / KL / mean-delta
flagged = [f for f in features if gap[f] > threshold]   # these shifted
```

**Part 3: Close the gap with the cheapest lever that works.** Input normalization (standardize features so a dim room maps onto the trained range), data augmentation (train on dimmed/rotated/occluded variants so the home court is bigger), domain adaptation (explicitly adapt the model), or — the real fix for concept drift — collect labeled target-domain data and retrain.

Lever ladder (cheapest first)

```
  ┌────────────────────────────────────────────────────────────────────────┐
  │ 1. input normalization   ── cheap, no retrain ── handles scale/lighting   │
  │ 2. data augmentation     ── retrain, no new labels ── widens home court   │
  │ 3. domain adaptation     ── more involved ── aligns feature spaces        │
  │ 4. collect target data   ── slow/expensive ── the only fix for concept    │
  │                                                drift                       │
  └────────────────────────────────────────────────────────────────────────┘
       try top → bottom; stop when the gap closes on a deploy-domain test set
```

> **Not yet exercised in aptkit.** There is no trained model, no inference pipeline, no `summarize`, no PSI/KL computation, no augmentation, and no deploy-domain dataset anywhere in `packages/` or buffr. aptkit has never deployed a model into a second distribution. The above is the shape to build.

### Move 3 — The principle

**A model is only valid inside the distribution it was trained on; outside it, the model is guessing in a familiar accent.** Test-set accuracy measures the home court. Generalization to the deploy world is a *separate* claim that you must measure separately — by characterizing the deploy distribution and proving the model still holds there.

## Primary diagram

The full domain-gap detection and mitigation flow:

```
                          DOMAIN-GAP DETECTION & MITIGATION
  ┌──────────────────┐                         ┌──────────────────────────┐
  │ train data       │  fingerprint ──▶ P_train│ deploy sample            │ fingerprint ──▶ P_deploy
  │ (gym, clean)     │                         │ (living room, real users)│
  └──────────────────┘                         └──────────────────────────┘
            │                                              │
            └──────────────────────┬───────────────────────┘
                                   ▼
                    ┌──────────────────────────────────┐
                    │ per-feature distance (PSI / KL)   │
                    │ flag features where gap > thresh   │
                    └─────────────────┬─────────────────┘
                                      │
                  ┌───────────────────┴───────────────────┐
                  ▼                                         ▼
         gap small / none                            gap large
                  │                                         │
                  ▼                                         ▼
         ship as-is, keep                  ┌────────────────────────────────┐
         monitoring (file 15)              │ pick lever (cheapest first):   │
                                           │  normalize → augment →         │
                                           │  adapt → collect target data   │
                                           └────────────────┬───────────────┘
                                                            ▼
                                           ┌────────────────────────────────┐
                                           │ re-measure on a DEPLOY-DOMAIN   │
                                           │ test set (not the home court)   │
                                           └────────────────────────────────┘
```

The bottom-right box is the one people skip: after mitigating, you must re-measure on a *deploy-domain* test set, not the original one. Passing the home court again proves nothing.

## Elaborate

The things that bite:

- **The gap is silent — that's the whole danger.** No exception, no 500, no failed assertion. The only signal is degraded outcomes, often surfacing as user complaints weeks later. This is *why* drift detection (file 15) exists: to convert the silence into an alarm.
- **Augmentation must match the *real* shift, not an imagined one.** Augmenting with random rotations is useless if the real gap is lighting. Characterize the deploy distribution *first*, then augment toward it.
- **Normalization can hide a concept drift you can't fix.** If P(y|x) actually moved — the rules changed, not just the inputs — normalizing inputs just makes a wrong model look confident. Distinguish covariate shift (fixable cheaply) from concept drift (needs new labels) before reaching for a lever.
- **A "deploy-domain test set" is a real asset you have to build.** You can't validate the fix on the home court. Collecting even a small, honestly-labeled sample from the deploy world is often the highest-leverage thing you can do.

The contrl anchor — this is the canonical example and it's *yours*: contrl's pose-landmark rep counter was effectively tuned against public-gym pose data — good lighting, clean side angles, fit subjects in fitted clothes, landmarks crisp and well-separated. Then a real user runs it in a dim living room, phone propped at a janky angle against a water bottle, wearing a baggy hoodie that swallows the elbow and knee landmarks. The landmark distribution shifts — joint positions noisier, some occluded, angles compressed — and the rep counter that worked flawlessly in testing starts miscounting: missing reps, double-counting, drifting. *That* is covariate shift (seam A), and the fixes are exactly the lever ladder above: normalize the landmark coordinates relative to the body, augment training with dimmed/rotated/occluded poses, and collect real living-room footage to validate against. The test-set number was never wrong — it just measured the gym, and users don't live in the gym.

## Project exercises

### Build a distribution-comparison check

- **Exercise ID:** EX-ML-06a — slots into Phase 5 (ML hardening), and is the natural feeder for the Phase 5 drift-detection work in file 15.
- **What to build:** A check that takes two datasets (a "reference"/train sample and a "target"/deploy sample), computes a per-feature distribution distance (PSI to start), and emits a flagged report of which features shifted and by how much.
- **Why it earns its place:** It turns the silent failure into a measurable one *before* deployment, and it's the reusable core that online drift detection (file 15) will call on a schedule. It's the cheapest insurance against a confident-but-wrong model.
- **Files to touch:** Case B (new) — `packages/ml-evals/src/distribution-compare.ts` (PSI + per-feature report), `packages/ml-evals/src/dataset-stats.ts` (the fingerprint summarizer, shared with file 15). No existing aptkit file is touched; aptkit has no datasets or model today.
- **Done when:** Given a gym-like reference fixture and a living-room-like target fixture, the check prints a per-feature PSI table, flags the features above a configurable threshold, and returns "shift detected" — and returns "no shift" when the two samples are drawn from the same distribution.
- **Estimated effort:** 1–2 days

### Add a deploy-domain holdout gate

- **Exercise ID:** EX-ML-06b — Phase 5 ML hardening, building on EX-ML-06a.
- **What to build:** A gate that re-scores a model on a *separate* deploy-domain holdout set and fails if accuracy drops more than a configured delta below the home-court test score.
- **Why it earns its place:** It encodes the "re-measure on the deploy domain, not the home court" rule as a hard CI gate, so a model can't ship on its gym numbers alone.
- **Files to touch:** Case B (new) — `packages/ml-evals/src/deploy-holdout-gate.ts`, plus a deploy-domain fixture under `packages/ml-evals/fixtures/deploy-domain/`. In buffr, a new config flag in `buffr` settings to point at the deploy-domain sample source (Case B, new).
- **Done when:** The gate passes when home-court and deploy-domain scores are within the delta, and fails loudly (with the per-feature shift report from EX-ML-06a attached) when the deploy-domain score collapses.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: Your model hit 94% on the test set but users complain it's wrong. What's your first hypothesis?**

```
  test set (home court) ──▶ 94%  ── measured P_train
  real users (away)     ──▶ ??   ── live in P_deploy
                                    ▲ if P_train ≠ P_deploy → domain gap
```

Domain gap — the test set measured the training distribution, and production is a different one. I'd fingerprint both distributions and look for shifted features before touching the model. Anchor: *test-set accuracy is a home-court claim; deployment is an away game.*

**Q: You found covariate shift. Why not just retrain on new data immediately?**

```
  retrain w/ labels ──▶ slow, expensive, needs labeled target data
  normalize/augment ──▶ cheap, often closes covariate shift ── TRY FIRST
```

Because covariate shift often closes with normalization or augmentation — no new labels needed. Collecting and labeling target data is the expensive last resort, reserved for true concept drift. Anchor: *climb the lever ladder cheapest-first.*

**Q: How would you have caught the contrl rep-miscounting before users did?**

```
  gym landmarks  ─┐
                  ├─ PSI per feature ──▶ brightness/angle shifted ──▶ ALARM
  living-room ────┘
```

A distribution-comparison check on a sample of real living-room footage against the gym training data — the brightness and angle features would have flagged a shift pre-launch. Anchor: *characterize the deploy distribution before shipping, not after the complaints.*

## See also

- [`04-model-selection.md`](./04-model-selection.md) — the model you selected on the home court still has to survive the away game
- [`05-class-imbalance.md`](./05-class-imbalance.md) — label shift is a cousin of imbalance that moves at deploy time
- [`08-confusion-matrices.md`](./08-confusion-matrices.md) — the per-class view that shows *which* classes the gap is breaking; the one file here with real aptkit code
