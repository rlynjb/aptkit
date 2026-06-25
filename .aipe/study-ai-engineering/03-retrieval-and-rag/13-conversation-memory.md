# Conversation memory — RAG over the agent's own past

**Industry names:** episodic memory, retrieval-based long-term memory,
conversation memory, "memory" (LangChain `VectorStoreRetrieverMemory`) ·
*Industry standard*

## Zoom out, then zoom in

Everything else in this section retrieves over **documents** — a prose corpus
someone indexed ahead of time. `@aptkit/memory` does the exact same thing —
embed → store → similarity-search — but over a different corpus: **past
conversation exchanges**. Same machine, different fuel. That's the whole idea,
and it's why this file lives in the retrieval section and not the agent section:
recall is a vector search, full stop. What changes is *what you stored* (a Q/A
turn instead of a doc chunk) and *one metadata tag* that lets memory and
documents share a store without bleeding into each other.

```
  Zoom out — where conversation memory sits (it reuses the RAG seams)

  ┌─ Memory layer (packages/memory) ★ THIS FILE ─────────────────────┐
  │  createConversationMemory({ embedder, store, format?, kind? })    │
  │    remember(turn) → embed a Q/A exchange → upsert tagged 'memory' │ ← we are here
  │    recall(query)  → embed query → search → filter kind → top-k    │
  └───────────────┬───────────────────────────────┬──────────────────┘
                  │ EmbeddingProvider              │ VectorStore
  ┌─ Retrieval contracts (packages/retrieval) ─────▼──────────────────┐
  │  the SAME two contracts the document RAG pipeline rides on        │
  │  EmbeddingProvider.embed()      VectorStore.upsert()/.search()    │
  └───────────────┬───────────────────────────────┬──────────────────┘
                  │                                │
  ┌─ Adapters ────▼────────────────────────────────▼──────────────────┐
  │  OllamaEmbeddingProvider (nomic, 768)   InMemoryVectorStore (cosine)│
  │  (PgVectorStore is the buffr drop-in behind the same VectorStore)  │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: **conversation memory = RAG where the corpus is the conversation
history.** `remember(turn)` takes one user-asked / assistant-answered exchange,
renders it to a line of text, embeds it, and stores it. `recall(query, k)`
embeds a new query and returns the past exchanges most similar to it. The
question this file answers: how do you give an agent durable memory of *its own*
past without inventing any new infrastructure? Answer — you don't invent any.
You point the document-RAG machinery at a second kind of row.

## Structure pass

**Layers.** Two thin ones over the retrieval contracts. The *memory* layer
(`createConversationMemory` — the remember/recall logic) and the *adapter* layer
it borrows wholesale from `@aptkit/retrieval` (the embedder, the store). The
memory layer adds no storage of its own; it is pure logic over the injected
store.

**Axis — what's stored, and how is it distinguished?** Trace one question across
the document path and the memory path: *what does a row in the store mean?* In
document RAG a row is a chunk of a source doc (`meta: { text, docId }`). In
memory a row is a rendered exchange (`meta: { kind: 'memory', conversationId,
text }`). Same `VectorChunk` shape, same store — the *only* structural
difference is the `kind` tag. That tag is the entire mechanism for keeping two
corpora in one store.

```
  One question — "what is a row in this store?"

  ┌─ document RAG row ─┐  → a doc chunk;  meta.text = chunk, meta.docId = source
  └────────────────────┘
  ┌─ memory row ───────┐  → an exchange;  meta.text = "Past exchange…",
  └────────────────────┘                  meta.kind = 'memory', meta.conversationId
  same VectorChunk shape, same store — the kind tag is the only thing that differs
