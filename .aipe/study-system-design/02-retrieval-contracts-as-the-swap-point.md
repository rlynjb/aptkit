# 02 — Retrieval contracts as the swap point

**Industry name(s):** repository pattern / storage abstraction / pluggable vector
store. **Type:** Industry standard.

## Zoom out, then zoom in

Same move as the model seam (file `01`), applied to storage and embeddings. Two
contracts — `EmbeddingProvider` and `VectorStore` — and the entire RAG pipeline,
plus the memory engine, is written against them and nothing else.

```
  Zoom out — where the retrieval contracts live

  ┌─ agents / memory ───────────────────────────────────────┐
  │ search_knowledge_base tool · createConversationMemory()  │
  └───────────────────────────────┬──────────────────────────┘
                                  │ depends ONLY on:
  ┌─ retrieval contracts ────────▼───────────────────────────┐
  │ ★ EmbeddingProvider.embed()  ·  VectorStore.upsert/search ★│ ← here
  └───────────────────────────────┬──────────────────────────┘
                                  │ implemented by (swappable):
  ┌─ implementations ────────────▼───────────────────────────┐
  │ InMemoryVectorStore (cosine scan) │ OllamaEmbeddingProvider│
  │ PgVectorStore (buffr, pgvector+HNSW, durable)             │
  └───────────────────────────────────────────────────────────┘
```

The question: *how do you build a RAG pipeline that runs entirely in-memory for
tests and a demo, then becomes durable Postgres in production — with no pipeline
change?* And the bonus question this repo answers: *how does the same boundary give
you episodic memory for free?* Here's the mechanism.

## Structure pass

**Layers:** pipeline/tool/memory (callers) → the two contracts → implementations
(in-memory + Ollama in aptkit; `PgVectorStore` in buffr).

**Axis traced — *durability*:** does the data survive a process restart?

```
  One axis — "does the data survive restart?" — traced across stores

  ┌─ VectorStore contract ┐   contract says nothing about durability.
  └──────────┬─────────────┘
  ┌─ InMemoryVectorStore ─▼┐   NO. it's a Map; dies with the process.
  └──────────┬─────────────┘
  ┌─ PgVectorStore (buffr) ▼┐  YES. Postgres rows, transactional upsert.
  └─────────────────────────┘  the answer flips — same contract, two truths.
```

**Seam:** the `VectorStore` boundary. Durability flips across it while the method
signatures stay identical (`upsert`, `search`). That's the definition of a
load-bearing seam — and it's exactly the one buffr substitutes at.

## How it works

### Move 1 — the mental model

You've shipped this in AdvntrCue: pgvector behind a query function, so the rest of
the app calls `query(text, k)` and never writes SQL. The contract is "give me
ranked rows for this vector"; the store is whatever satisfies it. Here the contract
is two tiny types.

```
  The retrieval seam — index path and query path, both vendor-blind

   index:  doc → chunk → embedder.embed() → store.upsert()
                              │                    │
   query:  q  → ─────────────┘  embedder.embed() → store.search() → ranked hits
                                                        ▲
                          memory.remember = index path  │  with kind:'memory' tag
                          memory.recall   = query path ──┘
```

### Move 2 — the walkthrough

**The two contracts.** Both are deliberately minimal so an implementation is cheap.

```ts
// packages/retrieval/src/contracts.ts:22
export type EmbeddingProvider = {
  id: string;
  dimension: number;                          // fixed per provider (768 = nomic)
  embed(texts: string[]): Promise<number[][]>;
};
export type VectorStore = {                   // :33
  dimension: number;                          // carried so a mismatch can fail loud
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
```

**What breaks if missing:** without `VectorStore` as a contract, the pipeline would
hard-code `InMemoryVectorStore`, and "make it durable" would mean rewriting the
pipeline instead of writing one new class.

**The pipeline operates only on the contract.** `indexDocument` and
`queryKnowledgeBase` take a `RetrievalWiring = { embedder, store }` and never name a
vendor:

