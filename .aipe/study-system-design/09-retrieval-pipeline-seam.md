# Retrieval pipeline seam — RAG as two swappable adapters behind a tool

**Industry name(s):** RAG (Retrieval-Augmented Generation) · provider-neutral retrieval · retrieval-as-a-tool. **Type:** Industry standard pattern, project-specific wiring.

---

## Zoom out, then zoom in

The rest of this guide is about a system with *no* persistent data — agents that take a request, call a model, emit a trace, and forget everything. `@aptkit/retrieval` is the first package that builds a *corpus* and searches it. But notice where it sits: it doesn't bolt a database onto the runtime. It hangs two new contracts off the side and exposes the whole thing to an agent as **one more tool**.

```
  Zoom out — where retrieval sits in AptKit

  ┌─ Capability layer — packages/agents/* ───────────────────────────────┐
  │  anomaly-monitoring   diagnostic   recommendation   query   rubric    │
  │                                                                       │
  │  ★ rag-query ★  ── composes model + retrieval tool + profile ──┐      │ ← we are here
  └─────────────────────────────────────────────────────────────────┼─────┘
                                    │  runAgentLoop(...) + 1 tool     │
                                    ▼                                 │
  ┌─ Runtime core — packages/runtime ────────────────────────────────┼────┐
  │  runAgentLoop  ──►  ModelProvider.complete()   (the model seam)   │    │
  └──────────────────────────────────────────────────────────────────┼────┘
                                    │  the agent calls a tool         │
  ┌─ Retrieval — packages/retrieval ──────────────────────────────────▼───┐
  │  search_knowledge_base tool  ──►  RetrievalPipeline.query()            │
  │       query → embed → search → rank                                    │
  │            │ EmbeddingProvider seam │ VectorStore seam │               │
  │            ▼                        ▼                                  │
  │   OllamaEmbeddingProvider     InMemoryVectorStore  (cosine over a Map) │
  │   (nomic, 768-dim, over HTTP) (PgVectorStore is a later drop-in)       │
  └───────────────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is RAG — retrieve relevant passages, augment the prompt with them, generate a grounded answer. You already see the shape: `retrieve → augment → generate`. What's worth studying here is *how the retrieve step is wired so no vendor name appears in the pipeline logic*. The embedding model and the vector store are each a one-method contract; the pipeline never knows whether it's talking to nomic-over-Ollama or pgvector. That's the same move `ModelProvider` makes for reasoning (`01-provider-abstraction.md`), applied a second time to a different axis.

---

## The structure pass

Three layers, one axis, two new seams.

**Layers (outer → inner):**

```
  rag-query agent          → composes the capability (model + tool + profile)
    search_knowledge_base   → exposes retrieval to the LLM as a tool
      RetrievalPipeline      → the index/query orchestration (vendor-neutral)
        EmbeddingProvider    → text → vectors   (one swappable adapter)
        VectorStore          → store + ANN search (a second swappable adapter)
```

**The axis to hold constant: "who knows the vendor name?"** Trace it down and watch it flip — that flip *is* the design.

```
  axis = "does this layer name a vendor?"  — traced downward

  rag-query agent          → NO  (just "a ModelProvider", "a ToolRegistry")
  search_knowledge_base    → NO  (just "a RetrievalPipeline")
  RetrievalPipeline        → NO  (just "an embedder", "a store")
  ───────────────────────────  the seam: below here, vendor is named ───
  OllamaEmbeddingProvider  → YES (nomic-embed-text, localhost:11434)
  InMemoryVectorStore      → YES (cosine, in-process Map)
