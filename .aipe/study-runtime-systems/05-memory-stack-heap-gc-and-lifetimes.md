# Memory: Stack, Heap, GC, and Lifetimes

**Subtitle:** allocation / heap retention / garbage collection (V8) / object lifetimes — *the heap* (Industry standard).

## Zoom out, then zoom in

aptkit does **zero manual memory management** — no `--max-old-space-size` tuning, no manual `global.gc()`, no buffer pooling, no streaming to keep memory flat. It leans entirely on V8's garbage collector and lives within Node's default heap. The question worth asking: *what does aptkit retain, what's transient, and where does memory grow without bound?* There's exactly one place that grows without bound, and it's the one you'd guess.

```
  Zoom out — where memory accumulates in the runtime

  ┌─ Runtime layer ──────────────────────────────────┐
  │  runAgentLoop: messages[] grows PER TURN,         │
  │   freed when the call returns (short-lived)       │
  └───────────────────────┬───────────────────────────┘
  ┌─ Provider layer ──────▼───────────────────────────┐
  │  full-buffer reads: whole HTTP body in memory      │
  │   (res.json(), res.text()) — transient per call    │
  └───────────────────────┬───────────────────────────┘
  ┌─ Store layer ─────────▼───────────────────────────┐
  │  ★ InMemoryVectorStore.chunks ★  LONG-LIVED,       │ ← THIS CONCEPT'S
  │   768 floats × n chunks, never evicted             │   one unbounded heap
  └────────────────────────────────────────────────────┘
```

**Zoom in.** Two lifetimes dominate. Most of aptkit's allocations are *request-scoped*: the `messages` array, the parsed response, the tool results — all born inside one `runAgentLoop` call and collectible the moment it returns. One allocation is *instance-scoped and unbounded*: the vector store's `chunks` `Map`, which holds a 768-float `Float64`-backed array per chunk forever (until the store is dropped). That's the heap shape in one sentence.

## The structure pass

Trace the axis **"how long does this live, and what frees it?"** across the layers.

```
  One axis — "lifetime + who frees it" — by allocation site

  ┌─ stack / call-scoped ────────┐   lives: one call. freed: by GC after return
  │  messages[], toolResults[]    │   → grows within a call, dies with it
  └──────────────┬────────────────┘
  ┌─ transient buffers ──────────┐   lives: one I/O round-trip. freed: after parse
  │  full HTTP body (res.json)    │   → whole payload in RAM briefly
  └──────────────┬────────────────┘
  ┌─ instance-scoped ────────────┐   lives: as long as the store. freed: NEVER
  │  chunks Map (768 floats × n)  │   → the only monotonic growth in aptkit
  └───────────────────────────────┘
```

The seam is between **transient** and **instance-scoped** retention. Everything above the chunks `Map` is reclaimed automatically and quickly — the GC sees no live reference once a call returns. The chunks `Map` is different: it's held by a long-lived `InMemoryVectorStore` instance and has *no eviction path* — `upsert` only ever `.set`s (`in-memory-vector-store.ts:21`), never deletes. The axis-answer flips from "freed automatically" to "freed never (in this store's lifetime)" exactly there. That flip is why the in-memory store is a *demo* store and `PgVectorStore` (in buffr) is the durable one. → `study-performance-engineering` for memory-vs-corpus-size.

## How it works

### Move 1 — the mental model

You already manage lifetimes every time you write a React component: local `const`s die when the function returns; something you push into a module-level array or a long-lived ref *sticks around* until you remove it. The heap works the same way — an object lives exactly as long as something still points to it. The GC's whole job is: "find objects nothing points to anymore, reclaim them." Stack-local = short pointer chain, collected fast. Stored in a long-lived `Map` = pointed-to forever, never collected.

```
  The lifetime kernel — reachability decides retention

  GC root (the running call stack, the store instance)
        │ points to
        ▼
   ┌─────────────┐   still reachable? → KEEP
   │ object      │
   └─────────────┘   nothing points here? → RECLAIM
                     (next GC pass sweeps it)

  short chain (call-local) → collected soon after return
  rooted in a long-lived Map → collected NEVER (until Map drops it)
```

