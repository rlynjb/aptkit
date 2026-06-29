# Agent Memory Tiers

**Industry term:** agent memory tiers (working / episodic / long-term). *Industry standard.*

## Zoom out, then zoom in

Memory as a dedicated component, separate from the context window. aptkit has a real episodic-memory engine (`@aptkit/memory`) — built, tested, and reusing the retrieval contracts — but **not yet wired into any aptkit agent.** Name that honestly: the mechanism exists; no agent recalls memory yet.

```
  Zoom out — memory reuses the retrieval contracts (zero new infra)

  ┌─ Memory layer (@aptkit/memory) ─────────────────────────────┐
  │  createConversationMemory({embedder, store})                 │ ← we are here
  │  remember = RAG index path · recall = RAG query path         │
  └───────────────────────────────┬──────────────────────────────┘
                                   │ SAME EmbeddingProvider + VectorStore
  ┌─ Retrieval layer ───────────────▼───────────────────────────┐
  │  the contracts documents already use                         │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: `createConversationMemory` (`packages/memory/src/conversation-memory.ts`) stores Q/A exchanges as vector rows and recalls them by similarity — over the *same* `EmbeddingProvider`/`VectorStore` contracts as the RAG pipeline. `remember` is the index path; `recall` is the query path. It's the strongest evidence those contracts were the right boundary. But **no aptkit agent calls it** — buffr's session runtime is the intended consumer.

## The structure pass

**Layers.** Three memory tiers: working (in-context, this run), episodic (recent sessions, retrieved), long-term (persistent knowledge).

**Axis: lifecycle — when does each tier's content live and die?** Working dies at run end; episodic persists across sessions; long-term is durable.

**The seam.** The `VectorStore` contract — episodic memory and documents sit behind the *same* one, partitioned only by a `kind` tag.

## How it works

**Use case it would fit:** the rag-query agent recalling "you asked about your running goals last week" — but it doesn't, yet. The engine is ready; the wiring is the gap.

### Move 1 — the tiers

This is the local-canonical-plus-retrieved-context instinct from a local-first app's storage layering, applied to an agent's knowledge.

```
  ┌─ Working (in-context) ─────────────────────────┐
  │  The current run's messages[]. Gone at run end. │
  └─────────────────────────────────────────────────┘
  ┌─ Episodic (recent sessions) ───────────────────┐
  │  Past Q/A exchanges as vector rows.             │
  │  Retrieved by similarity to the current query.  │  ← @aptkit/memory
  └─────────────────────────────────────────────────┘
  ┌─ Long-term (persistent knowledge) ─────────────┐
  │  Durable facts/preferences in a vector DB.      │
  │  buffr's PgVectorStore. Unbounded.              │
  └─────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Working memory is the loop's `messages[]`.** Covered in [../01-reasoning-patterns/02-agent-loop-skeleton.md](../01-reasoning-patterns/02-agent-loop-skeleton.md) — it accumulates this run and is gone when the run ends. That's the only tier an aptkit agent uses today.

**Episodic memory is `remember`/`recall`, and it's the RAG pipeline reused.** `remember` embeds an exchange and upserts it as a vector row; `recall` embeds a query and searches:

```ts
// conversation-memory.ts:74 — remember = the RAG index path
async remember(turn) {
  const [vector] = await embedder.embed([format(turn)]);
  await store.upsert([{ id: `${kind}:${turn.conversationId}:${n}`,
    vector, meta: { kind, conversationId: turn.conversationId, text } }]);
}
// conversation-memory.ts:89 — recall = the RAG query path, then filter by kind
async recall(query, k = 5) {
  const [vector] = await embedder.embed([query]);
  const hits = await store.search(vector, Math.max(k * 4, 20));  // over-fetch
  return hits.filter((h) => h.meta?.kind === kind).slice(0, k)...; // then filter
}
```

