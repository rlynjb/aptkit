# Complexity & Cost Models

**Industry name(s):** asymptotic analysis · Big-O / Big-Θ · amortized analysis · cost models — *Industry standard*

---

## Zoom out, then zoom in

Before any single algorithm, here's the lens you hold over the whole repo. Complexity analysis isn't a topic in aptkit — it's the *question you ask of every other file*. Where it lives: nowhere and everywhere.

```
  Zoom out — the cost lens over aptkit's hot paths

  ┌─ Retrieval layer ───────────────────────────────────────────┐
  │  chunkText            O(n) over doc length    (one-time index)│
  │  ★ InMemoryVectorStore.search ★               (EVERY query)   │
  │     cosine per chunk  O(d) × n chunks  +  sort  O(n log n)    │
  │     = O(n·d + n log n) per query   ← the dominant cost        │
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Service layer ───────────▼─────────────────────────────────┐
  │  runAgentLoop  O(maxTurns) model calls — each call dwarfs    │
  │  everything above; the network/LLM cost is the real budget   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ swap for production
  ┌─ buffr (companion) ───────▼─────────────────────────────────┐
  │  PgVectorStore + HNSW   ≈ O(log n) per query (ANN)           │
  │  the asymptotic win the whole linear-scan story is about     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: you already know Big-O cold. What this file does is pin the *right* cost model onto aptkit's two hottest paths — the per-query vector search and the per-run agent loop — and show why the dominant term is different from where a CS-textbook instinct would point.

---

## Structure pass

**Layers:** index-time (chunk + embed + upsert, paid once) vs query-time (embed + scan + sort, paid every request) vs loop-time (model calls, paid per turn).

**Axis — cost (latency / compute per unit of work):** trace "what's the dominant term?" down the layers.

```
  One axis — "what dominates the cost?" — traced down the layers

  ┌──────────────────────────────────────────┐
  │ index-time:  embed n chunks   (one-time)  │ → embedding network call dominates
  └──────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ query-time: scan n chunks  (per query)│ → O(n·d) scan dominates in-memory
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ loop-time: maxTurns model calls   │ → the LLM call dominates EVERYTHING
          └──────────────────────────────────┘

  the answer flips at each altitude — that contrast is the lesson:
  the scan looks expensive in isolation, but a single model.complete()
  call costs more wall-clock than scanning thousands of chunks.
```

**Seam — the cost model flips at the in-memory→ANN boundary.** Inside aptkit, `search` is `O(n)` in corpus size. Cross into buffr's `PgVectorStore` and it becomes ~`O(log n)` via HNSW. The asymptotic class changes across that one boundary — which is exactly why it's the seam worth studying (file **05**).

---

## How it works

### Move 1 — the mental model

You know `.map()` over an array is `O(n)`, and sorting it is `O(n log n)`. The cost model is just: **find the term that grows fastest as input grows, drop the constants, and check whether you pay it once or every request.** The trap in aptkit isn't computing the Big-O — it's picking the right *input size*. The corpus has two sizes that matter: `n` (number of chunks) and `d` (embedding dimension, fixed at 768). Conflate them and your analysis is wrong.

```
  Pattern — three cost classes, three payment schedules

   input grows ──►
   O(1)        ████                      paid: per call    (Set.has, Map.get)
   O(d)        ████████                  paid: per chunk   (cosine, d=768 fixed)
   O(n·d)      ████████████████████      paid: per QUERY   (scan all chunks)
   O(n log n)  ██████████████████        paid: per QUERY   (sort the hits)
   O(maxTurns) ██ (small const × HUGE)   paid: per RUN     (model calls)

   "fixed d" collapses O(n·d) toward O(n) in practice — but the
   sort's O(n log n) then becomes the leading term as n grows.
```

### Move 2 — the walkthrough

#### Amortized vs per-call: the index path is paid once, the query path every time

The first cost-model move in aptkit is separating one-time from per-request work. `indexDocument` (`packages/retrieval/src/pipeline.ts:32-47`) chunks, embeds, and upserts — that's `O(n·d)` work, but you pay it **once**, when a document enters the corpus. `queryKnowledgeBase` (`pipeline.ts:50-59`) embeds the query once then calls `store.search` — and that's paid on **every** request.

```
  Amortized split — the same O(n) work, two schedules

  ┌─ index-time (amortized to ~0 per query) ─┐
  │  doc → chunkText → embed → upsert         │  paid once per doc
  └───────────────────────────────────────────┘
  ┌─ query-time (the real recurring cost) ───┐
  │  query → embed → search(scan+sort) → top-k│  paid every request
  └───────────────────────────────────────────┘
```

The boundary condition: if your workload is read-heavy (many queries, rare indexing), the per-query scan is what you optimize — and the index cost is noise. If it's write-heavy, the embed-on-index cost matters too. aptkit's RAG agents are overwhelmingly read-heavy, so the scan is the target.

#### The dominant term in `search`: O(n·d) scan, then O(n log n) sort

Here's the actual hot path, annotated:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:25-33
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {        // ← n iterations
    hits.push({ id: chunk.id,
      score: cosineSimilarity(vector, chunk.vector),  // ← O(d) each, d=768
      meta: chunk.meta });
  }
  hits.sort((a, b) => b.score - a.score);            // ← O(n log n)
  return hits.slice(0, Math.max(0, k));              // ← O(k)
}
```

