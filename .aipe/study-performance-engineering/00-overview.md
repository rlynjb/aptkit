# Performance Engineering — overview

The verdict up front: **aptkit makes good performance *decisions* and has done
zero performance *measurement*.** There are no budgets, no baselines, no
profiler runs, no recorded latencies anywhere in the repo. What it has is a set
of cost-shaping choices baked into code — a bounded agent loop, a batched
embedder, a vendor-neutral vector contract, a build-time-inlined Studio bundle —
each with a performance shape you can reason about from the source. This guide
walks those decisions, names what each costs, and is honest everywhere about
what is `not yet exercised`: measured, profiled, or budgeted.

## The map — where performance lives

```
  Performance surfaces, top to bottom

  ┌─ Client (apps/studio) ──────────────────────────────────────┐
  │  537 kB single JS chunk, no code-splitting · markdown inlined│
  │  at build via ?raw → zero runtime fetch on GitHub Pages      │  → 05
  └───────────────────────────┬──────────────────────────────────┘
                              │ agent run = N model round-trips
  ┌─ Runtime (packages/runtime) ▼────────────────────────────────┐
  │  runAgentLoop: maxTurns/maxToolCalls cap + forced synthesis   │  → 01
  │  usage-ledger: per-call tokens → sum → USD (openai-only price)│  → 03
  └───────────────────────────┬──────────────────────────────────┘
                              │ tool call: search_knowledge_base
  ┌─ Retrieval (packages/retrieval) ▼────────────────────────────┐
  │  embed(texts[]) batched: 1 call/doc · chunker 512/64          │  → 04
  │  InMemoryVectorStore: O(n·d) scan + full sort, sync           │  → 02
  │  over-fetch(topK*4)+JS filter (no metadata predicate)         │  → 06
  └───────────────────────────┬──────────────────────────────────┘
                              │ same VectorStore contract
  ┌─ Storage (buffr, out of repo) ▼──────────────────────────────┐
  │  PgVectorStore: pgvector HNSW · pg.Pool · ef_search UNSET     │  → 02
  └───────────────────────────────────────────────────────────────┘
```

## Ranked findings

1. **The O(n·d) linear cosine scan + full sort is the clearest bottleneck**
   (`packages/retrieval/src/in-memory-vector-store.ts:25-33`) — and it's
   synchronous inside an `async` signature, so it blocks the event loop for the
   whole scan. The mitigant is real: it's the zero-cloud *demo* adapter, and
   production swaps in buffr's pgvector HNSW path behind the identical
   `VectorStore` contract. The red flag is that nobody has measured the corpus
   size where the scan starts hurting. → `02-linear-scan-vs-ann-tradeoff.md`.

2. **Nothing is measured — no budgets, baselines, or profiling.** This is the
   meta-finding: every other entry here is reasoned from code, not a stopwatch,
   because the measurement infrastructure doesn't exist. Per-run `durationMs`
   and token counts are recorded but never aggregated into a baseline or
   compared against a target. You can't manage what you don't measure; this is
   the first gap to close. → `audit.md` lens 2, `03-token-cost-accounting.md`.

3. **The bounded agent loop is the repo's one real overload-control mechanism**
   (`packages/runtime/src/run-agent-loop.ts:98-135`) — a hard `maxTurns` /
   `maxToolCalls` ceiling plus a forced synthesis turn that strips the tools
   array so the run terminates with an answer instead of looping. It bounds
   *depth* (and thus per-run cost), not *concurrency* — there's no backpressure
   or concurrency limiter anywhere. → `01-bounded-loop-cost-ceiling.md`.

Below the top three, the audit ranks: the 537 kB un-split Studio bundle (#3 in
the red-flag table), no caching layer anywhere (#4), over-fetch-then-filter
waste (#5), no backpressure (#6), and buffr's untuned HNSW `ef_search` (#7).

## `not yet exercised` — the honest gaps

- **Budgets** — no p95 target, no bundle ceiling, no per-answer token/cost cap
  written anywhere. The agent-loop caps are *implicit* ceilings, never declared
  as budgets.
- **Baselines & profiling** — no benchmark harness, no profiler run, no
  representative-workload corpus, no before/after numbers. `durationMs` is one
  sample per run, not a distribution.
- **Latency tail** — p95/p99 never captured. The dominant term (model
  round-trips) is structurally obvious but never timed.
- **Throughput / concurrency / backpressure** — nothing batches, queues, or
  limits concurrent runs; no contention to measure because nothing fans in.
- **Caching** — no embedding cache, no query-result cache, no response cache.
  Every repeat pays full freight.
- **Client metrics** — no Lighthouse, no FCP/LCP/TTI, no main-thread profile of
  the in-browser cosine scan.
- **HNSW tuning** — buffr's `PgVectorStore` never sets `ef_search`; the
  recall/latency knob sits at default, blind.

## Reading order

1. `audit.md` — the 8-lens walk; start here for the full picture.
2. `01-bounded-loop-cost-ceiling.md` — the loop's cost ceiling (most
   load-bearing mechanism).
3. `02-linear-scan-vs-ann-tradeoff.md` — the #1 bottleneck and its contract-based
   fix.
4. `03-token-cost-accounting.md` — how runs turn into dollars.
5. `04-embedding-batching.md` — the one real I/O optimization.
6. `05-build-time-inlining-zero-fetch.md` — the Studio bundle trade.
7. `06-over-fetch-then-filter.md` — the cost of a predicate-free contract.

## Cross-links

- **`study-runtime-systems`** — the loop's execution model, cancellation, the
  blocked-event-loop mechanics this guide *measures*.
- **`study-database-systems`** — how pgvector/HNSW serves the sub-linear search
  and where predicates get pushed down.
- **`study-ai-engineering`** — RAG retrieval quality (precision@k), embedding
  choices, the agentic retrieval loop.
- **`study-frontend-engineering`** — Studio bundling, rendering, and build that
  `05-` touches.
- **`study-system-design`** — the architecture-scale tradeoffs behind the
  contract seams this guide costs out.
