# Memory Recall Over-Fetch

*Industry names: read amplification, over-fetch-then-filter, client-side
post-filtering (the missing-pushdown anti-pattern); unbounded append / no
TTL; write-path embedding. Type: Industry standard (the cost shape every
"filter we couldn't push to the store" pays).*

## Zoom out, then zoom in

`@aptkit/memory` gives an agent episodic memory: store each past exchange as
a vector, recall the ones similar to a new question. It's built on the exact
same `VectorStore` the documents use (file **07**). The catch is that memory
rows and document rows can live in the *same* store, and the store's `search`
returns the top-k by similarity with **no way to say "only the memory ones."**
So `recall` asks for far more rows than it needs, then throws most away in
JS. That's the cost shape this file is about — read amplification — plus two
companions: memory that grows forever, and an embedding hop that's now on the
write path too.

```
  Zoom out — where memory sits relative to the document scan

  ┌─ Agent layer ──────────────────────────────────────────────┐
  │  search_memory tool  /  search_knowledge_base tool          │ ← callers
  └───────────────────────────────┬─────────────────────────────┘
                                  │  query text in
  ┌─ Memory layer (@aptkit/memory) ▼───────────────────────────┐
  │  recall(query, k)                                            │
  │    embed(query)                                              │
  │    ★ over-fetch: search(vec, max(k*4, 20)) ★                 │ ← we are here
  │    filter meta.kind === 'memory'  →  slice(0, k)             │
  └───────────────────────────────┬─────────────────────────────┘
                                  │  search(vec, fetchK)
  ┌─ Retrieval layer (@aptkit/retrieval) ▼─────────────────────┐
  │  InMemoryVectorStore.search  →  O(n·d) flat scan (file 07)  │
  │  n = documents + UNBOUNDED memory rows (shared store)        │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: there's no new algorithm here. `recall` is just `search` from file
**07** with a multiplier in front and a `.filter()` behind. The pattern worth
learning is *why the multiplier exists* (a contract with no metadata filter),
*what it costs* (4×/≥20 the rows scanned and transferred per recall), and the
two cost companions it ships with — unbounded growth and a write-path embed.

## The structure pass

**Layers:** agent (asks to recall) → memory (embeds, over-fetches, filters) →
retrieval (the O(n·d) scan over n rows) → storage (the shared `Map`, now
holding documents *and* an ever-growing pile of memory rows).

**Axis — rows touched per returned result, traced down the stack.** Hold one
question constant: *to hand back k useful rows, how many does each layer have
to look at?* The answer inflates at one seam and never deflates.

```
  Axis = "rows touched per returned result" — traced across the contract seam

  ┌─ recall asks for k ─┐  seam:  ┌─ store can only do search(vec, K) ─┐
  │  wants k MEMORY rows│ ══════►  │  returns top-K by score, ANY kind  │
  │                     │ (filter  │  no `where kind = 'memory'` exists │
  │                     │  can't   └────────────────────────────────────┘
  │                     │  push                    │
  │                     │  down)    over-fetch K = max(k*4, 20), then
  └─────────────────────┘           filter in JS, slice k
         ▲                                  ▲
         └──── same VectorStore contract, but the filter lives on the
               WRONG side of the seam → 4×/≥20 read amplification
```

**The seam is the `VectorStore` contract** (`packages/retrieval/src/
contracts.ts:33-37`): `search(vector, k)` — vector and a count, nothing else.
There's no predicate argument, so a `kind === 'memory'` filter *cannot* be
expressed to the store. It has to run on the caller's side, *after* the store
has already scored and sorted rows it will discard. That single missing
parameter is the whole reason `recall` over-fetches. Contrast buffr's
`PgVectorStore`, which *does* push one filter into the scan (`where app_id =
$2`, `buffr/src/pg-vector-store.ts:74`) — proof the shape works; it just lacks
a `kind` predicate so it'd over-fetch a shared memory store too.

## How it works

### Move 1 — the mental model

You already know this shape from any list UI where the backend can't filter
and you do it on the client: you fetch a page bigger than you need, drop the
rows that don't match, and show the first k. The cost is the rows you fetched
and threw away. Here the "page" is a vector search and the discarded rows were
*scored and sorted* first — so the waste is scan work, not just transfer.

```
  The over-fetch-then-filter kernel

  k wanted ─┐
            ▼
   fetchK = max(k*4, 20)               ← ask the store for MORE than k
   hits = search(queryVec, fetchK)     ← O(fetchK·d) scan + sort (file 07)
   hits.filter(kind === 'memory')      ← drop the rows we can't use
        .slice(0, k)                   ← keep the first k survivors

   the rows between k and fetchK are scored, sorted, transferred, discarded
