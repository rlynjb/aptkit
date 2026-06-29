# RAG — Retrieval-Augmented Generation

**Subtitle:** RAG · grounded generation over a private corpus · *Industry standard*

## Zoom out, then zoom in

RAG is the spine of aptkit. Here's where it sits: the agent asks for a tool, the
tool runs the retrieval pipeline, the pipeline reaches an embedder and a store,
and the ranked chunks come back up to ground the model's answer.

```
  Zoom out — RAG across the layers

  ┌─ Capability ──────────────────────────────────────────────┐
  │  rag-query agent — "answer grounded in the knowledge base" │
  └───────────────────────────┬────────────────────────────────┘
                              │ calls tool: search_knowledge_base
  ┌─ Retrieval pipeline ──────▼────────────────────────────────┐
  │  ★ index: doc→chunk→embed→upsert ★                          │ ← we are here
  │  ★ query: query→embed→search→rank ★                         │
  └──────────────┬───────────────────────────┬─────────────────┘
                 │ embed()                    │ search()
  ┌─ Embedder ───▼──────────┐   ┌─ Vector store ▼──────────────┐
  │ nomic-embed-text, 768d  │   │ InMemory (cosine) / PgVector │
  └─────────────────────────┘   └──────────────────────────────┘
```

Now zoom in. You already shipped RAG once (AdvntrCue: pgvector + GPT-4), so the
shape is familiar — retrieve, augment, generate. What's worth studying in aptkit
is that the pipeline is built from scratch over two swappable contracts, and the
agent reaches it as a *tool* rather than as bespoke control flow. The model
decides *when* to retrieve; the pipeline decides *what* comes back.

## Structure pass

**Layers.** Pipeline (index/query) → contracts (embedder, store) → adapters
(nomic, in-memory/pg). Two paths run through the same wiring: indexing writes,
querying reads.

**Axis — state.** Who owns the corpus? Trace it: the pipeline owns no state (it's
pure functions over a wiring); the `VectorStore` owns the vectors; the document
text lives in `meta.text` on each chunk. The pipeline is stateless glue between a
stateful store and a stateless embedder.

**Seam.** The load-bearing boundary is the pair of contracts in
`contracts.ts` — `EmbeddingProvider` (`:22`) and `VectorStore` (`:33`). The axis
"who knows about the vendor?" flips here: above, the pipeline names no vendor;
below, nomic and in-memory/pgvector live. A dimension guard (`pipeline.ts:22`)
makes the seam fail loud if an embedder and store disagree.

## How it works

### Move 1 — the mental model

You know how `Array.prototype.filter` + `sort` gives you "the items matching a
predicate, ranked"? RAG is that, but the predicate is *semantic similarity* and
the ranking is *cosine score*. Retrieve the few most-similar chunks, paste them
into the prompt, let the model answer from them instead of from frozen training
data.

```
  RAG — the kernel

  question ─► embed ─► search store ─► top-k chunks ─► stuff prompt ─► answer
                                          │                              │
                                          └── cite these ────────────────┘
   the model answers FROM the chunks, not from memory — that's the whole trick
```

### Move 2 — the two paths

**Index path: doc → chunk → embed → upsert.** Before you can retrieve, the corpus
must be embedded and stored. `indexDocument` (`pipeline.ts:32`) is the whole write
side:

```ts
export async function indexDocument(doc, wiring) {
  assertWiring(wiring);                       // fail loud if dims disagree
  const texts = chunkText(doc.text);          // 512-char windows, 64 overlap
  if (texts.length === 0) return;
  const vectors = await wiring.embedder.embed(texts);   // one embed call, batched
  const chunks = texts.map((text, i) => ({
    id: `${doc.id}#${i}`,                     // stable id: docId#chunkIndex
    vector: vectors[i]!,
    meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },  // text rides along
  }));
  await wiring.store.upsert(chunks);
}
```

The detail that matters: `text` is stored *in the chunk's meta*. That's what lets
the search tool build a citation later without a second lookup.

```
  Index path — write side

  doc {id,text} ─► chunkText ─► ["…512c…","…512c…"] ─► embed ─► [v0,v1]
                                                                  │
                          upsert chunks {id:"doc#0", vector:v0, meta:{…,text}}
                                                                  ▼
                                                          ┌─ VectorStore ─┐
                                                          │  the corpus   │
                                                          └───────────────┘
