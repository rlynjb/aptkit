# Performance Engineering — the audit

Pass 1 of the two-pass study (see `me.md` → AUDIT-STYLE GENERATORS). One `##` per lens. Each lens names what the repo actually does with `file:line` grounding, or emits `not yet exercised`. Significant patterns cross-link to a Pass-2 file.

The verdict up front, because it shapes every lens below:

```
  The honest state of performance in aptkit

  ┌──────────────────────────────────────────────────────────┐
  │  Nothing in this repo is MEASURED.                         │
  │                                                            │
  │  No budget is written down. No baseline is captured.       │
  │  No profiler is wired. No p95/p99 is computed.             │
  │  No cache exists. No limiter exists. No backpressure.      │
  │                                                            │
  │  What DOES exist: cost is ACCOUNTED (token ledger),        │
  │  worst-case work is BOUNDED (loop caps), and the           │
  │  expensive primitive (linear scan) is ISOLATED behind a    │
  │  contract so the fast one (pgvector HNSW) drops in.        │
  └──────────────────────────────────────────────────────────┘
```

So read this audit as: the repo has built the *seams* where performance will be controlled, and has wired the one piece of *cost telemetry* that matters (tokens), but has not yet pointed a single measurement at anything. That is the correct state for a from-scratch toolkit at this stage, and naming it honestly is the whole point.

---

## Lens 1 — performance-budget

`not yet exercised` as a written artifact. No latency budget, no cost ceiling, no bundle budget is declared anywhere in the repo. There is no `budget.json`, no CI threshold, no `chunkSizeWarningLimit` override in `apps/studio/vite.config.ts`, no asserted p-anything.

What stands in for a budget today is a set of **hard caps on worst-case work**, which bound cost without ever measuring it:

- The agent loop caps turns and tool calls: `maxTurns = 8`, `maxTokens = 4096` defaults in `packages/runtime/src/run-agent-loop.ts:87-88`; per-agent overrides like `maxTurns: 6, maxToolCalls: 4` in `packages/agents/recommendation/src/recommendation-agent.ts:86-87` and `packages/agents/rag-query/src/rag-query-agent.ts:75-76`.
- Tool results are clamped: `MAX_TOOL_RESULT_CHARS = 16_000` in `packages/runtime/src/run-agent-loop.ts:52`, truncated at line 54-57.
- Chunk windows are fixed: `CHUNK_SIZE = 512`, `CHUNK_OVERLAP = 64` in `packages/retrieval/src/chunker.ts:13-14`.

These are *ceilings*, not *budgets*. A budget says "p99 answer latency < 2s at 5 concurrent users"; a ceiling says "this loop cannot run more than 6 times." The repo has ceilings. → see `02-bounded-loop-cost-ceiling.md` for the deep walk.

The Vite default `chunkSizeWarningLimit` (500 kB) is the *only* budget-like threshold in the repo, and it is inherited, not chosen — the build emits the single JS chunk at 537,310 bytes (`apps/studio/dist/assets/index-*.js`), over the limit, and the warning is the closest thing to a defended number. → see `05-build-time-inlining-zero-fetch.md`.

## Lens 2 — measurement-baselines-and-profiling

`not yet exercised` for profiling. No profiler is wired (no `--prof`, no `clinic`, no `0x`, no flamegraph tooling, no `performance.now()` spans around hot code). No representative-workload harness exists for the retrieval path or the agent loop.

There is **one** real before/after evidence loop, but it measures *correctness*, not performance: the replay-artifact pipeline (`packages/evals`, `scripts/eval-replay-artifacts.mjs`). It records `durationMs` per replay artifact (`artifacts/replays/*.json` carry a `durationMs` key), so a wall-clock number *is* captured per run — but nothing asserts on it, trends it, or treats it as a baseline. It is a field, not a baseline.

The closest thing to instrumentation is the trace event stream — `model_usage` events emitted at `packages/runtime/src/run-agent-loop.ts:111-122`, and `tool_call_end` carrying `durationMs` at line 171-179. That telemetry exists and is summed (`summarizeUsage` in `packages/runtime/src/usage-ledger.ts:25-42`), but it is summed for *cost*, not for latency baselining. → see `03-token-cost-accounting.md`.

## Lens 3 — latency-throughput-and-tail-behavior

`not yet exercised`. No p50/p95/p99 is computed anywhere. No throughput target. No queue, no concurrency limiter, no contention analysis. `summarizeUsage` (`usage-ledger.ts:25`) sums tokens and counts turns; it does not touch latency distribution.

