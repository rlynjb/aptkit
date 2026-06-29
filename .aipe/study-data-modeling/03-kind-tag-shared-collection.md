# 03 — The discriminator tag over a shared collection

**Industry name(s):** discriminator column / single-collection-multiple-types
(a.k.a. single-table inheritance, type-tag partition). **Type:** Industry
standard.

Conversation memory and document chunks are the **same physical rows in the
same `chunks` table**, distinguished only by a discriminator (`meta.kind`).
One collection, two logical entities, separated by a tag — and recall
filters by that tag *client-side* because the `VectorStore` contract has no
metadata predicate.

## Zoom out, then zoom in

The memory engine writes into the *same* store the documents use. The only
thing keeping them apart is a string in the `meta` bag.

```
  Zoom out — where the discriminator lives

  ┌─ aptkit memory (packages/memory) ──────────────────────────┐
  │  createConversationMemory({embedder, store})               │
  │   remember(turn) → upsert chunk meta.kind='memory'         │ ← we are here
  │   recall(query)  → search, then FILTER by meta.kind        │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ SAME VectorStore instance
  ┌─ shared store (InMemory or PgVectorStore) ──▼──────────────┐
  │  one collection / one chunks table                         │
  │   row meta.kind='memory'   ┐                               │
  │   row (no kind = document) ┴─ mixed together, one index    │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a clean design would give memory its own table or its own store. It
doesn't — `session.ts:53` passes the *same* `store` to both the retrieval
pipeline and `createConversationMemory`. So a document chunk and a remembered
Q/A exchange are indistinguishable at the storage level except for
`meta.kind`. The question it answers: *how do you add episodic memory with
zero new infrastructure — no new table, no new store, no new contract?* You
overload the existing collection and partition it with a discriminator.

## Structure pass

```
  One axis — "what type is this row, and who decides?" — across layers

  ┌─ memory engine ───────────────────┐
  │  remember tags kind='memory'      │   → ENGINE decides type, writes tag.
  └───────────────────────────────────┘
              │  the seam ═══════════════  ◄── type-awareness flips here
              ▼
  ┌─ VectorStore contract ────────────┐
  │  upsert / search(vector, k)       │   → STORE is type-BLIND. No filter,
  └───────────────────────────────────┘      no predicate. Returns all kinds.
              │  recall reads back
              ▼
  ┌─ recall (client filter) ──────────┐
  │  hits.filter(kind==='memory')     │   → ENGINE re-decides type on read.
  └───────────────────────────────────┘
```

- **Layers:** memory engine → the `VectorStore` contract → recall.
- **Axis = "what type is this row?"** The engine knows (it sets the tag).
  The store is deliberately blind — `search(vector, k)` has no `where kind=`
  argument. So recall has to re-establish type *after* the search, in the
  client.
- **The seam = the `VectorStore.search` boundary.** Type-awareness flips
  here: the engine is type-aware, the store is type-blind, and the
  contract's missing metadata predicate is the whole reason recall
  over-fetches then filters. That gap is the load-bearing constraint.

## How it works

#### Move 1 — the mental model

You've done this in the frontend: one `items` array holding todos and notes,
each tagged `{type: 'todo'}` or `{type: 'note'}`, and `items.filter(i =>
i.type === 'todo')` to get one kind back. Single-table inheritance is that,
in a database — one table, a `kind` column, filter on it. The twist here:
the "table" is a vector index queried by similarity, and the query API
*can't* filter — so the filter moves to after the fetch, and you over-fetch
to compensate for the rows the filter will drop.

```
  The pattern — over-fetch, then filter by discriminator

  recall(query, k=5)
        │ embed query
        ▼
  search(vector, fetchK = max(k*4, 20))   ← over-fetch: ask for MORE than k
        │
        ▼
  [doc, memory, doc, memory, memory, doc, ...]   ← mixed kinds come back
        │ filter kind === 'memory'
        ▼
  [memory, memory, memory]                        ← keep memory
        │ slice(0, k)
        ▼
  top-k memory hits
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — `remember` writes the discriminator.** The engine stamps
`kind='memory'` into the bag and namespaces the id.

```ts
// packages/memory/src/conversation-memory.ts:80-86
await store.upsert([
  {
    id: `${kind}:${turn.conversationId}:${n}`,        // ← "memory:c1:0" — id namespace
    vector,
    meta: { kind, conversationId, text },             // ← kind is the discriminator
  },
]);
```

