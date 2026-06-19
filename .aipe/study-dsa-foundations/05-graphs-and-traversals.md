# 05 — Graphs and Traversals

**Industry name(s):** Graph (directed/undirected), adjacency list, BFS, DFS, topological sort, shortest path (Dijkstra). Type label: Language-agnostic foundation.

## Zoom out, then zoom in

Graphs model *relationships you traverse* — dependencies, networks, paths. AptKit has data that *looks* relational — capability coverage with `requires` and `enriches` lists, the package dependency tree, the provider fallback chain — but none of it is traversed as a graph. Every relationship here is evaluated as a flat, one-hop `Set.has` check or a fixed linear order. So graphs are `not yet exercised`, and this file's job is to be precise about *why*, and exactly where a real graph would appear. You've built the real thing (`Graph.ts`, `Graph2.ts`, BFS/DFS, Dijkstra, connected components in `reincodes`), so the teaching has somewhere solid to land.

```
  Zoom out — relational-looking data in AptKit (none traversed)

  ┌─ Tools/context layer ────────────────────────────────┐
  │  coverage: requirement.requires = [tokenA, tokenB]   │ ← LOOKS like edges
  │            requirement.enriches = [tokenC]            │   evaluated as flat
  │            → capabilities.has(token)  ONE HOP only    │   Set.has, no traversal
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ Providers layer ─────────▼───────────────────────────┐
  │  fallback chain: try A, then B, then C  (fixed list)  │ ← a path, but LINEAR,
  │                                                        │   not a graph search
  └───────────────────────────┬───────────────────────────┘
                              │
  ┌─ (absent as graph) ───────▼───────────────────────────┐
  │  adjacency list, BFS, DFS, topo sort, Dijkstra         │ ← your reincodes work
  │  not yet exercised                                     │
  └────────────────────────────────────────────────────────┘
```

Zoom in: a graph is nodes plus edges; traversal is visiting nodes by following edges, tracking what you've seen so you don't loop. The defining feature is *transitivity* — A connects to B connects to C, and you care about reaching C *through* B. AptKit never has that. Its "edges" are all single-hop membership checks against a flat set, and its one "path" (the provider fallback) is a fixed linear list you walk start-to-end. No transitivity means no traversal means no graph.

## Structure pass

**Layers.** Tools/context (coverage `requires`/`enriches`), providers (the fallback chain). Both *look* like graph layers; neither traverses.

**Axis — trace "reachability": *to use X, what must transitively be true?*** This is the graph question, and watching it stay one-hop everywhere is the lesson.

```
  One axis — "reachability" — and why it never goes transitive

  coverage:   requirement requires [t1, t2]
              → capabilities.has(t1) AND capabilities.has(t2)
              ONE HOP. t1 is a raw token, not another requirement.
              no "t1 requires t3" chain to follow.

  fallback:   try provider A → fail → try B → fail → try C
              LINEAR walk of a fixed list. no branching, no cycles.

  a graph question would be: "X requires Y, Y requires Z,
  is Z available?" — transitive closure. that question is
  NEVER ASKED here. so reachability stays one hop deep.
```

**Seam.** The load-bearing boundary is between *one-hop membership* (what AptKit does — `capabilities.has(token)`) and *multi-hop traversal* (what a graph needs — follow edges, track visited, until frontier empty). The axis-answer flips from "check direct presence" to "search transitive reachability" exactly when a requirement's dependency points at *another requirement* instead of a raw capability token. Today it always points at a raw token. That single fact is why there's no graph: the edges don't chain.

## How it works

This is the kernel you already know from `reincodes`, walked here so the *absence* is precise — and so the trigger that would summon it is unmistakable.

### Move 1 — the mental model

You built grid BFS — the river-crossing puzzle (`PG.ts`) lighting up reachable states. That's the shape: a frontier of "to-visit" nodes, a visited set so you never re-expand, and a loop that pulls from the frontier, expands neighbors, and enqueues the unseen ones until the frontier drains.

