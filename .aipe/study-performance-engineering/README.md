# study-performance-engineering

Measurement and optimization of aptkit: budgets, baselines, profiling, latency, throughput, memory, I/O, rendering, caching, batching, backpressure, and cost — grounded in real files, honest about what is `not yet exercised`.

The through-line: **what is measurably slow or expensive, why, and which change improves it without moving the bottleneck?** The honest answer for aptkit today: almost nothing is *measured* — but the seams where performance gets controlled are built, and one cost (tokens) is fully accounted.

## Reading order

1. **`00-overview.md`** — the map, the ranked findings, and the full `not yet exercised` list. Start here.
2. **`audit.md`** — Pass 1. The 8-lens audit (budget, baselines, latency/tail, CPU/memory, I/O/DB, caching/batching/backpressure, rendering, red-flags). Every lens grounded or marked `not yet exercised`; red flags ranked by consequence.
3. **The pattern files** — Pass 2, the patterns this repo actually exercises:
   - `01-linear-scan-vs-ann-tradeoff.md` — exact O(n) scan vs HNSW ANN, behind one `VectorStore` contract
   - `02-bounded-loop-cost-ceiling.md` — `maxTurns`/`maxToolCalls` as a worst-case cost ceiling + forced synthesis
   - `03-token-cost-accounting.md` — the one real measurement: meter → reduce → price
   - `04-embedding-batching.md` — batch-shaped embed contract + the chunk-window recall/cost dial
   - `05-build-time-inlining-zero-fetch.md` — fixtures/docs inlined → 537 kB chunk, zero runtime fetch
   - `06-over-fetch-then-filter-cost.md` — `k*4` over-fetch + JS filter because the contract has no predicate

## What lives here vs next door

This guide MEASURES and improves observed bottlenecks. It does not re-teach mechanisms or architecture that belong to neighbors:

- **`study-runtime-systems`** — the execution model: event loop, the synchronous-in-async scan, `AbortSignal` cancellation threaded through the loop.
- **`study-database-systems`** — the storage engine: HNSW internals, pgvector query planning, predicate pushdown.
- **`study-ai-engineering`** — embedding models, chunking strategy, retrieval recall, eval scoring.
- **`study-frontend-engineering`** — Studio rendering, the Vite build pipeline, dev-middleware replay routes.

A finding belongs to the generator that owns the mechanism; this guide cross-links rather than duplicates.
