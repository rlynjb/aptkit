# Performance Engineering — Audit (Pass 1)

The one rule that reframes this whole audit: **AptKit's dominant
cost and latency is the model round-trip, not CPU or memory.** This
is a TypeScript monorepo that wraps LLM agents. The hot path is not a
tight loop you profile with a flamegraph — it's a sequence of HTTP
calls to Anthropic or OpenAI, each one taking hundreds of milliseconds
to several seconds and each one billed per token. Everything the repo
does to "go faster" or "cost less" is really about **bounding the
number of model turns and the tokens per turn.**

So when you read "performance budget" below, don't think CPU cycles.
Think: how many billed round-trips can one agent run fire off, and
how big is each one?

```
  Where the time and money actually go

  ┌─ JS process (AptKit) ──────────────────────────────┐
  │  agent loop, JSON parse, NDJSON encode, schema      │
  │  render  →  microseconds to low-ms, NOT the cost    │
  └───────────────────────────┬─────────────────────────┘
                              │  network hop (the cost)
  ┌─ Provider (Anthropic / OpenAI) ─▼───────────────────┐
  │  model inference  →  100s of ms – seconds PER TURN  │
  │  billed per input + output token                    │
  └──────────────────────────────────────────────────────┘

  perf work here = bound the number of these hops + the tokens each one carries
```

The lenses below are walked in order. Where a lens finds nothing, it
says `not yet exercised` and names when it would start to matter.

---

## 1. performance-budget

**The budget is expressed as a hard turn-and-tool-call ceiling per
agent, not as a latency SLO.** Every agent passes `maxTurns` and
`maxToolCalls` into `runAgentLoop`:

- `packages/agents/recommendation/src/recommendation-agent.ts:86-87` — `maxTurns: 6`, `maxToolCalls: 4`
- `packages/agents/anomaly-monitoring/src/monitoring-agent.ts:76-77` — `maxTurns: 8`, `maxToolCalls: 6`
- `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:73-74` — `maxTurns: 8`, `maxToolCalls: 6`
- `packages/agents/query/src/query-agent.ts:94-95` — `maxTurns: 8`, `maxToolCalls: 6`
- `packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:75-76` — `maxTurns: 6`, `maxToolCalls: 3`

`runAgentLoop` defaults to `maxTurns = 8` and `maxTokens = 4096`
(`packages/runtime/src/run-agent-loop.ts:87-89`). The loop counts each
iteration and stops at the ceiling (`run-agent-loop.ts:98-101`). Because
each turn is at most one billed model call, the ceiling is a literal
upper bound on the bill and on wall-clock time for a run: a
recommendation run can cost **at most 6 model round-trips**, no matter
what the model decides to do.

The per-turn output budget is `maxTokens` (default 4096; the recovery
turn drops to 2048 — `run-agent-loop.ts:213`). Tool results fed back
into context are truncated at `MAX_TOOL_RESULT_CHARS = 16_000`
(`run-agent-loop.ts:52-57`), which bounds how much a fat tool result
can inflate the next turn's input tokens.

→ This is the load-bearing performance control. See **01-turn-and-tool-budget.md**.

A user-visible *latency* budget (p95 < N ms) is **not yet exercised** —
there is no SLO defined anywhere. The budget that exists is a *work*
budget (turns), which is the right first move for an LLM system because
turns dominate latency. A latency SLO becomes relevant once this ships
behind a request path with real users waiting.

## 2. measurement-baselines-and-profiling

**Measurement is real and structured; profiling is not.** Every model
turn emits a `model_usage` trace event carrying `inputTokens`,
`outputTokens`, and an `estimated` flag (`run-agent-loop.ts:111-122`).
`summarizeUsage` folds those events into one ledger row — total tokens,
turn count, whether any figure was estimated
(`packages/runtime/src/usage-ledger.ts:25-42`). `estimateCost` turns
tokens into USD using `pricingForModel` (`usage-ledger.ts:50-78`).

The replay runner stamps every run with `modelTurns` and `durationMs`
(`packages/evals/src/replay-runner.ts` summary fields; e.g.
`apps/studio/vite.config.ts:568-570`), and the Studio replay list
surfaces `usage` + `costEstimate` per artifact
(`vite.config.ts:954-979`). So you get a **before/after instrument**:
run a fixture, read tokens/turns/cost; change a prompt, run again,
compare.

→ Cost measurement is significant enough for its own file: **02-token-cost-ledger.md**.

CPU/memory profiling, flamegraphs, and a benchmarking harness are
**not yet exercised** — and correctly so. There is no CPU-bound hot
path to profile. The thing worth measuring (tokens, turns, cost) *is*
measured. A profiler becomes relevant only if a non-model code path
(say, a large NDJSON decode or schema render over a huge workspace)
ever shows up as slow — nothing suggests it does today.

## 3. latency-throughput-and-tail-behavior

**The tail is capped structurally, not measured statistically.** The
worst case for a single run is bounded two ways:

