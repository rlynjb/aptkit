# Arrays, Strings & Hash Maps

**Industry name(s):** indexed sequences · dynamic arrays · strings · hash sets / hash maps (`Set`/`Map`) — *Industry standard / Language-agnostic*

---

## Zoom out, then zoom in

This is the repo-grounded core. If you strip aptkit down to its data structures, what's left is arrays, strings, and maps — and almost nothing else. Every load-bearing path here is one of those three.

```
  Zoom out — where arrays/strings/maps live in aptkit

  ┌─ Retrieval layer ───────────────────────────────────────────┐
  │  chunkText: STRING.slice over a sliding window              │
  │  embed():   string[] → number[][]  (array of 768-vectors)   │
  │  ★ InMemoryVectorStore: Map<id, chunk> + ARRAY of hits ★     │
  │  search():  iterate map → push to array → sort array        │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Tool layer ──────────────▼─────────────────────────────────┐
  │  filterToolsForPolicy: SET membership (allowlist)           │
  │  parseAgentJson: STRING scan (fence + brace search)         │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Memory / Eval layer ─────▼─────────────────────────────────┐
  │  recall: Map<convId, counter> + over-fetch ARRAY + filter   │
  │  precision@k: SET intersection over a sliced ARRAY          │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the vector store *is* an array-and-map structure — chunks live in a `Map<string, VectorChunk>` for `O(1)` upsert-by-id, and a query materializes them into an `Array<VectorHit>` to sort. You've built far gnarlier structures than this. The thing worth your attention is *why these primitives and not fancier ones* — and where the array choice will eventually break.

---

## Structure pass

**Layers:** the embedding vector (a fixed-length `number[768]`), the chunk store (a `Map` keyed by id), the hit list (a transient `Array` built per query), and the policy/dedup sets (`Set`).

**Axis — state ownership:** trace "who owns this data and how long does it live?"

```
  One axis — "what owns this, and how long does it live?"

  ┌────────────────────────────────────────────────┐
  │ vector number[768]  → owned by a chunk, durable │
  └────────────────────────────────────────────────┘
      ┌──────────────────────────────────────────────┐
      │ Map<id, VectorChunk> → owned by store, durable│ → keyed, O(1) upsert
      └──────────────────────────────────────────────┘
          ┌──────────────────────────────────────────┐
          │ VectorHit[]  → built per query, thrown away│ → transient, sorted
          └──────────────────────────────────────────┘
              ┌──────────────────────────────────────┐
              │ Set<string> → built per call, discarded│ → O(1) membership
              └──────────────────────────────────────┘
```

**Seam — the `Map`→`Array` conversion inside `search`.** The store *holds* chunks in a map (fast keyed access) but *ranks* them as an array (you can't sort a map). That conversion, `for (const chunk of this.chunks.values())`, is the joint where "keyed storage" flips to "ordered ranking." It's the load-bearing line.

---

## How it works

### Move 1 — the mental model

You know two things already: a `.map()`/`.filter()` over an array is the bread-and-butter of frontend rendering, and a `Set` gives you `O(1)` membership instead of `Array.includes`'s `O(n)`. aptkit uses exactly those reflexes. The vector store is "a `Map` for storage, an `Array` for ranking." The policy filter is "a `Set` so the membership check is free." Nothing exotic — but the *choice of which* is the lesson.

```
  Pattern — the store's two faces: keyed map vs ordered array

   storage face (durable)          ranking face (transient, per query)
   ┌───────────────────────┐       ┌────────────────────────────────┐
   │ Map<id, VectorChunk>   │  ──►  │ VectorHit[]  (push each chunk)  │
   │  upsert by id: O(1)    │ iterate│  then .sort() then .slice(k)   │
   │  no order              │ values │  ordered by score              │
   └───────────────────────┘       └────────────────────────────────┘
       why a Map: dedup by id on upsert, no scan to find a chunk
       why an Array: you can't rank a Map; sorting needs a sequence
```

### Move 2 — the walkthrough

#### The chunk store is a Map keyed by id — so upsert dedups for free

`InMemoryVectorStore` holds chunks in a `Map`, not an array:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:12, 18-23
private readonly chunks = new Map<string, VectorChunk>();

async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);   // ← same id overwrites; dedup is free
  }
}
```

