# Agent Memory Tiers

**Industry standard.** "Agent memory," "working/episodic/long-term memory," "memory tiers." Type label: infrastructure. **In this codebase: built but not yet wired.** `@aptkit/memory` (`createConversationMemory`, the `search_memory` tool) is fully implemented and reuses the retrieval contracts — but **no aptkit agent loop calls it.** Studio lists it in its capability catalog; buffr's session runtime is the intended consumer. Memory as an agentic recall capability is `not yet exercised` in any aptkit agent.

## Zoom out, then zoom in

Memory as a dedicated component, separate from the context window. Three tiers: working (in-context, gone at run end), episodic (recent sessions, retrieved by relevance), long-term (durable knowledge). aptkit built the episodic/long-term tier as a retrieval-backed engine — and the standout design fact is it reuses the *exact same* `EmbeddingProvider` and `VectorStore` contracts as RAG, with zero new infrastructure.

```
  Zoom out — aptkit's memory tiers

  ┌─ Working (in-context) ──────────────────────────────────┐
  │  the messages array in runAgentLoop; gone at run end     │ ← HAVE (every agent)
  └──────────────────────────────────────────────────────────┘
  ┌─ Episodic / long-term (persistent) ─────────────────────┐
  │  ★ @aptkit/memory — remember/recall over a VectorStore ★ │ ← BUILT, NOT WIRED
  │  conversation-memory.ts; reuses retrieval contracts      │
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: lifetime + retrieval.** Working memory lives one run (the `messages` array); persistent memory lives across runs (vector rows). The load-bearing question for the persistent tier is *retrieval* — long-term memory only works if the right thing comes back at the right time, which is RAG inside the agent. The seam: aptkit's memory and its documents share one `VectorStore`, partitioned by a `kind` tag — the same store, two consumers.

## How it works

### Move 1 — the mental model

The same local-canonical-plus-retrieved-context instinct from a local-first app's storage layering, applied to an agent's knowledge. Working memory is the current task's context; episodic/long-term memory is a vector store you *recall from* by relevance. Recall is RAG — embed the query, search, return the closest past exchanges.

```
  Memory tiers — working in-window, persistent in a vector store

  ┌─ Working ──────────┐   lives one run (messages array)
  └────────────────────┘
  ┌─ Episodic/long-term┐   remember(turn) → embed → upsert
  │  (vector store)    │   recall(query)  → embed → search → past exchanges
  └────────────────────┘   (retrieval IS the recall mechanism)
```

### Move 2 — the engine, and why it's the strongest contract evidence

**`remember` is the RAG index path; `recall` is the RAG query path.** The memory engine doesn't invent storage — it embeds an exchange and upserts it, then embeds a query and searches. Identical operations to retrieval.

```typescript
// packages/memory/src/conversation-memory.ts:74-86 (remember = index path)
const text = format(turn);
const [vector] = await embedder.embed([text]);
await store.upsert([{
  id: `${kind}:${turn.conversationId}:${n}`,
  vector,
  meta: { kind, conversationId: turn.conversationId, text },  // ← kind-tagged
}]);

// :89-105 (recall = query path)
const [vector] = await embedder.embed([query]);
const hits = await store.search(vector, fetchK);
return hits.filter((h) => h.meta?.kind === kind).slice(0, k)...  // ← filter to memory rows
```

This is the strongest evidence in the codebase that the retrieval contracts were the right boundary: episodic conversation memory is a *second consumer* of `EmbeddingProvider`/`VectorStore` with **zero new infrastructure** (the migration note in the project context calls this out explicitly). Same embedder, same store, same dimension check (`conversation-memory.ts:62`).

**The shared-store partition trick.** Memory rows carry `meta.kind: 'memory'` and an id namespace (`memory:<convId>:<n>`). Because the `VectorStore` contract has *no metadata predicate*, `recall` over-fetches (`fetchK = max(k*4, 20)`, line 94) then filters by `kind` client-side. So memory can share one store with documents (it surfaces via `search_knowledge_base`) or live in a dedicated store with its own `search_memory` tool. The caller decides; the engine doesn't care.

**Two ways to reach it — both built, neither wired into an aptkit agent.**
- **Shared store:** memory mixed into the document corpus, surfaced by the existing `search_knowledge_base` tool. No new tool.
- **Dedicated store:** `createMemoryTool` (`memory-tool.ts:28`) builds a `search_memory` tool — a sibling of `search_knowledge_base` — for explicit recall.

```typescript
// packages/memory/src/memory-tool.ts:4, 36-37
export const SEARCH_MEMORY_TOOL_NAME = 'search_memory';
description: 'Search past conversation exchanges with this user for ones relevant to a '
           + 'query. Use when the answer may depend on something discussed earlier.',
