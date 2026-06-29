# Shared State, Races, and Synchronization — what one thread buys you

**Industry name(s):** data races / synchronization · shared mutable state · run-to-completion semantics · **Type:** Industry standard

## Zoom out, then zoom in

Most of a "synchronization" chapter is about locks, atomics, and channels protecting shared memory from concurrent threads. aptkit has none of those, and the reason is the single most useful fact about its runtime: there's one thread, so there's nothing to lock.

```
  Zoom out — where shared state could live, and what guards it

  ┌─ Runtime layer ──────────────────────────────────────────────────┐
  │   runAgentLoop: messages[], toolCalls[]  → LOCAL to one call (no  │
  │                                             sharing → no race)     │
  └──────────────────────────────────┬─────────────────────────────────┘
  ┌─ Provider layer ──────────────────▼─────────────────────────────────┐
  │   GemmaModelProvider.toolUseCount  → instance field, MUTABLE        │ ← we are here
  │   FallbackModelProvider.lastSelectedProvider → instance field, MUT  │
  └──────────────────────────────────┬─────────────────────────────────┘
  ┌─ Retrieval layer ─────────────────▼─────────────────────────────────┐
  │   InMemoryVectorStore.chunks (Map) → mutable, shared if reused      │
  │   conversation-memory counters (Map) → mutable per-instance         │
  └──────────────────────────────────────────────────────────────────────┘

  guard mechanism across all of them: JS run-to-completion. no locks exist.
```

**Zoom in.** A data race needs two things: shared mutable state, and two execution contexts touching it at the same instant. aptkit has the first (a few mutable fields) but structurally cannot have the second (one thread). So this file is short by design — it explains *why* the races are absent, names the one place that's still a latent footgun (a provider instance shared across concurrent agent runs), and stops. Don't invent locking the repo doesn't need.

## Structure pass

Trace the **state** axis — who owns each piece of mutable state, and can two things touch it concurrently?

```
  Axis: "is this state shared across concurrent work?" — per location

  ┌──────────────────────────────────────────────────────────┐
  │ runAgentLoop messages[] / toolCalls[]                      │  → NO: born and dies
  │   (run-agent-loop.ts:94-95)                                │     inside one call
  └───────────────────┬────────────────────────────────────────┘
      ┌───────────────▼────────────────────────────────────────┐
      │ GemmaModelProvider.toolUseCount (gemma-provider.ts:44)   │  → MAYBE: shared if one
      │ FallbackModelProvider.lastSelectedProvider (:30)         │     provider instance is
      │                                                          │     reused across runs
      └───────────────┬────────────────────────────────────────┘
          ┌───────────▼────────────────────────────────────────┐
          │ InMemoryVectorStore.chunks Map (:12)                 │  → SHARED by design
          │   (the corpus — read by many queries)                │     (reads only after index)
          └────────────────────────────────────────────────────┘
```

The seam: **the boundary between call-local state and instance state.** Inside `runAgentLoop`, everything is a local variable — no two calls can see each other's `messages`. The moment state moves onto a provider *instance* field (`toolUseCount`, `lastSelectedProvider`), it's shared across every call to that instance. On one thread that's still safe (run-to-completion), but it's the only place the safety depends on *not* awaiting between read and write — and the provider code does await between them.

## How it works

### Move 1 — the mental model

You know `useState` doesn't tear: a React component's state updates aren't interrupted mid-update by another render, because JS runs each callback to completion before starting the next. Same guarantee, server-side. Between two `await` points, your code runs atomically — no other task can interleave. The race window only opens *across* an `await`.

```
  Run-to-completion — the free mutex

  task A:  read count ── increment ── write count   ← all synchronous:
           └──────── ATOMIC, no gap ────────┘          no task B can interleave

  task A:  read count ── await fetch ── write count  ← the await is a GAP:
                          ▲                              task B CAN run here
                          │ if A and B share `count`, B sees stale value
                       race window
```

The rule: **synchronous spans are atomic; the danger is read-modify-write that straddles an `await` on shared state.** That's the one pattern to hunt for.

### Move 2 — the three kinds of state, walked

**Call-local state: safe, the common case.** `run-agent-loop.ts:94`:

```ts
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
const toolCalls: ToolCallRecord[] = [];
let finalText = '';
```

These live in the function's closure. Every `runAgentLoop` invocation gets its own. Two concurrent agent runs (say, two Studio replays in flight) never share these arrays — there's no race because there's no sharing. This is the dominant pattern in the repo and it's correct.

**Instance counter state: a latent footgun.** `gemma-provider.ts:44` and `:110`:

```ts
private toolUseCount = 0;
// ...
private nextToolUseId(name: string): string {
  const id = `gemma-${name}-${this.toolUseCount}`;
  this.toolUseCount += 1;          // ← read-modify-write on instance state
  return id;
}
```

`nextToolUseId` runs synchronously (no `await` between read and write), so even if the same `GemmaModelProvider` instance served two concurrent `complete()` calls, this increment itself can't tear. But the *intent* — monotonic, collision-free tool-use ids — assumes a single logical conversation. Share one provider instance across two unrelated agent runs and the ids interleave (`gemma-search-0`, `gemma-search-1` from two different conversations). That's not a data race; it's an identity-collision-by-sharing. The repo's usage pattern is one provider per run, so it's fine today — but it's the field to flag in review. Same shape for `FallbackModelProvider.lastSelectedProvider` (`fallback-provider.ts:30`): it records which provider won the *last* call, so sharing one fallback instance across concurrent calls makes "last selected" ambiguous.