```

**Seam.** The load-bearing seam is the **injected `store`**. `remember` and
`recall` never name a database — they speak only `VectorStore.upsert` and
`.search`. That seam flips on the *isolation* axis depending on what you pass:
hand it the **same** store the documents use and memory mixes into the corpus
(it surfaces through the document search tool); hand it a **dedicated** store and
memory is isolated (reached only through `search_memory`). One line of wiring
decides which, and the memory module is identical either way
(`conversation-memory.ts:18-31`).

## How it works

You already know document RAG from this section: chunk → embed → upsert; query →
embed → search → rank. Conversation memory is that pipeline with two
substitutions — the "document" is a Q/A turn, and a `kind` tag rides along so you
can tell memory rows apart from doc rows after the fact. Nothing else is new.

### Move 1 — the mental model

The shape is a write path and a read path over one store, where the write path
*tags* what it writes and the read path *filters* on that tag.

```
  Conversation memory — write tags, read filters (same store as docs)

  remember(turn):                         recall(query, k):
    text = format(turn)                     qv = embed(query)
    v    = embed(text)                      hits = store.search(qv, fetchK)
    store.upsert({                          return hits
      id: "memory:<conv>:<n>",                 .filter(kind == 'memory')   ◄ the tag
      vector: v,                               .slice(0, k)
      meta: { kind:'memory', text }
    })            └─ the tag ─┘
                  ▲                                     ▲
                  └──────────── same store ────────────┘
```

The brain to hold: **memory is documents you wrote at runtime instead of indexed
ahead of time.** A doc chunk is embedded once at index time; a memory row is
embedded the moment an exchange happens. Both end up as rows you cosine-search.
Recall is *semantic search over past turns* — "which things I said before are
relevant to what's being asked now?"

### Move 2 — the moving parts

**The format() — turning an exchange into embeddable text.** Bridge from
`JSON.stringify` before you POST a body: an embedder eats a *string*, not a
`{question, answer}` object, so you need a function that renders the turn to one
line of text. That rendered line is what gets embedded *and* what gets returned
on recall (it's stored verbatim in `meta.text`). The default renders both sides
of the exchange so the embedding captures the question *and* the answer:
`Past exchange — user asked: "…" assistant answered: "…"`. Boundary condition:
this string is the *only* thing the similarity search sees — drop the answer from
the format and you can only recall by question wording; keep both and a recall
query can match on either side. The format is injectable (`format?` option) for
exactly this reason.

```
  format() — the exchange becomes one embeddable/recallable line

  turn = { conversationId:'c1', question:'what editor do I use', answer:'neovim' }
        │
        ▼  defaultFormat (conversation-memory.ts:44-46)
  "Past exchange — user asked: \"what editor do I use\"
   assistant answered: \"neovim\""
        │
        ├─► embed(this) → the vector that gets stored        (what recall matches on)
        └─► meta.text = this → returned verbatim on recall   (what the agent reads)
