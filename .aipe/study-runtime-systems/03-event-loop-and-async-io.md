# Event Loop and Async I/O — await points, queues, and the one blocking scan

**Industry name(s):** event loop / async I/O · microtask vs macrotask queue · event-loop blocking · **Type:** Industry standard

## Zoom out, then zoom in

Every `await` in aptkit is a handoff to the event loop. This file is about what the loop does between your awaits — and the one place aptkit hands it a CPU job it can't put down.

```
  Zoom out — where the event loop sits under aptkit

  ┌─ aptkit logic (JS) ───────────────────────────────────────────────┐
  │   runAgentLoop · generateStructured · cosine scan · JSON.parse     │
  └──────────────────────────────────┬─────────────────────────────────┘
                                      │ await (yields the thread)
  ┌─ ★ Event loop (libuv) ★ ──────────▼─────────────────────────────────┐ ← we are here
  │   microtask queue (Promises)  ·  macrotask queue (I/O callbacks)    │
  └──────────────────────────────────┬─────────────────────────────────┘
                                      │ non-blocking syscalls
  ┌─ OS / kernel ─────────────────────▼─────────────────────────────────┐
  │   sockets (HTTP to Ollama/cloud) · timers · fs                      │
  └──────────────────────────────────────────────────────────────────────┘
```

**Zoom in.** The event loop is the scheduler from `02`, made concrete. It runs your synchronous code to completion, then drains the microtask queue (settled Promises), then picks up the next macrotask (an I/O callback), and repeats. The rule that governs aptkit's responsiveness: **the loop can only switch tasks at an `await` or when your synchronous code returns.** A long synchronous stretch with no `await` freezes everything. aptkit has exactly one such stretch worth knowing.

## Structure pass

Trace the **lifecycle** axis — *when* does each piece of work touch the loop?

```
  Axis: "when does this hit the event loop?" — across a single agent run

  ┌────────────────────────────────────────────────┐
  │ await model.complete()   → YIELDS: registers I/O │  loop free, can run other tasks
  └───────────────────┬──────────────────────────────┘
      ┌───────────────▼──────────────────────────────┐
      │ JSON.parse(response) → SYNC: runs to end       │  loop blocked, but tiny
      └───────────────┬──────────────────────────────┘
          ┌───────────▼──────────────────────────────┐
          │ cosine scan over corpus → SYNC: runs to end │  loop BLOCKED for O(n·d)
          └─────────────────────────────────────────────┘
```

The seam: **the boundary between an `async` signature and whether the body actually `await`s.** `InMemoryVectorStore.search` is declared `async` but its body has no `await` (`in-memory-vector-store.ts:25`) — it returns a Promise, but it never yields the loop while computing. That's the trap: the signature *looks* like it cedes control; the execution doesn't. Identifying that flip is the whole point of reading the loop before the mechanics.

## How it works

### Move 1 — the mental model

You know loading states: a `fetch()` fires, your component shows a spinner, and the UI stays interactive because the browser's event loop keeps running while the request is in flight. Node's loop is the same machine. The danger is also the same: a synchronous loop that runs too long is the server-side equivalent of a `while(true)` freezing your browser tab.

```
  The loop's cycle — and where a sync scan jams it

  ┌──────────────┐   run sync code    ┌──────────────┐
  │ pick macro-  │ ─────────────────► │ drain micro- │
  │ task (I/O cb)│                    │ tasks (Promise│
  └──────▲───────┘                    │ continuations)│
         │                            └──────┬────────┘
         │      ◄──────── loop ──────────────┘
         │
   if a sync task (cosine scan) runs 200ms here,
   NOTHING in either queue advances for 200ms
```

The strategy: **keep every synchronous span short so the loop cycles fast, and push all latency into awaited I/O.** aptkit honors this everywhere except the vector scan, which is async-shaped but synchronous-bodied.

### Move 2 — the await points and the one block

**Await point: the model call.** `run-agent-loop.ts:103` — `await model.complete(...)`. This is a clean yield. Under the hood it reaches `gemma-provider.ts:204`:

```ts
const res = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  ...(signal ? { signal } : {}),
});
```

`fetch` is non-blocking I/O: it registers the socket with libuv and the `await` suspends the agent-loop task. The thread is free until the response macrotask fires. This is aptkit's bread-and-butter — almost all wall-clock time is spent suspended here.

**Await point: the embedding call.** `pipeline.ts:40` — `await wiring.embedder.embed(texts)`. Same shape: an HTTP round-trip to Ollama's embed endpoint, all chunk texts batched into one request body, one yield.

**The block: the cosine scan.** `in-memory-vector-store.ts:25` — the method that *looks* async but never yields:

```ts
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {          // ← O(n) loop, no await
    hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
  }
  hits.sort((a, b) => b.score - a.score);              // ← O(n log n) sort, sync
  return hits.slice(0, Math.max(0, k));
}
```

And the inner cost, `in-memory-vector-store.ts:46`:

```ts
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i += 1) {              // ← d iterations (768 for nomic)
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  // ...
}
```