```

The kernel is: **over-fetch → filter → slice**. The over-fetch is forced by
the seam; strip it and a shared store could return *zero* memory rows in its
top-k (all documents), so recall would silently return nothing. That's the
load-bearing reason it exists — and also exactly why it's a tax, not a bug.

### Move 2 — the walkthrough

**The multiplier — why `max(k*4, 20)`.** Bridge from a pagination buffer: if
you know roughly what fraction of the top-k will survive a client filter, you
over-fetch by the inverse of that fraction. Here the code assumes memory is a
minority of a shared store, so it pulls 4× the wanted k, with a floor of 20 so
small k (the default is 5) still has a real shot at finding memory rows buried
under documents.

```
  fetchK = max(k*4, 20)  — what the multiplier buys and costs

  k = 5   → fetchK = 20   (the floor wins)   → scan/sort/transfer 20 to keep 5
  k = 10  → fetchK = 40   (4× wins)          → scan/sort/transfer 40 to keep 10
  k = 100 → fetchK = 400  (4× wins)          → 400 rows scored to return 100

  the gap (fetchK − survivors) is pure waste: scored, ranked, then dropped
```

The boundary condition that bites: if memory is *more* than a quarter of the
store, 4× may still not surface enough memory rows in the top-fetchK, and
recall under-returns. If it's a tiny fraction, you over-fetch wildly. Either
way a fixed multiplier is a guess at a ratio the store could just *know* if
the filter lived on its side.

**The scan underneath — this is file 07, amplified.** The store doesn't have a
cheaper path for "fetch 20 then filter." `search(vec, 20)` runs the same
O(n·d) flat cosine scan over *every* row, scores all n, sorts all n, and
returns the top 20 (`in-memory-vector-store.ts:25-33`). The over-fetch doesn't
add scan passes — the scan is already all-n — but it *enlarges the sort and
transfer* and, more importantly, it means the n itself is bigger: a shared
store's n is documents **plus every memory row ever written**.

```
  Layers-and-hops — one recall, what each layer touches

  ┌─ Memory ────┐  hop 1: embed(query)            ┌─ Embedder ──┐
  │  recall(k=5)│ ──────────────────────────────► │  Ollama HTTP│
  │             │ ◄───────────── 768-d vector ──── └─────────────┘
  │             │  hop 2: search(vec, fetchK=20)   ┌─ Retrieval ─┐
  │             │ ──────────────────────────────► │  scan ALL n │
  │             │ ◄──────── 20 hits (any kind) ─── │  n = docs + │
  │  filter →   │                                  │  memory rows│
  │  slice(5)   │                                  └─────────────┘
  └─────────────┘
     the 15 non-memory (or surplus) hits in those 20 were scanned,
     sorted, and shipped across hop 2 only to be dropped here
```

**The growth — `remember` only ever appends.** Bridge from an append-only log:
every `remember` writes one row and nothing ever removes one. There's no
eviction, no TTL, no summarization anywhere in the package
(`conversation-memory.ts:74-87`). Over one conversation that's fine; over a
long-lived history the memory rows accumulate, and because they share the
store with documents, they inflate the n that *every* query — document search
or memory recall — has to scan.

```
  Unbounded append vs the bounded alternatives (none present today)

  now:        remember → upsert(row)   [grows forever]
              │
              └─ n_scan = n_docs + n_memory,  n_memory only ever ↑

  alternatives the repo does NOT yet have:
     • row cap        keep newest N memory rows
     • TTL            drop rows older than T
     • summarization  fold old turns into one rolling memory row
```

The boundary condition: this is invisible until n_memory rivals n_docs. At
that point the scan cost (file 07) is being driven mostly by *memory you may
never recall*, and a long session quietly makes every retrieval slower.

**The write-path embed — the new hop.** Before memory, the embedder was a
read-path cost: embed a document to index it, embed a query to search. Now
`remember` embeds the formatted exchange *on write* (`conversation-memory.ts:
75-76`), one HTTP hop per turn you choose to remember. And it's **not
batched** — it calls `embed([text])` with a single-element array, where
document indexing batches a whole doc's chunks into one call (file **08**). So
a remember-then-recall loop is two embed hops, one of them on the write path,
neither amortized.

### Move 2.5 — current state vs future state

Built-but-deliberately-minimal. The over-fetch and the unbounded growth are
both *first-cut* choices that the contract, not the memory module, forces.

```
  Phase A (here, aptkit)                Phase B (the fix)
  ─────────────────────                 ───────────────────────────
  search(vector, k)  — no filter        search(vector, k, {kind})  — filter
  recall over-fetches max(k*4,20)        store filters server-side, fetch k
  filter + slice in JS                   no client post-filter
  remember appends forever               row cap / TTL / summarization
  embed([one]) per remember              batch deferred remembers
        │                                          │
        └──── same VectorStore seam, one new arg ──┘
              the over-fetch DISAPPEARS the moment the filter pushes down
