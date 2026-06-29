# Over-fetch then filter

*Industry names: over-fetch-and-prune / client-side post-filtering / fetch
amplification. Type: Project-specific (forced by a contract gap).*

## Zoom out, then zoom in

The `VectorStore` contract has a deliberate hole: `search(vector, k)` ranks by
similarity but has **no metadata predicate** — you can't say "search, but only
memory rows" or "only docs from this source." The question this file answers:
**when a caller needs a filtered result, how does the repo get it from a
contract that can't filter — and what does that cost?** The answer: fetch more
than you need (`topK * 4`), then drop the non-matches in JS.

```
  Zoom out — where the over-fetch happens

  ┌─ Tool / Memory layer ───────────────────────────────────────┐
  │  search_knowledge_base(filter) · memory.recall(query)        │
  │     fetchK = topK*4  →  filter in JS  →  slice(topK)         │
  │                          ★ THIS CONCEPT ★                    │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  search(vector, fetchK)  ← can't filter
  ┌─ VectorStore contract ▼───────────────────────────────────────┐
  │  search(vector, k): VectorHit[]   — NO metadata predicate     │
  └───────────────────────────────────────────────────────────────┘

  the contract gap (no where-clause) is paid for above it: over-fetch a wider
  net, then prune. wasteful vs a SQL filter — and the waste grows with selectivity.
```

The pattern: **compensate for a missing query capability by widening the fetch
and filtering in application code.** It works, it's honest about *why* it exists
(the contract is vendor-neutral and the in-memory store has no index to filter
on), and it carries a real cost that grows precisely when the filter is most
selective.

## The structure pass

Trace the **cost** axis (work per result kept) across the contract seam.

```
  One axis (wasted work) across the filter seam

  ┌─ caller wants topK filtered ─┐  seam   ┌─ store returns ranked ─┐
  │ asks for topK*4 (over-fetch) │ ══════► │ scans/walks for 4×topK  │
  │ filters in JS, keeps ≤ topK  │         │ knows nothing of filter │
  └──────────────────────────────┘         └─────────────────────────┘
        discards up to 3×topK                  did 4× the ranking work
              (the waste)
```