- **Turn ceiling** caps the number of round-trips (lens 1).
- **Forced synthesis turn** caps the *tail* specifically. On the last
  allowed turn — or the moment the tool-call budget is spent — the loop
  strips the tools from the request and appends a synthesis instruction
  (`run-agent-loop.ts:101-109`, `buildSynthesisInstruction` at
  `run-agent-loop.ts:72-74`). With no tools offered, the model can only
  answer. That's what prevents a run from burning all its turns asking
  for "one more query" and returning nothing — the pathological
  worst-case latency-and-cost path.

p95/p99 latency distributions, queueing, and contention are **not yet
exercised**. There is no concurrency control over agent runs, no queue,
no percentile tracking. The repo runs one agent at a time in Studio or
a script. Throughput and tail *distribution* become relevant when many
runs execute concurrently behind a shared provider rate limit — at
which point the provider's rate limit, not local CPU, is the
bottleneck, and you'd need backpressure (lens 6).

→ The forced-synthesis tail cap is covered in **01-turn-and-tool-budget.md**.

## 4. cpu-memory-and-allocation

**Largely not the bottleneck — but two real bounded-work guards exist.**

There is no GC tuning, no allocation profiling, no memory-pressure
handling, because the workload doesn't generate any. The agent holds a
single `messages` array that grows by a few entries per turn and is
discarded when the run ends (`run-agent-loop.ts:94`). Bounded turns
means bounded message growth.

Two places do deliberately bound work to avoid unbounded CPU/allocation:

- **JSON extraction does a bounded substring scan**, not an unbounded
  parse-retry loop. `parseAgentJson` tries a fenced block, then one
  `JSON.parse`, then a single slice between the first `{`/`[` and the
  last `}`/`]` — one more parse, then it gives up
  (`packages/runtime/src/json-output.ts:7-28`). No backtracking, no
  regex catastrophe.
- **Tool results are truncated at 16k chars** before being stringified
  back into context (`run-agent-loop.ts:52-57`), bounding both the
  allocation and the downstream token cost.

→ The bounded JSON scan is a recognizable pattern: **05-bounded-json-scan.md**.

CPU/memory profiling under load is **not yet exercised** and won't
matter until a non-model path proves hot.

## 5. io-network-and-database-bottlenecks

**There is no database. The only I/O bottleneck is the provider network
hop — and there's a pre-flight guard for one class of it.** No SQL, no
ORM in the hot path; "data" is files and streams (replay artifacts,
fixtures, NDJSON).

The provider call is the I/O cost. One guard targets the *local*
provider specifically: `ContextWindowGuardedProvider` estimates the
request's input tokens *before* sending and throws
`ContextWindowExceededError` if the prompt won't fit the local context
window (`packages/providers/local/src/context-window-guard.ts:57-71`).
That's a **fail-fast**: instead of paying the latency of a round-trip
that's doomed to be truncated or rejected, it rejects locally in
microseconds and lets the fallback chain move to the next provider.

The token estimate is crude on purpose: `charsPerToken = 3`, i.e.
`Math.ceil(text.length / 3)` (`context-window-guard.ts:52, 91-103`).
That's a known imprecision — real BPE tokenization varies by content,
so the guard can be off by a meaningful margin and either reject a
prompt that would have fit or admit one that's slightly over. It's a
guard rail, not a precise meter. The move if precision matters: swap in
the provider's real token-counting endpoint behind the same interface.

→ Covered in **03-context-window-preflight-guard.md**.

Filesystem I/O (reading fixtures, listing replay artifacts in
`replay-runner.ts:31-44`) is sequential and unbounded in count, but
runs at dev/CI time over small directories, so it's not a bottleneck.
Connection pooling, retry/backoff timing, and request batching are
**not yet exercised** (see lens 6).

## 6. caching-batching-and-backpressure

**Be precise here: there is NO caching of model responses.** No prompt
cache, no response cache, no memoization of `model.complete()`. This is
the single biggest *unexercised* perf lever in the repo and it's worth
saying clearly so nobody mistakes the fixtures for a cache.

**Fixtures are test doubles, not a runtime cache.** `FixtureModelProvider`
replays a pre-recorded `ModelResponse[]` in order and throws when
exhausted (`packages/agents/recommendation/src/fixture-provider.ts:11-17`).
It is swapped in *for development and eval runs* to make them
deterministic and free — it is never consulted at runtime to avoid a
live call on a cache hit. The distinction matters: a cache is keyed by
request and serves live traffic; a fixture is a hardcoded script for a
known scenario. They look similar (both return a `ModelResponse`
without calling the provider) but serve opposite purposes.

That said, the fixture path is a genuine, large **cost/latency lever for
development**: a fixture run does zero model round-trips, costs $0, and
returns in milliseconds. The entire eval and Studio-preview workflow
rides on it.

→ Covered in **04-fixture-replay-as-zero-cost-path.md**.

**Batching** of provider requests: **not yet exercised**. Each turn is
one `complete()` call; there's no request coalescing or the providers'
batch APIs.

