# DSA Foundations — Practice Map

**A ranked learning plan: exercised concepts first, missing foundations second** — Project-specific.

## Zoom out, then zoom in

This is the file that turns the other seven into a plan. It ranks what to practice by *leverage for you specifically* — given your strong `reincodes` portfolio and your AI-engineering pivot, the highest-value work is not re-drilling graphs; it's mastering the exact-vs-approximate retrieval seam that aptkit and buffr straddle.

```
  Zoom out — the practice map's two tiers

  ┌─ TIER 1: exercised in aptkit — master the production shape ──┐
  │  cosine rank + top-k     (file 06, 02)  ← the load-bearing   │
  │  cost model of the scan  (file 01)                           │
  │  bounded agent loop      (file 07)                           │
  │  Set/Map membership jobs (file 02)                           │
  └───────────────────────────────────────────────────────────────┘
                                   │ then
  ┌─ TIER 2: not in aptkit — keep sharp / extend ───────────────┐
  │  HNSW (exact→approx seam) (file 04, 05)  ← cross-repo, HIGH  │
  │  heap / priority queue    (file 03)      ← you built it      │
  │  graphs BFS/DFS/Dijkstra  (file 05)      ← you built it      │
  │  trees / tries            (file 04)                          │
  │  dynamic programming      (file 07)      ← genuine gap       │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the ranking principle is leverage = (how often it appears in the work you're pivoting toward) × (how far it is from what you've already shipped). The cosine-rank seam scores high on both — it's the heart of every RAG system *and* it connects to your existing heap/graph work through HNSW. DP scores high on distance (genuine gap) but lower on AI-engineering frequency. The plan ranks accordingly.

## Structure pass

```
  layers:  what aptkit runs  →  what buffr runs  →  what you've built elsewhere
  axis held constant: "what's the highest-leverage thing to practice next?"

  ┌─ aptkit (exercised) ────────┐   master it cold — it's your demo surface
  │  cosine top-k, loop, maps    │   → you'll be asked to defend this
  └──────────────┬───────────────┘
                 │  seam: exact O(n) ═══► approximate O(log n)
  ┌─ buffr (cross-repo) ────────┐   the HIGHEST-leverage stretch
  │  HNSW graph index            │   → connects your heap/graph work to RAG
  └──────────────┬───────────────┘
                 │  seam: production ═══► curriculum
  ┌─ reincodes (built) ─────────┐   keep warm, don't re-learn
  │  heaps, graphs, BST, sorts   │   → interview muscle memory
  └──────────────────────────────┘
```

The load-bearing seam — exact scan to approximate graph — is *the* thing to be able to walk on a whiteboard. It's where your existing DSA (priority queues, graph traversal) meets the AI-engineering work you're moving into. Everything else ranks around it.

## How it works — the ranked plan

### Move 1 — the shape of the plan

```
  the practice plan — ranked by leverage for an AI-engineering pivot

  RANK  WHAT                          WHY IT'S HERE              EFFORT
  ──────────────────────────────────────────────────────────────────────
  1     defend the cosine top-k       it's aptkit's load-bearing  low
        algorithm cold                 algorithm + your demo       (you know
        (files 06, 02, 01)             surface                     it)
  2     walk HNSW as exact→approx      the highest-leverage        med
        seam on a whiteboard           stretch; bridges your       (new framing
        (files 04, 05)                 graph/heap work to RAG      of known DSA)
  3     implement a size-k heap        closes the "why full sort"  low
        top-k, compare to full sort    loop; you have BinaryHeap   (port it)
        (file 03)                                                  
  4     keep graphs/heaps warm         interview muscle; already   low
        (files 03, 05)                 shipped, don't re-learn     (review)
  5     drill dynamic programming      genuine gap, lower AI-eng    high
        (file 07)                      frequency but real          (new)
