# Agent Memory
*Agent memory · short-term vs long-term (Industry standard)*

Agent memory splits cleanly into two things people constantly conflate. Short-term memory is the `messages` array of *one* `runAgentLoop` run — it lives for the duration of the loop and evaporates when `answer()` returns. Long-term memory is episodic memory (`createConversationMemory`) that survives across runs by storing past exchanges as vectors and recalling them by similarity. The clean insight in aptkit's design: long-term memory is just **RAG pointed inward**. `remember` is the index path, `recall` is the query path, and both reuse the *exact same* `EmbeddingProvider` + `VectorStore` contracts the document RAG uses. Zero new infrastructure. Memory is a corpus where the documents are your own past conversations.

Be honest up front: no aptkit agent wires this in yet. The module is built and tested; buffr's session runtime uses it. In aptkit it's a ready component waiting for a `search_memory` tool to be granted to an agent — which is the exercise at the end.

## Zoom out, then zoom in

Two memories, two lifetimes. One is the loop's working set; the other is a vector store that outlives every run.

```
Short-term vs long-term
┌───────────────────────────────────────────────────────────────────────┐
│  SHORT-TERM  (one runAgentLoop run)                                     │
│    messages[] grows turn by turn ──► discarded when answer() returns    │
│    lifetime: one query                                                  │
├───────────────────────────────────────────────────────────────────────┤
│  LONG-TERM   (createConversationMemory) — RAG pointed inward    ★       │
│    remember(turn) ──embed──► VectorStore.upsert   (index path)          │
│    recall(query)  ──embed──► VectorStore.search   (query path)          │
│    lifetime: forever (durable store)                                    │
│    REUSES the SAME EmbeddingProvider + VectorStore as document RAG      │
└───────────────────────────────────────────────────────────────────────┘
```

The ★ is the whole trick. aptkit didn't build a memory database. It noticed that "store an exchange and find it again later" is identical to "store a document chunk and retrieve it" — so it points the retrieval stack at conversations. The store is *injected*: pass the same store the documents use and memory mixes into the corpus (surfaces via `search_knowledge_base`); pass a dedicated store and memory is isolated (surfaces via `search_memory`).

## Structure pass

Trace **state** — where a remembered exchange lives and how it comes back.

A turn enters as a `MemoryTurn { conversationId, question, answer }` (`conversation-memory.ts:4-8`). `remember` formats it to text, embeds it to a vector, and upserts it with a *structured id* and a *kind tag*: `id = `${kind}:${turn.conversationId}:${n}`` where `n` is a per-conversation counter (`:78-86`). So state is one vector row per exchange, namespaced by conversation, tagged `kind: 'memory'`.

The seam — and the part worth knowing — is on the way back out. The `VectorStore` contract has *no metadata predicate*; `search` can't say "only memory rows." So `recall` over-fetches and filters client-side: `fetchK = Math.max(k * 4, 20)` (`:94`), search that many, then `.filter(h => h.meta?.kind === kind).slice(0, k)` (`:97-98`). The 4× over-fetch exists precisely because, in a *shared* store, document rows can rank above memory rows; you fetch extra so enough memory rows survive the filter. State flips from "everything similar" to "only my memories" right there, in application code, because the store can't do it for you.

## How it works

### Move 1 — the mental model

Long-term memory is two RAG operations wearing different names. Indexing a doc and remembering an exchange are the same `embed → upsert`. Querying docs and recalling memories are the same `embed → search`.

```
The kernel: memory = RAG with conversations as the corpus
  remember = RAG index:  text → embed → upsert(id, vector, meta)
  recall   = RAG query:  query → embed → search → filter(kind) → top-k
```

### Move 2 — the moving parts

**`remember` — the index path.** Embed the formatted exchange, mint a collision-proof id, upsert with the kind tag.

```
MemoryTurn ──format──► text ──embed──► vector
   id = "memory:<convId>:<n>"  +  meta{ kind, conversationId, text }  ──► store.upsert
```

```ts
// packages/memory/src/conversation-memory.ts:74-87
async remember(turn: MemoryTurn): Promise<void> {
  const text = format(turn);
  const [vector] = await embedder.embed([text]);
  if (!vector) return;
  const n = counters.get(turn.conversationId) ?? 0;        // per-conversation counter
  counters.set(turn.conversationId, n + 1);
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,             // ◄── namespaced id, never collides
    vector,
    meta: { kind, conversationId: turn.conversationId, text },  // ◄── kind tag for recall filter
  }]);
}
```

**`recall` — the query path with the client-side kind filter.** Embed the query, over-fetch, filter by `kind`, take top-k.

```ts
// packages/memory/src/conversation-memory.ts:89-106
async recall(query: string, k: number = DEFAULT_RECALL_K): Promise<MemoryHit[]> {
  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  const fetchK = Math.max(k * 4, 20);          // ◄── 4× over-fetch (store has no metadata filter)
  const hits = await store.search(vector, fetchK);
  return hits
    .filter((h: VectorHit) => h.meta?.kind === kind)   // ◄── client-side kind filter
    .slice(0, k)
    .map((h: VectorHit) => ({ id: h.id, score: h.score, text: /*...*/, conversationId: /*...*/ }));
}
```