- **Layers:** caller (wants filtered top-k) over store (ranks, can't filter).
- **Axis:** wasted work — results fetched but discarded.
- **Seam:** the `search(vector, k)` signature with no filter argument. The
  axis-answer (how much work is wasted) is *created* by this seam: a richer
  contract with a predicate would push the filter down and waste nothing.

## How it works

#### Move 1 — the mental model

You know the N+1 / over-fetch problem in a frontend data layer — you `GET
/posts` then filter client-side because the API has no `?author=` param, pulling
rows you immediately throw away? This is that, applied to vector search: no
filter param on `search`, so you pull a wider window and prune.

```
  Pattern — widen the net, prune the catch

  want: top 5 rows where kind=memory

  fetch 20 (= 5×4)  →  [d d m d m d d m d m …]   ← d=doc, m=memory
        │                filter kind==memory
        ▼                       │
  [m m m m m …]  →  slice(5)  →  [m m m m m]
   kept 5, fetched 20, ranked 20 — 15 discarded
```

#### Move 2 — the step-by-step walkthrough

**Case 1 — the search tool's metadata filter.** When the model passes a
`filter` arg, `search_knowledge_base` over-fetches 4× then prunes —
`search-knowledge-base-tool.ts:87-90`:

```ts
// Over-fetch when filtering so the post-filter can still return up to topK.
const fetchK = filter ? topK * 4 : topK;        // ← 4× wider net only when filtering
let hits = await pipeline.query(query, fetchK);
if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
```

The `topK * 4` is a heuristic guess that "4× the window will contain at least
topK matches after pruning." It's not guaranteed — a filter selective enough
that fewer than 1-in-4 hits match will return *fewer* than topK even though
matching rows exist further down the ranking. That's the silent failure mode of
over-fetch-and-prune: the prune can starve the result.

`matchesFilter` (`:101-106`) is itself perf-and-robustness aware:

```ts
return Object.entries(filter).every(([key, value]) =>
  !(key in hit.meta) || hit.meta[key] === value);   // absent key = pass, not fail
```

A filter key only *excludes* a hit that has that key with a different value;
keys absent from a chunk's meta are ignored. That stops a weak local model's
hallucinated filter (e.g. `{textContains: "x"}`) from wiping every result — a
correctness guard, but it also means the filter is permissive, so the 4×
over-fetch is doing double duty against both selectivity and hallucination.

**Case 2 — memory recall, the same shape.** `conversation-memory.ts:92-96`:

```ts
// Over-fetch then filter: a shared store may return documents above memory,
// and search itself cannot filter by metadata.
const fetchK = Math.max(k * 4, 20);             // ← 4×, floored at 20
const hits = await store.search(vector, fetchK);
return hits.filter((h) => h.meta?.kind === kind).slice(0, k) ...
```

Here the filter is the `kind: 'memory'` tag — because memory rows can share a
store with document rows (the project context's "memory reuses the retrieval
contracts" design). When they share, a recall query ranks *documents and memory
together*, and the documents that rank above memory are fetched only to be
discarded. The `Math.max(k*4, 20)` floor admits the cost: at small k, 4× isn't a
wide enough net, so it forces at least 20.

**The boundary condition — cost scales inversely with what you want.** The more
selective the filter (the rarer the matching rows), the more the 4× over-fetch
under-delivers, and the more ranking work is wasted per result kept. On the
in-memory store, `fetchK` doesn't change the scan cost (it scans all n
regardless — see `02-linear-scan-vs-ann-tradeoff.md`), it only changes how many
hits get materialized and sorted-through. On `PgVectorStore`, a larger `limit`
*does* make the HNSW walk work harder. So the waste is real on both sides,
worst where the filter is most selective.

```
  Layers-and-hops — the discarded work, shared-store recall

  ┌─ Memory.recall ─┐ hop 1: search(vec, k*4≥20)  ┌─ shared VectorStore ─┐
  │ wants k memory  │ ───────────────────────────► │ ranks docs+memory    │
  │ rows            │ hop 2: 20 mixed hits ◄─────── │ together, no filter  │
  └────────┬────────┘                               └──────────────────────┘
           │ filter kind==memory → keep ≤ k
           ▼  discarded the doc hits that outranked memory  ← the waste
```

#### Move 2 variant — the load-bearing skeleton

The kernel: **(1) a fetch window wider than the desired result, (2) an
application-side predicate, (3) a slice back down to the desired count.**

- Drop the widening → you fetch exactly topK, the filter prunes some, you return
  *fewer than topK* — the result is starved.
- Drop the predicate → you return unfiltered results (docs mixed into memory
  recall; ignored hallucinated filters become no-ops anyway).
- Drop the slice → you return the whole over-fetched window, blowing the caller's
  topK contract and the token budget downstream.

The *real* fix isn't hardening this pattern — it's removing the need for it: a
`VectorStore.search(vector, k, filter)` predicate pushed down to the store
(trivial as a SQL `where` on `PgVectorStore`, harder on the in-memory store
which would still scan). The over-fetch is a workaround for a contract gap, and
naming it as such is the lesson.

#### Move 3 — the principle

When the data layer can't express your filter, you pay for it above the data
layer — and over-fetch-and-prune is the cheapest workaround that still works,
with a cost that's worst exactly when the filter matters most. The
generalizable rule: **push filters down to where the data lives; every predicate
you evaluate in application code is rows you fetched, ranked, and threw away.**
The deeper tension here is deliberate: the `VectorStore` contract stays
vendor-neutral and predicate-free *on purpose* (so in-memory and pgvector share
one shape), and the price of that neutrality is this over-fetch. That's a real
tradeoff, owned — not a mistake.

## Primary diagram

```
  Over-fetch then filter — paying for a missing predicate

  ┌─ Caller layer ──────────────────────────────────────────────┐
  │  search_knowledge_base(filter)  /  memory.recall(query, k)   │
  │    fetchK = topK*4   (recall: max(k*4, 20))                  │
  │    hits.filter(predicate).slice(topK)                       │
  │       └ discards up to 3×topK ranked-but-unwanted hits      │
  └───────────────────────────┬──────────────────────────────────┘
                              │  search(vector, fetchK)  — NO filter arg
  ┌─ VectorStore contract ▼───────────────────────────────────────┐
  │  ranks fetchK by cosine · knows nothing of the predicate       │
  │  in-memory: scans all n anyway · pgvector: bigger limit = more │
  └───────────────────────────────────────────────────────────────┘
    cost grows with filter selectivity · fix = push predicate down (SQL where)
```

## Elaborate

Over-fetch-and-prune is the same shape as GraphQL over-fetching or a REST
endpoint with no query params — the consumer compensates for an under-expressive
interface. It's everywhere in retrieval systems specifically because the
vendor-neutral vector-store interface (the thing that lets you swap pgvector for
Pinecone for in-memory) tends to be minimal: similarity + k, nothing else. The
moment you need hybrid search (vector + metadata), you either widen the
interface (and lose some portability) or over-fetch (and pay the waste). aptkit
chose portability. The clean upgrade path, when buffr's `PgVectorStore` is the
store, is to extend the contract with an optional predicate that compiles to a
SQL `where` — then over-fetch only on stores that genuinely can't filter. Read
next: `02-linear-scan-vs-ann-tradeoff.md` (the scan this over-fetches from) and
`04-embedding-batching.md` (the cost on the index side).

## Interview defense

**Q: Your search over-fetches `topK*4` then filters in JS. Why not filter in the
store?**

Verdict first: because the `VectorStore` contract is deliberately predicate-free
to stay vendor-neutral — one shape for in-memory and pgvector — so a filtered
query can't push the predicate down, and over-fetch-and-prune is the workaround.
The detail: fetch 4× the window, filter on metadata, slice back to topK. The
honest cost: it's wasted ranking work that's worst when the filter is most
selective, and it can *starve* the result — a filter where fewer than 1-in-4
hits match returns fewer than topK even though matches exist deeper. The fix
isn't to tune the 4× — it's to extend the contract with an optional predicate
that compiles to a SQL `where` on pgvector.

```
  sketch while you talk:

  want topK filtered → fetch topK*4 → filter(meta) → slice(topK)
        └ no predicate on search() ┘    └ JS prune, discards 3×topK ┘
  fix:  search(vec, k, filter) → SQL where → zero waste on pg
```

One-line anchor: *"every predicate I evaluate in app code is rows I fetched,
ranked, and threw away — push the filter to where the data lives."*

**Q: Is the 4× safe?**

It's a heuristic, not a guarantee — that's the bug-shaped part. A selective
enough filter under-delivers. Nobody's measured the actual match rate against
the corpus, so the 4× is a guess that happens to be fine for the demo. The
right move at scale is the pushed-down predicate, not a bigger multiplier.

## See also

- `audit.md` — lens 6 (caching/batching/backpressure), red-flag #5.
- `02-linear-scan-vs-ann-tradeoff.md` — the scan the over-fetch reads from.
- Cross-guide: `study-database-systems` (pushing predicates into the query),
  `study-ai-engineering` (hybrid vector+metadata retrieval).
