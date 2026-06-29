# Shared State, Races, and Synchronization

**Subtitle:** shared mutable state / data races / the single-threaded safety guarantee — *the race condition* (Industry standard).

## Zoom out, then zoom in

The verdict first: aptkit has **no locks, no mutexes, no atomics, no channels — and it needs none, today.** Not because it's clever about synchronization, but because it has almost no shared mutable state and zero real concurrency. The interesting question isn't "where are the locks" — it's "what mutable state exists, and what would break the moment real concurrency arrived?"

```
  Zoom out — where mutable state lives in the runtime

  ┌─ Capability layer ──────────────────────────────┐
  │  agents — fully stateless per call               │
  └───────────────────────┬──────────────────────────┘
  ┌─ Runtime layer ───────▼──────────────────────────┐
  │  runAgentLoop — all state is STACK-LOCAL          │
  │   (messages[], toolCalls[], finalText)            │
  └───────────────────────┬──────────────────────────┘
  ┌─ Provider / store layer ─────────────────────────┐
  │  ★ GemmaModelProvider.toolUseCount ★  (mutable)   │ ← THIS CONCEPT
  │  ★ InMemoryVectorStore.chunks (Map) ★ (mutable)   │   the only shared state
  └───────────────────────────────────────────────────┘
```

**Zoom in.** A race condition needs two things: shared mutable state, *and* two threads/tasks touching it interleaved. aptkit has a little of the first and (effectively) none of the second. So this file is mostly about identifying the two pieces of mutable instance state, showing why they're safe under today's single-task model, and naming precisely the concurrency pattern that would turn them into bugs.

## The structure pass

Trace the axis **"who can mutate this, and could two writers overlap?"** down the layers.

```
  One axis — "is this mutable, and can writers overlap?" — by layer

  ┌─ stack-local (runAgentLoop) ──┐   mutable, but private to ONE call
  │  messages[], toolCalls[]       │   → no overlap possible; dies with the call
  └──────────────┬─────────────────┘
  ┌─ instance state (per object) ┐   mutable, SHARED across calls to that object
  │  toolUseCount, chunks Map      │   → overlap possible IF two tasks share the
  └──────────────┬─────────────────┘     instance AND interleave
  ┌─ module / global ────────────┐   none — no module-level mutable state
  │  (no singletons, no globals)   │   → nothing to race on
  └───────────────────────────────┘
```

The seam is between **stack-local** and **instance** state. Stack-local state can never race — each `runAgentLoop` call gets its own `messages` array (`run-agent-loop.ts:94`), its own `toolCalls` (`run-agent-loop.ts:95`); two concurrent loops would have two separate arrays. Instance state is different: if you hand the *same* `GemmaModelProvider` to two agents and run them concurrently, they share `toolUseCount`. The axis-answer flips from "can't overlap" to "could overlap" exactly at that boundary. → and "concurrently" is the word doing all the work, because aptkit never actually does that (`02-processes-threads-and-tasks.md`).

## How it works

### Move 1 — the mental model

You've hit this in the browser. Two `fetch` calls that both do `count++` on a shared variable — if their `.then` callbacks interleave, you can read `count`, get preempted, and write a stale value. The fix you reach for is usually *not* a lock (JS has no real ones) but *not sharing the mutable state* — give each its own, or make the update atomic-by-being-synchronous. aptkit takes the synchronous route by default: JS can't interrupt a synchronous statement, so `count++` between awaits is safe.

```
  The race kernel — what makes a data race

  shared state ─┐
                ├─► two tasks read-modify-write ─┐
  interleaving ─┘    with a yield BETWEEN         ├─► lost update / torn read
                     read and write               │
                                                  ▼
  remove EITHER ingredient → no race possible
```

Named by what breaks if removed:
- **Shared state** — remove it (give each task its own copy) and there's nothing to corrupt. This is what stack-local arrays do in `runAgentLoop`.
- **Interleaving with a yield mid-update** — remove it (keep the read-modify-write synchronous, no `await` between) and JS's run-to-completion guarantees atomicity. This is what makes `toolUseCount++` safe.

aptkit removes *both* ingredients, which is belt-and-suspenders safe.

### Move 2 — the two pieces of mutable state, examined

**`GemmaModelProvider.toolUseCount` — a mutable counter, safe by synchronicity.** Here's the only mutable scalar in a provider:

```ts
// packages/providers/gemma/src/gemma-provider.ts:44, 110-114
private toolUseCount = 0;
// ...
private nextToolUseId(name: string): string {
  const id = `gemma-${name}-${this.toolUseCount}`;
  this.toolUseCount += 1;     // ← read-modify-write, but fully synchronous
  return id;
}
```

This generates unique tool-use IDs (`gemma-search_knowledge_base-0`, `-1`, …). The read-modify-write (`this.toolUseCount += 1`) has **no `await` between the read and the write** — it's one synchronous statement. Under JS's run-to-completion rule, nothing can interleave there, so even if two tasks called `nextToolUseId` "concurrently," each call runs atomically. The latent hazard isn't a torn write — it's *cross-conversation ID collisions*: if one `GemmaModelProvider` instance is shared across two unrelated conversations, their tool-use IDs draw from the same counter. That's a *logical* sharing bug, not a memory race, and it's invisible today because each agent run wires its own provider. Sharing a provider across concurrent conversations is `not yet exercised`.

