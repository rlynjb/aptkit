# 03 — Contract as the Product

**Subtitle:** Information hiding via vendor-neutral contracts · the abstraction
*is* the deliverable — *Industry standard* (the retrieval port pattern;
"depend on an interface, not an implementation").

---

## Zoom out, then zoom in

The RAG pipeline in aptkit has two adaptability seams, and the design bet is that
those two seams — not the in-memory store, not nomic, not pgvector — are the
actual product. The vendors are interchangeable; the contracts are forever.

```
  Zoom out — where the retrieval contracts sit

  ┌─ Agent / tool layer ─────────────────────────────────────────┐
  │  search_knowledge_base tool · @aptkit/memory (remember/recall)│
  └────────────────────────────┬───────────────────────────────────┘
                               │ pipeline.index() / pipeline.query()
  ┌─ Pipeline (vendor-blind) ──▼───────────────────────────────────┐
  │  indexDocument · queryKnowledgeBase — names ONLY embedder+store│
  └──────────────┬─────────────────────────┬────────────────────────┘
                 │ ★ EmbeddingProvider ★    │ ★ VectorStore ★   ← we are here
  ┌─ Adapters ───▼────────────┐  ┌──────────▼────────────────────────┐
  │ OllamaEmbeddingProvider   │  │ InMemoryVectorStore (cosine)       │
  │ (nomic, 768)              │  │ PgVectorStore (in buffr, drop-in)  │
  └───────────────────────────┘  └─────────────────────────────────────┘
```

Zoom in: the concept is **information hiding at the seam** — the pipeline
encapsulates the decision "what embeds text, what stores vectors" so completely
that the words "nomic", "Ollama", "pgvector" appear *nowhere* in the pipeline
code. The header comment states it as law (`contracts.ts:1-5`): "the pipeline
logic never names a vendor." The question it answers: how do you write RAG once
and run it against an in-memory array today and Postgres tomorrow with no change
to the pipeline?

---

## Structure pass

- **Layers:** consumer (tool / memory) → pipeline functions → the two contracts
  → the concrete adapters.
- **Axis — "is a vendor named here?":** trace it down.
  - consumer → no. Calls `pipeline.query(q, k)`.
  - pipeline → no. `indexDocument`/`queryKnowledgeBase` speak `embedder`,
    `store`, `vector` only (`pipeline.ts:31-59`).
  - contract → no. `EmbeddingProvider`/`VectorStore` carry a `dimension` and
    verbs, no vendor (`contracts.ts:22-37`).
  - adapter → **yes, finally.** "nomic-embed-text", `localhost:11434`, cosine.
- **Seam:** the two contract types. Vendor knowledge flips from absent to present
  exactly there. And the proof the seam is right: a *second, unplanned* consumer
  (`@aptkit/memory`) plugged into the same seam with zero new infrastructure.

---

## How it works

### Move 1 — the mental model

You know how a React component takes `props` and doesn't care whether the data
came from a `fetch`, a cache, or a test fixture? The component codes against the
*prop shape*. The pipeline codes against the *contract shape* — `embed(texts)`
and `upsert/search` — and doesn't care what's behind them.

```
  Pattern — two contracts, the pipeline between them, vendors at the edges

   index path:   doc ─► chunkText ─► embedder.embed() ─► store.upsert()
                              (the pipeline only ever calls these two verbs)
   query path:   query ─────────────► embedder.embed() ─► store.search() ─► hits

   ┌──────────────────┐        ┌──────────────────┐
   │ EmbeddingProvider│        │ VectorStore      │
   │  dimension        │        │  dimension        │
   │  embed(texts)     │        │  upsert(chunks)   │
   └──────────────────┘        │  search(vec, k)   │
                               └──────────────────┘
        ▲ swap the body, the pipeline never notices ▲
```

The strategy: **the two contract types are the deliverable; everything that
satisfies them is an implementation detail living at the edge.**

### Move 2 — the step-by-step walkthrough

**The two contracts, in full.** Tiny — and that's the point.

