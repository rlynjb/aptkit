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

**New since the last audit: a RAG retrieval pipeline (`@aptkit/retrieval`)
and a local Gemma provider.** This adds a second class of perf surface
*below* the model hop — embedding calls, a vector scan, chunking, and a
retrieval-depth knob — plus a local-inference latency story that's slower
per turn than a cloud call. None of it dethrones the model round-trip as
the dominant cost; it widens the picture. The two patterns worth a file:
the O(n·d) linear vector scan (**07**) and embedding batching + the top-k
floor (**08**).

**Also new: `@aptkit/memory`** (`packages/memory/src/conversation-memory.ts`)
— episodic memory built on the same `VectorStore`. It doesn't add a new cost
*class*; it *amplifies* the linear scan (lens 4) three ways: `recall`
over-fetches `max(k*4, 20)` rows then filters client-side because the
contract has no metadata filter; memory grows unbounded with no eviction;
and `remember` puts an embedding round-trip on the write path. The amplifier
gets its own file: **09**.

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

**Retrieval quality now has a real baseline instrument too.**
`scorePrecisionAtK` / `scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts:47-78`) score top-k retrieval
against a labeled set, and `packages/agents/rag-query/scripts/eval.ts` runs
them over a 6-doc corpus with real nomic embeddings — a "measure retrieval
in isolation, no model generation" number. That's the before/after
instrument for a chunking or top-k change: re-run the eval, compare P@1 and
R@k. It's a *quality* baseline, not a latency one.

CPU/memory profiling, flamegraphs, and a benchmarking harness are
**not yet exercised** — and correctly so. There is no CPU-bound hot
path to profile. The one new candidate is the in-memory vector scan
(lens 4), but at the corpus sizes the repo exercises (3–6 docs) it's
sub-millisecond. The thing worth measuring (tokens, turns, cost,
retrieval P@k) *is* measured. A profiler becomes relevant only if a
non-model code path (a large NDJSON decode, schema render over a huge
workspace, or a vector scan over a large corpus) ever shows up as slow —
nothing suggests it does today.

A single live observation worth recording, *not* a benchmark: in one
observed `ask.ts` run a local Gemma tool-call turn took roughly 7 seconds.
Treat it as an anecdote about local-inference latency on one machine — no
harness, no percentile, no repeated sampling. It's the reminder that the
*model turn* dominates wall-clock here even harder for a local model than a
cloud one (the embed call and the scan over a 3-doc corpus are sub-ms next
to a multi-second local turn). → see **08-embedding-batch-and-topk-floor.md**.

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

→ The bounded JSON scan is a recognizable pattern: **06-bounded-json-scan.md**.

**The one new CPU-shaped path: the vector scan.**
`InMemoryVectorStore.search` does an O(n·d) cosine pass over *every* stored
chunk on *every* query, then a full O(n log n) sort
(`packages/retrieval/src/in-memory-vector-store.ts:25-33`). At n = 3–6 docs
(the corpora in `ask.ts` / `eval.ts`) this is ~tens of thousands of
multiply-adds — sub-millisecond, invisible next to the embed call and the
model turn. It's the exact-search *baseline*; it becomes the bottleneck at
large n, where buffr's HNSW-indexed `PgVectorStore` (same `VectorStore`
contract) replaces it with a sub-linear ANN walk.

→ The linear scan and its HNSW contrast get a file: **07-linear-vector-scan.md**.

**Episodic memory amplifies that same scan.** `@aptkit/memory`'s `recall`
runs the store's `search` with `fetchK = Math.max(k * 4, 20)` and then
filters the hits to `meta.kind === kind` client-side
(`packages/memory/src/conversation-memory.ts:94-98`). So to return k memory
rows it scores, sorts, and transfers up to **4× (or ≥20)** rows — pure
amplification of the O(n·d) scan, because the `VectorStore` contract is
`search(vector, k)` with no `where` clause to push the `kind` filter down
(`packages/retrieval/src/contracts.ts:33-37`). On top of that, memory **grows
without bound**: every `remember` appends a row and there is no eviction, TTL,
or summarization anywhere in the package (`conversation-memory.ts:74-87`). In
a *shared* store the memory rows pile up alongside documents and inflate the
n that every query — document or memory — scans. Today the row counts are
tiny (the tests store 1–2 rows) so this is sub-ms; it's an amplifier on the
finding-7 baseline that becomes real over a long conversation history.

