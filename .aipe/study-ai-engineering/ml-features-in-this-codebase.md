# How aptkit uses ML specifically

This codebase does not currently train, deploy, or serve any classical ML model.
There is no supervised pipeline, no feature engineering, no on-device classifier,
no recommender trained on interactions. The ML engineering concepts in
`08-machine-learning/` are covered as **study material**, not as a description of
code that exists.

That is a deliberate boundary, not an omission. aptkit's analytics capabilities
(anomaly-monitoring, diagnostic-investigation, recommendation) all run a
**pre-trained LLM** behind a prompt + tool policy. They produce things that
*look* ML-shaped — ranked anomalies, recommendations, confidence scores — but
the "model" is Gemma reasoning over a `WorkspaceDescriptor`, not a fitted
classifier with learned weights.

## What's ML-adjacent (but isn't trained ML)

```
  ┌──────────────────────────┬──────────────────┬──────────────────────────┐
  │ Capability               │ Looks like…      │ But actually is…         │
  ├──────────────────────────┼──────────────────┼──────────────────────────┤
  │ anomaly-monitoring agent │ anomaly detection│ LLM scoring metrics      │
  │                          │ model            │ against 10 prose         │
  │                          │                  │ categories — no model    │
  ├──────────────────────────┼──────────────────┼──────────────────────────┤
  │ recommendation agent     │ a recommender    │ LLM generating ≤3 recs   │
  │                          │ system           │ from anomaly+diagnosis — │
  │                          │                  │ no ranking model, no     │
  │                          │                  │ interaction log          │
  ├──────────────────────────┼──────────────────┼──────────────────────────┤
  │ intent classification    │ a text classifier│ keyword heuristic +      │
  │                          │                  │ one-shot LLM — no trained│
  │                          │                  │ classifier               │
  ├──────────────────────────┼──────────────────┼──────────────────────────┤
  │ precision@k / recall@k   │ ML eval metrics  │ genuinely ML metrics —   │
  │ scorers                  │                  │ applied to RETRIEVAL,    │
  │                          │                  │ not to a trained model   │
  └──────────────────────────┴──────────────────┴──────────────────────────┘
```

The one genuinely ML artifact in the repo is the **ranked-retrieval scorer**
(`packages/evals/src/precision-at-k.ts`) — `scorePrecisionAtK` / `scoreRecallAtK`.
These are the same metrics you'd use to evaluate a classifier or a recommender,
but here they grade RAG retrieval quality. That's the bridge: the reader already
holds the eval vocabulary from this repo; Section 08 extends it to trained models.

## What ML in this codebase would require

If aptkit grew a trained model, the cleanest fit would be a learned **reranker**
on top of the cosine retrieval, or a learned **intent classifier** replacing the
keyword heuristic. Both are written up as Case-B project exercises in
`08-machine-learning/` and `09-ml-system-design-templates/`. Neither exists today
— marked `not yet exercised` throughout.

## not yet exercised

- supervised training pipeline (data → features → split → fit → deploy)
- feature engineering / feature store
- train/val/test discipline, model selection (LR vs GBT)
- class imbalance handling, calibration, confusion matrices over a trained model
- on-device inference, quantization, drift detection, retraining pipelines

These belong to the **classical supervised ML shape** — trained models with
labeled data, feature engineering, and deployment — which this codebase is not.
They are taught as new ground in Section 08.