```
  The kernel — BFS frontier + visited (the thing AptKit lacks)

  frontier: [start]      visited: {start}
    ┌──────────────────────────────────────┐
    │ while frontier not empty:             │
    │   node = dequeue(frontier)            │
    │   for neighbor of node.edges:         │  ← edges = the relationships
    │     if neighbor not in visited:       │  ← visited = no re-expand
    │       visited.add(neighbor)           │
    │       enqueue(frontier, neighbor)     │
    └──────────────────────────────────────┘
  terminates when frontier empties ← the load-bearing part people forget
```

The whole point of this machine is *following edges across multiple hops*. AptKit's coverage check is the degenerate one-hop case: `frontier = [requirement]`, expand once into its `requires` tokens, check each is present, done. There's no second hop, so the frontier, the visited set, and the loop all collapse into a single `.every(has)`. That collapse *is* why it's not a graph.

### Move 2 — where the graph isn't, one relationship at a time

**Coverage `requires`/`enriches` — edges that don't chain.** Bridge from your adjacency list: an adjacency list maps a node to its neighbors. `requirement.requires` maps a capability to the tokens it needs — that's *shaped* like adjacency. But the neighbors are raw capability tokens (event names, catalog names), not other requirements. So there's no node to traverse *to*. It's a one-hop `.every(capabilities.has(dep))`.

```
  Coverage as a (non-)graph — one hop, no traversal

  requirement R
     requires → ["purchase", "purchase.amount", "catalog:products"]
                      │            │                    │
                      ▼            ▼                    ▼
                 capabilities.has(each)  ── all present? → 'full'
                                            some enrich missing? → 'limited'
                                            some require missing? → 'unavailable'

  the arrows are NOT edges to other requirements — they're
  membership checks against a flat Set. depth = 1. no closure.
```

What would make it a graph: if `requires: ["capability:diagnosis"]` meant "this capability needs *another capability* to have run first," you'd have edges between requirements, possible chains (A→B→C), possible cycles, and you'd need topological sort to order them and cycle detection to reject bad configs. None of that exists. The check is flat by design.

**The provider fallback chain — a path, but linear.** Bridge from a linked list: the fallback provider tries adapters in a fixed sequence — A, then B if A fails, then C. That's a *path*, but a predetermined linear one, not a search through a branching graph. There's no choice of which neighbor to visit, no visited set, no termination-on-empty-frontier — just "next in the list until one succeeds or the list ends."

```
  Fallback chain — linear walk, not graph search

  [provider A] → fail → [provider B] → fail → [provider C] → result | error
       │                     │                     │
   no branching          no visited set       fixed order
   it's a for-loop over a list, not a traversal
```

**The package dependency DAG — real, but resolved by the build tool, not the repo.** AptKit's 11 internal packages *do* form a dependency graph (runtime → tools → agents → core), and `build:core:deps` even has an explicit ordered chain. That ordering is a topological sort — but `tsc -b` and npm compute it, the repo just declares the edges in `package.json`. The repo never traverses this graph in its own code. (This is a system-design/build concern — see `study-system-design`.)

### Move 2.5 — current state vs future state: the real graph trigger

```
  Phase A (now)                    Phase B (a graph appears)

  coverage: requires → raw token   capabilities depend on OTHER
            one-hop Set.has        capabilities → edges chain →
                                   need topo sort (run order) +
                                   cycle detection (reject bad config)
                                   + transitive reachability (can X
                                   run given what's available?)

  agents: independent, flat        a planner that composes capabilities
                                   into a DAG and executes in dependency
                                   order → BFS/DFS/topo over that DAG

  cost of switching: this is your reincodes Graph.ts +
  topological-sort territory, dropped in when composition arrives.
```

