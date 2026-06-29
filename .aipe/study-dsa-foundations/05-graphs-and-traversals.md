# Graphs & Traversals

**Industry name(s):** graphs · BFS / DFS · shortest paths · dependency graphs · HNSW (hierarchical navigable small world) — *Industry standard*

> **Status: `not yet exercised` in aptkit; ONE real graph in the companion repo (buffr).** No BFS, DFS, shortest-path, or topological sort runs in aptkit's source. You've built graph traversal from scratch (`Graph.ts` BFS/DFS, `Graph2.ts` weighted + Dijkstra, `PG.ts` BFS over a river-crossing state graph). This file is curriculum — with the single most important DSA fact about the whole system: **the production vector index is a graph.** buffr's `PgVectorStore` uses HNSW, an approximate-nearest-neighbor *graph*, and a query is a *greedy graph traversal*. That's the one place a real graph algorithm runs.

---

## Zoom out, then zoom in

aptkit has no graph. But the structure that replaces aptkit's linear scan in production *is* a graph, and the search over it is a traversal — so graphs are the climax of this guide, not a footnote.

```
  Zoom out — the one graph in the system (and it's not in aptkit)

  ┌─ aptkit Retrieval layer ────────────────────────────────────┐
  │  InMemoryVectorStore.search → LINEAR SCAN of an array        │
  │  no graph; touch all n chunks                                │
  └───────────────────────────┬─────────────────────────────────┘
                              │ same VectorStore contract, swap in prod
  ┌─ buffr Storage layer ─────▼─────────────────────────────────┐
  │  PgVectorStore → Postgres HNSW index                        │
  │  ★ embeddings linked into a navigable GRAPH ★               │
  │  a query is a GREEDY TRAVERSAL: start at an entry node,     │
  │  hop to the nearest neighbor, repeat until no closer        │
  │  buffr/sql/001_agents_schema.sql:28-29 (vector_cosine_ops)  │
  │  [graph build/tuning mechanics → study-database-systems]    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a graph is nodes connected by edges; a traversal explores it (BFS by layers, DFS by depth, greedy by best-next-hop). HNSW connects each embedding to its nearest neighbors as graph edges, then *searches* by walking edges toward the query — a best-first traversal. It's the production answer to "find nearest without scanning all `n`."

---

## Structure pass

**Layers:** the flat array (aptkit, no graph) → the HNSW proximity graph (buffr) → the traversal that queries it.

**Axis — how is the nearest neighbor found?** trace it across the seam.

```
  One axis — "how do you find the nearest chunk?"

  ┌─ aptkit (InMemoryVectorStore) ─┐  scan ALL n, compare each, sort
  │  exhaustive: exact, O(n)        │  → guaranteed exact top-k
  └─────────────────────────────────┘
              seam: contract swap (same VectorStore interface)
  ┌─ buffr (PgVectorStore / HNSW) ─┐  TRAVERSE a proximity graph
  │  greedy best-first hops         │  → approximate, ≈ O(log n)
  └─────────────────────────────────┘  → trades exactness for speed
