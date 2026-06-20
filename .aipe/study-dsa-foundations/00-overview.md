# 00 — Overview: AptKit through a DSA lens

## The verdict first

AptKit is a small set of data structures used well, not a large set used badly. If you opened every `.ts` file and tallied the structures, the count is short: **`Map` (one, the tool registry), `Set` (allowlists, dedup, retrieval scoring), discriminated unions (the event and rule streams), arrays-as-logs (the message transcript), modulo round-robin (variant scheduling), `Array.prototype.sort` comparators (ranking), and — newly, in `@aptkit/retrieval` — a numeric vector dot-product (cosine similarity) and fixed-window string slicing (chunking).** That is the working vocabulary. The textbook structures most readers expect — balanced trees, heaps, graphs as traversal, binary search, dynamic programming — are still genuinely absent, and the absence is correct for what this codebase is: a stateless orchestration layer over an LLM, where the expensive thing is a model round-trip, not a CPU cycle.

The one shift since the first pass: `@aptkit/retrieval` adds a *from-scratch RAG pipeline* that exercises three DSA primitives the rest of the kit never reached for — **cosine similarity** (a dot-product over float vectors with magnitude normalization), **linear-scan nearest-neighbor** (score every chunk, sort, take top-k), and **fixed-size character chunking** (a sliding window with overlap). Plus `packages/evals/precision-at-k.ts` adds **precision@k / recall@k** as `Set`-membership scoring. None of this is large-scale yet (the store is an in-memory `Map`), but it moves a few "not yet exercised" items closer to live — most importantly the linear-scan → ANN/HNSW tradeoff, which the code now explicitly gestures at instead of being purely hypothetical.

Here is the whole repo as one DSA picture before we zoom into any single structure.

```
  AptKit — the structures, by layer

  ┌─ Agent capability (per-agent package) ───────────────────────────┐
  │  message array  →  comparator sort + slice (top-k ranking)       │
  │  (transcript log)     anomaly-monitoring, recommendation         │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ calls
  ┌─ Runtime (foundation) ────▼──────────────────────────────────────┐
  │  bounded loop over message array   discriminated union           │
  │  (turn budget = termination)       (CapabilityEvent stream)      │
  │  bounded JSON substring scan       reduce over event log         │
  │  (parseAgentJson)                  (usage-ledger)                 │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ uses
  ┌─ Tools / context / evals ─▼──────────────────────────────────────┐
  │  Map<name,handler>   Set<allowedTools>   Set membership (coverage)│
  │  (registry lookup)   (policy filter)     dotted-path walk (diff)  │
  │  Set ops: precision@k / recall@k (evals/precision-at-k.ts)        │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ retrieval (new package)
  ┌─ Retrieval (@aptkit/retrieval) ───▼───────────────────────────────┐
  │  chunkText: fixed-window string slice + overlap                   │
  │  cosineSimilarity: dot-product / (‖a‖·‖b‖)  over float vectors    │
  │  InMemoryVectorStore.search: linear scan + sort + slice (top-k)   │
  │  ← linear scan O(n·d) is where an ANN/HNSW index would slot in    │
  └───────────────────────────────────────────────────────────────────┘
```

Read it from the bottom: the substrate is `Map` and `Set` lookups and a dotted-path JSON walk. The middle is a bounded loop over an array and a discriminated-union stream. The top is comparator sorts that rank and `slice` that caps. The newest layer, `@aptkit/retrieval`, is the one place the kit does *numeric* DSA — a cosine dot-product over float vectors and a sliding-window string chunker — and it's the one place a real scale tradeoff (linear scan vs. an approximate-nearest-neighbor graph index) becomes concrete rather than hypothetical. Everywhere else the data is small (≤10 anomalies, ≤3 recommendations, ~49 tools, a handful of events), so linear scans and hash lookups win on both simplicity and real-world speed.

## Ranked findings — what's most consequential

These are ordered by how much they shape the codebase, not alphabetically.

**1. The `Map`-backed `InMemoryToolRegistry` is the most load-bearing structure in the repo.** `packages/tools/src/tool-registry.ts:34` holds `handlers = new Map<string, ToolHandler>()`, and `callTool` (`:50`) is an O(1) `Map.get` followed by an invocation with a wall-clock timing. Every tool the model calls routes through this one `Map`. It is the hot path's only real data-structure lookup. → `02-arrays-strings-and-hash-maps.md`.

**2. `Set` is the repo's correctness primitive, not just a convenience.** Three independent places turn an allowlist or expected-list into a `Set` and ask membership questions: tool-policy least-privilege filtering (`tool-policy.ts:15`), coverage gating (`coverage-gate.ts:42`), and detection scoring's matched/missed/unexpected partition (`detection-scorer.ts:64,80`). The `Set` is what makes "did the model stay inside its allowed tools" an O(1) check instead of an O(n) scan. → `02-arrays-strings-and-hash-maps.md`.

**3. The real cost model is tokens-and-turns, not Big-O.** `run-agent-loop.ts:98` bounds the loop with `turn < maxTurns`, `:101` adds a `maxToolCalls` budget, and `usage-ledger.ts:25` reduces the event stream into a token total that `estimateCost` (`:50`) prices in USD. The asymptotic complexity of any structure here is dwarfed by the cost of one model round-trip. This is the cost axis that actually bites. → `01-complexity-and-cost-models.md`.

