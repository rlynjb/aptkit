# Stacks, Queues, Deques & Heaps

**Industry name(s):** LIFO stack · FIFO queue · double-ended queue · binary heap / priority queue — *Industry standard*

> **Status in aptkit: `not yet exercised` as explicit structures.** No `Stack`, `Queue`, `Deque`, or `Heap` class runs anywhere in aptkit's source. You've built `BinaryHeap.ts` and `PriorityQueue.ts` from scratch — this file is mostly curriculum, with **one real seam**: the top-k selection in `search` is precisely the problem a heap solves, and the repo solves it with a full sort instead. That seam is the lesson.

---

## Zoom out, then zoom in

These ordering disciplines don't appear as data structures in aptkit — but the *problem one of them solves* is sitting in the hottest path. Here's where a heap *would* live if the corpus grew.

```
  Zoom out — the one place an ordering discipline is latent

  ┌─ Retrieval layer ───────────────────────────────────────────┐
  │  InMemoryVectorStore.search:                                │
  │    hits.sort(...)        ← FULL sort: O(n log n)            │
  │    .slice(0, k)          ← then keep top-k                  │
  │                                                              │
  │    ★ a MIN-HEAP of size k would do this in O(n log k) ★      │
  │       (the curriculum seam — not what the repo does)        │
  └──────────────────────────────────────────────────────────────┘

  ┌─ everywhere else ───────────────────────────────────────────┐
  │  no stack, no queue, no deque, no priority queue            │
  │  the agent loop is a flat counted for-loop, not a work queue│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a heap is a priority-ordered structure where the min (or max) is always at the root, `O(log n)` to insert or extract. The top-k retrieval problem — "give me the k highest-scoring chunks" — is the textbook use case. aptkit chooses a full sort instead, and that choice is correct *for now* for a reason worth understanding.

---

## Structure pass

**Layers (curriculum):** stack (LIFO, call-stack/undo), queue (FIFO, work scheduling), deque (both ends), heap (priority extraction).

**Axis — ordering discipline:** trace "what determines what comes out next?"

```
  One axis — "what comes out next?" — across the four structures

  stack  → the LAST thing in        (LIFO)   — recursion, undo
  queue  → the FIRST thing in       (FIFO)   — BFS frontier, job queue
  deque  → either end, your choice            — sliding-window maxima
  heap   → the HIGHEST PRIORITY one (by key) — top-k, Dijkstra, scheduling
```

**Seam — full-sort vs heap-select at the top-k boundary.** aptkit's `search` answers "what comes out next?" with "sort everything, take the front k." A heap answers it with "maintain only the k best." The axis-answer (how ordering is achieved) flips across that seam — and it's the only place in aptkit where one of these structures is even relevant.

---

## How it works

### Move 1 — the mental model (the heap, and the seam)

You built `BinaryHeap.ts` with `heapifyUp`/`heapifyDown` and a `PriorityQueue.ts` on top of it — so the mechanism is yours already. The shape: a binary heap is an array where each parent is `≤` (min-heap) or `≥` (max-heap) its children, so the extreme element is always at index 0. Top-k via a heap is "keep a min-heap of size k; for each new score, if it beats the heap's min, evict the min and insert."

```
  Pattern — top-k via a bounded min-heap (the seam aptkit does NOT take)

  maintain heap of size k=3, min at root:

  scores stream in: 0.9  0.3  0.7  0.8  0.2  0.95 …
  heap (min at top):
    [0.9]              insert 0.9
    [0.3, 0.9]         insert 0.3
    [0.3, 0.9, 0.7]    insert 0.7      ← heap full (size 3)
    0.8 > min(0.3)?    yes → evict 0.3, insert 0.8 → [0.7,0.9,0.8]
    0.2 > min(0.7)?    no  → skip
    0.95 > min(0.7)?   yes → evict 0.7, insert 0.95 → [0.8,0.9,0.95]

  result: the 3 highest, in O(n log k) — never sorted the rest
```

Versus what aptkit *actually* does: sort all `n` then slice — `O(n log n)`, simpler code, exact ties handled by sort stability. The heap is the asymptotic win when `k << n`; the sort wins on simplicity when `n` is small.

### Move 2 — the walkthrough

#### The repo's choice: full sort + slice, not a heap

Here's the actual top-k in aptkit, and it's deliberately *not* a heap:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:31-32
hits.sort((a, b) => b.score - a.score);   // sort ALL n hits: O(n log n)
return hits.slice(0, Math.max(0, k));     // keep top-k: O(k)
```

Why the full sort and not your `PriorityQueue.ts`? Three reasons, all honest tradeoffs:

1. **`n` is tiny.** The in-memory store holds a handful of docs. `O(n log n)` and `O(n log k)` are indistinguishable at `n = 50`. The heap's win only shows up when `k << n` with large `n`.
2. **The full sorted list is sometimes useful.** `recall` over-fetches `max(k*4, 20)` then filters by `kind` (`conversation-memory.ts:94`) — it wants *more* than k from the sort, so a size-k heap would be the wrong tool there anyway.
3. **Simplicity is correctness.** `Array.sort` is one line, battle-tested, and stable. A hand-rolled bounded heap is more code to get wrong — and you'd only reach for it under a measured latency need.

