# Over-fetch then filter

**Industry name:** over-fetch-and-post-filter (vs predicate pushdown) · **Type:** Industry standard

The pattern both the knowledge-base search and memory recall use to filter results the store can't filter for them — pull a wider page, then drop the misses in JS — and why that wastes work the moment the store is a real database.

---

## Zoom out, then zoom in

The `VectorStore` contract ranks by similarity and returns top-`k`. It has **no metadata predicate** — you cannot ask it "top-k *where kind = memory*." So any caller that needs a filtered top-`k` has to fetch more than `k` and filter the surplus itself.

```
  Zoom out — where the post-filter lives

  ┌─ Consumer layer ──────────────────────────────────────────┐
  │  search_knowledge_base tool   /   memory.recall()          │ ← we are here
  │     want: top-k WHERE meta matches                         │
  └───────────────────────────┬───────────────────────────────┘
                              │ VectorStore.search(vector, k)  — NO predicate
  ┌─ Store layer ─────────────▼───────────────────────────────┐
  │  InMemoryVectorStore (in-process)  |  PgVectorStore (DB)   │
  │  returns ranked top-k, metadata-blind                      │
  └────────────────────────────────────────────────────────────┘
```

Because the contract can't filter, the consumer over-fetches (`k * 4`) and post-filters. In-process that is a JS array op — cheap. Against `PgVectorStore` those surplus rows cross the database boundary only to be thrown away — the cost the pattern hides.

## The structure pass

Trace **the cost axis — "where does the filter run, and what does it cost?"** across the contract seam.

```
  Axis: "where is the filter applied?" — across the VectorStore seam

  ┌─ consumer ───────────────────┐  seam   ┌─ store ──────────────────────┐
  │ over-fetch k*4                │ ══╪══►  │ ranks k*4, returns ALL of them│
  │ filter in JS, slice to k      │ (flips) │ (no predicate to push down)   │
  │ cost: k*4 rows materialized   │         │ in-mem: free                  │
  │        + 4× work upstream     │         │ Postgres: 4× rows over the wire│
  └───────────────────────────────┘         └──────────────────────────────┘
```

- **Layers:** consumer (wants filtered top-k) → contract (no predicate) → store (ranks, blind to meta).
- **Axis:** where the filter runs. The contract forces it *above* the store, in the consumer's process.
- **Seam:** `VectorStore.search`. The missing predicate is the load-bearing absence — it pushes the filter to the wrong side of the boundary, and against a DB that means surplus rows crossing the wire.

## How it works

#### Move 1 — the mental model

You know the difference between `SELECT * ... LIMIT 100` then filtering in your app, versus `SELECT * WHERE x = 'y' LIMIT 25` letting the database filter. The first pulls rows you don't want across the wire; the second pushes the predicate down to where the data lives. This repo is forced into the first shape because the `VectorStore` contract has no `WHERE`.

```
  Pattern — over-fetch vs predicate pushdown

  OVER-FETCH (what the repo does):        PUSHDOWN (what a predicate would allow):

   want k=5 of kind=memory                 want k=5 of kind=memory
        │ ask store for k*4 = 20            │ ask store: top-5 WHERE kind=memory
        ▼                                    ▼
   [20 ranked rows, mixed kinds]            [5 ranked memory rows]
        │ filter kind=memory in JS          (store did the filtering)
        │ slice to 5
        ▼
   ≤5 rows  (15 fetched-then-discarded)
```

#### Move 2 — the step-by-step walkthrough

**Case 1 — `search_knowledge_base` over-fetches only when filtering.** The tool exposes an optional metadata `filter`. When present, it fetches `4×` and post-filters; when absent, it fetches exactly `topK`:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:87-90
// Over-fetch when filtering so the post-filter can still return up to topK.
const fetchK = filter ? topK * 4 : topK;            // ← 4× only on the filtered path
let hits = await pipeline.query(query, fetchK);
if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
```

The `4×` multiplier is a guess at how many ranked hits you must scan to still find `topK` that pass the filter. Too small and the filtered result comes up short; too large and you waste more work. There is no baseline tuning it — `4` is a hardcoded heuristic (`audit.md` Lens 5). And `matchesFilter` (line 101-106) is deliberately lenient: a filter key absent from a chunk's meta is *ignored*, so a weak model's hallucinated filter can't wipe every result — a correctness guard that also means the filter does less narrowing than it looks like.

**Case 2 — memory `recall` always over-fetches.** Memory rows share a store with documents, tagged `meta.kind: 'memory'`. To recall *only* memory, `recall` must over-fetch past the documents that rank above memory rows, then filter by `kind`:

```ts
// packages/memory/src/conversation-memory.ts:92-99
// Over-fetch then filter: a shared store may return documents above memory,
// and search itself cannot filter by metadata.
const fetchK = Math.max(k * 4, 20);                 // ← at least 20, or 4× k
const hits = await store.search(vector, fetchK);
return hits
  .filter((h: VectorHit) => h.meta?.kind === kind)  // ← keep only memory rows
  .slice(0, k)
  .map((h) => ({ id: h.id, score: h.score, text: ..., conversationId: ... }));
