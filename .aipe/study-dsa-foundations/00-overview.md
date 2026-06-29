# DSA Foundations — aptkit

The reusable data-structures-and-algorithms vocabulary behind aptkit — and the foundations the repo deliberately does *not* exercise yet.

You've shipped a DSA portfolio already: `Graph.ts`, `BinaryHeap.ts`, `PriorityQueue.ts`, `BinarySearchTree.ts`, five animated sorters, BFS over a river-crossing state graph. This guide is **not** here to re-teach you BFS. It does two things instead:

1. Names which of those fundamentals aptkit actually *reaches for* in production code — and which it pointedly doesn't.
2. Calibrates the gap: aptkit is a RAG/agent toolkit, so it lives almost entirely in the **array + map + linear-scan + ranking** corner of DSA. The graph/tree/heap/DP machinery you've built from scratch is, in this repo, `not yet exercised`.

---

## The repo-grounded map — what DSA aptkit actually runs

```
  aptkit through the DSA lens — which structures light up

  ┌─ Service layer (agents) ───────────────────────────────────┐
  │  runAgentLoop  →  bounded for-loop + state machine          │
  │  (packages/runtime/src/run-agent-loop.ts)                   │
  │     control: a counted loop with a forced-final escape      │
  └───────────────────────────┬─────────────────────────────────┘
                              │ calls tools
  ┌─ Tool layer ──────────────▼─────────────────────────────────┐
  │  filterToolsForPolicy  →  Set membership (allowlist)        │
  │  (packages/tools/src/tool-policy.ts)                        │
  │  parseAgentJson        →  bounded substring scan / tolerant │
  │  (packages/runtime/src/json-output.ts)     parse            │
  └───────────────────────────┬─────────────────────────────────┘
                              │ search_knowledge_base
  ┌─ Retrieval layer ─────────▼─────────────────────────────────┐
  │  chunkText      →  sliding window over a string             │
  │  InMemoryVectorStore.search → linear scan + cosine + sort   │
  │                              + top-k slice  ★ the core DSA ★ │
  │  recall()       →  Map<id,counter> + over-fetch + filter    │
  │  (packages/retrieval/*, packages/memory/*)                  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ scored by
  ┌─ Eval layer ──────────────▼─────────────────────────────────┐
  │  scorePrecisionAtK / scoreRecallAtK → Set ∩ over top-k      │
  │  (packages/evals/src/precision-at-k.ts)                     │
  └──────────────────────────────────────────────────────────────┘
                              │ production drop-in (companion repo)
  ┌─ buffr / Provider layer ──▼─────────────────────────────────┐
  │  PgVectorStore → HNSW graph index (ANN)                     │
  │  (buffr/sql/001_agents_schema.sql, vector_cosine_ops)       │
  │  THE one real graph algorithm in the whole system —         │
  │  and it lives in the companion repo, not aptkit.            │
  └──────────────────────────────────────────────────────────────┘
```

The whole system is, structurally, **one ranking problem wrapped in one bounded loop**. Everything load-bearing reduces to: turn text into a vector, scan an array, sort by score, take the top-k. That's the spine. The graph appears exactly once — as the HNSW index in buffr — and it's the production substitute for aptkit's linear scan.

---

## Ranked findings — what to look at first

**1. The single most consequential algorithm is a linear scan, and that's a deliberate `O(n)`-per-query tradeoff, not an oversight.** `InMemoryVectorStore.search` (`packages/retrieval/src/in-memory-vector-store.ts:25-33`) walks *every* chunk, computes cosine similarity against each, sorts the full hit list, and slices the top-k. For a from-scratch teaching pipeline with a few docs, that's the right call — it's deterministic, dependency-free, and trivially correct. The cost it accepts: linear in corpus size on every single query. The production answer is buffr's HNSW index (an approximate-nearest-neighbor *graph*), which trades exactness for sub-linear lookup. This swap — array linear-scan → ANN graph — is *the* DSA story of this repo. Read **02** and **05**.

**2. The agent loop is a bounded state machine whose load-bearing part is the part people forget — the forced-final turn.** `runAgentLoop` (`packages/runtime/src/run-agent-loop.ts:98-190`) is a `for (turn = 0; turn < maxTurns; …)` loop. The kernel isn't the iteration — it's `forceFinal = turn === maxTurns - 1 || budgetSpent` (line 102), which strips the tools on the last turn and forces synthesis. Drop that and the loop can spin to the cap producing no answer. Read **01** (cost models / amortized) and the loop walk in **07**.

**3. aptkit is array-and-map shaped; your graph/tree/heap portfolio is `not yet exercised` here.** No tree, no heap, no graph traversal, no DP runs anywhere in aptkit's source. The top-k selection in `search` *could* use a heap (your `BinaryHeap.ts`) instead of a full sort — and at corpus scale it would — but the in-memory store sorts the whole array because `n` is tiny. This is the honest gap: the repo doesn't punish you for not knowing graphs; it simply doesn't use them. The curriculum files (**03**, **04**, **05**, **07**) teach those foundations and say plainly where they *would* enter if aptkit grew.

---

## Reading order

```
  01  complexity-and-cost-models          ← the lens for every file below
  02  arrays-strings-and-hash-maps        ← REPO-GROUNDED: the spine
  03  stacks-queues-deques-and-heaps      ← curriculum + top-k heap seam
  04  trees-tries-and-balanced-indexes    ← curriculum + the HNSW seam
  05  graphs-and-traversals               ← curriculum + the ONE real graph (HNSW)
  06  sorting-searching-and-selection     ← REPO-GROUNDED: the ranking sort + top-k
  07  recursion-backtracking-and-dp       ← partial: bounded loop, no DP/backtracking
  08  dsa-foundations-practice-map        ← ranked plan: exercised first, gaps second
```

Read **01** first — it's the cost lens you hold over every other file. Then **02** and **06** are the dense repo-grounded core. **03–05** and **07** are mostly curriculum, each with one honest seam back into aptkit.

---

## Repo-grounded vs curriculum-only

```
  topic                              status in aptkit
  ─────────────────────────────────  ───────────────────────────────────
  arrays / strings / hash-maps       REPO-GROUNDED — the whole spine
  sorting / searching / selection    REPO-GROUNDED — ranking sort + top-k slice
  complexity / cost models           REPO-GROUNDED — analyzes the above
  bounded iteration / state machine  REPO-GROUNDED — runAgentLoop
  set / map membership               REPO-GROUNDED — tool policy, id counters, p@k
  heaps / priority queues            NOT YET EXERCISED — would replace the top-k sort
  trees / tries / balanced indexes   NOT YET EXERCISED — HNSW (a graph) is in buffr
  graphs / BFS / DFS / shortest path NOT YET EXERCISED in aptkit; ONE graph in buffr (HNSW)
  recursion / backtracking           NOT YET EXERCISED — the loop is flat, not recursive
  dynamic programming                NOT YET EXERCISED — no overlapping-subproblem code
```

---

## See also — cross-guide seams

- **`study-ai-engineering`** owns the *retrieval pipeline as an AI system* — embeddings, RAG, agentic retrieval. This guide owns the *data structures and algorithms* underneath it (the array scan, the cosine math, the top-k). When you want "why RAG," go there; when you want "what's the cost of `search`," stay here.
- **`study-database-systems`** owns buffr's pgvector storage engine, the HNSW index build, and query execution. This guide names HNSW as the ANN *graph structure* (file **05**); the storage-engine mechanics live there.
- **`study-performance-engineering`** owns the measurement and budgets (the latency of the linear scan, the token budget of the loop). This guide names the *asymptotic* cost; that guide measures the *wall-clock* cost.
