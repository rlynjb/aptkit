# 03 — Retrieval and RAG

> **AptKit now ships a real vector RAG pipeline** — built from scratch this
> session in `@aptkit/retrieval`, provider-neutral, runnable with zero cloud.
> What's in-repo and tested: an embedding provider (nomic-embed-text, 768-dim,
> over local Ollama), an in-memory cosine vector store, a fixed-size character
> chunker, the index/query pipeline (`doc→chunk→embed→upsert`;
> `query→embed→search→rank`), and a `search_knowledge_base` tool that wraps the
> query path. The capstone `@aptkit/agent-rag-query` assembles it into a grounded
> RAG agent (retrieve → ground → cite). And **`@aptkit/memory` now points that same
> machine at a second corpus — past conversation exchanges** (RAG over history;
> `13-conversation-memory.md`). So **most files in this section are now a tour of
> real code, not a foundation taught against a gap.**
>
> What's deliberately *out of scope for aptkit* and lives in the **buffr** repo:
> the durable `PgVectorStore` / Supabase pgvector persistence and the live
> precision@k-over-a-real-corpus eval run. aptkit ships the in-memory pipeline +
> the scorers; buffr is the running body. A few concepts here are still genuinely
> *not yet exercised* anywhere in aptkit (embedding-model swap, sparse/hybrid,
> reranking, query-rewriting, stale/incremental, GraphRAG) — those keep their
> Project-exercise framing.
>
> You also shipped classic *cloud* RAG separately — AdvntrCue (Next.js + pgvector
> + GPT-4 + Drizzle). That's the cloud mirror of what's now in-repo as
> **local-first**: same three stages, nomic instead of OpenAI embeddings,
> in-memory instead of pgvector, Gemma instead of GPT-4.

## The one seam you keep coming back to

The retrieval seam in aptkit is **the tool boundary**, not a prompt-render
boundary. The agent doesn't get chunks spliced into its system prompt up front —
it *calls* `search_knowledge_base` mid-loop, the tool runs the query path, and
the ranked chunks come back as a tool result the model reads. Fix this in your
head once.

```
  The AptKit retrieval seam — the search_knowledge_base tool boundary

  ┌─ Agent layer (packages/agents/rag-query) ────────────────────────┐
  │  RagQueryAgent → runAgentLoop  ── model decides to call ──┐       │
  │                                  search_knowledge_base    │       │
  └──────────────────────────────────────────────────────────┼───────┘
                                      tool call: {query,top_k}│
  ┌─ Retrieval layer (packages/retrieval) ◄───────────────────┘───────┐
  │  pipeline.query(q, k):  embed(q) ─► store.search ─► ranked chunks  │
  │       │  results returned to the model as a tool result            │
  └────────────────────────────────────┬───────────────────────────────┘
                                        │  EmbeddingProvider / VectorStore
  ┌─ Adapters ─────────────────────────▼───────────────────────────────┐
  │  OllamaEmbeddingProvider (nomic, 768)   InMemoryVectorStore (cosine)│
  │  (PgVectorStore is the buffr drop-in behind the same VectorStore)   │
  └─────────────────────────────────────────────────────────────────────┘
```

The contrast worth holding: AptKit's *analytics* agents ground via tool calls to
exact metric endpoints (agentic retrieval, no vectors). The *rag-query* agent
grounds via a tool call to a **vector** search. Same agent-loop machinery, same
tool seam — the difference is only what sits behind the tool.

## Files

★ = backed by real in-repo code now.

- **[01-embeddings.md](01-embeddings.md)** ★ — text → vector; similarity is
  geometry (cosine of the angle between vectors). Real: `OllamaEmbeddingProvider`
  (nomic, 768) + `cosineSimilarity` in `InMemoryVectorStore`.
- **[02-embedding-model-choice.md](02-embedding-model-choice.md)** ★ — hosted vs
  local vs domain-tuned; why the choice is one-way (re-embedding cost). Real:
  aptkit picked nomic-768-local; the 768-dim is the one-way door, enforced by a
  dimension-mismatch throw.
- **[03-chunking-strategies.md](03-chunking-strategies.md)** ★ — fixed /
  sentence-window / structural; the chunk is the unit of retrieval. Real: the
  retrieval pipeline ships a **fixed-size character chunker** (`chunker.ts`,
  512/64). AptKit *also* has a structural `splitMarkdownSections` (content gen).
  Two chunkers, two purposes.
