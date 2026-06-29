# Supervised Learning Pipeline

> supervised learning pipeline · ML lifecycle

Let me say the uncomfortable thing first, before we draw a single box: **aptkit trains no model.** There is no supervised pipeline in this repo. No labeled dataset, no feature table, no train/val/test split, no `.fit()` call, no serialized weights. This whole sub-section is new ground. Everything below is study material and buildable exercises — not a tour of shipped code. When I say a stage "lives here," I mean *here in the generic pipeline*, not *here in aptkit*. Read it that way.

You do have one real ML project to anchor against: contrl, the pose-landmark rep counter (MediaPipe pose → on-device rep detection in React Native). I'll keep pointing at it in prose because it's the one place you've actually touched data, features, and a model end to end. But contrl isn't the repo we're studying, so I won't cite its files — just its shape.

## Zoom out, then zoom in

A supervised pipeline is five stages in a line. The model — the thing people obsess over — is the fourth stage, and it's the smallest, latest, most swappable piece. Here's the whole thing with a star on where *this file* lives, which is **everywhere**, because this file is about the pipeline as a whole.

```
Supervised pipeline — the five stages (★ = this file: the whole line)
┌──────────┐   ┌────────────┐   ┌──────────────────┐   ┌─────────┐   ┌──────────┐
│  DATA    │──▶│  FEATURES  │──▶│ TRAIN / VAL / TEST │──▶│  MODEL  │──▶│  DEPLOY  │
│  collect │   │  raw →     │   │  split + fit + eval │   │  the    │   │  serve + │
│  + label │   │  engineered│   │  on held-out data   │   │  learner│   │  monitor │
└──────────┘   └────────────┘   └──────────────────┘   └─────────┘   └──────────┘
   ★ big          ★ big              ★ medium             ★ SMALL       ★ medium
  (most bugs    (load-bearing      (where leaks         (swappable,   (where it
   live here)    work lives)        hide)                late)         meets reality)
```

The size labels under each box are the whole lesson. Most "AI bugs" in classical ML are **data bugs and feature bugs**, not model bugs. The model is a thin layer that maps engineered features to a prediction; if the features are wrong, no model architecture saves you. You'll spend 70% of real ML time in the first two stages and call it "ML work" even though no learning is happening yet.

## Structure pass

Walk the line left to right; each seam is a place where a bug can hide and where you can put a test.

- **Data → Features.** Seam: schema and units. Raw records (events, frames, rows) cross into a numeric feature space. Bugs: missing values, mixed units, label noise, timezones.
- **Features → Train/Val/Test.** Seam: the split. This is where *leakage* enters — if your split mixes near-identical rows across train and val, your metrics lie. (File 03 is entirely about this seam.)
- **Train/Val/Test → Model.** Seam: the fit. The learner consumes a feature matrix `X` and labels `y`; it knows nothing about your domain. Garbage features in, confident garbage out.
- **Model → Deploy.** Seam: train/serve skew. The features computed at serving time must match training *exactly* — same code path ideally. In contrl this seam is real: the angle math that runs on-device per frame must match whatever produced your training labels.

The seams matter more than the boxes. A pipeline is correct when every seam has a contract you can assert.

## How it works

### Move 1 — Mental model

A supervised pipeline is a **conveyor belt**, not a brain. Data goes in one end, a prediction comes out the other, and the "learning" is just one station fitting a function `f(X) → y` from examples. Hold this picture:

```
Mental model — conveyor belt, not brain
  raw world                                                   prediction
     │                                                            ▲
     ▼                                                            │
  ┌─────┐   transform   ┌─────────┐   fit f(X)→y   ┌───────┐   apply f
  │ DATA│──────────────▶│ FEATURES│───────────────▶│ MODEL │──────────▶
  └─────┘               └─────────┘                └───────┘
     "what happened"     "numbers the         "the only stage
                          model can eat"        that 'learns'"
```

The belt only learns at one station. Everything upstream is plumbing and everything downstream is serving. If you treat ML as "pick a fancy model," you've stared at one station and ignored the belt.

### Move 2 — Step by step

