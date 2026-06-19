# 08 — Machine learning (classical, supervised, on-device)

**Honest banner, read this first.** AptKit ships **no trained machine-learning
model**. There is no supervised learner, no feature-engineering pipeline, no
train/val/test split, no on-device inference, no quantized weights, no
collaborative-filtering recommender. AptKit is a pure LLM-application toolkit: a
bounded agent loop, structured-output generation, a provider abstraction, a
token/cost ledger, and a replay-driven eval layer. **Every concept in this
section is taught as new ground** — none of it is exercised in the repo today.

That honesty is the point. This section exists because the classical-ML
vocabulary (features, leakage, class imbalance, calibration, drift, retraining)
is a known gap for the reader, who has built exactly one ML pipeline — on-device
pose landmarking with MediaPipe in a computer-vision app. That gives you a real
anchor for *on-device inference* and *the supervised-pipeline shape*; the rest
(class weights, confusion matrices, PSI drift, recommender families) is new.
Each file teaches the pattern in full depth, then says plainly where AptKit
stands.

## The LLM analogs — close in shape, not in kind

Three AptKit agents have the *shape* of a classical-ML task, but they are
LLM agents, not trained models. The guide notes these analogies where they
genuinely help, and refuses to overclaim:

```
  Classical-ML task        →  AptKit's LLM analog (NOT a trained model)

  multi-class classifier   →  anomaly-monitoring agent
                              (LLM picks anomaly categories from a checklist;
                               no learned decision boundary, no training data)
  recommender / ranker     →  recommendation agent
                              (LLM proposes ≤3 actions grounded in a diagnosis;
                               no collaborative filtering, no learned ranker)
  scoring model            →  rubric-judge in @aptkit/evals
                              (LLM scores against a rubric; no regression head)
```

The most useful honest connection: AptKit's `detection-scorer.ts`
(`packages/evals/src/detection-scorer.ts`) already computes
precision/recall-shaped numbers over the anomaly agent's category detections. If
you treated that agent as a classifier and evaluated it, the confusion matrix in
`08-confusion-matrices.md` is exactly the artifact you'd build — and AptKit
stops one step short of building it.

## Concept files

```
01-supervised-pipeline.md     data → features → split → train → deploy
02-feature-engineering.md     turning raw signals into model inputs
03-train-val-test.md          split discipline; leakage; the unit seen new
04-model-selection.md         logistic regression vs gradient-boosted trees
05-class-imbalance.md         macro-F1, class weights, SMOTE, focal loss
06-domain-gap.md              train/inference distribution mismatch
07-transfer-learning.md       reuse a pretrained model on a new task
08-confusion-matrices.md      ← CONNECT: evaluate the anomaly agent as a classifier
09-calibration.md             predicted probability vs actual frequency
10-recommender-systems.md     ← CONNECT: recommendation agent is a recommender SHAPE
11-cold-start.md              new user / new item / new system
12-on-device-inference.md     server vs on-device (your contrl background)
13-quantization.md            FP32 / FP16 / INT8 / INT4
14-training-run-logging.md    ← CONNECT: AptKit's usage-ledger is the same instinct
15-drift-detection.md         PSI; ← CONNECT: conceptual cousin of anomaly detection
16-retraining-pipelines.md    scheduled / drift / performance triggers
```

## Reading order

`01` is the spine — read it first; every other file is a station on that
pipeline. `03` (split discipline) and `05` (class imbalance) are the two that
interviewers probe hardest, so read those next. `08`, `10`, `14`, and `15` carry
the honest AptKit connections and are worth reading even if you skim the
genuinely-distant files (`07`, `12`, `13`).

## What "Project exercises" means in this section

Every file ends with a Case-B exercise: the buildable target that would make the
concept real in AptKit. Be clear-eyed — **adding a trained ML pipeline to AptKit
is a large stretch.** AptKit is not the natural home for a training loop. So for
the deep-ML files the exercise is honestly a thought-experiment or a small,
measurable deliverable you *can* land here: most often, evaluating an existing
LLM agent's outputs with an ML metric inside `packages/evals/`. The exercise IDs
follow a `Phase 2C [C2C.x]` convention (there is no `aieng-curriculum.md` in the
repo; IDs are by-convention).

The interview signal these exercises chase: **having actually trained and
evaluated a model is rare among LLM-application engineers.** Closing even a
small slice of this gap — building one confusion matrix over the anomaly agent's
detections — is disproportionately valuable.
