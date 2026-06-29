# Design a search and ranking system

- **The prompt:** "Design the search system for a documentation site that returns the most relevant pages for a free-text query."

- **Standard architecture:** The first thing on the whiteboard is the split between the offline indexing path and the online query path, with the ranker as a second stage after candidate retrieval.

  ```
  Search and ranking — two-stage retrieve-then-rank
  ┌──────────┐     ┌──────────┐     ┌──────────────┐
  │ documents│ →   │ chunker  │ →   │ embed + index│   (offline)
  └──────────┘     └──────────┘     └──────┬───────┘
                                           ▼
                                    ┌──────────────┐
                                    │ vector + BM25│
                                    │    index     │
                                    └──────┬───────┘
                                           ▼ (online)
  ┌────────┐   ┌───────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐
  │ query  │ → │ understand│ → │ candidate│ → │ learned  │ → │ results│
  │        │   │ + rewrite │   │ retrieval│   │ reranker │   │        │
  └────────┘   └───────────┘   └──────────┘   └────┬─────┘   └────────┘
                                                   ▲
                                              ┌────┴─────┐
                                              │click logs│ (feature + label source)
                                              └──────────┘
  ```

  The reranker is the part that separates a search system from a similarity lookup: cheap recall first, expensive precision second.

- **Data model:**
  - Inverted index (BM25/sparse) — term → posting list, for lexical recall on rare tokens and exact matches embeddings miss.
  - Vector index (HNSW over dense embeddings) — approximate nearest-neighbor for semantic recall.
  - Document store — raw chunk text + metadata, joined back after retrieval to render results.
  - Click logs — query, shown results, position, click/dwell; the label source for the learned ranker.
  - Feature cache — precomputed per-doc features (popularity, freshness, length) keyed by doc id.

- **Key components:**
  - Query understanding rewrites and expands the raw query (spell-fix, synonym expansion, intent detection); choice: run a cheap deterministic rewrite before any model call so the common case never pays for an LLM.
  - Candidate retrieval pulls a few hundred docs by recall, not precision; choice: hybrid BM25 + vector fused with reciprocal rank fusion, because dense alone misses exact-token queries and sparse alone misses paraphrases.
  - Learned reranker scores the candidate set with a gradient-boosted or cross-encoder model over query-doc features; choice: a pointwise/pairwise GBDT first because it trains on click logs cheaply and is debuggable, upgrading to a cross-encoder only when latency budget allows.
  - Serving layer caps candidate count and reranker depth to hold the latency SLA.

- **Scale concerns:**
  - At ~1M docs the vector index no longer fits a brute-force scan in budget; you need HNSW or IVF approximate search, accepting a recall hit for a latency floor.
  - At ~1k QPS the cross-encoder reranker becomes the bottleneck (one model call per candidate per query); cap reranked candidates to the top ~100 and cache results for hot queries.
  - At ~10M docs reindexing becomes a batch job measured in hours; you need incremental indexing and a freshness SLA, or the index drifts from the corpus.
  - At ~100M click events the ranker training set must be sampled and debiased, or position bias dominates the learned weights.

- **Eval framing:** Offline, you replay logged queries against a labeled set and measure precision@k and recall@k (relevant docs in the top-k), plus NDCG when graded relevance exists. Online, you A/B the ranker and watch click-through rate, mean reciprocal rank of the clicked result, and abandonment. Offline gains that don't move the online metric usually mean the offline labels encode position bias.

- **Common failure modes:**
  - Stale index — corpus changes but the index lags; mitigate with incremental indexing and a freshness SLA on reindex lag.
  - Position bias — the ranker learns "top results get clicked" rather than relevance; mitigate by debiasing click labels (inverse-propensity weighting) or randomized exploration slots.
  - Cold-start queries — rare/novel queries have no logs and the learned ranker has no signal; mitigate by falling back to the lexical+vector score before the ranker has confidence.
  - Vocabulary mismatch — dense-only retrieval misses exact tokens (error codes, IDs); mitigate with the BM25 leg of hybrid retrieval.

- **Applies to this codebase:** `partially`. aptkit has the retrieval layer but not the ranking system. `packages/retrieval/` defines the EmbeddingProvider + VectorStore contracts (`contracts.ts`), an index/query pipeline (`pipeline.ts`), a fixed 512-char / 64-overlap chunker (`chunker.ts`), and an InMemoryVectorStore that does cosine top-k (`in-memory-vector-store.ts`); buffr swaps in a PgVectorStore over pgvector with HNSW cosine `<=>` at `/Users/rein/Public/buffr/src/pg-vector-store.ts`. The `search_knowledge_base` tool (`search-knowledge-base-tool.ts:101`) wraps this with a minTopK floor. But that is candidate retrieval only: there is no second-stage learned reranker, no BM25/hybrid leg, no query understanding or rewrite, and no click logs to learn from. Queries are paraphrase-style against a vector store; ranking by anything other than raw cosine is `not yet exercised`.

- **How to make it apply:** Add click logging first — a table in buffr's `agents` schema (alongside `sql/001_agents_schema.sql`) capturing query, the result chunk ids and positions returned by `search_knowledge_base`, and which chunk the answer cited. Once enough logs accumulate, insert a reranker stage between `pipeline.ts`'s query call and the tool's return in `search-knowledge-base-tool.ts`: take the cosine top-k as candidates, score them with a model trained on the click logs, and reorder. Add a BM25 leg to `contracts.ts` as a second retriever to make it genuinely hybrid. Until those logs exist, the learned reranker is `not yet exercised` and you should say so.