Since aptkit has no pipeline, this is pseudocode for a *new* skeleton. **Not yet exercised in aptkit** — there is no `fit`, no `X`, no `y` anywhere in `packages/`. Treat the code below as the thing the Phase 2C exercise asks you to scaffold.

**Stage 1 — Data: collect and label.**

```
Data stage
┌────────────────────────────────────────────────┐
│ raw_records = load("workout_sessions.jsonl")     │
│ # each record: { session_id, user_id, frames[],  │
│ #                label: "good_rep" | "bad_rep" }  │
│ assert no record missing a label                  │
│ assert label ∈ known set   ← contract at the seam │
└────────────────────────────────────────────────┘
```

This is where most bugs are born: a label typo, a duplicated session, a unit mismatch. Assert the contract here or chase it for a week downstream.

**Stage 2 — Features: raw → engineered.**

```
Feature stage
raw frames ──▶ extract ──▶ feature_row
[{x,y,z}×33]            { knee_angle_min, rom, time_at_bottom, peak_velocity }
                          ▲ the load-bearing transform (file 02)
```

```python
def extract_features(session):           # pseudocode — not in aptkit
    return {
        "knee_angle_min": min(knee_angle(f) for f in session.frames),
        "rom":            range_of_motion(session.frames),
        "time_at_bottom": dwell(session.frames),
    }
```

**Stage 3 — Train/Val/Test: split, fit, evaluate.**

```
Split + fit
features ──┬──▶ TRAIN (fit) ──▶ model
           ├──▶ VAL (tune)  ──▶ pick hyperparams
           └──▶ TEST (once) ──▶ the number you report
            ▲ split by SESSION/USER, never by frame (file 03)
```

```python
train, val, test = grouped_split(features, group="user_id")  # not row-wise!
model = fit(train.X, train.y)
score = evaluate(model, val)            # tune against val
final = evaluate(model, test)           # touch test once
```

**Stage 4 — Model: the small late part.**

```python
model = LogisticRegression()   # swap for anything; it's one line
model.fit(X, y)
```

That's it. The model is one swappable line. This is why "what model should I use?" is the wrong first question.

**Stage 5 — Deploy: serve and monitor.** Run the *same* feature code at serving time. Log inputs and predictions so you can detect when the live data drifts away from training data.

### Move 3 — The principle

**The model is the small, late, swappable part; the data and features are the program.** When metrics are bad, look upstream first. Nine times out of ten the bug is a label, a unit, or a leak — not the learner.

## Primary diagram

The canonical picture for this file: the five stages with their failure modes attached, so you read the pipeline as a chain of contracts.

```
Supervised pipeline — stages, seams, and where bugs live
┌────────┐  units/labels  ┌──────────┐   the split    ┌────────────┐  fit  ┌───────┐  skew  ┌────────┐
│  DATA  │═══════════════▶│ FEATURES │═══════════════▶│ TRAIN/VAL/ │══════▶│ MODEL │═══════▶│ DEPLOY │
│        │   ▲ seam 1     │          │   ▲ seam 2      │   TEST     │ ▲seam3│       │ ▲seam4 │        │
└────────┘                └──────────┘                 └────────────┘       └───────┘        └────────┘
 BUGS:                     BUGS:                         BUGS:                BUGS:            BUGS:
 missing/dup,              wrong units,                  leakage across       overfit,         train/serve
 label noise,              data leak into                groups, test         under-fit        skew, drift
 wrong timezone            a feature                     touched too much
   └─ ~40% of real ML pain ─────────────────────────────┘   └──── ~50% ────┘   └ ~10% ┘
```

Notice the percentages at the bottom: the model station carries maybe 10% of where things actually go wrong. The first two stages plus the split carry the rest.

## Elaborate

