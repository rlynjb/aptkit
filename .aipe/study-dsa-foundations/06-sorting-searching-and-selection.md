# Sorting, Searching & Selection

**Comparison sort · linear vs binary search · top-k selection · exact vs approximate nearest-neighbor** — Industry standard. **Status in aptkit: exercised — the cosine rank + top-k is the load-bearing algorithm.**

## Zoom out, then zoom in

This is the file where aptkit's real DSA lives. The single most consequential algorithm in the whole toolkit is six lines: score every chunk by cosine, sort, take the top-k. Everything about retrieval quality and cost rides on it.

```
  Zoom out — where sorting & selection run

  ┌─ Service layer — packages/agents/rag-query ──────────────────┐
  │  model decides to call search_knowledge_base                 │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ tool call: query + top_k
  ┌─ Storage layer — packages/retrieval ─────────────────────────┐
  │  ★ in-memory-vector-store.ts:25 search() ★                    │ ← THE
  │    1. linear scan: score every chunk   (search)              │   algorithm
  │    2. sort by score descending          (sort)               │
  │    3. slice(0, k)                        (selection)         │
  │  search_knowledge_base-tool.ts: minTopK floor + filter       │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: three classic operations stacked. **Search** = find candidates (here: a linear scan, since there's no index). **Sort** = order them (full comparison sort by score). **Selection** = take the best `k` (a slice). The interesting choices are *why a linear scan and not binary search* (the data is unsorted and unindexed) and *why a full sort and not a partial selection* (small `n`, simplest correct thing). You've built all five sorts in `reincodes`; this file is about which one runs here and why the simple choice is right.

## Structure pass

```
  layers:  find candidates  →  order them  →  take the best k
  axis held constant: "how much of the data must we touch?"

  ┌─ search (find) ─────────────┐   linear scan: touch ALL n  → O(n·d)
  │  cosineSimilarity over array │   → no index, so no shortcut
  └──────────────┬───────────────┘
                 │  seam: from "touch all" to "order all"
  ┌─ sort (order) ──────────────┐   full comparison sort  → O(n log n)
  │  hits.sort(b.score - a.score)│   → orders every hit, even discarded ones
  └──────────────┬───────────────┘
                 │  seam: from "order all" to "keep few"
  ┌─ selection (keep k) ────────┐   slice(0, k)  → O(k)
  │  hits.slice(0, k)            │   → throws away n−k of the sorted work
  └──────────────────────────────┘
```

The axis — *how much data must we touch?* — exposes the one inefficiency: the sort orders all `n` hits when only `k` survive. A partial selection (quickselect, or a size-k heap from file 03) touches less. aptkit chooses the full sort anyway; the seam below explains why that's correct at this `n`.

## How it works

### Move 1 — the mental model

Top-k retrieval is "score, order, keep the best few." The mental model worth holding: there are three ways to get the top-k, on a spectrum of how much they touch.

```
  three ways to get top-k — spectrum of work touched

  full sort        [score all n] → [sort all n] → [take k]   O(n log n)  ← aptkit
  partial select   [score all n] → [quickselect / size-k heap]  O(n log k)
  indexed search   [walk index, never touch most of n]       O(log n)    ← buffr HNSW

  fewer touches ───────────────────────────────────────────►
  aptkit picks the SIMPLEST that's correct at small n
