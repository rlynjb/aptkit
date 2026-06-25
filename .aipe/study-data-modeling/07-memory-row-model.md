# Memory row model — episodic turns as `kind`-tagged rows in the shared corpus

**Industry name(s):** episodic / long-term conversation memory; retrieval-augmented memory; vector-memory store. **Type label:** Industry standard (the "store past turns as embeddings, recall by similarity" pattern is what LangChain's `VectorStoreRetrieverMemory`, Mem0, and Letta/MemGPT all implement). The *partition mechanism* — a `kind` tag soft-splitting memory from documents inside ONE collection — is Project-specific.

This is the second store-shaped model in the guide, and it's the more interesting one for a data-modeling lens. File `06` covered the document corpus — chunks with id `"<docId>#<i>"`. `@aptkit/memory` (`packages/memory/src/conversation-memory.ts`) adds a *second kind of row* that lives in the **same `VectorStore`**: a remembered conversation turn. Same store, same `(id, vector, meta)` shape, different id scheme and a discriminator tag. The whole file is about what it means to put two logically distinct entities in one physical collection with no schema to keep them apart.

## Zoom out, then zoom in

Here's where memory sits. Notice it shares the STORE layer with the document corpus from `06` — that sharing is the entire modeling story.

```
  Zoom out — memory rows and document rows in ONE store

  ┌─ Source layer ──────────────────────────────────────────────────┐
  │  RetrievalDocument {id,text,meta?}   MemoryTurn {convId,q,a}     │
  │       (06 — documents)                  (07 — this file)         │
  └───────────────┬───────────────────────────────┬─────────────────┘
       chunk+embed│                    format+embed│
  ┌─ STORE layer (ONE VectorStore) ───▼────────────▼─────────────────┐
  │  Map<id, VectorChunk>  — rows of TWO kinds, no schema to split    │ ← we are here
  │   "guide#0"  meta.kind absent     │  "memory:c1:0" meta.kind=memory│
  │   (document row)                  │  (memory row) ★ THIS ★         │
  └───────────────┬───────────────────────────────┬─────────────────┘
    search(qvec,k)│ returns BOTH kinds intermixed  │
  ┌─ Read layer ──▼───────────────────────────────▼─────────────────┐
  │  recall(): over-fetch → filter meta.kind==='memory' → top-k      │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the model is one row type (`MemoryTurn` in → a `VectorChunk` row → `MemoryHit` out) plus a **logical partition** layered over a physical store that has no partitioning of its own. The question this concept answers: *how do you store two different kinds of thing — documents and conversation memory — in a store with one flat namespace and no metadata index, and still recall only the kind you want?*

Three modeling choices carry it: the **composite id** `memory:<convId>:<n>` (contrast the document `"<docId>#<i>"`), the **`kind` discriminator tag** that soft-partitions the shared store, and the **over-fetch-then-filter recall** forced by the absence of any metadata index. Take them in that order.

## The structure pass

Layers are named in the zoom-out (Source → Store → Read). Trace one axis across them: **where does the partition between memory and documents live — physical or logical?** That axis makes the seams pop, because the answer flips at every boundary.

```
  One axis — "what keeps memory rows separate from document rows?" — traced

  ┌ Source → Store seam ─────────────────────────────────────────────┐
  │  separated by: id PREFIX + meta.kind tag, written at remember()   │ ← LOGICAL
  │  `${kind}:${convId}:${n}`, meta.kind=kind (conversation-memory:80)│   (a label)
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌ inside the Store ──────────▼─────────────────────────────────────┐
  │  separated by: NOTHING — one Map, one namespace, no index on kind │ ← NONE
  │  VectorStore contract has no metadata filter (contracts.ts:33-37) │   (shared)
  └─────────────────────────────┬─────────────────────────────────────┘
                                │
  ┌ Store → Read seam ─────────▼─────────────────────────────────────┐
  │  separated by: client-side filter AFTER an over-fetch             │ ← LOGICAL
  │  hits.filter(h => h.meta.kind===kind) (conversation-memory:97)    │   (re-derived)
  └──────────────────────────────────────────────────────────────────┘
```

Two seams hold a logical partition; the store itself holds none. That's the lesson. The `kind` tag is a **discriminator column with no index** — it exists only as a value in the open `meta` bag, re-checked at read time. Compare the document corpus (`06`): there, `docId` is a soft FK to a table that doesn't exist. Here, `kind` is a soft partition key over a collection that *does* exist but can't be queried by it. The whole file hangs on this: the partition is real in the data, invisible to the store, and re-asserted by the client on every recall.

## How it works

#### Move 1 — the mental model: a discriminator tag over a shared table

You already know the single-table-inheritance pattern from ORMs: one physical table holds two entity types, told apart by a `type` column — `vehicles` with `type IN ('car','truck')`, each row carrying the union of both shapes' fields. A vector store has no columns and no `WHERE`, so the memory model is single-table-inheritance with the discriminator pushed into the open `meta` bag and the `WHERE type='memory'` done in application code after the fact.

```
  The memory row model — discriminator tag in a shared namespace

  ONE store (Map<id, VectorChunk>)
  ┌─────────────────────────────────────────────────────────────┐
  │ id="guide#0"      meta={ docId, chunkIndex, text }           │ ← document row
  │ id="memory:c1:0"  meta={ kind:'memory', conversationId, text}│ ← memory row
  │ id="memory:c1:1"  meta={ kind:'memory', conversationId, text}│ ← memory row
  │ id="ghost#3"      meta={ docId, chunkIndex, text }           │ ← document row
  └─────────────────────────────────────────────────────────────┘
        │                       │
   id prefix says         meta.kind says
   which entity           which entity (the one recall trusts)

  recall: pull k×4, KEEP only meta.kind==='memory', slice k
```

The key insight: the *id prefix* and the *`kind` meta field* both encode the partition, but recall trusts only `meta.kind` (`conversation-memory.ts:97`). The id prefix makes rows human-readable and collision-safe; the `kind` tag makes them *filterable*. Two encodings of one fact — and that's a deliberate redundancy, because the store can sort by neither.

#### Move 2 — the three modeling choices, one at a time

**Part 1 — the composite id: `memory:<conversationId>:<n>`, a `kind:scope:counter` namespace.**

You know how the document corpus uses `"<docId>#<index>"` — a composite key encoding *which document* and *which chunk*. Memory uses the same trick with a THIRD component and a different delimiter: `` `${kind}:${turn.conversationId}:${n}` `` (`conversation-memory.ts:82`). Three parts: the entity kind, the conversation it belongs to, and a per-conversation ordinal.

```
  Memory id — three-part namespace vs the document's two-part key

  document:  "guide" # 0          →  <docId>#<index>
              └docId┘ └index┘         (kind is IMPLICIT — no prefix)

  memory:    "memory" : "c1" : 0   →  <kind>:<convId>:<counter>
              └kind─┘  └conv┘ └n┘       (kind is EXPLICIT — first segment)

  why the kind prefix on memory but not documents?
  → documents are the "default" rows; memory is the tagged minority.
    the prefix makes a memory id self-identifying at a glance.
```

The counter `n` comes from an in-memory `Map<conversationId, number>` (`conversation-memory.ts:71`, incremented at `:78-79`). First turn of conversation `c1` → `memory:c1:0`, second → `memory:c1:1`. This is the load-bearing part: drop the counter and every turn of a conversation collides on `memory:c1`, so `upsert` overwrites and only the *last* turn of each conversation survives — you'd have a memory that forgets everything but the most recent exchange. The counter is what makes a conversation's turns accumulate instead of clobber.

**Part 2 — the id-collision reasoning: why `conversationId` is assumed unique.**

Here's the subtle part. The counter lives in a `Map` that's local to one `createConversationMemory` instance and resets when the process restarts. So how are ids guaranteed distinct? The answer is in the comment at `conversation-memory.ts:69-70`: **`conversationId` is assumed unique per conversation.** That single assumption carries the whole id-uniqueness argument.

```
  Id uniqueness — the assumption that makes it sound

  WITHIN one conversation:   counter makes turns distinct
    c1 → memory:c1:0, memory:c1:1, memory:c1:2 …   (Map counter)

  ACROSS conversations:      conversationId makes them distinct
    c1 → memory:c1:*    c2 → memory:c2:*           (never overlap)
                │                  │
                └── distinct iff convId is globally unique ──┘

  the crack: process restart resets the counter Map to empty.
    if convId "c1" is REUSED after a restart, the new turns
    restart at :0 and OVERWRITE the old c1:0, c1:1 in a durable store.
```

So the uniqueness guarantee is *conditional*: ids are distinct as long as `conversationId` is never reused across the lifetime of the durable store. With an in-memory store that's fine — restart wipes everything, so reuse can't collide with rows that no longer exist. With a durable `PgVectorStore` (in buffr), it's a real constraint the caller must honor: hand out fresh conversation ids (a UUID, not a reused slug), or a recycled id silently overwrites an old conversation's first turns. Name this honestly in an interview — the counter is correct *given* unique conversation ids; it does not itself *enforce* uniqueness the way a database sequence or `gen_random_uuid()` default would.

**Part 3 — the `kind` discriminator: a soft partition over a shared store.**

The reason memory needs a `kind` tag at all is the design decision spelled out in the options doc-comment (`conversation-memory.ts:20-26`): memory MAY share the same store as documents. When it does, a recall must return memory rows *only* — a document chunk that happens to be semantically close to the query must not leak in as a "past exchange." There's no second table to put memory in (that'd defeat sharing), so the partition is a tag: every memory row carries `meta.kind = 'memory'` (`conversation-memory.ts:84`).

```
  The kind tag — a logical partition with no physical backing

  shared store (documents + memory mixed)
  ┌──────────────────────────────────────────────┐
  │ meta.kind = 'memory'   ← the partition KEY     │
  │ meta.kind = (absent)   ← document rows         │
  └──────────────────────────────────────────────┘
         │
         │  there is NO index on kind, NO partition,
         │  NO sub-collection. it's a value in an open bag.
         ▼
  recall must re-derive the partition CLIENT-SIDE every call:
    filter(h => h.meta?.kind === kind)
```

This is single-table inheritance's discriminator column, except the store can't index it or filter on it — the `VectorStore` contract is exactly `upsert` + `search(vector, k)` with no `where` (`contracts.ts:33-37`). So the discriminator buys you *correctness* (recall can tell memory from documents) but not *efficiency* (it can't ask the store for memory rows; it has to fetch a mixed bag and sort them out). That cost is Part 3's consequence, which is Part 4. Boundary condition: `kind` is configurable (default `'memory'`, `conversation-memory.ts:41`), so two memory instances over the same store with *different* `kind` values get two independent partitions — `'memory'` vs `'scratchpad'` never see each other's rows. The tag is the partition; change the tag, change the partition.

**Part 4 — over-fetch-then-filter: the recall path forced by no metadata index.**

This is the modeling consequence that's worth the whole file. Because the store can rank by vector similarity but can't filter by `kind`, `recall` can't say "give me the 5 nearest *memory* rows." It can only say "give me the nearest rows" and then throw away the documents. If memory is a minority of a large shared corpus, the top-`k` by pure similarity might be *all documents* — so asking for exactly `k` rows could return *zero* memory rows after the filter.

```
  Over-fetch then filter — the recall kernel

  want k=5 memory rows from a store that can't filter by kind:

  step 1  fetchK = max(k*4, 20)        ← over-fetch a wider net
  step 2  hits = store.search(qvec, fetchK)   ← 20 nearest of ANY kind
  step 3  hits.filter(kind==='memory') ← drop document rows  (client-side)
  step 4  .slice(0, k)                 ← keep the top 5 that survived

  why k*4 (min 20)?  a guess at "enough headroom that ≥k memory
  rows survive the filter." it is NOT a guarantee — if >15 of the
  20 nearest are documents, recall returns <5 memory rows.
```

The `fetchK = Math.max(k * 4, 20)` (`conversation-memory.ts:94`) is a heuristic headroom, not a correctness guarantee. It assumes memory rows aren't so heavily outnumbered near the query that 4× over-fetch still under-delivers. That's a fine bet when memory has its own dedicated store (then *every* row is memory and the filter is a no-op), and a risky one in a large shared corpus. This is the textbook cost of modeling a partition as an unindexed tag: the database can't help you select on it, so you pay in over-fetch and a client-side scan. The day this moves to a real `PgVectorStore` with SQL, the fix is `WHERE meta->>'kind' = 'memory'` pushed into the query — and then `fetchK` collapses back to `k` and the over-fetch disappears. The over-fetch is a workaround for a missing `WHERE`, nothing more.

#### Move 2.5 — current state vs future state

Memory today is built but lives entirely in-memory in AptKit; the durable binding is in buffr.

```
  Phase A (AptKit, now)            Phase B (buffr, durable)
  ──────────────────────           ────────────────────────
  store = InMemoryVectorStore      store = PgVectorStore
  partition = client-side filter   partition = WHERE kind='memory' (SQL)
  over-fetch k*4 then filter        fetch exactly k (server filters)
  counter Map resets on restart    convId must be durably unique (UUID)
  recall scans whole Map O(n)      recall uses an ANN index + WHERE
```

What *doesn't* change is the row shape and the module code: `createConversationMemory` speaks only the `VectorStore` contract (`conversation-memory.ts:60-61`), so swapping the store swaps durability and the filter strategy without touching `remember`/`recall`. The over-fetch-then-filter is the *only* part that's a stand-in for a capability the in-memory store lacks; it's load-bearing now, dead weight once SQL can filter.

#### Move 3 — the principle

A discriminator tag in an open metadata bag is the cheapest way to put two entities in one collection — and the cost is that the store can't index or filter on it, so every read that needs one kind pays an over-fetch and a client-side filter. Model a partition as a tag only when the store can't give you a real one; the moment it can (SQL `WHERE`, a sub-collection, a separate index), graduate the tag into something the engine enforces. Knowing that a `kind` field and a real partition are *not* the same thing — one is a hope re-checked on every read, the other is a guarantee the store maintains — is the data-modeling judgment this concept teaches.

## Primary diagram

The full memory model, from a turn to a recalled hit, every layer and the partition mechanism labelled.

```
  The memory row model — full path, partition points marked

  ┌─ Source ──────────────────────────────────────────────────────────────┐
  │  MemoryTurn { conversationId:"c1", question:"…", answer:"…" }           │
  └───────────────────────────────┬────────────────────────────────────────┘
        format(turn) (det.)        │   embedder.embed (768-dim, nomic)
                                   ▼
  ┌─ Write row: VectorChunk ───────────────────────────────────────────────┐
  │  id:"memory:c1:0"  vector:[…768…]                                       │
  │  meta:{ kind:'memory', conversationId:"c1", text:format(turn) }         │
  │       ▲ kind:convId:counter id     ▲ kind tag (the partition key)       │
  └───────────────────────────────┬────────────────────────────────────────┘
        upsert → assertDimension ✓ │  ◄═══ HARD CHECK (inherited from store)
                                   ▼
  ┌─ STORE: ONE Map<id, VectorChunk> — documents + memory mixed ───────────┐
  │  counter Map<convId,n> makes turns of a conversation accumulate         │
  └───────────────────────────────┬────────────────────────────────────────┘
        recall(query,k):           │  embed query → search(qvec, k*4≥20)
                                   ▼  ranks ALL rows (both kinds) by cosine
  ┌─ Over-fetch ──────────────────────────────────────────────────────────┐
  │  20 nearest rows of ANY kind (documents + memory intermixed)            │
  └───────────────────────────────┬────────────────────────────────────────┘
        filter meta.kind==='memory'│  ◄═══ LOGICAL PARTITION (client-side)
                                   ▼  .slice(0, k)
  ┌─ Read rows: MemoryHit[] ──────────────────────────────────────────────┐
  │  { id:"memory:c1:0", score:0.83, text, conversationId:"c1" }            │
  └───────────────────────────────┬────────────────────────────────────────┘
        memory-tool: drop convId   │  → SearchMemoryResult {id,score,text}
                                   ▼
  ┌─ Agent (search_memory tool) ──────────────────────────────────────────┐
  │  recalls past exchanges to ground an answer on prior context           │
  └────────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The memory model is reached for when an agent's answer may depend on something discussed in a *previous* exchange. The host calls `remember({conversationId, question, answer})` after each turn to persist it; later, `recall(query, k)` (or the `search_memory` tool) pulls the most relevant past exchanges back. Two deployment shapes the module supports without code change (`conversation-memory.ts:20-26`): memory shares the document store (then the existing `search_knowledge_base` tool surfaces it and no separate tool is needed — `memory-tool.ts:24-26`), or memory gets a dedicated store and the agent recalls it explicitly via `search_memory`. In-memory now; the durable `PgVectorStore` binding is in buffr.

**The row shapes — `packages/memory/src/conversation-memory.ts:4-16` and `memory-tool.ts:6`.**

```
  conversation-memory.ts  (lines 4-16)

  export type MemoryTurn = {            ← the INPUT (not a stored row)
    conversationId: string;             ← scope segment of the id + partition
    question: string;                   ┐ formatted together into the
    answer: string;                     ┘ embeddable/recallable text
  };
  export type MemoryHit = {             ← the RECALL output (internal)
    id: string;                         ← "memory:<convId>:<n>"
    score: number;                      ← cosine sim from the store
    text: string;                       ← denormalized turn text (from meta)
    conversationId?: string;            ← carried through for the caller
  };
       │
       └─ MemoryTurn is the un-embedded input; the stored row is a
          VectorChunk; MemoryHit is what recall hands back. Three shapes
          for one logical thing: input → row → hit.

  memory-tool.ts  (line 6)

  export type SearchMemoryResult = { id: string; score: number; text: string };
       │
       └─ the TOOL payload — MemoryHit MINUS conversationId. The model
          doesn't need the conv id to use the recalled text, so it's dropped
          at the tool boundary (memory-tool.ts:55).
```

**The write row — composite id + kind tag + denormalized text — `conversation-memory.ts:74-87`.**

```
  conversation-memory.ts  (lines 74-87, inside remember)

  const text = format(turn);                  ← render turn → one string
  const [vector] = await embedder.embed([text]);
  if (!vector) return;                        ← embedder produced nothing → skip
  const n = counters.get(turn.conversationId) ?? 0;   ← per-conv ordinal
  counters.set(turn.conversationId, n + 1);   ← bump so next turn gets n+1
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,  ← kind:convId:counter namespace
    vector,
    meta: { kind, conversationId: turn.conversationId, text },  ← tag + denorm text
  }]);
       │
       └─ THREE modeling facts in one upsert: the composite id (collision-safe
          given unique convId + the counter), the `kind` tag (the partition key),
          and `text` copied INTO meta (denormalized so recall returns the turn
          text without re-reading any source — same move as docs copying `text`
          into chunk meta in 06).
```

**The recall path — over-fetch then filter — `conversation-memory.ts:89-106`.**

```
  conversation-memory.ts  (lines 89-106, recall)

  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  const fetchK = Math.max(k * 4, 20);         ← over-fetch headroom (no WHERE)
  const hits = await store.search(vector, fetchK);   ← nearest of ANY kind
  return hits
    .filter(h => h.meta?.kind === kind)        ← the partition, client-side
    .slice(0, k)                               ← keep top-k survivors
    .map(h => ({                               ← project VectorHit → MemoryHit
      id: h.id,
      score: h.score,
      text: typeof h.meta?.text === 'string' ? h.meta.text : '',   ← type-guard
      conversationId: typeof h.meta?.conversationId === 'string'
        ? h.meta.conversationId : undefined,
    }));
       │
       └─ the filter is the partition made real on every call. The type-guards
          on meta.text / meta.conversationId are the price of the open `meta`
          bag (same cost the document tool pays in 06). Remove the filter and
          recall leaks document chunks as fake "past exchanges."
```

**The tool payload — drop conversationId at the boundary — `memory-tool.ts:49-57`.**

```
  memory-tool.ts  (lines 49-57, handler)

  const query = String(args.query ?? '');
  const topK = typeof args.top_k === 'number' ? args.top_k : defaultTopK;
  const hits = await memory.recall(query, topK);    ← recall does the filtering
  return {
    query,
    memories: hits.map(h => ({ id: h.id, score: h.score, text: h.text })),
  };
       │
       └─ MemoryHit → SearchMemoryResult: conversationId is dropped. The model
          gets {id, score, text} — exactly the citation surface, no internal
          scoping field. Mirrors how search_knowledge_base shapes its results.
```

## Elaborate

Retrieval-based episodic memory is the dominant way production LLM systems carry context across sessions: you can't fit the whole history in the context window, so you embed each turn, store it, and pull back only the turns relevant to the current query. LangChain's `VectorStoreRetrieverMemory`, Mem0, and Letta all do exactly this. AptKit's contribution is the deliberately minimal version — `remember` is one embed + one upsert; `recall` is one embed + one search + a filter — built on the *same* `VectorStore` contract the document corpus uses, so memory and documents are physically interchangeable storage and the only thing distinguishing them is a tag.

The `kind`-tag-as-partition choice is the part with the sharpest tradeoff, and it's worth naming both directions. **Shared store** (`kind` does the work): one piece of infra, memory and documents recalled by the same `search_knowledge_base` tool — but every recall over-fetches and filters, and a large document corpus can drown out memory near the query. **Dedicated store** (`kind` is a no-op): memory is isolated, the filter always passes, over-fetch is wasted but harmless, and you need a second store + the explicit `search_memory` tool. The module supports both with zero code change because it only speaks the contract — that's the payoff of modeling the partition as data rather than as two hard-coded tables.

The honest limitation, same as `06`: the in-memory store's `search` is an O(n) cosine scan, so over-fetching `k*4` rows is an O(n) sort either way — the over-fetch costs almost nothing here. It starts to matter in Postgres, where `fetchK` rows must come back over the wire and through the client before the filter; there the right answer is to push `WHERE meta->>'kind'='memory'` into the SQL and fetch exactly `k`. That move — tag-filter in the client → indexed predicate in the engine — is the single most important graduation this model has, and it's a `study-system-design` decision about *where* the filter runs; the *shape* (a `kind` discriminator) is this file.

Read next: file `06` (the document row model) for the sibling that shares this store and the `text`-into-meta denormalization; file `02` (the tagged-union event log) for the other discriminator-tag pattern, where `_tag` distinguishes six event variants the way `kind` distinguishes two row kinds here.

## Interview defense

**Q: You store conversation memory and documents in the same vector store. How do you tell them apart on recall?** A discriminator tag. Every memory row carries `meta.kind = 'memory'`; document rows don't. The store can't filter on it — the `VectorStore` contract is just `upsert` + `search(vector, k)`, no `where` — so recall over-fetches (`k*4`, min 20 nearest of any kind) and then filters `meta.kind === 'memory'` client-side before slicing to `k`. It's single-table inheritance with the `WHERE type=…` done in application code.

```
  shared store ──search(qvec, k*4)──► nearest of ANY kind
                                          │ filter meta.kind==='memory'
                                          ▼ slice k
                                      memory rows only
```

Anchor: *"`kind` is a soft partition — a tag in the meta bag, re-filtered on every recall because the store has no metadata index."*

**Q: Your memory ids are `memory:<convId>:<n>` with `n` from an in-process counter. What guarantees they don't collide?** Two things, and one assumption. Within a conversation, the per-`conversationId` counter makes turns distinct (`:0`, `:1`, …). Across conversations, distinctness rests on the assumption that `conversationId` is globally unique — stated in the code comment. The crack: the counter `Map` resets on process restart, so if a `conversationId` is *reused* after a restart against a durable store, the new `:0` overwrites the old one. With an in-memory store that's harmless (restart wipes the rows too); with `PgVectorStore` the caller must hand out fresh ids — a UUID, not a recycled slug.

```
  within conv:  counter → :0 :1 :2 …      (accumulate, never clobber)
  across convs: convId unique → no overlap (ASSUMED, not enforced)
  restart:      counter resets → reused convId can overwrite durable rows
```

Anchor: *"The counter makes turns distinct; `conversationId` uniqueness makes conversations distinct — and that uniqueness is assumed, not enforced by the model."*

**Q: Why over-fetch `k*4`? Isn't that wasteful?** It's a workaround for a missing `WHERE`. The store ranks by similarity but can't filter by `kind`, so to get `k` *memory* rows I have to pull more than `k` rows of any kind and hope enough survive the filter. `k*4` (min 20) is headroom, not a guarantee — if memory is heavily outnumbered near the query, even 20 could come back as <`k` after filtering. In the in-memory store the over-fetch is nearly free (search is already an O(n) scan). The real fix is Postgres: push `WHERE meta->>'kind'='memory'` into the query and fetch exactly `k` — the over-fetch exists only because the in-memory contract can't filter.

```
  no WHERE:  fetch k*4 → filter → slice k   (today, in-memory)
  SQL WHERE: fetch exactly k (server filters) (buffr / pgvector)
```

Anchor: *"The over-fetch is a stand-in for `WHERE kind='memory'` — it disappears the moment the store can filter."*

## Validate

**Reconstruct.** From memory, write the input type and the stored row's id + meta. `MemoryTurn = { conversationId: string; question: string; answer: string }`; the row is `id = "memory:<conversationId>:<n>"`, `meta = { kind: 'memory', conversationId, text }`, `vector = embed(format(turn))`. (`conversation-memory.ts:4-8, 80-87`.)

**Explain.** Why does the id need both `conversationId` AND a counter `n`, when `06`'s document id needs only `docId` and an index? (Document chunks are produced all-at-once from one doc, so the index is the chunk's position. Memory turns arrive over time, one per call, so there's no batch position — the counter, kept in a `Map`, supplies the ordinal that makes a conversation's turns accumulate instead of overwriting on a shared `memory:<convId>` key. `conversation-memory.ts:71, 78-82`.)