- **[04-vector-databases.md](04-vector-databases.md)** ★ — pgvector / sqlite-vec /
  Pinecone / in-memory table; what an ANN index buys you. Real:
  `InMemoryVectorStore` (brute-force cosine) ships now; `PgVectorStore` is the
  buffr drop-in behind the same `VectorStore` contract.
- **[05-dense-vs-sparse.md](05-dense-vs-sparse.md)** — embeddings vs BM25;
  meaning-match vs term-match.
- **[06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md)** — fuse two
  rankings with Reciprocal Rank Fusion: `score(doc) = Σ 1/(k + rank)`.
- **[07-reranking.md](07-reranking.md)** — cheap bi-encoder retrieve → expensive
  cross-encoder rerank; the two-stage funnel.
- **[08-query-rewriting-hyde.md](08-query-rewriting-hyde.md)** — fix the query
  before you search; HyDE embeds a hypothetical answer.
- **[09-stale-embeddings.md](09-stale-embeddings.md)** — vectors drift from their
  source text; `embedding_stale_at` and re-embed-on-change.
- **[10-incremental-indexing.md](10-incremental-indexing.md)** — full rebuild vs
  delta indexing; only re-touch what changed.
- **[11-rag.md](11-rag.md)** ★ — **THE ANCHOR.** retrieve → augment → generate,
  end to end. Now real: `@aptkit/agent-rag-query` runs it through the
  `search_knowledge_base` tool inside `runAgentLoop` (retrieve → ground → cite).
  Includes the above-threshold rule: don't bolt RAG onto things that work without
  it (aptkit's *analytics* agents are the "no" case).
- **[12-graphrag.md](12-graphrag.md)** — retrieval over an entity/relationship
  graph; traverse edges instead of ranking a flat list.
- **[13-conversation-memory.md](13-conversation-memory.md)** ★ NEW — **RAG over
  history.** Same embed→store→search machine, but the corpus is past Q/A exchanges.
  Real: `@aptkit/memory` (`createConversationMemory`) reuses the
  `EmbeddingProvider`+`VectorStore` contracts; `remember` tags rows `kind:'memory'`,
  `recall` over-fetches then filters. Shared-vs-dedicated store is the one knob.

## Reading order

```
  01 embeddings ──► 02 model choice ──► 03 chunking
       │                                     │
       ▼                                     ▼
  05 dense/sparse ──► 06 hybrid/RRF ──► 07 reranking
       │                                     │
       ▼                                     ▼
  04 vector DBs                        08 query rewrite/HyDE
       │                                     │
       └──────────────► 11 RAG ◄─────────────┘   ← the anchor; read after the parts
                          │
                          ▼
       09 stale embeddings ──► 10 incremental indexing ──► 12 GraphRAG
                          │
                          └──────────► 13 conversation-memory  ← RAG over history
```

Read **11-rag.md** once the parts make sense — it assembles them. The freshness
files (09, 10) and GraphRAG (12) are the operational and advanced layers on top.
**13-conversation-memory.md** is the same pipeline pointed at a second corpus (past
exchanges instead of documents) — read it after 11 to see how little it took to
build episodic memory once document RAG existed.

## What lives elsewhere

- **Durable persistence + live eval run** — `PgVectorStore` / Supabase pgvector
  and the precision@k run over a real corpus live in the **buffr** repo (the
  running service that assembles these packages). aptkit ships the in-memory
  store + the scorers; buffr binds them to a database and a real knowledge base.
- **Agentic retrieval** — retrieval as a *loop the model steers* over analytics
  tools lives in `.aipe/study-agent-architecture/02-agentic-retrieval/`. AptKit
  now ships *both* shapes: vector RAG (this section, `rag-query` agent) and
  agentic-over-tools (the analytics agents). The above-threshold rule (11-rag.md)
  is how you choose between them.
- **The rag-query agent's orchestration** — the bounded-loop wiring, the
  least-privilege tool policy, the forced-synthesis turn — is taught from the
  agent-orchestration lens in `.aipe/study-agent-architecture/`. This section
  owns the *retrieval mechanics*; that lens owns the *loop*.
- **Long-term agent memory** — no longer a gap. `@aptkit/memory` ships it, and the
  *mechanics* (RAG over past exchanges) live in this section at
  [13-conversation-memory.md](13-conversation-memory.md). The *taxonomy* (short-term
  `messages` array vs long-term retrieval, and that no aptkit loop auto-calls it yet)
  lives in
  [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md).
- **The prompt-context block** the summaries render into:
  [../02-context-and-prompts/](../02-context-and-prompts/).
