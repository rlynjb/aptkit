# 09 — ML system-design templates

> Anchor: LLM application engineering. · Curriculum: Phase 3 (no curriculum file
> in this repo; exercises cite real aptkit/buffr paths instead).

Interview reframes for the classical-ML design loop. These are the canonical
"design a recommender," "design anomaly detection," "design object detection"
prompts — the ones that expect candidate generation, ranking models, feature
pipelines, and trained classifiers. Same code, different framing.

The shape matches `07-system-design-templates/`: prompt, standard architecture,
data model, components, scale concerns, eval framing, failure modes, then the
honest verdict and the refactor that would close the gap.

Be honest in the room: aptkit is an LLM-application toolkit, not a classical-ML
system. There is no trained model, no candidate generator, no interaction log, no
feature store. The "recommendation agent" is an LLM, not a fitted recommender.
The "anomaly-monitoring agent" scores prose against categories, not metrics
against baselines. So two of these three verdicts run `no` or weak `partially`,
and that is the correct answer — the value is walking the canonical architecture
and naming the exact seam where aptkit would have to grow a model.

## Files (self-contained per template)

1. `01-recommender-system.md` — candidate gen + ranking model; why aptkit's recommendation agent is an LLM, not a recommender
2. `02-anomaly-detection.md` — statistical scorers + drift; the anomaly-monitoring agent scores prose, not metrics
3. `03-object-detection-cv.md` — the canonical CV pipeline; aptkit has no vision, walked as out-of-shape