**Apply to a scenario.** Memory shares a store with 10,000 document chunks. You `recall("…", 5)` and the 20 nearest rows by similarity are all documents. What does recall return, and why? (An empty array — the `kind` filter drops all 20 document rows and there are no memory rows left to slice. `k*4=20` headroom wasn't enough; the partition is unindexed so the store couldn't be asked for memory rows directly. `conversation-memory.ts:94-98`. The fix is a server-side `WHERE kind='memory'`.)

**Defend the decision.** An interviewer says "you should have put memory in its own table instead of tagging it." Defend the shared-store-plus-tag choice — and say when you'd switch. (The tag lets one store serve both, so the same `search_knowledge_base` tool surfaces memory and documents together, and the module swaps in-memory for pgvector with zero code change because it only speaks the `VectorStore` contract. I'd switch to a dedicated store the moment memory needs isolation or the document corpus grows large enough that over-fetch-then-filter under-delivers — at which point `kind` becomes a no-op and the `search_memory` tool recalls the isolated store directly. `conversation-memory.ts:20-26`, `memory-tool.ts:24-26`.)

## See also

- `06-vector-store-row-model.md` — the sibling that shares this exact store; the document row (`"<docId>#<i>"`, `meta.docId`) vs the memory row (`"memory:<convId>:<n>"`, `meta.kind`). The `text`-into-meta denormalization is the same move in both.
- `02-tagged-union-event-log.md` — the other discriminator-tag model; `_tag` distinguishes six event variants the way `kind` distinguishes two row kinds, both self-describing rows on a wire.
- `audit.md` — Lens 1 (second store-shaped model), Lens 2 (memory `text` denorm), Lens 3 (over-fetch-then-filter as the cost of an unindexed partition), Lens 6 (one store, two logical entities).
- `study-system-design` — *where* the partition filter runs (client over-fetch vs SQL `WHERE`) and *whether* memory shares the document store; the row shape and the `kind` tag are this file.
