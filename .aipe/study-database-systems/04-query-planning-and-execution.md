# 04 · Query Planning and Execution

**Industry name(s):** query plan, scan/sort operators, N+1, `EXPLAIN`. **Type:** Industry standard.

## Zoom out, then zoom in

You know N+1 from frontend data fetching: render a list, then fire one request per row instead of one batched request. Database query execution is where that pattern is born — and this repo has exactly one query that matters plus one loop that's *almost* an N+1.

```
  Zoom out — where queries execute

  ┌─ Tool layer (aptkit) ──────────────────────────────────┐
  │  search_knowledge_base → pipeline.query(text, fetchK)   │
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Store layer ──────────────▼────────────────────────────┐
  │  InMemory: scan + sort in JS                             │
  │  Postgres: ★ ONE SELECT, planner picks the scan ★        │ ← we are here
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Postgres executor ────────▼────────────────────────────┐
  │  HNSW index scan → filter app_id → limit k               │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **query execution** — the planner turning a SQL string into a sequence of scan/filter/sort/limit operators, and the cost of each. There's also a write-side loop in `upsert` worth examining for N+1 behavior. And there's a notable absence: **no `EXPLAIN` is run anywhere in either repo**, so every claim about the plan is an inference from the SQL, labeled as such.

## The structure pass

**Layers.** Two query shapes execute here: the read path (one `SELECT` per search) and the write path (a loop of `INSERT`s per document). The planner only gets involved on the Postgres side; aptkit's "plan" is hand-written JS.

**Axis — trace "how many round trips / passes does this take?" across read and write:**

```
  One question across the paths: "how many operations per logical request?"

  READ (search one query)
  ┌─ InMemory ──────────┐  → 1 pass: scan n, sort n, slice k
  ┌─ Postgres ──────────┐  → 1 SQL statement: HNSW scan → filter → limit

  WRITE (index one document of m chunks)
  ┌─ InMemory ──────────┐  → 1 batch upsert call, m Map.set in a loop
  ┌─ Postgres ──────────┐  → m INSERTs in ONE transaction (m round trips, 1 commit)
```

**Seam.** The boundary is the single `store.search`/`store.upsert` call. The read is genuinely one query — clean. The write is the interesting seam: `upsert` takes a *batch* of chunks but executes them as *m separate `INSERT` statements* in a loop over one transaction. That's the N+1 boundary — batched at the contract, per-row at execution.

## How it works

### Move 1 — the mental model

A query plan is a pipeline of operators, the same shape as a stream you chain `.filter().sort().slice()` on — except the planner decides the *order* and *which index* feeds the front. For the search, the plan is: HNSW index scan → filter by app_id → limit k. The art is that the planner could run the filter before or after the scan, and that choice is the whole ballgame for filtered vector search.

```
  The search plan — operators, top of pipe to bottom

   ORDER BY embedding <=> $query     ┌─ HNSW index scan ──┐  candidate vectors
            │                        │ (approximate NN)   │  nearest-first
            ▼                        └─────────┬──────────┘
   WHERE app_id = $app   ───────────►  filter app_id      │  drop wrong tenant
            │                                  ▼
   LIMIT k               ───────────►  limit k             │  stop at k
            │                                  ▼
        results ◄────────── rebuild meta for citations ───┘
```

The kernel: **the index feeds the pipe, the filter trims it, the limit stops it.** Get the order wrong (filter after a too-small HNSW candidate set) and you under-return.

### Move 2 — the walkthrough

**The read path — one query, inferred plan.** The search is a single statement:

```ts
// buffr/src/pg-vector-store.ts:70-77
`select id, content, chunk_index, document_id, meta,
        1 - (embedding <=> $1::vector) as score
 from agents.chunks
 where app_id = $2
 order by embedding <=> $1::vector
 limit $3`
```

The plan the planner *should* pick (inference — no `EXPLAIN` run): an **HNSW index scan** on `embedding` driven by the `order by ... <=> ...`, producing candidates nearest-first, with the `app_id = $2` predicate applied as a filter, cut off at `limit $3`. Because the `order by` and `limit` together are exactly the shape pgvector's HNSW index serves, this should be an index scan, not a sequential scan + sort. But "should" is doing work — nobody has confirmed it. The risk: if the planner *doesn't* use HNSW (stale stats, a predicate it can't push down), this silently becomes a **sequential scan computing `<=>` against every row then sorting** — the in-memory store's O(n) behavior, but on disk. You'd only catch it with `EXPLAIN ANALYZE`, which is **`not yet exercised`**.

**The score arithmetic happens in the SELECT.** `1 - (embedding <=> $1::vector) as score` — `<=>` is cosine *distance* (0 = identical, 2 = opposite), and the code converts it to a similarity *score* in the projection so it matches the in-memory store's `cosineSimilarity` semantics (`buffr/src/pg-vector-store.ts:69` comment). The `order by` uses raw distance (ascending = nearest first); the score is computed only for the returned rows. That's efficient — distance for ordering, similarity for the caller.

**The write path — the almost-N+1.** `upsert` takes a batch but loops:

```ts
// buffr/src/pg-vector-store.ts:40-58
await client.query('begin');
for (const c of chunks) {                              // m chunks → m round trips
  ...
  await client.query(
    `insert into agents.chunks (...) values ($1,...,$6::vector,...)
     on conflict (id) do update set ...`,              // one statement PER chunk
    [...],
  );
}
await client.query('commit');                          // ONE commit for all m
```

This is the N+1 shape: the contract hands over a batch of m chunks, but execution fires m separate `INSERT` statements — m network round trips to Postgres. It's *not* a true N+1 disaster because (a) it's all inside one transaction with one commit/fsync, and (b) each insert is a cheap PK-keyed upsert. But a 50-chunk document is 50 round trips that a single multi-row `INSERT ... VALUES (...),(...),(...)` could collapse into one. The fix is a known pattern (multi-row insert or `unnest`); it's just not done. The HNSW index-maintenance cost (see 03) is paid per insert regardless, so collapsing the round trips helps network latency, not index cost.

**The in-memory "execution" — handwritten plan.** aptkit's read is the plan, in code:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:27-33
for (const chunk of this.chunks.values())          // SCAN (sequential, always)
  hits.push({ id, score: cosineSimilarity(...), meta });
hits.sort((a, b) => b.score - a.score);            // SORT (full, every query)
return hits.slice(0, Math.max(0, k));              // LIMIT
```

