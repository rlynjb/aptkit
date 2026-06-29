# Design a recommender system

- **The prompt:** "Design a recommender that picks the items to show each user on a feed or product page."

- **Standard architecture:** The whiteboard is the two-stage funnel — cheap candidate generation that narrows millions of items to hundreds, then an expensive ranking model that orders them — fed by an interaction log that closes the loop.

  ```
  Recommender — candidate generation then ranking
  ┌────────┐   ┌──────────────┐   ┌──────────┐   ┌──────────┐   ┌──────┐
  │ user + │ → │  candidate   │ → │ ranking  │ → │ business │ → │ feed │
  │ context│   │  generation  │   │  model   │   │  rules   │   │      │
  └────────┘   └──────┬───────┘   └────┬─────┘   └──────────┘   └──┬───┘
                      ▲                ▲                            │
              ┌───────┴───────┐  ┌─────┴──────┐                    │
              │ item embeddings│  │  features  │                   │
              │ + popularity   │  │   store    │                   │
              └───────┬────────┘  └─────┬──────┘                   │
                      └─────────────────┴──────────────────────────┘
                                  interaction log (impressions, clicks)
  ```

  The interaction log is the spine: it is both the training label source and the feature source. No log, no recommender.

- **Data model:**
  - Interaction log — user, item, action (impression/click/convert), timestamp; the label and feature source.
  - Item embeddings + popularity — per-item vectors and counters for candidate generation by similarity or trend.
  - User/session features — recent history, context, demographics, keyed for the ranker.
  - Feature store — precomputed user×item features served at low latency at ranking time.
  - Trained model artifacts — versioned ranking model with the feature schema it expects.

- **Key components:**
  - Candidate generation narrows the catalog to a few hundred items by ANN over embeddings, collaborative-filtering neighbors, and popularity; choice: blend several cheap recall sources because any single one has a blind spot.
  - Ranking model scores each candidate for the target action (p(click), p(convert)); choice: a gradient-boosted tree or two-tower DNN trained on the interaction log, picked over heuristics because it learns feature interactions the log reveals.
  - Feature store serves consistent features offline (training) and online (serving); choice: one store for both to avoid train/serve skew.
  - Business-rules layer applies diversity, freshness, and policy constraints after ranking; choice: keep these out of the model so they're auditable and tunable without retraining.

- **Scale concerns:**
  - At ~1M items brute-force scoring is impossible; candidate generation via ANN is mandatory before ranking ever runs.
  - At ~10M daily interactions the ranker must retrain on a schedule (daily/hourly) or it drifts behind user behavior.
  - At ~1k QPS the feature-store lookup and model inference dominate latency; precompute user features and cap candidates to the low hundreds.
  - At launch (zero log) cold-start dominates: new users and new items have no interactions, so the system must fall back to popularity and content similarity until signal accumulates.

- **Eval framing:** Offline, replay the interaction log and measure ranking quality with NDCG, precision@k/recall@k on held-out clicks, and AUC for the click model. Online, A/B the model and watch click-through rate, conversion, and long-term engagement — offline AUC gains routinely fail to move online conversion because the log is biased toward what the old model showed.

- **Common failure modes:**
  - Cold-start — new users/items have no interactions; mitigate with popularity and content-based fallback until signal exists.
  - Feedback loop / filter bubble — the model only learns from items it chose to show; mitigate with exploration slots and impression logging, not just click logging.
  - Train/serve skew — features differ between training and serving; mitigate with a single feature store.
  - Popularity bias — the ranker collapses to recommending head items; mitigate with diversity rules and debiased labels.

- **Applies to this codebase:** `no` (at best a weak `partially`). aptkit's "recommendation agent" (`packages/agents/recommendation/`) is an LLM that produces ≤3 grounded recommendations from an anomaly plus a diagnosis — it is a prompt over a language model, not a recommender system. There is no candidate generation, no ranking model, no interaction log, no feature store, and no cold-start handling. Nothing is trained or fitted. The recommendations are reasoned text, not scored items pulled from a catalog and ordered by a model. None of the funnel above exists; calling this a recommender in an interview would be dishonest.

- **How to make it apply:** This is a stretch and you should frame it as one. The closest real ranking surface in aptkit is "which anomaly to surface first" — the anomaly-monitoring agent already produces a severity-sorted list (`packages/agents/anomaly-monitoring/`). To turn that into a recommender: log which surfaced anomalies an operator acted on (impressions + actions) into buffr's `agents` schema (`/Users/rein/Public/buffr/sql/001_agents_schema.sql`), accumulate enough interactions, then train a reranker that orders anomalies by p(operator acts) instead of by LLM-assigned severity. That gives you a genuine candidate set (the flagged anomalies), a label (acted/ignored), and a ranking model. Until that log and model exist, a trained recommender is `not yet exercised`.
