# Study — Performance Engineering (aptkit)

Measurement and optimization of this repo: budgets, baselines, profiling,
latency, throughput, memory, I/O, rendering, caching, batching, backpressure,
and cost. Grounded in real files. **The honest headline: nothing here is
measured yet** — this guide walks the repo's performance *decisions* and names
everywhere a budget, baseline, or profile is `not yet exercised`.

This is an audit-style guide — two passes:

- **Pass 1** is `audit.md`: an 8-lens walk of the whole repo, each lens grounded
  in `file:line` or marked `not yet exercised`, ending in a ranked red-flag
  table.
- **Pass 2** is the numbered pattern files: one per performance pattern the repo
  actually exercises.

## Reading order

1. **`00-overview.md`** — the map, ranked findings, and the full `not yet
   exercised` list. Start here.
2. **`audit.md`** — Pass 1, the 8-lens audit.
3. **`01-bounded-loop-cost-ceiling.md`** — the agent loop's hard turn/tool-call
   ceiling + forced synthesis turn. The repo's one real overload control.
4. **`02-linear-scan-vs-ann-tradeoff.md`** — the O(n·d) in-memory cosine scan
   vs buffr's pgvector HNSW, behind one contract. The #1 bottleneck.
5. **`03-token-cost-accounting.md`** — per-call tokens → summed → priced in USD;
   provider-neutral, openai-only pricing, no aggregated baseline.
6. **`04-embedding-batching.md`** — the plural `embed(texts[])` contract: one
   HTTP round-trip per document.
7. **`05-build-time-inlining-zero-fetch.md`** — Studio's `?raw` markdown
   inlining and the 537 kB single-chunk bundle trade.
8. **`06-over-fetch-then-filter.md`** — fetching `topK*4` then pruning in JS to
   work around a predicate-free `VectorStore` contract.

## Pattern files at a glance

| File | Pattern | Load-bearing capability |
| --- | --- | --- |
| `01` | bounded loop cost ceiling | hard worst-case round-trip / cost bound + clean termination |
| `02` | linear scan vs ANN | swap exact O(n) scan for sub-linear HNSW with no rewrite |
| `03` | token cost accounting | provider-neutral USD-per-run reconstructed from the trace |
| `04` | embedding batching | 1 round-trip per doc instead of N |
| `05` | build-time inlining | serverless static deploy with zero runtime doc fetch |
| `06` | over-fetch then filter | filtered retrieval over a predicate-free contract |

## Partition — what this guide owns vs neighbors

```
  study-performance-engineering  MEASURES and improves bottlenecks (this guide)
  study-runtime-systems          explains the execution model (loop, event loop, cancel)
  study-database-systems         explains the storage engine (pgvector, HNSW, query exec)
  study-system-design            explains architecture-scale tradeoffs
```

A finding belongs to the generator that owns the mechanism. This guide
cross-links rather than re-teaches.

## Cross-links

- `study-runtime-systems` — the loop and event-loop mechanics behind `01`/`02`.
- `study-database-systems` — pgvector/HNSW and predicate push-down behind
  `02`/`06`.
- `study-ai-engineering` — RAG quality, embeddings, agentic retrieval.
- `study-frontend-engineering` — bundling/rendering/build behind `05`.
- `study-system-design` — the contract seams these costs hang on.
