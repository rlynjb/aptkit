# 00 — Overview: the AptKit runtime, in one frame

Before any concept, the whole machine. AptKit runs in two runtimes — Node.js (the Studio dev server, the `scripts/*.mjs` entry points, the per-package test runner) and the browser (the React/Vite Studio UI). Both are single-threaded. The unit of concurrency in both is *not* a thread — it's an awaited Promise scheduled on one event loop.

```
  AptKit runtime map — two single-threaded event loops, NDJSON between them

  ┌─ Browser runtime (1 event loop) ───────────────────────────────────┐
  │  React Studio UI                                                    │
  │    fetch('/api/stream/...')  ──►  decodeNdjsonStream (async gen)    │
  │    onEvent(event) → setState → re-render                            │
  └───────────────────────────────┬─────────────────────────────────────┘
                                   │  HTTP POST, response = NDJSON stream
                                   │  (one record per line, flushed live)
  ┌─ Node runtime (Vite dev server, 1 event loop) ─▼────────────────────┐
  │  middleware handler (async)                                         │
  │    └─► runReplay() ──► Agent.propose() ──► runAgentLoop()           │
  │                                                │                     │
  │         ┌──────────── the bounded loop ────────▼──────────┐         │
  │         │ for turn 0..maxTurns:                            │         │
  │         │   signal.throwIfAborted()   ← cancellation check │         │
  │         │   await model.complete()    ← network I/O task   │         │
  │         │   for each tool_use:                             │         │
  │         │     await tools.callTool()  ← sequential, 1@time │         │
  │         └──────────────────────┬────────────────────────────┘       │
  │                                │ each emit() → res.write(ndjson)     │
  └────────────────────────────────┘                                    │
            │                                                            │
  ┌─ Provider SDK boundary ────────▼───────────────────────────────────┐
  │  Anthropic / OpenAI SDK → HTTPS → model API (awaited, signal-aware) │
  └─────────────────────────────────────────────────────────────────────┘
```

Everything below the UI is *one Node process, one thread, one loop*. The "parallelism" you might expect — running tool calls at once, fanning out fixture replays — is **not here**. Work is strictly sequential `await` inside `for` loops. That's the single most important fact about this runtime, and it's a deliberate fit for an LLM agent loop where each step depends on the last.

## The through-line question

> Where does work execute, what does it own, and what breaks under concurrency or overload?

For AptKit the answers are unusually clean:
- **Where:** one event loop per runtime; tasks are awaited Promises, never threads.
- **Owns:** each run owns its own `messages` array and `toolCalls` array on the stack/heap of one async call tree — no shared mutable state between runs.
- **Breaks under concurrency:** almost nothing, *because there is no in-process concurrency to break*. The race surface is the filesystem (two promotes writing the same path) and the provider API (rate limits), not in-memory state.
- **Breaks under overload:** the loop is bounded (`maxTurns`, `maxToolCalls`, `maxTokens`, `MAX_TOOL_RESULT_CHARS`), so a runaway agent is capped — but there's **no backpressure** on the NDJSON stream and **no timeout** on the awaited model call.

## Ranked findings — what to look at first

The teacher's verdict, most consequential first. Evidence in `08-runtime-systems-red-flags-audit.md`.

1. **The bounded agent loop is the heart of the runtime, and it's well-bounded.** Four independent budgets cap a single run: `maxTurns` (default 8, recommendation 6), `maxToolCalls` (recommendation 4), `maxTokens` (4096), and `MAX_TOOL_RESULT_CHARS` (16,000). The `forceFinal` flag strips tools on the last turn so the model *must* answer instead of looping forever. `run-agent-loop.ts:98-135`, `:52-57`. This is the load-bearing mechanism — see `07`.

2. **Cancellation is threaded end-to-end via one `AbortSignal`, but it's cooperative — it only fires at `await` boundaries.** `signal?.throwIfAborted()` at the top of every turn (`run-agent-loop.ts:99`), passed into `tools.callTool` (`:159`), into `model.complete` (`:108`), through the fallback chain (`fallback-provider.ts:52,65`), down to the SDK's native `{ signal }` (`anthropic-provider.ts:38`, `openai-provider.ts:47`), and into the stream decoder (`ndjson-stream.ts:112,123`). A synchronous hot loop would ignore it — there isn't one here. See `07`.

3. **Tool calls run strictly one at a time — no `Promise.all`.** The loop `await`s each tool inside a `for...of` (`run-agent-loop.ts:139-189`). When a model requests three independent tools in one turn, they execute serially. Same in every `scripts/*.mjs` (`for...of` + `await`, e.g. `replay-promoted-fixtures.mjs:28-40`). Correct for dependent steps; leaves latency on the table for independent ones. See `02`, `08`.

4. **NDJSON streaming has no backpressure.** The Studio handler calls `res.write(...)` per event and never checks the return value or waits for `drain` (`vite.config.ts:906-909`). For human-paced agent traces this never matters; under a flood of events to a slow client it buffers unboundedly in the Node process. See `06`, `08`.

5. **The awaited model call has no timeout.** `await model.complete()` can hang as long as the SDK's own defaults allow; the only escape is the external `AbortSignal`. There's no `Promise.race` against a deadline in the loop. See `07`, `08`.

## `not yet exercised` — honestly absent

These are real runtime-systems topics that this repo does **not** contain. Each file marks where it's relevant and what would introduce it.

- **Worker threads / `Worker` / `worker_threads`.** No multi-threading anywhere. Verified: no `worker_threads`, `new Worker`, `SharedArrayBuffer`, or `Atomics` in any source file. (Rein built a *separate* real-time on-device ML pipeline in `contrl` with Worklets-core + a frame-rate latency budget — that's the closest thing in the portfolio to a hot-path worker, but it lives in another repo, not here.) See `02`.
- **Process pools / clustering / `child_process` fan-out.** Scripts are single sequential Node processes. No `cluster`, no worker pools. See `02`.
- **Mutexes / semaphores / locks / atomics.** No shared mutable state across concurrent tasks means nothing to lock. See `04`.
- **Manual memory management / object pools / arena allocation.** V8 GC handles everything; no `Buffer` pooling or manual frees. See `05`.
- **Stream backpressure handling (`drain`, `pipe`, highWaterMark tuning).** Streaming is fire-and-forget `res.write`. See `06`.
- **Deadlines / per-call timeouts / graceful shutdown handlers.** No `Promise.race(timeout)`, no `process.on('SIGTERM')` drain. See `07`.

## Why this is the right frame

An LLM agent loop is *inherently* sequential — turn N's tool results are turn N+1's input. Threads buy you nothing when each step waits on the previous one's network round-trip. The honest runtime story here isn't "they forgot to parallelize" — it's "the workload is a chain of dependent awaited I/O, and the single-threaded event loop is exactly the right tool for that." The interesting engineering is in the *bounds* (budgets) and the *escape hatch* (cancellation), not in concurrency primitives. That's where files 07 and 08 spend their time.