```

What *doesn't* have to change: the memory module's logic, the tool, the agent.
The amplification is entirely a property of the seam — add a metadata
predicate to `VectorStore.search` (buffr's `where app_id` proves the DB can do
it; it just needs `where meta->>'kind' = $x` too) and `recall` collapses from
"fetch 4×, filter, slice" to "fetch k." The growth fix is orthogonal: a cap,
a TTL, or rolling summarization on the write path.

### Move 3 — the principle

A filter you can't push to the store is a tax you pay on every read. The
amount of the tax is exactly the rows the store scored and shipped so you
could throw them away — here `fetchK − k`, a 4×/≥20 multiplier. The fix is
never "fetch a bit less"; it's "move the filter to the side of the seam that
already has the data," so the store returns k and only k. And anything that
*appends without bound* into a linearly-scanned store turns a flat cost into a
creeping one — bound the growth or the scan grows with your history.

## Primary diagram

The full recap: one recall, the over-fetch tax, the shared growing store, and
the write-path embed, all on top of the file-07 scan.

```
  Memory recall — the full cost picture

  WRITE PATH (remember)                 READ PATH (recall, k)
  ─────────────────────                 ─────────────────────
  embed([text])  ← 1 unbatched hop      embed([query])  ← 1 hop
        │                                     │
        ▼                                     ▼
  upsert(1 row)  ← append-only,         search(vec, max(k*4,20))
  no eviction/TTL                             │   ← over-fetch
        │                                     ▼
        ▼                          ┌─ InMemoryVectorStore (file 07) ─┐
  ┌─ shared store ────────────────►│  O(n·d) scan, n = docs + memory  │
  │  n_memory grows forever        │  score all n, sort, return fetchK│
  └────────────────────────────────└──────────────┬───────────────────┘
                                                   ▼
                                    filter kind==='memory' → slice(k)
                                                   │
                                    fetchK − survivors = scanned & dropped
```

## Implementation in codebase

**Use cases.** `recall` is reached two ways. (1) The `search_memory` tool
(`packages/memory/src/memory-tool.ts:52`) lets an agent explicitly recall past
exchanges when memory lives in a *dedicated* store. (2) When memory *shares*
the document store, the existing `search_knowledge_base` tool surfaces memory
rows alongside documents (no separate tool) — which is exactly the shared-n
case that makes the over-fetch and the unbounded growth bite. `remember` is
called wherever the host decides a turn is worth keeping (no in-repo caller
wires it into an agent loop yet — the package ships the capability and its
tests exercise it: `packages/memory/test/conversation-memory.test.ts`).

```
  packages/memory/src/conversation-memory.ts  (lines 89–106)  — recall

  async recall(query, k = 5) {
    const [vector] = await embedder.embed([query]);    ← read-path embed hop
    if (!vector) return [];
    const fetchK = Math.max(k * 4, 20);                ← THE OVER-FETCH:
    const hits = await store.search(vector, fetchK);   ← scan/sort/ship fetchK
    return hits
      .filter((h) => h.meta?.kind === kind)            ← drop non-memory rows
      .slice(0, k)                                      ← keep first k survivors
      .map(...);                                        ← (fetchK − k) wasted
  }
       │
       └─ fetchK = max(k*4, 20) is forced because store.search takes no
          metadata filter — the kind predicate has to run here, AFTER the
          store already scored and ranked rows it returns only to discard.
```

```
  packages/memory/src/conversation-memory.ts  (lines 74–87)  — remember

  async remember(turn) {
    const text = format(turn);
    const [vector] = await embedder.embed([text]);     ← WRITE-PATH embed hop,
    if (!vector) return;                                  single-element array
    const n = counters.get(turn.conversationId) ?? 0;     = NOT batched
    counters.set(turn.conversationId, n + 1);
    await store.upsert([                               ← append one row;
      { id: `${kind}:${turn.conversationId}:${n}`,        no eviction, no TTL,
        vector, meta: { kind, conversationId, text } },   no summarization
    ]);
  }
       │
       └─ every remember adds exactly one row and nothing removes one, so a
          shared store's n grows without bound over a long history — the n
          that the file-07 scan (and every over-fetched recall) walks.
