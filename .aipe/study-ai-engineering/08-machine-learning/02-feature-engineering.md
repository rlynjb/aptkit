# Feature Engineering

> feature engineering · data transformation

Same disclaimer as file 01, and I'll keep being blunt: **aptkit has no features because aptkit trains no model.** There is no feature table, no transform module, no `extract_features` anywhere in `packages/`. This is new ground. What follows is study material plus exercises that would *introduce* feature engineering, not a description of code that exists.

The anchor that makes this concrete for you is contrl. That project is, at its core, a feature-engineering project wearing a rep-counter costume. Raw MediaPipe pose landmarks are useless to a classifier as-is; the work that makes contrl function is turning those landmarks into meaningful per-rep numbers. That transform is the lesson of this entire file.

## Zoom out, then zoom in

Feature engineering is stage two of the five-stage pipeline. It sits between raw data and the split, and it is where the load-bearing work lives. Star on stage two.

```
Where feature engineering lives (★ = this file)
┌──────┐   ┌────────────┐   ┌──────────────────┐   ┌───────┐   ┌────────┐
│ DATA │──▶│  FEATURES ★ │──▶│ TRAIN/VAL/TEST   │──▶│ MODEL │──▶│ DEPLOY │
│ raw  │   │ raw →        │   │                  │   │ small │   │        │
│      │   │ engineered   │   │                  │   │       │   │        │
└──────┘   └────────────┘   └──────────────────┘   └───────┘   └────────┘
              ▲ ~60–80% of the outcome decided here
```

The rough split of where outcome comes from: features ~60–80%, the split discipline some, the model only ~10%. If you remember one number from this sub-section, make it that. The reason is simple — the model can only see what the features expose. A great learner over bad features is a confident wrong answer.

## Structure pass

Feature engineering has its own internal layers, from rawest to most refined. Each layer is a transform with its own failure mode.

- **Raw signal.** What the sensor or source emits. For contrl: `{x, y, z}` per joint, per frame, ~33 landmarks, 30+ frames a second. Useless to a model directly — it's a firehose of positions with no meaning.
- **Cleaned signal.** Smoothing, gap-filling, unit normalization. Failure: noise leaks through, or you smooth away the thing you care about.
- **Derived quantities.** Per-frame physics: joint angles, velocities. Failure: wrong reference frame, wrong joint triple.
- **Aggregated features.** Per-*example* summaries: min knee angle over a rep, range of motion, time-at-bottom, peak velocity. This is the row the model actually eats. Failure: aggregating over the wrong window.
- **Feature set (versioned).** The named, frozen collection `v3 = {knee_angle_min, rom, time_at_bottom, peak_velocity}`. Failure: you change a feature and can no longer compare today's model to last week's.

The seam that bites hardest is raw→aggregated: you collapse a time series of frames into one row per rep, and getting the window boundaries wrong silently corrupts every feature.

## How it works

### Move 1 — Mental model

A feature is a **lens that makes the signal the model needs visible, and hides the rest.** Raw landmarks contain the answer ("was this a good squat?") but buried under thousands of irrelevant numbers. A good feature is a sharp lens; a bad feature is a smudged one.

```
Mental model — features as lenses
   raw firehose                lens 1            lens 2            lens 3
  {x,y,z}×33×N frames  ──▶  knee_angle(t)  ──▶  min over rep  ──▶  knee_angle_min
  (thousands of numbers)    (1 number/frame)    (1 number/rep)     (a feature)
        ▲ model can't                                                ▲ model CAN
          use this                                                     use this
```

Each lens throws away information on purpose. The art is throwing away the irrelevant and keeping the predictive. You're not adding information — the answer was always in the raw data — you're making it *legible*.

### Move 2 — Step by step

Pseudocode for a *new* feature module. **Not yet exercised in aptkit** — there is no transform code in `packages/`; the closest real instance of this work is contrl, described in prose only.

**Part 1 — From raw to per-frame derived quantities.**

```
Per-frame derivation
landmark[hip], landmark[knee], landmark[ankle]
        │
        ▼  angle = arccos( (hip-knee)·(ankle-knee) / (|hip-knee||ankle-knee|) )
   knee_angle(frame_t)   ← one number per frame
```

```python
def knee_angle(frame):                  # pseudocode — not in aptkit
    return angle_between(frame.hip, frame.knee, frame.ankle)
```

This is the contrl lesson in one function: the *physics* lives here. Pick the wrong three joints and every downstream feature is garbage.

**Part 2 — From per-frame to per-rep aggregates.**

```
Aggregation over a rep window
knee_angle(t):  170 150 120  95  80  95 130 165 ...
                └──────── one rep window ────────┘
                          ▼ aggregate
  knee_angle_min = 80   range_of_motion = 90   time_at_bottom = 2 frames
```

```python
def rep_features(rep_frames):           # pseudocode — not in aptkit
    angles = [knee_angle(f) for f in rep_frames]
    return {
        "knee_angle_min": min(angles),
        "rom":            max(angles) - min(angles),
        "time_at_bottom": sum(1 for a in angles if a < BOTTOM_THRESHOLD),
        "peak_velocity":  max(abs(d) for d in deltas(angles)),
    }
```

**Part 3 — Versioning the feature set.**

```
Feature-set versioning
feature_set_v1 = { knee_angle_min, rom }
feature_set_v2 = { knee_angle_min, rom, time_at_bottom }          ← added one
feature_set_v3 = { knee_angle_min, rom, time_at_bottom, peak_velocity }
                  ▲ each frozen + named → models stay comparable across versions
```

```python
FEATURE_SET_V3 = ["knee_angle_min", "rom", "time_at_bottom", "peak_velocity"]
def build_matrix(reps, feature_set=FEATURE_SET_V3):
    return [[rep[name] for name in feature_set] for rep in map(rep_features, reps)]
```

