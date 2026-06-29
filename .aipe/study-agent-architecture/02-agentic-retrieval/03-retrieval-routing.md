# Retrieval Routing

**Industry standard.** "Retrieval routing," "source routing," "multi-store RAG." Type label: reasoning pattern (routing applied to knowledge sources). **In this codebase: not yet implemented.** aptkit has exactly one knowledge source per pipeline — an `InMemoryVectorStore` behind one `search_knowledge_base` tool. There's no router picking between a vector store, a relational store, and live search, because there's only one source.

## Zoom out, then zoom in

When there are multiple knowledge sources, you route the query to the right one before retrieving — semantic queries to the vector store, exact lookups to SQL, freshness queries to web search. aptkit has one store today, so it doesn't route. But the contracts make adding sources cheap, so it's worth seeing the refactor.

```
  Zoom out — retrieval routing WOULD sit above the tool

  ┌─ Loop layer ─────────────────────────────────────────────┐
  │  model calls a search tool                                │
  └───────────────────────────┬──────────────────────────────┘
                              │ TODAY: one tool, one store
  ┌─ Router layer (not yet) ──▼──────────────────────────────┐
  │  ★ which source? vector | SQL | web ★  (not exercised)    │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Source layer ────────────────────────────────────────────┐
  │  InMemoryVectorStore (the only source today)               │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: how many sources, and who picks?** Today: one source, no picking. The seam that *would* appear is the router between the loop and multiple stores. aptkit already has the routing pattern (`classifyIntent`, SECTION A) and the retrieval contracts (`VectorStore`, `EmbeddingProvider`) — retrieval routing is just those two composed: classify the query's source need, dispatch to the matching store.

## How it works

### Move 1 — the mental model

This is SECTION A's routing pattern aimed at knowledge sources instead of handlers. Before retrieving, classify what *kind* of question it is and pick the source that answers that kind best.

```
  Retrieval routing — pick the source before retrieving

  query → ┌─ router: which source? ──┐
          └──────────┬────────────────┘
        ┌────────────┼────────────┐
        ▼            ▼            ▼
     vector DB    SQL DB     web search
     (semantic)   (exact)    (fresh)
```

### Move 2 — what it would take in aptkit

aptkit has all the parts; they're just not wired into a router.

**The contracts are ready.** `VectorStore` is a vendor-neutral interface (`packages/retrieval/src/contracts.ts`). buffr already implements a *second* `VectorStore` (`PgVectorStore`). Adding a SQL source or a web source means a new tool, not a new architecture.

**The routing pattern is ready.** `classifyIntent` (`query/src/intent.ts:13`) already classifies a query into one of three buckets with one cheap model call. The same shape, retargeted: classify into "semantic / exact / fresh" and dispatch to the matching tool.

**The refactor.** Register multiple search tools instead of one, and either (a) let the model pick the tool (multi-tool ReAct — aptkit's recommendation agent already does this with 13 tools), or (b) add an explicit router step before the loop. Option (a) is the smaller change: give the rag-query agent's policy three tools instead of one.

```
  Retrieval routing refactor in aptkit (would-be)

  TODAY:
    ragQueryToolPolicy.allowedTools = [search_knowledge_base]   ← one source

  REFACTORED (option a — multi-tool, model picks):
    allowedTools = [search_documents, query_metrics_sql, search_web]
    model reasons: "this is a freshness question" → calls search_web
    (the model routes, exactly like recommendation agent picks among 13 tools)
```

**The interview-grade point.** A single vector store is rarely the whole answer in production: paraphrase queries want a vector store, exact lookups want a relational store, freshness wants live search. aptkit's recommendation agent already proves the model *can* route among many tools — retrieval routing is that same capability pointed at knowledge sources. The reason aptkit doesn't do it yet is honest: it has one corpus (a personal knowledge base), so one source is correct. Multi-source routing is a need that appears when the knowledge spans stores, not before.

### Move 3 — the principle

Routing between a vector store (paraphrase queries), a relational store (exact lookups), and live search (freshness) is what production retrieval looks like. aptkit isn't there because it has one source — and adding sources is a tool-registration change, not an architecture change, precisely because retrieval is contract-neutral and exposed as tools. The cost of *not* having multi-source design baked in early is zero here, because the seam (tools + contracts) is already in place.

## Primary diagram

```
  Retrieval routing — the shape aptkit could adopt

  query → classify source need (one cheap call OR model-decided)
              │
        ┌─────┼──────────────────┐
        ▼     ▼                  ▼
  search_documents  query_metrics_sql  search_web
  (InMemory/Pg      (relational,       (live,
   VectorStore)      exact lookups)     fresh data)
        │     │                  │
        └─────┴──────────────────┘
              ▼
      ranked results → model grounds + cites
  (TODAY: only the leftmost path exists)
```

## Elaborate

Retrieval routing is the recognition that "RAG" collapses three different retrieval problems — semantic similarity, exact structured lookup, and freshness — that need different stores. Teams that ship a single vector store hit the wall when a user asks "what's the current price" (freshness, vector store has stale data) or "how many orders last week" (exact aggregate, vector store can't count). aptkit hasn't hit that wall because its corpus is one personal knowledge base — but its tool-based, contract-neutral retrieval means the wall, when it comes, is a small refactor.

## Interview defense

**Q: Do you route between knowledge sources?**
Not yet — I have one corpus, a personal knowledge base, so one vector store is correct. But the architecture is ready: retrieval is contract-neutral (`VectorStore`) and exposed as tools, and my recommendation agent already proves the model can route among many tools. Multi-source routing would be giving the rag-query agent three search tools instead of one and letting it pick — semantic to the vector store, exact to SQL, fresh to web. It's a tool-registration change, not an architecture change.

```
  one source today → register 3 tools → model routes (like the 13-tool agent)
```
*Anchor: I didn't bake in multi-source prematurely, but the seam (tools + contracts) makes it cheap when needed.*

## See also

- `01-reasoning-patterns/07-routing.md` — the routing pattern this reuses
- `01-agentic-rag.md` — the single-source loop today
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — multi-tool registries (the recommendation agent's 13 tools)
- `study-ai-engineering/03-retrieval-and-rag/` — hybrid retrieval, RRF (cross-ref)
