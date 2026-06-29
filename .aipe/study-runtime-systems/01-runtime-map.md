# Runtime Map

**Subtitle:** the execution model / process-and-resource topology as-built — *the runtime map* (Project-specific).

## Zoom out, then zoom in

Before any single mechanism, here's the whole machine. aptkit runs as **one Node process**, and inside it every layer you'll study lives on the same thread, sharing the same event loop and the same heap. The only thing that ever leaves the process is a `fetch()` to Ollama.

```
  Zoom out — the whole runtime, one process

  ┌─ Host process (Node, single, e.g. buffr or a Studio dev server) ─┐
  │                                                                  │
  │  ┌─ Capability layer ────────────────────────────────────────┐  │
  │  │  RagQueryAgent · RecommendationAgent · QueryAgent · …      │  │
  │  └───────────────────────────┬────────────────────────────────┘  │
  │                              │ calls                              │
  │  ┌─ Runtime layer ───────────▼────────────────────────────────┐  │
  │  │  ★ runAgentLoop ★   structured-generation   ndjson-stream   │  │ ← THIS GUIDE
  │  │  (the bounded async driver — owns the turn loop)            │  │   maps all of this
  │  └───────┬───────────────────────────────────┬─────────────────┘  │
  │          │ model.complete()                  │ tools.callTool()    │
  │  ┌───────▼─────────────┐            ┌─────────▼─────────────────┐  │
  │  │ Provider adapters   │            │ Tool registry             │  │
  │  │ gemma·fallback·local│            │ search_knowledge_base     │  │
  │  └───────┬─────────────┘            └─────────┬─────────────────┘  │
  │          │ fetch()                            │ pipeline.query()    │
  │          │                          ┌─────────▼─────────────────┐  │
  │          │                          │ InMemoryVectorStore       │  │
  │          │                          │ (sync cosine scan, heap)  │  │
  │          │                          └───────────────────────────┘  │
  └──────────┼───────────────────────────────────────────────────────┘
             │ HTTP (network boundary — the ONLY thing off-process)
   ┌─────────▼──────────┐
   │ Ollama :11434      │  gemma2 + nomic-embed-text
   └────────────────────┘
```

**Zoom in.** The map has four bands, but only one of them *owns control flow*: the runtime layer, and specifically `runAgentLoop`. Everything above it is a thin capability wrapper that configures the loop; everything below it is something the loop *awaits*. So "the runtime map" really means: one async driver, the things it awaits (a network call, a synchronous scan), and the one resource that crosses the process boundary (the HTTP socket to Ollama). That's the whole territory.

## The structure pass

Pick one axis and trace it down the stack: **where does the work physically execute?**

```
  One axis — "where does this work run?" — traced down the layers

  ┌─ Capability layer ────────────┐   on the call stack (sync setup)
  │  agent.answer(question)       │   → builds a system prompt, returns a Promise
  └──────────────┬────────────────┘
  ┌─ Runtime layer ──────────────┐   on the call stack + event loop
  │  runAgentLoop  for-turn loop  │   → sync between awaits, suspended during awaits
  └──────────────┬────────────────┘
  ┌─ Provider layer ─────────────┐   suspended on the event loop
  │  fetch() to Ollama           │   → libuv holds the socket; thread is FREE here
  └──────────────┬────────────────┘
  ┌─ Vector store ───────────────┐   on the call stack, BLOCKING
  │  cosine for-loop (sync)       │   → no await; nothing else runs until it returns
  └───────────────────────────────┘
```

The axis-answer **flips twice**, and each flip is a seam worth studying:

- **Seam 1 — the `await model.complete()` boundary** (`run-agent-loop.ts:103`). Above it, work runs *on the stack*. Below it, the work is a network call and the thread is *handed back to the event loop* — aptkit does nothing while Ollama thinks. This is the seam where "busy" becomes "idle-but-suspended." → `03-event-loop-and-async-io.md`.
- **Seam 2 — the `pipeline.query()` → cosine scan boundary** (`in-memory-vector-store.ts:25`). Above it, async. Below it, a synchronous CPU loop that *does not yield*. This is the seam where "idle-but-suspended" flips back to "busy and blocking." → `03`, and `study-performance-engineering`.

