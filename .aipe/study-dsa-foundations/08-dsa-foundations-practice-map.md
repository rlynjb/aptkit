# DSA Foundations — Practice Map

**Industry name(s):** learning plan · spaced practice schedule — *Project-specific*

The ranked plan. Exercised-in-aptkit concepts first (deepen what's load-bearing and shippable), missing foundations second (curriculum you've built before but the repo doesn't run). This is calibrated to *you* — you've already shipped graphs, heaps, BSTs, and five sorts from scratch, so the gaps aren't "learn BFS"; they're "see where the structures you own would re-enter this codebase."

---

## Zoom out, then zoom in

Where every DSA topic sits relative to aptkit's actual code — what's load-bearing, what's latent, what's absent.

```
  Zoom out — the practice landscape, ranked by repo leverage

  ┌─ TIER 1: exercised + load-bearing (deepen these) ───────────┐
  │  arrays/strings/maps  → the spine (file 02)                 │
  │  sorting/selection    → the ranking sort (file 06)          │
  │  complexity/cost      → the lens over both (file 01)        │
  │  bounded state machine→ the agent loop (file 07)            │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ TIER 2: latent — the problem is here, structure isn't ─────┐
  │  heaps / top-k        → would replace the full sort (file 03)│
  │  trees / indexes      → would replace the scan (file 04)    │
  │  graphs / ANN         → HNSW lives in buffr (file 05)       │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ TIER 3: absent by problem-shape (curriculum only) ─────────┐
  │  backtracking · DP    → wrong shape for expensive LLM steps │
  │  tries · union-find   → no prefix / disjoint-set query      │
  │  segment trees        → no range-aggregate query            │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the plan isn't "study DSA." It's "make the Tier-1 structures so reflexive you can defend the design tradeoffs, then practice the Tier-2 structures *as the scaling answer to aptkit's specific bottleneck*, then keep Tier-3 sharp as portfolio breadth — knowing the repo doesn't need it."

---

## Structure pass

**Axis — repo leverage:** how directly does practicing this concept improve your grip on *this* codebase?

```
  One axis — "does practicing this deepen my grip on aptkit?"

  Tier 1 → YES, directly — it's the code you ship and defend
  Tier 2 → YES, as the scaling story — the swap when n grows
  Tier 3 → NO for aptkit — portfolio breadth, not repo depth
```

**Seam — Tier 1→2 is the scaling boundary.** Tier 1 is "aptkit as it runs today (small `n`)." Tier 2 is "aptkit at scale" — the exact point where the full sort becomes a heap, the scan becomes an index, the array becomes a graph. Practicing Tier 2 *as the answer to a Tier-1 bottleneck* is higher-leverage than practicing it abstractly.

---

## The ranked plan

### Tier 1 — exercised + load-bearing (do first)

These are in the hot path. The goal isn't to learn them — you know them — it's to *defend the tradeoffs* fluently.

**1. Cost models over the two hot paths (file 01).**
- *Drill:* For `InMemoryVectorStore.search`, write the cost in terms of `n` (chunks) and `d` (768) separately, then state which term dominates at `n=50` vs `n=50,000`. Then do the same for `runAgentLoop` and explain why the model call dwarfs the scan.
- *Done when:* you can say, without notes, "the scan is `O(n·d)` but the leading recurring cost in a real run is `O(maxTurns)` model calls, each >> the scan."

**2. The ranking sort + top-k selection (file 06).**
- *Drill:* Rewrite `search`'s top-k three ways — full sort + slice (current), bounded min-heap (`O(n log k)`), quickselect (`O(n)` unordered) — and write down the exact condition (`k`, `n`, ordered-vs-not) under which each wins. You've built the heap (`BinaryHeap.ts`); wire it in and benchmark against the sort at `n=10`, `n=1000`, `n=100000`.
- *Done when:* you can justify the full sort at small `n` and name the crossover where the heap wins.

**3. The array/map/set primitive choices (file 02).**
- *Drill:* Explain why the store is `Map` for storage but `Array` for ranking, why tool policy is a `Set`, and why `recall` uses a `Map` counter — each in one sentence tied to the access pattern.
- *Done when:* you can predict, for a new feature, which primitive its access pattern demands.

**4. The bounded agent loop as a state machine (file 07).**
- *Drill:* Diagram `runAgentLoop`'s three termination conditions from memory and explain what breaks if you remove the forced-final tool-stripping.
- *Done when:* you can name the forced-final turn as the loop's enforced base case unprompted.

### Tier 2 — latent (do second, as the scaling story)

The problem is in aptkit; the structure isn't (yet). Practice these *as aptkit's scaling answer*, not abstractly.

**5. Heaps for top-k at scale (file 03).**
- *Drill:* Take your `PriorityQueue.ts` and build the size-k min-heap top-k; prove it returns the same top-k as the sort on random data; benchmark the crossover `n`.
- *Why it earns its place:* it's the first thing you'd reach for if profiling showed the sort hot — and you've already built the heap.

**6. The HNSW graph traversal (file 05) — the highest-value Tier-2 item.**
- *Drill:* Read buffr's `chunks_embedding_hnsw` index and the `order by embedding <=> $1` query. Then sketch the greedy best-first traversal it runs and map each part to your `Graph.ts` BFS kernel (frontier/visited/expand/terminate). Articulate exactly what HNSW gives up (exactness) and gains (sub-linear lookup).
- *Why it earns its place:* this is the single most important DSA fact about the production system — the one real graph — and it's a small step from the traversals you've animated.

**7. Indexes vs scans (file 04).**
- *Drill:* Explain why a B-tree can't index the 768-dim embedding (no scalar order) but does index buffr's `id`/`app_id` columns, and why that forces the vector index to be a graph.
- *Why it earns its place:* it's the conceptual bridge that makes file 05 click — the "why a graph and not a tree" answer.

### Tier 3 — absent by problem-shape (keep sharp, low repo leverage)

Portfolio breadth, not aptkit depth. The honest note: aptkit's problem shape (no overlapping subproblems, expensive steps, no prefix/disjoint/range queries) means these would *not* improve your grip on this repo. Keep them for general interview readiness, not for understanding aptkit.

```
  topic            why absent in aptkit                practice for
  ───────────────  ──────────────────────────────────  ─────────────
  backtracking     steps are expensive model calls →   general DSA
                   one bounded retry, no search tree    interviews
  dynamic prog.    no subproblem repeats (each turn's   general DSA
                   input is the growing conversation)   interviews
  tries            no prefix query over a string set    general DSA
  union-find       no disjoint-set / connectivity query general DSA
  segment trees    no range-aggregate query             general DSA
```

For these, your existing portfolio (`Graph.ts`, `Tree.ts`, the recursion visualizers, `PG.ts`'s state-space BFS) is the right reference — they just don't map onto aptkit.

---

## Primary diagram

The full plan in one frame, ranked by leverage.

```
  aptkit DSA practice map — ranked by repo leverage

  DO FIRST (Tier 1 — shipped, defend the tradeoffs)
   1. cost models (01)        ── two hot paths, dominant term
   2. ranking sort/top-k (06) ── 3 ways, name the crossover
   3. array/map/set (02)      ── primitive per access pattern
   4. bounded loop (07)       ── forced-final = enforced base case

  DO SECOND (Tier 2 — the scaling story, structures you own)
   5. heap top-k (03)         ── wire your PriorityQueue, benchmark
   6. HNSW traversal (05) ★   ── the one real graph; map to your BFS
   7. indexes vs scans (04)   ── why vectors need a graph not a tree

  KEEP SHARP (Tier 3 — breadth, NOT aptkit depth)
   backtracking · DP · tries · union-find · segment trees
   absent because aptkit's problem shape doesn't call for them

  ★ = highest-value single item: the production vector index is a graph
```

---

## Elaborate

The reason Tier 1 sits above Tier 2 even though Tier 2 is "harder": interview and design value comes from defending the *choices in the code that ships*, not from reciting structures the code doesn't use. "Why a full sort here and not a heap" is a stronger signal than "I can implement a red-black tree" — it shows you reason about `n`, `k`, and simplicity-vs-asymptotics in context. Tier 2 is ranked by its connection to a *real bottleneck* (the scan), which is why HNSW is the standout: it's the actual production answer, one short hop from traversals you've already built and animated.

Tier 3's honesty is the point of this guide. A DSA study guide that pretended aptkit exercises DP or tries would be inventing findings to fill a template. It doesn't, and saying so — with the problem-shape reason (expensive steps, no overlapping subproblems, no prefix/range/disjoint queries) — is more useful than a fake anchor. Your portfolio already covers these; this repo just isn't where they live.

---

## Interview defense

**Q: What DSA does this repo actually exercise, and what would you study to scale it?**

> Exercised and load-bearing: arrays/maps/sets as the spine, a cosine-keyed full sort with top-k slice as the ranking, and a bounded iterative state machine as the agent loop. To scale it I'd study the Tier-2 trio in order: a size-k heap to replace the full sort once `n` is large and `k << n`; then the real answer, an HNSW proximity graph — the one actual graph in the system, which lives in the companion repo and runs a greedy best-first traversal to get sub-linear lookup at the cost of exactness; and the index-vs-scan reasoning that explains why vectors need a graph, not a B-tree.

```
  Tier1 (ship/defend) → Tier2 (scale: heap → HNSW → indexes) → Tier3 (breadth)
```

**Q: Why isn't there DP or backtracking?**

> Problem shape. DP needs overlapping subproblems — each agent turn's input is the growing conversation, never a recomputed sub-input, so there's nothing to memoize. Backtracking needs cheap steps to explore-and-undo — each step here is an expensive model call, so aptkit does one bounded recovery turn, not a retry tree. They're absent because the shape doesn't call for them, not because they were overlooked.

Anchor: *Tier 1 is defending the code that ships; Tier 2 is the scaling swap (sort→heap→HNSW); Tier 3 is breadth the repo's problem shape doesn't reach for.*

---

## See also

- **00-overview.md** — the repo-grounded map and the repo-grounded-vs-curriculum table.
- **01–07** — each tiered concept in full.
- `study-performance-engineering` — when to actually trigger the Tier-2 scaling swaps (measured, not guessed).
- `study-database-systems` — the HNSW / index mechanics behind Tier-2 items 6 and 7.
