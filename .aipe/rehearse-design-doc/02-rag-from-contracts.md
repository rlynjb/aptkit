# RFC 02 — A RAG pipeline built on two contracts, not a framework

**Summary:** Build the retrieval pipeline against two vendor-neutral ports — the
embedding provider (`EmbeddingProvider`) and the vector store (`VectorStore`) in
`packages/retrieval/src/contracts.ts` — so the pipeline logic never names a
vendor, the wiring guard (`assertWiring` in `pipeline.ts`) catches dimension
mismatches at construction time, and the same two contracts power a second
consumer (episodic memory) and a third-party adapter (buffr's `PgVectorStore`)
with zero new infrastructure.

## Context / problem

AptKit needs RAG: index documents, embed a query, search by similarity, hand
ranked chunks to an agent as grounding. The obvious move in 2024 is to reach for
a framework — LangChain or LlamaIndex — and get retrieval "for free."

The constraint that ruled against that: AptKit's reason to exist is a
**provider-neutral core**. Everything already depends on the model contract
(`ModelProvider.complete()`), never a vendor SDK. RAG is the same problem one
layer over — an embedding vendor and a vector database are just more vendors. If
the pipeline imports a framework that imports Pinecone's client and OpenAI's
embeddings, the neutrality the rest of the core fought for leaks at the
retrieval seam. And the deployment target (buffr) uses Postgres + pgvector,
which a framework's happy path doesn't center.

So the question wasn't "how do we do RAG" — the shape (embed → store → search →
rank) is well understood. It was: **where does the vendor boundary go, and who
owns the code on each side of it?**

## Goals & non-goals

**Goals:**

- The pipeline logic names no vendor — nomic, OpenAI, pgvector, in-memory are
  all incidental behind a contract.
- Swapping the embedder or the store is an injection, not a rewrite.
- A dimension mismatch (768-dim corpus, different-dim query) fails loud, at
  wiring time, not as silent garbage results.
- Retrieval reaches agents as a *tool*, not bespoke control flow — the model
  decides when to search.

**Non-goals:**

- A general-purpose retrieval framework. Two contracts and a pipeline, not a
  plugin ecosystem.
- Metadata filtering *in the contract*. The `VectorStore` contract has no
  metadata predicate by design (see Open questions).
- Hybrid / re-ranking / query rewriting. The pipeline is dense-vector retrieval;
  fancier ranking is out of scope here.

## The decision

Define two ports and make the pipeline depend only on them. Everything concrete
— the embedding model, the database — is an adapter injected at the edge. This
is dependency inversion applied to retrieval: the pipeline depends on the
contract, not the implementation.

```
  RAG from contracts — the pipeline depends only on two ports

  ┌─ Agent layer ──────────────────────────────────────────────────┐
  │  rag-query agent  →  search_knowledge_base tool (the seam to RAG)│
  └────────────────────────────────┬─────────────────────────────────┘
                                   │ pipeline.query(q, topK)
  ┌─ Retrieval layer (vendor-neutral) ─────────────────────────────┐
  │   indexDocument / queryKnowledgeBase                            │
  │        │  depends ONLY on ↓                                     │
  │   ┌────▼─────────────┐        ┌──────────────────┐             │
  │   │ EmbeddingProvider│  PORT  │   VectorStore    │  PORT       │
  │   │  embed(): #[][]  │        │ upsert / search  │             │
  │   │  dimension       │        │ dimension        │             │
  │   └────▲─────────────┘        └────────▲─────────┘             │
  │        │ assertWiring(): dimensions must match ─┘  (loud)      │
  └────────┼───────────────────────────────┼──────────────────────┘
           │ adapter                        │ adapter
  ┌─ Provider / storage layer ──────────────┼──────────────────────┐
  │  OllamaEmbeddingProvider (nomic, 768)   │  InMemoryVectorStore  │
  │                                         │  PgVectorStore (buffr)│ ← drop-in
  └──────────────────────────────────────────────────────────────────┘
```

The load-bearing parts, by what breaks if you remove each:

- **The two contracts** (`contracts.ts`). The whole neutrality claim. The file's
  own comment is the contract: "the pipeline logic never names a vendor." Inline
  a vendor and the seam closes.
- **`assertWiring`** (`pipeline.ts:22–29`). The dimension guard. A corpus
  embedded at 768 dims cannot be searched by a query of another dimension — the
  results would be silent garbage. `assertWiring` throws at construction
  (`createRetrievalPipeline`) and on every index/query, turning a one-way data
  door into a loud wiring error: `dimension mismatch: embedder "..." is 768-dim
  but store is N-dim`. Drop it and a misconfigured pipeline indexes
  unsearchable vectors quietly.
- **Index path** (`indexDocument`, lines 32–47): doc → `chunkText` → `embed` →
  `upsert`, with each chunk carrying `{docId, chunkIndex, text}` in meta so the
  tool can build citations later.
- **Query path** (`queryKnowledgeBase`, lines 50–59): query → `embed` →
  `store.search` → ranked hits. The mirror of index.
- **The tool seam** (`search_knowledge_base`,
  `search-knowledge-base-tool.ts`). Retrieval reaches the agent as a registered
  tool, so the *model* decides when to search (agentic retrieval). The tool adds
  two weak-model guards over the raw query path: a `minTopK` floor (line 81) and
  a hallucination-tolerant `matchesFilter` (lines 101–106).

### Why this is the doc, not just a study topic — the abstraction paid off

A contract boundary is a *claim* until something else rides it. Two things do,
which is the proof this seam was placed right:

