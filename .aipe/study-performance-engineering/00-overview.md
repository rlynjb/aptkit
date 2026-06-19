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
```

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

## `not yet exercised` lenses (and when each starts to matter)

- **Model-response caching (prompt cache / response cache)** — none. The
  highest-leverage missing control; matters now for any repeated prompt.
- **Latency SLO + p95/p99 percentile tracking** — none; only per-run
  `durationMs`. Matters when this serves a real request path with users
  waiting.
- **CPU/memory profiling, flamegraphs, benchmarking harness** — none, and
  correctly so: there's no CPU-bound hot path to profile.
- **Request batching** — none; each turn is one `complete()`. Matters with
  high throughput or provider batch APIs.
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

## Cross-links

- **study-runtime-systems** — the *mechanism* of bounded work and
  cancellation (the loop, `AbortSignal`); this guide owns the *budget*.
- **study-debugging-observability** — the `model_usage`/`CapabilityEvent`
  trace as observability; this guide reads it as the cost/latency instrument.
- **study-ai-engineering** — cost-of-serving and provider economics at the
  system level; this guide owns per-run measurement.
- **study-distributed-systems** — the provider-hop latency and fallback
  chain; this guide owns the pre-flight guard that avoids the doomed hop.

## Background contrast — Rein's other perf work

You've built a real-time frame-budget pipeline before — **contrl**
(MediaPipe + Vision Camera on-device, pose-landmark → rep counter). That
system is the *opposite* performance shape: CPU/latency-bound, a hard
per-frame budget in the hot path, no network. AptKit is token/cost-bound,
with the network hop *as* the hot path. Same instinct — bound the work,
measure against a budget — pointed at a different bottleneck. Worth holding
both in mind: "budget" means frame-time in contrl and billed round-trips
here.