The one latency-shaped fact worth naming is structural, not measured: **every agent turn is a synchronous round-trip to the model** (`await model.complete(...)` at `run-agent-loop.ts:103`), and turns are strictly sequential inside the loop. So end-to-end latency is `Σ(turn latency)` with no overlap — a 6-turn recommendation run pays six serial model round-trips plus tool time. The cap on turns is therefore also the cap on tail latency. → see `02-bounded-loop-cost-ceiling.md`.

Throughput across concurrent agent runs is undefined: there is no shared limiter, no pool, no admission control in aptkit. Concurrency is whatever the host process spawns.

## Lens 4 — cpu-memory-and-allocation

The one CPU-bound hot path in the repo is the linear scan in `InMemoryVectorStore.search` (`packages/retrieval/src/in-memory-vector-store.ts:25-33`): it iterates every chunk computing cosine similarity (`cosineSimilarity`, line 46-57, a `d`-element loop, `d = 768`), pushes a hit object per chunk, then sorts the entire array before slicing `k`. That is O(n·d) for scoring plus O(n log n) for the full sort, allocating one `VectorHit` per stored chunk on every query. → see `01-linear-scan-vs-ann-tradeoff.md`.

Memory: the whole corpus lives in a `Map<string, VectorChunk>` (`in-memory-vector-store.ts:12`) — every chunk's 768-float vector resident in process heap. No eviction, no spill, no bound on corpus size. Fine for the demo corpus; it is exactly the thing `PgVectorStore` (buffr, `src/pg-vector-store.ts`) removes by pushing vectors into Postgres.

GC behavior is `not yet exercised` as an analysis — no allocation profiling has been done. The per-query `hits` array (one object per chunk) is the obvious allocation churn point if the corpus ever grew, but at demo scale it is noise.

## Lens 5 — io-network-and-database-bottlenecks

Three I/O surfaces, none measured:

1. **Model round-trips** — `model.complete()` over HTTP per turn (Anthropic/OpenAI SDKs, or local Ollama `:11434`). This is the dominant latency cost and is bounded only by `maxTurns`. No timeout is set on the call in `run-agent-loop.ts` beyond what the SDK defaults to; cancellation flows via `AbortSignal` (`signal` threaded at line 103-109).
2. **Embedding HTTP** — `OllamaEmbeddingProvider.embed` POSTs to `/api/embed` (`packages/retrieval/src/ollama-embedding-provider.ts:62-74`). The contract is **batch-shaped** (`embed(texts: string[])`, `contracts.ts:25`) and the index path sends the whole chunk array in one call (`pipeline.ts:40`), but the query/recall paths embed one string at a time (`pipeline.ts:56`, `conversation-memory.ts:76,90`). → see `04-embedding-batching.md`.
3. **Database (buffr only)** — `PgVectorStore.search` issues one cosine-distance query ordered by `embedding <=> $1` with `limit $3` (`buffr/src/pg-vector-store.ts:67-78`). The HNSW index exists (`buffr/sql/001_agents_schema.sql:28-29`, `using hnsw (embedding vector_cosine_ops)`) so the scan is sub-linear there — but the index is built with **default parameters** (no `m`, no `ef_construction`) and **no `hnsw.ef_search` is ever set**, so recall/latency at the index is untuned. The pool is created with bare defaults (`buffr/src/db.ts:4-6`, `new pg.Pool({ connectionString })`) — default max of 10 connections, no tuning. → see `01-linear-scan-vs-ann-tradeoff.md`.

A second database-shaped inefficiency: the **over-fetch-then-filter** pattern. Both `search_knowledge_base` (over-fetch `topK * 4` then post-filter, `search-knowledge-base-tool.ts:88-90`) and memory `recall` (`fetchK = max(k*4, 20)` then filter by `kind`, `conversation-memory.ts:94-95`) pull extra rows into the process and filter in JS because the `VectorStore` contract has no metadata predicate. Against `PgVectorStore` this means rows crossing the DB boundary that a `WHERE` clause should have dropped. → see `06-over-fetch-then-filter-cost.md`.

## Lens 6 — caching-batching-and-backpressure

**Caching: `not yet exercised`. Nothing is cached anywhere.** No memoized embeddings (the same query string re-embeds every call), no model-response cache, no LRU, no HTTP cache headers honored. The `FixtureModelProvider` replays recorded responses, but that is a *test* substitution, not a runtime cache.

**Batching: partial.** The embedding contract is batch-native and the index path uses it (`pipeline.ts:40` embeds all chunks in one call). The query and recall paths do not batch (one string per call) because they only ever have one query. → see `04-embedding-batching.md`.

**Backpressure / overload control: `not yet exercised`.** No limiter, no semaphore, no queue depth bound, no admission control, no debounce/throttle on any input. If a host fires 100 agent runs at once, 100 run at once. The only bound on *per-run* work is the loop ceiling (lens 1). → see `02-bounded-loop-cost-ceiling.md`.

