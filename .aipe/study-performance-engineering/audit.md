# Performance Engineering — the audit (Pass 1)

The verdict first: **nothing in this repo is measured.** There are no
benchmarks, no profiler runs, no recorded baselines, no latency budgets
written down anywhere. What the repo *does* have is a set of performance
*decisions* baked into code — a linear vector scan, a bounded agent loop, a
batched embedder, a single-chunk Studio bundle — each of which has a real
performance shape you can reason about from the source even though no one has
put a stopwatch on it.

So this audit does two things at once. It walks the eight lenses and, for each,
separates **what the code actually decides** from **what is `not yet
exercised`** — the measurement that would turn a decision into evidence. The
honest framing throughout: this is a portfolio/extraction repo whose hot paths
are either local (Ollama on `:11434`) or deterministic (fixtures), so the cost
of *not* measuring has been low. That stops being true the moment buffr puts
`PgVectorStore` and a real corpus behind the same contracts.

```
  Where performance lives in aptkit — the surfaces this audit walks

  ┌─ Client (apps/studio) ──────────────────────────────────────┐
  │  React 18 + Vite SPA · single 537 kB JS chunk · markdown     │
  │  inlined at build via ?raw · zero runtime fetch on Pages     │
  └───────────────────────────┬──────────────────────────────────┘
                              │  (dev only) NDJSON replay stream
  ┌─ Runtime (packages/runtime) ─▼───────────────────────────────┐
  │  runAgentLoop — N model round-trips, bounded by maxTurns(8) / │
  │  maxToolCalls · forced synthesis turn · usage-ledger cost     │
  └───────────────────────────┬──────────────────────────────────┘
                              │  tool call: search_knowledge_base
  ┌─ Retrieval (packages/retrieval) ▼────────────────────────────┐
  │  embed(texts[]) batched · chunker 512/64 · InMemoryVectorStore│
  │  cosine O(n·d) scan + full sort · over-fetch(topK*4)+filter   │
  └───────────────────────────┬──────────────────────────────────┘
                              │  same VectorStore contract
  ┌─ Storage (buffr — out of repo) ▼─────────────────────────────┐
  │  PgVectorStore · pgvector · pg.Pool · HNSW index (untuned ef) │
  └───────────────────────────────────────────────────────────────┘

  the seam that matters: the VectorStore contract — linear scan on one
  side, approximate-NN index on the other; the perf profile flips here
```

The lenses below run in order; each names code with `file:line` or emits `not
yet exercised`.

---

## 1. performance-budget

**No budget is written down anywhere.** There is no p95 target, no "search
must return in X ms", no bundle-size ceiling, no token-per-answer cap declared
in code, config, or docs. That is the single most important finding of this
lens, and it's honest: you cannot defend a budget you never set.

What exists instead are **implicit ceilings** — limits that bound the worst
case without being framed as budgets:

- The agent loop's hard iteration cap: `maxTurns = 8` default
  (`packages/runtime/src/run-agent-loop.ts:87`), and the rag-query agent
  tightens it to `maxTurns: 6, maxToolCalls: 4`
  (`packages/agents/rag-query/src/rag-query-agent.ts:75-76`). This is a *cost
  ceiling* on model round-trips even though no one calls it that. → see
  `01-bounded-loop-cost-ceiling.md`.
- `maxTokens = 4096` per call (`run-agent-loop.ts:88`) and
  `MAX_TOOL_RESULT_CHARS = 16_000` truncation (`run-agent-loop.ts:52`) bound
  the per-turn output and the prompt growth from fat tool results.
- Vite's default 500 kB chunk-size warning is the only bundle "budget" — and
  the Studio bundle exceeds it at 537 kB (`apps/studio/dist/assets/`). The
  warning fires; nothing acts on it. → see `05-build-time-inlining-zero-fetch.md`.

The budget that *should* exist but doesn't: a retrieval latency target. The
in-memory scan is O(n·d) and will silently degrade as the corpus grows
(`packages/retrieval/src/in-memory-vector-store.ts:25-33`); without a declared
"search p95 < X ms at N chunks" there's no signal for when to graduate to the
pgvector path. → `not yet exercised`.

## 2. measurement-baselines-and-profiling

