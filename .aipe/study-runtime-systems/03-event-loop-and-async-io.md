# 03 — Event Loop and Async I/O

**Industry name:** event loop / microtask queue / non-blocking I/O · *Industry standard*

## Zoom out, then zoom in

The single most important machine in this runtime sits in the runtime layer, beneath every agent and provider.

```
  Zoom out — where the loop sits

  ┌─ Application layer ──────────────────────────────────────┐
  │  runAgentLoop, agents, providers (all express awaits)    │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────┐
  │  ★ event loop + microtask queue ★                        │ ← we are here
  │     pulls ready tasks, runs each to completion           │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Kernel / network layer ─▼───────────────────────────────┐
  │  epoll/kqueue, socket I/O for the HTTPS provider call    │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the event loop is the scheduler that makes single-threaded code feel concurrent. The question it answers: "while I'm awaiting a model API call that takes two seconds, what is the CPU doing?" Answer: running *other* ready tasks — other requests, queued microtasks — and the instant the network reply lands, it queues your continuation and resumes it. Non-blocking I/O is the trick that turns "wait 2 seconds doing nothing" into "wait 2 seconds doing everything else."

## Structure pass

**Layers.** Application awaits → loop schedules → kernel does the actual socket I/O. The contract between application and loop is the Promise; the contract between loop and kernel is the OS readiness API (epoll/kqueue), which you never touch directly.

**Axis — "what blocks the thread at this layer?"**

```
  One question down the layers: "what blocks the one thread?"

  ┌─ application ───────────────┐  a synchronous CPU loop blocks
  │  JSON.parse, .filter, etc.  │  (runs to completion, no yield)
  └──────────────┬───────────────┘
       ┌─────────▼─────────────────┐ await NEVER blocks —
       │  loop: await suspends      │ it yields the thread
       └─────────┬─────────────────┘
           ┌─────▼───────────────────┐ kernel I/O is off-thread;
           │  socket read/write       │ the loop is notified when ready
           └──────────────────────────┘
```

The blocking answer flips at the `await`: synchronous app code blocks the thread (and must stay short), but `await` *never* blocks — it suspends and hands the thread back. Kernel-level network I/O happens entirely off the JS thread; the loop just gets a "socket ready" callback. That's why `await model.complete()` is free: the waiting happens in the kernel, not on your thread.

**Seams.** Two queues are the seam between "code that wants to run" and "code that runs next":
- **microtask queue** — Promise continuations (`.then`, the code after an `await`). Drained *completely* after each task, before any macrotask.
- **macrotask queue** — timers, I/O callbacks, the next HTTP request. One per loop tick.

The flip across this seam: microtasks always jump the macrotask queue. A flood of resolved Promises can starve a pending timer. AptKit doesn't hit this (no tight Promise loops), but it's the seam where event-loop bugs live.

## How it works

### Move 1 — the mental model

You know that `fetch()` returns a Promise and your `.then`/`await` runs "later," not now. The loop is what decides *when* "later" is. Strategy: **a queue of ready continuations, drained one at a time, never interrupting one mid-run.**

```
  The loop kernel — one tick

  ┌──────────────── loop tick ─────────────────┐
  │ 1. run one macrotask (e.g. an HTTP request) │
  │ 2. drain ALL microtasks (awaited            │
  │    continuations) until the queue is empty  │
  │ 3. I/O poll: any sockets ready? queue their │
  │    callbacks as macrotasks                  │
  │ 4. go to 1                                  │
  └─────────────────────────────────────────────┘
       run-to-completion: step 1's task finishes
       fully before step 2 begins
```

### Move 2 — walking the mechanism

**An `await` splits a function into "before" and "after."** Everything up to the `await` runs synchronously now. The `await` registers the continuation (the "after") as a microtask to run when the awaited Promise settles, and *returns control to the loop*. This is the yield point.

```
  await splits the function — execution trace

  state before: messages=[user], turn=0
  ─ runs now ─►  signal.throwIfAborted()   (sync)
  ─ runs now ─►  build request object      (sync)
  ─ AWAIT    ─►  model.complete(...)        ← suspend, return to loop
                 ............ loop runs other tasks ............
  ─ resumes ─►   response arrives → continuation queued as microtask
  state after:   messages=[user, assistant], turn still 0 until loop end
```

**Awaited network I/O is the dominant task in AptKit.** Every `model.complete()` is one `fetch`-like SDK call. While it's in flight, the JS thread is *free*. The kernel watches the socket; when bytes arrive, the loop wakes the continuation. This is why one Node process serves many concurrent Studio replays on one thread — they're all parked at their respective `await model.complete()` simultaneously, and the loop juggles their resumptions.

```
  Three concurrent requests, one loop, all parked at await

  req1: ──run──► await model ......................► resume ──►
  req2: ───run──► await model ...........► resume ──►
  req3: ──run──► await model ....► resume ──►
              ▲                  ▲       ▲
              loop free here — it advances whichever
              request's network reply landed first