```ts
// packages/retrieval/src/pipeline.ts:32 + :50 (abridged)
export async function indexDocument(doc, wiring) {
  assertWiring(wiring);                         // dimension match or throw — :22
  const texts = chunkText(doc.text);
  const vectors = await wiring.embedder.embed(texts);
  const chunks = texts.map((text, i) => ({
    id: `${doc.id}#${i}`,                        // stable chunk id
    vector: vectors[i]!,
    meta: { ...doc.meta, docId: doc.id, chunkIndex: i, text },  // meta carries citation data
  }));
  await wiring.store.upsert(chunks);
}
export async function queryKnowledgeBase(query, wiring, topK = 5) {
  const [vector] = await wiring.embedder.embed([query]);
  return wiring.store.search(vector, topK);      // ranked hits, store-agnostic
}
```

**The dimension is a one-way door.** This is the most important guard. A 768-dim
corpus searched by a 1536-dim query produces *silently wrong* rankings, not an
error — so the repo makes it loud at wiring time (`pipeline.ts:22`) *and* at upsert/
search time inside the store (`in-memory-vector-store.ts:36`). **What breaks if
missing:** corrupted ranking that no test catches because nothing throws.

**The two implementations, same contract.** The whole payoff is that these are
interchangeable:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:25 — O(n) cosine scan
async search(vector, k) {
  const hits = [...this.chunks.values()].map(c => ({
    id: c.id, score: cosineSimilarity(vector, c.vector), meta: c.meta }));
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(0, k));
}
```

```ts
// buffr/src/pg-vector-store.ts:67 — pgvector ANN, durable
async search(vector, k) {
  const { rows } = await this.pool.query(
    `select id, content, ..., 1 - (embedding <=> $1::vector) as score   -- <=> is cosine DISTANCE
     from agents.chunks where app_id = $2
     order by embedding <=> $1::vector limit $3`,                        -- HNSW index serves this
    [toVectorLiteral(vector), this.appId, k]);
  return rows.map(r => ({ id: r.id, score: Number(r.score),
    meta: { ...r.meta, docId: r.document_id, chunkIndex: r.chunk_index, text: r.content } }));
}
```

Note the last line of each: both rebuild `meta` to carry `docId`/`chunkIndex`/`text`
so the `search_knowledge_base` tool's citation builder (`search-knowledge-base-tool.ts:108`)
works identically over either store. The contract isn't just the method signatures —
it's the meta shape too, and buffr honors it (`pg-vector-store.ts:83`).

**The bonus payoff — memory is the same seam, reused.** This is the strongest
evidence the boundary was drawn right. `@aptkit/memory` adds *zero new
infrastructure*: `remember` is the index path, `recall` is the query path, over the
*same* `EmbeddingProvider`/`VectorStore` types (`conversation-memory.ts`). It tags
rows `kind:'memory'`, ids `memory:<convId>:<n>`. Because the `VectorStore` contract
has no metadata predicate, `recall` over-fetches then filters by `kind` client-side
— a logical partition over a shared collection.

```
  Self-similarity — memory IS retrieval with a tag

  remember(turn)  ──►  embed(format(turn))  ──►  store.upsert([{ id: memory:c:n,
                                                    meta:{ kind:'memory' } }])
  recall(query,k) ──►  embed(query) ──► store.search(k*over) ──► filter kind==='memory'
                                                    ▲
                       this is queryKnowledgeBase with a post-filter
```

buffr shares the document store with memory (`session.ts:53`), so a past exchange
surfaces through the *existing* `search_knowledge_base` tool — no new tool, no new
table. **What breaks if the boundary were wrong:** memory would have needed its own
store, its own embed path, its own search. It didn't, because the boundary already
captured exactly "embed text, store vector, search by similarity."

### Move 3 — the principle