```

### Move 2 — the plan, item by item

**Rank 1 — defend the cosine top-k algorithm cold (TIER 1, exercised).** This is `in-memory-vector-store.ts:25` and you should be able to recite its complexity, its exactness, and its scale ceiling without looking. It's the load-bearing algorithm in aptkit (file 06) and the thing any interviewer probing your RAG work will push on. Done when: you can whiteboard the scan→sort→slice, state `O(n·d + n log n)`, and explain *why* it's exact and *when* it breaks — in under two minutes. Effort: low (you already understand it; this is rehearsal).

**Rank 2 — walk HNSW as the exact→approximate seam (TIER 2, cross-repo, HIGHEST leverage).** From `buffr/sql/001_agents_schema.sql:28`. This is the single highest-leverage item because it sits exactly on your pivot: it's Dijkstra's priority-queue frontier (file 05, your `PriorityQueue.ts`) aimed at "closest to query," layered for `O(log n)` (file 04), trading exactness for speed. You already own every piece — the work is *connecting* them into "here's how vector search actually scales." Done when: you can draw the layered greedy descent, name the PQ frontier and visited set, and explain the recall/latency trade vs aptkit's exact scan. Effort: medium (new framing of DSA you've already built).

**Rank 3 — implement a size-k heap top-k and benchmark vs the full sort (TIER 2, you built the heap).** Port your `reincodes/BinaryHeap.ts` into a bounded size-k top-k, run it against aptkit's `.sort().slice(k)` at varying `n`, and *find the crossover point* where the heap starts winning. This closes the loop on file 03/06's "why does aptkit use the full sort" — you'll have measured the answer, not just argued it. Done when: you have a chart (or a number) showing where `O(n log k)` overtakes `O(n log n)` for `k=5`. Effort: low (you have the heap; this is wiring + measurement). This is the kind of hands-on proof that makes the fundamental real for you (your learning loop).

**Rank 4 — keep graphs/heaps/sorts warm (TIER 2, already shipped).** Files 03, 05. You've built BFS, DFS, Dijkstra, BinaryHeap, PriorityQueue, five sorts. Don't re-learn — *review*. A weekly pass re-implementing one from memory keeps the interview muscle warm. Done when: you can re-implement BFS + a min-heap from a blank file in 15 minutes. Effort: low (maintenance, not acquisition).

**Rank 5 — drill dynamic programming (TIER 2, genuine gap).** File 07 named this honestly: DP beyond classic memoized recursion is your thinnest area, and aptkit doesn't exercise it. It ranks *fifth* not because it's unimportant but because it's the *least* connected to your AI-engineering pivot — RAG and agent loops rarely need DP. Still worth closing for general interview coverage (edit distance, knapsack, LIS, the classics). Done when: you can derive the recurrence + tabulation for edit distance and longest-common-subsequence unprompted. Effort: high (genuine new work).

### Move 3 — the principle

Practice ranks by leverage, not by syllabus order. For your pivot, the highest-value DSA work is the exact→approximate retrieval seam — because it's where the algorithms you've already shipped (heaps, graph traversal) meet the systems you're moving toward (RAG at scale). The genuine gap (DP) ranks last not because it's easy but because it's farthest from the work. Don't re-drill what you've shipped; connect it forward.

## Primary diagram

```
  the practice map — one frame, ranked

  TIER 1 (aptkit runs it — DEFEND IT)
  ┌────────────────────────────────────────────────────────┐
  │ 1. cosine top-k cold        files 06,02,01   low effort │ ← your demo surface
  └────────────────────────────────────────────────────────┘
            │ the seam: exact O(n) ═══► approximate O(log n)
            ▼
  TIER 2 (not in aptkit — RANKED BY LEVERAGE)
  ┌────────────────────────────────────────────────────────┐
  │ 2. HNSW exact→approx walk   files 04,05      med  ★HIGH │ ← bridges your work
  │ 3. size-k heap + benchmark  file 03          low       │ ← port + measure
  │ 4. graphs/heaps warm        files 03,05      low       │ ← review only
  │ 5. dynamic programming      file 07          high      │ ← genuine gap, last
  └────────────────────────────────────────────────────────┘

  you already own ranks 3–4's primitives (reincodes); the work is
  connecting them to the retrieval seam, not re-learning them
```

## Elaborate

The reason this plan inverts the textbook order (which would teach DP as advanced and retrieval as a niche application) is that *your* leverage is different from a generic CS student's. You've shipped the fundamentals; what you haven't done is wire them into production AI systems and defend that wiring under pressure. So the plan front-loads the production seam (cosine scan ↔ HNSW) and back-loads the gap (DP) — because for an AI-engineering pivot, being able to say "here's how vector search scales, and here's the priority-queue graph traversal underneath it" is worth more than another DP pattern. The hands-on benchmark at rank 3 is the move that makes it real for you — the same way the Dijkstra animation made your PriorityQueue real. Pair this with **study-ai-engineering**'s retrieval-quality work (precision@k, eval harness) and you have both halves: how the ranking is computed (here) and whether it's good (there).

## Interview defense

**Q: You've built graphs and heaps. What's the highest-value DSA thing to learn next for AI engineering?**
The exact-vs-approximate nearest-neighbor seam — specifically HNSW. It's not new machinery; it's the priority-queue graph traversal I've already built (Dijkstra-style frontier) aimed at "closest to a query vector," layered for `O(log n)`. The leverage is that it connects my existing DSA to how RAG actually scales — aptkit does the exact `O(n)` scan, the production path (pgvector HNSW) does the approximate graph walk, and I can defend the whole spectrum.

```
  what I've shipped:   heaps, BFS/DFS, Dijkstra, sorts
  what aptkit runs:    exact cosine top-k (O(n))
  the bridge to learn: HNSW = my Dijkstra frontier + layers (O(log n))
  → highest leverage: it's the seam, not a new structure
```

Anchor: "I'm not missing the structures — I'm connecting them to production retrieval. The gap is the seam, not the primitives."

**Q: What's your weakest DSA area honestly?**
Dynamic programming beyond classic memoized recursion — segment trees, union-find, harder DP. It hasn't shown up in my projects because RAG and agent loops don't need it, so it ranks last in my practice plan by *leverage*, not importance. I'm closing it with the standard set (edit distance, LCS, knapsack) for interview coverage.

## See also

- `00-overview.md` — the repo-grounded vs curriculum-only split this plan ranks
- `06-sorting-searching-and-selection.md` — rank 1's algorithm
- `04-trees-tries-and-balanced-indexes.md` / `05-graphs-and-traversals.md` — rank 2's HNSW seam
- `03-stacks-queues-deques-and-heaps.md` — rank 3's size-k heap
- **study-ai-engineering** — the retrieval-quality half of the same work
- **study-performance-engineering** — measuring rank 3's crossover point
