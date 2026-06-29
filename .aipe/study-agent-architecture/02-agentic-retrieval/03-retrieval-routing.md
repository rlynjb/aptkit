# Retrieval Routing

**Industry term:** retrieval routing (route a query to the right knowledge source before retrieving). *Industry standard.*

## Zoom out, then zoom in

When there are multiple knowledge sources, route the query to the right one before retrieving. It's SECTION A's routing pattern applied to retrieval. aptkit has one source today — but its retrieval contract is built precisely so more can be added behind it.

```
  Zoom out — one source now, the seam for many

  ┌─ Tools layer ───────────────────────────────────────────────┐
  │  search_knowledge_base ─► RetrievalPipeline                  │ ← we are here
  └───────────────────────────────┬──────────────────────────────┘
                                   │ VectorStore contract
  ┌─ Retrieval layer ───────────────▼───────────────────────────┐
  │  InMemoryVectorStore (now) │ PgVectorStore (buffr, same      │
  │                            │ contract) │ SQL / web (drop-ins)│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit retrieves from one vector store via one `search_knowledge_base` tool. There's no router picking between a vector store, a relational store, and live search — because there's only one source. But the `VectorStore` contract is vendor-neutral, so buffr swaps in `PgVectorStore` with no agent change. Multi-source routing is `not yet exercised`; the seam that would enable it is live.

## The structure pass

**Layers.** A router (picks the source) over multiple source-specific retrievers.

**Axis: dependency — what does the agent depend on, the source or the contract?** aptkit depends on the `VectorStore` *contract*, not a concrete store. That inversion is what makes routing addable.

**The seam.** The `VectorStore` / `EmbeddingProvider` contract boundary. Today one adapter sits behind it; a router would sit *in front* of several.

## How it works

**Use case it would fit:** a personal assistant that needs the vector store for "what did I write about X," a relational store for "how many entries last week" (exact count), and live search for "what's the news today" (freshness). aptkit answers only the first; the others would need new sources and a router.

### Move 1 — the mental model

It's the `switch`-by-model router from [../01-reasoning-patterns/07-routing.md](../01-reasoning-patterns/07-routing.md), except the cases are knowledge sources instead of handlers. Pick the source that can actually answer, then retrieve.

```
  query → ┌──────────────────────────┐
          │ router: which source?    │
          └──────────┬───────────────┘
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     vector DB    SQL DB     web search
     (semantic)   (exact)    (fresh)
```

### Move 2 — the walkthrough

**aptkit has one source, behind a swappable contract.** The pipeline is wired to one embedder + one store, validated at wiring time:

```ts
// pipeline.ts:73 — one validated wiring; the store is injected, not named
export function createRetrievalPipeline(wiring: RetrievalWiring): RetrievalPipeline {
  assertWiring(wiring);   // embedder.dimension === store.dimension, or throw loud
  return {
    embedder: wiring.embedder,
    store: wiring.store,
    index: (doc) => indexDocument(doc, wiring),
    query: (query, topK) => queryKnowledgeBase(query, wiring, topK),
  };
}
```

`store` is whatever implements `VectorStore` — `InMemoryVectorStore` in aptkit, `PgVectorStore` in buffr. That's *adapter* swapping, not *routing*: it picks one store at wiring time, it doesn't pick among several per query.

**The dimension guard is a one-way door.** `assertWiring` (`pipeline.ts:22`) throws if the embedder and store dimensions disagree — a corpus embedded at 768 dims can only be searched by a 768-dim query. This matters for routing: each source would need its own dimension-matched wiring, and a router would have to keep them straight.

**What multi-source routing would add.** A classifier in front of `search_knowledge_base` (or several tools, one per source) that picks the source, plus per-source pipelines. The query agent's `classifyIntent` ([../01-reasoning-patterns/07-routing.md](../01-reasoning-patterns/07-routing.md)) is the exact shape — a cheap model classify — pointed at sources instead of intents. `not yet exercised`.

**Why the contract is the win even with one source.** Because buffr proves the swap works: same agent code, `PgVectorStore` instead of `InMemoryVectorStore`, no change above the contract. A router is "several adapters plus a picker" — and the adapters already plug in cleanly. The hard part (the neutral contract) is done.

### Move 3 — the principle

A single vector store is rarely the whole answer in production — routing between a vector store (paraphrase queries), a relational store (exact lookups), and live search (freshness) is what production retrieval looks like. aptkit isn't there, but its retrieval-neutral contract means routing is "add adapters plus a picker," not "rebuild retrieval." The senior read: the boundary is right even though only one source sits behind it.

## Primary diagram

```
  aptkit retrieval — one source, the seam for many

  query ─► search_knowledge_base ─► RetrievalPipeline
                                        │ VectorStore contract (the seam)
                                        ▼
                            ┌───────────────────────────┐
                            │ ONE store, picked at wiring │  ← today
                            │ InMemory (aptkit) /         │
                            │ PgVector (buffr)            │
                            └───────────────────────────┘
       a router would sit HERE ▲ (classify → pick source), per query
       not yet exercised:  vector | relational | web, chosen per query
```

## Elaborate

Retrieval routing is the production answer to "one index can't serve every query shape." Semantic search is great for paraphrase, terrible for exact counts; SQL is the reverse; neither is fresh. The router picks per query. aptkit's contribution to this story is the *seam*: by depending on `VectorStore` rather than a concrete store, it already supports adapter swapping (the buffr pgvector binding), which is the precondition for routing. The remaining work — a picker and multiple live sources — is additive, not structural.

## Interview defense

**Q: aptkit has one knowledge source. Is that a limitation?**

For multi-shape queries, yes — one vector store can't do exact counts or fresh data. But the retrieval contract is vendor-neutral: the agent depends on `VectorStore`, not a concrete store, which buffr proves by swapping in `PgVectorStore` with no agent change. Routing is "add adapters plus a per-query picker" — the hard part, the neutral contract, is already done.

```
  today:  query → search_knowledge_base → ONE store (picked at wiring)
  router: query → classify source → vector | SQL | web   (additive)
```

*Anchor: the boundary is right even with one source behind it — routing is adapters + a picker, not a rebuild.*

## See also

- [../01-reasoning-patterns/07-routing.md](../01-reasoning-patterns/07-routing.md) — the routing pattern this applies to sources.
- [01-agentic-rag.md](01-agentic-rag.md) — the loop a router would feed.
- The retrieval-neutral contract and buffr's pgvector binding: `.aipe/study-system-design/`.
