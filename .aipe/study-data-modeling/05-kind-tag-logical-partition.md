# 05 — A `kind` tag as a logical partition over one collection

**Industry name(s):** discriminator/type tag · single-table polymorphism ·
logical (vs physical) partition · over-fetch-then-filter. **Type:**
Industry-standard pattern, here a workaround for a contract with no
metadata predicate.

## Zoom out, then zoom in

Conversation memory and indexed documents share *one* vector store. They're
told apart only by a tag inside `meta`. Here's the shared collection.

```
  Zoom out — two row types, one collection, one tag

  ┌─ aptkit VectorStore (shared instance) ──────────────────────────┐
  │  row id "guide.md#3"      meta {docId, chunkIndex, text}         │ ← document
  │  row id "memory:c1:0"     meta {kind:'memory', conversationId,   │ ← memory
  │                                 text}                            │
  │  row id "guide.md#4"      meta {docId, ...}                      │ ← document
  │  ...                                                             │
  │                                                                  │
  │  search(vector, k) returns BOTH types, ranked by similarity     │
  │  → recall() must filter to kind='memory' AFTER the search        │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in. `createConversationMemory` can be wired to the *same* store the
documents use (the docstring says so explicitly —
`packages/memory/src/conversation-memory.ts:20-26`). When it is, a memory
row and a document chunk live side by side in one collection, distinguished
only by `meta.kind === 'memory'`. The catch: the `VectorStore.search`
contract takes `(vector, k)` and *nothing else* — no metadata filter. So
"give me the 5 most relevant *memory* rows" can't be expressed as a query.
This file is about the pattern that bridges that gap: over-fetch, then
filter by tag client-side.

## The structure pass

Axis: **where does the type filter happen — in the store or in the
caller?**

```
  axis = "how does recall get ONLY memory rows?"

  ┌─ ideal: store filters ───┐  seam  ┌─ reality: caller filters ────┐
  │ search(vec, k,           │ ══╪══► │ search(vec, k*4) → over-fetch │
  │   {kind:'memory'})       │ flips  │ then .filter(kind) .slice(k)  │
  │ contract has NO such arg │        │ in conversation-memory.ts      │
  └──────────────────────────┘        └──────────────────────────────┘
                                              ▲
                              the partition is LOGICAL (a tag), not
                              PHYSICAL (a separate table/collection)
```

- **Layers:** the `VectorStore` contract (top, generic) vs the memory
  engine that consumes it (bottom, type-aware).
- **The axis (where filtering happens):** because the contract can't
  filter by metadata, the responsibility flips to the caller. The store
  ranks everything; the memory engine narrows to its `kind`.
- **The seam:** the contract boundary deliberately has no metadata
  predicate — that's what kept it a clean enough interface for buffr's
  `PgVectorStore` to implement. The price of that clean seam is paid
  here, in over-fetch-then-filter.

## How it works

#### Move 1 — the mental model

You've done this exact move in the browser: an API returns a mixed list and
you `.filter()` it client-side because the endpoint won't take the
parameter you want. Memory `recall` is that — `search` returns a mixed,
similarity-ranked list of documents *and* memories, and the engine filters
to `kind:'memory'` after the fact. The wrinkle is ranking: if you ask for
`k` and 3 of the top `k` are documents, you'd get fewer than `k` memories.
So you over-fetch a bigger window first, *then* filter, *then* slice to `k`.

```
  the pattern — over-fetch, filter by tag, slice

  want k memory hits
        │  fetchK = max(k*4, 20)        ← over-fetch a wider window
        ▼
  store.search(vector, fetchK)          ← returns mixed kinds, ranked
        │  .filter(h => h.meta.kind === 'memory')   ← logical partition
        │  .slice(0, k)                              ← back down to k
        ▼
  k memory hits (or fewer if the window held fewer)
```

#### Move 2 — the walkthrough

**Tagging on write — the id namespace + the meta key.** `remember` stamps
both the id and the `meta` with the kind —
`/Users/rein/Public/aptkit/packages/memory/src/conversation-memory.ts:80-86`:

```ts
await store.upsert([
  {
    id: `${kind}:${turn.conversationId}:${n}`,        // id namespace: "memory:c1:0"
    vector,
    meta: { kind, conversationId: turn.conversationId, text },   // the tag
  },
]);
```

Two markers, doing different jobs. The id prefix (`memory:…`) namespaces
the *key* so a memory row can never collide with a document chunk's id
(`docId#index`) — they're disjoint by construction. The `meta.kind` is what
`recall` actually filters on, since the search result carries `meta`, not a
parsed id. The `n` is a per-conversation counter (`counters` Map,
`conversation-memory.ts:71,78-79`) so repeated turns in one conversation
get distinct ids.

**Filtering on read — over-fetch then narrow.**
`recall` — `conversation-memory.ts:89-105`:

```ts
const fetchK = Math.max(k * 4, 20);          // over-fetch: documents may rank above memory
const hits = await store.search(vector, fetchK);
return hits
  .filter((h: VectorHit) => h.meta?.kind === kind)   // ← the logical partition
  .slice(0, k)
  .map((h) => ({ id: h.id, score: h.score, text: ..., conversationId: ... }));
```

