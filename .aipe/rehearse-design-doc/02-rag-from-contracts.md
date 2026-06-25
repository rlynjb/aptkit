# RFC 02 — Build RAG from two contracts, not a framework

**Summary:** The retrieval pipeline depends only on two tiny vendor-neutral contracts — `EmbeddingProvider` and `VectorStore` in `packages/retrieval/src/contracts.ts` — and never names a vendor, so the same substrate now carries two unrelated consumers (buffr's pgvector store and `@aptkit/memory`'s episodic memory) that didn't exist when the contracts were drawn.

---

## Context / problem

This isn't a first RAG. The prior shipped one was AdvntrCue — Next.js + pgvector + GPT-4, framework-shaped, production-correct, single-app. So the goal this time is explicitly *different*: not "ship a RAG feature" but "ship a reusable retrieval substrate" that other apps consume. aptkit is a library; buffr is its first consumer; there will be more.

The pull, given that history, is to reach for LangChain or LlamaIndex — the obvious move, and a genuinely fast one for a single app. But the lesson from AdvntrCue is that vector stores rotate (Pinecone, pgvector, Weaviate, Qdrant) while the *shape* never does: embed, approximate-nearest-neighbor search, retrieve. A framework couples a reusable library to its own API and its own lifecycle; a contract couples it to nothing. The decision is whether the reusable core depends on a framework's surface or on a shape you own.

> ┃ The constraint that forces the call: this is a
> ┃ library, not an app. An app can marry a framework
> ┃ and ship faster. A library that marries a framework
> ┃ exports that marriage to every consumer.

---

## Goals & non-goals

**Goals**
- The pipeline logic names no vendor — embedder and store are swappable adapters.
- A consumer can supply its own store (durable, cloud, whatever) by implementing three methods.
- The whole index→query path runs with zero infrastructure for tests.
- A dimension mismatch between embedder and store fails loud, at wiring time.

**Non-goals**
- Not shipping out-of-the-box loaders, chunkers for every format, or vendor integrations. You own your chunking.
- Not optimizing for the single-app case. For a one-off app, a framework is faster — that's a feature of the framework, not a flaw here.
- Not pushing metadata filtering into the store contract (yet). Filtering lives in the tool today; see Open questions.

The first non-goal is the one that prevents the scope fight: **"why don't you have loaders like LangChain does?" is answered before it's asked — you deliberately don't, because owning the chunk path is the point.**

---

## The decision

The shape: everything in the pipeline depends on two contracts, and two completely unrelated consumers plug into those same two contracts from outside the package.

```
  RAG FROM CONTRACTS — two seams, many consumers

  ┌─ Contracts (packages/retrieval/src/contracts.ts) ───────┐
  │  EmbeddingProvider { id, dimension, embed(texts) }       │
  │  VectorStore       { dimension, upsert(chunks),          │
  │                      search(vector, k) }                 │
  │  ── header comment: "nomic / OpenAI / pgvector /         │
  │     in-memory are incidental" ──                         │
  └───────────────┬─────────────────────────┬────────────────┘
                  │ depends on (names         │ depends on
                  │ no vendor)                │ (names no vendor)
  ┌─ Pipeline ────▼───────────────┐  ┌─ Memory ▼────────────┐
  │ indexDocument / query         │  │ @aptkit/memory       │
  │ assertWiring(): embedder.dim  │  │ conversation-memory  │
  │   === store.dim, else THROW   │  │ remember / recall    │
  │ (one-way door, fails loud)    │  │ (reuses BOTH         │
  └───────────────┬───────────────┘  │  contracts, diff     │
                  │                   │  feature)            │
                  │ store: VectorStore└──────────────────────┘
                  ▼
  ┌─ Store implementations (incidental, swappable) ─────────┐
  │  InMemoryVectorStore        PgVectorStore                │
  │  cosine over a Map          (buffr/src/pg-vector-store)  │
  │  zero-infra reference       implements VectorStore       │
  │  impl (in-repo)             pgvector  <=>  cosine        │
  │                             ── a one-line drop-in,       │
  │                                separate repo ──          │
  └──────────────────────────────────────────────────────────┘
```

The diagram is the proof, not the aspiration: two arrows go *into* the contracts from consumers that the contracts' author never coded against.

**The two contracts.** `EmbeddingProvider` is `{ id, dimension, embed(texts) }` — turn text into vectors, carry your fixed dimension. `VectorStore` is `{ dimension, upsert(chunks), search(vector, k) }` — store vectors, rank by similarity. That's the entire surface. The header comment states the principle literally: the pipeline logic never names a vendor; nomic, OpenAI, pgvector, in-memory are incidental.

**The one-way door.** `assertWiring` in `pipeline.ts` enforces `embedder.dimension === store.dimension` and throws on mismatch — *"re-index the corpus with a matching provider."* A corpus embedded at 768 dims can't be searched by a query of another dimension; that's a wiring bug, not a runtime input, so it fails at wiring time, loudly. Each store also self-checks: `InMemoryVectorStore` and `PgVectorStore` both throw on a vector whose length doesn't match `this.dimension`.

**The zero-infra reference impl.** `InMemoryVectorStore` is cosine similarity over a `Map` — index a few docs, query, rank, return. It exists so the whole pipeline runs with no Postgres, which is what makes the tests cheap.

