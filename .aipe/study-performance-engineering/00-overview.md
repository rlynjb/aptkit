# Performance Engineering — Overview

## The one thing to internalize

**AptKit's performance model is tokens-and-turns, not CPU-and-memory.**
This is a TypeScript monorepo wrapping LLM agents. The hot path is a
sequence of HTTP calls to Anthropic or OpenAI — each costing hundreds of
milliseconds to seconds and billed per token. The local JavaScript work
(agent loop, JSON parsing, NDJSON encoding, schema rendering) is
microseconds-to-low-milliseconds and is not the bottleneck. So every perf
control in this repo is about **bounding model work**: how many billed
round-trips a run can make, how big each one is, and what each one costs.

```
  The repo's performance map — where time and money live

  ┌─ JS process (AptKit) ──────────────────────────────────────┐
  │  bounded agent loop · bounded JSON scan · NDJSON encode      │
  │  → microseconds–low ms · NOT the cost                        │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ the network hop = the cost
  ┌─ Provider (Anthropic default / OpenAI) ─▼───────────────────┐
  │  model inference → 100s ms – seconds PER TURN · billed/token │
  └──────────────────────────────────────────────────────────────┘

  perf work = (1) cap the number of hops  (turn budget)
              (2) cap the size of each hop (context guard, truncation)
              (3) measure the spend        (cost ledger)
              (4) skip hops entirely        (fixtures, dev/eval)
              (5) hide the latency you can't cut (streaming)
              (6) amortize the hops you keep (embed batching)
```

The RAG retrieval pipeline (`@aptkit/retrieval`) adds a second, cheaper
class of work *below* the model hop — an embedding round-trip (batched) and
an O(n·d) in-memory vector scan. Neither dethrones the model turn as the
dominant cost; both are sub-millisecond-to-low-ms at the corpus sizes the
repo runs. With a *local* Gemma model the turn is slower still — one
observed `ask.ts` tool-call turn took ~7s (an anecdote, not a benchmark).

If you read nothing else, read **01-turn-and-tool-budget.md** — the hard
turn/tool ceiling is the load-bearing control that makes a run's worst-case
cost a number you can write down before it starts.

## Ranked findings

1. **The turn-and-tool budget is the load-bearing perf control.** Every
   agent caps `maxTurns` and `maxToolCalls`, and the loop forces a final
   answer on the last turn by stripping the tools from the request
   (`run-agent-loop.ts:98-109`; e.g. `recommendation-agent.ts:86-87`). This
   bounds both the bill and the latency tail. → **01**

2. **Cost is measured but blind at the default provider.** A token/cost
   ledger folds per-turn usage into a row and prices it
   (`usage-ledger.ts:25-86`) — but `pricingForModel` only knows OpenAI
   `gpt-4.1-*`, so the default `claude-sonnet-4-6` run reports real tokens
   yet prints cost as `n/a` (`usage-ledger.ts:71-77`). The instrument has a
   hole exactly where it's used most. → **02**, and red flag #2 in audit.

3. **A pre-flight guard rejects doomed calls before paying for them** —
   estimating input tokens and throwing if the prompt won't fit
   (`context-window-guard.ts:57-71`). The estimate is a deliberately crude
   `length/3` heuristic (`:100-103`) — a guard rail, not a precise meter.
   → **03**, red flag #3.

4. **Fixtures are a zero-cost dev/eval path — and explicitly NOT a cache.**
   `FixtureModelProvider` replays recorded responses for $0 and ~ms
   (`fixture-provider.ts:11-17`), swapped in instead of live mode. The repo
   has no runtime model-response cache at all — the single biggest unclaimed
   cost lever. → **04**, red flag #1.

5. **Streaming hides latency it can't cut.** NDJSON trace events are flushed
   to the client live (`vite.config.ts:887-918`), dropping time-to-first-
   feedback from end-of-run to the first event. Total time is unchanged. → **05**

6. **Bounded JSON extraction avoids unbounded parse work** — a fixed
   three-rung ladder ending in a throw (`json-output.ts:7-28`). → **06**