The honest read: the day AptKit grows a *planner* that chains capabilities — "to answer this, first run diagnosis, which first needs monitoring" — the coverage system becomes a real dependency graph and you'll want BFS/DFS for reachability, topological sort for execution order, and cycle detection to reject impossible configs. That's exactly your `reincodes` `Graph.ts` (BFS/DFS, valid-tree check, connected components) and the topo-sort layer on top. It hasn't arrived because today every agent is independent and every dependency is one hop to a raw token.

### Move 3 — the principle

A relationship is only a *graph* when you traverse it transitively — follow edges across multiple hops, tracking visited to handle cycles. Data that's shaped like edges but only ever checked one hop deep (membership) is a set problem, not a graph problem, and a flat `Set.has` is the right tool — reaching for BFS there is over-engineering. The skill is spotting the difference: ask "do I follow this relationship through to a node I didn't start from?" If no, it's membership; if yes, it's a graph. AptKit always answers no.

## Primary diagram

The relational-looking data, framed against the absent traversal machinery.

```
  Graphs in AptKit — relational-looking, never traversed

  ┌─ LOOKS RELATIONAL, EVALUATED FLAT ───────────────────┐
  │  coverage requires/enriches → capabilities.has() ×1   │
  │  fallback chain → linear for-loop over fixed list      │
  │  package deps → real DAG, but topo-sorted by tsc/npm   │
  └────────────────────────────────────────────────────────┘
  ┌─ NOT YET EXERCISED (in repo code) ──────────────────┐
  │  adjacency list · BFS frontier+visited · DFS          │
  │  topological sort · cycle detection · Dijkstra        │
  │  → your reincodes Graph.ts / Graph2.ts / PG.ts        │
  │  trigger: capability composition into a dependency DAG │
  └────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The coverage check runs pre-model to decide which tasks are even runnable given a workspace's available data (so the agent doesn't spend tokens on impossible tasks). The fallback chain runs when a primary provider errors. Neither traverses; both are the closest the repo gets to relational data.

The one-hop coverage check — `packages/tools/src/coverage-gate.ts` (lines 38–45, `requirementCoverage`):

```
  export function requirementCoverage(requirement, capabilities): CoverageLevel {
    if (!requirement.requires.every((dep) => capabilities.has(dep)))   ← one hop, all-present
      return 'unavailable';
    if (requirement.enriches?.length &&
        !requirement.enriches.every((dep) => capabilities.has(dep)))   ← one hop, enrichers
      return 'limited';
    return 'full';
       │
       └─ `requires` is shaped like an adjacency list (node → dependency tokens), but
          `dep` is a raw capability token (e.g. "purchase.amount"), never another
          requirement. So there's nothing to traverse TO — depth is always 1. This is
          a Set-membership problem, correctly solved with .has, NOT a graph.
  }