```

Here over-fetch is unconditional, with a floor of 20. The reasoning is in the comment: in a shared store, documents can rank above memory rows for a given query, so you must pull a wide enough page that `k` memory rows survive the filter. The `kind` tag is a logical partition over one physical collection — and the partition is enforced *after* the fetch, not during it.

**Where it breaks — against `PgVectorStore`.** In-process, over-fetching 20 rows and filtering in JS is a trivial array op. But the durable store is buffr's `PgVectorStore`, and its `search` is a SQL `order by embedding <=> $1 limit $3` (`buffr/src/pg-vector-store.ts:70-78`). Over-fetching `k*4` there means the database ranks and serializes `4×` rows and ships them over the wire, only for JS to discard most. Postgres can filter on `meta` — `agents.chunks` stores `meta` as a column (`buffr/sql/001_agents_schema.sql`) — so a `where meta->>'kind' = 'memory'` would push the predicate down and the `limit k` would return exactly `k` already-filtered rows. The over-fetch is a workaround for a contract gap, and the gap costs real rows-over-the-wire the moment the store is a database. It is unmeasured (`audit.md` red flag #4) — at demo scale it is invisible; it becomes a real cost at corpus scale.

#### Move 2.5 — the fix the contract gap implies

This is the one pattern in the guide whose fix changes a *contract*, so it is worth naming what closing it costs:

```
  Now (no predicate):                     With a predicate in the contract:
  search(vector, k)                       search(vector, k, filter?)
    consumer over-fetches k*4               store pushes filter down
    filters in JS                           (SQL WHERE for Pg, .filter for in-mem)
    Pg: 4× rows over the wire               Pg: exactly k filtered rows
    ── works, wastes ──                     ── needs contract change ──
```

The catch: `VectorStore` is a load-bearing published contract (`@rlynjb/aptkit-core`, and buffr's `PgVectorStore` implements it). Adding a `filter` arg ripples to every implementation and the published surface. That is *why* the over-fetch exists — it kept the contract minimal at the cost of pushing the filter to the consumer. A deliberate tradeoff, not an oversight, and reversible when the cost is measured to matter.

#### Move 3 — the principle

When a store can't filter, the caller over-fetches and filters above it — and that is fine until the store is a database, where every over-fetched row is bytes over the wire you paid to discard. The pattern is a contract-shaped tradeoff: a minimal `search(vector, k)` interface is simpler and kept the published surface small, but it forces the filter to the wrong side of the boundary. Naming that the metadata predicate belongs *in the store* (pushdown) is the lesson — the repo chose the simpler contract knowingly.

## Primary diagram

```
  Over-fetch then filter — full picture

  ┌─ Consumers ───────────────────────────────────────────────────┐
  │  search_knowledge_base: fetchK = filter ? topK*4 : topK         │
  │  memory.recall:         fetchK = max(k*4, 20)                   │
  └───────────────────────────┬────────────────────────────────────┘
                              │ VectorStore.search(vector, fetchK)  — NO predicate
        ┌──────────────────────┴──────────────────────┐
  ┌─ InMemoryVectorStore ────────┐   ┌─ PgVectorStore (buffr) ──────────┐
  │ ranks fetchK, returns all     │   │ order by <=> limit fetchK         │
  │ JS .filter → slice(k)         │   │ ships fetchK rows over the wire   │
  │ cost: array op (free)         │   │ JS .filter → slice(k)             │
  │                               │   │ cost: 4× rows over wire, discarded│
  └───────────────────────────────┘   │ FIX: WHERE meta->>'kind' pushdown │
                                       └────────────────────────────────────┘
```

## Elaborate

Predicate pushdown — filtering as close to the data as possible — is one of the oldest performance principles in data systems, and over-fetch-and-post-filter is its anti-pattern, tolerable only when the data is already local. aptkit lands on the anti-pattern by *contract choice*: keeping `VectorStore` to `search(vector, k)` made it trivially implementable (the in-memory scan, the one-query Pg adapter) and kept the published API small, at the cost of pushing metadata filtering up to consumers. The cost is dormant in-process and real against Postgres — exactly the kind of thing that should be measured before the contract is changed, because the contract change is not free (it is a published, load-bearing interface). This is the cleanest example in the repo of a performance cost that is a *design tradeoff*, not a bug.

## Interview defense

**Q: Your memory recall over-fetches `k*4` rows then filters in JS. Why not filter in the store?**
Because the `VectorStore` contract has no metadata predicate — `search(vector, k)` ranks by similarity and is blind to `meta`. Memory and documents share one store partitioned by a `kind` tag, so recall pulls a wider page and filters by `kind` after. In-process that's a free array op. Against `PgVectorStore` it's `4×` rows over the wire I paid to discard — and Postgres *could* push the filter down with `WHERE meta->>'kind'`.

```
  search(vector, k*4) → [mixed rows] → JS filter kind → slice k
       (no WHERE)         4× over the wire on Pg
```
Anchor: "no predicate in the contract, so the filter runs on the wrong side of the boundary."

**Q: So why not just add the predicate?**
Because `VectorStore` is a published, load-bearing contract — buffr's `PgVectorStore` implements it and it's part of `@rlynjb/aptkit-core`. Adding a `filter` arg ripples to every implementation and the public surface. The over-fetch kept the contract minimal on purpose; I'd measure the row-over-wire cost against a real corpus before paying the contract change.

Anchor: "minimal contract bought simplicity; the over-fetch is the deliberate cost of that."

## See also

- `01-linear-scan-vs-ann-tradeoff.md` — the same `VectorStore` seam, the ranking side
- `04-embedding-batching.md` — the other per-query cost on the retrieval path
- `audit.md` — Lens 5 (DB bottlenecks), Lens 6 (batching/caching), Lens 8 (red flag #4)
- `study-database-systems` — predicate pushdown, pgvector `WHERE` + index interaction
