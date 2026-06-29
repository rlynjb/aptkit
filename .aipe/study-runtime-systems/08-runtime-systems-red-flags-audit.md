# Runtime-Systems Red-Flags Audit — ranked execution-model risks

**Industry name(s):** runtime risk audit · execution-model review · **Type:** Project-specific

This file ranks the execution-model risks in aptkit by consequence, names the evidence for each verdict, and says what would change it. Verdict-first: **aptkit's runtime is low-risk because it's a single-threaded, I/O-bound library with rigorously bounded per-run work — most runtime failure modes are structurally impossible here.** The risks that remain are concentrated in two places: one synchronous CPU loop that blocks the event loop, and the system-wide controls a library deliberately doesn't own. Nothing here is a bug; they're the seams where aptkit ends and a deployment begins.

```
  Risk surface — where it concentrates

  HIGH ░░░░░░░░  (none — single thread eliminates the high-severity class)
  MED  ████░░░░  event-loop blocking (cosine scan), no concurrency limit
  LOW  ██░░░░░░  no graceful shutdown, no deadline, instance-state sharing
  N/A  ────────  thread races, deadlocks, fd leaks (structurally absent)
```

## Ranked findings

### 1. (MED) The cosine scan blocks the event loop — `async` signature, synchronous body

**Evidence:** `packages/retrieval/src/in-memory-vector-store.ts:25` — `search` is declared `async` but its body has no `await`: an O(n) loop over the corpus computing cosine similarity (`:28`), each cosine an O(d) inner loop (`:50`, d=768 for nomic), then a full `O(n log n)` sort (`:31`). The whole thing runs synchronously on the one event-loop thread.

**Consequence (concrete):** at corpus size n, a query freezes the event loop for the duration of `n × 768` multiply-adds plus the sort. At demo/test scale (dozens of chunks) that's microseconds — invisible. At n = 50,000 it's tens of milliseconds during which *no other task advances* — every concurrent agent run, every trace event, every HTTP response stalls.

**Why it's acceptable today:** aptkit is a library with a dev/test in-memory store; real corpora live in buffr's `PgVectorStore`. At current scale the inline cost is right (no async overhead, trivially traceable).

**What changes it:** the day the in-memory store holds a large corpus in a long-lived process. The fix is behind the existing `VectorStore` contract (`pipeline.ts:73`), so it's a wiring change, not a rewrite: swap to `PgVectorStore` (scan becomes a network `await` in Postgres), offload to `worker_threads`, or move to a sub-linear ANN index. → `03`, `05`.

### 2. (MED) No producer-side backpressure or concurrency limit

**Evidence:** no `Promise.all`/`allSettled`/`race`, no `p-limit`, no semaphore, no queue anywhere in `packages/`. `runAgentLoop`'s bounds (`run-agent-loop.ts:98`, `:101`) are *per-run* — turn count and tool-call count — not system-wide.

**Consequence (concrete):** if a host fires N concurrent `runAgentLoop` calls, all N are in flight at once, all hammering Ollama/the cloud simultaneously. Nothing throttles them; a burst can overwhelm the model server or blow past a provider rate limit, and the failures come back as provider errors with no smoothing.

**Why it's acceptable today:** throughput control is a deployment concern, and aptkit is deliberately deployment-agnostic. The host (buffr) owns how many concurrent runs it admits.

**What changes it:** embedding aptkit in a server taking concurrent traffic. The fix is a concurrency limiter at the *call site* (the host), not inside the loop. → `07`, `study-distributed-systems`.

### 3. (LOW) No graceful shutdown — no SIGTERM/SIGINT handler

**Evidence:** no `process.on('SIGTERM')` or `process.on('SIGINT')` anywhere in `packages/`, `apps/`, or `scripts/`.

**Consequence (concrete):** a `kill` (or a container stop) mid-run drops the run instantly — no drain of in-flight work, no flush of buffered trace events, no cleanup. Any partially-produced result is lost.

**Why it's acceptable today:** runs are short-lived (a library, not a daemon), and there's no critical mutable state mid-write that a hard stop would corrupt. Graceful shutdown is the host process's job.

**What changes it:** running aptkit inside a long-lived server. The fix uses the machinery that's *already there*: on SIGTERM, the host aborts the in-flight runs' `AbortSignal`s, and the existing cooperative-cancellation plumbing (`run-agent-loop.ts:99`, `:108`, `:159`) unwinds them cleanly. → `07`.

