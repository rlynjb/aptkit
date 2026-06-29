# Graphs & Traversals

**Graph models (adjacency list / matrix) · BFS · DFS · shortest paths · navigable small-world graphs (HNSW)** — Industry standard. **Status in aptkit: `not yet exercised`. In buffr: HNSW is a navigable graph with greedy traversal (cross-repo).**

## Zoom out, then zoom in

aptkit has no graph. No adjacency list, no BFS, no DFS, no Dijkstra. The only graph anywhere in the production story is HNSW — and it's in **buffr**. So this file does two things: teaches the graph family (review for you — you built `Graph.ts`, `Graph2.ts`, BFS/DFS/Dijkstra, state-space BFS in `PG.ts`), and walks HNSW as a *graph traversal* (greedy best-first search with a priority-queue frontier), labeled cross-repo.

```
  Zoom out — where a graph would live (only buffr has one)

  ┌─ aptkit Service + Storage ───────────────────────────────────┐
  │  agent loop → linear sequence, NOT a graph (file 07)          │ ← no graph
  │  retrieval  → flat array scan, NOT a graph                    │
  └───────────────────────────────────────────────────────────────┘

  ┌─ buffr Storage layer — sql/001_agents_schema.sql:28 ─────────┐
  │  ★ HNSW → navigable small-world graph over embeddings ★       │ ← the only
  │    nodes = chunks; edges = "near in cosine space"            │   graph, and
  │    search = greedy best-first traversal with a PQ frontier   │   it's in BUFFR
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: a graph is nodes plus edges — relationships, not hierarchy (a tree is a graph with no cycles and one parent per node). Traversals answer "how do I get from here to there, or visit everything reachable?" BFS uses a queue (closest first), DFS uses a stack (deepest first), Dijkstra uses a priority queue (cheapest first). HNSW's search is a fourth flavor: greedy best-first toward a target, using a priority queue ordered by distance-to-query.

## Structure pass

```
  layers:  the graph model  →  the frontier structure  →  the order visited
  axis held constant: "which node do we expand next?"

  ┌─ BFS ───────────────────────┐   frontier = QUEUE; expand nearest by hops
  │  reincodes/Graph.ts bfs      │   → level by level, shortest unweighted path
  └──────────────┬───────────────┘
                 │  seam: next-node rule flips from oldest to deepest
  ┌─ DFS ───────────────────────┐   frontier = STACK; expand deepest first
  │  reincodes/Graph.ts dfs      │   → cycle detection, components, topo
  └──────────────┬───────────────┘
                 │  seam: next-node rule flips to cheapest cumulative cost
  ┌─ Dijkstra ──────────────────┐   frontier = PRIORITY QUEUE by path cost
  │  reincodes PriorityQueue     │   → weighted shortest path
  └──────────────┬───────────────┘
                 │  seam: next-node rule flips to closest-to-QUERY (greedy)
  ┌─ HNSW search ───────────────┐   frontier = PQ by distance to query
  │  buffr pgvector             │   → approximate nearest neighbor, ~O(log n)
  └──────────────────────────────┘
```

The single axis — *which node do we expand next?* — is the whole graph-traversal curriculum in one question. BFS says oldest, DFS says deepest, Dijkstra says cheapest-cumulative, HNSW says closest-to-query. Same skeleton (frontier + visited set + expand), four different frontier disciplines. You've implemented the first three; HNSW is the production one.

## How it works

### Move 1 — the mental model

Every graph traversal is the *same* kernel: a **frontier** of nodes to explore, a **visited set** so you don't loop forever, and an **expand** step that pulls the next node off the frontier and pushes its neighbors on. Swap the frontier structure and you change the traversal: queue → BFS, stack → DFS, priority queue → Dijkstra/HNSW.

```
  the universal traversal kernel — only the frontier changes

  visited ← {}
  frontier ← {start}
  while frontier not empty:
      node ← frontier.take()      // QUEUE→BFS, STACK→DFS, PQ→Dijkstra/HNSW
      if node in visited: continue
      visited.add(node)
      for each neighbor of node:
          frontier.add(neighbor)

  drop the visited set → infinite loop on any cycle (the part people forget)
```

This is exactly your `reincodes/Graph.ts` BFS/DFS shape (captured set + fringe). HNSW reuses the kernel with a priority-queue frontier ordered by *distance to the query vector*, plus an early-stop when the frontier can't beat the best found so far.

### Move 2 — HNSW as a greedy graph traversal (buffr, cross-repo)

aptkit has no traversal to walk, so we walk the production one and label it clearly.

**The graph: nodes are chunks, edges are proximity.** From `buffr/sql/001_agents_schema.sql:28`, `using hnsw (vector_cosine_ops)` builds a graph where each chunk-embedding is a node and edges connect vectors that are *near* each other in cosine space, organized into layers (sparse on top, dense at the bottom — the hierarchy from file 04). The graph is *navigable*: from any node you can greedily hop toward any target by always moving to the neighbor closest to it.

**The traversal: greedy best-first with a priority-queue frontier.** Searching for the query's nearest neighbors:

```
  HNSW greedy search — the traversal kernel with a PQ frontier
  (Storage layer — Postgres / pgvector)

  enter at top-layer entry node
  for each layer, top → bottom:
      frontier ← PQ ordered by distance(node, QUERY)   // closest-to-query first
      visited  ← {entry}
      while frontier has a node closer than the worst result kept:
          node ← frontier.pop()        // greedy: take closest-to-query
          for each neighbor of node:
              if neighbor not visited:
                  visited.add(neighbor)
                  frontier.push(neighbor)   // PQ keeps it ordered by query-distance
                  update top-k results
      descend to next layer using best node as new entry
  return top-k closest found        // APPROXIMATE — greedy can miss