```

**The honest gap.** No aptkit agent registers `search_memory` or wires `createConversationMemory`. The rag-query agent *could* — it already drives `search_knowledge_base`, and memory surfaces through that same tool when the stores are shared — but it doesn't construct a memory instance. The durable store (buffr's `PgVectorStore`) and the session loop that calls `remember`/`recall` live in buffr, not aptkit. So memory-as-agentic-recall is `not yet exercised` in any aptkit agent loop.

### Move 3 — the principle

The retrieval problem is the load-bearing one for long-term memory: it only works if the right thing is retrieved at the right time, which is RAG inside the agent. aptkit proved the point structurally — memory *is* RAG (index = remember, query = recall) over the same contracts, no new infra. The remaining work isn't building memory; it's wiring an agent to call `remember` after each turn and `recall` before reasoning. That wiring lives in the consumer (buffr), so aptkit ships the engine and honestly marks it unexercised.

## Primary diagram

```
  @aptkit/memory — built, reuses retrieval contracts, NOT wired into an agent

  remember(turn) ──► embed ──► store.upsert (kind: 'memory')  ┐
                                                              │ SAME store,
  recall(query)  ──► embed ──► store.search ──► filter kind   │ SAME contracts
                                                              ┘ as RAG
       │                                            │
       ▼ reached via                                ▼ partition by
  search_memory tool (dedicated)              meta.kind tag (shared)
  OR search_knowledge_base (shared store)
       │
       ▼
  NOT YET: no aptkit agent constructs createConversationMemory
           (buffr's session runtime is the intended caller)
```

## Elaborate

Agent memory matured from "stuff the whole history in the prompt" (working memory only) to tiered memory with relevance-based recall, because history outgrows the context window. The three-tier model (working / episodic / long-term) recognizes that not all memory should be in-window — most should be retrievable. aptkit's contribution is the cleanest possible proof that long-term memory is RAG: the memory engine is `remember = index, recall = query` over the same `VectorStore`. The reason it's not wired is honest — the durable store and the per-turn `remember` call belong to the deployment (buffr), not the toolkit.

## Interview defense

**Q: How does your agent remember across sessions?**
The engine is built — `@aptkit/memory` — but I'll be straight: no aptkit agent wires it yet. What's interesting is the design: long-term memory *is* RAG. `remember` is the index path (embed an exchange, upsert it), `recall` is the query path (embed a query, search). It reuses the exact same `EmbeddingProvider` and `VectorStore` contracts as document retrieval, with zero new infrastructure — which is the strongest evidence those contracts were the right boundary.

```
  remember = index path · recall = query path · same VectorStore as RAG
  (kind-tagged rows partition memory from documents in a shared store)
```
*Anchor: memory is RAG inside the agent; recall quality is a retrieval problem.*

**Q: Why isn't it wired?**
The durable store (a Postgres pgvector store) and the per-turn `remember` call live in the deployment, buffr — not the toolkit. aptkit ships the engine and the `search_memory` tool; the consumer does the wiring. I'd rather mark it `not yet exercised` than claim an agent uses it.

## See also

- `02-agentic-retrieval/01-agentic-rag.md` — recall is the same query path
- `01-context-engineering.md` — memory as a context source
- `03-tool-calling-and-mcp.md` — `search_memory` as a registered tool
- `study-ai-engineering/` — the agent-memory two-layer split (cross-ref; this extends to three tiers)