- **"AI bug" is almost always a data bug.** When a classical model misbehaves, your first move is to look at the actual rows — sort by prediction error, eyeball the worst 20. You'll usually find a labeling or unit problem, not a modeling one.
- **The model is swappable on purpose.** Keep the interface `fit(X, y) → predict(X)` so you can swap logistic regression for a gradient-boosted tree without touching the other four stages. If swapping the model means rewriting features, your seams leaked.
- **Train/serve skew is the deploy-stage killer.** The classic production failure: features computed in a notebook with pandas at training time, recomputed in TypeScript at serving time, and the two disagree subtly. Share the feature code or you'll ship a model that scored 0.95 offline and flops live.
- **contrl anchor.** Your rep counter is exactly this belt, even though you may not have drawn it as five boxes. DATA = recorded workout sessions of pose landmarks; FEATURES = per-rep joint angles and velocities derived from raw `{x,y,z}` landmarks; the MODEL is whatever decides "rep / not-rep"; DEPLOY = the on-device per-frame inference loop. The lesson transfers directly: when contrl miscounts, the bug is far more likely to be in how you derived the angle than in the classifier.
- **Don't over-build the skeleton.** Phase 2C wants the thinnest end-to-end belt that runs, not a production MLOps stack. One script that loads, extracts, splits, fits, and prints a score is the win.

## Project exercises

### Scaffold a minimal end-to-end pipeline skeleton

- **Exercise ID:** EX-ML-01a (Phase 2C — first end-to-end ML belt; this is new ground, aptkit has none today)
- **What to build:** The thinnest possible supervised pipeline that runs all five stages on toy or recorded data: load → extract features → grouped split → fit a trivial model → print val/test scores. The point is the *shape*, not the accuracy.
- **Why it earns its place:** You've never built the full belt as one artifact — contrl gave you data/features/inference but no explicit train/val/test discipline. Having a runnable skeleton turns "I understand ML pipelines" into "I have built one," which is the difference an interviewer can probe.
- **Files to touch:** Case B (new) — `aptkit/packages/ml-evals/src/pipeline.ts` (or a `train.py` under `buffr/scripts/ml/` if you want the Python ecosystem for `sklearn`). New package: `aptkit/packages/ml-evals/package.json`. No existing aptkit source changes.
- **Done when:** `node packages/ml-evals/dist/pipeline.js` (or `python buffr/scripts/ml/train.py`) runs the five stages end to end and prints a val score and a test score, with the split done by group (session/user), not by row.
- **Estimated effort:** 1–2 days

### Add seam-contract assertions to the data stage

- **Exercise ID:** EX-ML-01b (Phase 2C — harden the new belt's first seam)
- **What to build:** A small validation step at the Data→Features seam that asserts the contract: no missing labels, labels in a known set, no duplicate session IDs, consistent units. Fail loud and early.
- **Why it earns its place:** It internalizes the file's core claim — most ML bugs are data bugs — by making the data stage refuse bad input instead of silently poisoning the model. Cheap insurance that demonstrates maturity.
- **Files to touch:** Case B (new) — `aptkit/packages/ml-evals/src/validate.ts` (called from `pipeline.ts`). No existing source edits.
- **Done when:** Feeding a record with a missing label or a duplicate session ID throws a clear error naming the offending record, and the happy path passes silently.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: Your offline model scored 0.95 but tanked in production. Where do you look first?**

```
Offline 0.95  ──vs──  Production bad
     │                      │
     └── same model, so the gap is ── ▶ DATA or FEATURES or the SPLIT
                                          (not the learner)
```

Train/serve skew or a leaky split, almost always. I'd diff the features computed offline against the features computed live for the same input, and I'd re-check that the split grouped by the unit the model sees as new. Anchor: contrl — if rep detection works in my dev recordings but fails on a new person, that's a generalization/skew problem, not a model-capacity problem.

**Q: A teammate wants to spend the sprint trying five model architectures. Good use of time?**

```
effort ──▶ DATA  FEATURES  MODEL
           ████  ███████   █     ← payoff is concentrated upstream
```

Usually no. The model is ~10% of the outcome here. I'd spend the sprint cleaning labels and improving features, then swap the model in one line at the end. Anchor: contrl's accuracy lives in the angle/velocity feature math, not in the choice of classifier.

## See also

- [02-feature-engineering.md](./02-feature-engineering.md) — the load-bearing second stage
- [03-train-val-test.md](./03-train-val-test.md) — the split where leaks hide