**4. Round-robin modulo scheduling is the only non-trivial *algorithm* in the repo.** `content-generation-workflow.ts:148-156` (`planContentVariant`) uses `variantIndex % sections.length` and `variantIndex % angles.length` to fan content variants evenly across sections and angles. It is a clean, classic technique and the closest thing to an "algorithm with a name" outside of sort. → `03-stacks-queues-deques-and-heaps.md`.

**5. Ranking is comparator-sort-then-slice, repeated.** `monitoring-agent.ts:86-88` sorts anomalies by a `severityRank` lookup table descending, then `slice(0, 10)` caps the output — a top-k by full sort. The same shape (sort by a derived key, take a prefix) recurs wherever the repo ranks — and now also in `InMemoryVectorStore.search` (`packages/retrieval/src/in-memory-vector-store.ts:31-32`), which sorts all chunks by cosine score descending and slices the top-k. No heap-based selection, because k is tiny. → `06-sorting-searching-and-selection.md`.

**6. Cosine similarity is the repo's first and only numeric vector algorithm.** `in-memory-vector-store.ts:46-57` computes a dot product plus two squared-magnitudes in one O(d) pass, then divides by the product of norms (with a zero-denominator guard returning 0 to avoid `NaN`). Every retrieval hit's score comes from this one function. It's the foundation under the entire RAG ranking, and the `search` method's overall cost — score every stored chunk, then sort — is **O(n·d + n log n)**: a linear scan over n chunks at d dimensions. This is the textbook brute-force nearest-neighbor, and it's exactly the cost the contracts are designed to swap out for an ANN index later. → `06-sorting-searching-and-selection.md`, with the scale tradeoff in `05-graphs-and-traversals.md`.

**7. Fixed-window chunking and precision@k/recall@k are new string-and-set work.** `chunker.ts:16-31` slides a `512`-char window with a `64`-char overlap across a document (`step = size - overlap`), a classic windowing algorithm with an off-by-one-able termination (`start + size >= text.length` breaks the loop). And `evals/src/precision-at-k.ts:27-78` scores ranked retrieval with `Set` membership — `countDistinctHits` builds a `seen` set over the top-k so a relevant id counted once, with denominators that differ between precision (`min(k, retrieved)`) and recall (`|relevant|`). → chunking and the `Set` scoring both land in `02-arrays-strings-and-hash-maps.md`.

## The `not yet exercised` list — and when each would matter here

This is the honest half. Each of these is a foundation you've already built in `reincodes`; none appears in AptKit, and here's the trigger that would change that.

```
  foundation            status in aptkit       what would pull it in

  cosine similarity     NOW EXERCISED          in-memory-vector-store.ts:46
  fixed-window chunk    NOW EXERCISED          chunker.ts:16
  precision@k/recall@k  NOW EXERCISED          evals/precision-at-k.ts:47,68
  linear-scan k-NN      NOW EXERCISED          in-memory-vector-store.ts:25
                        (brute force, O(n·d))
  ──────────────────────────────────────────────────────────────────────────
  ANN / HNSW graph      not yet exercised      corpus grows past a few-thousand
   index                (BUT the code now       chunks so the O(n·d) scan hurts;
                         points right at it)    the PgVectorStore drop-in or an
                                                HNSW index replaces the scan
  heap / priority queue not yet exercised      top-k where k << n and n is
                                                large; today retrieval sorts
                                                ALL chunks then slices — a heap
                                                wins once n is large and k small
  binary search         not yet exercised      sorted artifact index large
                                                enough that linear scan hurts
  balanced tree / index not yet exercised      a persistent ordered store of
                                                replays queried by range
  trie                  not yet exercised      prefix routing over hundreds of
                                                tool names or intents
  graph + BFS/DFS       not yet exercised      capability dependencies that
                                                actually chain (A enables B
                                                enables C), needing topo order
  dynamic programming   not yet exercised      optimal sub-structure problem —
                                                none exists in this kit today
  backtracking          not yet exercised      constraint search over a state
                                                space (your river-crossing PG.ts)
```

The honest read: AptKit's data is still small and flat almost everywhere — heaps, balanced trees, and graph *traversal* have nothing to bite on yet. The one thing that changed is retrieval. `InMemoryVectorStore.search` is the kit's first algorithm whose cost scales with corpus size (O(n·d) to score, O(n log n) to sort), and the package's own comments call out that an `HNSW`/`PgVectorStore` drop-in is the next step. That's the most concrete "scale would pull in a foundation" story in the repo now: an HNSW index is literally a navigable-small-world *graph* you traverse greedily, so the day the corpus outgrows the in-memory scan, finding #6 turns into a graph-traversal problem — and the heap that a partial top-k would use (find #5) becomes worth its complexity. Separately, the coverage system (`coverage-gate.ts`) still *looks* like a dependency graph — `requires`/`enriches` are edges in spirit — but is still evaluated as flat `Set.has` checks with no traversal. → `05-graphs-and-traversals.md` walks both the coverage case and the new ANN/HNSW trigger.

## How to use this guide

Work top to bottom. Each concept file opens with where it sits in the layer diagram, walks the mechanism with pseudocode and a diagram before any real code, then shows the actual AptKit lines with a line-by-line read. The `not yet exercised` files are short on repo-anchored code (because there isn't any) and longer on "here's the foundation, here's the trigger, here's where you'd reach for it" — those lean on your `reincodes` background so the teaching has somewhere to land.

The final file, `08-dsa-foundations-practice-map.md`, ranks what to practice: the exercised concepts to sharpen for interviews first, the missing foundations to keep warm second.
