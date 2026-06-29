# Memory, Stack, Heap, GC, and Lifetimes — what lives, what grows, what gets collected

**Industry name(s):** heap allocation / GC · object lifetime · memory pressure · buffer-everything vs streaming · **Type:** Industry standard (V8 GC)

## Zoom out, then zoom in

aptkit allocates almost everything on the heap, keeps it for the duration of one operation, and lets V8's garbage collector reclaim it. The interesting decisions are the *buffer-everything* choices — places that hold the whole thing in memory rather than streaming it — because those are where memory grows with input size.

```
  Zoom out — where aptkit's memory lives

  ┌─ Stack (call frames) ─────────────────────────────────────────────┐
  │   shallow: runAgentLoop's for-loop, cosine's inner loop. No deep   │
  │   recursion anywhere. Stack depth is bounded and small.            │
  └──────────────────────────────────┬─────────────────────────────────┘
  ┌─ Heap (the interesting part) ─────▼─────────────────────────────────┐
  │   ★ messages[] growing per turn (run-agent-loop.ts:94)            ★ │ ← we are here
  │   ★ InMemoryVectorStore.chunks Map of 768-float arrays (:12)      ★ │
  │   ★ NDJSON line buffer (ndjson-stream.ts:108)                     ★ │
  │   replay artifacts read whole into memory (fs.promises, buffered)  │
  └──────────────────────────────────┬─────────────────────────────────┘
  ┌─ GC (V8, automatic) ──────────────▼─────────────────────────────────┐
  │   generational mark-sweep. aptkit pins nothing, frees nothing       │
  │   manually. lifetimes are scoped to one operation.                  │
  └──────────────────────────────────────────────────────────────────────┘
```

**Zoom in.** Memory in a GC runtime is about *lifetimes*: when is an object reachable, and when does it become garbage? For aptkit almost every object's lifetime is "one agent run" or "one request" — born at the start, unreachable at the end, collected shortly after. The two exceptions that outlive a single operation are the vector corpus (`Map`) and the per-conversation counters, both of which grow with use. This file walks where memory scales with input and where it doesn't.

## Structure pass

Trace the **lifecycle** axis on memory — how long does each allocation stay reachable?

```
  Axis: "how long does this live?" — by allocation site

  ┌──────────────────────────────────────────────────────────┐
  │ messages[] in runAgentLoop (run-agent-loop.ts:94)          │  → one agent run
  │   grows by 2 entries per turn, freed when the call returns │     (bounded by maxTurns)
  └───────────────────┬────────────────────────────────────────┘
      ┌───────────────▼────────────────────────────────────────┐
      │ NDJSON buffer (ndjson-stream.ts:108)                     │  → one line at a time
      │   sliced down as lines are yielded                       │     (bounded, streaming-ish)
      └───────────────┬────────────────────────────────────────┘
          ┌───────────▼────────────────────────────────────────┐
          │ InMemoryVectorStore.chunks Map (:12)                 │  → process lifetime,
          │   one 768-float array per chunk, never evicted        │     GROWS unbounded
          └────────────────────────────────────────────────────┘
```

The seam: **the boundary between per-operation lifetimes and process-lifetime state.** Below it, everything is short-lived and GC reclaims it between operations — memory is flat over time. Above it sits the corpus `Map`, which only ever grows (no eviction, no TTL). At aptkit's scale that's nothing; it's the one allocation whose size is a function of total data indexed rather than a single request.

## How it works

### Move 1 — the mental model

You know that in JS you never `free()` — you just stop referencing an object and the GC reclaims it. Memory pressure isn't about leaks-by-forgetting-to-free; it's about *holding references too long* or *holding too much at once*. The two questions for any allocation: how long is it reachable, and does its size grow with input?

