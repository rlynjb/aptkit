# B — Agentic Retrieval

The shift from retrieval as a one-shot pipeline step to retrieval as a control loop the agent drives. This is aptkit's headline pattern.

Anchor: single-agent (primary).

This sub-section does NOT re-teach retrieval mechanics (embeddings, chunking, vector stores, ranking) — those live in `.aipe/study-ai-engineering/03-retrieval-and-rag/`. It covers the agent-architecture concern: the model owns *when* to retrieve, the loop owns the *budget*.

## Files

1. [01-agentic-rag.md](01-agentic-rag.md) — **the headline.** Retrieval as a tool the model decides to call (`search_knowledge_base`). ReAct whose primary tool is retrieval.
2. [02-self-corrective-rag.md](02-self-corrective-rag.md) — grade chunks before generating. aptkit's `minTopK` floor + hallucination-tolerant filter are partial, structural versions of this.
3. [03-retrieval-routing.md](03-retrieval-routing.md) — route a query to the right source. aptkit has one source (the vector store); buffr adds pgvector behind the same contract.