→ The over-fetch + unbounded-growth pattern gets a file: **09-memory-recall-overfetch.md**.

CPU/memory profiling under load is **not yet exercised** and won't
matter until a non-model path proves hot — the vector scan (amplified by
memory over-fetch and growth) is the first candidate, but only at a corpus
size the repo doesn't yet reach.

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

**A second network hop now exists: the embedding call.**
`OllamaEmbeddingProvider.embed(texts[])` POSTs to Ollama's `/api/embed`
(`packages/retrieval/src/ollama-embedding-provider.ts:50-74`). It's I/O on
both paths — once per indexed document and once per query — but it's
**batched**: a whole document's chunks embed in *one* round-trip, not one
per chunk, because the contract takes a `texts[]` array
(`pipeline.ts:40`). That's request batching, exercised (contrast: model
calls are *not* batched). When the store is buffr's `PgVectorStore`, a
real database hop joins the picture — `study-database-systems` owns that.

→ Embedding batching is covered in **08-embedding-batch-and-topk-floor.md**.

**Memory adds an embedding round-trip to the *write* path.** Before
`@aptkit/memory`, the embed call only happened on retrieval (indexing a
document, then querying it). Now `remember` embeds the formatted exchange on
every store (`packages/memory/src/conversation-memory.ts:75-76`) and `recall`
embeds the query (`:90-91`) — so a "remember this turn, then recall later"
loop is *two* embedding hops, one of them on the write path. And unlike
indexing (which batches a whole document's chunks into one `embed(texts[])`
call), `remember` embeds **one exchange at a time** — `embedder.embed([text])`
with a single-element array — so there's no batching to amortize the per-call
HTTP cost across turns. With the local Ollama embedder this is sub-ms and $0;
it matters the moment the embedder is a paid API.

→ The write-path embed cost is covered in **09-memory-recall-overfetch.md**.

Filesystem I/O (reading fixtures, listing replay artifacts in
`replay-runner.ts:31-44`) is sequential and unbounded in count, but
runs at dev/CI time over small directories, so it's not a bottleneck.
Connection pooling, retry/backoff timing, and *model*-request batching are
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

**Batching is now exercised — but at the embedding layer, not the model
layer.** `OllamaEmbeddingProvider.embed(texts[])` embeds a whole document's
chunks in one HTTP call (`ollama-embedding-provider.ts:50-74`,
`pipeline.ts:40`) — one round-trip for N chunks, amortizing the fixed HTTP
cost. *Model* request batching is still **not yet exercised**: each agent
turn is one `complete()` call, no coalescing, no provider batch APIs
(OpenAI `/v1/batch`, Anthropic Message Batches). → see
**08-embedding-batch-and-topk-floor.md**.

**Memory `recall` is the *anti*-pattern here: over-fetch, not batch.** Where
embedding batching shrinks N round-trips to one, memory recall does the
opposite to row reads — it fetches `max(k*4, 20)` rows to return k
(`conversation-memory.ts:94-95`) because the `VectorStore` contract can't push
the `kind` filter into the scan. It's a read-amplification tax paid on every
recall, the mirror image of batching: a missing filter forcing extra work
rather than a present batch removing it. The fix is to teach the contract a
metadata predicate so the store filters server-side — see lens 4 and **09**.