```
  Object lifetime — reachable vs garbage

  function runAgentLoop():
    messages = []        ← allocated, reachable
    ... loop runs ...    ← messages grows, stays reachable
    return result        ← messages goes out of scope
                              │
                              ▼ no more references
                         GC reclaims it (next collection cycle)

  the leak shape to avoid: a long-lived container that keeps
  appending and never drops references (the corpus Map, by design)
```

The strategy: **scope every allocation to one operation so the GC reclaims it automatically, and accept exactly one growing structure — the corpus — because retrieval needs the whole index resident.**

### Move 2 — the allocations that matter

**The growing message array.** `run-agent-loop.ts:94` and `:124`, `:189`:

```ts
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
// ... each turn:
messages.push({ role: 'assistant', content: response.content });   // :124
messages.push({ role: 'user', content: toolResults });             // :189
```

Per turn, two entries are appended — and the *whole* `messages` array is re-sent to the model each call. So memory and per-call payload both grow linearly with turn count. But it's bounded: `maxTurns` defaults to 8 (`run-agent-loop.ts:87`), and the array is freed when the function returns. There's also a cap on individual tool results — `MAX_TOOL_RESULT_CHARS = 16_000` with `truncate` (`run-agent-loop.ts:52`) — so a single huge tool output can't blow the array up. This is the right shape: growth is bounded by a hard turn limit, and the lifetime is one call.

```
  messages[] growth — bounded by maxTurns

  turn 0:  [user]                                    1 entry
  turn 1:  [user, asst, toolResults]                 3 entries
  turn 2:  [user, asst, tR, asst, tR]                5 entries
  ...
  turn N:  2N+1 entries, each tool result ≤ 16KB
           └── hard ceiling at maxTurns (default 8) ──┘
           freed when runAgentLoop returns
```

**The corpus Map — the one unbounded structure.** `in-memory-vector-store.ts:12`:

```ts
private readonly chunks = new Map<string, VectorChunk>();
```

Each entry holds a `vector: number[]` of the embedding dimension — 768 floats for nomic-embed, 64 for the Studio fake embedder. A JS `number[]` of 768 doubles is ~6KB of payload plus object overhead. The `Map` never evicts: `upsert` only ever adds (`in-memory-vector-store.ts:18`). So total resident memory is `(chunks indexed) × (~6KB + meta)`. At demo scale (dozens of chunks) that's kilobytes. The honest framing: **this is the only structure whose memory is a function of cumulative data, not per-request work — and it's resident for the whole process.** It's correct for an in-memory dev/test store; the production answer is buffr's `PgVectorStore`, where vectors live in Postgres and aptkit's heap holds only the current query and its top-k hits.

**The NDJSON buffer — streaming-ish, bounded.** `ndjson-stream.ts:108`:

```ts
let buffer = '';
for await (const chunk of chunks) {
  buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  // ... slice complete lines out of buffer, yield them, shrink buffer
  buffer = buffer.slice(newlineIndex + newlineLength);   // :119
}
```

This is the closest aptkit gets to true streaming memory behavior: it holds only the unparsed tail (a partial line) plus whatever the current chunk added, slicing complete lines out as they arrive. Memory is bounded by the longest single line, not the whole stream. Good — it doesn't buffer the entire trace before parsing.

**Buffer-everything elsewhere.** Replay artifacts and fixtures are read whole into memory via `fs.promises.readFile` (in `scripts/*.mjs`, `packages/evals/src/replay-runner.ts`, `apps/studio/vite.config.ts`) — no `createReadStream`. For JSON files of a few KB that's correct; parsing JSON needs the whole document anyway, so streaming wouldn't help. `06` walks the file-handle side.

**Stack: shallow everywhere.** No deep recursion. The agent loop is iterative (`for`), the cosine scan is iterative, tree-walks in the workflow helpers are shallow. Stack depth is small and bounded — no stack-overflow surface.

### Move 3 — the principle