7. **The RAG vector search is an O(n·d) linear scan — the exact-search
   baseline.** `InMemoryVectorStore.search` scores every stored chunk on
   every query and sorts all n (`in-memory-vector-store.ts:25-33`).
   Sub-millisecond at the 3–6 doc corpora the repo runs; a wall at large n,
   where buffr's HNSW-indexed `PgVectorStore` (same `VectorStore` contract)
   takes over. Ship the cheap exact version, earn the index later. → **07**

8. **Embedding calls are batched; the model-controlled top-k is floored.**
   `embed(texts[])` POSTs a whole document's chunks in one round-trip
   (`ollama-embedding-provider.ts:50-74`). The `minTopK` floor clamps a
   model's `top_k` up — a live fix for Gemma self-selecting `top_k: 1` and
   starving a multi-part question (`search-knowledge-base-tool.ts:51,80-81`).
   A local Gemma tool-call turn was observed at ~7s once — an anecdote, not
   a benchmark; the model turn dominates wall-clock. → **08**

## `not yet exercised` lenses (and when each starts to matter)

- **Model-response caching (prompt cache / response cache)** — none. The
  highest-leverage missing control; matters now for any repeated prompt.
- **Latency SLO + p95/p99 percentile tracking** — none; only per-run
  `durationMs`. Matters when this serves a real request path with users
  waiting.
- **CPU/memory profiling, flamegraphs, benchmarking harness** — none, and
  correctly so: there's no CPU-bound hot path to profile.
- **Model request batching** — none; each turn is one `complete()`. (Note:
  *embedding* requests ARE batched — `embed(texts[])` — see finding 8.)
  Matters with high throughput or provider batch APIs.
- **Indexed / ANN vector search** — none here; the in-memory store is a flat
  O(n·d) scan. Matters at large corpus size; the HNSW-indexed `PgVectorStore`
  in buffr is the proven drop-in behind the same contract. → **07**
- **Embedding-call cost metering** — the embed path emits no usage event.
  Moot while embeddings are local ($0); matters the moment a paid embedder
  is wired.
- **Real backpressure / overload control** (queue, rate limiter,
  concurrency cap) — none. The fallback chain is failure-handling, not
  backpressure. Matters the moment concurrent runs share a provider rate
  limit.
- **Bundle-size budget, code-splitting, Web-Vitals** — none; Studio is a
  small dev-preview React app. Matters if Studio becomes a shipped product.

## Reading order

1. **audit.md** — the 8-lens walk; start here for the full picture.
2. **01-turn-and-tool-budget.md** — the load-bearing control.
3. **02-token-cost-ledger.md** — measuring the spend (and its gap).
4. **03-context-window-preflight-guard.md** — failing fast on doomed calls.
5. **04-fixture-replay-as-zero-cost-path.md** — the $0 dev/eval path.
6. **05-streaming-for-perceived-latency.md** — hiding latency.
7. **06-bounded-json-scan.md** — bounded recovery work.
8. **07-linear-vector-scan.md** — the O(n·d) RAG search baseline vs HNSW.
9. **08-embedding-batch-and-topk-floor.md** — embed batching + the top-k floor.

## Cross-links

- **study-runtime-systems** — the *mechanism* of bounded work and
  cancellation (the loop, `AbortSignal`); this guide owns the *budget*.
- **study-debugging-observability** — the `model_usage`/`CapabilityEvent`
  trace as observability; this guide reads it as the cost/latency instrument.
- **study-ai-engineering** — cost-of-serving, provider economics, and RAG
  retrieval quality at the system level; this guide owns per-run measurement
  and reads precision@k/recall@k as a perf baseline instrument.
- **study-distributed-systems** — the provider-hop latency and fallback
  chain; this guide owns the pre-flight guard that avoids the doomed hop.
- **study-database-systems** — pgvector + HNSW index mechanics (in buffr)
  that the in-memory linear scan is the exact-search baseline for.

## Background contrast — Rein's other perf work

You've built a real-time frame-budget pipeline before — **contrl**
(MediaPipe + Vision Camera on-device, pose-landmark → rep counter). That
system is the *opposite* performance shape: CPU/latency-bound, a hard
per-frame budget in the hot path, no network. AptKit is token/cost-bound,
with the network hop *as* the hot path. Same instinct — bound the work,
measure against a budget — pointed at a different bottleneck. Worth holding
both in mind: "budget" means frame-time in contrl and billed round-trips
here.
