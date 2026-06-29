# Complexity & Cost Models

**Asymptotic analysis / Big-O · amortized cost · the right cost model** — Language-agnostic.

## Zoom out, then zoom in

Every "is this fast enough?" question in aptkit traces back to one number you can read straight off a `for` loop. Here's where the cost actually accrues in the running system.

```
  Zoom out — where cost is paid in aptkit

  ┌─ Service layer — packages/runtime ───────────────────────────┐
  │  agent loop: ≤ maxTurns model calls                           │
  │    cost dominated by the NETWORK call, not the loop           │ ← cost lives
  │  parseAgentJson: O(n) over output text                        │   in the model
  └───────────────────────────────┬───────────────────────────────┘   call here
                                   │
  ┌─ Storage layer — packages/retrieval ─────────────────────────┐
  │  ★ vector search: O(n · d) scan + O(n log n) sort ★            │ ← THIS is the
  │    n = #chunks, d = 768 dims                                   │   algorithmic
  │  chunker: O(L) over document length L                         │   cost model
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the cost model is the discipline of asking *which input grows, and what does the work do as it grows?* For aptkit the answer is almost never "the loop is slow" — it's "the model call costs 800ms and the vector scan is `O(n·d)` where `n` is small today and unbounded tomorrow." Picking the right `n` is the entire skill. You already do this when you reason about a render pass over a `.map()` of rows; same move, different `n`.

## Structure pass

```
  layers:  per-request work  →  per-corpus work  →  per-document work
  axis held constant: "what is n, and what does cost do as n grows?"

  ┌─ agent loop (per request) ──┐   n = maxTurns (a CONSTANT, ≤8)
  │  cost = O(turns) × model RTT │   → bounded by design, not by input
  └──────────────┬───────────────┘
                 │  seam: input size flips from "fixed cap" to "corpus size"
  ┌─ vector scan (per corpus) ──┐   n = #chunks (UNBOUNDED, grows with docs)
  │  cost = O(n · d) + O(n log n)│   → this is the one that bites at scale
  └──────────────┬───────────────┘
                 │  seam: input size flips to "one document's length"
  ┌─ chunker (per document) ────┐   n = L = doc char length
  │  cost = O(L)                 │   → linear, runs once at index time
  └──────────────────────────────┘
```

The load-bearing seam is the middle one. The agent loop's cost is capped by a constant (`maxTurns`); the scan's cost grows with the corpus. When someone asks "will aptkit scale," they mean *that* `n`.

## How it works

### Move 1 — the mental model

Big-O is a function that answers one question: *as the input grows, how does the work grow?* You don't count operations — you count the **shape** of the growth and throw away constants. A loop over `n` items is `O(n)`. A loop inside a loop is `O(n²)`. A sort is `O(n log n)`. That's 90% of what you ever need to read off real code.

```
  Big-O is the SHAPE of the growth curve, constants discarded

  work
   │            O(n²)   ← nested loop
   │          ╱
   │        ╱   O(n log n)  ← sort
   │      ╱  ╭─────
   │    ╱ ╭──        O(n)   ← single scan
   │   ╱╭─    ────────
   │  ╱─  ──────────── O(1)  ← Set.has(), Map.get()
   │ ╱──────────────────────
   └──────────────────────────► n (input size)
```

The trap is picking the wrong `n`. In aptkit the agent loop *looks* expensive (a loop with model calls inside) but its `n` is a constant cap — the real `O(n)` lives in the vector scan where `n` is the corpus.

### Move 2 — walking aptkit's actual cost

**The vector scan — `O(n · d)` to score, `O(n log n)` to rank.** This is the one cost model worth memorizing in this repo. Open `in-memory-vector-store.ts:25`:

```ts
  async search(vector: number[], k: number): Promise<VectorHit[]> {
    this.assertDimension(vector, 'query vector');
    const hits: VectorHit[] = [];
    for (const chunk of this.chunks.values()) {          // ← O(n): n = #chunks
      hits.push({ id: chunk.id,
        score: cosineSimilarity(vector, chunk.vector),    // ← O(d): d = 768 dims
        meta: chunk.meta });
    }
    hits.sort((a, b) => b.score - a.score);              // ← O(n log n): full sort
    return hits.slice(0, Math.max(0, k));                // ← O(k): take top-k
  }
