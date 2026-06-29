# DSA Foundations — aptkit

The reusable data-structures-and-algorithms vocabulary behind aptkit, grounded in real files — plus the foundations the repo doesn't exercise yet, named honestly so you know what to drill.

This is a **curriculum-style** guide, not an audit. The concept order is fixed (complexity → arrays/maps → stacks/queues/heaps → trees → graphs → sorting/searching → recursion/DP → practice map). Each file teaches one family of structures, anchors the ones aptkit actually runs to a real `file:line`, and labels the rest `not yet exercised` rather than inventing a use for them.

## The through-line

```
  the question this guide answers
  ─────────────────────────────────────────────────────────
  which reusable structures and algorithms explain aptkit,
  and which foundational gaps should you deliberately practice?
```

You have a strong DSA portfolio already — graphs (BFS/DFS/Dijkstra), heaps, BSTs, sorting, recursion, all built from scratch in `reincodes`. This guide does **not** re-teach those. It does two things instead: (1) shows you where the *applied* structures live inside a production-shaped AI toolkit (mostly in the retrieval layer), and (2) draws a sharp line between "exercised here" and "you've built it elsewhere but aptkit doesn't run it."

## Where aptkit actually lives on the DSA map

aptkit is an AI-agent toolkit. Its DSA surface is small and concentrated — almost all of it is in `packages/retrieval` and `packages/runtime`. There is no graph, no tree, no heap in the running code. That's not a weakness; it's what a RAG-plus-agent-loop system is made of.

```
  aptkit's DSA surface — the structures that actually run
  (UI / Service / Storage bands)

  ┌─ Service layer — packages/runtime, packages/agents ───────────┐
  │  bounded agent loop      → state machine, fixed iteration cap  │
  │    run-agent-loop.ts     │ for-loop + break on terminal state  │
  │  tolerant JSON parse     → string scan, bracket-balance        │
  │    json-output.ts        │ fenced-block regex + substring scan │
  │  tool policy              → Set membership (allowlist)         │
  │    tool-policy.ts        │ O(1) `allowed.has(name)`            │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ retrieval reaches agents AS A TOOL
  ┌─ Storage layer — packages/retrieval, packages/memory ─────────┐
  │  ★ cosine-similarity rank + top-k  ★  ← the load-bearing one   │
  │    in-memory-vector-store.ts │ linear scan + sort + slice      │
  │  overlapping-window chunker  → sliding window over a string    │
  │    chunker.ts                │ fixed step = size - overlap     │
  │  memory id-counter           → Map<convId, n>                  │
  │    conversation-memory.ts    │ monotonic counter per key       │
  │  precision@k / recall@k      → Set intersection over top-k     │
  │    precision-at-k.ts         │ distinct-hit count in a window  │
  └───────────────────────────────────────────────────────────────┘

  ┌─ Storage layer — buffr (companion repo, the production path) ──┐
  │  pgvector HNSW index → approximate-nearest-neighbor graph      │
  │    sql/001_agents_schema.sql:28  using hnsw (vector_cosine_ops)│
  │  the ONE graph in the whole story — and it's not in aptkit     │
  └───────────────────────────────────────────────────────────────┘
```

The single most important thing to internalize: **aptkit's `InMemoryVectorStore` does an exact linear scan; buffr's `PgVectorStore` does an approximate graph walk (HNSW).** Same `VectorStore` contract, two completely different algorithms underneath. That seam — exact O(n) brute force vs approximate-nearest-neighbor (ANN) graph traversal — is the richest DSA lesson in the whole codebase, and it's covered across files 02, 05, and 06.

## Ranked findings

```
  rank   finding                                          where
  ────────────────────────────────────────────────────────────────────
  1      cosine rank + top-k is the load-bearing          in-memory-
         algorithm — linear scan, full sort, slice(k).    vector-store.ts:25
         The whole system's retrieval quality and cost
         ride on this one function. It is also the
         clearest exact-vs-approximate seam in the repo
         (vs buffr's HNSW). → 06, 02
  2      the agent loop is a bounded state machine —       run-agent-loop.ts:98
         a for-loop with a hard iteration cap and a
         forced-final turn. The cap is the load-bearing
         part: drop it and a tool-calling model can spin
         forever. → 07 (iteration as a state space)
  3      Set/Map membership carries three quiet jobs —     tool-policy.ts:16,
         tool allowlist (O(1) gate), memory id-counter    conversation-memory.ts:71,
         (collision-free ids), and distinct-hit counting  precision-at-k.ts:29
         for precision@k. None are flashy; all are the
         right primitive. → 02
```

## Repo-grounded vs curriculum-only

```
  REPO-GROUNDED (aptkit runs these — anchored to real files)
  ──────────────────────────────────────────────────────────
  complexity / cost models   the O(n·d) scan, the cap, slice(k)   → 01
  arrays · strings · maps     vectors, chunker, Set/Map membership → 02
  sorting · searching · top-k cosine sort + slice, linear scan     → 06
  recursion (bounded iter)    agent loop, parseAgentJson           → 07

  CURRICULUM-ONLY (you've built these in reincodes; aptkit does NOT run them)
  ──────────────────────────────────────────────────────────────────────────
  stacks · queues · deques    not yet exercised in aptkit          → 03
    └ priority queue / heap    not in aptkit (you built BinaryHeap) → 03
  trees · tries · balanced    not yet exercised in aptkit          → 04
    └ HNSW (a graph index)     IS exercised — but in BUFFR, not    → 04, 05
       aptkit. Labeled cross-repo.
  graphs · BFS · DFS · paths  not in aptkit's running code; the    → 05
    only live graph is buffr's HNSW (ANN). State-space
    BFS appears in YOUR reincodes (PG.ts), not here.
  dynamic programming         not yet exercised anywhere in        → 07
    aptkit or buffr.
```

## Reading order

```
  01 ─► 02 ─► 03 ─► 04 ─► 05 ─► 06 ─► 07 ─► 08
  cost   maps  queues trees graphs sort  recur  practice
         ★      gap    gap   ★HNSW  ★     ★      map
  ★ = has real aptkit code; others are curriculum-only / cross-repo
```

Read 01, 02, 06, 07 for the parts aptkit runs. Read 03, 04, 05 for the foundations you should keep sharp even though aptkit doesn't reach for them — file 08 ranks the whole thing into a practice plan.

## Cross-links to neighboring guides

- **study-ai-engineering** — owns the RAG pipeline as an *AI* concern (embeddings, retrieval quality, evals). This guide owns the *data structures* underneath it. When you want "why cosine, why 768-dim," go there; "what's the time complexity of the scan," stay here.
- **study-database-systems** — owns pgvector, HNSW build parameters, and the storage engine beneath buffr's index. This guide explains HNSW *as a graph*; that guide explains it *as a database index*.
- **study-performance-engineering** — owns the measurement and budget of the O(n·d) scan (when it stops being fine, how to profile it). This guide explains the cost *model*; that guide explains how to *measure and act* on it.
- **study-system-design** — owns the `VectorStore` contract as an architectural seam. This guide explains what's algorithmically different across that seam (exact scan vs ANN graph).
