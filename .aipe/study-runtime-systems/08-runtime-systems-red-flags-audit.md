# 08 — Runtime-Systems Red Flags (Audit)

**Industry name:** execution-model risk audit · *Project-specific*

The ranked execution-model risks in AptKit, most consequential first. Each is grounded in `file:line`, distinguishes observed behavior from inference, and names the move. The honest headline: this is a clean single-threaded runtime where the bounds and cancellation are done well; the risks are all about *overload* and *time*, not correctness or concurrency.

## Zoom out, then zoom in

```
  Zoom out — where the risks sit

  ┌─ Application/runtime layer ──────────────────────────────────┐
  │  agent loop: bounded ✓  cancellable ✓  timeout ✗             │ ← R3
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Streaming layer ────────▼───────────────────────────────────┐
  │  read backpressure ✓     write backpressure ✗               │ ← R1
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Retrieval / memory layer ─▼─────────────────────────────────┐
  │  sync cosine scan (unbounded) · embed+recall cancel not wired │ ← R6, R7
  │  memory counter Map: unbounded in-process, restart-ephemeral  │ ← R8
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Concurrency layer ──────▼───────────────────────────────────┐
  │  serial tools (latency) · filesystem last-write-wins         │ ← R2, R4
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: an execution-model risk is a place where the runtime behaves badly under conditions the happy path never hits — overload, a slow client, a hung dependency, contention. None of these break AptKit's *correctness*; they're throughput, latency, and resource-exhaustion risks. That's the right severity frame: ranked by "what happens under stress," not "is it wrong."

## Structure pass

**Axis — "what condition triggers this, and what's the blast radius?"** Holding that constant ranks the findings: a risk that triggers under common load with a process-wide blast radius outranks one that needs a rare collision and only affects one file.

```
  Ranking axis: trigger likelihood × blast radius

  R1 write backpressure   slow client (plausible) × process memory  → HIGH
  R6 sync cosine scan     large corpus (when used) × frozen loop     → MED
  R2 serial tool calls    every multi-tool turn    × per-run latency → MED
  R3 no per-call timeout  hung provider (rare-ish) × one hung run    → MED
  R7 embed+recall cancel  abort mid-embed (rare)   × one orphan req  → LOW
  R8 memory counter Map   long-running process     × slow leak       → LOW
  R4 fs last-write-wins   same-second collision    × one file        → LOW
  R5 client trace heap    huge trace in browser    × one tab         → LOW