```

**Seam — exact scan vs approximate traversal.** The axis-answer flips hard across the `VectorStore` contract: aptkit is *exhaustive and exact*; buffr's HNSW is *greedy, graph-walked, and approximate*. That trade — give up exactness, gain sub-linear lookup — is the defining graph decision in the system.

---

## How it works

### Move 1 — the mental model (BFS/DFS you know, then HNSW)

You've animated BFS lighting up grid cells and Dijkstra finding a path through obstacles, so the traversal mechanics are yours. The kernel of any traversal: a *frontier* (what to explore next), a *visited set* (so you don't loop), and an *expansion* step (dequeue a node, look at its neighbors). BFS uses a FIFO frontier (explore by distance layers); DFS uses a stack (go deep first); greedy/best-first uses a priority order (explore the most promising neighbor first). HNSW's search is best-first: the frontier is ordered by closeness to the query.

```
  Pattern — HNSW search is a greedy best-first traversal

  query q ●
            entry node
              ○──────○ visited
             /│      │
            ○ │      ○  ← hop to the neighbor CLOSEST to q
            │ ○──────○
            ○         \
                       ○ ● ← stop: no neighbor closer to q than current
                            return current (+ its neighbors) as top-k

  frontier = candidate neighbors ordered by distance to q
  visited  = nodes already expanded (don't re-walk)
  expand   = move to the closest unvisited neighbor
  stop     = no neighbor improves on the current best
```

The HNSW twist on plain best-first: it's *hierarchical* — a coarse top layer with long-range links for fast approach, finer layers below for precision. You descend layers, each a navigable small-world graph, zooming in on the query's neighborhood. But the per-layer mechanic is the greedy traversal you already know.

### Move 2 — the walkthrough

#### What aptkit does instead: the exhaustive non-graph

To see the graph's value, look at what it replaces — aptkit's scan visits *every* node with no edges at all:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:27-32
const hits: VectorHit[] = [];
for (const chunk of this.chunks.values()) {     // visit ALL n — no graph
  hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
}
hits.sort((a, b) => b.score - a.score);
return hits.slice(0, Math.max(0, k));
```

There are no edges, no frontier, no traversal — it's the degenerate case: "the graph where you check every node." Exact, simple, `O(n)`. This is the baseline HNSW improves on.

#### The real graph: buffr's HNSW index and its traversal query

In buffr the same contract method runs a graph traversal, expressed as SQL over an HNSW-indexed column:

```sql
-- buffr/sql/001_agents_schema.sql:28-29  (the graph itself)
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
```

```ts
// buffr/src/pg-vector-store.ts:69-75  (the traversal, as a query)
// <=> is cosine DISTANCE; cosine similarity score = 1 - distance.
//   select ... 1 - (embedding <=> $1::vector) as score
//   ... order by embedding <=> $1::vector   ← planner uses the HNSW graph
```

```
  Layers-and-hops — a vector query traverses the HNSW graph

  ┌─ aptkit (consumer) ──┐ hop 1: store.search(queryVec, k)
  │  pipeline.query()    │ ─────────────────────────────────►┐
  └──────────────────────┘                                    │
                          hop 4: VectorHit[] (ranked) ◄────┐  │
  ┌─ buffr PgVectorStore ┐                                 │  ▼
  │  SQL: order by <=>   │ hop 2: planner picks HNSW index │ ┌─ Postgres ─┐
  └──────────────────────┘ ───────────────────────────────┼►│  HNSW graph │
                          hop 3: greedy traversal returns  │ │  best-first │
                          ~k nearest WITHOUT scanning all n └─│  walk       │
                                                              └─────────────┘
```

The load-bearing point: `order by embedding <=> $1` is *not* a sort-the-whole-table — the planner uses the HNSW index to traverse to the query's neighborhood and return candidates without scanning every row. That's the `O(n)` → `~O(log n)` win, achieved by a graph traversal. Both stores satisfy `VectorStore`, so aptkit's pipeline code is byte-for-byte identical; only the wiring picks which store, hence which lookup strategy.

#### The load-bearing skeleton of any traversal — and what breaks without each part

HNSW's search, like your BFS, has a kernel where each part is load-bearing:

```
  traversal kernel        what breaks if you drop it
  ──────────────────────  ──────────────────────────────────────────
  frontier (ordered)      no "explore next" → can't progress
  visited set             revisit nodes → infinite loop on cycles
  expansion (neighbors)   no edges followed → not a traversal, a scan
  termination (no closer) never stops → walks the whole graph (O(n))
```

The part people forget is **termination** — for HNSW, "stop when no neighbor is closer to the query." Drop it and the approximate search degrades to the exhaustive scan it was meant to avoid. (This mirrors BFS's empty-frontier termination, the part you'd name in an interview.) The *approximate* in ANN comes precisely from this greedy local-stopping: it can stop at a local optimum and miss the true nearest — the exactness aptkit's scan keeps and HNSW trades away.

#### Where graphs would enter aptkit itself (they haven't)

Two honest "not yet" cases. (1) **Tool/capability dependency graphs** — if tools had prerequisites ("run anomaly-detection before diagnosis"), you'd topologically sort a DAG. aptkit's tool policy is a flat `Set` allowlist (file **02**), no dependencies, no graph. (2) **Multi-agent orchestration as a graph** — if agents formed a call graph with cycles to detect, a traversal would apply. aptkit's agents are independent single-capability loops; there's no inter-agent graph. Both are plausible future shapes; neither exists today.

### Move 3 — the principle

**A linear scan is the graph with no edges; an index is the graph with edges worth traversing.** The leap from aptkit to buffr is exactly the leap from "visit every node" to "follow edges toward the answer." HNSW buys sub-linear lookup by giving up exactness — a greedy best-first traversal that stops at a good-enough local optimum. The traversal kernel (frontier, visited, expand, terminate) is the same one you animated for BFS; only the frontier ordering and the stopping rule change. Graphs enter a system the moment "nearness" or "dependency" becomes the query.

---

## Primary diagram

The whole graph story for this system in one frame.

```
  Graphs in the system — the one that runs, and the ones that don't

  RUNS IN PRODUCTION (buffr, not aptkit):
    HNSW proximity graph over embeddings
      query = greedy best-first traversal
      frontier ordered by distance to query
      ≈ O(log n), APPROXIMATE (may miss true nearest)
      buffr/sql/001_agents_schema.sql:28-29 · pg-vector-store.ts:69-75

  THE BASELINE IT REPLACES (aptkit):
    InMemoryVectorStore — no edges, visit all n, exact, O(n)
    "the graph where you check every node"

  NOT YET EXERCISED ANYWHERE:
    tool dependency DAG (topo sort)   — tools are a flat Set allowlist
    multi-agent call graph            — agents are independent loops
    BFS/DFS/Dijkstra                  — your portfolio, no aptkit use

  traversal kernel (shared): frontier · visited · expand · TERMINATE
                             (termination is the part people forget)
```

---

## Elaborate

HNSW (2016) sits on a long line: navigable small-world graphs, and before them skip lists — the "express lanes" idea of a hierarchy of increasingly coarse links so you approach a target fast then refine. The greedy traversal is best-first search, the same family as A\* and Dijkstra (your `Graph2.ts`), minus the global-optimality guarantee — ANN deliberately trades the guarantee for speed. The reason vector search needs a graph and not a tree (file **04**): in high dimensions, tree-based spatial indexes (k-d trees, ball trees) degrade toward `O(n)` — the "curse of dimensionality." Proximity graphs sidestep it, which is why every production vector store (pgvector, FAISS, Qdrant, Weaviate) ships HNSW or a cousin.

The honest framing for your portfolio: you've built the exact traversal kernel HNSW uses (BFS frontier + visited + termination) and a weighted best-first search (Dijkstra). HNSW is those primitives applied to a proximity graph with a hierarchy on top. The gap isn't the algorithm — it's that aptkit's scale doesn't yet justify building the graph, so the production version lives in buffr's Postgres rather than hand-rolled. Read `study-database-systems` for how that index is built, tuned (`ef_search`, `m`), and queried; this file only names it as the system's one real graph.

---

## Interview defense

**Q: There's no graph algorithm in aptkit — so where do graphs actually show up in this system?**

> Exactly one place, and it's the most important DSA fact about the system: the production vector index is a graph. aptkit's `InMemoryVectorStore` scans a flat array — exact, `O(n)`, no edges. Swap in buffr's `PgVectorStore` behind the same `VectorStore` contract and a query becomes a traversal of an HNSW proximity graph: start at an entry node, greedily hop to the neighbor closest to the query, stop when none is closer — `≈ O(log n)`, approximate. Same kernel as BFS — frontier, visited, expand, terminate — with the frontier ordered by distance and a greedy stopping rule.

```
  aptkit: scan all n (exact, O(n))  ──contract swap──►
  buffr:  HNSW greedy traversal (approx, ~O(log n))
```

**Q: What's the part of that traversal people forget, and what does HNSW give up?**

> Termination — "stop when no neighbor is closer to the query." Forget it and the greedy walk degrades to the exhaustive scan it was meant to beat. And what HNSW gives up is *exactness*: greedy local stopping can settle at a local optimum and miss the true nearest neighbor. aptkit's scan keeps exactness and pays `O(n)`; HNSW trades a little recall for sub-linear speed. That trade is the whole reason vector DBs use a graph and not a k-d tree — in 768 dimensions, tree indexes collapse toward `O(n)` (curse of dimensionality), proximity graphs don't.

Anchor: *the production vector index is a graph; the query is a greedy best-first traversal that trades exactness for sub-linear lookup.*

---

## See also

- **04-trees-tries-and-balanced-indexes.md** — why a tree can't index vectors, so the index is this graph.
- **02-arrays-strings-and-hash-maps.md** — the flat-array scan HNSW replaces.
- **06-sorting-searching-and-selection.md** — exact full-sort selection vs approximate graph search.
- `study-database-systems` — how buffr builds, tunes, and queries the HNSW index in Postgres.
- `study-ai-engineering` — ANN as the retrieval-at-scale move in the RAG pipeline.