In a GC runtime, the memory question isn't "did I free it" — it's "what's reachable and for how long." aptkit's discipline is to scope nearly everything to one operation so the GC handles it for free, and to accept exactly one process-lifetime growing structure (the corpus) because retrieval genuinely needs the index resident. The lesson generalizes: a memory problem in a GC language is almost always a *lifetime* problem (something stays reachable too long) or a *bound* problem (something grows with input and has no cap), not a free-the-pointer problem. aptkit has no lifetime problems and exactly one structure without a cap — and that one is deliberately swappable for a database.

## Primary diagram

The complete memory picture: short-lived per-operation allocations the GC reclaims, one growing corpus, one streaming buffer, shallow stacks.

```
  aptkit memory map — complete

  ┌─ Stack: shallow, bounded ────────────────────────────────────────────┐
  │   iterative loops only, no deep recursion → no overflow surface       │
  └────────────────────────────────────────────────────────────────────────┘
  ┌─ Heap: by lifetime ───────────────────────────────────────────────────┐
  │                                                                        │
  │  PER-OPERATION (GC reclaims after each call) — memory flat over time   │
  │    runAgentLoop messages[]  ← grows 2/turn, capped by maxTurns (8)     │
  │    tool results             ← each truncated to 16KB                   │
  │    structured-gen attempts[]                                           │
  │                                                                        │
  │  STREAMING-BOUNDED                                                      │
  │    NDJSON buffer ← holds one partial line, sliced down as it yields    │
  │                                                                        │
  │  PROCESS-LIFETIME, GROWS WITH DATA (the one to watch)                  │
  │    InMemoryVectorStore.chunks ← (n chunks) × (768-float array + meta), │
  │                                  never evicted; swap for PgVectorStore │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

V8's generational GC is tuned for exactly aptkit's allocation pattern: lots of short-lived objects (the "young generation") that die fast and get collected cheaply, plus a small set of long-lived objects (the corpus) that survive into the "old generation" and are collected rarely. Per-operation allocations cost almost nothing to reclaim. The classic Node memory leak — an ever-growing cache or event-listener set on a long-lived object — maps directly onto the corpus `Map` if aptkit ever ran as a long-lived server *and* kept indexing without eviction. It doesn't today (it's a library, runs are short-lived), and in production the corpus moves to Postgres anyway. The general escape hatches when an in-memory index outgrows the heap: a real ANN index with its own memory management, off-heap storage, or — aptkit's actual plan — a database behind the same `VectorStore` contract. See `03` for the CPU cost of scanning that same `Map`, and `study-performance-engineering` for measuring heap pressure.

## Interview defense

**Q: What's the one structure in aptkit whose memory grows unbounded, and is that a problem?**

```
  InMemoryVectorStore.chunks Map (in-memory-vector-store.ts:12)
  one 768-float array per chunk, never evicted, process-lifetime
  grows with TOTAL data indexed, not per-request work

  problem? not at demo/test scale (KBs)
  it's a dev/test adapter — production swaps PgVectorStore behind the
  same VectorStore contract, so vectors live in Postgres, not the heap
```

Anchor: "Everything else is per-operation and GC'd; the corpus `Map` is the one process-lifetime growing structure, and it's deliberately swappable for a database."

**Q: How does `runAgentLoop` keep memory bounded?**

```
  messages[] grows 2 entries/turn but:
    - maxTurns (default 8) caps turn count
    - each tool result truncated to MAX_TOOL_RESULT_CHARS (16KB)
    - whole array freed when the call returns (GC)
  → bounded growth, one-call lifetime
```

Anchor: "The message array grows per turn but it's capped by `maxTurns` and 16KB-per-tool-result truncation, then GC'd when the run ends."

## See also

- `03-event-loop-and-async-io.md` — the CPU cost of scanning the same corpus `Map`
- `06-filesystem-streams-and-resource-lifecycle.md` — the buffer-everything file reads
- `07-backpressure-bounded-work-and-cancellation.md` — `maxTurns` as the bound that caps message growth
- `study-performance-engineering` — measuring heap pressure and the corpus crossover point