```

## The ranked findings

### R1 — No write backpressure on the NDJSON stream (HIGH)

**Observed.** `streamReplayResponse` calls `res.write(encodeNdjsonRecord(...))` per event and ignores the return value; there is no `await once(res, 'drain')`. `apps/studio/vite.config.ts:906–909`.

**Trigger and blast radius.** When the producer (agent emitting trace events) outpaces a slow or stalled HTTP client, `res.write` returning `false` is the kernel saying "send buffer full." Ignoring it means unsent data accumulates in the Node process heap, unbounded — a slow client can grow the dev server's memory until it's killed. Blast radius is process-wide (affects every request on that server), which is why it's ranked highest despite being unlikely in the current human-paced usage.

**Inference vs observed.** Observed: the return value is ignored. Inferred: under a flood-to-slow-client it buffers unboundedly (standard Node stream behavior, not measured here).

**The move.** Honor backpressure: `if (!res.write(line)) await once(res, 'drain')`. The NDJSON protocol, the `finally{ res.end() }`, and the client decoder all stay identical — it's a write-loop change only. See `06` Phase B.

### R6 — In-memory vector search is an unbounded synchronous scan (MEDIUM)

**Observed.** `InMemoryVectorStore.search` iterates every stored chunk and computes `cosineSimilarity` (an O(dim) dot-product loop) inline, then sorts — all synchronously, no `await` in the scan. `packages/retrieval/src/in-memory-vector-store.ts:25-33`, `:46-57`. The `dimension` is fixed (768), but the chunk *count* is unbounded.

**Trigger and blast radius.** For the demo corpus (3 docs) this is microseconds. Index a large corpus and a single `search` call runs an O(N·768) scan with no yield point — the event loop is frozen for the whole scan, blocking every other request on that process. Blast radius is process-wide (it's a loop-freeze, like R1), which is why it outranks the latency-only R2/R3.

**Inference vs observed.** Observed: the scan is synchronous and linear in chunk count. Inferred: at large N it freezes the loop (standard single-threaded behavior; the demo corpus is too small to measure it).

**The move.** It's deliberately the "zero-cloud, from-scratch" adapter — the contract (`VectorStore`) already anticipates a `PgVectorStore` drop-in that pushes ranking into Postgres/pgvector, off the JS thread, behind the identical interface. (That pgvector store lives in a separate repo, not here.) Until then, the bound is operational: keep the in-memory corpus small. See `03`.

### R2 — Tool calls execute serially, never fanned out (MEDIUM)

**Observed.** The tool loop is `for (const toolUse of toolUses) { await tools.callTool(...) }` — no `Promise.all`. `packages/runtime/src/run-agent-loop.ts:139–189`. Same serial shape in `scripts/replay-promoted-fixtures.mjs:28–40` and every other script.

**Trigger and blast radius.** Any model turn that requests multiple *independent* tools pays the sum of their latencies instead of the max. Three independent 200ms tools take 600ms. Blast radius is per-run latency — no correctness impact.

**Inference vs observed.** Observed: serial execution. The latency cost is arithmetic, not measured.

**The move.** This is a deliberate trade, not a bug: serial gives deterministic trace ordering and trivial cancellation. Fan out *only* when tools are provably independent, with a concurrency cap and per-tool error isolation, accepting nondeterministic trace order. The `AbortSignal` already threads into each `callTool` so cancellation survives the change. See `02` Phase B. Often the right call is to leave it serial — the latency is small relative to the model call itself.

### R3 — No per-call timeout on the awaited model request (MEDIUM)

**Observed.** `await model.complete({ ..., signal })` has no deadline; the loop bounds iterations, tokens, and tool count but not wall-clock time per call. `run-agent-loop.ts:103–109`. The only escape from a hung call is the externally-supplied `AbortSignal`.

**Trigger and blast radius.** A provider that accepts the connection but never responds hangs that one run indefinitely (subject to the SDK's own internal defaults, which exist but aren't configured here). Blast radius is one run plus the resources it holds (a stuck stream socket, the live `messages` array).

**Inference vs observed.** Observed: no `Promise.race` against a timer, no configured SDK timeout. Inferred: a non-responsive provider hangs until the SDK's built-in timeout (if any) or an external abort.

**The move.** Compose a deadline into the existing signal: `AbortSignal.timeout(ms)` merged with the caller's signal at the top of the loop. Zero new plumbing — every layer already accepts and honors an `AbortSignal`. See `07` Phase B.

### R7 — The agent's AbortSignal never reaches the embedding or memory-recall call (LOW)

**Observed.** Two instances of the same gap. (a) `OllamaEmbeddingProvider.embed` accepts an `AbortSignal` and threads it to the socket (`packages/retrieval/src/ollama-embedding-provider.ts:50-57`), but `pipeline.query` calls `embed([query])` with no options (`packages/retrieval/src/pipeline.ts:56`), so the agent's signal — which reaches the model call correctly — is dropped at the pipeline seam. (b) `@aptkit/memory` is the *worse* of the two: `recall(query, k?)` and `remember(turn)` take no signal argument at all (`packages/memory/src/conversation-memory.ts:36-38`), so there's no seam to thread one through — and the `search_memory` handler calls `await memory.recall(query, topK)` signal-less (`packages/memory/src/memory-tool.ts:52`). Both the `embed([query])` and `store.search(...)` inside `recall` run with no signal.

**Trigger and blast radius.** Abort a RAG or memory-recall run while it's embedding: the model call tears down, but the in-flight HTTP request to localhost Ollama (or a slow `PgVectorStore` search) runs to completion as an orphan. Blast radius is one orphaned request that finishes unwatched — small, hence LOW.

**Inference vs observed.** Observed: the embed provider accepts a signal but the pipeline doesn't pass one; the memory contract has no signal parameter at all. Inferred: an abort mid-embed leaves the request running (the provider's `throwIfAborted` only fires if a signal is supplied; memory has no checkpoint at all).

**The move.** RAG side: one-line fix, thread `signal` through `RetrievalPipeline.query` → `embedder.embed(texts, { signal })` — the provider half is already built correctly. Memory side: slightly larger — add a `{ signal }` option to the `ConversationMemory` contract first, then thread it into `embed`/`search`. See `07`.

### R8 — The memory counter Map is unbounded in-process state, lost on restart (LOW)

**Observed.** `createConversationMemory` closes over `const counters = new Map<string, number>()` (`packages/memory/src/conversation-memory.ts:71`) that persists across `remember` calls to mint distinct ids per conversation (`memory:${conversationId}:${n}`). One entry per distinct `conversationId`, never evicted; the read-modify-write is atomic (synchronous, before the `await store.upsert` — no race, see `04`).

**Trigger and blast radius.** Two distinct problems, both LOW. *Leak:* a long-running process that serves many conversations grows the `Map` without bound — one entry per conversation, forever, until restart. For a dev server this is negligible; for a long-lived production process it's a slow leak. *Durability:* the counter is in-process only, so a restart resets every conversation's `n` to 0 — a post-restart `remember` for a pre-existing conversation would mint `memory:conv:0` again and `upsert` over the first stored turn. Blast radius is one overwritten memory row (or unbounded process memory over a very long uptime).

**Inference vs observed.** Observed: the `Map` never evicts and is closure-local (not persisted). Inferred: restart causes id reuse and a same-id upsert overwrite (the store's `upsert` is last-write-wins on id).

**The move.** Accept it for the demo (single short-lived process, few conversations). If memory ever runs in a long-lived process: derive `n` from a durable source instead of an in-process counter — e.g. count existing rows for the conversation in the store, or use a content/UUID-based id that doesn't depend on a per-process counter. That removes both the leak and the restart-collision in one change. See `04`, `05`.

### R4 — Filesystem writes are last-write-wins with no lock (LOW)

**Observed.** Promote and save write JSON to a computed path with no file lock; collision avoidance is by embedding a timestamp + slug in the filename. `apps/studio/vite.config.ts:1356–1360`, `:374–377`.

**Trigger and blast radius.** Two writers targeting the identical path (same fixture + provider + second) overwrite each other silently. Blast radius is one file; no in-memory corruption (see `04`).

**Inference vs observed.** Observed: no `flock`, naming-based avoidance. Inferred: a same-second collision is last-write-wins (standard fs behavior).

**The move.** Accept it — the contention pattern (manual Studio promotes, sequential script runs) makes a same-second same-name collision practically impossible, and the artifacts are append-mostly. If concurrent automated promotion ever appears, switch to write-temp-then-rename (atomic) or include a random suffix.

### R5 — Client accumulates the full trace in component state (LOW)

**Observed.** The browser consumes the stream record-by-record (flat memory in the decoder, `apps/studio/src/api.ts:138–161`), but the React layer collects events into state for display. A pathologically large trace would grow the *browser* tab's heap.

**Trigger and blast radius.** Only a runaway trace (which the bounded loop in `07` prevents — `maxTurns` caps the event count) could grow this. Blast radius is one browser tab.

**Inference vs observed.** Observed: streaming decode is flat. Inferred: the React-side accumulation is bounded *because the loop is bounded*, not because the UI caps it.

**The move.** No action — the bound lives upstream in the agent loop. If unbounded external traces were ever loaded, virtualize the list.

## What is NOT a red flag (deliberately clean)

These are the things an auditor might flag in another codebase but which are correctly handled or correctly absent here:

```
  Checked and clean
  ─────────────────
  in-memory races         ✓ run-to-completion + per-run state (04)
  resource leaks          ✓ finally{ res.end() } + fs/promises (06)
  cancellation reaching    ✓ signal threaded to the SDK socket (07)
    the wire
  unbounded message growth ✓ maxTurns + 16KB truncate (05, 07)
  loop-blocking sync work  ✓ tool-result spans bounded; cosine scan = R6 (03)
  fallback-on-abort bug    ✓ fallback re-throws aborts (07)
  nested Gemma retry loop  ✓ maxToolCallAttempts caps it + signal checks (07)
