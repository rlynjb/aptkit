# Design a Search Ranking System

- **The prompt:** "Design a search ranking system that takes a user query and returns the top-k most relevant items from a corpus."

- **Standard architecture:**

```
            query
              │
              ▼
   ┌────────────────────┐
   │ Query understanding │  tokenize, spell-correct, intent, expand
   └─────────┬──────────┘
             │
             ▼
   ┌────────────────────────────────────┐
   │        Candidate retrieval          │
   │  ┌──────────┐      ┌─────────────┐  │
   │  │ Sparse    │     │ Dense (ANN)  │  │  fan out wide (k≈1000)
   │  │ inverted  │     │ HNSW over    │  │
   │  │ index BM25│     │ embeddings   │  │
   │  └────┬──────┘     └──────┬──────┘  │
   │       └────── RRF/merge ──┘         │
   └──────────────────┬──────────────────┘
                      │  ~1000 candidates
                      ▼
   ┌────────────────────────────────────┐
   │  Ranking (cross-encoder / learned)  │  score query×doc pairs, expensive
   └──────────────────┬──────────────────┘
                      │  top-k
                      ▼
   ┌────────────────────────────────────┐
   │     Serving  +  click logging       │ → feeds offline training
   └────────────────────────────────────┘
```

- **Data model:**
  - corpus item `{id, text, meta, embedding}` — the indexed unit; embedding is the dense vector.
  - inverted index (sparse) — term → posting list, powers BM25/lexical recall.
  - vector index (HNSW) — approximate-nearest-neighbor graph over embeddings, powers semantic recall.
  - click log `{query, shown_ids, clicked_id, position, dwell_ms, ts}` — the training signal for the learned ranker; the only thing here that gets you off heuristics.

- **Key components:**
  - Query understanding — normalizes and expands the raw query before retrieval; choice: keep spell-correction and expansion *outside* the embedding call so you can A/B them independently without re-embedding the corpus.
  - Candidate retrieval (dense + sparse) — two recall paths merged by Reciprocal Rank Fusion; choice: RRF over a tuned linear blend because RRF needs no per-corpus weight calibration and is robust when the two score distributions are incomparable.
  - Ranking (cross-encoder / learned) — re-scores the merged candidate set with a model that sees query and doc jointly; choice: cross-encoder only over the top ~1000, never the full corpus — joint attention is O(query×doc) and does not scale to corpus size.
  - Serving + logging — returns top-k and records impressions; choice: log impressions *and* positions, not just clicks, so you can correct position bias later.

- **Scale concerns:**
  - At ~10M docs the ANN index exceeds single-node RAM (768-dim float32 ≈ 30GB before graph overhead) → shard by doc id, scatter-gather, merge top-k per shard.
  - At ~1k QPS the cross-encoder rerank is the bottleneck (each query × 1000 candidates = 1000 forward passes) → cache reranks for head queries, cap candidate count, distill to a lighter ranker.
  - At ~100M docs a full re-embed on a model upgrade is a multi-day job → incremental re-embed with an `embedding_version` column and dual-read during migration; never block serving on a backfill.

- **Eval framing:** Offline: hit@k, MRR, NDCG on a labeled query→relevant-doc set — this is exactly the ranked-retrieval shape aptkit's `scorePrecisionAtK` / `scoreRecallAtK` already measure (`/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`); add MRR/NDCG on top for graded relevance. Online: CTR@1–3, dwell time, query reformulation rate (reformulation up = ranking down). A no-click is *not* a negative label — the user may not have seen it, or the answer was in the snippet.

- **Common failure modes:**
  - Stale index — doc edited, vector not refreshed → re-embed on write, version every embedding.
  - Cold / out-of-vocabulary queries — dense retrieval whiffs on rare proper nouns → keep the sparse path as a floor; lexical match never goes cold.
  - Position bias — top results get clicked because they're on top, not because they're better → inverse-propensity weighting or randomized result interleaving in a logging slice.
  - Lost-in-the-middle (if an LLM summarizes results) — the model ignores the middle of a long candidate list → rerank to put the best item first, cap list length.

- **Applies to this codebase:** `partially`. aptkit has the retrieval layer and the offline eval, but not the ranking layer. Dense recall is real: `search_knowledge_base` (`/Users/rein/Public/aptkit/packages/retrieval/src/search-knowledge-base-tool.ts`) runs cosine over nomic-embed-text 768-dim vectors via the `EmbeddingProvider` + `VectorStore` contracts (`/Users/rein/Public/aptkit/packages/retrieval/src/contracts.ts`), backed by `InMemoryVectorStore` in dev and buffr's `PgVectorStore` (pgvector + HNSW, `/Users/rein/Public/buffr/src/pg-vector-store.ts`) in prod. The offline ranked-retrieval eval is real (`precision-at-k.ts`). What's missing is everything that makes it a *search ranking* system: no sparse/BM25 path, no hybrid fusion, no cross-encoder or learned reranker, no click logging, and the queries are RAG-paraphrase-style ("answer this from the KB") rather than search-style ("rank these items for this query").

- **How to make it apply:** Add a "search the knowledge base" surface in Studio that returns ranked results instead of a synthesized answer, reusing the existing `search-knowledge-base-tool.ts` retrieval. Instrument a click log in buffr's `agents` schema (`/Users/rein/Public/buffr/src/pg-vector-store.ts` lives in the same store) — `{query, shown_chunk_ids, clicked, position, ts}`. Add a sparse retriever beside the dense one and merge with RRF. Only once click data exists, train a learned reranker and score the lift with the existing `scorePrecisionAtK`. Order matters: surface → logs → sparse → learned ranker. Do not build the ranker before you have labels.