Two more axes round out the map:

- **State ownership.** Almost everything is stack-local and dies with the call. The exceptions: `InMemoryVectorStore.chunks` (a `Map` that lives as long as the store instance, `in-memory-vector-store.ts:12`) and `GemmaModelProvider.toolUseCount` (a mutable counter, `gemma-provider.ts:44`). Those are the only two pieces of heap state that outlive a single call. → `04-shared-state-races-and-synchronization.md`.
- **Resource lifecycle.** The one OS resource aptkit touches is the HTTP socket per `fetch()`, opened and closed inside the transport (`gemma-provider.ts:203-214`). File descriptors only appear in the Studio dev server (`apps/studio/vite.config.ts`), via `node:fs/promises`. → `06-filesystem-streams-and-resource-lifecycle.md`.

## How it works

### Move 1 — the mental model

You already know the shape: it's a `fetch()` with extra steps. When you write a React component that calls `fetch()`, the browser hands the socket to the OS, your component's JS stops running, and a callback fires when the bytes come back. aptkit's runtime is that same pattern, looped: *await a model response, do a tiny bit of synchronous work, await again,* until a budget runs out.

```
  The runtime map as a control-flow shape

         ┌──────────────────────────────────────────┐
         │              ONE PROCESS                   │
         │                                            │
   start │   stack: agent.answer() ──► runAgentLoop   │
   ──────┼──►        │                                │
         │           ▼                                │
         │     ┌── for each turn (bounded) ──┐        │
         │     │  await model.complete() ────┼──► fetch (suspend)
         │     │       ▼                      │        │
         │     │  await tools.callTool() ─────┼──► cosine scan (block)
         │     │       ▼                      │        │
         │     │  budget spent? ──► force final│       │
         │     └──────────────────────────────┘        │
         │           │                                │
         │           ▼  finalText                     │
   ──────┼───────────────────────────────────────────│
   end   └────────────────────────────────────────────┘
```

Everything in this diagram happens on **one stack**. There is no second thread the loop hands work to. When the diagram says "suspend," it means the stack unwinds and the event loop is free; when it says "block," it means the stack stays put and nothing else runs.

### Move 2 — what's actually in the map

**The process owner is not aptkit.** This is the part that surprises people. aptkit exports classes and `async` functions; it never calls `process.on(...)`, never owns `main()`, never installs a signal handler. The process is owned by whoever imports it — buffr in production, the Vite dev server in Studio. Concretely: search the product packages for `process.on` and you get nothing; the only `process.exit` calls are in standalone CLI scripts (`packages/agents/rag-query/scripts/ask.ts:77`, `eval.ts:86`). The runtime map's outermost box is *borrowed*.

```
  Layers-and-hops — who owns the process boundary

  ┌─ Owner (buffr / Studio dev server) ─┐  owns: process, signals, lifecycle
  │   imports @rlynjb/aptkit-core        │
  └───────────────┬──────────────────────┘
                  │  hop: function call (in-process, same thread)
  ┌─ aptkit (this repo) ─────────────────┐  owns: NOTHING at process level
  │   runAgentLoop, providers, stores    │  just async functions + classes
  └───────────────┬──────────────────────┘
                  │  hop: fetch() over HTTP (the only IPC-like boundary)
  ┌─ Ollama :11434 ──────────────────────┐  separate process, separate machine-able
  │   model inference                     │
  └───────────────────────────────────────┘
```