```

**Async generators stream I/O lazily.** `decodeNdjsonStream` is an `async function*`: `for await (const chunk of chunks)` pulls one chunk, yields decoded records, and suspends until the consumer asks for more. Each `yield` is a suspension point; each loop iteration begins with a cancellation check. This is the loop applied to a *sequence* of I/O events rather than a single one.

```
  Async generator — pull-based streaming I/O

  consumer: for await (record of decodeNdjsonStream(chunks))
                │ asks for next
                ▼
  generator: for await (chunk of chunks)   ← awaits next network chunk
               buffer += chunk
               while (newline in buffer):
                 yield decodeNdjsonLine(...)  ← suspends, hands record to consumer
               (resumes when consumer asks again)
```

**The boundary condition — don't block the loop.** The loop's one rule: synchronous code between awaits must be short, because nothing else runs during it. AptKit's synchronous spans are mostly small (`JSON.parse` of a tool result capped at 16KB, `.filter`/`.map` over a handful of content blocks). The one bounded span to watch is `truncate(JSON.stringify(result))` on a tool result — capped at `MAX_TOOL_RESULT_CHARS` precisely so the synchronous stringify stays cheap.

The new RAG code adds the *first* synchronous span whose cost scales with data, not with a fixed bound: `InMemoryVectorStore.search` walks every stored chunk and runs `cosineSimilarity` — an O(N·dim) dot-product loop — entirely on the JS thread before it returns, then sorts (`in-memory-vector-store.ts:25-33`, `:46-57`). For the 3-doc demo corpus this is microseconds. But there's no `await` inside that scan: index a large corpus and a single `search` call freezes the loop for the whole linear scan. It's unbounded by design — the `dimension` is fixed (768) but the chunk *count* is not. This is the one place in the repo where corpus growth turns a cheap span into a loop-blocking one; the fix is the `PgVectorStore` drop-in the contract already anticipates (the scan moves into Postgres, off the JS thread). See `05`, `08`.

`@aptkit/memory`'s `recall` is the same async-I/O-then-sync-filter shape, no new loop. It does `await embedder.embed([query])` then `await store.search(...)` — two yields — followed by a *synchronous* `.filter(kind).slice(k).map(...)` span over the over-fetched hits (`conversation-memory.ts:89-105`). That trailing filter is a third consumer of this pattern (after the RAG query path and the agent loop), and it's bounded the friendly way: the scan is over `fetchK = max(k*4, 20)` hits, not the whole corpus, so unlike the cosine scan above its sync span is fixed-size by construction — the over-fetch caps it. The cancellation half is *not* handled, though: neither `embed` nor `search` here receives a signal (see `07`).

### Move 3 — the principle

The event loop converts "waiting on I/O" from a thread-blocking cost into free time, by doing the waiting in the kernel and resuming you via a queue. The single rule that keeps it healthy — never block the thread with long synchronous work — is the one thing you must hold in your head when writing for it. AptKit obeys it by keeping synchronous spans tiny and pushing all the slow work (model calls, tool I/O, file reads) behind `await`.

## Primary diagram

```
  Event loop + async I/O — the whole machine

  ┌─ JS thread (one) ────────────────────────────────────────────┐
  │                                                              │
  │  ┌─ macrotask queue ─┐      ┌─ microtask queue ─┐            │
  │  │ HTTP requests     │      │ awaited continuations         │
  │  │ I/O callbacks     │      │ (.then, code after await)     │
  │  │ timers            │      └─────────┬─────────────────────┘ │
  │  └────────┬──────────┘                │ drained fully each tick│
  │           │  one per tick             ▼                       │
  │           ▼                  run continuation to completion   │
  │      run task ──────────────────────────────────────────────►│
  └───────────────────────────┬───────────────────────────────────┘
                              │ await model.complete / tools / file
                              ▼  (work leaves the thread)
  ┌─ Kernel / Network ───────────────────────────────────────────┐
  │  socket I/O for HTTPS provider call — off-thread, non-blocking│
  │  ready → loop queues the continuation as a macrotask          │
  └───────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The loop is exercised on every model call (the big yield), every tool call, every NDJSON chunk decoded in the browser, and every file read in a script. You reason about it whenever a replay "hangs" (which await is it parked at?) or when you ask whether one slow request blocks others (it doesn't).

**Code side by side.**

The awaited model call — the dominant yield point:

```
  packages/runtime/src/run-agent-loop.ts (lines 99–109)

  signal?.throwIfAborted();                ← sync, runs now
  const budgetSpent = ...;                 ← sync
  const response = await model.complete({  ← SUSPEND: thread freed, kernel waits
    system: ...,
    messages,
    tools: forceFinal ? undefined : toolSchemas,
    maxTokens,
    signal,                                ← the only way to wake early
  });
       │
       └─ during this await the loop serves other requests; the continuation
          (everything after) is queued when the HTTPS reply lands
```

The native non-blocking I/O at the SDK boundary:

```
  packages/providers/anthropic/src/anthropic-provider.ts (lines 28–39)

  async complete(request) {
    const response = await this.client.messages.create(
      { model, max_tokens, messages, ... },
      request.signal ? { signal: request.signal } : undefined, ← signal → fetch → kernel
    );
       │
       └─ the SDK uses fetch under the hood; the socket wait is off-thread.
          the signal lets the kernel-level request be aborted.
```

The async generator streaming chunks lazily:

```
  packages/runtime/src/ndjson-stream.ts (lines 103–126)

  export async function* decodeNdjsonStream(chunks, options) {
    let buffer = '';
    for await (const chunk of chunks) {           ← await next network chunk (suspend)
      options.signal?.throwIfAborted();           ← cancel check each chunk
      buffer += decoder.decode(chunk, { stream: true }); ← partial bytes ok
      let nl = buffer.search(/\r?\n/);
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        yield decodeNdjsonLine(line, ...);        ← hand one record to consumer (suspend)
        nl = buffer.search(/\r?\n/);
      }
    }
       │
       └─ each yield suspends until the consumer's for-await asks again — pull-based,
          so a slow consumer naturally slows the generator (the one place with
          implicit backpressure — see 06)
```

## Elaborate

The event loop comes from the same lineage as the browser's — Node took libuv's loop and the same Promise/microtask model the browser uses, so the mental model transfers exactly from frontend work. The microtask-vs-macrotask ordering (microtasks drain fully before the next macrotask) is the subtle part that bites people: a recursive `Promise.resolve().then(...)` can starve I/O. AptKit never builds such a loop, so it stays out of trouble. The deeper context — *how* the kernel does non-blocking socket I/O (epoll/kqueue, TLS handshakes, connection reuse) — is networking's territory; this file stops at the loop's edge. The async generator's pull-based suspension is the one spot where the loop gives you backpressure for free; `06` picks that up.

## Interview defense

**Q: "While `await model.complete()` is in flight, what is the thread doing?"**

```
  thread:  [other req's task][drain microtasks][I/O poll]
                       ▲
                       your model call is parked in the kernel;
                       the thread is NOT waiting on it — it's running
                       whatever else is ready
```

Answer: "Running other ready work. The await suspends the function and returns the thread to the loop; the socket wait happens off-thread in the kernel. When the reply lands, my continuation is queued as a microtask and resumes." Anchor: `run-agent-loop.ts:103`.

**Q: "What would freeze the loop here, and does the code risk it?"** A long *synchronous* span — e.g. stringifying a giant object, or a CPU scan whose length scales with data. The tool-result path is bounded (`MAX_TOOL_RESULT_CHARS = 16_000` before `JSON.stringify`, `run-agent-loop.ts:52,162`), so that span stays tiny. The one unbounded sync span is `InMemoryVectorStore.search`'s cosine scan over every chunk (`in-memory-vector-store.ts:25-33`): harmless at demo corpus size, a loop freeze at scale because no `await` interrupts the linear scan. The move is the `PgVectorStore` drop-in that pushes ranking into Postgres, off the JS thread.

## Validate

1. **Reconstruct:** Draw one loop tick (macrotask → drain microtasks → I/O poll). Mark where an `await` continuation lands.
2. **Explain:** Why can one Node process serve three Studio replays on one thread? (All three park at `await model.complete()` — `run-agent-loop.ts:103`.)
3. **Apply:** A reviewer adds a synchronous `JSON.stringify` of an un-truncated 5MB tool result. What happens to other requests? (Loop frozen for the duration; bound it like `truncate` at `:54–57`.) Then: someone indexes a 200k-chunk corpus into `InMemoryVectorStore` and calls `search`. What freezes, and what's the fix? (The synchronous cosine scan over all chunks, `in-memory-vector-store.ts:25-33`; move ranking into `PgVectorStore` so it runs off the JS thread.)
4. **Defend:** Explain why `decodeNdjsonStream`'s `yield` gives implicit backpressure but `res.write` in the server does not (`06`).

## See also

- `01-runtime-map.md` — the loop's place in the topology.
- `06-filesystem-streams-and-resource-lifecycle.md` — the streaming half, and where backpressure is/isn't.
- `07-backpressure-bounded-work-and-cancellation.md` — bounding the synchronous + awaited work, and the memory recall signal gap.
- `04-shared-state-races-and-synchronization.md` — `@aptkit/memory`'s counter `Map`, the new cross-call mutable state.
- `.aipe/study-networking/` *(when generated)* — what happens beneath the awaited socket I/O.
