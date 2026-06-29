# Runtime Systems — Red-Flags Audit

*Ranked execution-model risks, grounded in real files. Each verdict names its evidence. Risks are ranked by consequence — what actually breaks, and when.*

The framing first: aptkit is a single-process, single-threaded, I/O-bound library. Most "runtime red flags" (deadlocks, thread starvation, lock contention, descriptor exhaustion) **cannot occur** because the conditions for them don't exist. The real risks are narrower and honest: one blocking CPU loop, one unbounded heap, no concurrency control, and no shutdown. None of them bite at demo scale; each is named with the precise condition that makes it bite.

## Risk ranking

```
  Severity × likelihood — ranked

  HIGH consequence, LOW likelihood-today
   1. cosine scan blocks the event loop (sync, O(n·d), no yield)
   2. chunks Map grows unbounded (no eviction)

  MEDIUM consequence, conditional
   3. no concurrency limiter / backpressure across runs
   4. no graceful shutdown (no SIGTERM handler)

  LOW consequence, latent
   5. shared provider instance → cross-conversation ID reuse
   6. whole-body / whole-file buffering (no streaming parse)
```

---

## 1. The cosine scan blocks the event loop — HIGH consequence, grows with corpus

**Verdict:** `InMemoryVectorStore.search` runs a synchronous `O(n·d)` cosine scan (d = 768) plus an `O(n log n)` sort on the event loop, with no `await` inside it. While it runs, *every other task on the loop is starved* — other in-flight requests, timers, stream writes.

**Evidence:** `packages/retrieval/src/in-memory-vector-store.ts:25-33` — the `for...of` over `this.chunks.values()` calling `cosineSimilarity` (`:46-57`, a 768-iteration inner loop) with no yield point; method is `async` but contains no `await`.

**When it bites:** corpus size. At demo scale (tens of chunks) it's microseconds — invisible, and the right call for a from-scratch in-memory store. At thousands of chunks it becomes milliseconds of *blocking* per query, adding that latency to every concurrent request sharing the loop. Linear in chunk count.

**The move:** swap to `PgVectorStore` (in buffr) behind the same `VectorStore` contract — moves the scan into Postgres, off aptkit's loop. A `worker_thread` is the in-process fallback. Do **not** chunk the scan with `setImmediate`; that trades blocking for added latency and complexity. → full mechanics in `03-event-loop-and-async-io.md`; cost analysis in `study-performance-engineering`.

---

## 2. The chunks Map grows unbounded — HIGH consequence, no eviction path

**Verdict:** `InMemoryVectorStore.chunks` accumulates a ~6 KB vector (768 floats) plus text per chunk and is **never evicted** — `upsert` only ever `.set`s. Memory grows `O(n_chunks)` monotonically for the store instance's lifetime.

**Evidence:** `packages/retrieval/src/in-memory-vector-store.ts:12` (the `Map`), `:18-23` (`upsert` — only `.set`, no `.delete`, no cap). Same growth for episodic memory rows upserted via `conversation-memory.ts:82`.

**When it bites:** sustained indexing into a long-lived in-memory store. A demo corpus is nothing; a real or growing knowledge base climbs until the heap is exhausted. There's no TTL, no LRU, no size limit.

**The move:** same as #1 — the durable home is `PgVectorStore`, where vectors live on disk. If the in-memory store must stay, add eviction (LRU/size cap). Not a GC-tuning problem — a "cache with no eviction" problem. → `05-memory-stack-heap-gc-and-lifetimes.md`.

---

## 3. No concurrency limiter or backpressure across runs — MEDIUM, conditional on the caller

**Verdict:** nothing bounds *how many* agent runs execute at once. A caller can launch arbitrarily many `runAgentLoop`s concurrently, each opening its own Ollama `fetch`; there is no semaphore, queue, or backpressure to throttle intake when Ollama is saturated.

**Evidence:** absence — no `Promise.all`/limiter/queue in product code; the bounds in `run-agent-loop.ts:98-109` are strictly *within* one run (`maxTurns`/`maxToolCalls`), not across runs.

**When it bites:** when the consumer fans out many concurrent requests against one Ollama instance. Ollama serializes/queues internally, so aptkit's unbounded fan-out turns into a pile of pending `fetch`es and unbounded latency, with no shedding.

**The move:** the limiter belongs to the consumer (buffr) — a semaphore capping concurrent runs, or a queue with backpressure. aptkit correctly doesn't own dispatch. The hook already exists: pass an `AbortSignal` to shed load by cancelling queued runs. → `07-backpressure-bounded-work-and-cancellation.md`.

---

## 4. No graceful shutdown — MEDIUM, deliberate boundary

