# 03 — Retrieval and RAG

> **AptKit ships no retrieval and no RAG.** No vector store, no embeddings, no
> chunking-for-retrieval, no reranking, no similarity index. This is verified:
> the repo has no SQL or vector database — "data" is file- and stream-shaped
> (trace events, replay artifacts, fixtures, the `WorkspaceDescriptor`). So
> **every file in this section is taught as a foundation, not as a tour of
> existing code.** The mechanism walkthroughs go deep on how the pattern works;
> the **Project exercises are the buildable path** to landing each concept in
> AptKit for real.
>
> You have shipped classic RAG separately — AdvntrCue (Next.js + pgvector +
> GPT-4 + Drizzle, top-k similarity with session memory). That is the right
> mental model to carry in. What this section does is **anchor that model to
> AptKit's code seam**: the place a retrieval layer would attach is the
> `schemaSummary()` / `WorkspaceDescriptor` prompt-context boundary in
> `packages/context`, feeding into `runAgentLoop` / `generateStructured` in
> `packages/runtime`. Retrieved chunks, if AptKit had them, would be rendered
> into the system prompt right next to the workspace summary.

## The one seam you keep coming back to

Every concept here eventually attaches to the same boundary. Worth fixing it in
your head once, up front.

```
  The AptKit prompt-context seam — where retrieved chunks WOULD land

  ┌─ Context layer (packages/context) ───────────────────────────────┐
  │  WorkspaceDescriptor ──► schemaSummary() ──► one string block     │
  │                                                  │                │
  │   ★ a retrieval layer would render top-k chunks into a            │
  │     sibling block right here, next to the schema summary ★        │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  system prompt text
  ┌─ Runtime layer (packages/runtime) ▼────────────────────────────────┐
  │  runAgentLoop({ system, ... })   /   generateStructured(...)        │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  ModelProvider.complete()
  ┌─ Provider layer ──────────────────▼────────────────────────────────┐
  │  anthropic / openai / fixture                                       │
  └─────────────────────────────────────────────────────────────────────┘
```

`schemaSummary()` already does the job a retrieval renderer does: take
structured input and flatten it into a deterministic prompt block. That is why
it is the natural attach point — you would add a second renderer beside it.

## Files

- **[01-embeddings.md](01-embeddings.md)** — text → vector; similarity is
  geometry (cosine of the angle between vectors).
- **[02-embedding-model-choice.md](02-embedding-model-choice.md)** — hosted vs
  local vs domain-tuned; why the choice is one-way (re-embedding cost).
- **[03-chunking-strategies.md](03-chunking-strategies.md)** — fixed /
  sentence-window / structural; the chunk is the unit of retrieval. AptKit's
  `splitMarkdownSections` IS structural chunking — but wired to content
  generation, *not* retrieval. The primitive exists; the retrieval wiring does
  not.
- **[04-vector-databases.md](04-vector-databases.md)** — pgvector / sqlite-vec /
  Pinecone / in-memory table; what an ANN index buys you.
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
- **[11-rag.md](11-rag.md)** — ★ **THE ANCHOR.** retrieve → augment → generate,
  end to end, attached to the `schemaSummary` seam. Includes the above-threshold
  rule: don't bolt RAG onto things that work without it.
- **[12-graphrag.md](12-graphrag.md)** — retrieval over an entity/relationship
  graph; traverse edges instead of ranking a flat list.

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
```

Read **11-rag.md** once the parts make sense — it assembles them. The freshness
files (09, 10) and GraphRAG (12) are the operational and advanced layers on top.

## What lives elsewhere

- **Agentic retrieval** — retrieval as a *loop the model steers* over analytics
  tools (the shape AptKit actually ships) lives in
  `.aipe/study-agent-architecture/02-agentic-retrieval/`. That is the honest
  "retrieval" in this repo; this section is the *vector* foundation it does not
  yet use.
- **Long-term agent memory** — the short-term vs retrieved-memory split is in
  [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md).
  Long-term memory is retrieval; that file and this section are two views of the
  same gap.
- **The prompt-context block** the summaries render into:
  [../02-context-and-prompts/](../02-context-and-prompts/).
