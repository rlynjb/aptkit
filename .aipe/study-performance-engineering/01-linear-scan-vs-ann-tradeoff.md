# Linear scan vs approximate-nearest-neighbor

**Industry name:** exact (brute-force) k-NN vs approximate-nearest-neighbor (ANN) search · **Type:** Industry standard

The two ways to answer "which vectors are closest to this query vector," and the seam in this repo that lets you swap one for the other without touching anything above it.

---

## Zoom out, then zoom in

The retrieval pipeline has one job at query time: take a 768-float query vector and return the `k` chunks whose vectors point most nearly the same direction. Where that ranking *happens* is the whole performance story.

```
  Zoom out — where the ranking lives

  ┌─ Agent layer ─────────────────────────────────────────────┐
  │  runAgentLoop → search_knowledge_base tool                 │
  └───────────────────────────┬───────────────────────────────┘
                              │ pipeline.query(q, k)
  ┌─ Retrieval layer ─────────▼───────────────────────────────┐
  │  embed(query) → ★ store.search(vector, k) ★               │ ← we are here
  └───────────────────────────┬───────────────────────────────┘
                              │ VectorStore contract (the seam)
        ┌──────────────────────┴──────────────────────┐
  ┌─ in-process ──────────┐              ┌─ Postgres (buffr) ──────┐
  │ InMemoryVectorStore   │              │ PgVectorStore           │
  │ LINEAR SCAN: O(n·d)   │              │ HNSW index: sub-linear  │
  │ + full sort O(n log n)│              │ order by <=> limit k    │
  └───────────────────────┘              └─────────────────────────┘
```

Same `VectorStore` contract, two implementations. The in-process one (`InMemoryVectorStore`) scores every chunk and sorts the lot — exact, simple, O(n). The Postgres one (`PgVectorStore` in buffr) hands the work to an approximate-nearest-neighbor index (the HNSW index) that walks a graph instead of the whole array — approximate, sub-linear. The pattern is: build with the exact scan because it is trivially correct and needs zero infrastructure, then drop in the ANN index behind the same contract when `n` outgrows the scan.

## The structure pass

Trace **one axis — cost per query — across the seam**, and watch it flip.

```
  Axis: "what does one query cost?" — across the VectorStore seam

  ┌─ above the seam ─────────────┐  seam   ┌─ below the seam ────────────┐
  │ store.search(vector, k)      │ ════╪══► │ same call signature          │
  │ caller cannot tell which     │ (flips) │                              │
  │ implementation answers       │         │                              │
  └──────────────────────────────┘         └──────────────────────────────┘
        InMemoryVectorStore                       PgVectorStore (buffr)
        cost = O(n·d + n log n)                   cost = O(log n) graph walk
        n grows → linear slowdown                 n grows → barely moves
```

- **Layers:** agent → retrieval pipeline → `VectorStore` implementation. One contract, two bodies.
- **Axis traced:** cost-per-query. Above the seam it is invisible (the caller just awaits `search`). Below the seam it flips from O(n) to O(log n).
- **Seam:** the `VectorStore` interface (`packages/retrieval/src/contracts.ts`). It is load-bearing because the cost axis flips across it while the call signature does not — exactly the property that makes the swap a config change, not a rewrite.

## How it works

#### Move 1 — the mental model

You already know the shape from a `.filter().sort().slice()` over an array — score everything, sort by score, take the top `k`. The exact scan *is* that, with cosine similarity as the score function. The ANN index is the optimization you reach for when "score everything" stops being affordable: instead of touching all `n`, walk a graph that gets you near the top `k` while touching only ~log `n` nodes.

```
  Pattern — exact scan vs graph walk for top-k

  EXACT (InMemoryVectorStore):        ANN / HNSW (PgVectorStore):

   query ●                              query ●
     │ score ALL n                        │ enter graph at one node
     ▼                                     ▼
   [c0 c1 c2 ... c(n-1)]   ← touch all   ◌─◌─◌      greedily hop toward
     │ sort by score                      │╲  ╲     closer neighbors,
     ▼                                     ◌  ◌─◌    touching ~log n nodes
   take top k                              ▼
                                          top k (approximate)
   touches n, sorts n                     touches ~log n, no full sort
```

The price of the graph walk is that it is *approximate*: it can miss a true top-`k` neighbor that the exact scan would have found. That recall loss is the tradeoff you buy sub-linear latency with — and it is tunable (the `ef` knob below).

#### Move 2 — the step-by-step walkthrough

**The exact scan — score all, sort all, slice k.** This is the in-process implementation, and it is worth reading line by line because every cost on the cost axis is visible in eight lines.

```ts
// packages/retrieval/src/in-memory-vector-store.ts:25-33
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');     // O(1) guard
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {        // ← iterate ALL n chunks
    hits.push({ id: chunk.id,
      score: cosineSimilarity(vector, chunk.vector), //   each score is a d-element loop (d=768)
      meta: chunk.meta });                            //   one object allocated PER chunk
  }
  hits.sort((a, b) => b.score - a.score);            // ← full sort, O(n log n)
  return hits.slice(0, Math.max(0, k));              //   then throw away all but k
}
```

Three costs stacked: the `for` loop is O(n·d) (n chunks × 768-element cosine, `cosineSimilarity` at line 46-57), the `sort` is O(n log n) over the whole array, and you allocate `n` hit objects only to discard `n − k` of them. Nothing here is wrong — it is *exactly* correct, returns the true top `k` every time, and needs no index, no extra structure, no build step. That correctness-for-free is why it is the right thing to build first.