```

The binary-search instinct is a trap here: binary search needs *sorted* data and finds *one* key. The vectors aren't sorted by anything, and you want the `k` closest by a *computed* score, not a stored key. So linear scan, not binary search — and that's not a shortcoming, it's the only correct option without an index.

### Move 2 — walking aptkit's actual algorithm

**The search — a linear scan, because there is no index.** `in-memory-vector-store.ts:25`:

```ts
  async search(vector: number[], k: number): Promise<VectorHit[]> {
    this.assertDimension(vector, 'query vector');
    const hits: VectorHit[] = [];
    for (const chunk of this.chunks.values()) {                 // ← touch EVERY chunk
      hits.push({ id: chunk.id,
        score: cosineSimilarity(vector, chunk.vector),          // ← compute score, not lookup
        meta: chunk.meta });
    }
```

Every chunk gets scored — `O(n·d)`. There's no way to skip any, because "relevance" is a *computed* cosine score against this specific query, not a precomputed sortable key. You can't binary-search for "closest to query" in an unsorted array. The linear scan is exact and unavoidable here. Boundary condition: as `n` grows this is the cost that bites — and it's exactly where buffr's HNSW index avoids touching most of `n`.

**The sort — full comparison sort, even though most hits are discarded.** Line 31:

```ts
    hits.sort((a, b) => b.score - a.score);   // ← O(n log n), descending by score
    return hits.slice(0, Math.max(0, k));     // ← O(k), keep the top k, discard n−k
```

`Array.prototype.sort` is a comparison sort (V8 uses Timsort, `O(n log n)`). It orders *all* `n` hits, then `slice(k)` throws away `n−k` of them. That's provably more work than necessary — a quickselect or a size-k heap (file 03) gets top-k in `O(n log k)` without fully ordering the tail.

So why the full sort? Three honest reasons: (1) `n` is small — the in-memory store holds a handful of docs' worth of chunks, and `O(n log n)` on small `n` is microseconds; (2) native `.sort()` has a tiny constant and zero allocation overhead, beating a hand-rolled heap in practice at this scale; (3) it's the simplest *correct* thing — no edge cases, no partial-selection bugs. **This is the right call for an in-memory reference implementation, and the wrong call at scale — which is why the contract lets buffr swap in HNSW without touching this code** (file 04, 05).

**The selection floor — `minTopK` stops a weak model from starving retrieval.** `search-knowledge-base-tool.ts:51`:

```ts
  const minTopK = Math.max(1, options.minTopK ?? 1);
  ...
  const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
  const topK = Math.max(requestedTopK, minTopK);   // ← floor the k the model asked for
```

This is a selection-parameter guard, not a sort change. A weak local model (Gemma) sometimes asks for `top_k: 1`, starving a multi-part question of context. `minTopK` floors `k` so selection can't return too few. The lesson: the `k` in top-k is a *quality knob*, and an agent that picks its own `k` needs a floor. Boundary: `Math.max(1, ...)` ensures the floor itself is never zero.

**The filter — tolerant post-selection over the ranked window.** Lines 88-90 and `matchesFilter` (101): when the model passes a metadata filter, the tool over-fetches `topK * 4`, then filters down to `topK`. The filter only excludes a hit that *has* the key with a *different* value — a hallucinated filter key (`{textContains: "x"}`) is ignored, not allowed to wipe every result. This is selection hardened against a model that makes up filter fields: the search/sort stay exact; the post-filter is forgiving.

### Move 3 — the principle

Top-k is search + sort + select, and the right implementation depends entirely on `n`. At small `n`, a full sort + slice is the simplest correct thing and wins on constants. At large `n`, you stop touching all of it — partial selection, or better, an index. aptkit picks simple-and-exact; the `VectorStore` contract is what lets that choice be revisited (buffr's HNSW) without the calling code knowing.

## Primary diagram

```
  aptkit's top-k algorithm — one frame

  query vector ──┐
                 ▼
  ┌─ SEARCH (linear scan) ──────────────────────┐  O(n·d)
  │  for each chunk: score = cosine(q, chunk)     │  no index → touch all n
  │  in-memory-vector-store.ts:28                 │  EXACT (can't miss)
  └────────────────────────┬─────────────────────┘
                           ▼
  ┌─ SORT (full comparison) ─────────────────────┐  O(n log n)
  │  hits.sort(b.score − a.score)                 │  orders all, keeps few
  │  in-memory-vector-store.ts:31                 │  (wasteful but simple)
  └────────────────────────┬─────────────────────┘
                           ▼
  ┌─ SELECT (slice + floor + filter) ────────────┐  O(k)
  │  slice(0, max(k, minTopK)); tolerant filter   │  minTopK stops starvation
  │  search-knowledge-base-tool.ts:51,90          │  filter tolerates hallucination
  └───────────────────────────────────────────────┘
                           ▼
                    top-k ranked hits

  scale escape hatch: same VectorStore contract → buffr swaps HNSW (O(log n))
```

## Elaborate

The top-k pattern is everywhere relevance ranking lives: search engines, recommenders, RAG. The classic optimization is *selection without full sorting* — quickselect (Hoare, `O(n)` average) finds the k-th element and partitions around it; a bounded heap (file 03) does `O(n log k)`. aptkit uses neither because at its `n` the constant factors flip the asymptotic verdict — the lesson that asymptotic analysis assumes large `n` and small-`n` reality can invert it (file 01). The deeper arc: aptkit's exact scan and buffr's approximate HNSW are the two ends of the exact-vs-approximate-nearest-neighbor spectrum, joined by one `VectorStore` contract — the cleanest demonstration in the repo that the *interface* is what lets the *algorithm* change. Retrieval-quality scoring (precision@k/recall@k, file 02 and `evals`) is the AI-engineering layer on top; **study-ai-engineering** owns "is the ranking good," this file owns "how the ranking is computed."

## Interview defense

**Q: aptkit does a full sort then slices k. Is that optimal? What would you change?**
Not asymptotically — a full sort is `O(n log n)` to keep `k` items, when a size-k heap or quickselect gets top-k in `O(n log k)` / `O(n)`. But at aptkit's `n` (in-memory, a handful of docs) the full sort wins on constants: native `.sort()`, no allocation, no partial-selection edge cases. I'd only switch when `n` is large — and at that point I'd skip the scan entirely and use an ANN index (buffr's HNSW), not a heap.

```
  full sort   O(n log n)  ← aptkit, wins at small n
  size-k heap O(n log k)  ← worth it when k ≪ n, large n
  HNSW index  O(log n)    ← buffr, the real answer at scale
```

Anchor: "The sort isn't the problem at this `n` — and the fix at scale isn't a better sort, it's not scanning at all."

**Q: Why a linear scan and not binary search?**
Binary search needs sorted data and finds one key. The vectors aren't sorted, and relevance is a *computed* cosine score against this query, not a stored key — there's nothing to binary-search on. Without an index, scanning every vector is the only exact option. An index (HNSW) is what lets you skip most of `n`, and it's a graph walk, not a binary search.

**Q: What's `minTopK` for?**
It floors the `k` the model requests. A weak local model sometimes asks for `top_k: 1`, starving a multi-part question of context. `minTopK` (in `search-knowledge-base-tool.ts:51`) guarantees selection returns enough — it's a quality guard on the selection parameter, separate from the sort.

## See also

- `01-complexity-and-cost-models.md` — the `O(n·d + n log n)` cost this walks
- `03-stacks-queues-deques-and-heaps.md` — the size-k heap alternative to the full sort
- `02-arrays-strings-and-hash-maps.md` — precision@k scoring the output of this rank
- `05-graphs-and-traversals.md` / `04-...` — HNSW, the indexed `O(log n)` escape hatch
- **study-ai-engineering** — whether the ranking is *good* (retrieval quality), vs how it's computed