Named by what breaks if removed:
- **Reachability from a GC root** — this is the *only* thing keeping an object alive. Drop the last reference and it's eligible for collection. The chunks `Map` is a root-adjacent holder: while the store lives, every chunk it points to lives.
- **The lack of an eviction path** — remove an object from the `Map` (which aptkit never does) and it becomes collectible. Its absence is why corpus memory only grows.

### Move 2 — the allocation sites, walked

**Call-scoped growth in the loop — born and freed per call.** Inside `runAgentLoop`, memory grows *within* a single call as the conversation accumulates:

```ts
// packages/runtime/src/run-agent-loop.ts:94, 124, 189
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
// ...each turn:
messages.push({ role: 'assistant', content: response.content });   // grows
// ...
messages.push({ role: 'user', content: toolResults });             // grows
```

Each turn appends two messages (the assistant turn and the tool results), so `messages` grows linearly with turn count — but turn count is hard-capped at `maxTurns` (≤ 8, `run-agent-loop.ts:87`). The whole array is rooted only by the `runAgentLoop` stack frame, so the instant `runAgentLoop` returns, nothing points to `messages` and it's GC-eligible. There's also a guard against unbounded *per-message* growth: tool results are truncated to 16 KB (`run-agent-loop.ts:52-57`, `MAX_TOOL_RESULT_CHARS = 16_000`), so one giant tool result can't blow up the conversation buffer. This is well-behaved transient memory: bounded per call, freed on return.

```
  Execution trace — messages[] growth across a bounded loop

  turn 0:  [user]                                   1 msg
  turn 0:  + [assistant] + [tool_results]           3 msgs
  turn 1:  + [assistant] + [tool_results]           5 msgs
  ...      (capped at maxTurns ≤ 8)
  return:  messages[] unreachable → GC reclaims      0 (freed)
```

**Transient full-buffer reads — the whole payload in RAM, briefly.** aptkit reads HTTP bodies *whole*, not streamed:

```ts
// packages/providers/gemma/src/gemma-provider.ts:213
return (await res.json()) as OllamaChatResponse;
// packages/retrieval/src/ollama-embedding-provider.ts:72
const json = (await res.json()) as OllamaEmbedResponse;
```

`res.json()` buffers the entire response body into memory before parsing. For a model completion (a few KB of text) and an embedding batch (n × 768 floats), that's small and transient — allocated, parsed into JS objects, and the buffer is collectible right after. The embedding response is the larger one: embedding 50 chunks pulls back ~50 × 768 ≈ 38K floats in one JSON parse. Still modest, still transient. The honest note: there's no streaming parse, so a pathologically large embedding batch would spike memory proportionally. At aptkit's batch sizes this is a non-issue; it's named because "read the whole body" is a deliberate simplicity choice with a known ceiling. → `06-filesystem-streams-and-resource-lifecycle.md` for the one place aptkit *does* stream (NDJSON out).

