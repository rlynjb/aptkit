# 02 — Agentic Retrieval

**Anchor: single-agent (primary).**

The standout pattern in aptkit. This sub-section does **not** re-teach retrieval mechanics (embeddings, chunking, vector DBs, RRF, reranking — those live in `study-ai-engineering/03-retrieval-and-rag/`). It covers the shift from retrieval as a *one-shot pipeline step* to retrieval as a *control loop the agent drives* — purely an agent-architecture concern, and the most interesting decision in the repo.

The key move: **retrieval is exposed as a tool the model calls when it judges it needs grounding**, not a prompt-splice the framework injects. The model owns *when* to retrieve; the loop owns the *budget*. `search_knowledge_base` (`packages/retrieval/src/search-knowledge-base-tool.ts`) is that tool; `rag-query` (`packages/agents/rag-query/src/rag-query-agent.ts`) is the agent that drives it.

Read in order:

1. `01-agentic-rag.md` — retrieval as a tool the model drives; the rag-query agent.
2. `02-self-corrective-rag.md` — aptkit's partial version: the `minTopK` floor + hallucination-tolerant `matchesFilter` guard.
3. `03-retrieval-routing.md` — not yet exercised; one store today, the multi-source refactor.