```
  The footgun: instance state shared across runs

  one provider instance ── complete() call A ──► toolUseCount: 0→1→2
                       └── complete() call B ──► toolUseCount: 2→3→4
                                                  ▲
                            ids from A and B interleave on the shared counter
                            (no torn write — but a logical id collision)

  the fix is not a lock: it's "one provider instance per agent run"
```

**Shared corpus state: read-only after index.** `in-memory-vector-store.ts:12` — `private readonly chunks = new Map<string, VectorChunk>()`. The `Map` is mutated during `upsert` (indexing) and read during `search` (querying). If those phases overlapped concurrently you'd want care, but the lifecycle is index-then-query: writes happen at setup, reads happen at runtime. A concurrent `upsert` during a `search` would, on one thread, still be safe — the `search` loop (`in-memory-vector-store.ts:28`) is synchronous and runs to completion before any `upsert` task could start. The single thread is doing the synchronization for free.

**Why no locks, atomics, or channels exist — and shouldn't.** There is no `Atomics`, no `Mutex`, no message channel anywhere in `packages/`. Adding one would be cargo-culting: locks coordinate threads, and there's one thread. The correct "synchronization primitive" in this codebase is the run-to-completion guarantee plus the discipline of keeping state call-local. The day aptkit adds `worker_threads` (the `05`/`08` escape hatch for the cosine scan), *then* shared-memory concerns become real — and the answer there is message-passing (workers don't share heap by default), not locks.

### Move 3 — the principle

Single-threaded JS gives you a coarse mutex for free: any synchronous span is atomic, so the only race surface is shared state touched across an `await`. The engineering move isn't to add locks — it's to keep state call-local so there's no shared surface at all, and where instance state is unavoidable (a counter, a "last selected"), make sure either the read-modify-write is synchronous or the instance isn't shared across logical work. aptkit does the first instinctively (everything in `runAgentLoop` is local) and is exposed only on the second, in a way that's a usage convention, not a code bug.

## Primary diagram

The complete state map: local state is race-free, instance state is convention-guarded, the corpus is read-only at runtime, and run-to-completion is the only synchronization.

```
  aptkit shared-state map — complete

  ┌─ ONE thread: run-to-completion is the only synchronization ──────────┐
  │                                                                       │
  │  CALL-LOCAL (safe — no sharing)                                       │
  │   runAgentLoop: messages[], toolCalls[], finalText                    │
  │   structured-generation: attempts[]                                   │
  │                                                                       │
  │  INSTANCE STATE (convention-guarded — "one instance per run")         │
  │   GemmaModelProvider.toolUseCount    ── sync RMW, no tear             │
  │   FallbackModelProvider.lastSelectedProvider ── set per call          │
  │   conversation-memory counters Map   ── per-conversation ids          │
  │                                                                       │
  │  SHARED CORPUS (read-only at query time)                              │
  │   InMemoryVectorStore.chunks Map ── written at index, read at search  │
  │                                                                       │
  │  ✗ no locks  ✗ no atomics  ✗ no channels — none needed on one thread  │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "free mutex" of single-threaded JS is why Node sidestepped an entire class of bugs that plague threaded servers — no torn reads, no deadlocks, no lock-ordering discipline. The cost is that you can't use threads for CPU parallelism without re-introducing the problem, which is why `worker_threads` deliberately does *not* share the JS heap: workers communicate by copying or transferring messages, so there's still no shared mutable state to race on. If aptkit ever offloads the cosine scan to a worker, the corpus would be transferred or rebuilt in the worker, and synchronization would be message-passing — the channel model, not the lock model. See `02` for the thread model this rests on, and `study-distributed-systems` for the harder version of the same problem once buffr's multi-process runtime coordinates shared Postgres state across processes (where run-to-completion no longer saves you).

## Interview defense

**Q: How does aptkit avoid data races without any locks?**

```
  one JS thread + run-to-completion semantics
  → any synchronous span is atomic; no two tasks run at the same instant
  → race surface = shared state touched ACROSS an await
  aptkit keeps state call-local (runAgentLoop locals) → no shared surface
```

Anchor: "Single-threaded JS is a free coarse mutex — the only race window is a read-modify-write on shared state that straddles an `await`, and the repo keeps state call-local to avoid even that."

**Q: Is there any shared mutable state I should worry about?**

```
  yes — instance fields: GemmaModelProvider.toolUseCount,
        FallbackModelProvider.lastSelectedProvider
  not a torn-write race (the RMW is synchronous)
  but a logical collision IF one instance is shared across concurrent runs
  fix: one provider instance per agent run (a usage convention, not a lock)
```

Anchor: "The provider instances carry mutable counters — safe under the repo's one-instance-per-run usage, but the thing I'd flag if someone tried to share a provider across concurrent conversations."

## See also

- `02-processes-threads-and-tasks.md` — the single thread that makes run-to-completion hold
- `03-event-loop-and-async-io.md` — the `await` points that open the only race windows
- `study-distributed-systems` — coordination across processes (buffr), where run-to-completion no longer protects shared state
