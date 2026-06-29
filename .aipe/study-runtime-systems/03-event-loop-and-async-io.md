# Event Loop and Async I/O

**Subtitle:** the event loop (Node's libuv) / async I/O / the blocking-synchronous-work hazard — *the event loop* (Industry standard).

## Zoom out, then zoom in

This is the heart of the runtime guide. Everything in aptkit that takes time is either an **awaited network call** (suspends the loop, thread goes free) or **synchronous CPU work** (holds the loop, nothing else runs). The whole performance and responsiveness story lives in telling those two apart.

```
  Zoom out — where the loop lives in the request path

  ┌─ Capability layer ──────────────────────────────┐
  │  agent.answer(question)                          │
  └───────────────────────┬──────────────────────────┘
                          │ calls
  ┌─ Runtime layer ───────▼──────────────────────────┐
  │  runAgentLoop  ── drives turns on ──►  ★ EVENT LOOP ★ │ ← THIS CONCEPT
  │   await model.complete()  → suspends             │
  │   await tools.callTool()  → cosine scan BLOCKS   │
  └───────────────────────┬──────────────────────────┘
                          │ fetch() (async I/O, suspends)
  ┌─ Network boundary ────▼──────────────────────────┐
  │  Ollama :11434                                    │
  └───────────────────────────────────────────────────┘
```

**Zoom in.** The event loop is the scheduler from `02`, viewed as a machine with queues. Async I/O — every `fetch` to Ollama — registers a callback and hands the socket to libuv; the loop moves on. CPU work has no such handoff: it runs on the stack to completion. The question here: *which lines in aptkit free the loop, and which lines hold it hostage?* Answering that tells you exactly where a future stall would come from.

## The structure pass

Trace the axis **"is the event loop free right now?"** across the operations in one agent turn.

```
  One axis — "is the loop free?" — across one turn's operations

  ┌─ build prompt / listTools ────┐   loop BUSY (sync, but microseconds)
  └──────────────┬────────────────┘
  ┌─ await model.complete() ─────┐   loop FREE  ← I/O suspend, the long wait
  │   (fetch in flight)           │
  └──────────────┬────────────────┘
  ┌─ parse response, push msgs ──┐   loop BUSY (sync, microseconds)
  └──────────────┬────────────────┘
  ┌─ await tools.callTool() ─────┐   loop FREE for the await, then…
  │   → cosine scan               │   loop BUSY and BLOCKING (sync, O(n·d))
  └───────────────────────────────┘
```

Two seams flip the axis:

- **Seam 1 — the network await** (`run-agent-loop.ts:103`). Loop goes from busy to free. This is where aptkit spends 99% of wall-clock time, and it spends it *idle* — exactly what you want.
- **Seam 2 — the cosine scan** (`in-memory-vector-store.ts:25-33`). Loop goes from free (the await) straight to busy-and-non-yielding. This is the only place in aptkit where the loop is held by aptkit's *own* CPU work with no escape hatch. Everywhere else, "busy" is so brief it's invisible. → `study-performance-engineering` for the cost numbers.

## How it works

### Move 1 — the mental model

You know the event loop already from the browser: it's the thing that lets a `setTimeout`, a click handler, and a `fetch().then()` all coexist on one thread. Node's version (libuv underneath) is the same machine — a loop that drains queues. The one rule you must hold: **the loop can only pick up the next queued callback when the current synchronous run finishes.** Long sync run = starved queue.

```
  The event loop kernel — drain the queues, forever

        ┌─────────────────────────────────────────┐
        │  run current sync code to completion     │ ← if this is the cosine
        │   (the call stack must EMPTY first)      │   scan, everything waits
        └───────────────────┬──────────────────────┘
                            ▼
        ┌─────────────────────────────────────────┐
        │  drain ALL microtasks (Promise .then)    │ ← await continuations
        └───────────────────┬──────────────────────┘
                            ▼
        ┌─────────────────────────────────────────┐
        │  run ONE macrotask (timer, I/O callback) │ ← fetch resolution
        └───────────────────┬──────────────────────┘
                            └──────────► loop back
```

The skeleton, named by what breaks if removed:
- **The "stack must empty first" rule** — remove it (i.e. run a long sync function) and no queued callback ever fires; the process appears hung. This is the cosine-scan hazard.
- **The microtask drain** — this is where every `await` continuation in `runAgentLoop` resumes. Remove the distinction and you lose the ordering guarantee that a resolved Promise's `.then` runs before the next timer.
- **The macrotask step** — where the `fetch` callback (the model response arriving) gets picked up.

### Move 2 — the operations, walked

**The awaited network call — the loop's happy path.** Look at the model call inside the loop:

```ts
// packages/runtime/src/run-agent-loop.ts:103-109
const response = await model.complete({
  system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
  messages,
  tools: forceFinal ? undefined : toolSchemas,
  maxTokens,
  signal,
});
```

The `await` is the whole story. `model.complete` eventually bottoms out in `fetch` (`gemma-provider.ts:204`). The moment `fetch` is called, libuv takes the socket, registers a callback, and the `runAgentLoop` stack *unwinds back to the event loop*. aptkit's thread is now free to run anything else queued. When Ollama responds, libuv queues the callback, the loop picks it up, the Promise resolves, the microtask queue runs the continuation, and `runAgentLoop` resumes right after the `await`. This is async I/O working exactly as designed: the long wait costs zero thread time.

```
  Layers-and-hops — what crosses the loop boundary on a model call

  ┌─ runAgentLoop (stack) ─┐  hop 1: call model.complete()
  │  await model.complete()│ ──────────────────────────────►┐
  └────────────────────────┘                                │
         ▲                                          ┌────────▼────────┐
         │ hop 4: continuation                      │ fetch → libuv    │
         │ resumes (microtask)                      │ holds socket     │
  ┌──────┴─────────────────┐                        └────────┬─────────┘
  │ event loop (free here) │  hop 3: callback queued    hop 2│ HTTP to
  │ runs OTHER tasks       │ ◄──────────────────────────     ▼ Ollama
  └────────────────────────┘                        ┌─────────────────┐
                                                     │ Ollama :11434    │
                                                     └─────────────────┘
```

**The synchronous scan — the loop's hazard.** Now the contrast. The tool call is awaited, but the work behind it isn't async:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:25-33
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {        // ← loops EVERY chunk
    hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
  }                                                  // ← cosine = 768 mults each
  hits.sort((a, b) => b.score - a.score);            // ← then O(n log n) sort
  return hits.slice(0, Math.max(0, k));
}
```

The method is declared `async`, but there is **no `await` inside it**. So once the thread enters this `for` loop, it runs every chunk through `cosineSimilarity` (`in-memory-vector-store.ts:46-57`, a 768-iteration inner loop) and then sorts — all without ever returning to the event loop. For the duration, no other task runs, no timer fires, no other request's `fetch` callback gets picked up. The `async` keyword is a *promise wrapper*, not a yield; it does not chunk the work.

```
  Execution trace — the loop during a cosine scan (n chunks, d=768)

  before:  loop free, other tasks could run
  enter search():
    chunk 1   → cosineSimilarity: 768 mult+add   ─┐
    chunk 2   → 768 mult+add                       │  loop is BUSY,
    ...                                            │  nothing else runs,
    chunk n   → 768 mult+add                       │  no yield point
    sort n hits  → O(n log n) comparisons         ─┘
  return slice(0, k)
  exit:    loop free again
