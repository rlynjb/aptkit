# 03 · B-tree, Hash, and Secondary Indexes

**Industry name(s):** secondary indexes, b-tree, ANN index (HNSW). **Type:** Industry standard.

## Zoom out, then zoom in

You know an index as "the thing that makes `WHERE id = x` fast instead of scanning every row." That intuition holds. What's unusual in this repo: the hot query isn't `WHERE id = x` — it's "find the 5 vectors *nearest* to this one," and a b-tree can't answer that. So buffr carries **two different index structures** over the same `agents.chunks` table.

```
  Zoom out — where indexes sit

  ┌─ Pipeline (aptkit) ────────────────────────────────────┐
  │  store.search(vector, k)  /  store.upsert(chunks)       │
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Store layer ──────────────▼────────────────────────────┐
  │  InMemory: NO index — linear scan + sort every query     │
  │  Postgres: ★ HNSW (nearest-vector) + b-tree (id, app_id)★│ ← we are here
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Disk ─────────────────────▼────────────────────────────┐
  │  HNSW graph · b-tree on id PK · b-tree on app_id         │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **index selection** — which structure answers which query, and what each one costs on write. aptkit's answer is "no index, scan everything." buffr's answer is HNSW for the similarity search, a b-tree primary key for upsert-by-id, and a second b-tree for the `app_id` filter. Three structures, three jobs.

## The structure pass

**Layers.** The query layer asks one of two questions: "give me row with this exact id" (upsert) or "give me rows nearest this vector" (search). Each maps to a different index. The index layer is where the question shape decides the structure.

**Axis — trace "what does this index cost on a write?" because that's the index tradeoff that bites:**

```
  One question across the indexes: "cost to maintain on insert?"

  ┌─ b-tree on id (PK) ─────────────┐  → O(log n) — cheap, balanced tree insert
  ┌─ b-tree on app_id ──────────────┐  → O(log n) — cheap
  ┌─ HNSW on embedding ─────────────┐  → EXPENSIVE — graph link rewiring per insert
  ┌─ InMemory (no index) ───────────┐  → ZERO write cost; ALL cost moved to read
```

**Seam.** The boundary is `upsert` vs `search`. Above the seam the pipeline doesn't know an index exists. Below it, the *same insert* touches three index structures in Postgres (and pays HNSW's graph-maintenance cost), while in aptkit the insert touches none and the read pays everything. The axis — where the cost lives — flips hard across the in-memory/Postgres seam.

## How it works

### Move 1 — the mental model

You've built a `BinarySearchTree` from scratch (`BinarySearchTree.ts`) — a b-tree is that idea, fattened to many keys per node so it stays shallow on disk. HNSW is a different animal: it's a **navigable graph** you greedily walk toward the query vector, like a multi-level skip list pointing through high-dimensional space. A b-tree gives you *exact* ordering on a scalar; HNSW gives you *approximate* nearness in 768 dimensions.

```
  Two index shapes for two questions

  b-tree (exact, ordered scalar)        HNSW (approximate nearest neighbor)
        [m]                                 layer 2:  o ──────► o
       /   \                                layer 1:  o ─► o ─► o ─► o
     [d]   [t]                              layer 0:  o-o-o-o-o-o-o-o-o
    / \    / \                                        ▲ enter top, greedily
  ...  ...                                            hop toward query vector
  answers: id = "x"                        answers: nearest(vector, k)
```

The kernel of HNSW: **start at a sparse top layer, greedily hop to the closest node, descend a layer, repeat.** Lose the layered shortcuts and it degrades to a flat graph walk — slow. Lose the "stop when no neighbor is closer" termination and it never converges.

### Move 2 — the walkthrough

**aptkit: no index, the scan IS the query.** The in-memory store has zero index structures. Every search recomputes cosine against every chunk and sorts:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:25-33
async search(vector: number[], k: number): Promise<VectorHit[]> {
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values())                    // O(n) — touch every chunk
    hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
  hits.sort((a, b) => b.score - a.score);                      // O(n log n) — sort the lot
  return hits.slice(0, Math.max(0, k));                        // take top-k
}
```

This is *exact* nearest-neighbor (it considers everything) at O(n) per query. Writes are free (`Map.set`), reads are linear. It's the right call for tests and small corpora — and a non-starter at scale, which is the whole reason HNSW exists.

**buffr: three index structures, declared in the schema.**

```sql
-- buffr/sql/001_agents_schema.sql:14, 28-30
id text primary key,                                           -- (1) b-tree on id, implicit from PK
...
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);   -- (2) HNSW for nearest-vector
create index if not exists chunks_app_id on agents.chunks (app_id);  -- (3) b-tree on app_id
```

Three jobs:

- **(1) b-tree on `id` (the primary key).** Powers the upsert: `on conflict (id) do update` needs to find the existing row by id, which is a b-tree probe — O(log n). This is what makes "upsert this chunk" cheap regardless of corpus size.
- **(2) HNSW on `embedding` with `vector_cosine_ops`.** Powers the search. `vector_cosine_ops` tells pgvector to build the graph using cosine distance, matching the `<=>` operator the query uses. This is the index that turns the in-memory O(n) scan into an approximate sub-linear graph walk.
- **(3) b-tree on `app_id`.** Powers the multi-tenant filter `where app_id = $2`. Without it, the `app_id` predicate would scan.

**The surprising part: HNSW is approximate, and the query uses it AND a separate filter.** The search query is:

```ts
// buffr/src/pg-vector-store.ts:70-77
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score              -- cosine distance → similarity
   from agents.chunks
   where app_id = $2                                           -- b-tree on app_id (or filter)
   order by embedding <=> $1::vector                           -- HNSW on embedding
   limit $3`,
  [toVectorLiteral(vector), this.appId, k],
);
```

Here's the rub the planner has to resolve, and it's the most important index interaction in the repo: **the `where app_id` filter and the `order by embedding` use different indexes.** HNSW returns approximate-nearest rows in embedding space; the `app_id` filter then has to apply on top. If HNSW returns its top candidates and most belong to a *different* app_id, the post-filter can leave you with fewer than `k` results — the classic "filtered ANN" problem. Whether Postgres handles this well (filtered HNSW scan) or poorly (over-fetch then filter) is **`not yet exercised`** — no `EXPLAIN` has been run, and with `app_id` defaulting to `'laptop'` for everything in a single-tenant laptop deployment, the filter is effectively a no-op today. The risk is latent until a second app_id appears.

**Write cost — the HNSW tax.** Every `upsert` of a chunk inserts into all three indexes. The b-trees are cheap O(log n). HNSW is not: inserting a vector means finding its place in the navigable graph and rewiring neighbor links, which is markedly more expensive than a b-tree insert. The `upsert` loop inserts chunks one row at a time inside the transaction (`buffr/src/pg-vector-store.ts:43-57`), so a 50-chunk document pays the HNSW insertion cost 50 times. `ef_construction` (how hard HNSW works to build good links) is left at the pgvector default — **not tuned** — so build quality vs build speed is whatever the default trades.

```
  Layers-and-hops — one upsert touching three indexes (buffr)

  ┌─ PgVectorStore ─┐ hop: INSERT ... ON CONFLICT (id)   ┌─ Postgres ──────────┐
  │ upsert (txn)    │ ──────────────────────────────────►│ heap tuple written  │
  └─────────────────┘                                    └──────┬──────────────┘
                                                                │ then maintain:
                                          ┌─────────────────────┼─────────────────────┐
                                          ▼                     ▼                     ▼
                                   b-tree(id) O(log n)   b-tree(app_id) O(log n)   HNSW(embedding)
                                   cheap probe           cheap                     EXPENSIVE rewire
```

### Move 3 — the principle

Index selection is question-driven: a b-tree answers "exact / ordered," an ANN index answers "approximately nearest." You pay for every index on every write, and HNSW's write tax is the steep one — it buys sub-linear similarity search at the cost of expensive inserts and *approximate* (not exact) results. The general lesson: each index is a bet that a read pattern is worth a write cost, and an ANN index additionally trades correctness for speed.

## Primary diagram

```
  Full index picture — agents.chunks, three structures + the in-memory control

  ┌─ aptkit InMemoryVectorStore ─┐      ┌─ buffr Postgres: agents.chunks ──────────┐
  │ NO index                     │      │  ┌ b-tree(id PK) ──► upsert by id O(logn)│
  │ search = O(n) scan + sort    │      │  ├ b-tree(app_id) ─► WHERE app_id filter │
  │ exact NN, free writes        │      │  └ HNSW(embedding, cosine)               │
  │                              │      │       └► ORDER BY embedding <=> $1       │
  │                              │      │          approximate NN, sub-linear read │
  │                              │      │          EXPENSIVE per-insert rewire     │
  └──────────────────────────────┘      │  ef_search / ef_construction: DEFAULT    │
                                         │  filtered-ANN interaction: NOT EXERCISED │
                                         └──────────────────────────────────────────┘
```

## Elaborate

HNSW (Hierarchical Navigable Small World) became the default ANN index in pgvector 0.5+ because it offers better recall/latency than IVFFlat without a training step. The cosine-distance operator `<=>` and the `vector_cosine_ops` opclass must agree — index built for cosine, query ordered by cosine — or the index won't be used; buffr gets this right. Two knobs are left default and are the obvious next tuning target: `ef_construction` (build-time graph quality) and `ef_search` (query-time candidate breadth, which trades recall for latency). Raising `ef_search` is the lever if retrieval starts missing relevant chunks. Read next: 04 for how the planner actually executes this query and the N+1 risk on the index side.

## Interview defense

**Q: Why two index types on one table?**

```
  question shape  →  index
  "id = x"        →  b-tree (exact)         ← upsert
  "app_id = x"    →  b-tree (exact)         ← tenant filter
  "nearest(vec)"  →  HNSW (approximate)     ← the RAG search
```

Answer: "The table answers two question shapes. Upsert and the tenant filter are exact-match — b-trees, O(log n). But the RAG search is 'nearest 5 vectors,' which a b-tree fundamentally can't do; you need an ANN index, so it's HNSW with `vector_cosine_ops` to match the `<=>` cosine operator. Different questions, different structures (`001_agents_schema.sql:28-30`)." Anchor: *b-tree is exact, HNSW is nearest — the question picks the index.*

**Q: What does HNSW cost you that a b-tree doesn't?**

Answer: "Two things. Write cost — inserting a vector rewires graph neighbor links, far pricier than a balanced-tree insert, and the upsert pays it per chunk. And correctness — HNSW is *approximate*; it can miss a true nearest neighbor. `ef_search` trades recall for latency, and we've left it at default, so we haven't tuned that tradeoff yet." Anchor: *HNSW trades write cost and exactness for sub-linear nearest-neighbor reads.*

## See also

- `02-records-pages-and-storage-layout.md` — the `embedding` column the HNSW index covers.
- `04-query-planning-and-execution.md` — how the planner runs the HNSW + filter query.
- `09-database-systems-red-flags-audit.md` — the filtered-ANN and untuned-HNSW risks.
- study-dsa-foundations — b-trees and graph search, the structures under these indexes.