```

**Query path: query → embed → search → rank.** The read side is `queryKnowledgeBase`
(`pipeline.ts:50`):

```ts
export async function queryKnowledgeBase(query, wiring, topK = 5) {
  assertWiring(wiring);
  const [vector] = await wiring.embedder.embed([query]);  // embed the query the SAME way
  if (!vector) return [];
  return wiring.store.search(vector, topK);               // cosine top-k
}
```

The query is embedded by the *same provider* as the corpus — that's why the
dimension guard matters. `store.search` ranks by cosine and returns the top-k
`VectorHit`s (`in-memory-vector-store.ts:25`).

```
  Query path — read side

  "what ORM?" ─► embed ─► qv ─► store.search(qv, 5) ─► [hit,hit,hit] sorted by score
                                       │
                              cosine(qv, each chunk.vector), sort desc, slice 5
```

**Augment + generate.** The retrieved chunks reach the model through the tool
result. The rag-query agent's system prompt orders the model to call
`search_knowledge_base` first and ground every answer in the returned chunks,
citing sources, and to say so plainly when the corpus has nothing
(`rag-query-agent.ts:20-27`). The "augment" step is just: the tool result becomes
a `tool_result` message the model reads on its next turn (`run-agent-loop.ts:189`).

```
  Augment + generate — through the agent loop

  model turn 1: "call search_knowledge_base('ORM')"
       │
  tool result: { results: [ "[setup.md] We use Drizzle…", … ] }  ◄─ appended as a message
       │
  model turn 2: reads chunks → "You use Drizzle ORM [setup.md]."  ◄─ grounded + cited
```

### Move 2.5 — current state vs future state

aptkit's RAG runs end to end today on the in-memory store with local nomic + Gemma.
The only thing that changes for production durability is the store: buffr fills
`PgVectorStore` (pgvector + HNSW) behind the same `VectorStore` contract. Nothing
in `indexDocument`/`queryKnowledgeBase`/the agent changes.

```
  Phase A (aptkit, now)            Phase B (buffr, durable)
  ┌────────────────────┐          ┌────────────────────────┐
  │ InMemoryVectorStore│          │ PgVectorStore          │
  │ cosine over array  │   same   │ pgvector <=>, HNSW idx  │
  │ forgets on exit    │ contract │ persists across runs    │
  └────────────────────┘          └────────────────────────┘
   pipeline + agent: IDENTICAL on both
```

### Move 3 — the principle

RAG is only as good as retrieval — a great model over bad chunks gives confident
wrong answers. So the engineering investment goes into the retrieval contracts and
their failure modes (the hallucinated-filter bug, the `minTopK` floor), not into
the model. Build the pipeline so the vendor is swappable and the failure modes are
visible, and the "generation" half mostly takes care of itself.

## Primary diagram

```
  RAG end to end in aptkit

  ┌─ rag-query agent (capability) ─────────────────────────────────────┐
  │  system: "always search first, ground answers, cite, refuse if none"│
  └───────────────┬──────────────────────────────▲─────────────────────┘
         tool call │                              │ grounded answer
  ┌─ search_knowledge_base tool ─▼────┐           │
  │  topK = max(requested, minTopK)   │           │
  └───────────────┬───────────────────┘           │
                  │ pipeline.query                 │
  ┌─ pipeline ────▼────────────────────────────────┴──────────┐
  │  INDEX  doc→chunk(512/64)→embed(nomic,768)→store.upsert    │
  │  QUERY  query→embed→store.search(cosine top-k)→VectorHit[] │
  └───────────────┬───────────────────────────────────────────┘
                  ▼
  ┌─ VectorStore ── InMemory (aptkit)  |  PgVector + HNSW (buffr) ─┐
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

