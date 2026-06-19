# Recommender System Design

- **The prompt:** "Design a recommender system that surfaces N items per user from a catalog of M items, maximizing user engagement."

- **Standard architecture:**

  ```text
  Recommender pipeline
  ────────────────────────────────────
  User context (history, profile)
    │
    ▼
  ┌──────────────────────────────────┐
  │ Candidate generation             │
  │  (content + collaborative,       │
  │   reduce M → ~1000)              │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Ranking                          │
  │  (learned model, predict         │
  │   engagement probability)        │
  └──────────────┬───────────────────┘
                 │  top-N
                 ▼
  ┌──────────────────────────────────┐
  │ Re-ranking / business rules      │
  │  (diversity, freshness,          │
  │   fairness, cold-start fallback) │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Serving + logging                │
  │  (impressions, clicks, dwell)    │
  └──────────────┬───────────────────┘
                 │
                 ▼
              N items shown
  ```

- **Data model:**
  - Item catalog with `{id, features, content embeddings, metadata, created_at}`.
  - User profile with `{id, demographics, explicit preferences, derived features}`.
  - Interaction log with `{user_id, item_id, timestamp, action, dwell, position}` — the training signal for collaborative filtering.
  - Model registry: trained candidate-gen and ranking models with versions, training snapshots, eval metrics.

- **Key components:**
  - *Candidate generation*: hybrid content-based + collaborative. Decision: content-based first (handles cold-start), collaborative once a user has ≥ N interactions.
  - *Ranking*: gradient-boosted trees on engineered features. Decision: GBT over neural for tabular features at this scale; Two-Tower if scale grows.
  - *Re-ranking*: enforces diversity, freshness, fairness. Decision: deterministic rules over learned policies for interpretability.
  - *Cold-start*: new user → popular items by demographic prior; new item → content similarity to engaged items.

- **Scale concerns:**
  - At ~100k items: full candidate-gen scan too slow. ANN index over item embeddings, retrieve top-1000.
  - At ~10M users: training data exceeds single-node fit. Distributed training, downsample negatives.
  - At ~1B impressions/day: feature-store lookups bottleneck. Precompute user features offline, cache hot users in memory.

- **Eval framing:**
  - Offline: precision@k, recall@k, MRR, NDCG on held-out interactions.
  - Online: click-through rate, dwell time, session length, return rate.
  - A/B: control arm (rules / popular) vs treatment arm (learned). "No-click is not a negative label."
  - Single-user case: keep a rules-only control arm and a learned experimental arm; log which arm produced each session.

- **Common failure modes:**
  - Filter bubble — recommends the same cluster repeatedly. Mitigation: explicit diversity constraint in re-ranking.
  - Cold-start for new items — never shown, never accumulates signal. Mitigation: exploration quota (top-K always includes one new item).
  - Position bias in training data. Mitigation: inverse propensity scoring, randomized exploration sessions.
  - Drift — preferences shift, model lags. Mitigation: retraining cadence + drift detection (PSI on input distribution).

- **Applies to this codebase:** **Partially.** The **recommendation agent** (`packages/agents/recommendation/src/recommendation-agent.ts`) has the recommender *shape* without any of the recommender *machinery*. The shape match is real:
  - **Candidate space = an action taxonomy.** Recommendations are drawn from `DEFAULT_ACTION_TAXONOMY` — `scenario`, `segment`, `campaign`, `voucher`, `experiment` (`packages/prompts/src/recommendation.ts`, `packages/agents/recommendation/src/types.ts`). That is the catalog of M items the recommender chooses from.
  - **Ranking by predicted impact.** The prompt instructs the model to "order recommendations by predicted impact, highest first" and to estimate dollar impact with a stated assumption. That is the ranking stage's job — predict engagement/value and sort by it.
  - **A top-N cut.** `propose()` returns `parsed.slice(0, 3)` — at most 3 actions, the recommender's "N items shown."
  - **A confidence field.** Each recommendation carries `confidence: high | medium | low`, the interpretability hook the re-ranking stage usually owns.

  Where it diverges: this is **LLM-driven generation from a diagnosis, not collaborative filtering over interaction logs.** The input is not a user's interaction history — it is a `Diagnosis` object produced upstream by the diagnostic agent (the monitor → diagnose → recommend pipeline). There is **no interaction log, no trained ranking model, no candidate-generation retrieval, and no learned engagement probability.** Impact is *estimated by the model in prose*, not predicted by a model fit on clicks. And there is effectively **one "user"** — a single workspace — so there is no collaborative signal across users to filter on. The recommender architecture's load-bearing parts (the interaction log and the learned ranker) are exactly the parts AptKit does not have. The bounded loop is tight by design: `maxTurns 6`, `maxToolCalls 4`, with read-only feature-discovery tools (`recommendationToolPolicy`) used only to avoid duplicating live work, not to retrieve candidates.

- **How to make it apply:** The path from "LLM that proposes actions" to "recommender that ranks learned candidates":
  1. **Log which recommendations the merchant acts on.** Today recommendations are returned and forgotten. Add an outcome record — `{recommendation_id, bloomreachFeature, acted_on, observed_impact}` — persisted as NDJSON alongside `artifacts/replays/`. The `id` is already assigned per recommendation by `idGenerator` in `propose()`, so you have the join key for free. This is the missing interaction log.
  2. **After a threshold of logged outcomes, add a learned ranker.** Once you have enough `acted_on` labels, fit a simple model (logistic regression or GBT) over features the agent already produces — `bloomreachFeature` type, estimated impact range, effort, the diagnosis category — to predict action-probability. Replace the LLM's prose ordering with the learned score, and keep the LLM only for *generating* candidate actions. That is the standard "rules v1 → learned v2 after threshold" progression, and it matches the single-user A/B framing in the template: control arm = LLM-ordered, treatment arm = learned-ranked, log which arm produced each session.
  3. **Add diversity / cold-start re-ranking** as deterministic rules over the top-3 (no two same-`bloomreachFeature` actions, always include one untried action type) — the interpretable re-ranking layer the template calls for.

  Foundations for the learned-ranker step are in [`../08-machine-learning/`](../08-machine-learning/) (feature engineering, train/val/test split discipline).
