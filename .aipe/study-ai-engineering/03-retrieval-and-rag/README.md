# 03 — Retrieval and RAG

> Anchor: LLM application engineering (loopd-shaped) — Phase 2A/2B.
> aptkit retrieves over an indexed document corpus; buffr swaps the durable store.

The from-scratch RAG pipeline, built behind two swappable contracts
(`EmbeddingProvider`, `VectorStore`, `packages/retrieval/src/contracts.ts`).
This is the deepest, most defensible sub-section: real index/query paths, a
real cosine store, a real pgvector drop-in (buffr), and the **signature
hallucinated-filter bug + fix + the floor that prevents retrieval starvation**.

## Files

- `01-embeddings.md` — text → 768-dim vector; the geometric picture; nomic-embed-text.
- `02-embedding-model-choice.md` — why nomic, why local, the one-way-door of dimension.
- `03-chunking-strategies.md` — fixed-size 512-char windows with 64-char overlap; the chunker.
- `04-vector-databases.md` — InMemoryVectorStore (aptkit) vs PgVectorStore (buffr, pgvector+HNSW).
- `05-dense-vs-sparse.md` — aptkit is dense-only; sparse is `not yet exercised`.
- `06-hybrid-retrieval-rrf.md` — `not yet exercised`; the buildable exercise.
- `07-reranking.md` — `not yet exercised`; gated on measured retrieval quality.
- `08-query-rewriting-hyde.md` — `not yet exercised`; the exercise.
- `09-stale-embeddings.md` — aptkit doesn't track staleness; buffr's `embedding_model` column is the slot.
- `10-incremental-indexing.md` — upsert-by-id is the incremental primitive; full re-index is the fallback.
- `11-rag.md` — the full pipeline + the `search_knowledge_base` tool, minTopK floor, the hallucinated-filter fix.
- `12-graphrag.md` — `not yet exercised`; the exercise.

Read `11-rag.md`, `04-vector-databases.md`, and `01-embeddings.md` first.