```

**The two load-bearing seams** (`packages/retrieval/src/contracts.ts:22-37`):

- **`EmbeddingProvider`** — `{ id, dimension, embed(texts) }`. Turns text into vectors. The `dimension` is a property *of the provider* (768 for nomic) — that fact is what makes the next seam safe.
- **`VectorStore`** — `{ dimension, upsert(chunks), search(vector, k) }`. Stores embeddings and does the nearest-neighbour search. Carries its *own* `dimension` so it can reject a vector of the wrong length loudly.

A seam is load-bearing when an axis flips across it. The vendor-name axis flips at the contract boundary: above it, swap nomic for OpenAI embeddings or in-memory for pgvector and *not one line of pipeline code changes*. That's the test passing.

---

## How it works

### Move 1 — the mental model

You know how `ModelProvider.complete()` lets every agent call "the model" without knowing which vendor answers? Retrieval does the same trick twice — once for the thing that makes vectors, once for the thing that stores and searches them. The pipeline is just glue between two holes, and you plug a concrete adapter into each hole at wiring time.

```
  RAG — two paths through one pipeline, two pluggable holes

         INDEX path (offline, build the corpus)
  doc ─► chunkText ─► embedder.embed() ─► store.upsert()
         (512-char       │  hole 1            │  hole 2
          windows)       ▼                    ▼
                   [EmbeddingProvider]   [VectorStore]
                         ▲                    ▲
         QUERY path (online, answer a question)
  query ───────────► embedder.embed() ─► store.search(k) ─► ranked hits
```

Same two holes serve both paths. Index fills the store; query reads it. The holes never change; the path through them does.

### Move 2 — the walkthrough

**The index path: doc → chunk → embed → upsert.** Start where the corpus gets built (`packages/retrieval/src/pipeline.ts:32-47`). You hand `indexDocument` a `{ id, text, meta }`. It runs `chunkText` to slice the text into ~512-char windows with a 64-char overlap, calls `embedder.embed(texts)` to get one vector per chunk, then stamps each chunk with a stable id (`${doc.id}#${i}`) and the original text in `meta` before `store.upsert`. Here's the part that bites if you skip it: the **text is carried into `meta`** so the search result can quote it back as a citation later. Drop that and your retrieval returns ids and scores but nothing the model can ground an answer on.

```
  Layers-and-hops — indexing one document

  ┌─ caller ──────┐  hop 1: index({id,text})   ┌─ pipeline ─────────┐
  │ ask.ts CORPUS │ ─────────────────────────► │ indexDocument      │
  └───────────────┘                            └─────────┬──────────┘
                          hop 2: chunkText(text)         │
                                                         ▼
                          hop 3: embed(chunks)   ┌─ EmbeddingProvider ┐
                                ◄─ number[][] ─── │ Ollama → nomic     │ HTTP
                                                  └────────────────────┘
                          hop 4: upsert(chunks    ┌─ VectorStore ──────┐
                                  + text in meta) │ InMemory (Map)     │
                                ───────────────►  └────────────────────┘
```

**The query path: query → embed → search → rank.** The mirror image (`pipeline.ts:50-59`). Embed the *query string* with the same provider, hand the resulting vector to `store.search(vector, topK)`, get back hits ranked by score. The store owns the ranking — `InMemoryVectorStore` computes cosine similarity against every stored chunk and sorts (`in-memory-vector-store.ts:25-33`). That's a linear scan: fine for a few hundred chunks, the thing `PgVectorStore` would replace with an ANN index at scale.

**The dimension one-way door — the seam's safety latch.** This is the load-bearing part people forget. An embedding only means anything when compared to another embedding *from the same model*. A 768-dim nomic vector and a 1536-dim OpenAI vector live in different spaces — cosine between them is garbage. So the pipeline asserts at wiring time that `embedder.dimension === store.dimension` (`pipeline.ts:22-29`), and the store re-checks every individual vector's length on `upsert` and `search` (`in-memory-vector-store.ts:36-42`). Remove this guard and a mismatched swap *silently* corrupts ranking — every score is meaningless but nothing throws. Failing loud at wiring time is what makes the "swap the adapter" promise actually safe.

```
  The one-way door — why dimension is checked twice

  wiring time:   embedder.dimension ─── must equal ──► store.dimension
                       (768 nomic)                       (768)
                            │ if they disagree → throw, refuse to build
  per-vector:    every upsert/search vector.length must equal store.dimension
                            │ if not → throw "dimension mismatch"
                            ▼
                 a corpus embedded at 768 can ONLY be queried at 768
```

