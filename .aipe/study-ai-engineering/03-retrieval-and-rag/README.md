# 03 — Retrieval and RAG

> Anchor: LLM application engineering (RAG over a corpus). · Curriculum: Phase 2
> (no curriculum file in repo; exercises cite real aptkit/buffr paths).

This is the heart of aptkit. The retrieval pipeline is **built from scratch over
two contracts** — `EmbeddingProvider` and `VectorStore` — so the vendor (nomic /
OpenAI / pgvector / in-memory) is incidental. The same two contracts power both
RAG and episodic memory.

The signature story lives here: a weak local model passing a hallucinated
`filter` argument used to wipe every search result. The fix
(`matchesFilter`, `search-knowledge-base-tool.ts:101`) is the clearest
"I-built-this-and-hit-a-real-bug" evidence in the repo. Read `04-vector-databases`
and `11-rag` for the spine, then `04`/`09` for the failure modes.

## Files (self-contained per concept)

1. `01-embeddings.md` — text → 768-dim vector; cosine as semantic distance
2. `02-embedding-model-choice.md` — nomic local; the one-way door (re-embed to switch)
3. `03-chunking-strategies.md` — aptkit's fixed-size 512/64-char chunker; why deterministic
4. `04-vector-databases.md` — InMemoryVectorStore vs buffr's PgVectorStore; same contract
5. `05-dense-vs-sparse.md` — aptkit is dense-only; sparse/BM25 `not yet exercised`
6. `06-hybrid-retrieval-rrf.md` — the pattern; `not yet exercised` (dense-only today)
7. `07-reranking.md` — two-stage retrieval; `not yet exercised`; the natural next build
8. `08-query-rewriting-hyde.md` — `not yet exercised`; where it would slot in
9. `09-stale-embeddings.md` — freshness; buffr's `embedding_model` column; re-embed story
10. `10-incremental-indexing.md` — buffr's upsert-on-conflict as incremental indexing
11. `11-rag.md` — the full pipeline; index path + query path; the spine of the repo
12. `12-graphrag.md` — `not yet exercised`; the pattern and aptkit's flat-corpus reality