```

At demo sizes (a handful of docs → tens of chunks) this is microseconds and harmless — the right call for a from-scratch in-memory store. The honest statement: it's `O(n·d)` synchronous work on the event loop, and it scales linearly with corpus size. The seam where this stops being free is also the seam where buffr's `PgVectorStore` takes over — moving the scan into Postgres, off aptkit's loop entirely. → `study-performance-engineering` owns the "how slow, when" analysis.

**No microtask tricks, no manual scheduling.** aptkit never calls `queueMicrotask`, `setImmediate`, `process.nextTick`, `setTimeout`, or `setInterval` in product code (I checked — zero hits). It doesn't manually yield to break up CPU work, doesn't poll, doesn't schedule. The only scheduling is implicit through `await`. That's a clean design: the loop's behavior is entirely predictable from reading the awaits.

### Move 3 — the principle

Async I/O is free thread time; synchronous CPU work is rented thread time you can't sublet. The skill is reading code and instantly classifying every operation into one bucket. In aptkit, every operation is async-and-free *except* the cosine scan, which is sync-and-blocking. An `async` function signature tells you nothing — you have to look *inside* for an `await`. A method that returns a Promise but never awaits is a CPU loop wearing an async costume.

## Primary diagram

```
  Event loop and async I/O in aptkit — complete

  ┌─ aptkit thread (one) ─────────────────────────────────────────┐
  │                                                                │
  │  CALL STACK                    EVENT LOOP QUEUES               │
  │  ┌──────────────────┐          ┌────────────────────────────┐ │
  │  │ runAgentLoop     │          │ microtasks: await resumes  │ │
  │  │                  │          │ macrotasks: fetch callbacks │ │
  │  │ await model.     │ suspend  └─────────────▲──────────────┘ │
  │  │  complete() ─────┼──────────────► fetch → libuv → socket    │
  │  │                  │ ◄── resolve ──────────┘                  │
  │  │                  │                                          │
  │  │ await tools.     │                                          │
  │  │  callTool()      │                                          │
  │  │   └► cosine scan │ ✗ NO YIELD — holds the loop, O(n·d)      │
  │  │      (sync for)  │   nothing else runs until it returns     │
  │  └──────────────────┘                                          │
  └────────────────────────────────────┬───────────────────────────┘
                                        │ HTTP
                              ┌─────────▼──────────┐
                              │ Ollama :11434      │
                              └────────────────────┘
