# Sorting, Searching & Selection

**Industry name(s):** comparison sort · ranking · top-k selection · linear/binary search · partial selection (quickselect) — *Industry standard*

---

## Zoom out, then zoom in

This is the second repo-grounded core. The single most-run algorithm in aptkit is a *sort* — `hits.sort()` inside the vector store — and the answer it produces, the top-k slice, is a *selection*. Ranking is what aptkit does.

```
  Zoom out — where sorting/selection lives in aptkit

  ┌─ Retrieval layer ───────────────────────────────────────────┐
  │  ★ InMemoryVectorStore.search ★                              │
  │    cosineSimilarity → SCORE each chunk     (the comparator)  │
  │    hits.sort(desc by score) → RANK         (O(n log n))      │
  │    .slice(0, k) → SELECT top-k             (the answer)      │
  └───────────────────────────┬─────────────────────────────────┘
                              │ scored by
  ┌─ Eval layer ──────────────▼─────────────────────────────────┐
  │  precision@k / recall@k → was the top-k SELECTION good?     │
  │  (packages/evals/src/precision-at-k.ts)                     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: sorting orders by a key; selection keeps only the best few; searching finds a target. aptkit ranks chunks by cosine score, selects the top-k, and then *evaluates* that selection with precision/recall. The three operations — score, rank, select — are the spine of retrieval, and they're all here in real code.

---

## Structure pass

**Layers:** the comparator (cosine score), the sort (full ordering), the selection (top-k slice), the evaluation (was the selection right?).

**Axis — exactness vs work:** trace "how much work to get a correct ranking?"

```
  One axis — "how much work for a correct top-k?"

  full sort + slice (aptkit) → order ALL n, keep k     O(n log n) — exact
  partial sort / heap        → order only what's needed O(n log k) — exact
  quickselect                → partition to k-th only   O(n) avg  — exact, unordered
  ANN graph (buffr)          → approximate nearest      O(log n)   — APPROXIMATE
```

**Seam — exact ranking (aptkit) vs approximate ranking (buffr).** aptkit's sort produces a provably-correct ordering. The production swap to HNSW (file **05**) gives up exactness for speed. The exactness axis flips across that boundary — and precision@k (this file's eval) exists precisely to *measure* how much exactness an approximate store loses.

---

## How it works

### Move 1 — the mental model

You've animated all five comparison sorts, so the mechanics are reflexive. The retrieval insight is simpler than the sorts themselves: **ranking is sort-by-a-derived-key.** The key isn't stored on the chunk — it's *computed per query* (cosine similarity to the query vector), so you score first, then sort by that ephemeral score, then take the front of the ordered list. The "search" in `search_knowledge_base` is really a *rank-and-select*, not a find-this-target search.

```
  Pattern — score, rank, select (the retrieval spine)

  chunks:   c0    c1    c2    c3    c4
  score:   0.31  0.88  0.42  0.91  0.20   ← cosine(query, chunk)
              │     │     │     │     │
              ▼     ▼     ▼     ▼     ▼
  sort desc: [0.91][0.88][0.42][0.31][0.20]   ← rank ALL by score
  slice(k=2): ─┴─────┴─                         ← SELECT top-2
  result:    [c3, c1]
```

### Move 2 — the walkthrough

#### The comparator: cosine similarity is the sort key

Before any sort there's a comparator. aptkit's is cosine similarity — the dot product of two vectors over the product of their magnitudes, in `[-1, 1]`:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:46-57
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0; let magA = 0; let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot  += a[i]! * b[i]!;        // numerator: alignment of the two vectors
    magA += a[i]! * a[i]!;        // |a|²
    magB += b[i]! * b[i]!;        // |b|²
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;   // 0 on a zero vector → avoid NaN
}
```

This is `O(d)` per comparison (`d` = 768). It's the sort *key generator* — every chunk gets one score against the query. The boundary condition the code guards (`denom === 0 ? 0`): a zero-length vector would divide by zero and produce `NaN`, which sorts unpredictably and poisons the ranking. Returning `0` keeps the comparator total and the sort well-defined.

#### The sort: full comparison sort, descending by score