```ts
// packages/retrieval/src/contracts.ts:22-37
export type EmbeddingProvider = {
  id: string;
  dimension: number;                          // fixed per provider (768 = nomic)
  embed(texts: string[]): Promise<number[][]>;
};
export type VectorStore = {
  dimension: number;
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
```

`embed` is one verb. `VectorStore` is two verbs plus a `dimension`. Behind these:
HTTP to Ollama, a cosine scan over a `Map`, or pgvector's ANN index in buffr. The
pipeline (`pipeline.ts`) imports the *types* and never an adapter.

**The pipeline names nothing.** Here's the index path — read it for vendor words:

```ts
// packages/retrieval/src/pipeline.ts:31-47 (condensed)
export async function indexDocument(doc, wiring: RetrievalWiring) {
  assertWiring(wiring);                          // dim check (see below)
  const texts = chunkText(doc.text);
  if (texts.length === 0) return;
  const vectors = await wiring.embedder.embed(texts);     // contract verb
  const chunks = texts.map((text, i) => ({
    id: `${doc.id}#${i}`,
    vector: vectors[i]!,
    meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
  }));
  await wiring.store.upsert(chunks);             // contract verb
}
```

`wiring.embedder` and `wiring.store` — that's all it knows. Swap
`InMemoryVectorStore` for `PgVectorStore` and not one line here changes.

**The one piece of shared knowledge the contract guards: dimension.** A corpus
embedded at 768 dims can't be searched by a query of another dimension — silent
mismatch corrupts ranking. So the contract carries `dimension` and the pipeline
fails *loud, at wiring time*:

```ts
// pipeline.ts:22-29
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(`dimension mismatch: embedder "${wiring.embedder.id}" is ` +
      `${wiring.embedder.dimension}-dim but store is ${wiring.store.dimension}-dim ...`);
  }
}
```

This is a one-way door (lens 6 of the audit): a mistake here is unrecoverable
without re-indexing, so it's made impossible to proceed past.

**The proof the seam is right — memory reuses it with zero new infra.** This is
the strongest design evidence in the whole repo. `@aptkit/memory` needed to store
and recall conversation turns by similarity. It did *not* build a memory store.
It took the *same two contracts*:

```ts
// packages/memory/src/conversation-memory.ts:60-87 (condensed)
export function createConversationMemory(opts) {
  const { embedder, store } = opts;              // the SAME contracts
  // remember = the RAG index path, one row:
  async remember(turn) {
    const [vector] = await embedder.embed([format(turn)]);
    await store.upsert([{ id: `${kind}:${turn.conversationId}:${n}`, vector,
                          meta: { kind, conversationId, text } }]);
  }
  // recall = the RAG query path:
  async recall(query, k) {
    const [vector] = await embedder.embed([query]);
    const hits = await store.search(vector, fetchK);
    return hits.filter(h => h.meta?.kind === kind).slice(0, k)...;
  }
}
```

`remember` *is* `indexDocument` for one row; `recall` *is* `queryKnowledgeBase`
with a `kind` filter. A contract a second consumer adopts unchanged was drawn at
the right boundary — that's the load-bearing claim, and it's testable: strip the
contracts and memory would need its own store, its own embedder wiring, its own
dimension guard. It needed none.

```
  Layers-and-hops — one seam, two consumers, zero duplicated infra

  ┌─ retrieval ──────┐   embed()/upsert()/search()   ┌─ EmbeddingProvider ┐
  │ indexDocument    │ ─────────────────────────────►│ + VectorStore      │
  │ queryKnowledge   │                                │ (the contracts)    │
  └──────────────────┘                                │                    │
  ┌─ memory ─────────┐   embed()/upsert()/search()    │                    │
  │ remember / recall│ ─────────────────────────────►│  ◄── same seam     │
  └──────────────────┘   (no new store, no new infra) └────────────────────┘
