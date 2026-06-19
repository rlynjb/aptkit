# The supervised-learning pipeline (data → features → split → train → evaluate → deploy → monitor)

**Industry names:** supervised ML pipeline, training pipeline, ML lifecycle, model lifecycle · *Industry standard*

## Zoom out, then zoom in

This is the spine of the whole `08` section. Every other file here is a station
on the conveyor below — feature engineering is the second box, train/val/test is
the third, model selection sits inside the fourth. Read this one first; the rest
are zoom-ins on a single stage.

```
  Zoom out — the supervised pipeline, and what this file owns

  ┌─ Offline (training time) ─────────────────────────────────────────────┐
  │                                                                        │
  │  raw data ──► features ──► split ──► train ──► evaluate                │
  │  (02-…)      (02-…)       (03-…)    (04-…)     (08-confusion…)          │
  │                                       │                                │
  │                              ★ THIS FILE owns the WHOLE spine —        │
  │                                the conveyor, not any one box           │
  └────────────────────────────────────────────┬───────────────────────────┘
                                                │  ship the frozen model
  ┌─ Online (inference time) ──────────────────▼───────────────────────────┐
  │  deploy ──► serve predictions ──► monitor (15-drift…) ──► retrain (16-…)│
  └────────────────────────────────────────────────────────────────────────┘
```

Zoom in: AptKit ships **none** of this. No trained model, no feature pipeline,
no split, no training loop. AptKit is an LLM-application toolkit — a bounded
agent loop, a provider abstraction, an eval layer. So this whole file is new
ground. Your one real anchor is **contrl**: you ran a supervised CV model
(MediaPipe pose landmarking) on-device. You shipped the *deploy/serve* end of
this conveyor without ever hand-building the *train* end. This file fills in the
left half. The pattern: **supervised learning is an offline conveyor that
freezes a model, and an online phase that runs it and watches it rot.**

## Structure pass

**Layers.** Two, split by *time of execution*. The **offline** layer runs once
(or on a schedule): it consumes historical labelled data and emits a frozen
artifact — weights plus the exact feature transforms used to produce them. The
**online** layer runs per-request: it takes a live input, applies the *same*
transforms, and emits a prediction.

