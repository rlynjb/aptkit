# Processes, Threads, and Tasks — where work actually runs

**Industry name(s):** process/thread model · task scheduling (async tasks) · **Type:** Industry standard (Node single-threaded event loop)

## Zoom out, then zoom in

aptkit's answer to "where does work run" is short: one process, one thread, many *tasks*. The interesting part is what a "task" is when there are no threads to put it on.

```
  Zoom out — the three scheduling levels, only one is real here

  ┌─ OS level: PROCESSES ─────────────────────────────────────────────┐
  │   one Node process per run (test / script / dev server)           │
  │   parallel? only if you launch several — aptkit never forks workers │
  └────────────────────────────────────┬───────────────────────────────┘
  ┌─ Runtime level: THREADS ────────────▼───────────────────────────────┐
  │   exactly ONE JS thread. no worker_threads, no cluster.            │ ← the whole story
  │   ★ all aptkit logic is scheduled here ★                          │
  └────────────────────────────────────┬───────────────────────────────┘
  ┌─ Language level: TASKS ─────────────▼───────────────────────────────┐
  │   Promises / async functions — interleaved on the one thread        │
  │   a "task" = an async function suspended at an await                │
  └──────────────────────────────────────────────────────────────────────┘
```

**Zoom in.** When people say "tasks" in a multi-threaded runtime they mean units of work a scheduler hands to threads. In aptkit there's no thread pool to hand work to — a "task" is just an `async` function call that suspends at an `await` and resumes when its Promise settles. The scheduler is the JS event loop. That's the model; the mechanics are how aptkit's loops sit on top of it.

## Structure pass

Trace the **failure** axis across the three levels — where can a unit of work die, and what does it take down with it?

```
  Axis: "if this unit fails, what dies?" — across scheduling levels

  ┌──────────────────────────────────────────────┐
  │ PROCESS: an unhandled throw at top level      │  → the whole run exits
  └───────────────────┬────────────────────────────┘
      ┌───────────────▼──────────────────────────┐
      │ THREAD: n/a — one thread = process         │  → no thread to lose independently
      └───────────────┬──────────────────────────┘
          ┌───────────▼──────────────────────────┐
          │ TASK: an await rejects                 │  → the awaiting function's
          │ (caught in try/catch in the loop)      │    Promise rejects; loop decides
          └─────────────────────────────────────────┘
```

The seam that matters: **thread = process.** Because there's one thread, there's no isolation between "tasks" — a synchronous CPU loop in one task (the cosine scan) blocks *every* other pending task until it finishes. The flip side: there's also no shared-memory race between tasks, because only one runs at a time (`04` builds on this). The single-thread choice buys safety and costs isolation.

## How it works

### Move 1 — the mental model

You know this from the browser: `setTimeout`, `fetch().then()`, `await` — none of them spawn a thread. They register work that the event loop picks up later, on the same thread. A "task" is a continuation, not a worker.

```
  Tasks on one thread — interleaving, not parallelism

  thread:  ████ task A runs ████─await─░░░░░░░░░░─████ A resumes ████
                                 │              ▲
                                 │ task B can   │ when A's Promise
                                 ▼ run here      settles, A is re-queued
                              ████ task B ████

  two tasks "in flight" — but never two running at the same instant
```

The strategy aptkit uses: **express every slow operation as an awaited Promise so the one thread can interleave tasks, and never schedule work onto threads because there are none.** Concurrency exists (multiple agent runs could be in flight); parallelism does not (no two run simultaneously).

### Move 2 — the agent loop as the task scheduler

The clearest place to see aptkit's task model is `runAgentLoop`. It *is* a hand-written sequential scheduler: a `for` loop where each iteration is "do one model call, then do its tool calls," strictly in order.

```
  runAgentLoop as a sequential task driver — run-agent-loop.ts:98

  for turn in 0..maxTurns:
      signal?.throwIfAborted()              // ← cancellation check, every turn
      response = await model.complete(...)  // ← TASK 1: suspend on HTTP
      for each toolUse in response:
          result = await tools.callTool(...) // ← TASK 2..n: one tool at a time
      append results, loop
```

**The model call is one suspended task.** Real code, `run-agent-loop.ts:103`:

```ts
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,
  maxTokens,
  signal,
});
```

The `await` here is where the thread is free. While this Promise is pending, the OS is doing the HTTP work to Ollama or the cloud; the event loop could run another task if one were queued. This is the only "task switch" that matters in aptkit — at an I/O boundary.

**Tool calls run strictly one at a time.** `run-agent-loop.ts:139`:

```ts
for (const toolUse of toolUses) {
  // ...
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  // ...
}
```

This is a deliberate, and arguably suboptimal, choice. If a model returns three tool calls in one turn, aptkit `await`s them sequentially — call one, wait, call two, wait, call three. They're independent; they could be `Promise.all`'d for lower wall-clock latency. They aren't. The call was right at this scale (tool calls are mostly local synchronous work or single HTTP calls, and sequential is simpler to trace and to attribute cost to), but it's the obvious first lever if tool latency ever dominates. Name it in an interview: "tool calls within a turn are sequential, not fanned out — that's the latency I'd parallelize first."