## Lens 7 — rendering-client-and-mobile-performance

The Studio app (`apps/studio`, React 18 + Vite) ships as a **single 537 kB JS chunk** with no code-splitting and no lazy routes — the build emits one `index-*.js` over Vite's 500 kB warning line. The cause is deliberate: build-time inlining. Fixtures are imported as JSON (`import monitoringFixture from '../../packages/agents/.../fixtures/*.json'` in `vite.config.ts`) and docs are imported as raw strings (`import coreApiMarkdown from '../../../docs/core-api.md?raw'` in `apps/studio/src/main.tsx:12-13`). Everything the demo needs is baked into the bundle, so the deployed GitHub Pages site makes **zero runtime data fetches**. → see `05-build-time-inlining-zero-fetch.md`.

That is a real tradeoff, not an accident: larger first-load JS bought against zero network round-trips and a fully static host. For a fixture-only demo it is the right call; for a data-driven app it would not be.

No other client-perf work is exercised: no virtualization, no `React.memo`/`useMemo` hot-path optimization audited, no main-thread profiling, no mobile constraints (Studio is desktop-web).

## Lens 8 — performance-red-flags-audit

Ranked by consequence. Each names its evidence — a baseline (none exist) or the explicitly missing measurement.

```
  Risk ranking — by what breaks first as scale grows

  #1 ███████████  linear scan won't scale   (structural, unmeasured)
  #2 ████████     nothing is measured        (no baseline anywhere)
  #3 ██████       no caching = repeat cost    (every call recomputes)
  #4 █████        over-fetch crosses DB       (4× rows, post-filter)
  #5 ████         untuned HNSW ef (buffr)     (default params)
  #6 ███          537kB single chunk          (Vite warns, accepted)
  #7 ██           no backpressure             (unbounded concurrency)
```

1. **Linear scan in `InMemoryVectorStore.search` (`in-memory-vector-store.ts:25-33`).** O(n·d) + O(n log n) sort per query. Evidence: **none measured** — but structurally it is the first thing that falls over as the corpus grows. Mitigation already designed: the `VectorStore` contract isolates it, and `PgVectorStore` + HNSW (buffr) is the sub-linear drop-in. The risk is real only if someone runs the in-memory store in production. → `01-linear-scan-vs-ann-tradeoff.md`.

2. **Nothing is measured.** No budget, no baseline, no profiler, no p95. Evidence: the absence itself. Consequence: every other entry on this list is reasoned about structurally, not from data — you cannot say *which* is actually slow because nothing has been timed. This is the highest-leverage gap to close: capture one baseline (the `durationMs` already in replay artifacts is the seed) and the list reorders itself by fact instead of by inference.

3. **No caching anywhere.** Evidence: grep finds no cache. Consequence: identical queries re-embed and re-search every time; identical agent inputs re-run the full model loop. At demo scale, free; at any repeat-query load, pure waste.

4. **Over-fetch-then-filter crosses the DB boundary (`search-knowledge-base-tool.ts:88-90`, `conversation-memory.ts:94-95`).** Pulls `4×` rows then filters in JS because the contract has no metadata predicate. Evidence: structural, unmeasured. Against `PgVectorStore` a `WHERE meta->>'kind' = 'memory'` would push the filter into SQL. → `06-over-fetch-then-filter-cost.md`.

5. **Untuned HNSW (buffr `sql/001_agents_schema.sql:28-29`, `db.ts:4`).** Index built with default `m`/`ef_construction`; `hnsw.ef_search` never set; pool at default size. Evidence: unmeasured — recall and latency at the index are whatever pgvector's defaults give. → `01-linear-scan-vs-ann-tradeoff.md`.

6. **537 kB single Studio chunk (`apps/studio/dist/assets/index-*.js`).** Over Vite's 500 kB warning. Evidence: the build warning. Accepted tradeoff for zero-fetch static hosting. → `05-build-time-inlining-zero-fetch.md`.

7. **No backpressure (`run-agent-loop.ts`, no limiter).** Unbounded concurrent runs. Evidence: structural absence. Low consequence today (single-user demo, single-user buffr laptop runtime); becomes real the moment aptkit fronts a multi-user service.

---

### Cross-links

- Execution mechanics of the loop, event loop, cancellation → `study-runtime-systems`.
- The pgvector storage engine, HNSW internals, query planning → `study-database-systems`.
- Embedding models, RAG retrieval quality, eval scoring → `study-ai-engineering`.
- Studio rendering, bundle, build pipeline → `study-frontend-engineering`.