**The driver owns the turn loop.** `runAgentLoop` (`run-agent-loop.ts:98-190`) is the only place in the repo that runs an unbounded-looking control structure — and it's bounded by `maxTurns` (default 8, `run-agent-loop.ts:87`). Each agent configures it: the RAG agent uses `maxTurns: 6, maxToolCalls: 4` (`rag-query-agent.ts:75-76`), the monitoring agent `8/6` (`monitoring-agent.ts:76-77`). The loop is the *only* stateful control flow; everything else is a straight-line `async` function.

**The resources are: one socket per call, zero descriptors in core.** A model call opens a `fetch` (`gemma-provider.ts:204`), reads the full body, closes. No connection pool, no keep-alive management in aptkit's own code (that's the runtime's `fetch` default). → `study-networking` for the pooling story.

### Move 3 — the principle

A library's runtime map is defined as much by what it *refuses to own* as by what it does. aptkit owns the turn loop and the async control flow; it deliberately does not own the process, the signals, or durable state — because those belong to the deployment, and baking them in would make the library un-embeddable. The map is small on purpose.

## Primary diagram

```
  The aptkit runtime map — complete

  ┌─ Borrowed process (owner: buffr / Studio) ───────────────────────┐
  │  signals · lifecycle · shutdown  ← NOT aptkit's (not yet exercised)│
  │                                                                   │
  │  ┌─ aptkit: one thread, one event loop, one heap ──────────────┐  │
  │  │                                                             │  │
  │  │  STACK (sync work)          EVENT LOOP (suspended awaits)    │  │
  │  │  ┌────────────────┐         ┌──────────────────────────┐    │  │
  │  │  │ runAgentLoop   │ await ─► │ fetch callback (Ollama)  │    │  │
  │  │  │  (bounded for) │ ◄─────── │ resolves Promise         │    │  │
  │  │  │ cosine scan ───┼─BLOCKS── │ (queue waits behind it)  │    │  │
  │  │  └────────────────┘         └──────────────────────────┘    │  │
  │  │                                                             │  │
  │  │  HEAP state that outlives a call:                           │  │
  │  │   · InMemoryVectorStore.chunks (Map)                        │  │
  │  │   · GemmaModelProvider.toolUseCount (counter)               │  │
  │  └─────────────────────────────┬───────────────────────────────┘  │
  └────────────────────────────────┼───────────────────────────────────┘
                                    │ HTTP (network — only off-process hop)
                          ┌─────────▼──────────┐
                          │ Ollama :11434      │
                          └────────────────────┘
```

## Elaborate

This map is the shape of a **library, not a service**. Services own their process and answer the question "how do I stay up and drain cleanly on deploy"; libraries answer "how do I run cleanly inside *someone else's* process." aptkit is firmly the latter. The pattern of pushing process ownership to the consumer is what lets buffr supply the durable `PgVectorStore` and the `agents` Postgres schema without aptkit knowing anything about Postgres. Read `02-processes-threads-and-tasks.md` next to see *why* one thread is the right call for this workload, then `03-event-loop-and-async-io.md` to watch the loop actually run.

## Interview defense

**Q: Walk me through aptkit's runtime topology.**
One Node process, one thread, one event loop. The runtime layer (`runAgentLoop`) owns control flow; provider adapters and the vector store are things it awaits. The only off-process hop is a `fetch()` to a local Ollama server. There are no threads, no workers, no child processes in the hot path.

```
  one process → one loop → await(network) | block(cosine) → fetch to Ollama
```
*Anchor: aptkit is a library — it borrows the process from buffr; it owns only the turn loop.*

**Q: What's the load-bearing piece, and what's the part people miss?**
Load-bearing: the bounded turn loop in `run-agent-loop.ts`. The part people miss: aptkit doesn't own the process, so there's no signal handler or shutdown logic *by design* — that's the consumer's job.

## See also

- `02-processes-threads-and-tasks.md` — why one thread
- `03-event-loop-and-async-io.md` — the await chain in motion
- `07-backpressure-bounded-work-and-cancellation.md` — the loop's budget
- `study-system-design` — the aptkit↔buffr boundary