Why a `Map` and not an `Array<VectorChunk>`? Because re-indexing a document must *replace* its chunks, not append duplicates. Chunk ids are `"<docId>#<index>"` (`pipeline.ts:42`), so `chunks.set(id, …)` overwrites the prior version in `O(1)`. With an array you'd scan to find-and-replace (`O(n)`) or accept duplicates. The boundary condition: this only works because the id is a *stable, deterministic key*. Random ids would break the dedup.

#### Search converts the Map to an Array because you can't rank a Map

A `Map` has no order. Ranking needs a sequence, so `search` materializes one:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:27-32
const hits: VectorHit[] = [];
for (const chunk of this.chunks.values()) {   // Map → iterate values
  hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
}
hits.sort((a, b) => b.score - a.score);        // Array → sortable
return hits.slice(0, Math.max(0, k));          // Array → sliceable top-k
```

This is the `Map`→`Array` seam. Every query rebuilds the hit array from scratch (it's transient state — owned by the call, discarded after). That's deliberate: scores depend on the query vector, so they can't be precomputed. The cost is the full materialize-and-sort every time (file **01**, file **06**). The fix at scale isn't a better array — it's an index (file **04**, **05**).

#### Strings: the sliding window in chunkText

The one real string algorithm in aptkit is the chunker — a sliding window with overlap:

```ts
// packages/retrieval/src/chunker.ts:22-30
const step = Math.max(1, size - overlap);      // 512 - 64 = 448 chars/step
const chunks: string[] = [];
for (let start = 0; start < text.length; start += step) {
  chunks.push(text.slice(start, start + size));   // window [start, start+512)
  if (start + size >= text.length) break;
}
```

```
  Window pattern — fixed-size windows with overlap

  text:   ────────────────────────────────────────────────────►
  win 0:  [════════════ 512 ════════════]
  win 1:               [════════════ 512 ════════════]
                       └─ 64 overlap ─┘
  win 2:                            [════════════ 512 ════════════]
          step = size - overlap = 448; overlap keeps a straddling
          fact whole in at least one window
```

This is `O(n)` over the document length — each character is copied into at most two windows (because of overlap). The boundary condition the overlap exists to handle: a fact that lands *exactly* on a chunk boundary would be split in half and lost from both chunks; the 64-char overlap guarantees it stays whole in at least one window. The string is treated as an indexed sequence and `slice` is the array-of-chars operation underneath.

#### Sets: O(1) membership for tool policy and distinct-hit counting

Two places use a `Set` to turn an `O(n)` membership check into `O(1)`. The tool allowlist:

```ts
// packages/tools/src/tool-policy.ts:15-16
const allowed = new Set(policy.allowedTools);       // build once
return allTools.filter((tool) => allowed.has(tool.name));  // O(1) per tool
```

And the precision@k distinct-hit counter, which uses a `Set` *twice* — once for the relevant ids (passed in as `ReadonlySet`), once to dedup hits:

```ts
// packages/evals/src/precision-at-k.ts:27-34
function countDistinctHits(retrievedIds, relevantIds: ReadonlySet<string>, k): number {
  const topK = retrievedIds.slice(0, k);    // array slice
  const seen = new Set<string>();           // dedup set
  for (const id of topK) {
    if (relevantIds.has(id)) seen.add(id);  // O(1) membership + O(1) insert
  }
  return seen.size;                         // distinct count
}
```

The `seen` set is doing double duty: membership (`relevantIds.has`) *and* deduplication (a relevant id appearing twice counts once). That's the canonical "intersection size via hash set" pattern — `|A ∩ B|` in `O(|topK|)` instead of `O(|topK|·|relevant|)`. The boundary condition: it measures *coverage* not *frequency*, which is why the dedup matters — a result list that returns the same relevant chunk five times shouldn't score five.

#### Maps as counters: the per-conversation id sequence in memory

`recall`/`remember` uses a `Map<string, number>` as a per-conversation counter so repeated turns get distinct ids:

```ts
// packages/memory/src/conversation-memory.ts:71, 78-80, 83
const counters = new Map<string, number>();
// inside remember():
const n = counters.get(turn.conversationId) ?? 0;   // O(1) read, default 0
counters.set(turn.conversationId, n + 1);            // O(1) increment
id: `${kind}:${turn.conversationId}:${n}`,           // memory:conv-1:0, :1, :2 …
```

This is a hash-map-as-counter — the same shape as a frequency map, used here to generate monotonic ids per key. The boundary condition the comment names (line 69-70): it assumes `conversationId` is globally unique, so ids never collide *across* conversations. The counter is in-process state — restart the process and it resets to 0, which is fine because durable persistence (buffr's `PgVectorStore`) keys on the full id string, not the counter.

### Move 3 — the principle

**Match the structure to the access pattern, not to the data.** The same chunks live in a `Map` (because access is keyed and dedup matters) and get re-expressed as an `Array` (because ranking needs order). A `Set` shows up wherever the question is "is this in the collection?" The data is identical; the structure is chosen per *operation*. That's the whole discipline — and it's why aptkit needs no graph or tree to do its job well at small scale.

---

## Primary diagram

Every array/string/map in aptkit, in one frame.

```
  aptkit's three primitives — where each is reached for and why

  STRING  ── chunkText: sliding window, slice [start, start+512)
          └─ parseAgentJson: fence regex + indexOf('{')/lastIndexOf('}')

  ARRAY   ── embed result: number[][] (each row a 768-vector)
          ├─ VectorHit[]: built per query, sorted, sliced to top-k
          └─ retrievedIds.slice(0, k): the top-k window for scoring

  MAP     ── chunks: Map<id, VectorChunk>  → O(1) keyed upsert + dedup
          └─ counters: Map<convId, n>      → O(1) per-conversation id seq

  SET     ── allowed: Set<toolName>        → O(1) policy membership
          └─ seen / relevantIds: Set<id>   → O(1) intersection for p@k

  the join that matters: Map (storage) ──iterate values──► Array (ranking)
                         inside InMemoryVectorStore.search