```

### Move 3 — the principle

The most valuable thing a module can produce is sometimes not behaviour but a
*boundary*. When the abstraction is the product, a second use case costs almost
nothing — which is exactly the test of whether you drew it in the right place.
aptkit's retrieval contracts passed that test the day `@aptkit/memory` shipped on
top of them unchanged.

---

## Primary diagram

```
  Contract as the product — full picture

  ┌─ consumers ──────────────────────────────────────────────────────┐
  │  search_knowledge_base tool   │   @aptkit/memory remember/recall   │
  └──────────────┬──────────────────────────────┬─────────────────────┘
                 │ pipeline.index/query           │ embed/upsert/search
  ┌─ pipeline (vendor-blind) ───────────────────▼─────────────────────┐
  │ indexDocument · queryKnowledgeBase · assertWiring (dim one-way door)│
  └──────────────┬────────────────────────────────────────────────────┘
  ════════════════ THE SEAM (contracts.ts:22-37) ════════════════════════
   EmbeddingProvider {dimension, embed}      VectorStore {dimension, upsert, search}
  ════════════════════════════════════════════════════════════════════════
   ┌─ nomic/Ollama ─┐   ┌─ InMemoryVectorStore ─┐   ┌─ PgVectorStore (buffr) ─┐
   │ embed via HTTP │   │ cosine over a Map     │   │ pgvector ANN, durable    │
   └────────────────┘   └────────────────────────┘   └──────────────────────────┘
```

---

## Elaborate

This is "program to an interface" stated at full strength: the interface is not a
convenience, it's the thing you ship. The reason it matters for RAG specifically
is that the vector-store landscape churns fast (Pinecone → pgvector → Qdrant →
…) and the embedding model churns faster — pinning the pipeline to any one of
them would mean rewriting it on every swap. aptkit pinned it to two types
instead.

The honest weakness lives right next to the strength: the contract is *minimal to
a fault* — `search(vector, k)` has no metadata filter, so both consumers
re-invent over-fetch-then-filter on top of it
(`search-knowledge-base-tool.ts:88`, `conversation-memory.ts:94`). That's
`audit.md`'s fix-first finding and the subject of
`04-guard-rails-as-information-hiding.md`. The minimal contract was the right
*young-repo* call (the in-memory store gains nothing from a filter); it's now
ready to grow a `filter?` parameter that pushes the work down into each store.

---

## Interview defense

**Q: What's the strongest evidence your retrieval abstraction is at the right
boundary?**

A second consumer adopted it unchanged. Conversation memory needed
store-and-recall-by-similarity; instead of building a memory store, it took the
exact `EmbeddingProvider`/`VectorStore` contracts — `remember` is the index path
for one row, `recall` is the query path with a `kind` filter — and shipped with
zero new infrastructure. A contract that survives an unplanned second use was
drawn correctly.

```
  remember  ≡  indexDocument (one row)
  recall    ≡  queryKnowledgeBase (+ kind filter)
  → same contracts, no new store
```

**Q: What does the contract deliberately *not* do, and why?**

It has no metadata filter on `search`. That keeps it minimal and gives the
in-memory store nothing to implement — but it forces both consumers to over-fetch
`k*4` and filter client-side. It's a real leak (the same workaround in two
files). The fix is a `filter?` parameter that pgvector can satisfy in SQL; it
wasn't added early because the contract is a published must-not-change surface
and the early cost didn't justify it.

*Anchor:* "The contract is the product. Proof: `@aptkit/memory` is `remember`/
`recall` built on the same two retrieval contracts with no new infrastructure."

---

## See also

- `01-deep-provider-module.md` — the same "depend on a contract" move for models.
- `04-guard-rails-as-information-hiding.md` — the missing `filter?` and the
  over-fetch workaround it forces.
- `audit.md` — lens 3 (the dimension triple-check leak + the filter leak), lens 6
  (dimension as a fail-loud one-way door).
- `../study-system-design/` — the buffr `PgVectorStore` binding at service
  altitude; `../study-agent-architecture/` — retrieval reaching agents as a tool.