**Backpressure / overload control**: **not yet exercised** in the true
sense (no queue, no token-bucket rate limiter, no concurrency cap). The
fallback chain (`providerWithConfiguredFallback`,
`vite.config.ts:819-828`) is failure-handling, not backpressure — it
moves to the next provider on error, it doesn't shed or queue load. The
nearest thing to backpressure is the synthesis turn's *self-imposed*
work ceiling. Real backpressure becomes relevant the moment concurrent
runs share a provider rate limit.

**Debouncing/throttling**: **not yet exercised** — no user-input-driven
high-frequency calls exist (Studio runs are explicit button presses).

## 7. rendering-client-and-mobile-performance

**Minor and correctly treated as such.** `apps/studio` is a small React
18 + Vite app (`apps/studio/vite.config.ts`) — six workspace panels and
a capabilities gallery, all driven by explicit user actions. There's no
large list virtualization, no render-budget pressure, no main-thread
work worth profiling. Vite uses esbuild for dev transform and a Rollup
(rolldown-class) production build; the dist bundle is small.

The one rendering-adjacent perf win is **streaming**: the Studio API
streams NDJSON trace events to the client as the run progresses
(`vite.config.ts:887-918`, `streamReplayResponse`), so the user sees
steps and tool calls appear live instead of staring at a spinner until
the whole run finishes. That's a **perceived-latency** win — total time
is unchanged, but time-to-first-feedback drops to the first event.

→ Covered in **06-streaming-for-perceived-latency.md**.

A bundle-size budget, code-splitting, Lighthouse/Web-Vitals tracking,
and mobile constraints are **not yet exercised**. They'd matter if
Studio grew into a shipped product surface rather than a dev preview.

## 8. performance-red-flags-audit

Ranked by consequence. Each names the evidence — a defended bound or an
explicitly missing measurement.

**1. No model-response caching — the largest unclaimed cost lever.**
Evidence: no cache keyed on `ModelRequest` anywhere; `FixtureModelProvider`
is a test double, not a runtime cache (`fixture-provider.ts:11-17`).
Consequence: every live run pays full token cost even for identical or
near-identical prompts. For repeated workspace scans this is real money
left on the table. The move: a content-addressed prompt/response cache
behind the `ModelProvider` interface, or use the providers' native
prompt-caching (Anthropic prompt caching cuts input-token cost on the
stable system+tools prefix). This is the highest-leverage missing
control.

**2. Cost is unmeasurable for the default provider (Anthropic).**
Evidence: `pricingForModel` returns `undefined` for any provider that
isn't `'openai'` (`usage-ledger.ts:71-77`), and only `gpt-4.1-*` is
priced. Anthropic turns return real token usage (`estimated: false`,
`packages/providers/anthropic/src/...`) but `estimateCost` yields
`undefined`, so `formatCost` prints `'n/a'` (`usage-ledger.ts:81-86`).
Consequence: the repo's *default* model is `claude-sonnet-4-6` (project
context) and you cannot see what a run costs. The cost instrument has a
hole exactly where the default sits. The move: add Anthropic (and the
full OpenAI) price table to `pricingForModel`. Low effort, high signal.

**3. Token estimate is a length/3 heuristic.** Evidence:
`charsPerToken = 3`, `Math.ceil(text.length / 3)`
(`context-window-guard.ts:52, 100-103`). Consequence: the context-window
pre-flight guard can mis-judge a borderline prompt in either direction —
reject one that would fit, or admit one that's slightly over and eat a
truncation/rejection round-trip. Acceptable for a coarse local guard;
wrong if used as a precise budgeter. The move: use the provider's real
token-count endpoint when the margin is tight.

**4. No latency SLO and no percentile tracking.** Evidence: nothing
defines or records p95/p99; only per-run `durationMs` is stamped
(`replay-runner` summaries). Consequence: there is no way to detect a
latency regression or a slow-tail provider. Acceptable today (single
runs, no users waiting on a request path); becomes a gap the moment this
serves real traffic. The move: record per-turn durations and a run-level
percentile once there's a request path.

**5. No backpressure under concurrent fan-in.** Evidence: no queue, no
concurrency cap, no rate limiter (lens 6). Consequence: N concurrent
runs would hit the provider rate limit simultaneously and fail in a
thundering herd rather than queueing. Acceptable today (no concurrency);
the move is a bounded work queue + token-bucket limiter in front of the
provider when concurrency arrives.

---

### Cross-links

- **study-runtime-systems** — owns the *mechanism* of bounded work and
  cancellation (the loop, `AbortSignal`); this guide owns the *budget*
  those mechanisms enforce.
- **study-debugging-observability** — owns the `model_usage` /
  `CapabilityEvent` trace as an observability surface; this guide reads
  the same events as the *cost/latency instrument*.
- **study-ai-engineering** — owns the cost-of-serving and provider
  economics at the system level; this guide owns the per-run measurement.
- **study-distributed-systems** — owns the provider-hop latency and the
  fallback chain as a partial-failure concern; this guide owns the
  pre-flight guard that avoids paying for a doomed hop.
