# Performance Engineering — overview

The repo-grounded map: what's measurably slow or expensive in aptkit, what's bounded, what's accounted, and the long honest list of what is `not yet exercised`. Read this first, then `audit.md`, then the pattern files.

## The one-paragraph verdict

aptkit has built the *seams* where performance gets controlled — the `VectorStore` contract isolating the slow primitive, the bounded agent loop capping worst-case work, the batch-shaped embedding contract, the build-time-inlined static Studio — and it has wired exactly one real measurement: token cost. **Nothing else is measured.** No budget is written down, no baseline captured, no profiler attached, no p95 computed, no cache anywhere, no backpressure. That is the correct state for a from-scratch toolkit at this stage; the value of this guide is naming precisely where the controls exist and where the measurements don't.

## The map

```
  aptkit performance surfaces — where cost and latency live

  ┌─ Studio (client) ─────────────────────────────────────────┐
  │  one 537 kB JS chunk, fixtures+docs inlined → 0 runtime    │
  │  fetch   ───────────────────────────────────► 05-build-... │
  └───────────────────────────┬───────────────────────────────┘
                              │
  ┌─ Agent runtime ───────────▼───────────────────────────────┐
  │  runAgentLoop: maxTurns/maxToolCalls cap worst case ──► 02 │
  │  model_usage events → summarizeUsage/estimateCost ────► 03 │
  └───────────────────────────┬───────────────────────────────┘
                              │ search_knowledge_base tool
  ┌─ Retrieval ───────────────▼───────────────────────────────┐
  │  embed(texts[]) batched on index path ────────────────► 04 │
  │  over-fetch k*4 then JS filter (no predicate) ────────► 06 │
  │  store.search:                                            │
  │    InMemoryVectorStore  O(n·d)+sort  ──┐                   │
  │    PgVectorStore (buffr) HNSW ~O(log n) ┴──────────────► 01 │
  └────────────────────────────────────────────────────────────┘
```

## Ranked findings

1. **The linear scan won't scale — but it's isolated behind a contract (`01`).** `InMemoryVectorStore.search` is O(n·d) + a full sort per query (`in-memory-vector-store.ts:25-33`). It is exactly correct and needs zero infrastructure, and the `VectorStore` seam makes buffr's HNSW-indexed `PgVectorStore` a drop-in. Structurally the first thing to fall over at scale; unmeasured. The HNSW `ef_search` knob in buffr is at its default — untuned.

2. **Worst-case cost is bounded; cost is accounted (`02`, `03`).** Each agent caps `maxTurns`/`maxToolCalls`, and since each turn is one model round-trip, that cap *is* the cost and tail-latency ceiling — a priceable number before you run. The loop emits `model_usage` per turn, summed and priced by the token ledger. This is the one fully-wired measurement in the repo (pricing table covers OpenAI only).

3. **Two contract-shaped inefficiencies, both deliberate, both unmeasured (`04`, `06`).** Embedding batches on the index path but the chunk-window size (512/64) trades recall against cost with no baseline. Both `search_knowledge_base` and memory `recall` over-fetch `k*4` then filter in JS because `VectorStore` has no metadata predicate — free in-process, but rows-over-the-wire against `PgVectorStore`. The Studio bundle (537 kB, one chunk, over Vite's warning) is the same shape of accepted-and-visible tradeoff (`05`).

## `not yet exercised`

The honest absence list — these become relevant at the noted point, and the audit names each:

- **Performance budget** — no written latency/cost/bundle budget. Hard caps stand in (loop ceilings). → relevant once aptkit fronts a service with an SLA.
- **Baselines & profiling** — no profiler, no representative-workload harness, no captured baseline. The `durationMs` already in replay artifacts is the seed to start from. → relevant the moment you need to say *which* path is slow from data, not inference.
- **Latency / throughput / tail** — no p50/p95/p99, no throughput target, no contention analysis. → relevant under concurrent load.
- **Caching** — none anywhere. Identical queries re-embed; identical inputs re-run the loop. → relevant under any repeat-query load.
- **Backpressure / overload control** — no limiter, semaphore, queue bound, or admission control. Per-run cost is capped; cross-run concurrency is not. → relevant in a multi-user service.
- **HNSW tuning (buffr)** — `m`/`ef_construction`/`ef_search` all at pgvector defaults; pool at default size. → relevant once corpus and query load grow.
- **Bundle splitting** — no `manualChunks`, no lazy routes; one 537 kB chunk. → relevant if Studio grows past a load-once demo.
- **GC / allocation analysis** — never profiled. → relevant only if the in-memory store runs at non-demo scale.

## Reading order

1. `audit.md` — the 8-lens walk, every lens grounded or marked `not yet exercised`, red flags ranked.
2. `01-linear-scan-vs-ann-tradeoff.md` — the headline cost surface and its drop-in fix.
3. `02-bounded-loop-cost-ceiling.md` — how worst-case run cost is bounded.
4. `03-token-cost-accounting.md` — the one real measurement.
5. `04-embedding-batching.md` — index-path batching + the recall/cost dial.
6. `05-build-time-inlining-zero-fetch.md` — the Studio bundle tradeoff.
7. `06-over-fetch-then-filter-cost.md` — the contract-gap cost.

## Cross-links

- `study-runtime-systems` — the event loop, the synchronous-in-async scan, `AbortSignal` cancellation.
- `study-database-systems` — HNSW internals, pgvector query planning, predicate pushdown.
- `study-ai-engineering` — embedding models, chunking strategy, retrieval recall, eval scoring.
- `study-frontend-engineering` — Studio rendering, the Vite build, dev-middleware replay routes.