**`not yet exercised` — comprehensively.** No profiler has been run, no
benchmark harness exists, no representative-workload corpus is checked in, and
no before/after numbers are recorded anywhere in the repo.

The repo has the *raw materials* for measurement but never closes the loop into
a baseline:

- **Per-run timing exists** but is unaggregated. Every Studio replay records
  `durationMs: Date.now() - startedAt` (`apps/studio/vite.config.ts:533,
  570-571` and the other `run*Replay` functions). It's a wall-clock number per
  run, shown in the UI — never collected into a distribution, never compared
  across runs. One sample is not a baseline.
- **Token usage is summed** by `summarizeUsage`
  (`packages/runtime/src/usage-ledger.ts:25-42`) and `modelTurnCount`
  (`:45-47`), and `estimateCost` (`:50-68`) converts it to dollars. This is
  real cost instrumentation — but it's per-run accounting, not a tracked
  baseline with a target. → see `03-token-cost-accounting.md`.
- **Replay determinism is the closest thing to a benchmark fixture.**
  `FixtureModelProvider` replays recorded `ModelResponse[]` so a run is
  reproducible (`apps/studio/vite.config.ts:757`). That makes *correctness*
  measurable (evals) but not *performance* — fixtures short-circuit the model
  round-trip that dominates real latency.

What's missing: a `bench/` harness that indexes a known corpus and times
`search` at growing `n`; a profiler pass over the cosine loop; a recorded p50/p95
for a live (non-fixture) agent run. → `not yet exercised`.

## 3. latency-throughput-and-tail-behavior

No latency *distribution* has ever been captured, so p95/p99 are `not yet
exercised`. But the **dominant latency term is structurally obvious from the
code**: each turn of the agent loop is one `await model.complete(...)`
(`run-agent-loop.ts:103`), a network round-trip to a model. Latency ≈
(turns) × (per-call model latency) + (tool time). The loop is sequential — no
turn overlaps the next — so total latency is the *sum* of round-trips, and the
worst case is bounded by `maxTurns` / `maxToolCalls`. → see
`01-bounded-loop-cost-ceiling.md`.

The **forced synthesis turn** is the tail-shaping mechanic worth naming: on the
last allowed turn the loop drops the tools array and appends a synthesis
instruction (`run-agent-loop.ts:101-109`, `buildSynthesisInstruction:72-74`),
guaranteeing the run terminates with an answer instead of looping or hanging.
That's tail-*latency* control by construction — the run can't run away.

Throughput, queues, contention, concurrency limits: **all `not yet
exercised`.** Nothing batches concurrent agent runs, nothing queues them,
nothing limits in-flight requests. Studio handles one replay at a time per HTTP
request; there is no fan-in to contend over. The one place tool calls *could*
parallelize — multiple `tool_use` blocks in a single response — runs them
sequentially in a `for` loop (`run-agent-loop.ts:139-187`), an accepted cost
because the local providers return one tool call at a time.

## 4. cpu-memory-and-allocation

The one CPU-bound hot path in the repo is the **cosine scan**. For each query,
`InMemoryVectorStore.search` iterates every stored chunk, computing a full
768-dimensional dot product and two magnitudes per chunk
(`in-memory-vector-store.ts:25-33`, `cosineSimilarity:46-57`), then sorts the
*entire* hit array before slicing top-k (`:31-32`). That's O(n·d) compute plus
O(n log n) sort, synchronous, inside an `async` signature — the event loop is
blocked for the whole scan. → see `02-linear-scan-vs-ann-tradeoff.md`.

Memory:

- The store holds every chunk in a `Map<string, VectorChunk>`
  (`in-memory-vector-store.ts:12`); the corpus lives entirely in process heap.
  At 768 floats × 8 bytes ≈ 6 kB per vector before object overhead, this is
  fine for the demo corpus and unbounded for a real one. No eviction, no cap.
- `search` allocates a fresh `hits` array sized to the whole corpus on every
  query (`:27-30`), then a sorted copy via `.sort` in place, then a sliced
  copy. Three passes over n for one query.
- The agent loop accumulates the full message history in `messages`
  (`run-agent-loop.ts:94, 124, 189`) — every turn's assistant content and tool
  results are retained for the next `complete` call. Bounded by `maxTurns`, so
  it can't grow unboundedly, but the prompt grows linearly with turns and each
  tool result is capped at 16 kB.

