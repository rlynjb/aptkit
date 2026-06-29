# Design an anomaly-detection system

- **The prompt:** "Design a system that detects anomalous behavior in a stream of metrics and alerts when something is wrong."

- **Standard architecture:** The whiteboard is a streaming path from metric ingestion through baseline modeling to a scorer that flags deviations, with an alerting layer that suppresses noise.

  ```
  Anomaly detection — baseline, score, alert
  ┌────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐
  │ metrics│ → │ feature  │ → │ baseline │ → │  scorer  │ → │ alert  │
  │ stream │   │ extract  │   │  model   │   │ + thresh │   │ + dedup│
  └────────┘   └──────────┘   └────┬─────┘   └────┬─────┘   └───┬────┘
                                   ▲              │             │
                              ┌────┴─────┐        │             ▼
                              │ historical│       │       ┌──────────┐
                              │  windows  │       │       │  human   │
                              └───────────┘       │       │ feedback │
                                   ▲              │       └────┬─────┘
                                   └──────────────┴────────────┘
                                     drift detection (PSI) retrains baseline
  ```

  The baseline is the design point: an anomaly is only defined relative to a learned notion of normal, and that normal drifts.

- **Data model:**
  - Metric stream — timestamped metric values per entity, the input.
  - Baseline statistics — per-metric rolling mean/variance/seasonal profile, defining "normal."
  - Scorer thresholds — learned or configured cutoffs per metric, separating noise from signal.
  - Alert log — fired alerts with score, context, and resolution, for dedup and precision tuning.
  - Feedback labels — human "real/false-alarm" judgments, the only ground truth in an otherwise unlabeled problem.

- **Key components:**
  - Feature extraction turns raw metrics into features (deltas, ratios, rolling windows); choice: rolling-window features over raw values so the scorer sees rate-of-change, where anomalies actually live.
  - Baseline model learns per-metric normal, with seasonality; choice: per-metric baselines over one global model because metrics have wildly different scales and rhythms.
  - Scorer flags deviations — statistical (z-score, IQR) or model-based (isolation forest, autoencoder reconstruction error); choice: start with statistical scorers because they're interpretable and need no labels, escalating to a model only when statistics miss multivariate anomalies.
  - Alerting layer thresholds, deduplicates, and groups; choice: dedup and rate-limit at the alert layer so one incident isn't a hundred pages.

- **Scale concerns:**
  - At ~100 metrics per entity multivariate anomalies (correlated shifts) appear that per-metric scorers miss; you need a joint model.
  - At ~1k entities the baseline-retraining job dominates compute; schedule incremental updates rather than full recompute.
  - At seasonal boundaries (daily/weekly cycles) a naive baseline fires false alarms every cycle; the baseline must model seasonality or alert precision collapses.
  - At gradual drift the baseline silently follows the drift and stops flagging a slow degradation; you need PSI drift detection separate from the anomaly scorer.

- **Eval framing:** The problem is mostly unlabeled, so eval leans on the feedback log. Offline, against whatever labeled incidents exist, measure precision@k (of the top-k flagged, how many were real) and recall (of real incidents, how many were flagged). Online, track alert precision (fired alerts that were genuine) and time-to-detection. The tension is always precision vs recall: a scorer that catches everything pages constantly.

- **Common failure modes:**
  - Alert fatigue — too many false positives and operators stop reading; mitigate by tuning the threshold against alert precision and deduping at the alert layer.
  - Seasonal false alarms — the baseline doesn't model cycles and fires every Monday; mitigate with seasonal baselines.
  - Concept drift — normal shifts and the baseline either lags or absorbs the anomaly; mitigate with PSI drift detection that retrains on real shifts but not on incidents.
  - Cold-start metric — a new metric has no baseline; mitigate by widening thresholds until enough history accumulates.

- **Applies to this codebase:** `partially`. The anomaly-monitoring agent (`packages/agents/anomaly-monitoring/`) does flag unusual behavior — it scans metrics against 10 ecommerce anomaly categories and returns a severity-sorted list. But it does this by LLM-scoring metrics against prose category descriptions, not by any statistical or ML scorer. There is no per-metric baseline, no z-score or isolation forest, no PSI drift detection, no learned threshold, and no seasonality model. It's pattern-matching by a language model, which catches things a naive z-score would miss but gives you no calibrated score and no drift handling. Worth noting the LLM analog: hallucination detection in the RAG path is itself a form of anomaly detection (the cited-claim check in `search-knowledge-base-tool.ts:101` flags outputs that deviate from grounded evidence).

- **How to make it apply:** Add a statistical pre-scorer in front of the anomaly-monitoring agent: compute per-metric rolling baselines (mean/variance, seasonal profile) and a PSI drift score over historical windows, persisted to buffr's `agents` schema (`/Users/rein/Public/buffr/sql/001_agents_schema.sql`). Feed the statistically-flagged metrics into the existing LLM agent for categorization and explanation — statistics for detection, LLM for the narrative. Then the detection-scorer eval (`packages/evals/src/detection-scorer.ts`) measures precision/recall against labeled incidents. Statistical anomaly detection and drift scoring are `not yet exercised`; the LLM-over-categories flagging is real.