**The `kind` tag is a logical partition over a shared collection.** Memory rows are tagged `kind: 'memory'`. When memory *shares* the document store, recall over-fetches then filters by `kind` client-side — because the `VectorStore` contract has no metadata predicate (`conversation-memory.ts:92`). That's the same over-fetch-then-filter trick the `search_knowledge_base` filter uses. Two consumers, one store, partitioned by a tag.

**Two wiring modes — both injected, neither wired into an aptkit agent.** Memory can SHARE the document store (memory surfaces via the existing `search_knowledge_base` tool) or use a DEDICATED store (recalled via a `search_memory` tool from `createMemoryTool`, `packages/memory/src/memory-tool.ts`). The store is *injected* — the engine never names a database. Pass `InMemoryVectorStore` for tests, `PgVectorStore` for durable memory. But: **no aptkit agent constructs a `ConversationMemory` or registers `search_memory`.** `not yet exercised` in any aptkit agent.

### Move 2.5 — current state vs future state

```
  Phase A (now):  working memory only (the loop's messages[]).
                  @aptkit/memory is built + tested but NO agent wires it.
                  recall() is never called inside an aptkit agent run.

  Phase B (buffr): session runtime calls remember() after each turn and
                   exposes recall() via search_memory (dedicated) or
                   search_knowledge_base (shared store). Durable PgVectorStore.
```

What doesn't have to change: the agent, the loop, the contracts. Wiring memory is registering one more tool and calling `remember` after each turn — the engine is done.

### Move 3 — the principle

Long-term memory only works if the right thing is retrieved at the right time — which is RAG *inside* the agent. aptkit proves the point structurally: episodic memory IS the RAG pipeline with a `kind` tag, zero new infrastructure. The honest gap is the last mile — no aptkit agent recalls memory yet; the retrieval problem is solved, the wiring is buffr's job.

## Primary diagram

```
  aptkit memory tiers — built vs wired

  WORKING   messages[] in runAgentLoop          ✓ used by every agent
  EPISODIC  @aptkit/memory: remember/recall      ✓ BUILT + TESTED
            over the SAME EmbeddingProvider +     ✗ NOT WIRED into any
            VectorStore as RAG, tagged kind:memory  aptkit agent
  LONG-TERM PgVectorStore (buffr)                 ↗ buffr's session runtime
                                                    is the intended consumer
```

## Elaborate

The three-tier memory model is the field's answer to "context windows aren't memory." Working memory (the window) is amnesiac across runs; episodic and long-term tiers persist and retrieve. aptkit's notable move is collapsing episodic memory onto the retrieval contracts — `remember` is `indexDocument`, `recall` is `queryKnowledgeBase`, partitioned by a `kind` tag. That this required *zero new infrastructure* is the strongest possible evidence the `EmbeddingProvider`/`VectorStore` boundary was drawn in the right place. The unfinished part is honest: a memory engine nobody calls yet is a tool, not a feature.

## Interview defense

**Q: Does aptkit have agent memory?**

It has a built, tested episodic-memory engine — `@aptkit/memory` — but no aptkit agent wires it yet. The notable part is *how* it's built: `remember`/`recall` reuse the exact `EmbeddingProvider`/`VectorStore` contracts as RAG, with memory rows tagged `kind: 'memory'` and recall over-fetching then filtering by that tag. Zero new infrastructure. buffr's session runtime is the intended consumer.

```
  remember = RAG index path · recall = RAG query path · kind tag partitions
  built + tested ✓   wired into an aptkit agent ✗ (not yet exercised)
```

*Anchor: episodic memory IS RAG with a kind tag — the zero-new-infra reuse is the evidence the contracts were right; the wiring is the honest gap.*

## See also

- [01-context-engineering.md](01-context-engineering.md) — memory as a context band.
- [../02-agentic-retrieval/01-agentic-rag.md](../02-agentic-retrieval/01-agentic-rag.md) — the pipeline memory reuses.
- Agent memory two-layer short/long split: `.aipe/study-ai-engineering/04-agents-and-tool-use/`.
