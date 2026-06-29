# Processes, Threads, and Tasks

**Subtitle:** the single-threaded event-loop model / cooperative scheduling — *the task* (a `Promise`) (Industry standard).

## Zoom out, then zoom in

Where does work *physically run* in aptkit? On exactly one thread. There is no thread pool you dispatch to, no worker you `postMessage`, no process you fork. Every agent, every provider call, every cosine scan runs on the same single thread of execution, scheduled cooperatively by Node's event loop.

```
  Zoom out — the execution substrate

  ┌─ Process (Node, single) ─────────────────────────────────────┐
  │                                                               │
  │  ┌─ THE one thread ─────────────────────────────────────────┐ │
  │  │   call stack ──► runs ONE task to its next await,         │ │
  │  │                  then picks the next ready task           │ │ ← THIS CONCEPT
  │  │                                                           │ │   lives here
  │  │   ★ a "task" = a Promise continuation ★                   │ │
  │  └───────────────────────────────────────────────────────────┘ │
  │                                                               │
  │  ┌─ libuv thread pool (Node's, NOT used by aptkit) ─────────┐ │
  │  │   fs, dns, crypto — aptkit doesn't reach for these in core │ │
  │  └───────────────────────────────────────────────────────────┘ │
  └───────────────────────────────────────────────────────────────┘
```

**Zoom in.** "Single-threaded" doesn't mean "does one thing." It means there's one *call stack*, and the unit the runtime schedules onto it is a **task** — in JS terms, a `Promise` continuation. aptkit creates tasks every time it `await`s. The question this file answers: if there's only one thread, how does aptkit run a loop that makes network calls without freezing? Answer: it doesn't *run* during the network call — it *suspends* and lets the one thread pick up other ready tasks.

## The structure pass

Trace the axis **"who is in control of the thread right now?"** down through the levels of concurrency aptkit actually has.

```
  One axis — "who holds the thread?" — across the levels

  ┌─ OS process level ────────────┐   the OS scheduler (preemptive)
  │  Node process vs Ollama proc  │   → two real processes, OS time-slices them
  └──────────────┬────────────────┘
  ┌─ Thread level ───────────────┐   only ONE thread in aptkit's code
  │  the single JS thread         │   → no contention; nothing to schedule against
  └──────────────┬────────────────┘
  ┌─ Task level (the real story) ┐   the event loop (cooperative)
  │  Promise continuations        │   → a task runs until it awaits, then yields
  └───────────────────────────────┘
```

The seam that matters is between the **process level** and the **task level**, and it's *not* where people expect. There's real OS-preemptive concurrency between the Node process and the Ollama process — they run genuinely in parallel, and the OS forcibly time-slices them. But *inside* aptkit there's only cooperative task scheduling: a task keeps the thread until it voluntarily yields at an `await`. The flip across that seam is **preemptive → cooperative**. That's the single most important runtime fact about aptkit: inside it, nothing can interrupt a running task. A task that never awaits never yields. → that's exactly the cosine scan's hazard in `03-event-loop-and-async-io.md`.

## How it works

### Move 1 — the mental model

You've used this without naming it. When you write `const data = await fetch(url)` in a React effect, the function *pauses* and the browser is free to handle clicks, run other effects, repaint. Your code didn't get its own thread — it got *taken off* the one thread while waiting, then *put back* when the data arrived. A "task" is one of those resumable chunks of work between two awaits.

```
  The task as a unit — what runs between awaits

  agent.answer()  ── runs ──►  await fetch  ── YIELDS ──► (thread free)
       │                                                      │
       │              ...other ready tasks may run...         │
       ▼                                                      ▼
  resume  ◄────────── Promise resolves, continuation queued ──┘
       │
       └─ runs ──► await next ── YIELDS ──► ...

  one thread, many tasks, interleaved at await boundaries
```

The strategy in one sentence: **the thread runs one task until it hits an `await`, then it's free to run any other task whose Promise has resolved.** That's cooperative scheduling. No task is ever preempted mid-run; it only yields at an `await`.

### Move 2 — the levels, walked

**The process boundary — two real processes, genuine parallelism.** aptkit's Node process and the Ollama server are *separate OS processes*. While Ollama is doing inference (a heavy CPU/GPU job), aptkit's thread is idle and the OS gives those cycles to Ollama. This is the only true parallelism in the picture, and aptkit reaches it for free by making a network call.

```
  Layers-and-hops — the only real parallelism is across the process boundary

  ┌─ aptkit process ─────┐                    ┌─ Ollama process ─────┐
  │  thread: idle,        │  hop: HTTP POST    │  thread(s): BUSY      │
  │  suspended on await ──┼───────────────────►│  running inference    │
  │                       │  hop: HTTP 200 ◄────│  (in parallel — real  │
  │  thread: resumes ◄────┼────────────────────│   OS time-slicing)    │
  └───────────────────────┘                    └───────────────────────┘
        ▲ cooperative inside              preemptive across ▲
```

The relevant code is the transport (`gemma-provider.ts:201-215`): a plain `fetch` to `http://localhost:11434/api/chat`. From aptkit's side it's just `await this.chat(...)` at `gemma-provider.ts:69`. The parallelism is implicit — aptkit gets it by *not being the one doing the inference*.