**Axis — where does the label live?** Trace the *label* (the ground-truth answer
you're trying to predict) across the conveyor. In raw data the label is present
and trusted. Through features and split it stays attached to each row. At
training it's the target the model fits to. At evaluation it's hidden from the
model and revealed only to score. **At inference it does not exist** — that's the
whole point; you predict it. The label is the thread that ties the offline phase
together and then vanishes.

**Seam.** The load-bearing seam is `train → deploy`: the moment you *freeze* the
model. Before it, you can see labels and tune freely. After it, the model is
fixed and the world keeps moving. Every production-ML failure mode (leakage,
drift, train/serve skew) is a story about something leaking *across* this seam —
either future information leaking left into training, or the live distribution
drifting right away from what you trained on.

## How it works

You already know this shape from a **build-and-deploy pipeline** or a **data
ETL**: stages connected by artifacts, each stage pure-ish, the output of one
feeding the next, and a frozen build artifact at the end you ship and then
monitor in prod. The supervised pipeline is that, with one twist: the artifact
is a *learned function*, and its inputs at serve time must be transformed the
*exact* way they were at train time or the build is silently corrupt.

### Move 1 — the mental model

```
  Mental model — a build pipeline that emits a learned function

  source code  ──► compile ──► test ──► binary ──► deploy ──► monitor
       │             │           │         │          │          │
       ▼             ▼           ▼         ▼          ▼          ▼
  raw+labels ──► features ──► split  ──► fit  ──► evaluate ──► serve ──► drift-watch
       │             │           │        │          │          │          │
   "has the      "shape it    "carve     "learn   "grade on   "apply    "did the
    answer"       into         out a      the      held-out    the       inputs
                  numbers"     held-out   mapping   data"       frozen    drift?"
                               grade"               only        fn
```

Same conveyor your CI runs every day, but the "binary" is a function from
features to a prediction, and the "tests" are run on data the model never saw.
The mapping from raw data to the answer is *learned from examples* instead of
written by hand — that's the only thing that makes it "ML" rather than "code."

### Move 2 — the load-bearing skeleton

Strip it to the minimum that is still a supervised pipeline. Each stage names a
distinct moving part; lose any and the conveyor breaks differently.

```
  Kernel (pseudocode)

  # OFFLINE — runs once, sees labels
  dataset   = load(rows with features X and label y)
  X_clean   = features(dataset)                  # 02 — transforms, FIT on train only
  train, val, test = split(X_clean, by=unit_new_at_inference)   # 03
  model     = fit(train.X, train.y)              # 04 — choose family, learn params
  tune model on val (hyperparams, threshold)     # never touch test
  report    = evaluate(model, test.X, test.y)    # 08 — the honest number
  artifact  = freeze(model, feature_transforms)  # ← THE SEAM

  # ONLINE — runs per request, label does NOT exist
  x_live    = incoming_input
  x_feat    = artifact.feature_transforms(x_live)   # SAME transforms as train
  yhat      = artifact.model.predict(x_feat)
  monitor(x_live, yhat)                          # 15 — watch for drift
```

**Name each part by what breaks without it:**

- **`load` (data + labels).** No labels, no supervised learning — that's the
  definition. Garbage or mislabelled rows here cap the ceiling of everything
  downstream; no model beats its labels.
- **`features` (02).** The transform from raw signal to numbers the model can
  consume. Critically, transforms that *learn* parameters (a mean to subtract, a
  category vocabulary) must be **fit on training data only** and then *applied*
  to val/test/live. Fit them on everything and you've leaked across the seam.
- **`split` (03).** Carve out data the model never sees, so the evaluation
  estimates performance on *new* inputs. The subtle part is splitting at the
  unit that's *new at inference time* (per-user, not per-row) — covered in 03.
- **`fit` (04).** Learn the parameters that minimize error on training data. The
  *family* you fit (logistic regression vs gradient-boosted trees) is the
  model-selection decision — covered in 04.
- **`evaluate` (08).** Score on the held-out test set, once, after tuning is
  done. This is the only number you're allowed to believe.
- **`freeze` — the seam.** Bundle the weights *and the exact feature transforms*
  into one artifact. Ship weights without the transforms and serve time applies
  different math than train time — **train/serve skew**, the most common silent
  prod bug.
- **`monitor` (15).** The frozen model degrades as the live world drifts from
  the training distribution. Watching for that drift is what triggers retraining
  (16). A pipeline with no monitor ships a model that rots invisibly.

**Skeleton vs. hardening.** The seven stages above are the skeleton. Layered on
top in production: experiment tracking (every training run logged — 14), a
feature store (share transforms across models), CI on the pipeline itself, and
automated retraining triggers (16). You can teach the skeleton without any of
that; you cannot run it in prod without most of it.

### Move 3 — the principle

A supervised pipeline is **two conveyors that must agree at one frozen seam.**
The offline conveyor can see the future (labels) and is allowed to peek; the
online conveyor cannot and must not. Every correctness rule in this section is a
way of enforcing that the offline phase doesn't cheat with information the online
phase won't have — and that the two phases compute features identically. Get the
seam right and the rest is tuning; get it wrong and a model that looks brilliant
offline is worthless online.

## Primary diagram

The full conveyor, every stage and artifact labelled. This is the master diagram
the rest of `08` references.

```
  The supervised pipeline — full picture

  ┌──────────────── OFFLINE (sees labels, runs on a schedule) ────────────────┐
  │                                                                            │
  │  [raw data + labels]                                                       │
  │        │                                                                   │
  │        ▼                                                                   │
  │  features  ── fit transforms on TRAIN ONLY ──┐                             │
  │   (02)                                        │                            │
  │        │                                      │                            │
  │        ▼                                      │                            │
  │  split (03) ──► train ──► val ──► test        │                            │
  │        │          │        │       │          │                            │
  │        │          ▼        ▼       │          │                            │
  │        │        fit(04)  tune ─────┤          │  (test untouched until end)│
  │        │          │     hyperparams│          │                            │
  │        │          ▼        ▲       ▼          │                            │
  │        │      [model] ─────┘   evaluate(08) ──┘  ◄── the honest number     │
  │        │          │                                                        │
  │        ▼          ▼                                                        │
  │     freeze(model + feature_transforms) ─────► [ARTIFACT]  ★ THE SEAM       │
  └──────────────────────────────────────────────────┬─────────────────────────┘
                                                       │  deploy
  ┌──────────────── ONLINE (no labels, runs per request) ─▼────────────────────┐
  │  x_live ──► SAME feature_transforms ──► model.predict ──► yhat             │
  │                                                            │               │
  │                                                            ▼               │
  │                                                monitor drift (15) ─► retrain(16)│
  └────────────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Not yet implemented in AptKit — AptKit ships no trained model.** There is no
data stage, no feature pipeline, no split, no fit, no frozen artifact. The
nearest analog is the anomaly-monitoring agent
(`packages/agents/anomaly-monitoring/src/monitoring-agent.ts`), which produces
*classifier-shaped* output (it picks anomaly categories from a checklist) — but
it has no learned decision boundary and no training phase, so it sits entirely on
the right (online) half of the conveyor with nothing behind it.

## Elaborate

The offline/online split is the oldest idea in production ML and predates deep
learning by decades — it's the same separation as compile-time vs run-time. What
changed over the 2010s is the *operational* layer around it (MLOps): feature
stores, experiment trackers, model registries, and CI for pipelines, all of
which exist to police the train→deploy seam at scale. The instinct that AptKit
*does* share is the usage/cost ledger — logging every model call — which is the
same impulse as training-run logging (14): you can't improve what you don't
record.

Adjacent: the LLM-application analog of "training" is **prompt iteration +
eval** — you don't fit weights, but you do tune a system prompt against a
held-out eval set, and the leakage discipline of 03 applies there too (don't
tune on your test cases). What to read next: 02 (the features box), then 03 (the
split box) — those are the two stages this file glossed.

## Project exercises

*Provenance: Phase 2C — Machine learning (C2C.x). No `aieng-curriculum.md`
present; IDs are by-convention. Case B — nothing here exists yet; this is a
thought-experiment plus one small measurable deliverable.*

### Exercise — design (and partly build) a supervised pipeline over AptKit's anomaly data

- **Exercise ID:** `[C2C.1]` Phase 2C, supervised-pipeline concept
- **What to build:** On paper, design the full seven-stage pipeline that would
  turn the anomaly agent's job into a *trained* classifier: what's a row, what's
  the label (e.g. "this 90-day window for this metric is anomalous"), what
  features (deltas vs the category thresholds in
  `packages/agents/anomaly-monitoring/src/categories.ts`), how you'd split
  (per-workspace, not per-window — see 03), which family (04), and how you'd
  evaluate (08). Then land the one buildable slice: a small scorer in
  `packages/evals/` that grades the *existing* LLM anomaly agent's detections as
  if it were a classifier, reusing the precision/recall shape already in
  `packages/evals/src/detection-scorer.ts`.
- **Why it earns its place:** Most LLM-application engineers have never built the
  offline half of this conveyor. Being able to sketch the whole thing *and* show
  you understand where AptKit honestly stops (it has the online half, not the
  offline) is a strong, rare signal — "I've trained a model end-to-end" beats
  "I've called an API."
- **Files to touch:** `packages/evals/` (a new scorer module, the natural AptKit
  home for ML-metric evaluation); the *training* half is honestly **a new
  repo/package** — AptKit is not the natural home for a training loop.
- **Done when:** A one-page pipeline design exists naming every stage's input,
  output, and the seam; and a `packages/evals/` scorer produces a
  precision/recall number over a fixture of anomaly-agent detections.
- **Estimated effort:** `1–3 days` (design `1–4hr`; the scorer slice `1–4hr`)

## Interview defense

**Q: Walk me through a supervised ML pipeline end to end.**
I'd sketch the two conveyors and the seam:

```
  data ─► features ─► split ─► fit ─► evaluate ─► │ FREEZE │ ─► serve ─► monitor
         (train-fit only)    (held-out grade)     ▲
                                            the seam: labels exist left, not right
```

"Seven stages. The offline half sees labels and is allowed to tune; the online
half has no labels and must apply the *same* feature transforms. The whole game
is not cheating across the freeze line — no future info leaking left, transforms
identical on both sides."
*Anchor: every prod-ML bug is a leak across the train→deploy seam.*

**Q: You've shipped an on-device CV model before. Which half of this pipeline did
you actually build?**
"The right half — deploy and serve. In contrl I ran a pretrained MediaPipe pose
model on-device; I owned inference and the runtime, not the training loop or the
feature/split discipline. So I know the serving and drift end cold, and the part
I'm deliberately building up is the offline conveyor: features, leakage-safe
splits, and honest evaluation."
*Anchor: I've shipped the online half; the offline half is the named gap.*

## Validate

- **Reconstruct:** From memory, draw the seven-stage conveyor and mark the seam.
  Check against the Primary diagram above.
- **Explain:** Why must feature transforms be *frozen into the artifact* and not
  recomputed at serve time? (Because recomputing them on live data uses
  different parameters — a different mean, a different category vocabulary — than
  training did; that's train/serve skew, and it silently corrupts every
  prediction.)
- **Apply:** AptKit's anomaly agent already emits category detections. Which
  stages of this pipeline does it have, and which is it missing? (It has only the
  online half — serve. It has no data/label stage, no features, no split, no fit,
  no held-out evaluation. It's a classifier shape with nothing behind the seam.)
- **Defend:** An interviewer says "just train on all your data, it's more
  examples." Why is that wrong? (You'd have no held-out test set, so your
  reported number would be the model grading its own homework — it tells you
  nothing about new inputs, which is the only thing inference faces.)

## See also

- [02-feature-engineering.md](02-feature-engineering.md) — the features stage in depth
- [03-train-val-test.md](03-train-val-test.md) — the split stage; leakage; the unit seen new
- [04-model-selection.md](04-model-selection.md) — choosing the family inside the fit stage
- [README.md](README.md) — the honest banner and the LLM-analog table