`kind` defaults to `'memory'` (`:41`). A document chunk, by contrast, has no
`kind` key (the pipeline sets only `docId`/`chunkIndex`/`text`,
`pipeline.ts:44`). So presence-of-`kind` *is* the type. The id namespace
(`memory:<convId>:<n>`) also keeps memory ids from colliding with document
chunk ids (`<docId>#<index>`) — two id schemes in one keyspace, kept
distinct by prefix.

**Step 2 — the store is deliberately type-blind.** `VectorStore.search` has
no metadata filter — by design, so every adapter (in-memory, pgvector) is
trivial to implement.

```ts
// packages/retrieval/src/contracts.ts:35-36
upsert(chunks: VectorChunk[]): Promise<void>;
search(vector: number[], k: number): Promise<VectorHit[]>;  // ← no `filter` arg
```

This is the constraint that shapes everything downstream. The contract could
have added a `filter?: Record<string, unknown>` — it didn't, to keep the
adapter surface minimal. The price is paid in recall.

**Step 3 — `recall` over-fetches, then filters client-side.** Because the
store returns *all* kinds ranked together, recall asks for far more than `k`
and drops the non-memory rows.

```ts
// packages/memory/src/conversation-memory.ts:89-105
const [vector] = await embedder.embed([query]);
// Over-fetch then filter: a shared store may return documents above memory,
// and search itself cannot filter by metadata.
const fetchK = Math.max(k * 4, 20);                  // ← ask for 4× (min 20)
const hits = await store.search(vector, fetchK);
return hits
  .filter((h) => h.meta?.kind === kind)              // ← keep only memory
  .slice(0, k)                                        // ← then trim to k
  .map((h) => ({ id: h.id, score: h.score, text: ..., conversationId: ... }));
```

The `k*4` (floor 20) is a heuristic margin: if documents outrank memory in
similarity, you still want enough memory rows to survive the filter. It's
**not a guarantee** — if more than `fetchK - k` documents outrank every
memory row, recall returns fewer than `k` memory hits, or none. That's the
accepted failure mode of partitioning a similarity index with a
post-filter.

```
  Layers-and-hops — recall against a shared collection

  ┌─ session ──────┐  memory.recall(query, 5)
  │ ask() / turn   │ ───────────────────────────────────────────┐
  └────────────────┘                                             │
                       ┌─ ConversationMemory.recall ───────────┐ │
                       │ fetchK = max(5*4, 20) = 20            │◄┘
                       │ store.search(vec, 20)                 │
                       └───────────────┬───────────────────────┘
                       ┌─ VectorStore (shared) ▼───────────────┐
                       │ ranks ALL 20 nearest — docs + memory  │
                       │ mixed, no kind filter possible        │
                       └───────────────┬───────────────────────┘
                       ┌─ recall (client) ▼────────────────────┐
                       │ filter kind==='memory' → slice(0,5)   │
                       │ RISK: <5 if docs dominate the top 20  │
                       └────────────────────────────────────────┘
```

**Step 4 — and the dropped FK makes it physically legal.** A memory chunk
has no `meta.docId`, so `PgVectorStore.upsert` writes `document_id = null`
(`pg-vector-store.ts:44`). Because the FK was dropped
(`01-soft-fk-for-drop-in-parity.md`), that orphan row is valid. The
discriminator pattern *depends on* the soft FK — you can't share the table
if the table demands a parent document for every row.

#### Move 2 variant — the load-bearing skeleton

Kernel of "discriminator over a shared collection": **a type tag on each row
+ a shared store + a read that filters by the tag.** When the store can't
filter, add: **over-fetch by a margin before filtering.**

- **Drop the tag** and memory and documents are indistinguishable — recall
  returns documents as if they were past exchanges.
- **Drop the over-fetch** (search for exactly `k`) and a single high-scoring
  document can push every memory row out of the result, so recall silently
  returns nothing useful.
- **Drop the client filter** and recall returns mixed kinds — a document
  chunk surfaces as a "past exchange."

Optional hardening (not present): a real metadata predicate on the contract
(`search(vector, k, filter)`) pushed down to a SQL `where meta->>'kind' =
'memory'`, which would make the over-fetch unnecessary and the guarantee
exact. `not yet exercised` — and the cleanest future fix.