The rank itself is one line — `Array.sort` with a descending-score comparator:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:31
hits.sort((a, b) => b.score - a.score);   // descending: highest score first
```

`Array.sort` in V8 is Timsort — a stable, adaptive merge/insertion hybrid, `O(n log n)` worst case. Two things matter here. **Stability:** equal scores keep their insertion order, so ties are deterministic (the map-iteration order). **It's a full sort:** every one of the `n` hits is ordered, even though only `k` survive the slice. That's the work file **03** flagged a heap could save — but at aptkit's small `n` the full sort wins on simplicity. The boundary condition: `b.score - a.score` on `NaN` scores would be undefined ordering — which is exactly why the comparator above never returns `NaN`.

#### The selection: top-k by slice

Selection is the array slice — and the defensive `Math.max(0, k)`:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:32
return hits.slice(0, Math.max(0, k));   // top-k; clamp negative k to 0
```

This is "selection by sort-then-truncate." A pure selection algorithm (quickselect) would find the k-th largest in `O(n)` average *without* fully ordering — but you'd get an unordered top-k and have to sort the survivors anyway, and aptkit *wants* them ordered (the model reads them best-first). So full-sort-then-slice is the right shape here even though quickselect is asymptotically cheaper for the pure "which k" question. The boundary condition: `Math.max(0, k)` stops a negative `k` from `slice`'s negative-index behavior (which would count from the end and return garbage).

#### The minTopK floor: a selection-size guard against a weak model

There's a subtle selection bug the retrieval tool defends against — a weak local model asking for `top_k: 1` and starving its own multi-part question. The tool floors the selection size:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:55, 82-84
const minTopK = Math.max(1, options.minTopK ?? 1);
// ...
const requestedTopK = typeof args.top_k === 'number' && args.top_k > 0 ? args.top_k : defaultTopK;
const topK = Math.max(requestedTopK, minTopK);   // floor the selection size
```

This is a selection-size policy, not an algorithm — but it's the difference between a correct retrieval and a missed answer. If the model picks `top_k: 1` for a question needing three sources, `minTopK` overrides it. The lesson: the *size* of a selection is itself a correctness parameter, not just a performance knob.

#### Evaluating the selection: precision@k and recall@k

Once you have a top-k, how good was it? That's `study-ai-engineering`'s domain conceptually, but the *algorithm* is a set-intersection over the selected window, and it lives here:

```ts
// packages/evals/src/precision-at-k.ts:47-57
export function scorePrecisionAtK(retrievedIds, relevantIds: ReadonlySet<string>, k): RetrievalScoreResult {
  if (k <= 0) return { ...NOT_WELL_FORMED };
  const total = Math.min(k, retrievedIds.length);   // denominator: actual window size
  if (total === 0) return { ...NOT_WELL_FORMED };
  const matched = countDistinctHits(retrievedIds, relevantIds, k);  // |top-k ∩ relevant|
  return { ok: true, score: matched / total, matched, total };
}
```

```
  Execution trace — precision@k over a selection

  retrievedIds = [c3, c1, c9, c1, c4]   relevantIds = {c1, c3, c7}   k = 3
  topK = slice(0,3) = [c3, c1, c9]
  seen = {}
    c3 in relevant? yes → seen={c3}
    c1 in relevant? yes → seen={c3,c1}
    c9 in relevant? no  → seen={c3,c1}
  matched = |seen| = 2     total = min(3, 5) = 3
  precision@3 = 2/3 = 0.67
```

precision@k = "of the k I selected, what fraction were relevant?"; recall@k (`precision-at-k.ts:68-78`) = "of all relevant, what fraction did I select?" — same `countDistinctHits`, different denominator (`relevantIds.size`). The `ok` flag separates *well-formed* from *good*: a real score of `0` still has `ok: true`; `ok: false` means the metric is *undefined* (`k <= 0` or empty denominator). That distinction is the careful part — never conflate "the selection was bad" with "the metric couldn't be computed."

### Move 3 — the principle

**Retrieval is score → rank → select, and the cheapest correct version depends on whether you need the survivors ordered.** aptkit full-sorts because it's small and wants the top-k ordered for the model; quickselect or a bounded heap would win at scale on the pure "which k" question; an ANN graph wins at large scale by giving up exactness. And the *size* of the selection (`minTopK`) is a correctness parameter, not a tuning knob. precision@k closes the loop — it measures whether the selection algorithm, exact or approximate, actually surfaced the relevant items.

---

## Primary diagram

The full score-rank-select-evaluate pipeline.

```
  aptkit retrieval — sorting, selection, and its evaluation

  SCORE   cosineSimilarity(query, chunk)  O(d) each, d=768
            guard: zero vector → 0 (no NaN to poison the sort)
            ↓
  RANK    hits.sort((a,b)=>b.score-a.score)  Timsort, O(n log n), stable
            (full sort: orders all n even though k survive)
            ↓
  SELECT  .slice(0, max(0,k))   top-k, ordered best-first
            policy: topK = max(requested, minTopK)  ← floor vs weak model
            ↓
  EVALUATE scorePrecisionAtK / scoreRecallAtK
            matched = |top-k ∩ relevant|   (distinct, via Set)
            precision = matched / min(k, retrieved)
            recall    = matched / |relevant|
            ok=false ⇒ metric undefined (≠ score 0)

  scale swap: full sort (exact) → HNSW graph (approximate, file 05)
              precision@k is how you measure what approximation costs