Total: `O(n·d) + O(n log n) + O(k)`. Because `d` is a fixed 768, the textbook would write `O(n + n log n) = O(n log n)`. But in *wall-clock* terms `n·d` flop-heavy cosine work is the real spend for small `n`, and the sort dominates only once `n` is large. This is the gap between asymptotic class and measured cost that `study-performance-engineering` picks up.

The boundary condition that bites: this is `O(n)` in *corpus size, per query*. Ten thousand chunks and a hundred queries per second is a million cosine computations a second. That's the wall the linear scan hits — and the reason the production store is an ANN graph.

#### O(1) membership: the cheap operations that hide in plain sight

Not everything is `O(n)`. The tool allowlist is a `Set` lookup:

```ts
// packages/tools/src/tool-policy.ts:15-22
const allowed = new Set(policy.allowedTools);        // O(m) build, once
return allTools
  .filter((tool) => allowed.has(tool.name))          // O(1) per tool
  ...
```

`Set.has` is amortized `O(1)`. Same shape in `recall`'s per-conversation `Map<string, number>` counter (`packages/memory/src/conversation-memory.ts:71,78-79`): `Map.get`/`Map.set` are `O(1)`. These never show up in a latency profile — naming them as `O(1)` is how you know *not* to optimize them. (Full treatment in file **02**.)

#### The cost that dwarfs all of the above: the model call

`runAgentLoop` runs up to `maxTurns` iterations (default 8, `packages/runtime/src/run-agent-loop.ts:87`), each doing one `await model.complete(...)`. The loop is `O(maxTurns)` in model calls — a small constant. But each model call is hundreds of milliseconds to seconds of network + inference. So the *honest* cost model for an agent run is: `O(maxTurns)` × (a cost so large the entire retrieval scan rounds to zero next to it). The DSA instinct — "optimize the `O(n log n)` sort!" — is the wrong instinct here. Optimize the number of turns and tokens first.

### Move 3 — the principle

**Pick the input size and the payment schedule before you pick the Big-O.** The same `O(n)` scan is irrelevant when amortized over indexing and critical when paid per query; the same loop is trivial in iteration count and dominant in wall-clock because each iteration is a network call. Asymptotic class tells you how cost *scales*; the cost model tells you which cost *matters*.

---

## Primary diagram

The full cost picture across aptkit's layers.

```
  aptkit cost model — every load-bearing path, with its dominant term

  INDEX (amortized, once per doc)
   chunkText O(n_chars) → embed O(chunks·network) → upsert O(chunks)

  QUERY (per request)  ──────────────────────────────── the recurring cost
   embed query O(network)
   InMemoryVectorStore.search:
     ├ scan:  n × cosine(d)   = O(n·d)     ← grows with corpus
     ├ sort:  O(n log n)                   ← leading term as n grows
     └ slice: O(k)
   → swap to buffr PgVectorStore + HNSW ⇒ ≈ O(log n)   [the asymptotic win]

  LOOP (per run)
   runAgentLoop: O(maxTurns) × model.complete()
   ← each call >> all retrieval cost combined; THIS is the real budget

  CHEAP / O(1) (ignore in profiling)
   Set.has (tool policy) · Map.get/set (memory id counter, p@k seen-set)
```

---

## Elaborate

Amortized analysis comes from the analysis of dynamic arrays and hash tables — the question "what does an operation cost *on average over a sequence*, even if one operation is occasionally expensive?" The dynamic array's `push` is the canonical example: usually `O(1)`, occasionally `O(n)` when it resizes, but `O(1)` *amortized*. aptkit's index/query split is the same idea at a coarser grain: the expensive embedding work is amortized across the many cheap-relative queries that follow.

The deeper lesson aptkit teaches about cost models: in an LLM system, the traditional DSA cost (scans, sorts) is almost always dominated by I/O and inference cost. The discipline isn't "make the algorithm faster" — it's "know which layer's cost is the leading term so you optimize the right one." Read `study-performance-engineering` next for the measured-cost half of this.

---

## Interview defense

**Q: What's the time complexity of a single `search_knowledge_base` call in aptkit?**

> `O(n·d + n log n)` where `n` is corpus chunk count and `d` is the 768-dim embedding. The scan computes cosine against every chunk (`O(n·d)`), then sorts all hits (`O(n log n)`), then slices top-k (`O(k)`). With `d` fixed it's `O(n log n)`-bounded. It's `O(n)` *per query* in corpus size — which is exactly why production uses an ANN index instead.

```
  scan (n × O(d)) ──► sort (O(n log n)) ──► slice (O(k))
  dominant: O(n·d) flop-wise small n / O(n log n) large n
```

**Q: So is the scan the bottleneck you'd optimize first?**

> No — and that's the load-bearing point. Each agent run makes up to `maxTurns` model calls, and one `model.complete()` costs more wall-clock than scanning thousands of chunks. The first optimization is fewer turns / fewer tokens, not a faster scan. You optimize the scan only when the corpus is large enough that it competes with inference latency — and at that point you swap the linear store for buffr's HNSW.

Anchor: *the dominant cost in an LLM system is the model call, not the data-structure operation.*

---

## See also

- **02-arrays-strings-and-hash-maps.md** — the `O(n)` scan and `O(1)` membership in full.
- **06-sorting-searching-and-selection.md** — the `O(n log n)` sort and why it's a full sort, not a top-k heap.
- **05-graphs-and-traversals.md** — HNSW, the `O(log n)` ANN graph that replaces the scan.
- `study-performance-engineering` — the measured wall-clock half of every claim here.