**Retrieval-as-a-tool: the second seam.** Now the part that ties retrieval back into the agent world (`packages/retrieval/src/search-knowledge-base-tool.ts:43-99`). `createSearchKnowledgeBaseTool(pipeline)` wraps the pipeline's `query()` in a `{ definition, handler }` pair — the exact shape `runAgentLoop` already knows how to call. The definition is a JSON schema (`query`, `top_k`, optional `filter`); the handler runs the query path and shapes each hit into a `citation` string (`[docId] snippet`). This is the same boundary as every other tool in the repo — the agent doesn't know it's doing RAG, it just sees a tool named `search_knowledge_base` (`04-capability-as-tool-policy.md`).

Two defensive choices in the tool earn their place:
- **`minTopK` floor** (`tool.ts:51, 81`). A weak local model (Gemma) tends to ask for `top_k: 1`, which starves a multi-part question. The floor forces at least N results regardless of what the model requested. The capstone sets `minTopK: 4` (`ask.ts:48`).
- **Permissive filter matching** (`tool.ts:101-106`). A filter key only excludes a hit that *has* that key with a different value — a hallucinated filter key the chunk doesn't carry is ignored, so a confused model can't silently wipe every result.

**Capability composition: three packages, one constructor.** The rag-query agent is the payoff (`packages/agents/rag-query/src/rag-query-agent.ts:49-84`). It takes three injected dependencies and composes them:

```
  RagQueryAgent({ model, tools, profile })  — three holes, one capability

  A  model    : ModelProvider   → the reasoning (guarded Gemma)
  B  tools    : ToolRegistry     → holds search_knowledge_base
  C  profile  : string           → me.md text, injected into the system prompt
                    │
                    ▼ injectProfile(template, profile, {position:'start'})
            then renderPromptTemplate → final system prompt
                    │
                    ▼ filterToolsForPolicy(allTools, ragQueryToolPolicy)
            least-privilege: this agent may ONLY call search_knowledge_base
                    │
                    ▼ runAgentLoop({ maxTurns:6, maxToolCalls:4, synthesisInstruction })
            same bounded loop as every other agent (02-bounded-agent-loop.md)
```

Profile injection (`packages/context/src/profile-injector.ts:25-38`) is pure string-in/string-out — it prepends the `me.md` text under a heading, *before* template rendering so `{placeholder}`s survive. The tool policy (`rag-query-agent.ts:15-18`) is the same allowlist mechanism as the other five agents — this one is granted exactly one tool.

### Move 3 — the principle

The whole RAG capability adds zero new architectural *machinery*. It reuses three seams the repo already had — the tool contract, the agent loop, the tool policy — and adds two new ones (`EmbeddingProvider`, `VectorStore`) that are *the same shape* as `ModelProvider`: a narrow interface, a swappable adapter behind it, a vendor name that never leaks upward. When you find yourself adding a capability and the new code is mostly *contracts and wiring* rather than new control flow, that's the sign the existing seams were the right ones. The proof landed shortly after: `@aptkit/memory` became a *second consumer* of these exact two seams with no new infrastructure at all (`10-memory-store-topology.md`) — one consumer could be a coincidence; two is the boundary generalizing.

---

## Primary diagram

The whole retrieval capability in one frame — index offline, query online, both through two pluggable adapters, exposed to a bounded agent as one tool.

