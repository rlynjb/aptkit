# Design a Recommender System

- **The prompt:** "Design a recommender system that surfaces N items per user from a catalog of M items, maximizing engagement."

- **Standard architecture:**

```
          user_id + context
                 │
                 ▼
   ┌──────────────────────────────────┐
   │     Candidate generation           │  M items → ~1000
   │  ┌────────────┐  ┌──────────────┐ │
   │  │ Content     │  │ Collaborative │ │
   │  │ (ANN over   │  │ (co-engage /  │ │
   │  │  item embs) │  │  matrix fact) │ │
   │  └─────┬──────┘  └──────┬───────┘ │
   │        └──── union ──────┘         │
   └────────────────┬──────────────────┘
                    │  ~1000 candidates
                    ▼
   ┌──────────────────────────────────┐
   │  Ranking (learned)                 │  predict P(engage | user,item)
   └────────────────┬──────────────────┘
                    │  scored
                    ▼
   ┌──────────────────────────────────┐
   │  Re-rank + business rules          │  diversity, freshness, cold-start
   └────────────────┬──────────────────┘
                    │  top-N
                    ▼
   ┌──────────────────────────────────┐
   │  Serving  +  impression/click log  │ → training data
   └──────────────────────────────────┘
```

- **Data model:**
  - item catalog `{id, features, content_embedding, meta}` — what can be recommended; embedding powers content candidate-gen.
  - user profile `{id, long_term_prefs, recent_context}` — the query side of the recommendation.
  - interaction log `{user, item, ts, action, dwell, position}` — every impression and engagement; this is the model's entire training set and the position field is what lets you de-bias it.
  - model registry `{model_id, version, trained_on, metrics}` — which ranker is live and what it scored, so you can roll back.

- **Key components:**
  - Candidate generation — narrows M items to ~1000 with cheap recall; choice: union of content (ANN over item embeddings) and collaborative (co-engagement) so a new user with no history still gets content candidates.
  - Ranking (learned) — predicts engagement probability per (user, item) pair; choice: a learned model over hand-tuned weights, because engagement is non-linear in features and you have the interaction log to fit it.
  - Re-rank + business rules — applies diversity, freshness, and cold-start exploration after scoring; choice: rules *after* the learned score, never baked into it, so policy changes don't require retraining.
  - Serving + logging — returns top-N and logs impressions with positions; choice: log impressions, not just clicks — you cannot correct position bias from clicks alone.

- **Scale concerns:**
  - At ~100k items a full candidate scan per request is too slow → ANN over item embeddings to get candidates in sublinear time.
  - At ~10M users the training data outgrows a single node → distributed training and negative downsampling (engagement is rare; don't train on every non-click).
  - At ~1B impressions/day feature-store lookups dominate latency → precompute and cache features for hot users, batch the cold ones.

- **Eval framing:** Offline: precision@k, recall@k, MRR, NDCG on held-out interactions — the candidate-generation step is scored *exactly* like ranked retrieval, which is the shape aptkit's `scorePrecisionAtK` / `scoreRecallAtK` already implement (`/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`). Online: CTR, dwell, session length, return rate, via A/B with control = current rules and treatment = learned ranker. A no-click is *not* a negative label — un-engaged ≠ disliked.

- **Common failure modes:**
  - Filter bubble — the ranker over-exploits known preferences → an explicit diversity constraint in the re-rank stage.
  - New-item cold-start — no interactions, never surfaced, never gets interactions → an exploration quota that forces fresh items into some slots.
  - Position bias — top slots get clicked because they're top → inverse-propensity weighting or a randomized logging slice.
  - Drift — preferences shift, model goes stale → scheduled retrain plus a Population Stability Index trigger on feature distributions.

- **Applies to this codebase:** `partially`. aptkit's recommendation agent (`/Users/rein/Public/aptkit/packages/agents/recommendation/`) proposes ≤3 grounded actions — but it is LLM-driven over read-only analytics tools inside a bounded `runAgentLoop`, *not* a learned ranker. There is no interaction log, no learned model, no collaborative filtering, no candidate-generation/ranking split. What aptkit *does* have that transfers directly is the offline ranking eval: `scorePrecisionAtK` / `scoreRecallAtK` (`/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`) is precisely how you'd score a recommender's candidate-generation recall. So the measurement half is real; the model half is not.

- **How to make it apply:** Instrument an interaction log in buffr's `agents` schema (store layer at `/Users/rein/Public/buffr/src/pg-vector-store.ts`) — `{user, surfaced_action, position, accepted, ts}`. Frame the recommendation agent's "which action to surface first" as a ranking surface and score that ordering with the existing `scorePrecisionAtK` against accepted actions. Only after the interaction log has volume, introduce a learned ranker over those features and A/B it against the current LLM ordering. The honest move in an interview: "I have the offline ranking eval and a candidate generator; I do not yet have the logged interactions a learned ranker needs — here's how I'd bootstrap them."