GC behavior, heap profiling, allocation rate under load: **`not yet
exercised`.**

## 5. io-network-and-database-bottlenecks

The real I/O bottlenecks live at two seams, and the repo has thought about one
of them in code:

- **Embedding calls** go to Ollama's `/api/embed` over local HTTP
  (`packages/retrieval/src/ollama-embedding-provider.ts:62-74`). The pipeline
  **batches** — `indexDocument` chunks a doc then calls `embedder.embed(texts)`
  with the *whole* chunk array in one request (`pipeline.ts:37-40`), so a
  20-chunk document is one HTTP round-trip, not 20. → see
  `04-embedding-batching.md`.
- **Model calls** go to a provider (`run-agent-loop.ts:103`). Local Gemma is
  one local HTTP call per turn (`gemma-provider.ts:69-74`); cloud providers are
  network round-trips. Gemma's emulated tool-calling can cost an *extra* round
  trip — on a botched JSON tool call it retries with a corrective nudge, up to
  `maxToolCallAttempts` (default 2) (`gemma-provider.ts:62-89`). That's an I/O
  amplification specific to the toolless local model.
- **The database bottleneck is out of repo, in buffr.** `PgVectorStore.search`
  runs an `order by embedding <=> $1 limit $3` cosine-distance query against
  `agents.chunks` through a `pg.Pool` (`buffr/src/pg-vector-store.ts:67-85`).
  This is where the linear scan becomes a sub-linear index lookup — *if* an
  HNSW index exists and its `ef_search` is tuned. The repo wires the pool but
  **the HNSW `ef` parameter is untuned / not set in this code** — `not yet
  exercised`. `upsert` wraps every chunk insert in a single transaction
  (`buffr/src/pg-vector-store.ts:40-65`), which is correct but serializes the
  writes.

Filesystem I/O: Studio reads replay artifacts and fixtures from disk per
request (`vite.config.ts:939-985`, `listPromoted*`), re-reading and re-running
every promoted fixture on each summary request — wasteful but dev-only and
small-N.

## 6. caching-batching-and-backpressure

**Batching: yes, in one place.** The embedder batches a document's chunks into
one call (`pipeline.ts:37-40`) — the load-bearing I/O optimization in the
retrieval path. → see `04-embedding-batching.md`.

**Caching: nowhere.** There is no cache layer anywhere in the repo. No
embedding cache (re-indexing the same doc re-embeds from scratch), no query-result
cache (the same query re-scans the whole corpus every time), no memoized model
responses outside the fixture-replay mechanism, no HTTP caching headers except
`cache-control: no-cache` on the NDJSON stream (`vite.config.ts:902`). Every
repeated operation pays full freight. → `not yet exercised` as a *measured*
gap; named here as a deliberate omission for a repo whose hot path is local.

**Backpressure / overload control: nowhere.** No concurrency limiter, no queue,
no rate limiter, no semaphore bounding in-flight model or embed calls. If two
agent runs fire at once, both hit Ollama concurrently with nothing between them
and the local model. The *only* bounded-work mechanism in the repo is the agent
loop's iteration cap (→ `01-bounded-loop-cost-ceiling.md`) — that bounds depth,
not concurrency.

**The over-fetch-then-filter pattern** is the one place batching/caching
thinking shows a cost smell. The `search_knowledge_base` tool, when given a
metadata filter, fetches `topK * 4` hits then post-filters in JS
(`search-knowledge-base-tool.ts:88-90`); `recall` in memory does the same with
`Math.max(k * 4, 20)` (`packages/memory/src/conversation-memory.ts:94-96`).
Both compensate for the `VectorStore` contract having no metadata predicate by
over-fetching — wasteful versus a SQL `where` clause, and the cost grows with
the filter's selectivity. → see `06-over-fetch-then-filter.md`.

## 7. rendering-client-and-mobile-performance

The client is `apps/studio`, a React 18 + Vite SPA. The findings:

- **The bundle is one 537 kB JS chunk** (`apps/studio/dist/assets/index-*.js`),
  past Vite's 500 kB warning threshold. There is **no code-splitting**: no
  `manualChunks`, no dynamic `import()`, no route-level lazy loading — every
  workspace (Recommendation, Monitoring, Diagnostic, Query, Rubric, RAG, Docs)
  ships in the initial download. `react-markdown` + `remark-gfm` +
  `github-slugger` + `lucide-react` all land up front. → see
  `05-build-time-inlining-zero-fetch.md`.
