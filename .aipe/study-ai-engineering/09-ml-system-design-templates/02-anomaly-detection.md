# Design an Anomaly Detection System

- **The prompt:** "Design an anomaly detection system that flags unusual events in a stream of data."

- **Standard architecture:**

```
         event stream
              │
              ▼
   ┌──────────────────────────┐
   │ Feature extraction        │  windowed aggregates, per-entity normalize
   └────────────┬─────────────┘
                │
                ▼
   ┌──────────────────────────┐
   │ Anomaly scoring           │  statistical (z/EWMA) or ML
   └────────────┬─────────────┘
                │
                ▼
   ┌──────────────────────────┐
   │ Threshold / severity tier │
   └────────────┬─────────────┘
                │ above threshold
                ▼
   ┌──────────────────────────┐
   │ Alert + log + human review │
   └────────────┬─────────────┘
                │ human labels
                ▼
   ┌──────────────────────────┐
   │ Feedback → next training   │
   └──────────────────────────┘
```

- **Data model:**
  - event stream `{entity_id, ts, metrics...}` — the raw signal, partitioned by entity.
  - per-entity baseline `{entity_id, mean, variance, window, updated_at}` — the "normal" each event is compared against; per-entity because one global baseline drowns small entities.
  - anomaly log `{ts, entity_id, score, threshold, severity, action, human_label?}` — every flag and its disposition; the `human_label` is the future training signal.
  - alert state `{entity_id, last_alert_ts, suppressed_until}` — debounce so one incident isn't 500 alerts.

- **Key components:**
  - Feature extraction — turns raw events into windowed, per-entity-normalized features; choice: normalize per entity, not globally — a value normal for entity A is an anomaly for entity B.
  - Anomaly scoring — assigns an outlier score; choice: start statistical (z-score / EWMA residual) before ML — it needs no labels, is explainable to the on-call, and sets the baseline ML must beat.
  - Threshold + severity tiering — converts score to action; choice: tiers (info/warn/critical) over a single cutoff, so high-volume low-severity flags don't page a human.
  - Human review + feedback — labels a sampled top-N of flags; choice: review only the top-N by severity — humans are the scarce resource, spend them on the flags most likely to be real.

- **Scale concerns:**
  - At ~10k events/sec stream processing is the bottleneck → shard the stream by entity_id so scoring parallelizes and per-entity state stays local.
  - At ~1M entities per-entity baselines blow memory → tier baselines hot/cold, keep active entities in memory and page the long tail from store.
  - At a high false-positive rate the *humans* become the bottleneck → tighten for precision first, route only top-N severity to review; alert fatigue kills the system faster than missed anomalies.

- **Eval framing:** Offline: precision, recall, F1 on a labeled anomaly set — anomalies are imbalanced by default, so report macro-F1, not accuracy (a "never anomalous" model scores 99% accuracy and is useless). aptkit's anomaly-monitoring output is scored by a detection-scorer (`/Users/rein/Public/aptkit/packages/evals/src/detection-scorer.ts`) — that's the offline detection harness. Online: human-review agreement rate and time-to-acknowledge. LLM analog: hallucination detection *is* anomaly detection — same precision/recall framing over "is this output an outlier".

- **Common failure modes:**
  - Concept drift — "normal" shifts, baselines lag → PSI on the feature distribution triggers a baseline refresh / retrain.
  - Alert fatigue — too many false positives, humans stop looking → tune for precision early, severity-tier aggressively.
  - New-entity cold-start — no baseline yet, everything looks anomalous → grace period plus a population prior until the entity accrues history.
  - Threshold staleness — a fixed cutoff that drifts out of calibration → periodically recalibrate thresholds against recent labeled flags.

- **Applies to this codebase:** `partially`. aptkit's anomaly-monitoring agent (`/Users/rein/Public/aptkit/packages/agents/anomaly-monitoring/`) scans metrics across 10 fixed ecommerce categories and returns severity-sorted anomalies, scored by the detection-scorer (`/Users/rein/Public/aptkit/packages/evals/src/detection-scorer.ts`). But it is LLM-driven over analytics tools inside a bounded `runAgentLoop` with a tool-policy allowlist — *not* a statistical or ML anomaly model. There are no per-entity baselines, no EWMA/z-score scoring, no PSI, no learned detector, and no human-label feedback loop. The output shape (severity-sorted flags) and the offline scorer are right; the detection mechanism is an LLM judgment, not a model.

- **How to make it apply:** Add per-entity baseline statistics and a statistical scorer (z-score / EWMA residual) as a *pre-LLM gate* in `/Users/rein/Public/aptkit/packages/agents/anomaly-monitoring/` — heuristic-before-LLM, so cheap statistics flag candidates and the LLM only explains the survivors. Add a PSI check on category metric distributions to trigger baseline refresh. Wire a human-review / feedback log into buffr's `agents` schema (store layer `/Users/rein/Public/buffr/src/pg-vector-store.ts`) so labels accumulate, and keep scoring with the existing `detection-scorer.ts`. The statistical gate is the change that turns "LLM eyeballs the metrics" into "a detector the LLM annotates."