```
  Cost of one search — pure CPU, on the loop thread

  n chunks × d dims =  n × 768 multiply-adds  +  n log n sort
  ─────────────────────────────────────────────────────────────
  n = 50    →   ~38K ops      → microseconds, invisible
  n = 50,000 →  ~38M ops      → tens of ms, the loop is frozen
                                for that whole span
```

At aptkit's actual scale — a handful of docs indexed in tests and the Studio demo — `n` is tiny and this is invisible; running it inline is the right call (no async overhead, dead simple, perfectly traceable). The honest statement is: **this is the one place in the repo where CPU work sits on the loop thread with no yield, and it's the first thing that bites if the corpus ever grows.** The escape hatch is `worker_threads` (move the scan off-thread) or, more likely, swapping in buffr's `PgVectorStore` so the scan happens in Postgres over a network `await` instead of inline. The contract is identical (`VectorStore`), so it's a wiring change, not a rewrite — `pipeline.ts:73` shows the seam.

**Microtasks: the retry loops.** Both the Gemma provider (`gemma-provider.ts:62`) and `generateStructured` (`structured-generation.ts:62`) are `for` loops that `await` a model call each iteration. Each iteration yields the loop at its `await`; the retry itself isn't a busy-wait. So a 2-attempt structured generation is "yield, parse, maybe yield again" — never a tight spin.

**No timers in the hot path.** No `setInterval`, `setImmediate`, or `queueMicrotask` anywhere in `packages/` or `scripts/`. The only `setTimeout` is one `window.setTimeout` in a Studio UI component for a transient panel — browser-side, off the runtime path. So aptkit's loop is driven entirely by I/O completion and Promise settling, not by timers.

### Move 3 — the principle

The event loop rewards code that yields often and punishes code that doesn't. The async/await syntax hides which is which — an `async` function that never `await`s is a synchronous function wearing a Promise costume, and it blocks the loop exactly as if you'd called it synchronously. The discipline: when you see `async`, ask "does the body actually yield, or just the signature?" In aptkit that question has one interesting answer (the cosine scan) and that single answer tells you precisely where the only event-loop risk lives and exactly how to relieve it — swap the store implementation behind the contract.

## Primary diagram

The complete loop view: clean yields at I/O, one synchronous block, retry loops that yield each iteration.

```
  aptkit on the event loop — complete

  ┌─ JS thread ──────────────────────────────────────────────────────────┐
  │                                                                        │
  │  runAgentLoop turn:                                                    │
  │    await model.complete() ──► fetch ──► [SUSPEND] ◄── response macrotask│
  │         │ loop free here                                               │
  │    JSON.parse(result)      ──► sync, tiny block                        │
  │    InMemoryVectorStore.search() ──► SYNC LOOP, O(n·d)+sort, [BLOCKS]    │
  │         ▲                                                              │
  │         └── the one place async signature ≠ actual yield               │
  │                                                                        │
  │  retry loops (gemma, generateStructured):                              │
  │    for attempt: await complete() ──► yields each iteration (no spin)   │
  │                                                                        │
  │  queues: microtask (Promise continuations) · macrotask (I/O callbacks) │
  │  drivers: I/O completion only — no timers in the hot path              │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "async function that doesn't await" footgun is one of Node's most common production incidents: a CPU-heavy handler declared `async` gives the false comfort that it's non-blocking, and under load it stalls every concurrent request because they all share the one thread. aptkit's cosine scan is the textbook case, defused only by small `n`. The standard fixes are all available behind the `VectorStore` contract: move to a real ANN index (HNSW, IVF) so search is sub-linear; offload to `worker_threads`; or push it to a database with vector support (pgvector) so the cost becomes a network `await` that yields. aptkit's design — the swappable contract — is precisely what makes that future change cheap. See `study-performance-engineering` for measuring the crossover point, and `05` for the memory side of the same `Map`.

## Interview defense

**Q: Is `InMemoryVectorStore.search` blocking the event loop?**

```
  signature: async  →  looks like it yields
  body:      for-loop over n chunks, cosine (d=768), full sort
             ZERO awaits inside
  verdict:   yes — it blocks the loop for its whole O(n·d + n log n) span
  safe today because n is tiny (demo/test corpus)
  fix behind the same contract: worker_threads OR swap to PgVectorStore
```

Anchor: "It's `async` in signature but synchronous in body — the one place in the repo CPU work sits on the loop thread with no yield."

**Q: What drives aptkit's event loop — timers or I/O?**

```
  I/O completion (fetch responses) + Promise settling
  no setInterval / setImmediate / queueMicrotask in the runtime
  retry loops await each iteration — they yield, they don't spin
```

Anchor: "It's purely I/O-driven — every advance is a settled HTTP Promise, never a timer tick."

## See also

- `02-processes-threads-and-tasks.md` — the single thread the loop runs on
- `05-memory-stack-heap-gc-and-lifetimes.md` — the `Map` the scan iterates and its memory growth
- `07-backpressure-bounded-work-and-cancellation.md` — how `signal.throwIfAborted()` interrupts the loop between awaits
- `study-performance-engineering` — measuring when the inline scan's cost crosses over