```
  One pair of contracts, three independent consumers

  EmbeddingProvider + VectorStore  (packages/retrieval/src/contracts.ts)
        ▲                ▲                         ▲
        │                │                         │
  ┌─────┴──────┐   ┌─────┴─────────┐        ┌──────┴─────────────┐
  │ retrieval  │   │ @aptkit/memory│        │ buffr PgVectorStore│
  │ pipeline   │   │ remember=index│        │ implements         │
  │ (docs RAG) │   │ recall=query  │        │ VectorStore        │
  └────────────┘   └───────────────┘        └────────────────────┘
   first consumer   second consumer          third-party adapter
```

- **`@aptkit/memory`** (`conversation-memory.ts`) is a *second* consumer of the
  exact same two contracts. `remember` is the index path; `recall` is the query
  path. Episodic conversation memory shipped with **zero new infrastructure** —
  it's RAG pointed at conversation turns instead of documents, tagged
  `kind:'memory'`. That it needed no new contract is the strongest evidence the
  boundary was the right one.
- **buffr's `PgVectorStore`** (`/Users/rein/Public/buffr/src/pg-vector-store.ts`)
  is a verified drop-in adapter — a Postgres/pgvector implementation of the
  `VectorStore` contract, living in a *different repo*, that the pipeline accepts
  without changing a line. It even rebuilds the same `{docId, chunkIndex, text}`
  meta shape on `search` so the citation tool keeps working. That's the swap the
  contract promised, exercised across a repo boundary.

## Alternatives considered

**1. LangChain / LlamaIndex.** Retrieval, chains, and a vector-store abstraction
out of the box; far less code to write. *Why it lost:* it inverts the dependency
the wrong way — the core would depend on a framework that depends on vendors,
and the neutrality the rest of AptKit enforces leaks at the retrieval seam. The
framework's abstractions are also heavier than two interfaces; you adopt its
worldview to get its convenience. **The flip condition:** under a production
deadline where retrieval quality and breadth (hybrid search, re-rankers,
loaders) matter more than owning the boundary, a framework is the right call.
That deadline wasn't this one — owning a clean seam was the point.

**2. Code directly against a vector-DB SDK** (pgvector client, or Pinecone's).
Simplest path to a working query; no contract indirection. *Why it lost:* it
welds the pipeline to one database. buffr uses pgvector; tests want in-memory;
a future deployment might want something else. With the SDK inlined, each is a
rewrite of the pipeline. With the contract, each is an adapter. The in-memory
store *is* the test double — no mocking framework needed.

**3. One concrete embedder + store, no contract at all.** Hardcode
`OllamaEmbeddingProvider` + `InMemoryVectorStore`, skip the interfaces. *Why it
lost:* memory and buffr could never have ridden it. The second and third
consumers are exactly what the contract bought; without it, memory would be a
parallel copy of the index/query logic and `PgVectorStore` would have nothing to
implement.

## Tradeoffs accepted

We chose to own the retrieval code behind two contracts, accepting that we write
and maintain more of it than a framework user does — the chunker, the in-memory
store, the cosine scan, the tool, the wiring guard are all ours to keep working.
We took that cost deliberately: the code we own is small, has no transitive
vendor dependencies, and the boundary is exactly where we want it. A framework
would have written less of it for us and put the seam in the wrong place. More
code we control beats less code we don't.

## Risks & mitigations

- **Silent dimension mismatch** → `assertWiring` throws loud at wiring time and
  on every index/query; the store also rejects wrong-length vectors. A
  mismatch can't reach results as garbage.
- **A new adapter drifts from the contract** → the contract is a TypeScript
  type; `PgVectorStore implements VectorStore` is compiler-checked. An adapter
  that doesn't satisfy the shape doesn't build.
- **Weak model starves retrieval** (`top_k: 1` on a multi-part question) →
  `minTopK` floor in the tool raises the effective `k`.
- **Weak model hallucinates a filter** that matches nothing → `matchesFilter`
  ignores keys absent from a chunk's meta, so a bogus filter can't wipe every
  result.

## Rollout / migration

The contracts shipped with the in-memory adapter first; agents got retrieval via
the `search_knowledge_base` tool. Memory was added later against the same
contracts — additive, no change to retrieval. buffr supplies `PgVectorStore` as
the durable adapter at deploy time; the swap from in-memory to Postgres is a
construction-site change, not a pipeline change. Because the contracts
(`EmbeddingProvider` / `VectorStore`) are part of the published `@rlynjb/aptkit-core`
surface, changing their shape is a breaking change that ripples to buffr — they
are a compatibility contract, treated as one.

## Open questions

- **Metadata filtering lives in the tool, not the contract.** The
  `VectorStore.search` contract has no metadata predicate, so both the
  `search_knowledge_base` tool and memory's `recall` **over-fetch then
  post-filter** in application code (`fetchK = topK * 4`, then filter). It works,
  but it's O(over-fetch) and can't push the predicate down to a database that
  could index it (pgvector could filter in SQL). Whether to add a filter
  argument to the contract — and pay the cost of every adapter implementing it —
  is open.
- **Chunking is fixed.** One `chunkText` strategy for all documents; no
  per-document chunk sizing or overlap tuning. Fine for now, unmeasured against
  retrieval quality.
- **Only dense retrieval.** No hybrid (keyword + vector) or re-ranking. If
  recall@k turns out weak on real corpora, that's the first thing to add — and
  it'd likely go behind the tool, not the contract.
