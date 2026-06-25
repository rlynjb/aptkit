# Memory store topology — episodic memory as a second retrieval consumer, shared or dedicated

**Industry name(s):** long-term agent memory · episodic memory · RAG-over-conversation-history · retrieval-based memory. **Type:** Industry standard pattern, project-specific wiring (the shared-vs-dedicated choice).

---

## Zoom out, then zoom in

Every agent in the rest of this guide is stateless — request in, model call, trace out, forget everything (`audit.md` lens 3). `@aptkit/memory` is the first package that gives an agent a *past*: it remembers what was said in earlier turns (and earlier *sessions*) and recalls the relevant bits later. But here's the thing worth studying before any mechanism: it adds **zero new infrastructure**. No database client, no new contract, no new control flow. It's the *second consumer* of the two retrieval seams `@aptkit/retrieval` already defined — `EmbeddingProvider` and `VectorStore` (`09-retrieval-pipeline-seam.md`).

```
  Zoom out — where memory sits, and what it reuses

  ┌─ Capability layer — packages/agents/* ────────────────────────────────┐
  │  rag-query   query   recommendation   anomaly   diagnostic   rubric    │
  └───────────────────────────────┬────────────────────────────────────────┘
                                   │  a tool, OR the existing search tool
  ┌─ Memory — packages/memory ─────▼──────────────────────────────────────┐
  │  ★ createConversationMemory({embedder, store}) ★  → {remember, recall} │ ← we are here
  │     createMemoryTool(memory)  → a `search_memory` tool                  │
  └───────────────┬───────────────────────────────┬───────────────────────┘
                  │ reuses EmbeddingProvider seam  │ reuses VectorStore seam
  ┌─ Retrieval — packages/retrieval ────────────────▼──────────────────────┐
  │  EmbeddingProvider (text→vectors)   VectorStore (upsert / search)       │
  │  same two contracts the RAG pipeline already speaks — no new infra      │
  └─────────────────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is *retrieval-based memory*: instead of stuffing the whole conversation history into the prompt (which blows the context window), you **embed each exchange as it happens, store the vector, and recall the few most-relevant past exchanges by similarity** when you need them. It's RAG with the corpus being "things this user said before" instead of "documents." The interesting system-design decision isn't the embedding — it's **where those memory vectors live**: in the *same* store as your documents, or a *dedicated* one. That single choice — made by the caller, not the module — changes which tool surfaces memory and whether memory pollutes document search. That topology decision is what this file is about.

---

## The structure pass

Three layers, one axis, one caller-owned decision that flips everything below it.

**Layers (outer → inner):**

```
  the caller (e.g. buffr session.ts)  → picks the store: shared or dedicated
    createConversationMemory           → engine: remember / recall (vendor-blind)
      VectorStore (injected)           → where memory rows physically live
        InMemoryVectorStore | PgVectorStore   → the concrete store (caller's choice)
```

**The axis to hold constant: "is memory isolated from documents?"** Trace it down and watch the *topology* decide the answer — not the engine.

```
  axis = "does memory share a store with documents?"

                      SHARED topology          DEDICATED topology
                      ───────────────          ──────────────────
  store passed     same store as docs       a second, memory-only store
  recall surfaces  via search_knowledge_base  via the search_memory tool
  pollution risk   memory rows rank against   none — corpora are separate
                   document rows
  extra tool       NO (reuses doc tool)       YES (createMemoryTool)
  who decides      the CALLER, at wiring time — the module never knows
```

**The two load-bearing seams here are reused, not new** (`packages/memory/src/conversation-memory.ts:1`). Memory imports `EmbeddingProvider`, `VectorStore`, `VectorHit` straight from `@aptkit/retrieval` and speaks nothing else. The seam that *is* new is a softer one: the **`kind` tag** (`conversation-memory.ts:84`). Because the `VectorStore` contract has no metadata filter, memory tags every row `kind: 'memory'` and `recall` over-fetches then filters — that tag is the only thing keeping memory rows distinguishable from documents in a shared store.

A seam is load-bearing when an axis flips across it. The isolation axis flips at the **store-injection boundary** — the `store` argument the caller passes. Above it, the engine is identical in both topologies; below it, "is memory isolated?" gets two different answers. That's why the topology is a *caller* decision and the module stays dumb about it (`conversation-memory.ts:20-26`, the doc comment makes this explicit: "The caller decides; this module does not care which").

---

## How it works

### Move 1 — the mental model

You already know RAG: embed a query, search a vector store, get back the top-k most similar chunks (`09-retrieval-pipeline-seam.md`). Memory is *the same loop pointed at a different corpus*. The corpus isn't documents — it's past conversation turns, each one embedded the moment it happens. `remember` is the index path; `recall` is the query path. The only genuinely new wrinkle is that memory and documents might live in the *same* store, so `recall` has to filter out anything that isn't a memory row.

```
  Memory = RAG with a self-growing corpus

         WRITE path (remember) — runs after every turn
  {question, answer} ─► format ─► embed ─► upsert(kind=memory)
                                              │
                                              ▼  (corpus grows by 1 each turn)
                                       [ VectorStore ]
                                              ▲
         READ path (recall) — runs when you need the past
  query ──────────────► embed ─► search(k×4) ─► filter kind==memory ─► top k
```

The corpus *grows during use* — that's the difference from document RAG, where the corpus is built offline and read-only. Every answered turn adds one row.

### Move 2 — the walkthrough

**`remember`: format → embed → upsert, tagged.** Start where memory grows (`conversation-memory.ts:74-87`). You hand `remember` a `{ conversationId, question, answer }`. It renders the exchange to one string via a `format` function (default: `Past exchange — user asked: "..." assistant answered: "..."`), embeds that single string, and upserts one row. Two details carry weight: the row's **`meta.kind = 'memory'`** tag (what `recall` filters on later) and the **id scheme** `${kind}:${conversationId}:${n}`, where `n` comes from a per-conversation counter so repeated turns in one conversation get distinct ids without collisions.

```
  Layers-and-hops — remembering one exchange

  ┌─ caller ────────┐ hop 1: remember({convId,q,a})  ┌─ memory engine ────┐
  │ session.ask()   │ ──────────────────────────────►│ format + counter   │
  └─────────────────┘                                └─────────┬──────────┘
                         hop 2: embed([text])                  │
                               ◄── number[768] ──── ┌─ EmbeddingProvider ─┐
                                                    │ Ollama → nomic      │ HTTP
                                                    └─────────────────────┘
                         hop 3: upsert([{id,vector,  ┌─ VectorStore ───────┐
                                 meta:{kind:'memory'}}])│ shared OR dedicated│
                               ───────────────────────►└─────────────────────┘
```

**`recall`: over-fetch then filter — the shared-store survival trick.** This is the part that bites if you don't see why it's there (`conversation-memory.ts:89-106`). `recall` embeds the query, searches, and keeps only `kind === 'memory'` rows. But it doesn't ask for `k` rows — it asks for `Math.max(k * 4, 20)`. Why over-fetch? Because in a **shared store**, the search returns documents *and* memory rows interleaved by score; a document might out-rank every memory row in the top-k. If you searched for exactly `k` and filtered after, a memory-relevant query could come back empty just because documents crowded the top. Over-fetching by 4× gives the filter enough raw hits to still find `k` memory rows underneath the documents. **The `VectorStore` contract has no `where`/metadata filter** — that's the constraint this whole dance works around.

```
  Why over-fetch — the shared-store filter, made concrete

  query "which editor do I prefer" in a SHARED store, k=3:

  search(vec, 3)              search(vec, 12)  ← over-fetched
  ┌──────────────┐            ┌──────────────┐
  │ doc  0.91    │            │ doc  0.91    │ ✗ filtered
  │ doc  0.88    │            │ doc  0.88    │ ✗ filtered
  │ doc  0.85    │            │ doc  0.85    │ ✗ filtered
  └──────────────┘            │ mem  0.82    │ ✓ keep
   filter → [] EMPTY          │ mem  0.79    │ ✓ keep
   (documents ate the top-k)  │ mem  0.77    │ ✓ keep → top 3
                              └──────────────┘
                               filter → 3 memories ✓
```

**The dimension latch — same safety as the RAG pipeline.** `createConversationMemory` asserts `embedder.dimension === store.dimension` at construction and throws if they disagree (`conversation-memory.ts:62-65`). This is the *same* one-way door the retrieval pipeline uses (`09-retrieval-pipeline-seam.md`): a 768-dim memory corpus can only be queried at 768. Reusing the seam means reusing its safety latch for free.

**The two topologies — one caller decision.** Here's the architectural fork. The module exposes the same `{remember, recall}` either way; the caller decides the topology by *which store it passes*:

```
  SHARED topology — memory mixes into the document corpus
  ───────────────────────────────────────────────────────
  const store = new PgVectorStore(...);        ← ONE store
  const pipeline = createRetrievalPipeline({embedder, store});
  const memory   = createConversationMemory({embedder, store});  ← same store
        │
        └─ memory rows surface through search_knowledge_base automatically.
           NO search_memory tool needed. (this is what buffr wires.)

  DEDICATED topology — memory isolated in its own store
  ──────────────────────────────────────────────────────
  const memStore = new PgVectorStore(...);     ← a SECOND store
  const memory   = createConversationMemory({embedder, store: memStore});
  const tool     = createMemoryTool(memory);   ← agent recalls via search_memory
        │
        └─ documents and memory never rank against each other.
           the agent gets an explicit `search_memory` tool. (not yet exercised
           by any consumer — see "current vs future" below.)
```

**`createMemoryTool`: the dedicated-topology bridge.** When memory is isolated, the agent needs a way to reach it. `createMemoryTool(memory)` returns the same `{ definition, handler }` pair shape as `createSearchKnowledgeBaseTool` (`packages/memory/src/memory-tool.ts:28-60`) — a `search_memory` tool the agent loop already knows how to call. In the *shared* topology you skip this entirely: the existing `search_knowledge_base` tool already returns memory rows, so a second tool would be redundant (`memory-tool.ts:24-27` says exactly this).

### Move 2.5 — current state vs future state

Memory is *shipped and wired*, but only one of its two topologies is actually exercised. The shared-store path is live in buffr; the dedicated-store + `search_memory` path is built-but-unused.

```
  Phase A — what's live now            Phase B — built, not yet exercised
  ─────────────────────────           ──────────────────────────────────
  SHARED topology                     DEDICATED topology
  buffr session.ts:53 wires           createMemoryTool exists, tested in
  createConversationMemory with        memory-tool.test.ts, but no consumer
  the SAME PgVectorStore as docs       constructs a second store + registers
        │                              search_memory into an agent policy
        ▼                                    │
  memory surfaces via                        ▼
  search_knowledge_base — no            would isolate memory from documents
  search_memory tool registered         and give the agent explicit recall
        │                                    │
        └─ tradeoff accepted: memory          └─ migration cost: a second store
           rows compete with documents           instance + add search_memory to
           for top-k slots; over-fetch            the rag-query tool policy. The
           mitigates but doesn't eliminate.       ENGINE doesn't change — only the
                                                  wiring above the seam.
```

The takeaway is the usual one for a good seam: *switching topology costs nothing in the engine.* You change the `store` you pass and whether you register a tool. `remember`/`recall` are byte-for-byte identical. (`packages/memory/test/conversation-memory.test.ts:38-49` proves the shared-store filter works; the dedicated path is just "don't share the store.")

### Move 3 — the principle

Memory is the strongest evidence yet that the retrieval contracts were drawn at the right boundary. A whole new capability — episodic, cross-session, durable agent memory — dropped in as a **second consumer of an existing seam with zero new infrastructure contracts.** The first consumer (the RAG pipeline) could have been a one-off; the second consumer is proof the seam *generalizes*. When you can add a capability and the new package's dependency list is just the contracts you already had (`@aptkit/retrieval`, `@aptkit/tools`) plus a tag and a filter, the seam earned its keep. The reverse smell — needing a new database client, a new contract, new control flow for every capability — is the signal your boundaries are in the wrong place.

---

## Primary diagram

The whole memory capability in one frame: a self-growing corpus written after every turn, recalled by similarity, living in a store the caller chooses — shared with documents or dedicated.

```
  AptKit memory — full capability map (state ownership crosses the repo boundary)

  ┌─ Capability — packages/agents/rag-query (driven by a caller) ──────────┐
  │  agent.answer(question)  →  finalText                                   │
  └───────────────────────────────┬───────────────────────────────────────┘
            after each turn        │  remember({convId, question, answer})
        ┌──────────────────────────┘
        ▼
  ┌─ Memory engine — packages/memory ─────────────────────────────────────┐
  │  remember: format → embed → upsert(kind=memory, id=kind:conv:n)        │
  │  recall:   embed → search(k×4) → filter kind==memory → top k           │
  │       │ EmbeddingProvider seam       │ VectorStore seam (INJECTED)     │
  └───────┼──────────────────────────────┼─────────────────────────────────┘
          ▼                              ▼
  ┌─ OllamaEmbedding ──┐   ┌─ VectorStore — caller's choice ───────────────┐
  │ nomic, 768, HTTP   │   │  SHARED: same store as docs  → search_knowledge│
  │                    │   │          _base surfaces memory (buffr wires this)│
  └────────────────────┘   │  DEDICATED: own store → search_memory tool     │
                           │  ── durable instance is PgVectorStore in BUFFR ┤
                           └────────────────────────────────────────────────┘
                                          │  the durable store lives across
                                          ▼  the repo boundary, in buffr
                              ┌─ buffr (separate repo) ───────────────┐
                              │ PgVectorStore over Supabase Postgres  │
                              │ pgvector — memory survives the process│
                              └───────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** The concrete scenario: buffr's Ink `chat` CLI runs a long-lived session (`buffr/src/session.ts`), and you want "what editor did I say I use?" three sessions later to actually work. After each turn, `session.ask()` calls `memory.remember({ conversationId, question, answer })` (`session.ts:66`) best-effort — a memory-write failure is swallowed so it can't lose the answer the user already has (`session.ts:64-69`). buffr wires the **shared topology**: memory goes into the *same* `PgVectorStore` as documents (`session.ts:41,53`), so past exchanges surface through the existing `search_knowledge_base` tool with no `search_memory` registered. That's the whole point — the durable, cross-session memory *capability* is aptkit's engine; buffr supplies only the `PgVectorStore` the state physically lives in.

**Code side by side — the over-fetch-then-filter recall (`packages/memory/src/conversation-memory.ts:89-106`):**

```
  async recall(query, k = 5) {
    const [vector] = await embedder.embed([query]);        ← embed the recall query
    if (!vector) return [];
    const fetchK = Math.max(k * 4, 20);                    ← OVER-FETCH: pull 4× (min 20)
    const hits = await store.search(vector, fetchK);       ← shared store returns docs + memory
    return hits
      .filter((h) => h.meta?.kind === kind)                ← keep ONLY memory rows
      .slice(0, k)                                         ← now take the real top-k
      .map((h) => ({ id, score, text, conversationId }));  ← shape for the caller
  }
       │
       └─ the fetchK=k×4 is load-bearing in a SHARED store: without it, documents
          ranking above every memory row would make recall return [] for a query
          that genuinely has relevant memories. The VectorStore contract has no
          metadata filter, so this app-side over-fetch IS the filter. Remove it
          and shared-store recall silently under-returns.
```

**Code side by side — the tag that survives a shared store (`conversation-memory.ts:80-86`):**

```
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,   ← namespaced id, collision-free per conv
    vector,
    meta: { kind, conversationId, text },         ← kind tag = the only doc/memory discriminator
  }]);
       │
       └─ meta.kind is what recall filters on. In a shared store this tag is the
          ONLY thing distinguishing a memory row from a document chunk. The id
          prefix (kind:conv:n) keeps a human-readable, collision-free namespace
          even when memory and documents share one physical store.
```

**Code side by side — the topology choice, in the caller (`buffr/src/session.ts:41-53`):**

```
  const store = new PgVectorStore({ pool, appId, dimension: embedder.dimension });
  const pipeline = createRetrievalPipeline({ embedder, store });   ← docs use `store`
  const memory   = createConversationMemory({ embedder, store });  ← SAME `store` = SHARED
       │
       └─ one variable passed to both = the shared topology. No search_memory tool
          is registered (session.ts only registers search_knowledge_base, line 43-44).
          To go DEDICATED you'd pass a second store here and register createMemoryTool.
          The aptkit engine doesn't change — the topology lives entirely in this wiring.
```

---

## Elaborate

Long-term agent memory has two schools. One is **summarization/fact-extraction memory**: distill the conversation into facts, store them as structured rows, rehydrate the summary into the prompt. The other is **retrieval-based memory**: embed raw exchanges, recall by similarity. `@aptkit/memory` is squarely the second — and it says so, scoping summarization, consolidation, and decay explicitly *out* (`packages/memory/README.md`). That's a deliberate boundary: the storage+retrieval half is the part that maps cleanly onto seams the repo already has, so it ships now; the management half (which needs its own policies) is layered on later.

The architecturally interesting bit is the *store topology* as a first-class, caller-owned decision. Most memory libraries pick for you — they ship a store and you live with it. By making `store` an injected dependency and staying agnostic about whether it's shared, this module pushes the shared-vs-dedicated tradeoff up to where it belongs: the integrator, who knows whether memory-polluting-document-search is acceptable for their product. buffr chose shared (memory and docs are both "things relevant to this user," ranking them together is fine, and one store is one less thing to operate); a different consumer with a large document corpus and noisy memory might choose dedicated to keep recall precise.

Read next: `09-retrieval-pipeline-seam.md` (the seams memory reuses — read this first if you haven't), `04-capability-as-tool-policy.md` (the tool boundary `search_memory` plugs into), `08-monorepo-bundle-boundary.md` (memory is the 16th bundled package). For *where the durable state physically lives* — `PgVectorStore` over Supabase Postgres — that's buffr's `.aipe/study-database-systems/`; this guide owns the seam, not the storage engine.

---

## Interview defense

**Q: You added conversation memory. How much new infrastructure did it cost?**

None. Memory is the second consumer of the two retrieval contracts the repo already had — `EmbeddingProvider` and `VectorStore`. The whole package depends on `@aptkit/retrieval` and `@aptkit/tools` and nothing else; it adds no database client, no new contract, no new control flow. `remember` is the RAG index path, `recall` is the RAG query path, pointed at a corpus of conversation turns instead of documents.

```
  new capability, reused seams

  RAG pipeline  ─┐
                 ├─► EmbeddingProvider + VectorStore  ← the same two contracts
  memory engine ─┘     (memory is the 2nd consumer = the seam generalizes)
```

**Anchor: the second consumer of a seam with zero new infra is the proof the boundary was right — the first consumer could've been a coincidence.**

**Q: Memory shares a vector store with your documents. How does recall avoid returning documents?**

Two parts. Every memory row is tagged `meta.kind = 'memory'` on write, and `recall` filters to that tag. But filtering alone isn't enough in a shared store, because documents can out-rank memory rows in the top-k — so `recall` over-fetches `k×4` (min 20) raw hits before filtering down to `k` memory rows. The `VectorStore` contract has no metadata filter, so this app-side over-fetch *is* the filter.

```
  shared-store recall = over-fetch, then filter by kind

  search(k×4) → [doc doc doc mem mem mem ...] → filter kind==memory → top k
```

**Anchor: the over-fetch is load-bearing — without it, documents ranking above memory make recall silently return empty for a query that has relevant memories.**

**Q: Shared store vs dedicated store for memory — who decides, and what's the tradeoff?**

The *caller* decides, by which store it injects — the engine is identical either way. Shared (what buffr wires) means memory surfaces through the existing `search_knowledge_base` tool with no extra tool, at the cost of memory rows competing with documents for top-k slots. Dedicated means a second store and a `search_memory` tool — memory and documents never rank against each other, at the cost of operating a second store and wiring a second tool.

```
  topology = a caller decision, not a module decision

  SHARED:    one store, one tool, memory & docs compete   (buffr)
  DEDICATED: two stores, search_memory tool, clean isolation (not yet exercised)
```

**Anchor: the topology lives entirely in the wiring above the seam — switching it doesn't touch remember/recall.**

---

## Validate

1. **Reconstruct.** From memory, draw `remember` and `recall` as the two RAG paths. Where is `kind` written, and where is it read? (`conversation-memory.ts:84`, `:97`)
2. **Explain.** Why does `recall` fetch `k×4` instead of `k`? What specifically breaks in a *shared* store if you fetch exactly `k`? (`conversation-memory.ts:94`)
3. **Apply.** You want memory isolated from documents. Walk the exact wiring change from buffr's `session.ts:53` — which line changes, and what new tool must you register? Does any line inside `@aptkit/memory` change? (`memory-tool.ts:28`)
4. **Defend.** Memory makes an agent stateful across runs — but `runAgentLoop` is still stateless per invocation (`audit.md` lens 3). Where does the cross-run state actually live, and which repo owns its durability? (`session.ts:41`, buffr's `PgVectorStore`)

---

## See also

- `09-retrieval-pipeline-seam.md` — the `EmbeddingProvider`/`VectorStore` seams memory reuses (read first).
- `04-capability-as-tool-policy.md` — the tool/registry/policy boundary `search_memory` plugs into.
- `08-monorepo-bundle-boundary.md` — memory is the 16th bundled package in `@rlynjb/aptkit-core` 0.4.1.
- `01-provider-abstraction.md` — the original seam pattern memory mirrors a third time.
- `audit.md` lenses 1, 3, 5 — boundaries (second retrieval consumer), state-across-runs, durable store ownership.
- buffr `.aipe/study-database-systems/` — where the durable `PgVectorStore` memory rows physically live (this guide owns the seam, not the engine).
