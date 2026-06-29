# Stacks, Queues, Deques & Heaps

**LIFO/FIFO ordering disciplines · double-ended queues · binary heaps & priority queues** — Industry standard. **Status in aptkit: `not yet exercised`.**

## Zoom out, then zoom in

Be honest up front: aptkit runs none of these as an explicit structure. There's no stack, no queue, no heap, no priority queue in the code. This file teaches the family, shows the one place a priority queue would be a *latent fit*, and points at where you've already built it (`reincodes`, `BinaryHeap.ts`/`PriorityQueue.ts`).

```
  Zoom out — where ordering disciplines would sit (none active)

  ┌─ Service layer — packages/runtime ───────────────────────────┐
  │  agent loop: messages[] grows append-only                    │
  │    NOT a queue — no dequeue, never drained                   │ ← looks like a
  │  call stack: parseAgentJson recursion is shallow             │   queue, isn't
  └───────────────────────────────┬───────────────────────────────┘
                                   │
  ┌─ Storage layer — packages/retrieval ─────────────────────────┐
  │  top-k selection: full sort + slice(k)                       │ ← a HEAP would
  │    in-memory-vector-store.ts:31  hits.sort(...).slice(k)     │   fit here ★
  │  the priority queue is the latent fit for top-k              │   (not used)
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: these are all *ordering disciplines* — rules for which element comes out next. A stack pops the most-recently-pushed (LIFO). A queue pops the oldest (FIFO). A deque does both ends. A heap pops the min or max in `O(log n)`. The priority queue is a heap with a "smallest key first" contract. The latent fit in aptkit is the heap, for top-k — covered as a real alternative in file 06.

## Structure pass

```
  layers:  the discipline  →  the structure  →  the pop cost
  axis held constant: "which element comes out next, and what does it cost?"

  ┌─ stack (LIFO) ──────────────┐   pop = newest;  push/pop O(1)
  │  recursion's call stack      │   → reverse-order processing
  └──────────────┬───────────────┘
                 │  seam: pop order flips newest → oldest
  ┌─ queue (FIFO) ──────────────┐   pop = oldest;  enqueue/dequeue O(1)
  │  BFS frontier, task buffers  │   → fairness, breadth-first
  └──────────────┬───────────────┘
                 │  seam: pop order flips oldest → BEST (by priority)
  ┌─ heap / priority queue ─────┐   pop = min/max;  push/pop O(log n)
  │  top-k, Dijkstra frontier    │   → ordering by key, not arrival
  └──────────────────────────────┘
```

The seam that matters for aptkit is the bottom one. aptkit's top-k uses a full sort (`O(n log n)`) then takes `k`. A heap pops the top-k in `O(n log k)` — strictly better when `k ≪ n`. aptkit doesn't reach for it; file 06 explains why the full sort is still the right call *today* and when it stops being.

## How it works

### Move 1 — the mental model

A heap is a binary tree kept in an array where every parent is `≤` its children (a min-heap). That one invariant means the smallest element is always at index 0 — `O(1)` to peek, `O(log n)` to remove (bubble the last element down to restore the invariant). A priority queue is just a heap with a friendly API: `enqueue(item, priority)` / `dequeue()` returns lowest priority.

```
  min-heap — parent ≤ children, smallest at the root

           [3]              array: [3, 5, 8, 9, 7]
          ╱   ╲              index:  0  1  2  3  4
        [5]   [8]            parent(i) = (i-1)/2
       ╱  ╲                  child(i)  = 2i+1, 2i+2
     [9]  [7]

  pop min:  return [3], move [7] to root, bubble down → O(log n)
  the visited/sorted illusion: you NEVER fully sort — you only
  maintain "min at root," which is the whole trick
```

You built exactly this in `reincodes/BinaryHeap.ts` (heapifyUp/heapifyDown) and wrapped it as `PriorityQueue.ts` with a value→index lookup for `updatePriority` — the structure Dijkstra's animation drains. So this is review for you; the aptkit-relevant point is *where it would slot in here* and why it doesn't.

### Move 2 — where a heap would fit aptkit (and why it doesn't, yet)

**The top-k selection — a priority queue is the latent fit.** Look at `in-memory-vector-store.ts:31`:

```ts
  hits.sort((a, b) => b.score - a.score);   // ← O(n log n): sorts ALL n hits
  return hits.slice(0, Math.max(0, k));     // ← then throws away all but k
```

This sorts every hit to keep `k` of them — wasted work when `k ≪ n`. The heap version keeps a **bounded min-heap of size k**: scan all `n` scores, push each, and whenever the heap exceeds `k`, pop the smallest. At the end the heap holds the top-k. Cost: `O(n log k)` instead of `O(n log n)`.

```
  bounded top-k heap — the algorithm aptkit could use but doesn't

  keep a MIN-heap of size k (smallest of the kept-so-far at root)

  for each score s in the n hits:
    if heap.size < k:        push s
    else if s > heap.peek(): pop min, push s   // s beats the worst kept
    else:                    discard s          // s can't make top-k

  result: heap holds the k largest, cost O(n log k)
  vs aptkit's O(n log n) full sort — better when k ≪ n