**The dimension guard — the injected-store safety check.** Removing it: a mismatched embedder and store silently produce garbage similarity. The constructor refuses the mismatch.

```ts
// packages/memory/src/conversation-memory.ts:62-66
if (embedder.dimension !== store.dimension) {
  throw new Error(`embedder dimension ${embedder.dimension} != store dimension ${store.dimension}`);
}
```

**The memory tool — how an agent reaches memory.** `createMemoryTool` (`packages/memory/src/memory-tool.ts:28-60`) wraps `recall` as a tool named `search_memory` whose handler calls `memory.recall`. Grant it to an agent via the policy allowlist and the agent can now look up its own past — recall becomes an Action in the ReAct loop.

### Move 3 — the principle

Don't build a memory subsystem. If you already have retrieval (embedder + vector store), long-term memory is that same stack with conversations as the corpus — `remember` indexes, `recall` queries. The only genuinely new logic is the `kind` tag and the over-fetch-then-filter, both forced by the `VectorStore` contract's lack of a metadata predicate. Inject the store so the caller chooses shared (memory blends into the knowledge base) vs dedicated (memory isolated).

## Primary diagram

```
Episodic memory over the SAME retrieval contracts as document RAG
┌────────────────────────────────────────────────────────────────────────┐
│ INDEX PATH (remember)                                                    │
│   exchange ─► format ─► embed ─► upsert(id="memory:<conv>:<n>",          │
│                                          meta.kind="memory")             │
│                                            │                             │
│                                            ▼                             │
│                                    ┌───────────────┐                     │
│                                    │  VectorStore  │ ◄─ shared OR         │
│                                    │ (injected)    │    dedicated         │
│                                    └───────────────┘                     │
│                                            ▲                             │
│ QUERY PATH (recall)                        │                             │
│   query ─► embed ─► search(fetchK=max(k*4,20)) ─► filter(kind) ─► top-k   │
│                          over-fetch ──────────┘   client-side ─┘         │
└────────────────────────────────────────────────────────────────────────┘
   Honest gap: NO aptkit agent wires this yet. buffr's session runtime does.
```

## Elaborate

The reason recall filters client-side instead of in the query is a deliberate contract choice: `VectorStore.search(vector, k)` takes no predicate, so memory can't push "kind = memory" down to the store. The 4× over-fetch is the cost of that simplicity — in a shared store, documents and memories compete for the top slots, so you grab extra and keep the memory rows. In a *dedicated* store the filter is a near no-op (every row is memory) but the code path is identical, which is the point: same logic for both deployments. Short-term memory needs no module at all — it's just the `messages` array in `runAgentLoop` (`run-agent-loop.ts:94`), recycled per run.

## Project exercises

### Wire search_memory into the rag-query agent

- **Exercise ID:** `EX-MEM-05b`
- **What to build:** Construct a `createConversationMemory` over the existing embedder + a dedicated vector store, register `createMemoryTool`'s `search_memory` tool, add it to the RAG query agent's `ragQueryToolPolicy.allowedTools`, and `remember` each completed Q/A exchange after `answer()` returns. This is a Case-B integration: composing two existing, tested components (the agent and the memory module) that aren't wired together today.
- **Why it earns its place:** This is the honest gap — aptkit ships memory but no agent uses it. Closing it proves you understand both the retrieval-contract reuse and the policy allowlist, and it makes the agent able to recall its own prior answers as a ReAct Action.
- **Files to touch:** `packages/agents/rag-query/src/rag-query-agent.ts` (allowlist + remember-after-answer), `packages/memory/src/memory-tool.ts` and `packages/memory/src/conversation-memory.ts` (the components you compose).
- **Done when:** Asking a follow-up that references an earlier answer causes the loop to call `search_memory`, recall the prior exchange, and ground its answer in it — and a test with an `InMemoryVectorStore` proves recall returns the remembered turn.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: How do you give an agent long-term memory without a new database?**

```
remember = RAG index ; recall = RAG query — SAME embedder + vector store
```

A: I point the existing retrieval stack inward. `remember` embeds an exchange and upserts it tagged `kind:'memory'`; `recall` embeds the query, searches, and keeps only memory rows. It reuses the document RAG's `EmbeddingProvider` and `VectorStore` — no new infra. The store is injected, so the caller picks shared or dedicated. Anchor: `conversation-memory.ts:80` — `store.upsert` with a kind tag.

**Q: Why does recall over-fetch 4×?**

```
VectorStore.search has no metadata filter → over-fetch, filter kind client-side
```

A: The store contract can't filter by metadata, so in a shared store documents can outrank memories in the top-k. `recall` fetches `max(k*4, 20)`, then filters to `kind === 'memory'` in app code and slices to k. The over-fetch buys enough memory rows to survive the filter. Anchor: `conversation-memory.ts:94-98`.

## See also

- [03-react-pattern.md](03-react-pattern.md) — short-term memory is the loop's `messages` array; `search_memory` is a recall Action.
- [04-tool-routing.md](04-tool-routing.md) — granting `search_memory` means adding it to the policy allowlist.
- `../03-retrieval-and-rag/` — the document RAG whose contracts memory reuses.
