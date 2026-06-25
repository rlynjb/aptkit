# Study — DSA Foundations (AptKit)

The reusable data-structures-and-algorithms vocabulary behind AptKit — and an honest map of the foundations this repo does *not* exercise yet.

## What this guide is

AptKit is a TypeScript ESM monorepo of reusable AI-agent capabilities. Through a DSA lens it is a small, sharp set of structures used really well: **hash maps and sets for lookup and dedup, discriminated unions for typed event/result streams, linear scans for filter/classify, modulo round-robin for scheduling, and comparator sorts for ranking.** The `@aptkit/retrieval` package adds the kit's first *numeric* DSA — **cosine similarity over float vectors, linear-scan (brute-force) nearest-neighbor with sort+slice top-k, and fixed-window text chunking** — plus **precision@k / recall@k** set-membership scoring in `packages/evals/precision-at-k.ts`. The newest package, `@aptkit/memory`, reuses that same cosine k-NN with one new twist: **over-fetch-then-filter-then-slice** (rank a wider window, post-filter by `kind`, truncate to k — because the `VectorStore` contract can't filter during the search), plus a **per-conversation counter `Map`** for collision-free ids. There are still no balanced trees, no heaps, and no traversed graphs in this codebase — and that is not a gap to apologize for, it is the correct shape for a stateless orchestration kit over an LLM. The one thing retrieval changes: the **linear-scan → ANN/HNSW** tradeoff is now concrete (the code's own comments point at a `PgVectorStore`/HNSW drop-in), so the "graph traversal would appear here" story has a real, scale-only trigger for the first time.

You (Rein) have already built the missing half in `reincodes` — Graph, BST, BinaryHeap, PriorityQueue, Dijkstra, five sorts with visualizers. This guide does *not* re-teach those. It anchors every applied lesson to AptKit code, and where a foundation is absent it says `not yet exercised` and tells you exactly when it would start to matter here.

## Reading order

```
  read top to bottom — each builds on the last

  00-overview.md ─────────────────► the repo through a DSA lens, ranked
        │                            findings, the not-yet-exercised list
        ▼
  01-complexity-and-cost-models ──► the cost model that actually bites
        │                            here: tokens and turns, not Big-O
        ▼
  02-arrays-strings-and-hash-maps ► the load-bearing structures: Map
        │                            registry, Set allowlist, JSON scan,
        │                            + chunker & precision@k (retrieval),
        │                            + memory's per-conversation counter Map
        ▼
  03-stacks-queues-deques-heaps ──► message array as a log; round-robin
        │                            "queue"; heaps not-yet-exercised
        ▼
  04-trees-tries-balanced-indexes ► dotted-path tree walk; everything
        │                            else not-yet-exercised
        ▼
  05-graphs-and-traversals ───────► capability edges as flat set-membership;
        │                            no real traversal — but the ANN/HNSW
        │                            graph index is now a concrete trigger
        ▼
  06-sorting-searching-selection ─► comparator sort + slice top-k (anomaly
        │                            + retrieval cosine k-NN); memory recall's
        │                            over-fetch→filter→slice; binary search absent
        ▼
  07-recursion-backtracking-dp ───► the one real recursion (collectText);
        │                            backtracking + DP not-yet-exercised
        ▼
  08-dsa-foundations-practice-map ► ranked learning plan: exercised
                                     first, missing foundations second
```

## The files

| File | What it covers | Repo verdict |
| --- | --- | --- |
| `00-overview.md` | One-page orientation, ranked findings, the `not yet exercised` list | — |
| `01-complexity-and-cost-models.md` | Time/space/amortized, and why token+turn budget is the real cost axis | exercised (cost axis), reframed |
| `02-arrays-strings-and-hash-maps.md` | `Map`-backed registry, `Set` allowlist, bounded JSON scan, fixed-window chunker, precision@k/recall@k set scoring, memory's per-conversation counter `Map` | heavily exercised |
| `03-stacks-queues-deques-and-heaps.md` | Message-array log, modulo round-robin scheduler | partial; heaps/PQ `not yet exercised` (retrieval's top-k is the first heap trigger) |
| `04-trees-tries-and-balanced-indexes.md` | `getPath` dotted-path walk over JSON | thin; tries/balanced trees `not yet exercised` |
| `05-graphs-and-traversals.md` | Capability `requires`/`enriches` as flat set checks; the ANN/HNSW *graph* index retrieval gestures at | `not yet exercised` as graph (HNSW is the concrete trigger) |
| `06-sorting-searching-and-selection.md` | Comparator sort + `slice` top-k (now in retrieval too), cosine-score ranking, memory recall's over-fetch→filter→slice (post-filtered top-k), linear classify | exercised; binary search `not yet exercised` |
| `07-recursion-backtracking-and-dynamic-programming.md` | `collectText` tree recursion | minimal; backtracking/DP `not yet exercised` |
| `08-dsa-foundations-practice-map.md` | Ranked plan: what to practice and why | — |

## Cross-links to neighboring guides

- **`study-software-design`** owns *why* these structures are wrapped the way they are (deep modules, information hiding). When this guide says "the `Map` is hidden behind `InMemoryToolRegistry`," the design rationale for that hiding lives there.
- **`study-system-design`** owns the architectural shape and scale tradeoffs — the provider-neutral seam, the replay backbone. When DSA touches "why is the cost model tokens not CPU," the system shape lives there.
- **`study-ai-engineering`** owns the agent-loop and eval mechanics as *AI* concepts. This guide looks at the same code (`run-agent-loop.ts`, `structural-diff.ts`) but only through the structure-and-algorithm lens.

Where a concept seams into one of those guides, the file says so inline.