```

And how tokens are built — `coverage-gate.ts:23` `schemaCapabilities` flattens events, event-properties, and catalogs into one `Set<string>`. The "graph" is pre-flattened into a token set, which is exactly what removes the need to traverse: every dependency is resolved against the flat set in one hop.

There is no graph traversal code to cite — no adjacency list construction, no BFS/DFS, no visited set, no topological sort anywhere in `packages/`. That absence is the finding.

## Elaborate

Graphs are the most general relational structure — trees and linked lists are special cases (a tree is an acyclic connected graph; a list is a path). BFS and DFS are the two fundamental traversals: BFS explores level by level with a queue (shortest path in unweighted graphs), DFS goes deep with a stack/recursion (cycle detection, topological sort). Dijkstra adds edge weights and a priority queue to find shortest weighted paths — which is the one place your `BinaryHeap`/`PriorityQueue` and `Graph2.ts` compose into a single algorithm.

The reason AptKit has none of this is genuinely structural, not an oversight: agent capabilities are independent, dependencies are one-hop to raw tokens, and the only real DAG (package build order) is owned by the build tool. The most likely future graph is capability composition — a planner that sequences capabilities by dependency. When that lands, the coverage `requires` field grows edges to other capabilities, and you'll want topological sort (build order respected at runtime) and cycle detection (reject "A needs B needs A"). That's a clean, bounded place to drop in the `reincodes` graph work. Until then, the `Set.has` is correct and a graph would be premature.

The build-order DAG and provider-fallback shape are system-design concerns — `study-system-design` owns the architectural view of those; this file only notes they aren't *traversed in repo code*.

## Interview defense

**Q: "The coverage system has `requires` and `enriches` lists. Is that a graph?"**

No — it's shaped like one but evaluated as flat membership. `requires` lists *raw capability tokens*, not other requirements, so there's no node to traverse to. The check is `requires.every(token => capabilities.has(token))` — one hop, O(requires). A graph needs transitivity: follow edges across multiple hops with a visited set. That never happens here, so a `Set.has` is the correct tool and BFS would be over-engineering.

```
  requirement → [raw tokens] → has()?   depth 1, no closure
  NOT requirement → requirement → requirement   (that'd be a graph)
```

Anchor: *it's adjacency-shaped but one-hop — a set problem, not a graph problem, until dependencies point at other capabilities.*

**Q: "When would this become a real graph, and what would you add?"**

When a capability's dependency points at *another capability* — composition. Then edges chain (A→B→C), and I'd need topological sort to run them in dependency order, cycle detection to reject impossible configs, and BFS/DFS for "is X reachable given what's available." That's exactly the `Graph.ts` + topo-sort work I've built before; it drops in when a capability planner arrives.

```
  trigger: requires → other capability
  add: adjacency list + topo sort (order) + cycle detect (reject)
```

Anchor: *the trigger is capability-to-capability dependencies — that's when one-hop membership becomes transitive reachability and you need traversal.*

**Q: "Is the provider fallback chain a graph traversal?"**

No — it's a linear walk of a fixed list: try A, then B, then C. There's no branching, no choice of neighbor, no visited set, no cycle concern. It's a `for`-loop with early exit on success, not a search. Calling it traversal would overstate it.

```
  A → fail → B → fail → C   fixed order, for-loop, not search
```

Anchor: *a fixed linear fallback is a loop, not a traversal — no frontier, no visited, no branching.*

## Validate

**Reconstruct.** Write the BFS kernel from memory: frontier queue, visited set, dequeue→expand→enqueue-unseen, terminate on empty frontier. Then write AptKit's coverage check and identify which BFS parts collapse away (frontier of one, no second hop, no visited needed).

**Explain.** In `coverage-gate.ts:42`, why is `requires.every(capabilities.has)` *not* a graph traversal even though `requires` looks like an adjacency list? (Answer: the elements of `requires` are raw tokens in the capability set, not nodes with their own edges — there's no node to traverse to, so depth is fixed at 1.)

**Apply to a scenario.** AptKit adds a planner where `recommendation` requires `diagnosis` to have run, and `diagnosis` requires `monitoring`. A config accidentally sets `monitoring` to require `recommendation`. What breaks, and which algorithm catches it? (Answer: a cycle — recommendation→diagnosis→monitoring→recommendation. A topological sort can't order a cyclic graph; running DFS and detecting a back-edge catches it. Today nothing catches it because there's no graph; this is precisely the trigger to add one.)

**Defend the decision.** Someone wants to model coverage as a graph "to be future-proof." Defend the flat `Set.has`. (Answer: dependencies are one-hop to raw tokens — there is no transitivity to traverse, so a graph adds an adjacency structure, a traversal, and a visited set that all collapse to a single `.every(has)`. It's complexity for a relationship that isn't there yet. Add the graph when composition makes edges chain, not before.)

## See also

- `02-arrays-strings-and-hash-maps.md` — the `Set.has` coverage check, the membership solution that stands in for traversal.
- `03-stacks-queues-deques-and-heaps.md` — the queue (BFS frontier) and heap (Dijkstra) that a real graph would need.
- `04-trees-tries-and-balanced-indexes.md` — trees as the acyclic special case; also absent for the same flat-data reason.
- `study-system-design` (neighboring guide) — the package build DAG and provider fallback as architectural shape.
