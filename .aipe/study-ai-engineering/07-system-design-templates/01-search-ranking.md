# Search Ranking System Design

- **The prompt:** "Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus."

- **Standard architecture:**

  ```text
  Search ranking pipeline
  ────────────────────────────────────
  Query
    │
    ▼
  ┌──────────────────────────────────┐
  │ Query understanding              │
  │  (tokenize, expand, rewrite)     │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Candidate retrieval              │
  │  (dense + sparse, top-N)         │
  └──────────────┬───────────────────┘
                 │  N candidates (N=500)
                 ▼
  ┌──────────────────────────────────┐
  │ Ranking                          │
  │  (cross-encoder, learned model)  │
  └──────────────┬───────────────────┘
                 │  top-k (k=10)
                 ▼
  ┌──────────────────────────────────┐
  │ Serving + logging                │
  │  (cache, instrument, return)     │
  └──────────────┬───────────────────┘
                 │
                 ▼
              Results
  ```

- **Data model:**
  - Document corpus with `{id, text, metadata, created_at, embedding}` per item.
  - Inverted index for sparse retrieval (BM25 term → doc IDs).
  - Vector index for dense retrieval (embedding → doc IDs, ANN via HNSW).
  - Click/interaction logs with `{query, doc_id, position, clicked, dwell_time}` — the training signal for offline learning.

- **Key components:**
  - *Query understanding*: rewrites for better retrieval (synonym expansion, typo correction, HyDE). Decision: rule-based for latency, LLM-rewrite only for hard queries.
  - *Retrieval*: hybrid dense + sparse with RRF fusion. Decision: keep both — sparse catches exact terms, dense catches paraphrases.
  - *Ranking*: cross-encoder rerank on top-N. Decision: only rerank when retrieval confidence is low (gated by bi-encoder margin) to bound latency.
  - *Serving*: cache top-k per query, instrument latency-per-stage and recall@k.

- **Scale concerns:**
  - At ~10M docs: ANN index exceeds RAM on a single node. Shard by doc-id range, query shards in parallel.
  - At ~1k QPS: cross-encoder rerank becomes the latency bottleneck. Cache reranks for popular queries; distill the cross-encoder for cold queries.
  - At ~100M+ docs: a full corpus re-embed on model upgrade becomes multi-day. Carry `embedding_version` per doc, dual-serve during migration.

- **Eval framing:**
  - Offline: hit@k, MRR, NDCG on a held-out query-doc relevance set.
  - Online: click-through rate at positions 1–3, dwell time, query reformulation rate (drops when ranking is good).
  - "No-click is not a negative label" — a user who does not click may have read the snippet and gotten the answer.

- **Common failure modes:**
  - Stale index → query returns deprecated docs. Mitigation: `embedding_stale_at` tracking, re-embed on edit.
  - Cold queries → no click data to learn from. Mitigation: query-similarity fallback, sparse-only retrieval.
  - Position bias in training data → model learns "position 1 is good," not "this doc is good." Mitigation: inverse propensity scoring or randomized sessions.
  - Lost-in-the-middle when results feed a downstream LLM → mid-ranked results get ignored. Mitigation: surface top-3 only or restructure the prompt.

- **Applies to this codebase:** **No / partially.** AptKit has no retrieval or ranking layer at all: no embeddings, no inverted index, no vector index, no click logs, no learned reranker. There is nothing in the repo that scores a corpus against a query. The closest thing is the **query agent** (`packages/agents/query/src/query-agent.ts`), but it does not *retrieve and rank* — it answers a natural-language question by calling a least-privilege allowlist of ~49 read-only analytics tools (`queryToolPolicy.allowedTools`) inside the bounded agent loop (`packages/runtime/src/run-agent-loop.ts`), then synthesizing a plain-prose answer. That is tool-augmented Q&A, not search ranking. The model decides *which tool to call*, and the tool returns structured analytics; there is no candidate set, no relevance score, and no top-k cut over documents. The only place a top-k cut exists in the repo is the monitoring agent's severity-sorted `.slice(0, 10)` over anomalies (`packages/agents/anomaly-monitoring/src/monitoring-agent.ts`), which ranks detections, not search results. So: structurally absent. In an interview, say "I have not built search ranking; here is what I would add."

- **How to make it apply:** This is a build, not a reframe. Three steps, in order:
  1. **Add a retrieval layer.** AptKit currently has none — see the foundations in [`../03-retrieval-and-rag/`](../03-retrieval-and-rag/). You would embed a corpus (e.g. the capability inventory in `docs/`, or workspace catalog items reached today via `list_catalog_items`/`get_catalog_item`), store embeddings, and add ANN search. This becomes a new `packages/retrieval` package alongside `packages/tools`.
  2. **Add click logging.** Reuse the existing trace backbone: emit a new `CapabilityEvent` variant (`packages/runtime/src/events.ts`) when a user opens a result, persisted as NDJSON the same way traces already are. That gives you the `{query, doc_id, position, clicked}` log the template wants for free.
  3. **Add a learned reranker** once you have ~500 logged clicks. Sit it on top of cosine similarity, score it offline with NDCG, and wire it through the existing eval seam (`packages/evals/src/replay-runner.ts`) so reranker changes are caught by replay.

  Honest framing for the interview: AptKit proves I can build a *tool-augmented* retrieval system (the model retrieves via tool calls, not a vector index). Search ranking is the version where retrieval is over an indexed corpus with a learned ranker — adjacent skill, not yet exercised here.