**The proof the abstraction paid off** — two independent consumers ride the same contracts:

1. **buffr's `PgVectorStore`** (`/Users/rein/Public/buffr/src/pg-vector-store.ts`) is `class PgVectorStore implements VectorStore`, importing `VectorStore` from `@rlynjb/aptkit-core`. It uses pgvector's `<=>` cosine-distance operator with `1 - distance` as the score and rebuilds the same `meta` shape so the `search_knowledge_base` tool's citations keep working. A verified one-line drop-in: swap the store, the pipeline doesn't change.

2. **`@aptkit/memory`'s episodic memory** (`packages/memory/src/conversation-memory.ts`) reuses *both* contracts for a totally different feature — `remember` embeds a conversational exchange and upserts it; `recall` embeds a query and searches. Same `EmbeddingProvider`, same `VectorStore`, zero new abstraction. It even handles the metadata-filter gap the same way the tool does: over-fetch (`k * 4`) then filter in memory, because the contract has no metadata filter.

> ┃ The yes-getting sentence: "Two consumers I didn't
> ┃ design for plugged into these two contracts without
> ┃ a single change to the pipeline. That's not a clean
> ┃ abstraction in theory — it's one that already paid."

---

## Alternatives considered

**(a) LangChain / LlamaIndex.**
The fast path: loaders, chunkers, retrievers, integrations, all imported. It lost *for a library* — it's lock-in, it teaches you the framework's API instead of the substrate, and a version bump or a hidden chunking default becomes your consumers' problem. But name the flip condition honestly: **for a one-off app, the framework legitimately wins** — faster to ship, and you don't need the reusable shape. This decision is correct *because* the target is a reusable library; flip the target and the answer flips.

**(b) A vector-DB SDK directly (Pinecone/pgvector client in the pipeline).**
Skip the framework, code the pipeline straight against one store's client. It lost because it couples the library to one vendor — the exact coupling the contracts exist to prevent. The moment a second store is wanted (and there now are two), the SDK-in-the-pipeline approach forces a rewrite that the contract makes a drop-in.

```
  WHERE A REVIEWER PUSHES — "isn't this reinventing the wheel?"

  This is the trap. Don't defend the rebuild as universally right.
  Reframe on target: "For an app, yes — I'd use LangChain. This is a
  library meant to be consumed by other apps, so the reusable contract
  IS the product. The proof it was worth it: two consumers ride it
  already." Conceding the app case is what makes the library case land.
```

---

## Tradeoffs accepted

We chose contracts over a framework, accepting that we own more code and import less glue. Concretely: no out-of-the-box document loaders, no library of chunking strategies, no pre-built vendor integrations. The chunker (`chunkText`) and the index/query paths are ours to write and maintain.

The buy is proportional: in-memory tests with no external service, no framework lock-in, and a substrate that two unrelated features already share. For a single app that buy would be over-priced; for a library consumed by others, the glue you'd import is exactly the glue you'd later fight.

---

## Risks & mitigations

```
  RISK                              MITIGATION / STATUS
  ────                              ───────────────────
  Dimension mismatch silently       assertWiring throws at wiring time; each
  corrupts ranking                  store re-checks vector length on upsert/search

  Metadata filtering lives in the   KNOWN COST, not yet mitigated: the tool
  tool, not the store → over-fetch  over-fetches fetchK = topK*4 and post-filters
  + in-memory post-filter           in memory. Correct for in-memory; wasteful
                                    against pgvector, where it could push into a
                                    SQL WHERE. Named as an open question.

  More owned code → more surface     the surface is tiny (two contracts, three
  to maintain                       methods on the store); the chunker is the
                                    only real owned logic of size
```

The second row is the honest scar: the same over-fetch-then-filter pattern appears in *both* the retrieval tool and conversation memory, precisely because the `VectorStore` contract has no filter. Against pgvector that's wasted rows the SQL could have excluded.

---

## Rollout / migration

The contracts are stable and shipped — they're part of the published `@rlynjb/aptkit-core` surface. Rollout for a new consumer is "implement three methods": a new store implements `dimension`, `upsert`, `search`, and it drops in behind the pipeline with no pipeline change. buffr's `PgVectorStore` is the worked example — it took the contract import and the three methods, nothing more.

There's no data-in-flight migration concern for the *contracts* themselves; the migration risk is dimensional — re-embedding a corpus if the embedder changes — and that's exactly what `assertWiring` is positioned to catch before it corrupts anything.

---

## Open questions

- **Push filtering into the `VectorStore` contract.** The single most consequential refinement: add an optional metadata-filter capability to `search` so pgvector can filter in SQL instead of the tool (and memory) over-fetching `k * 4` and post-filtering in memory. The cost is widening a deliberately tiny contract; the buy is dropping the wasted-rows tax against durable stores. Undecided which way the tradeoff falls.
- **Streaming chunkers.** Today indexing chunks a whole document in memory. For large corpora, should the pipeline accept a streaming chunker? Not needed at current scale; named so it isn't a surprise later.
- **Approximate vs exact search guarantees.** `InMemoryVectorStore` is an exact linear scan; `PgVectorStore` can use an approximate index. The contract doesn't say which a store provides. Should it carry a guarantee hint? Open.