### 4. (LOW) No wall-clock deadline on a run

**Evidence:** `runAgentLoop` is bounded by turn *count* (`run-agent-loop.ts:98`), not elapsed time. A run with slow tools can take arbitrarily long in wall-clock terms within 8 turns.

**Consequence (concrete):** a hung or very slow model/tool call leaves the run waiting at an `await` with no timeout — it'll wait as long as the underlying `fetch` does.

**Why it's acceptable today:** small, local, fast model calls in dev/test; the turn count is an effective practical bound.

**What changes it:** production latency SLAs. The fix is trivial because cancellation is fully plumbed: pass `AbortSignal.timeout(ms)` as the run's `signal` — the existing `throwIfAborted` checks and signal-forwarding honor it with zero new code. → `07`.

### 5. (LOW) Instance state shared across runs is convention-guarded, not enforced

**Evidence:** `GemmaModelProvider.toolUseCount` (`gemma-provider.ts:44`) and `FallbackModelProvider.lastSelectedProvider` (`fallback-provider.ts:30`) are mutable instance fields.

**Consequence (concrete):** not a torn-write race (the read-modify-write at `gemma-provider.ts:110` is synchronous, and there's one thread). But if one provider instance is *shared* across two concurrent agent runs, tool-use ids interleave across conversations and "last selected provider" becomes ambiguous — a logical collision, not memory corruption.

**Why it's acceptable today:** the repo's usage is one provider instance per run.

**What changes it:** any host that pools and shares provider instances across concurrent runs. The fix is a usage convention (one instance per run) or making the providers stateless w.r.t. the counter — not a lock. → `04`.

## Structurally absent (correctly) — do not flag these

```
  Runtime failure classes that CANNOT occur here, and why

  ┌─ thread data races / torn reads ─┐  one JS thread, run-to-completion
  ┌─ deadlocks / lock-order bugs ────┐  no locks exist (none needed)
  ┌─ file-descriptor leaks ──────────┐  fs.promises = acquire-use-release in one call;
  │                                   │  the one held handle (stream reader) releases
  │                                   │  in a finally (api.ts:177)
  ┌─ unbounded agent runs ───────────┐  maxTurns + maxToolCalls + forced final turn
  ┌─ runaway retry spins ────────────┐  retry loops hard-capped (gemma 2x, structured 2x)
  ┌─ stack overflow ─────────────────┐  iterative everywhere, no deep recursion
  └───────────────────────────────────┘
```

Calling any of these a "risk" would be cargo-culting concerns from threaded/streaming systems onto a single-threaded library that designed them out.

## `not yet exercised` summary

| Concern | Status | Where it'd land | File |
|---|---|---|---|
| `worker_threads` / OS threads | absent | offload the cosine scan when n grows | `02`, `05` |
| Producer backpressure / `p-limit` | absent | host call site (buffr), not the loop | `07` |
| Rate limiting / wall-clock deadline | absent | `AbortSignal.timeout` into existing plumbing | `07` |
| SIGTERM/SIGINT graceful shutdown | absent | host aborts run signals on shutdown | `07` |
| Locks / atomics / channels | absent | only if `worker_threads` is added | `04` |
| Parallel fan-out (`Promise.all`) | absent | within-turn tool calls, if latency demands | `02` |
| Filesystem streaming | absent | only for files too big to buffer (none today) | `06` |

## The one-line verdict

aptkit's runtime is as safe as a single-threaded I/O-bound library can be: the per-run work is rigorously bounded and cleanly cancellable, the whole high-severity class of threaded-runtime bugs is structurally impossible, and the only real in-process risk — the inline cosine scan — is defused by small scale and swappable behind a contract. The remaining gaps (backpressure, deadlines, graceful shutdown) aren't defects; they're the deliberate seam where the library hands throughput and lifecycle to the deployment, and `AbortSignal` is the bridge that makes wiring them up cheap.

## See also

- `00-overview.md` — the ranked findings in the context of the whole map
- `03-event-loop-and-async-io.md` — finding 1, the blocking scan, in depth
- `07-backpressure-bounded-work-and-cancellation.md` — findings 2-4, bounds and the missing controls
- `04-shared-state-races-and-synchronization.md` — finding 5, instance-state sharing
- `study-performance-engineering` · `study-distributed-systems` — the neighboring disciplines that own throughput and cross-process coordination
