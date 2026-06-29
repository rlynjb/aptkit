# RFC: RAG built on two contracts, not a vendor

## 1. Summary

The retrieval pipeline depends on exactly two interfaces — `EmbeddingProvider` and `VectorStore` (`packages/retrieval/src/contracts.ts`) — and **never names a vendor**. nomic, OpenAI, pgvector, in-memory are all incidental implementations behind those two types. The payoff isn't theoretical: **two unrelated consumers ride the same contracts** — buffr's `PgVectorStore` (a durable drop-in) and `@aptkit/memory` (a different feature entirely, episodic conversation memory). That's the proof the abstraction was the right boundary.

## 2. Context / problem

RAG is fundamentally `embed → store → search → rank`. The naive way to build it is to reach straight for a vector DB SDK and an embedding API and wire your pipeline to their call signatures. The moment you do that, "the RAG pipeline" and "Pinecone" (or pgvector, or Weaviate) become the same object — you can't develop offline, you can't test without the DB, and swapping the store is a rewrite.

This repo had a specific constraint that made vendor-coupling a non-starter: **aptkit is deployment-agnostic on purpose.** The persistent Postgres `agents` schema lives in the companion repo *buffr*, not here (project context, data-model section). aptkit ships to npm with no database. So the pipeline literally cannot import a pgvector client — the durable store lives in a different repo and gets injected at deploy time. The contract isn't a nicety; it's the only thing that lets the producer and the consumer live in separate repos.

## 3. Goals & non-goals