```

Walk the parts against the kernel you know:

- **Frontier = priority queue keyed by distance-to-query.** This is Dijkstra's machinery (your `PriorityQueue.ts` with `updatePriority`) pointed at a different objective: not "cheapest path cost" but "closest to the query vector." Same structure, different key.
- **Visited set — same load-bearing role as your BFS.** Without it the greedy walk revisits nodes and can cycle. Drop it and HNSW doesn't terminate cleanly. The part people forget, here too.
- **Greedy + early stop = the speedup.** Because it always expands the node closest to the query and stops when the frontier can't improve the kept top-k, it touches `O(log n)` nodes, not all `n`. That early stop is also the source of **approximation**: if the greedy path commits to the wrong neighborhood, the true nearest neighbor is never visited. aptkit's flat scan has no frontier and no early stop — it visits everything, so it's exact (file 06).

The boundary condition that defines the whole aptkit↔buffr seam: **HNSW's greedy traversal trades exactness for `O(log n)`.** A flat scan can't miss because it has no frontier to mislead it. The graph index can miss because greedy choices are local. You make that trade only when `n` is large enough that scanning all of it is the real cost.

**State-space search — the graph aptkit *almost* is, but isn't.** Worth naming because it's in your `reincodes/PG.ts` (river-crossing puzzle, BFS over an implicit state graph). The agent loop *looks* like it could be a search over a state space (each turn is a state, tool calls are edges). But it isn't implemented as one: there's no frontier, no backtracking, no visited set, no branching — it's a single linear path forward (file 07). So the closest thing to a graph search in the agent's *shape* is deliberately not built as a graph. `not yet exercised`.

### Move 3 — the principle

Every graph traversal is one kernel — frontier, visited set, expand — and the frontier's discipline *is* the algorithm. HNSW is Dijkstra's priority-queue machinery aimed at "closest to the query," and its greedy early-stop is exactly what buys `O(log n)` and exactly what makes it approximate. aptkit declines the graph (flat scan, exact); buffr accepts it (HNSW, approximate) when `n` demands it.

## Primary diagram

```
  graphs & traversals across the story — one frame

  TRAVERSAL    frontier        objective              where
  ──────────────────────────────────────────────────────────────────
  BFS          queue           fewest hops            reincodes/Graph.ts
  DFS          stack           deepest first          reincodes/Graph.ts
  Dijkstra     priority queue  cheapest path cost     reincodes (PG/Graph2)
  HNSW search  priority queue  closest to query     ★ buffr (cross-repo) ★
  state-space  queue (BFS)     reach goal state       reincodes/PG.ts

  aptkit: NO graph in running code (agent loop is linear, file 07)
  the seam:  exact scan (no frontier) ═══► greedy graph walk (PQ frontier)
                                            exact  ───►  approximate
```

## Elaborate

BFS/DFS are 19th-century ideas (maze-solving); Dijkstra is 1956; HNSW is 2016 and is *the* reason vector search scales. The throughline worth carrying: HNSW didn't invent new machinery — it pointed Dijkstra's priority-queue frontier at a similarity objective and added layers for `O(log n)` entry. So the graph algorithms you built in `reincodes` *are* the production retrieval algorithm, one indirection away. The database-engine concerns (how pgvector stores the graph, `ef_search` recall/latency knob, index build cost) belong to **study-database-systems**; the "it's a hierarchical index" framing is file 04; this file owns the *traversal*. aptkit's own graph gap is real and fine — it's a request-scoped toolkit, not a system with relationships to traverse.

## Interview defense

**Q: Walk the HNSW search as a graph traversal.**
It's greedy best-first search. Frontier is a priority queue ordered by distance-to-the-query-vector; you pop the closest node, expand its neighbors, push them on the PQ, and update your running top-k. A visited set stops cycles. You descend layer by layer (sparse → dense) for an `O(log n)` entry. It stops early when the frontier can't beat the kept results — which is the speedup *and* the source of approximation.

```
  frontier = PQ by distance-to-query
  pop closest → expand neighbors → push → update top-k
  visited set stops cycles · early stop → O(log n), approximate
```

Anchor: "It's Dijkstra's priority-queue machinery aimed at 'closest to the query' instead of 'cheapest path' — the visited set is just as load-bearing here as in BFS."

**Q: Is the agent loop a graph/state-space search?**
No. It has the *shape* of one — turns as states, tool calls as edges — but it's implemented as a single linear path: no frontier, no branching, no backtracking, no visited set. A true state-space search (like your river-crossing BFS in PG.ts) maintains a frontier and explores alternatives; the agent loop commits forward one turn at a time. `not yet exercised` as a graph.

## See also

- `04-trees-tries-and-balanced-indexes.md` — HNSW's layered hierarchy (the index view)
- `03-stacks-queues-deques-and-heaps.md` — the priority-queue frontier HNSW search uses
- `06-sorting-searching-and-selection.md` — the exact flat scan HNSW replaces (no frontier)
- `07-recursion-backtracking-and-dynamic-programming.md` — why the agent loop is linear, not a search
- **study-database-systems** — pgvector's HNSW storage, recall/latency tuning