Scan → sort → limit, no index, no planner — it's what the Postgres path collapses to if HNSW *isn't* chosen. Reading these two side by side is the lesson: the index is the only thing standing between the cloud path and the in-memory path's O(n) cost.

**The tool-layer over-fetch — execution above the store.** When the search tool applies a metadata filter, it over-fetches at the *tool* layer, not in SQL:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:87-90
const fetchK = filter ? topK * 4 : topK;           // over-fetch 4x when filtering
let hits = await pipeline.query(query, fetchK);
if (filter) hits = hits.filter((hit) => matchesFilter(hit, filter)).slice(0, topK);
```

This mirrors the filtered-ANN problem one layer up: because the store can't filter by arbitrary metadata, the tool asks for 4× and trims in JS. Same shape as memory's `recall` (`conversation-memory.ts`: `fetchK = max(k*4, 20)`). The execution strategy for "filter an ANN result" is consistently *over-fetch then filter in application code* — a real, if blunt, plan.

### Move 3 — the principle

Query execution is operator ordering, and the order that wins for vector search is index-scan-first, filter-second, limit-third. Two recurring traps live here: a missing/unused index silently degrades the plan to a full scan + sort (and without `EXPLAIN` you won't see it), and a batched API can hide a per-row N+1 at execution. The general lesson: the SQL string is a *request*, not a plan — until you read `EXPLAIN`, you're guessing how it runs.

## Primary diagram

```
  Full execution picture — read plan, write loop, in-memory control

  READ (buffr)                          WRITE (buffr)              READ (aptkit control)
  ┌─ HNSW index scan ─┐                 ┌─ begin ──────────┐       ┌─ for each chunk ─┐
  │ order by <=> $vec │ inferred,       │ for c in chunks: │       │  cosine + push   │ O(n)
  └────────┬──────────┘ NOT verified    │   INSERT (1 RTT) │ N+1   └────────┬─────────┘
  ┌────────▼──────────┐                 │   ON CONFLICT    │ shape ┌────────▼─────────┐
  │ filter app_id     │                 │ ... (m times)    │       │ sort all         │ O(n log n)
  └────────┬──────────┘                 │ commit (1 fsync) │       └────────┬─────────┘
  ┌────────▼──────────┐                 └──────────────────┘       ┌────────▼─────────┐
  │ limit k           │                  no EXPLAIN run anywhere    │ slice k          │
  └───────────────────┘                                            └──────────────────┘
```

## Elaborate

`EXPLAIN (ANALYZE, BUFFERS)` is the single highest-value diagnostic missing from buffr — it would confirm whether HNSW is actually chosen, reveal the filtered-ANN behavior with `app_id`, and quantify the TOAST/buffer reads from the fat embedding rows (02). The N+1 write loop is a textbook batching opportunity: pgvector and node-postgres both support multi-row inserts, and collapsing 50 round trips to 1 is a clean win once profiling shows it matters. Neither is urgent on a single-tenant laptop with a small corpus — which is exactly why they're `not yet exercised` rather than bugs. Read next: 05 for the transaction that wraps the write loop, 09 for these risks ranked.

## Interview defense

**Q: Your upsert takes a batch. How does it actually execute?**

```
  contract: upsert([c1..cm])   ← batched API
        │
        ▼ execution
  begin → INSERT c1 → INSERT c2 → ... → INSERT cm → commit
          └──── m round trips, 1 commit ────┘   ← N+1 shape
```

Answer: "It's a batched API hiding a per-row execution. The loop fires m separate `INSERT ... ON CONFLICT` statements inside one transaction (`pg-vector-store.ts:43-57`) — m round trips, one commit. It's not a catastrophic N+1 because it's one transaction with one fsync and each insert is a cheap PK upsert, but a 50-chunk doc is 50 round trips a single multi-row INSERT would collapse. We haven't done it because the corpus is small." Anchor: *batched contract, per-row execution — the classic N+1 boundary.*

**Q: How do you know the search uses the HNSW index?**

Answer: "I don't — and that's the honest answer. The `order by embedding <=> $1 limit k` shape is exactly what HNSW serves, so the planner *should* pick an index scan. But no `EXPLAIN ANALYZE` has been run, so it could be silently falling back to a sequential scan + sort, which is the in-memory store's O(n) behavior on disk. The first thing I'd do in production is run `EXPLAIN (ANALYZE, BUFFERS)` on that query." Anchor: *the SQL is a request; EXPLAIN is the only proof of the plan.*

## See also

- `03-btree-hash-and-secondary-indexes.md` — the HNSW index this plan relies on.
- `05-transactions-isolation-and-anomalies.md` — the transaction wrapping the write loop.
- `02-records-pages-and-storage-layout.md` — the pages a sequential-scan fallback would read.
- study-performance-engineering — measuring the N+1 and the missing `EXPLAIN`.