**Verdict:** no `SIGTERM`/`SIGINT` handler anywhere in product code. On process stop, in-flight agent runs are killed mid-await with no draining and no cleanup.

**Evidence:** absence — no `process.on('SIGTERM'...)` in any package; the only `process.exit` calls are in standalone CLI scripts (`packages/agents/rag-query/scripts/ask.ts:77`, `eval.ts:86`).

**When it bites:** on deploy/restart in a service context — in-flight model spend is wasted, partial work is dropped, streaming clients see a dropped connection.

**The move:** this is the consumer's (buffr's) job — aptkit is a library and doesn't own the process. The cooperative-cancellation half is *already built*: buffr installs the `SIGTERM` handler and aborts the in-flight `AbortSignal`s aptkit already threads everywhere (`run-agent-loop.ts:99`, providers, registry). aptkit built the hook; buffr pulls it. → `07-backpressure-bounded-work-and-cancellation.md`.

---

## 5. Shared provider instance → cross-conversation ID reuse — LOW, latent

**Verdict:** `GemmaModelProvider.toolUseCount` is per-instance mutable state. Share one instance across two conversations and their tool-use IDs draw from the same counter — a logical collision, not a memory race.

**Evidence:** `packages/providers/gemma/src/gemma-provider.ts:44` (the counter), `:110-114` (`nextToolUseId` increments it). Safe from data races because the increment is a single synchronous statement (`04-shared-state-races-and-synchronization.md`); the risk is *logical* sharing.

**When it bites:** only if a host wires one `GemmaModelProvider` instance across concurrent/unrelated conversations. Today each agent run wires its own — `not yet exercised`.

**The move:** instantiate one provider per conversation (cheap), or scope the counter to the conversation. Don't reach for a lock — JS has none and the issue isn't a race.

---

## 6. Whole-body / whole-file buffering — LOW, known ceiling

**Verdict:** HTTP responses and files are read *whole* into memory (`res.json()`, `readFile`), not streamed. Memory spikes proportional to payload size.

**Evidence:** `gemma-provider.ts:213`, `ollama-embedding-provider.ts:72` (`res.json()`), `apps/studio/vite.config.ts:953` etc. (`readFile`), `vite.config.ts:921-937` (request body accumulated whole).

**When it bites:** a pathologically large embedding batch or artifact file. At aptkit's sizes (KB-range payloads, modest batches) it's a non-issue — a deliberate simplicity choice with a known ceiling.

**The move:** if batch/file sizes grow, switch to a streaming JSON parser or `createReadStream`. aptkit already ships the streaming *decoder* for NDJSON output (`ndjson-stream.ts:103-135`), so the pattern is in-house when needed. → `06-filesystem-streams-and-resource-lifecycle.md`.

---

## What's NOT a risk (and why)

These are common runtime red flags that **cannot occur** in aptkit's model — named so the audit is honest about the floor, not just the ceiling.

- **Deadlocks / lock contention** — no locks, no mutexes; one thread, cooperative scheduling. Nothing to deadlock on.
- **Data races / torn writes** — single thread, run-to-completion atomicity; all read-modify-writes are synchronous. → `04`.
- **Thread-pool starvation** — no thread pool; aptkit never touches libuv's worker pool (no fs/crypto/dns in core).
- **Descriptor exhaustion** — core holds no file descriptors; sockets auto-close after body read; Studio's `readFile` opens+closes per call. → `06`.
- **Resource leaks on error** — the one held resource (Studio's NDJSON response stream) is closed in a `finally` (`vite.config.ts:917`). → `06`.

## `not yet exercised` — the full list

threads / `worker_threads` · child processes in the hot path · `cluster` · `Promise.all`/`.race`/`.allSettled` (any concurrent fan-out) · concurrency limiter / semaphore · queue / backpressure · `SIGTERM`/`SIGINT` handler · in-flight drain on shutdown · shared mutable state across concurrent tasks · manual GC tuning / heap-limit config · streaming JSON parse / `createReadStream` · LRU/TTL eviction on the in-memory store.

Every one of these is correctly absent for a single-process, I/O-bound library at demo scale. Each becomes relevant the moment aptkit's code runs *inside* buffr's service — which is precisely why those concerns live in buffr, the process owner, not in aptkit.

## See also

- `00-overview.md` — the three top findings in context
- `03-event-loop-and-async-io.md` — risk #1 mechanics
- `05-memory-stack-heap-gc-and-lifetimes.md` — risk #2 mechanics
- `07-backpressure-bounded-work-and-cancellation.md` — risks #3 and #4
- `study-performance-engineering` — quantified cost of risks #1, #2, #6
- `study-distributed-systems` — coordination once aptkit is one node in buffr