```

## Elaborate

The single-threaded event loop is Node's defining trait, inherited from the browser and built on libuv. The lesson aptkit teaches cleanly: the danger isn't the model — it's the *unawaited synchronous loop*. A 50ms sync function on the event loop adds 50ms of latency to *every other* in-flight request, because they all share the one loop. That's why "never block the event loop" is the first rule of Node performance. aptkit follows it everywhere by accident of being I/O-bound, and breaks it in exactly one place by design (the in-memory scan, accepted because the corpus is tiny). When the corpus grows, the move is `PgVectorStore` (off-process) or, failing that, a `worker_thread` — never chunking the scan with `setImmediate`, which just trades blocking for latency.

## Interview defense

**Q: aptkit's vector store method is `async` — does that mean the search doesn't block the event loop?**
No, and that's the trap. `async` wraps the return value in a Promise; it doesn't yield. `InMemoryVectorStore.search` has no `await` inside it, so the cosine `for`-loop runs to completion on the event loop — `O(n·d)`, blocking. At tiny corpus sizes it's negligible; at scale it stalls every other task. The fix is moving the scan off-process (`PgVectorStore`), not faking yields.

```
  async keyword ≠ yield. Look INSIDE for an await. No await = blocking.
```
*Anchor: a method that returns a Promise but never awaits is a CPU loop in an async costume.*

**Q: Where does aptkit spend its wall-clock time, and is the thread busy then?**
In `await model.complete()` — the fetch to Ollama. The thread is *free* the whole time; libuv holds the socket and the loop can run other tasks. That's the win of async I/O: the long wait costs no thread time.

## See also

- `02-processes-threads-and-tasks.md` — the cooperative scheduling this loop implements
- `05-memory-stack-heap-gc-and-lifetimes.md` — what the scan allocates
- `06-filesystem-streams-and-resource-lifecycle.md` — the NDJSON stream on the loop
- `study-performance-engineering` — the cost of the scan, quantified
- `study-networking` — the fetch as an HTTP exchange