**The one unbounded heap — the chunks `Map`.** This is the memory story that matters:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:12, 18-23
private readonly chunks = new Map<string, VectorChunk>();
async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);    // only ever .set — never .delete
  }
}
```

Every `VectorChunk` carries a `vector: number[768]` (`contracts` shape; nomic's fixed 768-dim, `ollama-embedding-provider.ts:40`). That's ~768 × 8 bytes ≈ 6 KB per chunk just for the vector, plus the `meta` (which includes the chunk's `text`, `pipeline.ts:44`). The `Map` is held by the `InMemoryVectorStore` instance, which a host keeps alive for the session. There is **no eviction, no TTL, no size cap** — index more documents, the `Map` grows, and it's freed only when the whole store instance is dropped. Memory grows `O(n_chunks × 768)`, monotonically. For a demo corpus that's nothing; for a real knowledge base it's exactly why you'd move to `PgVectorStore` (in buffr), where vectors live on disk in Postgres, not in V8's heap.

Note the same shape repeats for memory rows: `createConversationMemory` upserts `memory:<convId>:<n>` rows into a `VectorStore` (`conversation-memory.ts:82`) — when that's the in-memory store, episodic memory accumulates in the same unbounded `Map`. Same lifetime, same eviction story (none).

### Move 3 — the principle

Lifetime tracks reachability, and unbounded memory growth always comes from a long-lived container that only grows. aptkit's heap is clean *because* almost everything is rooted in a stack frame that returns quickly — the GC does all the work and you never think about it. The one exception, the chunks `Map`, is the canonical "in-memory cache with no eviction" shape: fine until it isn't, and the fix is never "tune the GC" but "give the data a real home with eviction or durability." That home is Postgres, behind the same `VectorStore` contract — which is the whole point of the contract.

## Primary diagram

```
  Memory and lifetimes in aptkit — complete

  ┌─ V8 heap (default size, GC-managed, no tuning) ─────────────────┐
  │                                                                 │
  │  SHORT-LIVED (freed by GC right after the call returns)         │
  │   ┌──────────────────────────────────────────────────────┐     │
  │   │ runAgentLoop messages[] — grows per turn, capped ≤8    │     │
  │   │ tool results — truncated to 16 KB each                 │     │
  │   │ parsed HTTP body (res.json) — whole payload, transient │     │
  │   └──────────────────────────────────────────────────────┘     │
  │                          │ unreachable on return → reclaimed     │
  │                          ▼                                       │
  │  LONG-LIVED & UNBOUNDED (freed only when the store is dropped)   │
  │   ┌──────────────────────────────────────────────────────┐     │
  │   │ InMemoryVectorStore.chunks Map                         │     │
  │   │  ~6 KB/chunk (768 floats) + text meta · NO eviction    │     │
  │   │  grows O(n_chunks) → move to PgVectorStore at scale    │     │
  │   └──────────────────────────────────────────────────────┘     │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

V8's generational GC is built for exactly aptkit's allocation shape: lots of short-lived objects (the "young generation" — request-scoped arrays, parsed responses) that die fast and get collected cheaply, plus a few long-lived ones (the chunks `Map`) that get promoted to the old generation and stay. You get good GC behavior for free by keeping per-request state on the stack. The trap the in-memory store illustrates is the oldest one in caching: a `Map` that only grows is a memory leak with a slow fuse. The textbook fixes are eviction (LRU, TTL) or offloading to durable storage; aptkit chose the latter via the `VectorStore` contract, so the in-memory store stays dead-simple and the durable concern lives in buffr's `PgVectorStore`. Manual heap tuning, `WeakMap`/`WeakRef` tricks, and streaming JSON parsers are all `not yet exercised` — and correctly so at this scale.

## Interview defense

**Q: Where does aptkit's memory grow without bound, and why is that acceptable?**
The `InMemoryVectorStore.chunks` `Map`. Every indexed chunk adds ~6 KB (a 768-float vector) plus its text, and there's no eviction — `upsert` only ever `.set`s. It grows `O(n_chunks)` for the store's whole lifetime. It's acceptable because the in-memory store is the *demo* store for a tiny corpus; the durable path is `PgVectorStore` behind the same contract, where vectors live in Postgres, not the V8 heap.

```
  long-lived Map + only-ever-grows = monotonic heap growth → offload, don't tune GC
```
*Anchor: an in-memory cache with no eviction is a leak with a slow fuse; the fix is durability, not GC flags.*

**Q: Is the rest of aptkit's memory well-behaved?**
Yes. The agent loop's `messages` array grows per turn but is hard-capped at `maxTurns ≤ 8` and freed on return; tool results are truncated to 16 KB so one huge result can't bloat the buffer; HTTP bodies are read whole but they're small and transient. It's all request-scoped, rooted in a stack frame, and reclaimed by V8 the moment the call returns.

## See also

- `04-shared-state-races-and-synchronization.md` — the same chunks `Map`, viewed as shared state
- `06-filesystem-streams-and-resource-lifecycle.md` — the streaming path that keeps memory flat
- `03-event-loop-and-async-io.md` — the cosine scan over this same heap data
- `study-performance-engineering` — memory cost vs. corpus size