**One retrieval-depth knob: the top-k floor.** `minTopK` clamps the model's
requested `top_k` *up* to a floor (`search-knowledge-base-tool.ts:51,
80-81`) — a deliberate quality/cost tradeoff found live: Gemma
self-selected `top_k: 1` and starved a multi-part question's retrieval. The
floor costs a few extra retrieved chunks and tokens to buy answer
completeness. Not backpressure (it doesn't shed load) — it's a guard on a
model-controlled perf/quality knob, same family as `maxTurns`. → **08**.

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

→ Covered in **05-streaming-for-perceived-latency.md**.

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

**6. The vector scan is O(n·d) — exact-search baseline, not built to
scale.** Evidence: `InMemoryVectorStore.search` loops every chunk on every
query and sorts all n (`in-memory-vector-store.ts:25-33`). Consequence:
query latency grows linearly with corpus size. Acceptable today (3–6 docs,
sub-ms) and *correct* as a first move — it's exact top-k with zero infra.
Becomes a wall at large n. The move is already proven: buffr's
`PgVectorStore` with an HNSW index (`buffr/sql/001_agents_schema.sql:28-29`)
behind the same `VectorStore` contract — sub-linear ANN, pipeline unchanged.
This is a *known, contracted* scaling story, not an unowned risk. → **07**.

**7. Embedding-call cost is unpriced and unmetered.** Evidence: the cost
ledger prices only model `complete()` turns (`usage-ledger.ts`); the
embedding round-trips (`ollama-embedding-provider.ts:50-74`) emit no
`model_usage` event and carry no price. Consequence: with the *local*
Ollama embedder, cost is genuinely $0 so this is moot — but if the embedder
swaps to a paid API (OpenAI embeddings), per-embed cost would be invisible.
Acceptable while embeddings are local; the move is to emit usage for the
embed path the moment a paid embedder is wired. The write-path embed in
`remember` (red flag #8) widens this surface.

**8. Memory `recall` over-fetches 4×/≥20 and memory grows unbounded.**
Evidence: `recall` reads `fetchK = Math.max(k * 4, 20)` rows then filters to
`meta.kind === kind` in JS (`conversation-memory.ts:94-98`), and `remember`
only appends — no eviction, TTL, or summarization in the package
(`:74-87`). Root cause: the `VectorStore` contract is `search(vector, k)` with
no metadata predicate (`contracts.ts:33-37`), so the `kind` filter can't be
pushed into the scan. Consequence: each recall scores/sorts/transfers up to 4×
(or ≥20) the rows it returns, and in a *shared* store the unbounded memory
rows inflate the n that every query scans — both amplifying the O(n·d) cost
(red flag #6). Acceptable today (tiny row counts, sub-ms) and the natural
first cut; it becomes real over a long-lived conversation history. The move:
add a metadata filter to the `VectorStore` contract (buffr already pushes a
`where app_id` scope at the DB — `buffr/src/pg-vector-store.ts:74` — so the
shape is proven; it just needs a `kind` predicate), and cap/evict/summarize
memory rows. → **09**.

**9. `remember` puts a non-batched embedding round-trip on the write path.**
Evidence: `remember` calls `embedder.embed([text])` per exchange
(`conversation-memory.ts:75-76`) — one HTTP hop per remembered turn, with a
single-element array so there's no batching, unlike document indexing which
batches a whole doc's chunks (`ollama-embedding-provider.ts:50-74`).
Consequence: a remember-then-recall loop is two embed hops, one now on the
write path; with a paid embedder each remembered turn carries an unbatched,
unmetered embed cost. Acceptable while the embedder is local ($0); the move is
to batch deferred remembers and meter the embed path (ties to red flag #7).
→ **09**.

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
- **study-database-systems** — owns pgvector and the HNSW index mechanics
  (in buffr) that the in-memory linear scan is the exact-search baseline
  for, plus predicate pushdown / ANN-with-`WHERE`; this guide owns the O(n·d)
  cost contract, when to cross the seam, and the read-amplification tax memory
  recall pays for the missing metadata filter (**09**).
- **study-ai-engineering** — owns the RAG retrieval-quality story
  (precision@k/recall@k, chunking strategy); this guide reads those scores
  as a *baseline instrument* for a chunking or top-k perf change.
