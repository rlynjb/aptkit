# Arrays, Strings & Hash Maps

**Indexed sequences · strings · hash sets & maps (`Set`/`Map`)** — Industry standard.

## Zoom out, then zoom in

This is the family aptkit *actually runs* the most. The embedding vector is an array, the chunker walks a string, and three quiet jobs ride on hash-set/hash-map `O(1)` membership. Here's where they sit.

```
  Zoom out — arrays, strings, and maps across aptkit

  ┌─ Service layer — packages/tools, packages/runtime ───────────┐
  │  tool policy      → Set<string> allowlist (O(1) gate)         │
  │    tool-policy.ts │ allowed.has(name)                         │
  │  parseAgentJson   → string scan (indexOf / lastIndexOf)       │
  └───────────────────────────────┬───────────────────────────────┘
                                   │
  ┌─ Storage layer — packages/retrieval, packages/memory, evals ─┐
  │  ★ embedding vector → number[768], the unit of retrieval ★    │
  │    in-memory-vector-store.ts                                  │
  │  chunk store      → Map<string, VectorChunk> (id → chunk)     │
  │  memory counter   → Map<convId, n>  (collision-free ids)      │
  │    conversation-memory.ts                                     │
  │  precision@k      → Set intersection over top-k               │
  │    precision-at-k.ts                                          │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: an array is a contiguous indexed sequence (`O(1)` random access, `O(n)` scan). A hash map/set trades ordering for `O(1)` average lookup. The skill is knowing *which one each job wants* — and aptkit gets it right every time. You've built these from scratch; this file is about recognizing them in production code where they're unannounced.

## Structure pass

```
  layers:  the data unit  →  the collection that holds it  →  the lookup over it
  axis held constant: "what does access cost on this structure?"

  ┌─ array: number[768] ────────┐   index access O(1); scan O(n)
  │  the embedding vector        │   → ordered, contiguous, positional
  └──────────────┬───────────────┘
                 │  seam: ordering MATTERS below, ordering is GONE above
  ┌─ Map<id, chunk> ────────────┐   keyed access O(1); no order guarantee
  │  the chunk store             │   → identity lookup, not position
  └──────────────┬───────────────┘
                 │  seam: value lookup flips to pure membership
  ┌─ Set<string> ───────────────┐   has() O(1); no value, just presence
  │  the tool allowlist          │   → "is this in the set?" and nothing else
  └──────────────────────────────┘
```

The seam to notice: as you go down, you shed structure. The vector *needs* order (dimension `i` of the query must multiply dimension `i` of the chunk). The chunk store doesn't care about order, only identity. The allowlist doesn't even care about a value, only presence. Each structure is the *minimum* that does the job — that's the design lesson.

## How it works

### Move 1 — the mental model

Three structures, one question each: arrays answer *"what's at position i?"*, maps answer *"what's stored under key k?"*, sets answer *"is x present?"*. You reach for the array when position is meaningful, the map when you look things up by identity, the set when all you need is membership.

```
  the three shapes, by the question they answer

  ARRAY            MAP                    SET
  [a][b][c][d]     {k1→v1, k2→v2}         {x, y, z}
   0  1  2  3
  "at index 2?"    "value under k2?"      "is y in here?"
   → O(1)           → O(1) avg             → O(1) avg
  order matters    keyed, unordered       presence only
