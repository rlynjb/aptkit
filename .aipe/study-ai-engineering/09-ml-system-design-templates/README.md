# 09 — ML system design templates (interview reframes)

> Anchor: codebases reframed as interview templates. Curriculum: Phase 5.

Mirror of `07-system-design-templates/` for the ML side. Fixed nine-bullet
shape, generated for every guide regardless of current applicability. For
aptkit the mappings are honest: the recommender and anomaly templates map
`partially` onto the analytics agents (which detect anomalies and propose
recommendations with an LLM, not a trained model); object detection does
not apply to aptkit at all (the reader's contrl project is the anchor for
CV instead).

## Files

- `01-recommender-system.md` — "Design a recommender." Applies `partially` (the recommendation agent is LLM-driven, not a learned ranker).
- `02-anomaly-detection.md` — "Design anomaly detection." Applies `partially` (the anomaly-monitoring agent is LLM-driven over fixed categories).
- `03-object-detection-cv.md` — "Design real-time on-device CV." Applies `no` (anchor: contrl, not aptkit).