- **Markdown is inlined at build time** via Vite `?raw` imports
  (`apps/studio/src/main.tsx:12-13`, plus the doc pages), so the docs pages do
  **zero runtime fetch** — the trade is a fatter bundle for a fetch-free static
  GitHub Pages deploy. This is a genuine, deliberate perf decision worth a
  pattern file. → `05-build-time-inlining-zero-fetch.md`.
- **No measured client metrics.** No Lighthouse run, no FCP/LCP/TTI numbers, no
  main-thread profiling. The in-browser RAG demo (`RagQueryWorkspace.tsx`) runs
  a fake embedder + `InMemoryVectorStore` + recorded responses entirely
  client-side — the cosine scan runs *on the main thread in the browser*, which
  is fine at demo-corpus size and would jank at scale. → `not yet exercised`.

Mobile: aptkit ships no mobile client (buffr/contrl do, out of repo). `not yet
exercised` here.

## 8. performance-red-flags-audit

Ranked by consequence — the cost each carries and the evidence (or the missing
measurement) behind the verdict.

```
  Red flags, ranked — consequence vs evidence

  rank  flag                              evidence          when it bites
  ────  ────────────────────────────────  ────────────────  ──────────────
   1    O(n·d) linear scan + full sort     code, unmeasured  corpus grows;
        in InMemoryVectorStore.search                        prod = pgvector
   2    No budgets / baselines / profiling absent entirely   you can't tell
        anywhere in the repo                                 if #1 bit yet
   3    Single 537 kB bundle, no splitting dist artifact      cold load on
                                                             slow networks
   4    No caching layer anywhere          absent entirely   repeated work
                                                             pays full cost
   5    Over-fetch (topK*4) then JS filter code, unmeasured  selective
        vs a SQL where clause                                filters, big n
   6    No backpressure / concurrency cap  absent entirely   concurrent runs
                                                             hammer Ollama
   7    HNSW ef untuned in PgVectorStore   buffr, unset      recall/latency
                                                             tradeoff blind
```

1. **O(n·d) linear cosine scan + full sort** — `in-memory-vector-store.ts:25-33`.
   The single clearest CPU bottleneck. Honest mitigant: it's the *demo* adapter;
   production is buffr's `PgVectorStore` HNSW path behind the same contract.
   The red flag is that nothing *measures* the crossover point where it starts
   hurting. → `02-linear-scan-vs-ann-tradeoff.md`. Evidence: code; **no
   baseline**.

2. **No budgets, baselines, or profiling at all** — the meta-red-flag. Every
   other finding here is reasoned from code, not measured, because the
   measurement infrastructure doesn't exist. This is the first thing to fix:
   you can't manage what you don't measure. Evidence: **absent**.

3. **Single 537 kB bundle, no code-splitting** — `apps/studio/dist/assets/`,
   `vite.config.ts` (no `build.rollupOptions.output.manualChunks`). Past Vite's
   own warning. Mitigant: it's a dev/demo Studio, not a customer-facing app, and
   the build-time inlining buys a zero-fetch static deploy. → `05-...`. Evidence:
   dist artifact size; **no client metrics**.

4. **No caching layer** — repeated embeds re-embed, repeated queries re-scan.
   Accepted because the hot path is local and cheap today; a real cost the
   moment embeds hit a paid API or the corpus grows. Evidence: **absent**.

5. **Over-fetch-then-filter** — `search-knowledge-base-tool.ts:88-90`,
   `conversation-memory.ts:94-96`. A contract limitation (no metadata predicate)
   paid for with 4× fetch + client-side filter. → `06-...`. Evidence: code;
   **unmeasured** waste.

6. **No backpressure / concurrency control** — nothing bounds concurrent calls
   to the local model or embedder. Evidence: **absent**.

7. **HNSW `ef_search` untuned** — `buffr/src/pg-vector-store.ts` sets up the
   query but never sets `ef_search`; the recall-vs-latency knob is left at
   default, blind. Out of repo, named for completeness. Evidence: **unset**.