**Where it breaks:** the cost is linear in corpus size. At 50 demo chunks it is microseconds. At 500,000 it is a synchronous CPU stall on every query — and note the signature is `async` but the body is fully synchronous, so that stall blocks the event loop (a `study-runtime-systems` concern). The scan does not get *wrong*, it gets *slow*, and it gets slow in proportion to how much you indexed.

**The ANN drop-in — same contract, the index does the work.** In buffr, `PgVectorStore` implements the identical `VectorStore` interface, but `search` is a SQL query, and the ranking is done by the HNSW index in Postgres:

```sql
-- buffr/src/pg-vector-store.ts:70-78  (search body)
select id, content, chunk_index, document_id, meta,
       1 - (embedding <=> $1::vector) as score   -- <=> is cosine DISTANCE; score = 1 - distance
from agents.chunks
where app_id = $2
order by embedding <=> $1::vector                 -- HNSW index serves this ORDER BY
limit $3                                           -- ...returning only k without a full scan
```

The index that makes the `order by ... limit` sub-linear is declared once at migration time:

```sql
-- buffr/sql/001_agents_schema.sql:28-29
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
```

`using hnsw` is the whole difference. Without it, Postgres would do its own sequential scan — the same O(n) you just left. With it, the planner walks the proximity graph for the `order by embedding <=> $1` and reads only the rows it needs to satisfy `limit k`. The HNSW internals (the layered graph, the greedy descent) are a `study-database-systems` topic; what matters *here* is that the cost axis flipped and the caller never knew.

**The catch nobody tunes — `ef`.** HNSW has a recall/latency knob. Build-time `m` and `ef_construction` set how dense the graph is; query-time `hnsw.ef_search` sets how wide the search beam is (higher = better recall, slower). In buffr **none of these are set** — the index is created with pgvector defaults and `ef_search` is never issued. So the ANN path *works* but its recall and latency are whatever the defaults happen to give, unmeasured. That is the honest gap: the seam is built, the fast path exists, but the one tunable that trades recall for speed is sitting at its default value with no baseline to tune against.

#### Move 3 — the principle

Isolate the expensive primitive behind a contract, build the dumb-but-correct version first, and make the fast version a drop-in. The exact scan was never meant to scale — it was meant to let the entire pipeline (chunk → embed → upsert → query → rank → cite) be built and tested with zero infrastructure, while the `VectorStore` seam guaranteed the O(log n) replacement would cost a wiring change, not a rewrite. That is the load-bearing move: not the scan, not the index, but the seam between them.

## Primary diagram

```
  The full picture — one contract, the cost axis flips beneath it

  ┌─ Retrieval pipeline ──────────────────────────────────────────┐
  │  queryKnowledgeBase(q, k)                                       │
  │     embed(q) ──► store.search(vector, k) ──► ranked VectorHit[] │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │  VectorStore contract  (the seam)
                  ┌───────────────┴───────────────┐
   ┌─ in-process (aptkit) ────────┐   ┌─ Postgres (buffr) ───────────────┐
   │ for chunk of all n:          │   │ order by embedding <=> $1         │
   │   score = cosine(q, chunk)   │   │ limit k                           │
   │ sort all n by score          │   │   served by:                      │
   │ slice top k                  │   │   hnsw (embedding vector_cosine)  │
   │ ─ exact, O(n·d + n log n)     │   │ ─ approximate, ~O(log n)          │
   │ ─ zero infra, always correct │   │ ─ ef_search UNTUNED (default)     │
   └──────────────────────────────┘   └───────────────────────────────────┘
```

## Elaborate

Brute-force k-NN and ANN are the two ends of the vector-search spectrum, and HNSW (Hierarchical Navigable Small World, 2016) is the ANN method pgvector ships. The reason the industry settled on "exact for small, ANN for large" is that exact search is the only one with zero recall loss, so it is the correct baseline and the correct test oracle — you can check an ANN index's recall *against* a brute-force scan. aptkit having both behind one contract means buffr could, in principle, validate `PgVectorStore`'s recall against `InMemoryVectorStore` on the same corpus. That eval does not exist yet (`not yet exercised`), but the shape is there.

What to read next: `06-over-fetch-then-filter-cost.md` (the other thing `search` does that costs rows), and `study-database-systems` for HNSW internals and the pgvector query plan.

## Interview defense

**Q: Your vector search is O(n) with a full sort. Why ship that?**
Because it is exactly correct with zero infrastructure, and it is isolated behind the `VectorStore` contract so the O(log n) replacement is a wiring change. The exact scan is the baseline and the test oracle; the HNSW index in buffr is the production path. I built the dumb-correct one first on purpose.

```
  store.search(vector, k)  ← same call
     │
     ├─ InMemoryVectorStore: score all n, sort, slice  (exact, O(n))
     └─ PgVectorStore:       order by <=> limit k        (HNSW, ~O(log n))
                                                          ↑ the swap is config
```
Anchor: "exact scan to build, ANN index to scale, one contract between them."

**Q: What's the load-bearing part people forget here?**
The `ef_search` knob. HNSW is approximate — it trades recall for speed, and that trade is tunable. In buffr it is sitting at the pgvector default, unset, so the index works but is untuned and unmeasured. Naming that is the difference between "I used pgvector" and "I know HNSW has a recall/latency dial I haven't turned yet."

Anchor: "ANN buys speed by spending recall — and `ef_search` is the dial."

## See also

- `02-bounded-loop-cost-ceiling.md` — the other O(1)-ceiling pattern
- `06-over-fetch-then-filter-cost.md` — what `search` does beyond ranking
- `audit.md` — Lens 4 (CPU/memory), Lens 5 (DB bottlenecks), Lens 8 (red flag #1)
- `study-database-systems` — HNSW internals, pgvector query planning