**The thread level — there is one, and aptkit never leaves it.** No `new Worker`, no `worker_threads` import, no `child_process` in any product package. I checked the whole tree: the single `child_process` reference is `spawnSync` in `scripts/pack-core-standalone.mjs:5`, which is build tooling. So the thread level is trivial: one thread, no contention, no synchronization primitives needed (which is why `04-shared-state-races-and-synchronization.md` is mostly "no locks needed — yet").

**The task level — where all aptkit concurrency actually lives.** Every `await` in aptkit creates a yield point. Walk one agent call:

```
  Execution trace — the thread across one rag-query turn

  step                                   thread state
  ──────────────────────────────────────────────────────────
  agent.answer("...")                    RUNNING (stack: answer)
  → listTools()                          RUNNING (sync, in-memory)
  → runAgentLoop enters turn 0           RUNNING
  → await model.complete()               YIELDS  ← thread free here
     ...fetch in flight...               (other tasks could run)
  ← response resolves                    RESUMES (continuation queued)
  → await tools.callTool()               YIELDS briefly
     → cosine scan (sync!)               RUNNING, BLOCKING  ← no yield inside
  ← hits returned                        RESUMES
  → await model.complete() (turn 1)      YIELDS
  ...                                    until budget spent → finalText
```

Two yields per turn (the two awaits), and one stretch — the cosine scan — that does *not* yield even though it's reached through an `await tools.callTool()`. The `await` is on the registry wrapper (`tool-registry.ts:62`), but `InMemoryVectorStore.search` itself (`in-memory-vector-store.ts:25-33`) is fully synchronous, so once entered it owns the thread until it returns the sorted slice.

**No fan-out — tasks run strictly in sequence.** aptkit never does `Promise.all`. If it embedded ten documents, it would `await` the embedder once with all ten texts (`pipeline.ts:40`, `indexDocument` passes the whole `texts` array to one `embed` call) — batching *inside* one call, not ten concurrent calls. Concurrent task fan-out is `not yet exercised`. → `07-backpressure-bounded-work-and-cancellation.md` for why a limiter would matter if it were.

### Move 3 — the principle

For an I/O-bound workload — and an agent loop is almost pure I/O, since the expensive work happens in Ollama's process — a single thread with cooperative scheduling is the *right* default, not a compromise. The thread is idle during the only slow part (inference), so there's nothing for a second thread to do. You'd reach for a worker only when you have CPU-bound work that *can't* be pushed to another process. aptkit has exactly one such candidate (the cosine scan), and it's small enough not to warrant it — yet.

## Primary diagram

```
  Processes, threads, and tasks in aptkit — complete

  ┌─ OS ──────────────────────────────────────────────────────────┐
  │  preemptive scheduling between processes                       │
  │                                                                │
  │  ┌─ aptkit Node process ───────────┐   ┌─ Ollama process ────┐ │
  │  │  ONE thread                      │   │  inference threads   │ │
  │  │  ┌────────────────────────────┐  │   │  (real parallelism)  │ │
  │  │  │ event loop (cooperative)   │  │   └──────────▲───────────┘ │
  │  │  │  task = Promise continuation│  │ fetch       │             │
  │  │  │   • runs to next await     │  │─────────────┘             │
  │  │  │   • yields, picks next     │  │                            │
  │  │  │   • cosine scan = NO yield │  │                            │
  │  │  └────────────────────────────┘  │                            │
  │  │  no workers · no child_process    │                            │
  │  └───────────────────────────────────┘                            │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the classic Node concurrency model, the same one that powers every Express server you've written: one thread, an event loop, I/O via callbacks/promises, CPU work pushed elsewhere. The model came out of the observation that most server work is *waiting* — for a DB, a network call, a disk read — and a thread that's waiting is wasted. aptkit fits that mold perfectly because its slow path is "wait for Ollama." Where it would strain is sustained CPU work on the main thread; the cosine scan is the seam where that strain first appears (`03-event-loop-and-async-io.md`), and `worker_threads` or pushing to `PgVectorStore` (in buffr) is the escape hatch.

## Interview defense

**Q: aptkit is single-threaded — how does it run an agent loop with network calls without blocking?**
It blocks nothing because it *suspends* at every `await`. The agent loop makes a `fetch` to Ollama and yields the thread; while Ollama does inference in its own process — real OS parallelism — aptkit's thread is free. It resumes when the response Promise resolves. One thread, many interleaved tasks.

```
  task runs → await fetch → YIELD (thread free) → resolve → RESUME
```
*Anchor: a "task" is a Promise continuation; the thread runs one to its next await, never preempted.*

**Q: When would you add a worker thread?**
When there's CPU-bound work that can't be pushed to another process and is big enough to stall the loop. The only candidate is the cosine scan in `InMemoryVectorStore.search`; at demo corpus sizes it's microseconds, so it's not worth a worker yet. The real fix is `PgVectorStore` moving the scan off-process entirely.

## See also

- `03-event-loop-and-async-io.md` — the yield points and the one that doesn't yield
- `04-shared-state-races-and-synchronization.md` — why one thread means (almost) no locks
- `07-backpressure-bounded-work-and-cancellation.md` — bounding the tasks
- `study-networking` — the fetch as a protocol exchange
