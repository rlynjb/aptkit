# Anomaly Detection System Design

- **The prompt:** "Design an anomaly detection system that flags unusual events in a stream of data."

- **Standard architecture:**

  ```text
  Anomaly detection pipeline
  ────────────────────────────────────
  Event stream
    │
    ▼
  ┌──────────────────────────────────┐
  │ Feature extraction               │
  │  (windowed aggregates,           │
  │   normalize per-entity)          │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Anomaly scoring                  │
  │  (statistical / ML model)        │
  └──────────────┬───────────────────┘
                 │
            ┌────┴─────┐
   score    │          │ score
 < threshold▼          ▼ > threshold
   Pass through    ┌─────────────────┐
                   │ Alert + log     │
                   │  + human review │
                   └────────┬────────┘
                            ▼
                   Feedback labels feed
                   next training cycle
  ```

- **Data model:**
  - Event stream with `{timestamp, entity_id, features, raw_payload}`.
  - Baseline statistics per entity (rolling mean, std, P95) for normalization.
  - Anomaly log with `{timestamp, score, threshold, action, human_label?}` — ground truth for retraining.
  - Alert state per entity (currently anomalous, cooldown timer, recent score history).

- **Key components:**
  - *Feature extraction*: windowed aggregates over the stream, normalized per-entity. Decision: tumbling windows for predictable latency, sliding windows when smoothness matters.
  - *Anomaly scoring*: isolation forest or autoencoder unsupervised; LightGBM when labels exist. Decision: start unsupervised, switch to supervised after collecting labeled anomalies.
  - *Thresholding*: dynamic per-entity threshold from baseline distribution + business tolerance. Decision: percentile-based, not absolute — adapts to distribution shift.
  - *Alerting*: deduplication, cooldown, severity tiering.
  - *Human review loop*: flagged events go to a review queue; labels feed retraining.

- **Scale concerns:**
  - At ~10k events/sec: stream processing bottlenecks. Shard by `entity_id`, process shards independently.
  - At ~1M entities: per-entity baselines blow up memory. Tiered baselines — hot in memory, cold in DB.
  - High false-positive rate at scale: humans cannot review every alert. Tiered severity, only top-N reviewed, the rest auto-escalated only on repeat.

- **Eval framing:**
  - Offline: precision/recall/F1 on labeled anomalies (ground truth is hard to get).
  - Online: human-review accuracy ("of flagged events, what fraction were real?"), missed-anomaly rate (needs retrospective labeling).
  - Imbalanced data is the default — anomalies are rare. Macro-F1 over accuracy.

- **Common failure modes:**
  - Concept drift — what counts as anomalous changes. Mitigation: PSI on input distribution, retraining trigger when PSI exceeds threshold.
  - Alert fatigue — too many false positives, humans stop reviewing. Mitigation: tune for precision over recall early, add severity tiers.
  - Cold-start for new entities — no baseline, everything looks anomalous. Mitigation: grace period or population-level prior.
  - LLM analog — hallucination detection *is* anomaly detection: score outputs, threshold, escalate flagged ones to human review.

- **Applies to this codebase:** **Partially — and this is the strongest match of the three ML templates.** The **anomaly-monitoring agent** (`packages/agents/anomaly-monitoring/src/monitoring-agent.ts`) walks the canonical architecture almost box-for-box:
  - **Feature extraction = tool-driven metric queries.** The agent's read-only allowlist (`anomalyMonitoringToolPolicy`) is `execute_analytics_eql`, `get_metric_timeseries`, `get_segments`, `get_anomaly_context` — it pulls windowed metrics per scope, which is the feature-extraction stage expressed as tool calls.
  - **Scoring against per-category thresholds.** It scans the 10 `ECOMMERCE_ANOMALY_CATEGORIES` (`packages/agents/anomaly-monitoring/src/categories.ts`), and each category carries explicit `thresholds.warning` and `thresholds.critical` percentages, rendered into the prompt by `formatCategoryChecklist()` as "warning >= X%, critical >= Y%." That is the thresholding stage with concrete, per-category cutoffs — exactly the "percentile/business-tolerance threshold" the template wants.
  - **Severity tiering and a top-N cut.** Output anomalies carry `severity: critical | warning | info | positive`, and `scan()` sorts by an explicit `severityRank` map (`critical:3 … positive:0`) then `.slice(0, 10)`. That is the template's "severity tiering" plus "only top-N reviewed."
  - **Structured-output discipline with recovery.** The loop parses the model's JSON anomalies via `tryParseAnomalies`, and on a parse miss runs a recovery turn (`buildRecoveryPrompt`) that converts the gathered tool evidence into the final array. This is the structured detection contract the eval layer then checks (`assertAnomalyShape`, `scoreDetections` in `packages/evals`).

  Where it diverges, honestly: **scoring is LLM-driven, not a statistical or ML model.** There is no isolation forest, no autoencoder, no fitted baseline distribution — the model reads metrics through tools and *judges* whether a category's threshold is breached. There is **no anomaly log, no human-label field, and no retraining loop**: anomalies are returned and the cycle ends. The thresholds are *static per category*, not dynamic per-entity. So the left half of the diagram (extract → score → threshold → tier → alert) is genuinely built; the closing loop (human review → label → retrain) is absent.

- **How to make it apply:** Two changes turn this from "LLM that flags anomalies" into a full detection pipeline with a feedback loop:
  1. **Add a labeled-anomaly log + feedback loop.** Persist each flagged anomaly as `{timestamp, metric, scope, severity, category, human_label?}` as NDJSON alongside `artifacts/replays/`. The detection-scorer (`packages/evals/src/detection-scorer.ts`) already scores anomalies against expected categories/metrics/scopes/severities — feed *confirmed* labels back as the `requiredCategories` expectations, and promote confirmed runs to fixtures via `scripts/promote-replay-to-fixture.mjs`. That closes the offline-eval loop with real ground truth instead of hand-written expectations.
  2. **Treat the diagnostic agent as the human-review analog.** The template's "human review queue → labels feed retraining" maps onto AptKit's existing pipeline: the anomaly-monitoring agent flags, the **diagnostic-investigation agent** (`packages/agents/diagnostic-investigation`) tests hypotheses against the flag — which is exactly the "is this flagged event real?" review step. Wire the diagnosis verdict back onto the anomaly log as the `human_label?` analog, and you have the labels needed to tune thresholds (or eventually fit a statistical scorer to replace the LLM judgment on the high-volume categories).

  The supervised-scorer step (replacing LLM scoring with a fitted model once labels exist) draws on the foundations in [`../08-machine-learning/`](../08-machine-learning/). The pipeline framing — monitor → diagnose → recommend — is the orchestration covered in [`../../study-agent-architecture/`](../../study-agent-architecture/).