**`InMemoryVectorStore.chunks` — a `Map`, safe by no-concurrent-writers.** The store holds a `Map` that accumulates across `upsert` calls:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:12, 18-23
private readonly chunks = new Map<string, VectorChunk>();
// ...
async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);    // ← mutation, but synchronous within the loop
  }
}
```

The `upsert` loop mutates the `Map` synchronously (no `await` inside the `for`), and `search` only *reads* it. The classic hazard — a `search` iterating `this.chunks.values()` (`in-memory-vector-store.ts:28`) while an `upsert` mutates the same `Map` — would throw or skip entries in many languages. In aptkit it can't happen, because (a) there's one thread and (b) neither method yields mid-iteration. A `search` runs its entire scan synchronously before any `upsert` could run. Concurrent index-while-querying is `not yet exercised`, and it's the exact scenario where buffr's `PgVectorStore` (a real database with MVCC) earns its keep — Postgres handles concurrent read/write correctly; the in-memory `Map` only handles it because nothing is concurrent.

```
  Comparison — why the Map is safe now vs. what breaks under concurrency

  TODAY (single task)                  IF two tasks interleaved (hypothetical)
  ──────────────────────               ─────────────────────────────────────
  search() scans fully    ┐            search() starts iterating values()  ┐
  THEN upsert() mutates    ├ safe       upsert() mutates Map mid-iteration  ├ would
  (or vice versa)          │            → "Map changed during iteration" or  │ break
  never interleaved        ┘            skipped/duplicated hits              ┘
```

**Everything else is stack-local and unshareable.** Inside `runAgentLoop`, `messages` (`run-agent-loop.ts:94`), `toolCalls` (`run-agent-loop.ts:95`), and `finalText` (`run-agent-loop.ts:96`) are all declared per-call. Two concurrent loops would never see each other's arrays. The `for` loop's `turn` counter, the per-turn `toolResults` — all stack-local. This is the bulk of aptkit's mutable state, and none of it can race, ever, by construction.

### Move 3 — the principle

The cheapest synchronization is no shared state. aptkit's safety comes from two disciplines applied without fanfare: keep per-request state on the stack (so it can't be shared), and keep read-modify-writes synchronous (so they can't be interleaved). You only reach for locks/atomics/channels when you have genuine parallelism *and* unavoidable shared state — neither of which aptkit has yet. The day it gets concurrent task fan-out (`Promise.all` over shared instances), the two pieces of instance state become real hazards, and the answer won't be a JS lock (there isn't one) — it'll be "don't share the instance" or "move the state to a store that handles concurrency" (Postgres).

## Primary diagram

```
  Shared state and safety in aptkit — complete

  ┌─ One thread, one task at a time (the safety guarantee) ─────────┐
  │                                                                 │
  │  STACK-LOCAL (per call — cannot be shared, cannot race)         │
  │   ┌──────────────────────────────────────────────────────┐     │
  │   │ runAgentLoop: messages[], toolCalls[], finalText       │     │
  │   └──────────────────────────────────────────────────────┘     │
  │                                                                 │
  │  INSTANCE STATE (shared across calls to one object)             │
  │   ┌──────────────────────────────┐  ┌────────────────────────┐ │
  │   │ GemmaProvider.toolUseCount    │  │ InMemoryVectorStore     │ │
  │   │  safe: sync read-mod-write    │  │  .chunks (Map)          │ │
  │   │  hazard: cross-convo ID reuse │  │  safe: no concurrent    │ │
  │   │  if instance shared           │  │  writers; hazard: index │ │
  │   └──────────────────────────────┘  │  -while-query (→ PgVector)│ │
  │                                      └────────────────────────┘ │
  │                                                                 │
  │  GLOBAL / MODULE: none. No singletons, no module-level mutables.│
  │  LOCKS / ATOMICS / CHANNELS: none — not yet needed.             │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

JavaScript's single-threaded model is a synchronization *strategy*, not just a constraint — "run to completion" gives you atomicity for free on any code path with no `await`. That's why most Node code never touches a lock: races require both shared state and a yield between read and write, and idiomatic Node keeps mutations synchronous. The discipline aptkit follows — stack-local per-request state, instance state only where it must persist (the corpus) — is the same one that keeps Express handlers safe. The place it would crack is `worker_threads` with `SharedArrayBuffer` (real shared memory, real `Atomics`) or sharing a mutable instance across concurrent tasks. Neither is in the repo. The retrieval contracts are designed so that "make the store concurrency-safe" is answered by swapping in `PgVectorStore` (in buffr), not by adding locks to the in-memory one.

## Interview defense

**Q: aptkit has shared mutable state — why are there no locks?**
Because a race needs shared state *and* interleaving with a yield mid-update, and aptkit removes both. The two pieces of mutable instance state — `toolUseCount` and the chunks `Map` — are mutated synchronously, so JS's run-to-completion makes the updates atomic; and there's one thread with no concurrent tasks, so nothing interleaves. Locks would be solving a problem that can't occur yet.

```
  race = shared state + interleaved read-mod-write. Remove either → safe.
```
*Anchor: `toolUseCount += 1` is one synchronous statement — nothing can interleave between the read and the write.*

**Q: What breaks the day you add `Promise.all` over a shared provider?**
The instance state becomes shared across overlapping tasks. `toolUseCount` would hand the same ID prefix to two conversations; a `search` could iterate the chunks `Map` while an `upsert` mutates it. The fix isn't a JS lock — give each task its own provider instance, and move the corpus to a store that handles concurrent read/write (Postgres / `PgVectorStore`).

## See also

- `02-processes-threads-and-tasks.md` — why "concurrent tasks" doesn't happen today
- `05-memory-stack-heap-gc-and-lifetimes.md` — where this state lives in memory
- `07-backpressure-bounded-work-and-cancellation.md` — the fan-out that would introduce concurrency
- `study-distributed-systems` — concurrency once buffr is the process owner
