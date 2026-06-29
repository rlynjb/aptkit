# Study — Runtime Systems (aptkit)

*The execution model inside the repo: where work runs, what it owns, and what breaks under concurrency or overload.*

aptkit is a provider-neutral TypeScript monorepo that runs on **one Node process, on one thread, on one event loop**. Everything below hangs off that fact. There are no worker threads, no child processes in the request path, no cluster, no real OS-level parallelism anywhere in the product code. The only `child_process` import in the whole tree is `spawnSync` inside a packaging script (`scripts/pack-core-standalone.mjs:5`) — build-time, not runtime. So when you ask "where does work execute," the honest answer for aptkit is: *right here, on this one stack, one task at a time.*

That sounds like a limitation. It's actually the design. aptkit is a library of agent capabilities (the bounded loop, provider adapters, a from-scratch RAG pipeline, episodic memory) that gets *consumed* by a deployment "body" — buffr — which owns the real process lifecycle and durable storage. aptkit's job is to be a clean set of `async` functions and classes that a host can call. The runtime concerns it actually exercises are narrow and sharp:

- **A bounded `async` loop** (`runAgentLoop`) that drives a model–tool conversation under hard iteration and tool-call budgets, threaded end-to-end with an `AbortSignal`.
- **`async`/`await` over network I/O** — every model call and embedding call is a `fetch()` to a local Ollama HTTP endpoint, awaited on the event loop.
- **One synchronous CPU loop that matters** — the cosine-similarity scan in `InMemoryVectorStore.search`, which runs to completion on the event loop and blocks everything else while it does.
- **NDJSON streaming** out of the Studio dev server, written chunk-by-chunk to an HTTP response.

## The runtime in one diagram

```
  aptkit — one process, one thread, one event loop

  ┌─ Node process (single) ───────────────────────────────────────┐
  │                                                                │
  │   call stack (one)            event loop (libuv underneath)    │
  │   ┌──────────────┐            ┌─────────────────────────────┐  │
  │   │ runAgentLoop │            │ macrotask queue             │  │
  │   │  await ──────┼───────────►│  (fetch callbacks, timers)  │  │
  │   │              │            ├─────────────────────────────┤  │
  │   │ cosine scan  │◄── BLOCKS  │ microtask queue             │  │
  │   │  (sync, O(n·d))│  the loop │  (Promise .then continuations)│ │
  │   └──────────────┘            └─────────────────────────────┘  │
  │                                                                │
  │   no threads · no workers · no child_process in hot path       │
  └────────────────────────────────┬───────────────────────────────┘
                                    │  fetch() over HTTP (awaited)
                          ┌─────────▼──────────┐
                          │ Ollama :11434      │  local model + embeddings
                          └────────────────────┘
```

## The ranked findings — what to look at first

**1. The bounded agent loop is the load-bearing runtime mechanism, and its budget is the whole point.** `runAgentLoop` (`packages/runtime/src/run-agent-loop.ts:76-202`) is a `for` loop over turns with two hard ceilings — `maxTurns` and `maxToolCalls` — plus a *forced final synthesis turn* that strips the tools away so the model has to answer instead of asking for more data (`run-agent-loop.ts:101-109`). Strip the budget out and a confused local model loops forever calling `search_knowledge_base`. This is the single most important thing to understand in the repo's execution model. → `03-event-loop-and-async-io.md`, `07-backpressure-bounded-work-and-cancellation.md`.

**2. Cancellation is threaded correctly and completely; shutdown is not threaded at all.** Every `async` entry point takes an `AbortSignal` and calls `signal?.throwIfAborted()` at each await boundary — the loop (`run-agent-loop.ts:99`), every provider (`gemma-provider.ts:53,63`, `fallback-provider.ts:52`, `context-window-guard.ts:58`), the tool registry (`tool-registry.ts:55`), the embedder (`ollama-embedding-provider.ts:51`), and the NDJSON stream (`ndjson-stream.ts:112,123`). That's textbook cooperative cancellation. But there is **no `SIGTERM`/`SIGINT` handler anywhere** in the product code — graceful shutdown is `not yet exercised` here because aptkit isn't the process owner; buffr is. → `07-backpressure-bounded-work-and-cancellation.md`.

**3. There is exactly one synchronous hot loop, and it sits on the event loop with no yield.** `InMemoryVectorStore.search` (`packages/retrieval/src/in-memory-vector-store.ts:25-33`) scans every chunk and computes a full cosine similarity (`O(n·d)`, d = 768) in a tight `for` loop, then sorts. No `await` inside it, so for the duration of the scan nothing else on the event loop runs — not other requests, not timers, not the GC's incremental work. At demo corpus sizes this is microseconds and invisible. It's named here because it's the one place in aptkit where CPU work and the event loop collide, and it's the seam where `PgVectorStore` (in buffr) moves the scan off-process. → `03-event-loop-and-async-io.md`, cross-link `study-performance-engineering`.

## `not yet exercised` in this repo

- **Threads / workers / `worker_threads`** — none. All work is on the main thread.
- **Multi-process / `cluster` / child processes in the request path** — none (`spawnSync` is build-only).
- **Real concurrency** — no `Promise.all`, `Promise.race`, or `Promise.allSettled` in product code; awaits are strictly sequential. Concurrent fan-out is `not yet exercised`.
- **Backpressure / a concurrency limiter / a queue** — none. Nothing bounds *how many* loops run at once; the bounds are *within* one loop.
- **Graceful shutdown** — no `SIGTERM` handler, no in-flight-request draining.
- **Shared mutable state across concurrent tasks** — the only mutable instance state (`GemmaModelProvider.toolUseCount`) is safe *only because* there's no real concurrency. → `04-shared-state-races-and-synchronization.md`.
- **Manual GC tuning / heap-limit configuration / streams with explicit backpressure** — none; relies on V8 defaults and full-buffer reads.

## Reading order

```
  01-runtime-map                      the process/task/resource map as-built
  02-processes-threads-and-tasks      why it's one thread, what a "task" is here
  03-event-loop-and-async-io          the await chain + the one blocking scan
  04-shared-state-races               why no locks are needed (yet)
  05-memory-stack-heap-gc             allocation shape, the full-buffer reads
  06-filesystem-streams-lifecycle     fs reads + NDJSON streaming + handle cleanup
  07-backpressure-bounded-cancellation  the budget, the signal, the missing shutdown
  08-runtime-systems-red-flags-audit  ranked execution-model risks
```

## Cross-links to neighboring guides

- **`study-performance-engineering`** — the cost of the `O(n·d)` cosine scan, the full-buffer reads, and where batching/limits would go. This guide says *where* work runs; that one says *how fast and how expensive*.
- **`study-distributed-systems`** — the fallback chain, partial failure across providers, and what happens when aptkit's single process is one node in buffr's larger system.
- **`study-networking`** — the `fetch()` transport, HTTP semantics against Ollama, timeouts, and retries. This guide treats the network call as "an await that suspends the loop"; that one treats it as a protocol exchange.
- **`study-system-design`** — *where* components live and how requests cross the aptkit↔buffr boundary, vs. this guide's *how code executes inside one machine*.