```

---

## Elaborate

The "sort by a computed key then take the front" shape is universal in ranking systems — search engines, feed ranking, recommendation. The interesting engineering is almost always in the *comparator* (here, cosine similarity) and the *selection size*, not the sort algorithm, which is a solved problem you delegate to the standard library. Quickselect (Hoare, 1961) is the answer when you need *only* the k-th element or an unordered top-k — `O(n)` average by partitioning toward the pivot without fully sorting; it's worth knowing precisely so you can say *why* aptkit doesn't use it (it wants the survivors ordered).

precision@k and recall@k come from information retrieval, decades older than embeddings. Their job in aptkit is to make retrieval quality a *number* so the eval harness can catch a regression — swap the embedding model or the store and precision@k tells you if relevance dropped. That's the bridge to `study-ai-engineering` (RAG quality) and `study-testing` (regression baselines): the selection algorithm here produces the ranking; those guides measure and guard it.

Binary search, notably, is `not yet exercised` — aptkit never searches a *sorted* array for a target. The sort here is for ranking, and the result is consumed as a top-k slice, never binary-searched. Naming the absence is the point: the "search" in this system is rank-and-select, not target-find.

---

## Interview defense

**Q: Walk me through the most-run algorithm in aptkit.**

> `InMemoryVectorStore.search`. It scores every chunk against the query with cosine similarity — `O(d)` per chunk, `d=768` — pushes `{id, score, meta}` into a hit array, sorts it descending by score with `Array.sort` (Timsort, stable, `O(n log n)`), and slices the top-k. Score, rank, select. The comparator guards against a zero vector returning `NaN`, which would scramble the sort; the slice clamps negative k to 0. It's a full sort even though only k survive — correct because `n` is small and the model wants the survivors ordered best-first.

```
  score (cosine, O(d)) → sort (Timsort O(n log n)) → slice(top-k)
```

**Q: Why a full sort and not quickselect, which is `O(n)`?**

> Quickselect gives you the k-th element or an unordered top-k in `O(n)` average — but I need the top-k *ordered*, because the model reads them best-first, so I'd have to sort the survivors anyway. At aptkit's small `n` the full sort is simpler and the asymptotic difference is invisible. Quickselect or a bounded heap earns its place only when `n` is large and `k << n`. And at *real* scale the right move isn't a cleverer selection at all — it's an ANN index that never ranks all `n`, which is what precision@k lets me measure the accuracy cost of.

**Q: What does `ok: false` mean in the precision@k result?**

> That the metric is *undefined*, not that the selection was bad. `ok: false` happens only when `k <= 0` or the denominator is zero (nothing retrieved, or no relevant ids). A genuine precision of `0` — selected k items, none relevant — still has `ok: true`. Separating "couldn't compute" from "computed and it's zero" stops a degenerate input from masquerading as a quality failure.

Anchor: *retrieval is score → rank → select; aptkit full-sorts because it's small and wants ordered survivors, and precision@k measures what an approximate selection would cost.*

---

## See also

- **02-arrays-strings-and-hash-maps.md** — the hit array the sort orders and the sets precision@k intersects.
- **03-stacks-queues-deques-and-heaps.md** — the heap-based partial selection aptkit declines to use.
- **05-graphs-and-traversals.md** — the approximate (HNSW) alternative to exact full-sort ranking.
- **01-complexity-and-cost-models.md** — the `O(n log n)` cost of the sort in context.
- `study-ai-engineering` / `study-testing` — precision@k as RAG-quality metric and regression baseline.
