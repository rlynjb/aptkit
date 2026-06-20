# Study — Runtime Systems (AptKit)

How AptKit's code actually *executes*: where work runs, what owns memory, how I/O is awaited, what's bounded, and how a run is cancelled. This is a single-threaded JavaScript/TypeScript codebase running on Node.js (servers, scripts, the `npm run ask` RAG CLI) and in the browser (Studio UI), now also talking to a local Ollama HTTP server for the Gemma provider and embeddings. There are no worker threads, no shared-memory concurrency, no manual thread pools. The execution model is **Node's event loop plus the Promise microtask queue** — and that frame is the honest one for this repo, not a limitation to apologize for. Two new wrinkles since the last pass: a bounded retry loop *nested inside* the Gemma provider's `complete()`, and the first synchronous CPU span (in-memory cosine search) whose cost scales with data rather than a fixed bound. Both are covered in 07 and 03/08.

## Reading order

```
  00-overview.md   the runtime map + ranked findings + not-yet-exercised
       │
       ▼
  01-runtime-map.md                       where work runs: processes, the loop, resources
  02-processes-threads-and-tasks.md       one thread, many awaited tasks; no workers
  03-event-loop-and-async-io.md           the loop, the microtask queue, awaited network I/O
  04-shared-state-races-and-synchronization.md   per-run isolation; why there are no locks
  05-memory-stack-heap-gc-and-lifetimes.md        allocation, the message array, GC lifetimes
  06-filesystem-streams-and-resource-lifecycle.md NDJSON streams, fds, the finally{} close
  07-backpressure-bounded-work-and-cancellation.md the bounded loop + AbortSignal (the core)
  08-runtime-systems-red-flags-audit.md   ranked execution-model risks, evidence-grounded
```

Read `00-overview.md` first — it has the whole machine in one diagram and tells you which concept files carry the weight. Files 07 and 08 are the load-bearing ones for this repo; 02 and 04 are mostly "here's why the thing you'd expect (threads, locks) isn't here, and when it would be."

## What this guide owns vs neighbors

```
  runtime-systems     HOW code executes inside one machine / one runtime  ← this guide
  system-design       WHERE components live and how requests cross boundaries
  networking          the transport beneath the awaited I/O (TLS, HTTP, retries)
  performance-eng     measuring + optimizing that execution (budgets, throughput)
  distributed-systems correctness when multiple machines coordinate
  agent-architecture  the reasoning shape of the bounded loop (ReAct, synthesis)
```

When a topic is really about the wire (timeouts, connection pooling) it's networking. When it's about measuring the loop (latency budgets, profiling) it's performance-engineering. When it's the *shape* of the agent loop's decisions it's agent-architecture. This guide owns the execution substrate: the loop, the tasks, the memory, the streams, the cancellation.

## Cross-links

- `.aipe/study-agent-architecture/` — the bounded loop's reasoning shape (ReAct, forced synthesis). 07 here cross-links it for the *control-flow* half; agent-architecture owns the *decision* half.
- `.aipe/study-system-design/` — provider abstraction, streaming-NDJSON as an architecture seam, request flow.
- `.aipe/study-networking/` *(when generated)* — the awaited `fetch`/SDK calls in 03 sit on top of HTTP; retries/timeouts/pooling live there.
- `.aipe/study-performance-engineering/` *(when generated)* — budgets and throughput for the same loop 07 bounds.
- `.aipe/study-distributed-systems/` *(when generated)* — the fallback chain (04, 07) is the closest thing here to partial-failure handling across providers.
