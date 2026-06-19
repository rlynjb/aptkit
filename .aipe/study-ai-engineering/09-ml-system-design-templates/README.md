# 09 — ML System Design Templates

These are the classical-ML parallels to section 07. Same fixed nine-bullet shape,
but the templates assume a *trained model* — collaborative filtering, a statistical
anomaly detector, a CNN — rather than a pre-trained LLM.

AptKit ships no trained model (see
[`../ml-features-in-this-codebase.md`](../ml-features-in-this-codebase.md) for the
honest statement). What it has instead are LLM agents that occupy the *shape* of
these ML systems: an agent that detects anomalies, an agent that recommends actions,
an agent that scores against a rubric. So for each template the "Applies" bullet is
about whether AptKit performs the *task* — and the "How to make it apply" bullet
names what you would build to replace the LLM with a trained model.

Every file follows the same nine labelled bullets:

1. **The prompt** — the verbatim interview question.
2. **Standard architecture** — the box-and-arrow diagram.
3. **Data model** — what is stored where.
4. **Key components** — named sub-systems, one technical choice each.
5. **Scale concerns** — what breaks first, with concrete thresholds.
6. **Eval framing** — offline/online metrics that matter.
7. **Common failure modes** — what an interviewer probes for, with mitigations.
8. **Applies to this codebase** — `yes` / `partially` / `no`, with a paragraph.
9. **How to make it apply** — the concrete refactor naming real AptKit files.

## Templates

- [01 — Recommender system](./01-recommender-system.md) — Applies: **partially**.
  The recommendation agent has the recommender *shape* (candidate taxonomy, ranked
  by predicted impact, top-3 output, confidence field) but is LLM-driven from a
  diagnosis, not collaborative filtering over interaction logs.
- [02 — Anomaly detection](./02-anomaly-detection.md) — Applies: **partially**
  (the strongest ML-side match). The monitoring agent scans 10 categories against
  per-category thresholds with severity tiering, but scoring is LLM-driven, not a
  statistical/ML model, and there is no retraining loop.
- [03 — Object detection / CV](./03-object-detection-cv.md) — Applies: **no**.
  AptKit has no vision or CV. Walked as canonical architecture only.

## Cross-links

- ML foundations (supervised learning, feature engineering, splits): [`../08-machine-learning/`](../08-machine-learning/)
- The AI-side parallel templates: [`../07-system-design-templates/`](../07-system-design-templates/)
- How AptKit actually uses AI: [`../ai-features-in-this-codebase.md`](../ai-features-in-this-codebase.md)
- The honest ML statement: [`../ml-features-in-this-codebase.md`](../ml-features-in-this-codebase.md)