```

---

## Elaborate

The `Map`-for-storage / `Array`-for-ranking split is the in-memory shadow of how a real vector database works: pgvector *stores* rows in a table (keyed, like the map) and *ranks* them via an index + `ORDER BY` (the sort, but index-accelerated). aptkit's `InMemoryVectorStore` is the contract-faithful toy version — same shape, no index. The hash set's `O(1)` membership is the same primitive a database uses for hash joins. None of this is accidental: the from-scratch pipeline was built to *be* the textbook version of the production system, so the data structures map one-to-one.

Where this connects forward: the moment the array scan becomes too slow (file **01**'s `O(n)`-per-query wall), the answer is to stop ranking an array and start querying an *index* — which is a tree (file **04**) or a graph (file **05**, HNSW). The array isn't wrong; it's the structure you outgrow.

---

## Interview defense

**Q: Why does `InMemoryVectorStore` use a `Map` for storage but an `Array` for search?**

> Storage is keyed and needs dedup-on-reindex — chunk ids are `docId#index`, so `Map.set` overwrites in `O(1)` and a re-indexed doc replaces its old chunks instead of duplicating. Ranking needs order, and you can't sort a `Map`, so `search` iterates the map values into a transient `VectorHit[]`, sorts by score, and slices the top-k. The map is durable state; the hit array is per-query and discarded.

```
  Map<id,chunk> ──iterate values──► VectorHit[] ──sort──► slice(k)
  keyed/dedup (durable)              transient ranking (per query)
```

**Q: Where does aptkit use a `Set`, and what does it buy?**

> Two places. Tool policy builds `new Set(allowedTools)` so the per-tool `allowed.has(name)` check is `O(1)` instead of `Array.includes`'s `O(n)`. And precision@k uses a `seen` set to count *distinct* relevant ids in the top-k — that's an intersection-size computation, `|retrieved ∩ relevant|`, in `O(k)`, with the set doubling as a dedup so a repeated chunk counts once. Coverage, not frequency.

Anchor: *the structure is chosen per-operation — `Map` for keyed dedup, `Array` for ordered ranking, `Set` for `O(1)` membership and intersection.*

---

## See also

- **01-complexity-and-cost-models.md** — the `O(n)` scan and `O(1)` membership costs.
- **06-sorting-searching-and-selection.md** — the sort that ranks the hit array, and the top-k slice.
- **04-trees-tries-and-balanced-indexes.md** — what replaces the array when the scan gets too slow.
- `study-ai-engineering` — the same structures viewed as a RAG pipeline.