```

### Move 2 — walking aptkit's actual structures

**The embedding vector — an array where position is the meaning.** A `number[768]` isn't just a list; each index *is* a semantic dimension. `cosineSimilarity` in `in-memory-vector-store.ts:46` walks the two arrays in lockstep:

```ts
  for (let i = 0; i < a.length; i += 1) {
    dot  += a[i]! * b[i]!;   // ← index i of query × index i of chunk — ORDER is load-bearing
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
```

The whole thing breaks if the arrays are misaligned by even one position — which is exactly why the store asserts `vector.length === dimension` before it ever scores (line 36). The array's contract is "same length, same meaning per index," and the dimension guard enforces it loudly. This is the array primitive doing real work: positional, contiguous, no hashing.

**The chunk store — a `Map` for identity, not position.** Line 12: `private readonly chunks = new Map<string, VectorChunk>()`. Upsert is `this.chunks.set(chunk.id, chunk)` — `O(1)`. Why a `Map` and not an array? Because upsert must be *idempotent*: re-indexing a doc with the same chunk id overwrites, doesn't duplicate. An array would need an `O(n)` find-and-replace; the `Map` makes "replace if exists" free. The search then iterates `.values()` — so the `Map` gives `O(1)` upsert *and* full iteration, which is exactly the access pattern (write by id, read all).

**The tool allowlist — a `Set` for pure membership.** `tool-policy.ts:16`:

```ts
  const allowed = new Set(policy.allowedTools);
  return allTools
    .filter((tool) => allowed.has(tool.name))   // ← O(1) per check vs O(m) array scan
    ...
```

Each tool is checked against the allowlist once. With a `Set`, every `has()` is `O(1)`, so filtering `t` tools against an allowlist is `O(t)`. With an array allowlist of size `m` it'd be `O(t·m)`. The set is the security primitive: least-privilege as a membership test. Boundary condition — a tool name not in the set is silently dropped, never offered to the model. That's the gate working.

**The memory id-counter — a `Map<convId, n>` for collision-free ids.** `conversation-memory.ts:71`:

```ts
  const counters = new Map<string, number>();
  ...
  const n = counters.get(turn.conversationId) ?? 0;   // ← current count for THIS conversation
  counters.set(turn.conversationId, n + 1);            // ← monotonic bump
  ... id: `${kind}:${turn.conversationId}:${n}`        // ← memory:conv-42:0, :1, :2, ...
```

The map keys a monotonic counter *per conversation*. Two turns in the same conversation get `:0` then `:1` — distinct ids, no collision. Two different conversations each start at `:0` but their ids differ by the `conversationId` segment. The map is doing the job a database `SERIAL` column would do, in memory, scoped per key. Drop the map and you'd reuse ids across turns and overwrite memory rows — the counter is load-bearing.

**precision@k — `Set` intersection over a window.** `precision-at-k.ts:29`:

```ts
  const topK = retrievedIds.slice(0, k);
  const seen = new Set<string>();
  for (const id of topK) {
    if (relevantIds.has(id)) seen.add(id);   // ← membership in the relevant set, O(1)
  }
  return seen.size;                          // ← DISTINCT hits, dedup is free in a Set
```

`relevantIds` is a `ReadonlySet<string>`, so each "is this retrieved id relevant?" is `O(1)`. And `seen` being a `Set` means duplicates in the top-k window count once — the dedup is structural, not a manual check. This is set intersection expressed as "iterate one set, membership-test the other," the standard `O(min(a,b))` intersection.

### Move 3 — the principle

Pick the structure that holds the *minimum* the job needs: position → array, identity → map, presence → set. aptkit never over-reaches — the allowlist is a set because it only ever asks "is this in," the vector is an array because position carries meaning. Reading which structure a job *deserves* is half of reading the code.

## Primary diagram

```
  aptkit's array/map/set jobs — one frame

  ARRAY (position is meaning)        MAP (identity → value)
  ┌──────────────────────────┐       ┌────────────────────────────┐
  │ number[768] embedding     │       │ chunks: Map<id, VectorChunk>│
  │  cosine walks i in lockstep│      │  upsert O(1), idempotent    │
  │  in-memory-vector-store:46 │      │  in-memory-vector-store:12  │
  └──────────────────────────┘       │ counters: Map<convId, n>    │
                                      │  collision-free ids         │
  SET (presence only)                 │  conversation-memory:71     │
  ┌──────────────────────────┐       └────────────────────────────┘
  │ allowed: Set<toolName>     │
  │  has() O(1) least-priv gate│       precision@k: Set intersection
  │  tool-policy:16            │        over top-k window
  │ seen / relevantIds         │        precision-at-k:29
  └──────────────────────────┘
```

## Elaborate

Hash maps/sets are the workhorse of every production codebase precisely because `O(1)` average lookup collapses so many `O(n)` scans. The tradeoff they make — and it's worth naming — is **no ordering** and a worst-case `O(n)` on pathological hash collisions (a concern for adversarial input, not aptkit's internal ids). aptkit leans on JS's native `Map`/`Set`, which is the right call: you built `BinaryHeap` and `Graph` from scratch in `reincodes` because the *structure was the lesson*; here the structure is infrastructure, so the language primitive wins. The interesting DSA in this repo isn't the map — it's the *array* (the vector) and what you do to rank it, which is file 06.

## Interview defense

**Q: Why is the chunk store a `Map` and the tool allowlist a `Set`?**
Different questions. The chunk store needs idempotent upsert keyed by id — `Map.set(id, chunk)` overwrites in `O(1)`, an array would need an `O(n)` find. The allowlist only ever asks "is this tool permitted?" — pure membership, so a `Set` with `O(1) has()` is the minimum that does it.

```
  Map  → "what's under this key?"   chunk store, id-counter
  Set  → "is this present?"          tool allowlist, relevant-ids
  same O(1), different question
```

Anchor: "Pick the structure that holds the minimum the job needs — the allowlist never needs a value, so it's a set, not a map."

**Q: The memory id-counter is just a `Map<string, number>`. What breaks without it?**
Id collisions. Two turns in one conversation would both get id `memory:conv:0` and the second `upsert` would overwrite the first — you'd silently lose memory. The map keys a per-conversation monotonic counter so ids are unique within a conversation and the `conversationId` segment keeps them unique across conversations. It's a `SERIAL` column done in memory.

## See also

- `01-complexity-and-cost-models.md` — why the scan is `O(n·d)` and `has()` is `O(1)`
- `06-sorting-searching-and-selection.md` — what the vector array gets ranked by
- `03-stacks-queues-deques-and-heaps.md` — the ordered structures aptkit does *not* use
- **study-ai-engineering** — the embedding vector as a semantic object, not just an array