```
  AptKit retrieval — full capability map

  ┌─ Capability — packages/agents/rag-query ──────────────────────────────┐
  │  RagQueryAgent.answer(question)                                        │
  │    inject profile → render system → filter tools → runAgentLoop        │
  │       maxTurns 6 · maxToolCalls 4 · forced synthesis turn              │
  └───────────────────────────────┬───────────────────────────────────────┘
              model.complete()     │      tool: search_knowledge_base
        ┌──────────────────────────┘                  │
        ▼                                              ▼
  ┌─ Provider ─────────────┐         ┌─ Retrieval — packages/retrieval ──────┐
  │ ContextWindowGuarded   │         │  search_knowledge_base tool           │
  │   → GemmaModelProvider │         │    → RetrievalPipeline.query(q, k)    │
  │   (Ollama gemma2:9b)   │         │  ┌─ QUERY: q → embed → search → rank ┐ │
  └────────────────────────┘         │  ┌─ INDEX: doc → chunk → embed →     │ │
                                     │  │           upsert (text in meta)   │ │
                                     │  ▼ EmbeddingProvider │ VectorStore   │ │
                                     │  OllamaEmbedding     │ InMemory      │ │
                                     │  (nomic, 768-dim,    │ (cosine over  │ │
                                     │   localhost:11434)   │  a Map)       │ │
                                     │  dimension checked at wiring + per-vector│
                                     └───────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** This is the capstone that proves the toolkit composes end to end with *zero cloud*: a local reasoning model (Gemma via Ollama), local embeddings (nomic via Ollama), an in-memory store, and a personal-notes corpus, all driven from one terminal command. The hand-test (`packages/agents/rag-query/scripts/ask.ts`) indexes three tiny notes and answers a question grounded in them, printing every tool call. It's the "build the whole RAG pipeline yourself, see it work, swap a real vector store later" demonstration — the AdvntrCue RAG shape from your own portfolio, but with the vector store and embedding model behind contracts instead of pinned to pgvector + OpenAI.

**Code side by side — the dimension guard (`packages/retrieval/src/pipeline.ts:22-29`):**

```
  function assertWiring(wiring) {
    if (wiring.embedder.dimension !== wiring.store.dimension)   ← compare the two seams
      throw new Error("dimension mismatch: embedder ... but store is ...")  ← refuse to build
  }
       │
       └─ called at createRetrievalPipeline AND at the top of index/query.
          Without it, a 768-dim corpus queried by a 1536-dim provider
          returns confident, meaningless rankings — no error, just wrong
          answers. This is the load-bearing safety latch of the seam.
```

**Code side by side — retrieval wrapped as a tool (`search-knowledge-base-tool.ts:78-96`):**

```
  const handler = async (args) => {
    const query = typeof args.query === 'string' ? args.query : '';   ← defend against junk args
    const topK = Math.max(requestedTopK, minTopK);                    ← floor stops top_k:1 starvation
    let hits = await pipeline.query(query, fetchK);                   ← THE query path call
    if (filter) hits = hits.filter(matchesFilter).slice(0, topK);     ← permissive post-filter
    return { query, results: hits.map(toResult) };                    ← each hit → {id,score,citation,meta}
  }
       │
       └─ the handler is the bridge: pipeline.query (vendor-neutral retrieval)
          becomes a ToolHandler that runAgentLoop already knows how to call.
          No new loop, no new boundary — the existing tool seam carries RAG.
```

**Code side by side — capability composition (`rag-query-agent.ts:62-80`):**

```
  async answer(question) {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);  ← least privilege: 1 tool
    const { finalText } = await runAgentLoop({                               ← SAME loop as every agent
      model: this.options.model, tools: this.options.tools,
      system: this.system,        ← profile already injected in the constructor
      maxTurns: 6, maxToolCalls: 4,
      synthesisInstruction: buildSynthesisInstruction("...cite the sources..."),
    });
    return finalText.trim() || FALLBACK_ANSWER;                             ← graceful degradation
  }