```

Walk the boundary condition: when `k` approaches `n`, `log k ≈ log n` and the heap wins nothing — you've added complexity for no gain. aptkit's `k` defaults to 5 and `n` is small (in-memory, a handful of docs), so `O(n log n)` on a tiny `n` is *faster in practice* than maintaining a heap — fewer allocations, native `.sort()`, no per-element heap ops. **That's why aptkit uses the sort: at this `n`, the simpler structure wins.** The heap becomes correct exactly when `n` is large and `k` stays small — and at *that* point you'd reach for buffr's HNSW index instead, which sidesteps the whole scan (file 06).

**The agent loop's `messages[]` is not a queue.** Worth naming to kill a tempting misread. `run-agent-loop.ts:94` builds `messages: ModelMessage[]` and only ever `.push()`es to it — it's an append-only log, never dequeued. The conversation grows; nothing is consumed FIFO. Calling it a queue would be wrong: there's no drain end. It's an accumulating array (file 02), full stop.

**There is no queue, no deque, no work buffer.** aptkit is request-scoped and synchronous — one agent loop, one retrieval, return. No background workers, no task scheduling, no fan-out frontier. A queue shows up when you have producers and consumers decoupled in time; aptkit has neither. `not yet exercised`, and honestly so.

### Move 3 — the principle

The ordering discipline you pick *is* the algorithm — a BFS is a queue, a top-k is a heap, a backtracker is a stack. aptkit's top-k uses a full sort because at a small `n` the simpler structure beats the asymptotically-better one. The lesson isn't "always use a heap"; it's "the heap wins only when `k ≪ n` *and* `n` is large enough for the constant to pay off."

## Primary diagram

```
  stacks/queues/heaps in aptkit — one frame (mostly negative space)

  EXERCISED?   structure        where it would go            verdict
  ──────────────────────────────────────────────────────────────────
  stack        recursion stack  parseAgentJson (shallow)     incidental
  queue        —                no producer/consumer split   not exercised
  deque        —                —                            not exercised
  heap / PQ    bounded top-k    in-memory-vector-store:31  ★ LATENT FIT
                                (aptkit uses full sort; heap
                                 wins only when k ≪ n, large n)

  you've BUILT these: reincodes/BinaryHeap.ts, PriorityQueue.ts
  aptkit doesn't run them — drill target, not repo evidence
```

## Elaborate

The heap (Williams, 1964, for heapsort) is the canonical answer to "I need the best `k`, not all `n` sorted." Its reach in real systems is everywhere top-k or scheduling matters: Dijkstra's frontier (which your `PriorityQueue.ts` powers), k-nearest-neighbor, event simulation, OS run-queues, rate-limiter timers. aptkit's omission is correct for its scale — but the *next* version of the lesson is HNSW, which is a graph layered with priority-queue-driven greedy search (file 05): the search frontier in HNSW *is* a priority queue. So the heap you built isn't absent from the production story — it's hiding inside the ANN index in buffr.

## Interview defense

**Q: aptkit sorts all hits then slices k. When would you use a heap instead?**
A bounded min-heap of size `k` gets top-k in `O(n log k)` vs the full sort's `O(n log n)` — strictly better when `k ≪ n`. But it's only worth it when `n` is large; at aptkit's small in-memory `n` with `k=5`, the native `.sort()` is faster in practice (fewer allocations, no per-element heap ops). And once `n` is genuinely large, you don't reach for a heap — you reach for an ANN index like buffr's HNSW that avoids scanning all `n` at all.

```
  full sort   O(n log n)   simple, wins at small n   ← aptkit
  size-k heap O(n log k)   wins when k ≪ n, large n
  ANN index   O(log n)     wins at huge n            ← buffr (HNSW)
```

Anchor: "The sort isn't a mistake — at this `n` the simpler structure wins; the heap is the *middle* answer between full sort and an index."

**Q: Is the agent loop's message list a queue?**
No — it's append-only, never dequeued. A queue has a drain end (FIFO consume); `messages[]` only grows as the conversation accumulates. Calling it a queue would miss that there's no consumer. It's an accumulating array.

## See also

- `06-sorting-searching-and-selection.md` — the top-k the heap would optimize, and why the sort wins today
- `05-graphs-and-traversals.md` — HNSW's greedy search frontier is a priority queue
- `02-arrays-strings-and-hash-maps.md` — the accumulating `messages[]` array (not a queue)
- `08-dsa-foundations-practice-map.md` — heap/PQ as a "keep sharp" drill, not repo evidence