**There is no fan-out anywhere.** Grep confirms zero `Promise.all`, `Promise.allSettled`, `Promise.race`, or `p-limit` across `packages/`. Every multi-item operation is a sequential loop:

```
  Three places that COULD parallelize but don't

  ┌─ tool calls in a turn ────────────┐  run-agent-loop.ts:139  → sequential await
  ┌─ provider fallback chain ─────────┐  fallback-provider.ts:50 → sequential (correct: it's
  │                                    │                            try-next-on-failure, not fan-out)
  ┌─ embedding a batch of chunks ─────┐  pipeline.ts:40           → one embed() call,
  │                                    │                            batched server-side (good)
  └────────────────────────────────────┘
```

The fallback chain *should* be sequential — it's "try A, if A fails try B," which is inherently ordered. The embedding batch is already efficient — `embedder.embed(texts)` sends all chunk texts in one HTTP request (`pipeline.ts:40`), so the batching happens server-side in Ollama. The tool-call loop is the only one where sequential is a latency choice rather than a correctness requirement.

**Processes: the one place aptkit spawns.** `scripts/pack-core-standalone.mjs:68`:

```ts
const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
```

`spawnSync` — synchronous, blocking. It shells out to `npm pack` during the publish flow, waits for it to finish, reads the exit code. This is a build-time script, not runtime, and `Sync` means it doesn't even use the event loop — it blocks the thread until the child exits. Correct for a sequential build step; it would be wrong in a request path.

### Move 3 — the principle

A single-threaded task model is a trade: you give up CPU parallelism and task isolation, and you get freedom from data races and a dramatically simpler mental model. aptkit takes that trade everywhere — which is the right default for an I/O-bound system where the expensive thing is always a network call, not a computation. The skill is knowing the *one* place the trade bites: when CPU work grows large enough that running it inline stalls every other task. That's the cosine scan, and it's why `worker_threads` is the named escape hatch in `05` and `08`, not used today but the correct move the day the corpus gets big.

## Primary diagram

The complete picture: one process, one thread, tasks interleaved at await points, no parallelism.

```
  aptkit's scheduling model — complete

  ┌─ ONE Node process ──────────────────────────────────────────────────┐
  │  ┌─ ONE JS thread (event loop) ─────────────────────────────────────┐ │
  │  │                                                                    │ │
  │  │  runAgentLoop  ──(for turn)──►  await model.complete()  ──┐       │ │
  │  │       │                          (task suspends here)      │ HTTP  │ │
  │  │       │                                                    │       │ │
  │  │       └──(for toolUse)──► await tools.callTool() ──────────┤ HTTP  │ │
  │  │                            ↑ sequential, one at a time     │       │ │
  │  │                                                            │       │ │
  │  │  cosine scan / JSON.parse / sort ── run INLINE, block ─────┘       │ │
  │  │                                                                    │ │
  │  │  ✗ no worker_threads  ✗ no cluster  ✗ no Promise.all fan-out      │ │
  │  └────────────────────────────────────────────────────────────────────┘ │
  │  build-time only: spawnSync('npm pack') — blocking, off hot path        │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Node's single-threaded model came from the observation that web servers spend almost all their time waiting on I/O, so threads (with their memory and context-switch cost, and their locking hazards) were the wrong tool — an event loop over non-blocking I/O does the same job with one thread. aptkit fits that thesis perfectly: it's a thin orchestration layer over LLM and embedding HTTP calls. The model breaks down precisely when work becomes CPU-bound rather than I/O-bound — which is the cosine scan's future. Node's answer to *that* is `worker_threads` (true OS threads with message-passing, no shared mutable state by default), and that's the escape hatch aptkit would reach for. See `study-distributed-systems` for the multi-process coordination story (buffr's runtime), and `study-performance-engineering` for measuring when the inline-CPU bet stops paying off.

## Interview defense

**Q: How many threads does aptkit use, and what's a "task" in this codebase?**

```
  threads: ONE (no worker_threads / cluster / new Worker anywhere)
  a task  = an async function suspended at an await
  scheduler = the JS event loop; runAgentLoop is a hand-written
              sequential driver over those tasks
```

Anchor: "It's a single-threaded async-task model — `runAgentLoop` is literally a `for` loop that awaits one model call then its tool calls in order."

**Q: Name a place the code could parallelize but chose not to, and why.**

```
  within-turn tool calls — run-agent-loop.ts:139
  three tool calls → three sequential awaits, not Promise.all

  right call now: simpler tracing + cost attribution, tools are cheap
  first lever later: fan them out if tool latency ever dominates
```

Anchor: "Tool calls inside a turn are sequential — independent ones could be `Promise.all`'d. That's the latency I'd parallelize first if it ever mattered."

## See also

- `03-event-loop-and-async-io.md` — what the event loop does at those await points, and the one task that blocks it
- `04-shared-state-races-and-synchronization.md` — why one thread sidesteps races, and the single shared-state seam
- `05-memory-stack-heap-gc-and-lifetimes.md` — the `worker_threads` escape hatch for the CPU scan