**Goals**
- Pipeline logic that compiles and runs with zero vendor dependency — an in-memory store and a local embedder are enough.
- A durable store (buffr's pgvector) drops in by implementing one interface, no pipeline change.
- Catch the one un-recoverable wiring mistake — a dimension mismatch — loudly, at wiring time.

**Non-goals**
- A metadata-filter predicate on the `VectorStore` contract. Filtering lives one layer up (over-fetch + post-filter in the tool). See Tradeoffs.
- Owning the embedding model or the DB. Both are injected; the pipeline doesn't pick them.
- Hybrid / keyword search. The contract is pure vector ANN.

## 4. The decision

Two types, three implementations, one guard. The pipeline functions take a `RetrievalWiring = { embedder, store }` and operate over the interfaces — they have no idea what's behind them.

```
  RAG from contracts — one pipeline, three+ implementations

  ┌─ aptkit (published, no DB) ─────────────────────────────────────────┐
  │                                                                     │
  │   indexDocument / queryKnowledgeBase / createRetrievalPipeline      │
  │   ── operate ONLY over these two types ──                           │
  │                                                                     │
  │   ┌───────────────────────┐        ┌───────────────────────────┐   │
  │   │ EmbeddingProvider     │        │ VectorStore               │   │
  │   │  id, dimension        │        │  dimension                │   │
  │   │  embed(texts)→vec[][] │        │  upsert(chunks)           │   │
  │   └──────────┬────────────┘        │  search(vec,k)→hits[]     │   │
  │              │                     └─────────────┬─────────────┘   │
  │     assertWiring(): embedder.dimension === store.dimension         │
  │              │ (pipeline.ts lines 22–29 — fail loud at wiring)     │
  └──────────────┼───────────────────────────────────┼─────────────────┘
                 │                                     │
   ┌─────────────▼──────────┐         ┌────────────────▼────────────────┐
   │ OllamaEmbeddingProvider│         │ InMemoryVectorStore (cosine scan)│  ← in repo
   │ (nomic, 768-dim)       │         │ PgVectorStore  (buffr, pgvector) │  ← cross-repo drop-in
   └────────────────────────┘         └──────────────────────────────────┘

   AND a second, unrelated consumer of the SAME two types:
   ┌─────────────────────────────────────────────────────────────────────┐
   │ @aptkit/memory — createConversationMemory({ embedder, store })        │
   │   remember() = the index path · recall() = the query path             │
   │   (a different FEATURE, zero new infrastructure)                      │
   └─────────────────────────────────────────────────────────────────────┘
```

The kernel — what breaks if each part is gone:

- **`EmbeddingProvider` (contracts.ts lines 21–26)** — `embed(texts) → number[][]` plus a fixed `dimension`. *Remove it:* the pipeline hard-codes a vendor's embedding call and can't run offline or in tests.
- **`VectorStore` (lines 28–37)** — `upsert(chunks)` + `search(vector, k) → hits`, and it carries its *own* `dimension`. *Remove it:* same coupling, plus you lose the place the dimension invariant is enforced.
- **`assertWiring()` (pipeline.ts lines 22–29)** — guards the one-way door. A corpus embedded at 768-dim can't be searched by a query of another dimension, so a mismatch throws *at wiring time* with a message that names the offending provider. *Remove it:* the mismatch surfaces as garbage similarity scores at query time — a silent correctness bug instead of a loud startup crash.

**The proof the boundary was right — two consumers, not one.** An abstraction with a single implementation is a guess. This one has two unrelated riders:

1. **buffr's `PgVectorStore`** (`/Users/rein/Public/buffr/src/pg-vector-store.ts`) — `implements VectorStore` from the published `@rlynjb/aptkit-core`. It runs cosine over pgvector (`1 - (embedding <=> $1)`, lines 67–85) and rebuilds the in-memory `meta` shape (`docId`/`chunkIndex`/`text`) so the `search_knowledge_base` tool's citations work unchanged. It's a *verified drop-in*: a different repo, a real database, zero pipeline edits.
2. **`@aptkit/memory`** (`packages/memory/src/conversation-memory.ts`) — episodic conversation memory, a *different feature*. `createConversationMemory({ embedder, store })` (lines 60–108) is the strongest evidence: `remember()` is literally the RAG index path and `recall()` is the query path, over the *same two contracts*, with **zero new infrastructure**. It even re-runs the same dimension guard (lines 62–66).

When the same two interfaces carry both a vendor swap *and* a brand-new feature, the boundary wasn't a guess.

## 5. Alternatives considered

**A. LangChain / LlamaIndex.** A batteries-included RAG framework — retrievers, chains, memory, the lot. *Why it lost:* you adopt their abstractions, their versioning, and their opinions about control flow, and the repo's whole reason for existing is to *own* the reusable agent primitives, not rent them. Two contracts you wrote are smaller and clearer than a framework you have to learn. Flip condition: a production deadline where shipping fast beats owning the substrate — then a framework's done-ness wins.

**B. A vector-DB SDK directly (pgvector client / Pinecone SDK).** Skip the abstraction, call the DB. *Why it lost:* it makes aptkit un-publishable as a DB-free package and un-testable without a running database. And it couples the pipeline to a vendor in a repo that explicitly defers the database to buffr. The `InMemoryVectorStore` + the cross-repo `PgVectorStore` only exist *because* the contract decoupled them.

## 6. Tradeoffs accepted

We chose two hand-written contracts, accepting that **we own more code** — `InMemoryVectorStore`, `OllamaEmbeddingProvider`, the chunker, the pipeline glue — that a framework would have handed us. That's deliberate: owned code is code you can read, test deterministically, and ship without a vendor. The Studio RAG page proves the dividend — it runs an entirely in-browser RAG with a fake embedder and `InMemoryVectorStore`, no network, because the contract let a third "implementation" exist for free.

The second accepted cost: **metadata filtering doesn't live on the `VectorStore` contract.** The contract is pure ANN (`search(vector, k)`), so filtering happens one layer up in `search_knowledge_base` — over-fetch `topK * 4`, then post-filter in `matchesFilter` (`search-knowledge-base-tool.ts` lines 88–90, 101–106). `@aptkit/memory.recall()` does the same dance, fetching `max(k*4, 20)` and filtering by `kind` client-side (conversation-memory.ts lines 94–95). That's wasted fetch bandwidth, owned on purpose: keeping the contract narrow is what made it trivial for `PgVectorStore` to implement and for memory to reuse.

## 7. Risks & mitigations

```
  Risk → guard

  embedder/store dimension drift  ─► assertWiring() throws at wiring time,
                                     names the provider (pipeline.ts 22–29)
  a new store forgets the guard    ─► VectorStore carries its OWN dimension;
                                     PgVectorStore.assertDim re-checks (buffr 32–36)
  over-fetch wastes DB bandwidth   ─► bounded multiplier (k*4), not unbounded
  citations break on a new store   ─► meta-shape contract (docId/chunkIndex/text)
                                     rebuilt by each store (PgVectorStore 80–84)
```

## 8. Rollout / migration

The contract shipped first; implementations followed without touching the pipeline. A consumer's migration from in-memory to durable is: implement `VectorStore` against your DB, re-index the corpus once (the dimension is a one-way door — you can't search an old corpus with a new embedder), and inject the new store. buffr did exactly this. **The shape that must not change** is the two contracts plus the `meta` keys citations depend on (`docId`, `chunkIndex`, `text`) — those are a cross-repo compatibility surface now, since buffr's `PgVectorStore` rebuilds them.

## 9. Open questions

- **Should `VectorStore` grow a filter predicate?** Today every consumer over-fetches and post-filters. A `search(vector, k, filter?)` signature would push the filter into pgvector's `WHERE` and stop the bandwidth waste — at the cost of a wider contract that every store must implement.
- **Embedding-model identity isn't enforced across re-indexes.** `assertWiring` checks dimension, not *which* 768-dim model produced the corpus. Two different 768-dim embedders pass the guard but produce incomparable vectors.
- **Memory and documents share a store with only a `kind` tag** partitioning them. At scale, is a client-side `kind` filter enough, or does memory need a dedicated store / a real predicate?

---

**Coach note.** The reviewer who's read a hundred RAG repos will say "everyone abstracts the vector store, so what?" Your answer is the thing most repos can't say: *"Two unrelated things ride these two interfaces — buffr's pgvector store in a different repo, and an episodic-memory feature that's just the index and query paths reused. The second consumer is the proof; one implementation is a guess, two is a boundary."* Lead with the second consumer. That's the sentence that separates "I read about hexagonal architecture" from "I shipped it and it paid off twice."