A storage contract earns its keep when a *second* feature you didn't plan for falls
out of it for free. The model-call seam (file `01`) proved swappability; this seam
proved *extensibility* — memory rode in on contracts built for documents. When a
boundary absorbs a new requirement with no new infrastructure, that's the signal it
was cut along the real joint.

## Primary diagram

The full retrieval seam, both implementations, plus memory riding the same boundary.

```
  Retrieval contracts as the swap point — full picture

  ┌─ callers ─────────────────────────────────────────────────────────┐
  │ pipeline (index/query) · search_knowledge_base tool · memory engine │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │ EmbeddingProvider · VectorStore only
  ┌─ contracts (packages/retrieval/src/contracts.ts) ───────────────────┐
  │ embed(texts)→vec[][]   |   upsert(chunks) · search(vec,k)→hits       │
  │ dimension guarded — mismatch throws loud (pipeline.ts:22)            │
  └──────────┬───────────────────────────────────────┬──────────────────┘
             ▼ (aptkit default, in-process)            ▼ (buffr, durable)
  ┌────────────────────────────┐          ┌────────────────────────────────┐
  │ InMemoryVectorStore         │          │ PgVectorStore implements        │
  │  Map + O(n) cosine scan     │          │  VectorStore                    │
  │ OllamaEmbeddingProvider     │          │  Supabase pgvector + HNSW       │
  │  nomic-embed-text, 768-dim  │          │  <=> cosine distance, app_id key│
  └────────────────────────────┘          │  transactional upsert           │
                                           └────────────────────────────────┘
  memory.remember/recall use the SAME contract, tag kind:'memory'
```

## Elaborate

This is the repository pattern from enterprise architecture, specialized to vectors.
The reason it's distinct from the model seam (file `01`) — and earns its own file —
is the durability flip: the model seam swaps *behavior*, this one swaps the *source
of truth*. The dimension guard is the unusual touch: most repository patterns don't
have a numeric invariant that, if violated, corrupts results silently. Vector
search does, so the repo enforces it at the boundary.

Engine internals belong elsewhere: HNSW index construction, the `<=>` / `<->`
pgvector operators, and transaction isolation are **`study-database-systems`**; the
`agents.chunks` table shape, the `app_id` partition key, and the dropped foreign key
that lets memory rows exist with no parent document are **`study-data-modeling`**.

## Interview defense

**Q: Why carry `dimension` on the store and the embedder both?**
Because a vector-dimension mismatch corrupts ranking *silently* — cosine over
mismatched-length vectors still returns numbers, just wrong ones. Carrying it on
both sides lets the wiring assert equality at construction (`pipeline.ts:22`) and
the store re-assert per call. Anchor: *the dimension is a one-way door; make it loud
at the door.*

```
  embedder.dim ── must equal ──► store.dim
       768                          768      ✓ wire
       768                         1536      ✗ throw at wiring, not at query
```

**Q: What proves the boundary is in the right place?**
Memory. It's a whole feature — episodic conversation recall — built with *zero* new
storage code, because `remember`/`recall` are just the index/query paths with a
`kind` tag (`conversation-memory.ts`). A boundary that absorbs an unplanned feature
for free was cut along the real joint. Anchor: *memory is retrieval with a tag.*

**Q: Biggest weakness of the default?**
`InMemoryVectorStore` is O(n) linear scan and process-bound — fine for fixtures,
useless at corpus scale. But that's *contained*: swapping `PgVectorStore` (HNSW ANN)
needs zero pipeline change. The weakness is the default, not the design. Anchor:
*the bottleneck is one class behind a stable contract.*

## See also

- `01-provider-neutral-model-seam.md` — the same move for the model call.
- `03-library-vs-deployment-split.md` — buffr is *where* `PgVectorStore` gets injected.
- `04-bounded-agent-loop.md` — the loop that reaches retrieval as a tool.
- **`study-database-systems`** — pgvector engine internals, HNSW.
- **`study-data-modeling`** — the `agents` schema and the memory FK.