The boundary condition where this flips: once `n` is large (tens of thousands of chunks) *and* you only need a small `k`, the full sort wastes work ordering chunks you'll throw away. That's the point where you'd reach for either a heap-based partial sort or — better — an index that never scans all `n` (file **04**, **05**).

#### Why there's no queue in the agent loop

A natural instinct: "isn't the agent loop a work queue?" No — and naming why teaches the queue concept by contrast. `runAgentLoop` (`run-agent-loop.ts:98`) is a flat counted `for` loop with a fixed bound. There's no frontier of pending work to dequeue, no FIFO ordering of tasks. Each turn is: call model, maybe execute the tools it asked for *immediately* (`run-agent-loop.ts:139-187`), append results, repeat. Tools are processed in the order the model returned them — an array iteration, not a queue with enqueue/dequeue discipline. If aptkit ever did *speculative multi-step planning* with a backlog of pending sub-tasks, a queue (or priority queue, by expected value) would enter. It doesn't, so it hasn't.

```
  Contrast — what aptkit has vs what a work-queue would be

  aptkit (flat loop):           a work-queue agent (NOT aptkit):
  for turn in 0..maxTurns:        queue = [root_task]
    resp = model.complete()       while queue not empty:
    for tool in resp.tools:         task = queue.dequeue()  ← FIFO/priority
      run immediately               subtasks = expand(task)
                                     queue.enqueue(subtasks) ← frontier grows
```

### Move 3 — the principle

**A full sort is a heap you didn't bother to bound — and at small `n` that's the right call.** The top-k problem always *can* use a heap; whether it *should* depends on whether `k << n` and whether `n` is large enough for the asymptotic gap to beat the simplicity of `sort().slice()`. aptkit picks simplicity because its `n` is small and it sometimes wants more than `k` anyway. Knowing *when* the heap earns its place — not reflexively reaching for it — is the senior move.

---

## Primary diagram

The seam in one frame: what aptkit does, and the heap it could grow into.

```
  Top-k selection — aptkit's choice vs the heap alternative

  CURRENT (aptkit, small n):
    all hits ──► Array.sort (O(n log n)) ──► slice(0,k) ──► top-k
    + simple, exact, stable; sometimes over-fetches >k (recall)
    − orders n-k chunks it discards

  CURRICULUM SEAM (large n, k << n):
    stream hits ──► size-k min-heap ──► drain ──► top-k
    + O(n log k), never fully sorts
    − more code; only helps when k << n AND n large

  BETTER AT SCALE (file 04/05):
    don't scan n at all ──► ANN index (HNSW) ──► ~O(log n) candidates
    the real production answer (buffr's PgVectorStore)
```

---

## Elaborate

The binary heap was invented for heapsort (1964) and is the backbone of priority queues — Dijkstra's algorithm, event-simulation schedulers, top-k streaming, Huffman coding. The "bounded min-heap for top-k" pattern is one of the most common real-world heap uses: log aggregators, search rankers, and recommendation systems all keep a size-k heap to find the best results over a large stream without sorting it. Your `PriorityQueue.ts` with `updatePriority` is exactly the variant Dijkstra needs (decrease-key) — a step beyond what top-k requires.

aptkit hasn't reached for any of this because its retrieval set is small and its loop is flat. The honest framing: the heap is a *latent* structure here — the problem exists (top-k), the structure that solves it optimally is one you've built, and the repo correctly declines to use it until the input size justifies it. That's not a gap in your knowledge; it's a gap in the repo's *need*.

---

## Interview defense

**Q: aptkit does top-k retrieval. Why a full sort and not a heap?**

> Because `n` is small. The full sort is `O(n log n)`, a size-k min-heap is `O(n log k)` — but with a few dozen chunks they're indistinguishable, and the sort is one stable, correct line versus a hand-rolled heap. There's also a case where the heap is the *wrong* tool: `recall` over-fetches `max(k*4, 20)` from the sort to filter by metadata afterward, so it wants more than k. I'd switch to a bounded heap only when `n` is large, `k << n`, and a profile shows the sort costing real latency — and even then I'd prefer an ANN index that never scans all `n`.

```
  sort+slice: O(n log n), simple, exact   ← aptkit (small n)
  size-k heap: O(n log k), k<<n large n
  ANN index:  ~O(log n), no full scan     ← production (buffr HNSW)
```

**Q: Is the agent loop a queue?**

> No — it's a flat counted `for` loop with a fixed turn bound, not a frontier you enqueue/dequeue. Tools requested in a turn run immediately in array order. A queue would enter only if the agent did speculative multi-step planning with a backlog of pending sub-tasks; aptkit's loop is single-track, so there's no work queue.

Anchor: *the top-k heap is latent in aptkit — the problem is there, the structure is correct to defer until `k << n` at large `n`.*

---

## See also

- **06-sorting-searching-and-selection.md** — the full sort aptkit uses instead of a heap, and partial-selection alternatives.
- **02-arrays-strings-and-hash-maps.md** — the hit array the sort operates on.
- **05-graphs-and-traversals.md** — HNSW, the structure that removes the need to rank all `n` at all.
- **08-dsa-foundations-practice-map.md** — where heap practice lands in the plan.