```

## `not yet exercised`

Runtime-systems mechanisms absent from the repo (not risks — just untouched territory):

- **Worker threads / `Worker` / `worker_threads` / `cluster` / process pools** — no multi-threading or multi-process fan-out. Verified absent in source. Relevant only if CPU-bound work appears (the on-device ML in Rein's `contrl` is that workload — different repo).
- **Mutexes / semaphores / `Atomics` / `SharedArrayBuffer`** — no shared mutable concurrent state to guard (`04`).
- **Manual memory management / object pools / `Buffer` reuse / GC tuning** — V8 defaults suffice for the small, short-lived live set (`05`).
- **Stream `drain`/`pipeline`/`highWaterMark` handling** — the missing piece behind R1 (`06`).
- **Per-call deadlines / `Promise.race(timeout)` / graceful shutdown (`SIGTERM` drain)** — the missing piece behind R3 (`07`).

## Validate

1. **Reconstruct:** Rank R1–R7 by trigger-likelihood × blast-radius from memory; justify why R1 and R6 (both loop-freezes, process-wide) outrank the latency-only R2/R3.
2. **Explain:** Why is "no in-memory races" not a finding here? (Run-to-completion + per-run state — `04`, `run-agent-loop.ts:94–95`.)
3. **Apply:** A new endpoint streams a 100k-event export to a phone on a slow connection. Which finding bites, and what's the fix? (R1 — honor `drain`, `vite.config.ts:907`.)
4. **Defend:** Argue why R2 (serial tools) might be left exactly as-is, and the one condition under which you'd fan out.

## See also

- `00-overview.md` — the same findings in the overview's ranked list.
- `06-filesystem-streams-and-resource-lifecycle.md` — R1, R4 in depth.
- `07-backpressure-bounded-work-and-cancellation.md` — R3, R7 (both embed + memory-recall signal gaps), the nested Gemma loop, and the clean bounds/cancellation.
- `04-shared-state-races-and-synchronization.md` — R8 (the memory counter `Map`) as state, and why it's not a race.
- `03-event-loop-and-async-io.md` — R6 (the unbounded synchronous cosine scan) and memory's bounded sync filter in depth.
- `02-processes-threads-and-tasks.md` — R2 in depth.
- `.aipe/study-performance-engineering/` *(when generated)* — measuring R1/R2/R3 under load.