```

```
  packages/retrieval/src/contracts.ts  (lines 33–37)  — the seam

  export type VectorStore = {
    dimension: number;
    upsert(chunks: VectorChunk[]): Promise<void>;
    search(vector: number[], k: number): Promise<VectorHit[]>;
  };                                          ▲
       │                                      └─ no predicate argument:
       └─ this missing filter param is the ROOT of the over-fetch. With a
          `where`/`filter` here, recall would ask for k and the store would
          return k memory rows — no 4× tax, no client-side discard.
```

The contrast that proves the fix is buildable (in buffr, not this repo):

```
  buffr/src/pg-vector-store.ts  (lines 70–77)  — a filter pushed INTO the scan

  select id, content, ..., 1 - (embedding <=> $1::vector) as score
  from agents.chunks
  where app_id = $2            ← a server-side filter that DOES push down
  order by embedding <=> $1::vector
  limit $3                     ← returns exactly k, no over-fetch
       │
       └─ buffr already filters by app_id at the DB. The same mechanism with
          a `meta->>'kind' = $x` predicate would let memory recall fetch k
          and only k — killing the amplification this file describes. Today
          even buffr lacks the `kind` predicate, so a shared store would
          over-fetch there too.
```

## Elaborate

This is the classic "predicate pushdown" problem from databases, wearing a
vector-search hat. When a filter can be evaluated by the storage layer, you
push it *down* so the engine scans/returns only matching rows; when it can't,
you pull every candidate up and filter in the application — paying for rows you
discard. Vector stores make this sharper because the discarded rows were also
*scored and ranked*, which is the expensive part. The general answer is a
hybrid query: an ANN search *with* a metadata predicate (pgvector supports
`WHERE` alongside the `ORDER BY ... <=>`, with caveats about how the filter
interacts with the HNSW index — that's `study-database-systems` territory).
The unbounded-growth half is the memory-management problem every long-running
agent hits: episodic stores need eviction, TTL, or summarization or they
become the dominant scan cost — the same instinct as bounding turns (file
**01**), applied to stored rows instead of round-trips.

## Interview defense

**Q: `recall` fetches 20 rows to return 5. Why not just fetch 5?**

Because the store shares space with documents and `search` has no metadata
filter — fetch 5 and the top-5 by similarity might be all documents, so recall
returns nothing. The `max(k*4, 20)` over-fetch buys enough headroom that
memory rows survive the client-side `kind` filter. It's a tax forced by the
contract, not a mistake: the real fix is to push the `kind` filter into
`VectorStore.search` so the store returns k memory rows directly.

```
  no filter at the seam          filter pushed down
  fetch max(k*4,20), drop most ► fetch exactly k
  4×/≥20 read amplification      no waste
  the tax                        the fix (one new arg on the contract)
```

Anchor: *over-fetch-then-filter is the price of a filter that lives on the
wrong side of the storage seam.*

**Q: What's the load-bearing line people forget?**

That `remember` is append-only with no eviction (`conversation-memory.ts:
74-87`). The over-fetch multiplier is the visible cost, but the quiet one is
that memory's n grows forever in a linearly-scanned store — so a long
conversation makes *every* retrieval slower, not just memory recall. Bound the
growth (cap/TTL/summarize) or the file-07 scan grows with your history.

## Validate

1. **Reconstruct:** write the recall kernel from memory (over-fetch → filter →
   slice) and state the multiplier. Check against `conversation-memory.ts:
   89-106`.
2. **Explain:** why is `fetchK = max(k*4, 20)` forced rather than chosen? Name
   the exact contract line that makes the `kind` filter un-pushable
   (`contracts.ts:36`).
3. **Apply:** memory shares the document store and a session runs for hours.
   Which two costs climb, and what's the fix for each? (Over-fetch tax → push
   the `kind` filter into `search`; unbounded n → cap/TTL/summarize the memory
   rows.)
4. **Defend:** why is over-fetching the *right* first cut despite the waste?
   (A shared store with no filter could otherwise return zero memory rows; the
   over-fetch guarantees recall isn't silently empty. The cost is real but the
   correctness floor matters more until the contract grows a filter.)

## See also

- **07-linear-vector-scan.md** — the O(n·d) scan this file amplifies; the
  over-fetch enlarges fetchK and the unbounded growth enlarges n.
- **08-embedding-batch-and-topk-floor.md** — the embed call (batched for
  documents) that `remember` un-batches onto the write path; the top-k floor,
  another model/cost knob in the same family.
- **01-turn-and-tool-budget.md** — the same "bound the work" instinct
  (bounded round-trips) that memory growth needs applied to stored rows.
- **audit.md** lens 4 (cpu-memory), lens 5 (io-network), lens 6
  (caching/batching), and red flags #8–#9 — where this sits in the full
  picture.
- **study-database-systems** (buffr) — predicate pushdown and ANN-with-`WHERE`
  mechanics, the indexed contrast to the client-side over-fetch.