#### Move 3 — the principle

A discriminator over a shared collection is the cheapest way to add a second
entity type — zero new infrastructure. The tax is paid at read time, and the
tax is proportional to how much the storage layer can filter for you: a SQL
`where` makes it free; a similarity index with no predicate makes you
over-fetch and filter in the client, accepting a probabilistic miss. Know
which you have before you reach for the pattern.

## Primary diagram

```
  One collection, two entities, a discriminator between them

  remember(turn)                          indexDocument(doc)
    id: memory:c1:0                          id: doc-7#0
    meta.kind = 'memory'                     meta.docId = 'doc-7'  (no kind)
        │                                        │
        └──────────────┐          ┌──────────────┘
                       ▼          ▼
        ┌─ shared VectorStore / agents.chunks ───────────────┐
        │  [memory row] [doc row] [memory row] [doc row] ...  │
        │  one HNSW index over ALL embeddings, mixed kinds    │
        └───────────────┬─────────────────────────────────────┘
          recall:       │ search(fetchK=max(k*4,20))
          over-fetch    ▼
          + filter   filter(kind==='memory') → slice(0,k)
                       │
                       ▼  may return < k if documents dominate
                    top-k memory hits
```

## Elaborate

Single-table inheritance / discriminator columns are a classic ORM pattern
(Rails STI, Hibernate `@DiscriminatorColumn`) — one table holds several
related types, a column says which. The trade is always the same: one table
is simpler to query across types and cheaper to add a type to, at the cost
of nullable columns (the columns one type uses and another doesn't) and
weaker per-type constraints.

What's distinctive here is doing it over a *vector* collection, where the
"query" is similarity and the storage layer can't filter. That turns the
clean STI `WHERE kind = ?` into an over-fetch-and-filter heuristic with a
real miss probability. The context.md calls memory reusing the retrieval
contracts "the strongest evidence the contracts were the right boundary" —
and it is, but this file is the honest footnote: the missing metadata
predicate is the contract's one rough edge, and the over-fetch is the scar.
Read next: `01-soft-fk-for-drop-in-parity.md` (the orphan rows this needs),
and study-system-design for memory-reuses-retrieval as an architecture call.

## Interview defense

**Q: Memory and documents share one table, separated by a `meta.kind` tag,
and you filter for it *after* the similarity search. Why not just filter in
the query?**

> Verdict: because the `VectorStore` contract deliberately has no metadata
> predicate — `search(vector, k)`, nothing else — so every adapter stays
> trivial to implement. The cost lands in recall: I over-fetch
> `max(k*4, 20)` candidates, then filter `kind === 'memory'` client-side and
> trim to `k`. It's a heuristic, not a guarantee — if documents dominate the
> top of the ranking, recall can return fewer than `k` memory hits. The
> clean fix is to add a pushed-down filter to the contract; I haven't,
> because the laptop corpus is small enough that the over-fetch margin
> always covers it.

```
  search(fetchK=20) → [doc,mem,doc,mem,mem,...] → filter kind=memory → slice(k)
                       RISK: docs dominate → fewer than k memory hits
```

Anchor: *a discriminator over a similarity index trades a free SQL `WHERE`
for a probabilistic over-fetch — name the miss case.*

**Q: What did sharing the store buy you, and what did it cost?**

> Bought: zero new infrastructure — `remember` is the RAG index path,
> `recall` is the query path, same embedder and store. Memory even surfaces
> through the existing `search_knowledge_base` tool. Cost: the over-fetch
> heuristic above, and memory rows are orphan chunks with no document, which
> is only legal because I dropped the FK on `chunks.document_id`.

Anchor: *reusing the retrieval contracts for memory is the payoff; the
post-filter and the orphan rows are the bill.*

## See also

- `01-soft-fk-for-drop-in-parity.md` — the dropped FK that lets memory rows
  exist with no document.
- `02-metadata-as-a-json-bag.md` — `meta.kind` is a bag key, like `docId`.
- `04-embedding-dimension-one-way-door.md` — both kinds share one dimension,
  enforced at wiring.
- `audit.md` lenses 2, 4 — single-collection denormalization and the
  app-enforced `kind` invariant.
- **study-system-design** — memory-reuses-retrieval as an architectural
  seam.