```

Read it line by line. The `for` loop touches every chunk once — that's the `n`. Inside, `cosineSimilarity` walks all 768 dimensions — that's the `d`. So scoring is `O(n · d)`. Then a full `.sort()` is `O(n log n)`, and `slice(k)` is `O(k)`. Total: **`O(n·d + n log n)`**. With `d` fixed at 768, the scoring term dominates until `n` gets large, then the sort term catches up.

Here's the boundary condition that matters: this is *exact*. Every chunk is scored, the ranking is provably correct. The cost you pay for that exactness is linear in the corpus — there is no index, no shortcut. The moment `n` is millions, this is too slow, and that's exactly the line buffr crosses by swapping in HNSW (see file 06 and 05).

**The agent loop — `O(maxTurns)`, a bounded constant.** Now contrast `run-agent-loop.ts:98`:

```ts
  for (let turn = 0; turn < maxTurns; turn += 1) {   // ← maxTurns defaults to 8
    ...
    const response = await model.complete({ ... });  // ← the REAL cost: network RTT
```

The loop runs at most `maxTurns` times — a constant (8 by default, line 87). So the loop's *algorithmic* cost is `O(1)` in any input you'd grow. The actual wall-clock cost is `maxTurns × (model round-trip time)`, which is dominated by the network, not the CPU. This is the cost-model lesson: **the expensive thing here isn't the algorithm, it's the I/O the algorithm waits on.** Counting loop iterations would mislead you completely.

**Amortized cost — the chunker's overlap.** The chunker (`chunker.ts:24`) steps through a string with `step = size - overlap`. It re-reads `overlap` characters on every window — wasted work. But it runs *once per document at index time*, never on the query hot path. Amortized over the document's whole life in the corpus, that re-read cost is zero. The cost-model lesson: **where work happens matters as much as how much.** Index-time waste is free; query-time waste is the bill.

### Move 3 — the principle

The cost model is not Big-O notation — it's choosing *which* `n` you're measuring and *where* the work lands. aptkit's loops are cheap; its scan grows with the corpus; its real latency is network I/O. Read the right `n` and the bottleneck names itself.

## Primary diagram

```
  aptkit's cost model — one frame

  REQUEST PATH (per call)              INDEX PATH (per document, once)
  ──────────────────────               ──────────────────────────────
  agent loop   O(maxTurns) ≈ O(1)      chunker     O(L)
     │  bounded by cap                    │  linear, amortized to ~0
     ▼  real cost = network RTT           ▼
  vector scan  O(n·d + n log n)        embed       O(chunks · model)
     │  n = corpus (UNBOUNDED) ★          │
     ▼  EXACT, no index                   ▼
  parseAgentJson O(output length)      store.upsert O(chunks)

  ★ = the only term that grows without bound; the scale story lives here
```

## Elaborate

Big-O came out of algorithm analysis (Knuth, 1970s) to compare algorithms independent of hardware. The thing textbooks underemphasize and production teaches hard: **constants and the choice of `n` decide real systems.** An `O(n²)` algorithm on `n=10` beats an `O(n log n)` one with a huge constant. aptkit's exact `O(n·d)` scan is the *right* choice while the corpus is small — simpler, exact, zero index-build cost — and the wrong one once it's large. That crossover point is a measurement question, which is why **study-performance-engineering** owns the "when do you switch" decision and this file only owns the "what's the growth shape" model.

## Interview defense

**Q: What's the time complexity of aptkit's vector search, and what's `n`?**
Lead with the answer: `O(n·d + n log n)`, where `n` is the number of chunks in the corpus and `d` is the embedding dimension (768). The scoring loop is `O(n·d)`, the rank is `O(n log n)`, the slice is `O(k)`.

```
  search() cost
  ┌──────────────────┬──────────┐
  │ score every chunk│ O(n · d) │  for-loop × cosine over d dims
  │ sort by score    │ O(n logn)│  full .sort()
  │ take top-k       │ O(k)     │  slice
  └──────────────────┴──────────┘
```

Anchor: "It's exact — every chunk scored — and that exactness is why it's linear in the corpus. buffr trades exactness for `O(log n)` via HNSW."

**Q: The agent loop has a network call inside a loop. Isn't that the bottleneck to optimize?**
The loop is capped at `maxTurns` (8), so it's `O(1)` algorithmically — you can't optimize the iteration count meaningfully. The cost is `maxTurns × RTT`; the lever is fewer turns or a faster model, not loop micro-optimization. Naming that the loop's `n` is a *constant* is the signal you read the cost model right, not just the code.

## See also

- `02-arrays-strings-and-hash-maps.md` — the scan and the `O(1)` membership it relies on
- `06-sorting-searching-and-selection.md` — the top-k selection this file costs out
- `07-recursion-backtracking-and-dynamic-programming.md` — the bounded loop as a state space
- **study-performance-engineering** — measuring the scan, finding the crossover point