RAG was invented to fix two LLM limits: models don't know your private data, and
their public knowledge is frozen at training time. Retrieval injects fresh,
specific knowledge at query time. The "above-threshold" rule still applies — don't
add RAG to features that work without it; hand-picked retrieval (recency, explicit
relations) often beats vector search at small scale. aptkit earns RAG because the
corpus is open-ended (a personal knowledge base). Read `04-vector-databases.md` for
the storage swap and `04-agents-and-tool-use/03-react-pattern.md` for how the agent
decides *when* to retrieve.

## Project exercises

### Add a "no relevant chunk" threshold to the query path
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a relevance floor in `queryKnowledgeBase` (or the tool) that
  drops hits below a cosine-score threshold, so the agent gets an empty result
  rather than three weak chunks, and answers "I couldn't find that" honestly.
- **Why it earns its place:** "refuse over hallucinate" is the single most-probed
  RAG behavior in interviews; wiring the threshold proves you control the
  precision/recall tradeoff at the retrieval seam.
- **Files to touch:** `packages/retrieval/src/pipeline.ts`,
  `packages/retrieval/src/search-knowledge-base-tool.ts`, a new test in
  `packages/retrieval/test/`.
- **Done when:** a unit test shows a low-similarity query returns `[]` and the
  rag-query agent emits the fallback answer.
- **Estimated effort:** `1–4hr`

### Run the RAG agent against buffr's PgVectorStore end to end
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** wire the rag-query agent to buffr's `PgVectorStore` and index
  a handful of docs, proving the contract swap is transparent.
- **Why it earns its place:** demonstrates the seam works — same agent, durable
  store, persists across runs.
- **Files to touch:** `/Users/rein/Public/buffr/src/session.ts`,
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`,
  `/Users/rein/Public/buffr/sql/001_agents_schema.sql`.
- **Done when:** indexing once and querying in a *new* process returns grounded
  answers without re-indexing.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "Walk me through your RAG pipeline."**
Two paths over two contracts. Index: chunk the doc into 512-char windows, embed
each with nomic (768-dim), upsert into the store with the text in the chunk's meta.
Query: embed the question the same way, cosine-search the store for top-k, hand the
chunks to the model as a tool result, model answers from them and cites. The vendor
is swappable — in-memory for tests, pgvector+HNSW in buffr.

```
  index: doc→chunk→embed→upsert        query: q→embed→search→rank→stuff→answer
  the model answers FROM chunks; retrieval quality is the whole ballgame
```
Anchor: *RAG is only as good as retrieval — a great model over bad chunks is confidently wrong.*

**Q: "What's the load-bearing part people forget?"**
That the query must be embedded by the *same* provider as the corpus, at the same
dimension — otherwise cosine ranks garbage. aptkit guards it: `assertWiring`
(`pipeline.ts:22`) throws at wiring time on a dimension mismatch, and the store
re-checks every vector. A silent dimension mismatch corrupts ranking with no error.

```
  embedder.dimension ≠ store.dimension ─► throw at wiring time (fail loud)
   the corpus and the query MUST share one embedding space
```
Anchor: *same embedder, same dimension, or the cosine scores are meaningless.*

## See also

- `04-vector-databases.md` — the store swap (in-memory vs pgvector)
- `03-chunking-strategies.md` — the 512/64 chunker
- `01-embeddings.md` — what the 768-dim vector means
- `04-agents-and-tool-use/02-tool-calling.md` — how search reaches the model
- `05-evals-and-observability/01-eval-set-types.md` — how retrieval is graded (precision@k)
