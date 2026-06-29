# 08 — Machine learning (classical)

> Anchor: classical supervised ML (contrl-mo-shaped) — Phase 2C / Phase 3 ML evals / Phase 5 ML hardening.
> For aptkit, this is almost entirely NEW GROUND. Read it as study material.

aptkit trains no model. There is no supervised pipeline, no feature
engineering, no on-device classifier, no recommender. This sub-section
teaches classical ML as new ground (per `me.md`: ML beyond contrl is a
named gap) and frames each concept as a buildable exercise — anchored, when
a concrete project helps, to the reader's contrl project rather than to
aptkit.

**The one genuine bridge:** `08-confusion-matrices.md` and the eval files
connect to aptkit's real `scorePrecisionAtK` / `scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts`). The ranked-retrieval metric is
identical to what evaluates a learned ranker. Everything else is marked
`not yet exercised`.

## Files

- `01-supervised-pipeline.md` — the five stages; `not yet exercised` in aptkit.
- `02-feature-engineering.md` — raw → engineered features; the load-bearing work.
- `03-train-val-test.md` — split discipline; the leak that metrics hide.
- `04-model-selection.md` — LR vs GBT.
- `05-class-imbalance.md` — why accuracy lies; macro-F1, confusion matrix.
- `06-domain-gap.md` — train/inference distribution mismatch.
- `07-transfer-learning.md` — pretrain → fine-tune.
- `08-confusion-matrices.md` — reading the matrix; **the precision@k bridge to aptkit**.
- `09-calibration.md` — predicted probability vs actual frequency.
- `10-recommender-systems.md` — content vs collaborative; single-user case.
- `11-cold-start.md` — new user / new item / new system.
- `12-on-device-inference.md` — server vs device tradeoffs (anchor: contrl).
- `13-quantization.md` — FP32/FP16/INT8/INT4 precision tradeoff.
- `14-training-run-logging.md` — what to log per run.
- `15-drift-detection.md` — PSI; spotting a stale model.
- `16-retraining-pipelines.md` — scheduled / drift-triggered / performance-triggered.
