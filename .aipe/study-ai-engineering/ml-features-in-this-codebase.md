# How This Codebase Uses ML

Be honest about this up front:

> **AptKit ships no trained ML model and runs no classical-ML inference.** The AI
> engineering concepts in section 08 are covered as study material; the Project
> exercises identify the features that *could* be added. Where AptKit performs
> tasks that are classically ML-shaped — anomaly detection, recommendation,
> scoring — those are implemented as LLM agents (sections 04/05), not trained
> models.

There is no training pipeline, no labeled dataset, no feature matrix, no model
weights, no model registry, and no inference call to a fitted model anywhere in the
repo. The data model is file- and stream-shaped (trace events, replay artifacts,
fixtures, workspace metadata) — none of it is training data. Every "intelligent"
decision in AptKit is made by a pre-trained LLM behind the `ModelProvider.complete()`
contract.

This matters for interviews: most candidates have only *consumed* pre-trained
models. Having *trained* one is the rarer signal. AptKit demonstrates the AI
engineering discipline (prompts, tool use, evals, bounded loops, replay) — not the
classical-ML discipline (data quality, feature engineering, train/val/test, drift).
Do not claim the latter from this codebase.

## LLM analogs and their classical-ML counterparts

Three AptKit agents occupy the *shape* of a classical-ML system without being one.
The distinction below is the honest version to give an interviewer.

| AptKit LLM agent | Classical-ML counterpart | The honest distinction |
| --- | --- | --- |
| `anomaly-monitoring-agent` (`packages/agents/anomaly-monitoring`) | Anomaly detection model (isolation forest / autoencoder / LightGBM) | Same architecture — feature extraction → scoring → threshold → severity tier → top-N. But scoring is **LLM judgment against static per-category thresholds**, not a fitted model over a learned baseline distribution. No anomaly log, no labels, no retraining loop. |
| `recommendation-agent` (`packages/agents/recommendation`) | Recommender model (collaborative filtering / learned ranker) | Same shape — candidate taxonomy, ranked by predicted impact, top-3, confidence field. But candidates are **LLM-generated from a diagnosis**, not retrieved from a catalog; ranking is **prose estimation**, not a model trained on an interaction log. Effectively one "user" (one workspace), so no collaborative signal. |
| `rubric-judge` / `rubric-improvement-agent` (`packages/evals/src/rubric-judge.ts`, `packages/agents/rubric-improvement`) | A scorer / classifier | Same job — map an input to a score and a verdict. But it is **LLM-as-judge with a structured rubric and a validator**, not a classifier trained on labeled examples. The rubric's calibration examples anchor the scale; they are not a training set. |

The structural takeaway: AptKit proves the LLM-agent version of these three
patterns. Replacing the LLM with a trained model in any of them is a real ML
project — collect labels, engineer features, split, train, evaluate, monitor for
drift — not a config change. Each template's "How to make it apply" bullet in
section 09 names that path concretely.

## Where to go next

- **Foundations** — supervised learning pipeline, feature engineering, train/val/test
  split discipline, classical metrics: [`08-machine-learning/`](./08-machine-learning/).
- **Reframes** — the three ML system-design templates and exactly what you would
  build to make each apply: [`09-ml-system-design-templates/`](./09-ml-system-design-templates/).
- **What AptKit actually does** — the five live AI features and their specs:
  [`ai-features-in-this-codebase.md`](./ai-features-in-this-codebase.md).
