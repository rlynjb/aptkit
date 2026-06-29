# Study — Runtime Systems (aptkit, as-built)

Where does work execute, what does it own, and what breaks under concurrency or overload? This guide answers that for aptkit specifically — the bounded agent loop, the provider transports, the in-memory vector scan, the NDJSON stream, and the Studio browser app — grounded in real files.

## Verdict first — the shape of execution in this repo

```
  aptkit's runtime, in one frame

  ┌─ Process boundary: ONE Node process (CLI / test / Vite dev server) ─────┐
  │                                                                          │
  │   ┌─ libuv event loop ─────────────────────────────────────────────┐   │
  │   │                                                                  │   │
  │   │   runAgentLoop ──await──► model.complete() ──await──► tools      │   │
  │   │   (sequential for-loop)   (HTTP via fetch)            (await)     │   │
  │   │         │                                                        │   │
  │   │         └── CPU work runs INLINE on this one thread:             │   │
  │   │             cosine scan, JSON.parse, sort — no worker offload    │   │
  │   └──────────────────────────────────────────────────────────────────┘ │
  │                                                                          │
  │   No worker_threads · no child_process (except npm pack) · no cluster    │
  │   No SIGTERM/SIGINT handler · no graceful shutdown · single process      │
  └──────────────────────────────────────────────────────────────────────────┘
                              │ NDJSON over HTTP (Studio dev server only)
                              ▼
  ┌─ Browser process: apps/studio (React 18, its own event loop) ───────────┐
  │   fetch() → ReadableStream.getReader() → decodeNdjsonStream (async gen)   │
  └──────────────────────────────────────────────────────────────────────────┘
```

The call here: **aptkit is a single-process, single-threaded, async-I/O-bound TypeScript runtime.** Almost everything that takes time is a network `await` (an HTTP call to Ollama or a cloud SDK). The CPU work that exists — cosine similarity, JSON parsing, array sorts — runs inline on the same event-loop thread and is small at current scale. There is no thread pool you wrote, no worker, no OS-level parallelism. The Studio is a separate browser process with its own event loop, reached only over HTTP NDJSON.

## The most consequential mechanisms, ranked

1. **The bounded agent loop (`runAgentLoop`, `packages/runtime/src/run-agent-loop.ts:76`).** A sequential `for` loop with a hard `maxTurns` bound, a `maxToolCalls` budget, a forced final synthesis turn, and `signal.throwIfAborted()` at the top of every iteration. This is the single most important runtime structure in the repo — every agent's execution, cost, and cancellation behavior flows through it. → `02`, `07`.

2. **The in-memory cosine scan (`InMemoryVectorStore.search`, `packages/retrieval/src/in-memory-vector-store.ts:25`).** The one place real CPU work happens in the hot path — an `async` method with no `await` inside, doing an O(n·d) loop plus a full sort, blocking the event loop for its whole duration. Fine at corpus sizes of dozens; the first thing that bites under scale. → `03`, `05`.

3. **The sequential fallback chain (`FallbackModelProvider.complete`, `packages/providers/fallback/src/fallback-provider.ts:47`).** A try/catch `for` loop over providers, each `await`ed in turn, with abort short-circuiting. Combined with Gemma's retry loop and structured-generation's retry, aptkit's failure handling is "retry in sequence, never in parallel." → `02`, `07`.

## Reading order

```
  01-runtime-map                          the process / task / resource map as-built
   ↓
  02-processes-threads-and-tasks          one process, async tasks, no threads
   ↓
  03-event-loop-and-async-io              the libuv loop, await points, the blocking scan
   ↓
  04-shared-state-races-and-synchronization   why single-thread JS sidesteps most races
   ↓
  05-memory-stack-heap-gc-and-lifetimes   allocation, the buffered-everything choices, GC
   ↓
  06-filesystem-streams-and-resource-lifecycle   fs.promises, the NDJSON stream, descriptors
   ↓
  07-backpressure-bounded-work-and-cancellation  maxTurns, AbortSignal, the missing pieces
   ↓
  08-runtime-systems-red-flags-audit      ranked execution-model risks
```

## `not yet exercised` in this repo

These are real runtime-systems concerns the codebase does not currently touch. Each file says when it would become relevant.

- **OS threads / `worker_threads` / `cluster`** — none anywhere. All CPU work is on the main thread. (`02`, `05`)
- **`child_process` for real work** — only `spawnSync` in `scripts/pack-core-standalone.mjs:68` to shell out to `npm pack`; never for concurrent or hot-path work. (`02`)
- **Filesystem streaming** — every file read/write is buffered (`fs.promises.readFile`/`writeFile`); no `createReadStream`/`createWriteStream`. (`06`)
- **Backpressure on the producer side** — the agent loop has no queue, no concurrency limiter (`p-limit`), no rate limiter. Bounds are on iteration count, not on throughput. (`07`)
- **Signal handling / graceful shutdown** — no `process.on('SIGTERM'/'SIGINT')`, no drain-then-exit. (`07`)
- **Locks / atomics / channels / shared-memory concurrency** — none, and on a single thread mostly unnecessary; the one shared-state seam is the `lastSelectedProvider` mutation. (`04`)
- **Parallel fan-out** — no `Promise.all`/`allSettled`/`race` over independent work anywhere in `packages/`. Embedding, indexing, and provider fallback are all strictly sequential. (`02`, `03`)

## Partition — what lives here vs next door

```
  study-runtime-systems   HOW code executes inside one machine/runtime (this guide)
  study-system-design     WHERE components live, how requests cross boundaries
  study-distributed-systems  coordination across processes under partial failure
  study-performance-engineering  measuring + optimizing the costs named here
  study-networking        the HTTP/transport layer the awaits sit on
```

Cross-links to neighbors appear at the seams inside each file.