Versioning is the part people skip and regret. Without it you can't answer "did the model get better, or did I change the features?"

### Move 3 — The principle

**Features are the program; the model is the interpreter.** You spend your effort designing lenses, and you measure feature quality not by how clever it is but by whether it moves the held-out score. When in doubt, add a feature before you change the model.

## Primary diagram

The canonical picture: the full raw→engineered ladder for one rep, the same pipeline contrl runs in spirit.

```
Feature engineering ladder — raw landmarks to a model-ready row
RAW          CLEANED          DERIVED            AGGREGATED         FEATURE SET (v3)
{x,y,z}×33   smoothed,        knee_angle(t),     min/max/dwell      [knee_angle_min,
 per frame   gap-filled,  ──▶ velocity(t)    ──▶ over the rep   ──▶  rom,
 ×N frames   normalized       per frame          window              time_at_bottom,
   │            │                │                 │                  peak_velocity]
   │ firehose   │ denoised       │ physics         │ summary          │ frozen + named
   ▼            ▼                ▼                 ▼                  ▼
 unusable    usable but      meaningful but     one row per         the matrix X
 by model    too raw         too granular       rep ← the unit       the model eats
                                                  the model predicts
```

Read it as a funnel: thousands of numbers in, four numbers out, each transform discarding what the model doesn't need. The model never sees the firehose — only the four-number row on the right.

## Elaborate

- **More features is not better.** Each feature is a chance to leak, to overfit, or to introduce train/serve skew. Add features that move the val score and delete the ones that don't.
- **The aggregation window is the silent killer.** Collapsing a time series to one row per example means defining "one example." Get the rep boundaries wrong and `knee_angle_min` is computed over half a rep. Test the windowing in isolation.
- **Train/serve skew is born here.** If your training features are computed in Python and your serving features in TypeScript on-device, they *will* drift apart. Ideally one feature module runs in both places; at minimum, test that both produce the same numbers on the same input.
- **Normalization belongs to the pipeline, not the row.** Things like "scale to zero mean / unit variance" must be fit on *train only* and applied to val/test — fitting the scaler on all data leaks test statistics into training. (That's a leak; file 03 covers the family.)
- **contrl anchor.** This is contrl. Raw MediaPipe gives you `{x, y, z}` per joint per frame; on its own that's noise. The project works because you derive joint angles, velocity, range-of-motion, and time-at-bottom per rep — and those engineered features carry essentially all of the rep-quality signal. If you handed a model the raw landmarks instead, it would need vastly more data to relearn what one line of angle math gives you for free. That's the 60–80% claim made tangible.

## Project exercises

### Build a feature-extraction module with explicit windowing

- **Exercise ID:** EX-ML-02a (Phase 2C — the feature stage of the new belt; aptkit has no transform code today)
- **What to build:** A pure module that takes raw per-frame records and a rep-window definition and returns one feature row per rep: angle-derived min, range-of-motion, dwell time, peak velocity. Pure functions, no I/O, fully unit-testable.
- **Why it earns its place:** This is the load-bearing 60–80%. Building it makes concrete what contrl does implicitly and gives you a tested artifact to point at when an interviewer asks "show me feature work, not model work."
- **Files to touch:** Case B (new) — `aptkit/packages/ml-evals/src/features.ts` with `repFeatures()` and `kneeAngle()`; tests at `aptkit/packages/ml-evals/src/features.test.ts`. Consumed by `pipeline.ts` from EX-ML-01a. No existing source edits.
- **Done when:** Unit tests pass for at least: a known synthetic rep producing expected angle-min and ROM, and an edge case (truncated window) handled explicitly rather than producing NaN.
- **Estimated effort:** 1–2 days

### Add feature-set versioning

- **Exercise ID:** EX-ML-02b (Phase 3 — ML evals; make feature sets comparable across model runs)
- **What to build:** A named, frozen feature-set registry (`FEATURE_SET_V1`, `_V2`, …) plus a `buildMatrix(reps, featureSet)` that records which version produced a given training run.
- **Why it earns its place:** Without versioning you can't separate "the model improved" from "I changed the inputs." This is the discipline that makes the evals in Phase 3 trustworthy.
- **Files to touch:** Case B (new) — `aptkit/packages/ml-evals/src/feature-sets.ts`; the run metadata written by `pipeline.ts` records the feature-set version. Optional: a `buffr` training-log row capturing `feature_set_version`.
- **Done when:** A training run logs which feature-set version it used, and switching versions changes the recorded metadata so two runs can be compared apples-to-apples.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: You have a week to improve a model. What do you do?**

```
week budget ──▶ ███████░  features    (look at errors, add/fix lenses)
                █░░░░░░░  model        (swap in one line at the end)
```

I'd spend most of it on features: pull the worst-predicted examples, find what the current features can't distinguish, and add a lens that separates them. The model swap is the last hour. Anchor: in contrl, the win was always a better angle/velocity feature, never a fancier classifier.

**Q: How does a feature cause a production failure even when offline metrics look great?**

```
TRAIN feature code (python)  ─┐
                              ├─ disagree on same input ──▶ train/serve skew
SERVE feature code (on-device)┘                              offline 0.95, live flop
```

Train/serve skew. The features are computed by different code in different places and silently diverge. The fix is one shared feature module, or a test that asserts both paths agree. Anchor: contrl's on-device per-frame feature math must match whatever produced its training labels, or rep detection degrades for new users.

## See also

- [01-supervised-pipeline.md](./01-supervised-pipeline.md) — the five stages this transform sits inside
- [03-train-val-test.md](./03-train-val-test.md) — why the split must respect feature correlation