Walk it: `fetchK = max(k*4, 20)` pulls a window 4× the request (floor 20),
because in a shared store the top results could be all documents. Then
`.filter(meta.kind === kind)` keeps only memory rows — *this line is the
entire partition.* Then `.slice(0, k)` trims back to what the caller asked.
**What breaks if you drop the over-fetch: in a shared store, `search(vec,
k)` could return `k` documents and zero memories, and `recall` returns an
empty list even though relevant memories exist.** The over-fetch is the
load-bearing compensation for a contract that can't filter server-side.

**The same shape appears in the document tool.** `search_knowledge_base`
uses the identical over-fetch-then-filter when given an optional metadata
`filter` — `packages/retrieval/src/search-knowledge-base-tool.ts:87-90`:
`fetchK = filter ? topK * 4 : topK`, then `hits.filter(matchesFilter)`. Two
consumers, same workaround, same root cause: `VectorStore.search` has no
predicate. Name it once: **client-side metadata filtering is just
over-fetch + filter at every call site**, because the seam doesn't carry a
predicate.

**Why logical, not physical?** A dedicated store (separate collection) is
the other option the engine supports — the docstring's "DEDICATED store
(memory isolated)" path (`conversation-memory.ts:21-25`). When memory has
its own store, `search` returns only memory and the filter is a no-op. The
shared-store path trades that cleanliness for "zero new infrastructure" —
memory rides the document corpus and surfaces through the existing
`search_knowledge_base` tool. The `kind` tag is what makes one collection
serve two row types.

#### Move 3 — the principle

When you put two row types in one collection, you need a discriminator —
and how you filter on it depends entirely on what the storage *seam* lets
you express. A contract with a metadata predicate filters server-side,
cheap. A contract without one (kept deliberately narrow so it's easy to
implement) pushes filtering to the caller, who must over-fetch to avoid
starving the post-filter. The tag is free; the *consequence* of the tag —
over-fetch-then-filter — is the cost of a narrow interface. Whether to pay
it (shared store) or avoid it (dedicated store) is a real per-use decision,
and the engine leaves it to the caller on purpose.

## Primary diagram

```
  the logical partition, end to end

  ── aptkit memory engine ──────────────────────────────────────────
  remember(turn)                          recall(query, k)
     │ id   = "memory:<conv>:<n>"            │ fetchK = max(k*4, 20)
     │ meta = {kind:'memory', conv, text}    ▼
     ▼                                  store.search(vec, fetchK)
  store.upsert([row])                        │ returns MIXED kinds, ranked
     │                                       │ .filter(meta.kind==='memory')  ← partition
     ▼                                       │ .slice(0, k)
  ── shared VectorStore (one collection) ────▼───────────────────────
  [ doc#0 | memory:c1:0 | doc#1 | memory:c1:1 | doc#2 | ... ]
     ▲ search has NO metadata predicate → filtering must happen above
  (durable: buffr PgVectorStore — same contract, same no-predicate limit)
```

## Elaborate

This is single-table polymorphism (a `type`/`kind` column distinguishing
row variants in one table) meeting a vector-store contract that, unlike
SQL, has no `WHERE`. In SQL you'd write `where meta->>'kind' = 'memory'`
and the DB filters server-side — and in fact buffr's `PgVectorStore`
*could* add that, since it's backed by Postgres jsonb. It doesn't, because
the `VectorStore` contract it implements has no predicate parameter, and
adding one to the contract would ripple to `InMemoryVectorStore` and every
consumer. So the limitation is inherited from the seam, not from Postgres.
The honest cost of over-fetch: `recall` reads `k*4` rows to return `k`,
and in a corpus where memories are rare relative to documents, even `k*4`
might not contain `k` memories — recall silently under-returns. A dedicated
memory store sidesteps it entirely. Read next: `02` (the same `meta` bag
that carries the tag), `study-ai-engineering` for retrieval/memory design.

## Interview defense

**Q: Memory and documents share one vector store — how do you keep `recall`
from returning documents?**

A `kind` tag in `meta` (and a `memory:` id namespace). The problem is the
`VectorStore.search` contract takes only `(vector, k)` — no metadata
filter — so I can't ask the store for "memory rows only." `recall`
over-fetches a wider window (`max(k*4, 20)`), filters to `meta.kind ===
'memory'` client-side, then slices back to `k`. The over-fetch matters:
without it, a search could return `k` documents and zero memories and
`recall` would come back empty.

```
  search(vec, k*4)  → mixed ranked list
       .filter(kind === 'memory')   ← the partition
       .slice(0, k)
  no predicate in the contract → filter must be caller-side + over-fetch
```

Anchor: *a narrow storage contract pushes the type filter to the caller —
so you over-fetch then filter, and the over-fetch is the part people
forget.*

**Q: Why share a store at all instead of separating memory out?**

Zero new infrastructure — memory rides the existing document corpus and
surfaces through the same `search_knowledge_base` tool. The engine also
supports a dedicated store when you want physical isolation; then the
filter is a no-op. It's a per-use call, left to whoever wires it.

Anchor: *logical partition (shared store + tag) buys zero-infra; physical
partition (dedicated store) buys clean queries — the engine supports
both.*

## See also

- `02-metadata-as-json-bag.md` — the `meta` bag the `kind` tag lives in.
- `03-embedding-dimension-one-way-door.md` — sharing one dimension-pinned
  collection.
- `01-dropped-fk-for-drop-in-parity.md` — memory rows are the
  dangling-`document_id` case.
- `audit.md` §4 (integrity), §6 (access patterns).