```

---

## Elaborate

RAG was the canonical answer to "the model doesn't know your private data and you can't afford to fine-tune": retrieve the relevant slice at query time and stuff it into the context window. The interesting design question is never *whether* to do RAG — it's *where the swap points are*, because every part of a RAG stack rotates. Embedding models change (OpenAI → nomic → bge). Vector stores change (Pinecone → pgvector → Qdrant → in-memory). Chunkers change (fixed-size → recursive → semantic). AptKit's bet is that the **two contracts are the stable part** and everything concrete is a drop-in — the same bet the rest of the repo makes with `ModelProvider`. The `InMemoryVectorStore` doc comment names `PgVectorStore` as the explicit next drop-in (`in-memory-vector-store.ts:6-9`); when it lands, the pipeline, the tool, and the agent don't change.

Read next: `01-provider-abstraction.md` (the same seam pattern for reasoning), `04-capability-as-tool-policy.md` (the tool/policy boundary this rides on), `02-bounded-agent-loop.md` (the loop that drives the tool call). For the *retrieval quality* side — chunking strategy, embedding choice, eval — see `.aipe/study-ai-engineering/` and `.aipe/study-agent-architecture/` (agentic retrieval as a reasoning concern).

---

## Interview defense

**Q: Your RAG pipeline talks to nomic embeddings and an in-memory store. How hard is it to move to OpenAI embeddings + pgvector in production?**

The pipeline never names either vendor — it operates over two contracts, `EmbeddingProvider` and `VectorStore`. Moving to production is writing two new adapter classes that implement those interfaces and changing the wiring at one call site; the pipeline logic, the `search_knowledge_base` tool, and the rag-query agent don't change.

```
  swap surface = the two adapters, nothing above them

  unchanged:  agent ─► tool ─► pipeline ─► [EmbeddingProvider][VectorStore]
  changed:                                  OpenAIEmbedding    PgVectorStore
```

The one thing you *can't* skip: the new embedding provider has a different dimension (1536 vs 768), so you must re-index the corpus. The pipeline's `assertWiring` check forces that — it refuses to build a pipeline where embedder and store dimensions disagree. **Anchor: the dimension one-way door is the safety latch — a mismatched swap fails loud at wiring time instead of silently corrupting every ranking.**

**Q: How does retrieval reach the LLM without the agent loop knowing anything about RAG?**

Retrieval is wrapped as a tool — `createSearchKnowledgeBaseTool` returns a `{ definition, handler }` pair in the exact shape `runAgentLoop` already calls. The agent sees a tool named `search_knowledge_base`; the handler runs the query path under the hood.

```
  the agent's view              the reality behind the tool seam
  ────────────────              ─────────────────────────────────
  "I have a tool   ──tool seam──► query → embed → search → rank
   search_kb"                     (a whole RAG pipeline)
```

The agent loop gains a capability without gaining a concept. **Anchor: RAG adds two new seams but reuses the tool seam to plug in — no new control flow in the loop.**

---

## Validate

1. **Reconstruct.** From memory, draw the two paths (index, query) and name the two pluggable holes. Where is the dimension checked, and why twice? (`pipeline.ts:22-29`, `in-memory-vector-store.ts:36-42`)
2. **Explain.** Why does `indexDocument` copy the chunk text into `meta` (`pipeline.ts:44`)? What breaks in the *citation* if it doesn't?
3. **Apply.** You swap `OllamaEmbeddingProvider` (768) for an OpenAI provider (1536) but forget to re-index. Walk what happens: at `createRetrievalPipeline`, at `upsert`, at `search`. Which throws first? (`pipeline.ts:22-29`)
4. **Defend.** The capstone sets `minTopK: 4` (`ask.ts:48`). Argue why a *floor* on top_k is a system-design decision and not just a tuning knob — what failure does it contain, and at which layer?

---

## See also

- `01-provider-abstraction.md` — the `ModelProvider` seam this pattern mirrors twice.
- `04-capability-as-tool-policy.md` — the tool/registry/policy boundary retrieval plugs into.
- `02-bounded-agent-loop.md` — the loop that drives the `search_knowledge_base` call.
- `08-monorepo-bundle-boundary.md` — `@aptkit/retrieval` and `@aptkit/agent-rag-query` are two of the 16 bundled packages.
- `10-memory-store-topology.md` — `@aptkit/memory` is the *second consumer* of these two seams; read it for the proof the boundary generalizes.
- `audit.md` lenses 1, 2 — where retrieval shows up in the boundary and flow inventory.
- `.aipe/study-ai-engineering/` · `.aipe/study-agent-architecture/` — retrieval *quality* and agentic-retrieval reasoning (this guide owns the architectural seam only).
