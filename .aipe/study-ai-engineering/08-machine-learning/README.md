# 08 — Machine learning

> Anchor: classical / trained ML. · Curriculum: Phase 8 (no curriculum file in
> this repo; exercises cite real aptkit/buffr paths instead).

Read this first, because the framing is unusual for this study set: **aptkit has
no trained machine-learning model.** No supervised pipeline, no feature
engineering, no fitted classifier, no recommender trained on interactions, no
on-device inference, no computer vision. aptkit runs *pre-trained LLMs* behind a
prompt + tool policy. So every file in this section is study ground — the
pattern is taught, then plainly marked `Not yet exercised in aptkit`.

That is honest, not apologetic. You have built one ML pipeline before (pose
landmarking), so the *shape* of "data → features → model → metric" is not new.
What is new is classical supervised ML as a discipline: feature engineering as
the load-bearing 60–80%, train/val/test splits that prevent leakage, class
imbalance, calibration, drift. This section closes that gap.

## The one real bridge — you already hold the eval vocabulary

aptkit ships genuine ML evaluation metrics. They just grade *retrieval* instead
of a trained model:

```
  The bridge: same metrics, different subject

  ┌─ aptkit today ──────────────────┐      ┌─ trained-model world ───────────┐
  │ precision@k / recall@k          │ same │ precision / recall / F1 over a  │
  │ over RETRIEVED document ids     │ math │ CLASSIFIER's predicted labels   │
  │ packages/evals/precision-at-k.ts│ ◄──► │ confusion matrix, per-class     │
  │ detection-scorer.ts             │      │ macro-F1, calibration curve     │
  └─────────────────────────────────┘      └─────────────────────────────────┘
   matched / min(k,retrieved)               TP / (TP+FP)
   matched / |relevant|                     TP / (TP+FN)
```

`scorePrecisionAtK` / `scoreRecallAtK` (`packages/evals/src/precision-at-k.ts`)
compute `matched / min(k, retrieved)` and `matched / |relevant|` with
distinct-hit counting. `scoreDetections` (`packages/evals/src/detection-scorer.ts`)
scores detection-like outputs as `matched / missed / unexpected` — the exact
shape of a classification confusion. Throughout this section the recurring move
is: *you already use this metric on retrieval; here is the trained-model version.*

## Where ML would actually live

When an exercise needs a concrete target, it uses one of two natural aptkit
extensions — never an invented app:

- **A learned reranker** over retrieval hits — buffr's `PgVectorStore.query()`
  returns `{ id, score, meta }[]` (`/Users/rein/Public/buffr/src/pg-vector-store.ts`);
  a trained model could re-score those hits. Labeled data already exists in
  `/Users/rein/Public/buffr/eval/queries.json`.
- **A learned intent classifier** replacing the keyword heuristic in
  `packages/agents/query/src/intent.ts`.

## Files (self-contained per concept)

1.  `01-supervised-pipeline.md` — data → features → split → train → deploy; the whole arc
2.  `02-feature-engineering.md` — raw → fixed numeric features; the load-bearing 60–80%
3.  `03-train-val-test.md` — split at the unit seen new at inference; leakage
4.  `04-model-selection.md` — LR vs GBT; train both, pick the simpler that wins
5.  `05-class-imbalance.md` — accuracy lies; macro-F1, per-class recall, weights/SMOTE/focal/threshold
6.  `06-domain-gap.md` — train vs inference distribution mismatch; normalization/augmentation/adaptation
7.  `07-transfer-learning.md` — pretrain → fine-tune; for tabular = retrain on personal data
8.  `08-confusion-matrices.md` — read it; per-class precision/recall/F1 derivation
9.  `09-calibration.md` — predicted prob vs actual frequency; Platt/isotonic; bridge to retrieval scores
10. `10-recommender-systems.md` — content vs collaborative vs hybrid; single-user = content + rules
11. `11-cold-start.md` — new user / new item / new system mitigations
12. `12-on-device-inference.md` — server vs on-device; model < 50MB, latency budget
13. `13-quantization.md` — FP32 / FP16 / INT8 / INT4 size · speed · quality
14. `14-training-run-logging.md` — log data/feature/hyperparam/metric versions per run; bridge to replay artifacts
15. `15-drift-detection.md` — PSI; train vs prod distribution shift
16. `16-retraining-pipelines.md` — scheduled / drift-triggered / performance-triggered