```

**remember() — embed, tag, upsert.** Bridge from an append-only log write. It
formats the turn, embeds the line, then upserts one row whose id is
`memory:<conversationId>:<n>` and whose `meta` carries `kind:'memory'`, the
`conversationId`, and the verbatim text. The `<n>` comes from a per-conversation
counter held in a `Map`, so repeated turns in the same conversation get distinct
ids instead of overwriting each other. Boundary condition: if the embedder
returns nothing for the line (empty batch), `remember` returns without writing —
it never stores a row with no vector to search on.

```
  remember() — one exchange becomes one tagged row

  format(turn) ─► "Past exchange — …"
        │ embed
        ▼
  vector
        │ id = "memory:" + conversationId + ":" + n     ← n from per-conv counter
        ▼                                                  (Map, so ids don't collide)
  store.upsert([{ id, vector, meta:{ kind:'memory', conversationId, text } }])
        └─ the kind tag is what makes this row findable as MEMORY later
```

**recall() — over-fetch, filter, slice.** Bridge from a `WHERE kind = 'memory'`
you can't write. The `VectorStore` contract is two methods — `upsert` and
`search` — and **search has no metadata filter**. So when memory shares a store
with documents, a raw `search` can return doc rows ranked above the memory rows
you want. recall works around this: it asks for **more** than `k`
(`fetchK = max(k*4, 20)`), then filters the hits down to `kind === 'memory'` in
application code, then slices to `k`. Boundary condition — this over-fetch is a
*heuristic*, not a guarantee: if a shared store is dominated by documents, the
top `fetchK` could in principle be all doc rows and starve recall. The fix when
that bites is a dedicated store (no doc rows to compete) — which is exactly why
the store is injected.

```
  recall() — the missing metadata filter, done in app code

  embed(query) ─► qv
        │
        ▼  over-fetch: fetchK = max(k*4, 20)   ← grab extra, docs may rank above
  store.search(qv, fetchK) ─► [ doc?, mem, doc?, mem, mem, … ]
        │ .filter(h => h.meta.kind === 'memory')   ◄ the filter that search can't do
        ▼
  [ mem, mem, mem … ]
        │ .slice(0, k)
        ▼
  top-k memory hits  → { id, score, text, conversationId }
```

**The dimension guard — the one-way door, again.** Bridge from the same throw in
`02-embedding-model-choice.md`: the constructor checks `embedder.dimension ===
store.dimension` and throws loudly if they disagree. A memory store embedded at
768 (nomic) can't be searched by a 4-dim query — the cosine math is undefined
across dimensions. Boundary condition: this fires at *construction*, before any
turn is remembered, so you find the mismatch wiring the agent up, not three
recalls into production with silently garbage scores.

### Move 2.5 — current state vs future state

Memory is **shipped and unit-tested in aptkit**, but the *durable* store and the
*memory-using runtime* live in **buffr**. Hold the split clearly:

```
  Phase A — what aptkit ships          Phase B — what buffr adds
  ─────────────────────────────        ──────────────────────────────────
  createConversationMemory (logic)     PgVectorStore (durable memory rows)
  createMemoryTool (search_memory)     a runtime that calls remember() per turn
  InMemoryVectorStore (tests)          memory wired into a real agent loop
  ▲ tested w/ a fake embedder          ▲ memory that survives a restart
    (conversation-memory.test.ts)
```

What *doesn't* change crossing that line: not one character of
`conversation-memory.ts`. The store is injected, so buffr swaps
`InMemoryVectorStore` for `PgVectorStore` behind the same `VectorStore` contract
and the remember/recall logic is byte-identical. That's the payoff of the
injected seam — aptkit proves the logic with an in-memory store; buffr makes it
durable without touching it.

### Move 3 — the principle

Long-term memory isn't a new subsystem — it's **RAG pointed at a second corpus**.
Once you have embed-store-search, "remember" is just "index a row at runtime" and
"recall" is just "search and keep the rows of this kind." The discipline is the
`kind` tag: it's what lets one store hold two corpora without a metadata-filtered
query, and it's the difference between memory that surfaces alongside documents
and memory that's isolated behind its own tool. Build the retrieval primitive
once; you get document RAG and episodic memory from the same parts.

## Primary diagram

The whole memory machine: both paths over one injected store, the tag written on
the way in and filtered on the way out, and the shared-vs-dedicated fork.

```
  Conversation memory — full picture (RAG over history)

  ┌─ remember(turn) ──────────────────────────────────────────────────┐
  │  format(turn) ─► embed ─► upsert{ id:"memory:<conv>:<n>",          │
  │                                   meta:{ kind:'memory', text } }   │
  └───────────────────────────────┬───────────────────────────────────┘
                                   ▼
  ┌─ VectorStore (INJECTED) ───────────────────────────────────────────┐
  │  SHARED with docs ──► memory rows + doc rows mixed (search_knowledge │
  │                       _base surfaces both)                          │
  │  DEDICATED       ──► memory rows only (search_memory tool)          │
  └───────────────────────────────┬───────────────────────────────────┘
                                   ▼
  ┌─ recall(query, k) ─────────────────────────────────────────────────┐
  │  embed(query) ─► search(fetchK=max(k*4,20)) ─► filter kind=='memory' │
  │                                              ─► slice(k)             │
  └─────────────────────────────────────────────────────────────────────┘
       dimension guard at construction: embedder.dim must == store.dim
```

## Implementation in codebase

**Use cases.** aptkit ships the memory *engine*, not yet a runtime that calls it
on every turn — that's buffr's job. So the live use case in-repo is the unit
tests, which double as the executable spec: remember two exchanges, recall one
from a *paraphrased* query (proving it's semantic, not keyword), and prove a
foreign doc chunk sharing the store is filtered out of recall
(`conversation-memory.test.ts:26-49`). The two shapes the design anticipates:
**shared store** — memory rows mixed into the document corpus, recalled passively
through the existing `search_knowledge_base` tool with no second tool; and
**dedicated store** — memory isolated, reached explicitly through the
`search_memory` tool from `createMemoryTool`.

**remember / recall — the engine**,
`packages/memory/src/conversation-memory.ts:60-108`:

```
  packages/memory/src/conversation-memory.ts  (lines 62-107)

  if (embedder.dimension !== store.dimension)              ← lines 62-66
    throw new Error(`embedder dimension … != store dimension …`);
       │  ← the one-way door, checked at construction, before any turn

  async remember(turn) {                                   ← lines 74-87
    const text = format(turn);                        ← exchange → embeddable line
    const [vector] = await embedder.embed([text]);
    if (!vector) return;                              ← never store an un-searchable row
    const n = counters.get(turn.conversationId) ?? 0; ← per-conv counter…
    counters.set(turn.conversationId, n + 1);         ← …so ids don't collide
    await store.upsert([{
      id: `${kind}:${turn.conversationId}:${n}`,      ← "memory:c1:0"
      vector,
      meta: { kind, conversationId: turn.conversationId, text },  ← the kind TAG
    }]);
  }

  async recall(query, k = 5) {                             ← lines 89-106
    const [vector] = await embedder.embed([query]);
    const fetchK = Math.max(k * 4, 20);               ← over-fetch: docs may rank above
    const hits = await store.search(vector, fetchK);
    return hits
      .filter(h => h.meta?.kind === kind)             ← the metadata filter search lacks
      .slice(0, k)                                    ← then trim to what was asked
      .map(h => ({ id, score, text, conversationId }));
  }
       │
       └─ no database is named anywhere. `store` is whatever you injected —
          InMemoryVectorStore in tests, PgVectorStore in buffr. Identical logic.
```

**defaultFormat — the exchange renderer**,
`packages/memory/src/conversation-memory.ts:44-46`:

```
  packages/memory/src/conversation-memory.ts  (lines 44-46)

  function defaultFormat(turn) {
    return `Past exchange — user asked: "${turn.question}"\n` +
           `assistant answered: "${turn.answer}"`;
  }
       │
       └─ both sides of the exchange go into the embedded text, so a recall query
          can match on the question OR the answer. Override via the `format?`
          option (a test uses `${q} => ${a}` to prove it's pluggable —
          conversation-memory.test.ts:56-68).
```

**The dedicated-store tool**, `packages/memory/src/memory-tool.ts:28-60`:

```
  packages/memory/src/memory-tool.ts  (lines 34-57)

  const definition = {
    name: 'search_memory',
    description: 'Search past conversation exchanges … Use when the answer may
                  depend on something discussed earlier.',        ← see note below
    inputSchema: { query: string (required), top_k: number },
  };
  const handler = async (args) => {
    const hits = await memory.recall(String(args.query), topK);   ← just calls recall
    return { query, memories: hits.map(h => ({ id, score, text })) };
  };
       │
       └─ mirrors createSearchKnowledgeBaseTool exactly: returns { definition,
          handler } to register into an InMemoryToolRegistry and gate with a tool
          policy. Use it ONLY when memory has its own store; when memory shares the
          document store, search_knowledge_base already surfaces it — no second tool.
```

> **Partition note.** *Whether the agent decides to call `search_memory`* (the
> control-flow question — recall as a step the loop steers) is the agent-
> architecture lens, not this file. *The exact wording* of that tool's
> `description` — how you phrase "use when the answer depends on something
> discussed earlier" so the model reaches for it — is the prompt-engineering
> lens. This file owns the *retrieval mechanism*: embed → store → similarity-
> search over past turns.

## Elaborate

The short-term / long-term split is the classic memory taxonomy
([../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md)):
short-term is the in-context `messages` array (automatic, GC'd at run end);
long-term is a *separate retrieval system* you build on purpose. `@aptkit/memory`
**is** that long-term system — and the lesson here is how little it took to build
once `@aptkit/retrieval` existed: ~100 lines, no new storage, no new contracts.
The framework world calls this `VectorStoreRetrieverMemory` (LangChain) or just
"memory"; the insight they all share is the one this file leads with — episodic
memory is RAG with the conversation as the corpus.

The honest scope: aptkit ships the engine and the tool, both unit-tested with a
fake embedder over `InMemoryVectorStore`. The *durable* memory store
(`PgVectorStore`) and the *runtime that calls `remember` after each turn* live in
buffr — so an aptkit agent doesn't yet automatically remember across runs; the
machinery to make it do so is now in the repo and proven, waiting to be wired.
That's the same aptkit-is-library / buffr-is-the-body split that runs through the
whole RAG section.

Adjacent concepts: the document-RAG version of this exact pipeline
([11-rag.md](11-rag.md)); the embedder + store contracts it rides on
([01-embeddings.md](01-embeddings.md), [04-vector-databases.md](04-vector-databases.md));
the dimension one-way door ([02-embedding-model-choice.md](02-embedding-model-choice.md));
and the short-term side of memory it completes
([../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md)).

## Project exercises

*Provenance: Phase 4 — long-term memory (C4.x), depends on Phase 2A/2B retrieval.
No `aieng-curriculum.md` present; IDs are by-phase convention. **Case A — memory
is implemented; these exercises wire it into a runtime and measure it.***

### Exercise — wire remember() into an agent run, then recall on the next

- **Exercise ID:** `[A4.9]` Phase 4, conversation-memory concept
- **What to build:** After an agent produces an answer, call `remember({
  conversationId, question, answer })`; on the next run for the same conversation,
  call `recall(question)` and inject the top hits into the prompt as "earlier you
  said:". Use a `DEDICATED` `InMemoryVectorStore` so memory doesn't mix with docs.
- **Why it earns its place:** It closes the gap between "the engine exists" and
  "the agent actually remembers" — the write-back-and-recall loop that
  `05-agent-memory.md` named as the missing piece is exactly this wiring.
- **Files to touch:** a test under `packages/memory/test/` (or a thin runtime
  wrapper) that runs two turns and asserts turn 2 recalls turn 1; `createMemoryTool`
  if you expose recall as a tool instead of a pre-injection.
- **Done when:** Turn 2 surfaces a fact stated only in turn 1, proven by a test
  that fails if the recall step is removed.
- **Estimated effort:** `1–4hr`

### Exercise — shared vs dedicated store, measured

- **Exercise ID:** `[A4.10]` Phase 4, shared-store tradeoff concept
- **What to build:** Put memory rows and document chunks in **one** store, then
  recall a memory while the store also holds many doc chunks. Vary `fetchK` and
  measure how often the memory you want survives the over-fetch-then-filter. Then
  repeat with a dedicated store and show the recall is unconditional.
- **Why it earns its place:** It makes the over-fetch heuristic concrete — you
  see the exact failure (docs starve the top `fetchK`) the dedicated store fixes,
  which is the real reason the store is injected.
- **Files to touch:** a test under `packages/memory/test/` that seeds N doc rows +
  M memory rows in a shared store and asserts recall hit-rate vs a dedicated store.
- **Done when:** The test shows recall hit-rate dropping as doc count climbs in
  the shared store, and staying at 100% in the dedicated store.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How does your agent remember things across conversations?**

```
  remember(turn) ─► embed Q/A ─► upsert tagged 'memory'
  recall(query)  ─► embed query ─► search ─► filter kind=='memory' ─► top-k

  it's RAG. the corpus is the conversation history.
```

"It's RAG pointed at a second corpus. `remember` formats a Q/A exchange into one
line, embeds it, and upserts a row tagged `kind:'memory'`. `recall` embeds a new
query, searches the same vector store, and keeps only the memory-tagged rows. The
whole thing reuses the document-RAG contracts — `EmbeddingProvider` and
`VectorStore` — so it's about a hundred lines with no new storage. The load-
bearing detail people miss: the store has no metadata filter, so recall *over-
fetches* (`max(k*4, 20)`) and filters to `kind:'memory'` in app code — that's how
memory and documents can share one store."
*Anchor: episodic memory is RAG with the conversation as the corpus; the `kind`
tag is what lets one store hold two corpora.*

**Q: Memory and your document knowledge base — same store or different?**

```
  SHARED store ──► memory surfaces via search_knowledge_base (no new tool)
                   risk: docs can rank above memory in the over-fetch
  DEDICATED store ► search_memory tool; memory isolated, recall unconditional
                   the module is IDENTICAL either way — store is injected
```

"Your call, and the module doesn't care — the store is injected. Share it and
memory mixes into the corpus and surfaces through the existing
`search_knowledge_base` tool; dedicate it and you reach memory through a separate
`search_memory` tool and recall never competes with doc rows. The tradeoff is
isolation vs. one-tool simplicity. I'd dedicate a store once the doc corpus is big
enough that the over-fetch-then-filter starts starving recall."
*Anchor: shared = passive surfacing + contention risk; dedicated = isolation + a
second tool. One injected line decides; the engine is byte-identical.*

## Validate

- **Reconstruct:** From memory, write the two paths — `remember` (format → embed →
  upsert tagged) and `recall` (embed → search over-fetch → filter kind → slice).
  Check against `conversation-memory.ts:74-106`.
- **Explain:** Why does `recall` fetch `max(k*4, 20)` instead of just `k`? (Because
  `VectorStore.search` has no metadata filter; in a shared store doc rows can rank
  above memory rows, so it over-fetches then filters to `kind:'memory'` in app code
  — `conversation-memory.ts:94-98`.)
- **Apply:** You put memory in the same store as 50k doc chunks and recall starts
  missing. What changed and what's the fix? (The top `fetchK` filled with doc rows
  and starved the filter; switch memory to a dedicated store — the injected `store`
  seam makes that a one-line wiring change.)
- **Defend:** Why is this file in the retrieval section and not the agent section?
  (Because recall is a vector search — embed → store → similarity-search — the same
  mechanism as document RAG. Whether the *agent* chooses to recall is the agent-
  architecture lens; the search itself is retrieval.)

## See also

- [11-rag.md](11-rag.md) — the document-corpus version of this exact pipeline
- [01-embeddings.md](01-embeddings.md) — text → vector, the step both paths share
- [04-vector-databases.md](04-vector-databases.md) — the `VectorStore` contract memory rides on
- [02-embedding-model-choice.md](02-embedding-model-choice.md) — the dimension one-way door memory re-checks
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — short-term vs long-term; this file is the long-term half made real
- `.aipe/study-agent-architecture/` — whether/when the agent *decides* to recall (the control lens)
- the **buffr** repo — the durable memory store + the runtime that calls `remember` per turn
