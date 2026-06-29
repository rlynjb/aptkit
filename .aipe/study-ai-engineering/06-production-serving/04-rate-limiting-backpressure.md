# Rate limiting & backpressure

**Subtitle:** Bound the rate of requests, not just the count of work · the 429 you never get · *Industry standard*

## Zoom out, then zoom in

Before mechanism: rate limiting caps *how fast* requests hit a downstream;
backpressure is the signal that pushes back when the downstream is full. Here's
where that lives in aptkit — and the honest answer is the slot is empty because
the downstream is `localhost`.

```
  Zoom out — where a rate limiter would sit (and doesn't)

  ┌─ Callers ───────────────────────────────────────────────────┐
  │  agents firing model.complete() as fast as the loop turns    │
  └───────────────────────────┬─────────────────────────────────┘
                              │ complete(request)
  ┌─ Rate limiter (the slot) ─▼─────────────────────────────────┐
  │  ★ tokens-per-minute budget? queue? reject when full?       │ ← EMPTY in aptkit
  └───────────────────────────┬─────────────────────────────────┘
                              │
  ┌─ Provider / model ────────▼─────────────────────────────────┐
  │  Gemma on local Ollama — no provider quota, no 429           │ ← no limit to respect
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. Cloud providers return `429 Too Many Requests` when you exceed a
quota, and a serious app meters its own request rate to stay under it. aptkit
talks to local Ollama — there's no quota, no 429, no bill that punishes a burst.
So request-rate limiting is `not yet exercised`. The nearest idea aptkit *does*
have bounds the *amount of work per run* (`maxToolCalls`, `maxTurns`) — that's
work-bounding, a cousin of backpressure, not rate-limiting. Keep them separate.

## Structure pass

**Layers.** Caller → (rate limiter, absent) → provider. The limiter would be a
gate between caller and provider; aptkit has no gate there.

**Axis — failure.** Trace how the system fails under load. With a cloud quota and
no limiter, a burst fails *externally*: the provider returns 429 and your calls
error. aptkit can't hit that failure — local Gemma just queues internally and
gets slower. So aptkit's load failure mode is *latency*, not *rejection*.

**Seam.** The boundary that *would* hold a limiter is
`ModelProvider.complete()` (`packages/runtime/src/model-provider.ts:54`) — same
decorator slot a cache uses. The seam that aptkit *actually* guards is the loop
counter inside `runAgentLoop`, and it bounds iterations, not request rate. The
axis "what stops runaway work?" flips at the loop counter — but "what stops
runaway *rate*?" has nothing to flip.

## How it works

### Move 1 — the mental model

You know a token-bucket limiter on an API gateway: requests draw from a bucket
that refills at a fixed rate; when it's empty you wait or get rejected. That's
rate-limiting — it governs *time*. aptkit's `maxToolCalls` is a different
governor: it's a *budget counter* that caps total work in one run, regardless of
time. A bucket says "no more than N per second"; a budget says "no more than N
total, ever, this run." Don't conflate them.

```
  Rate limit (time-based) vs. work budget (count-based)

  TOKEN BUCKET (rate)              WORK BUDGET (count)   ← what aptkit has
  ┌──────────────────┐            ┌──────────────────┐
  │ refills N/sec     │            │ maxToolCalls = 4 │
  │ draw on request   │            │ decrement per    │
  │ empty → wait/429  │            │   tool call      │
  │ governs SPEED     │            │ 0 left → force    │
  └──────────────────┘            │   final answer   │
                                   │ governs TOTAL    │
                                   └──────────────────┘
```

### Move 2 — the work-budget aptkit actually has

**The budget check.** `runAgentLoop` carries an optional `maxToolCalls` and a
`maxTurns` (default 8), and each turn checks whether the budget is spent —
`packages/runtime/src/run-agent-loop.ts:101`:

```ts
for (let turn = 0; turn < maxTurns; turn += 1) {              // turn cap (default 8, :87)
  signal?.throwIfAborted();
  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;  // tool-call cap
  const forceFinal = turn === maxTurns - 1 || budgetSpent;    // out of budget → wrap up
  const response = await model.complete({
    system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
    messages,
    tools: forceFinal ? undefined : toolSchemas,              // ← no tools offered when forcing final
    maxTokens,
    signal,
  });
  // ...
}
```

Read what `forceFinal` does: when the budget is spent it stops offering tools, so
the model *must* produce a final answer. That bounds how much work one run can
do. The rag-query agent sets `maxTurns: 6, maxToolCalls: 4`
(`packages/agents/rag-query/src/rag-query-agent.ts:75`) — a hard ceiling on the
investigation, not a cap on requests per second.

```
  maxToolCalls bounds WORK PER RUN — it never looks at the clock

  turn 0: tool call (1/4)   ┐
  turn 1: tool call (2/4)   │ budget draws down per call
  turn 2: tool call (3/4)   │
  turn 3: tool call (4/4)   ┘ budgetSpent → forceFinal: no tools, answer now
   nothing here meters requests-per-second — that's the gap
```

**Why there's no limiter.** The thing a rate limiter protects you from — a
provider quota — doesn't exist for local Gemma. `gemma-provider.ts` POSTs
straight to `http://localhost:11434/api/chat` with no quota in sight. A burst
makes Ollama slower; it never returns a 429. There's nothing to back off *from*,
so backpressure has no source signal to react to. `not yet exercised`.

### Move 3 — the principle

Rate-limiting governs *time* (requests per interval) to respect a downstream
quota; work-budgeting governs *count* (total work per run) to stop a runaway
agent. aptkit built the second because a local model has no quota to respect but a
chatty agent loop genuinely can spin. The discipline is knowing which problem you
have: aptkit's problem is "stop the loop," not "stay under the limit." When a
cloud provider with a real quota enters, the limiter slots in at `complete()`,
exactly where a cache would.

## Primary diagram

```
  What aptkit bounds vs. what it doesn't

  ┌─ BOUNDED: work per run (built) ─────────────────────────────┐
  │  maxTurns (8)  + maxToolCalls (4)  → forceFinal → stop       │
  │  protects against: a loop that never concludes              │
  └──────────────────────────────────────────────────────────────┘

  ┌─ UNBOUNDED: request rate (not yet exercised) ───────────────┐
  │  no tokens/minute budget · no queue · no 429 handling       │
  │  reason: local Gemma has no quota → load shows up as LATENCY │
  │  slot for it: ModelProvider.complete() decorator            │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The reason backpressure is unbuilt is the same local-first thread running through
this whole section: when the downstream is a process on your own machine, the
failure under load is "it gets slow," not "it rejects you." Rate limiting earns
its place the moment a shared, quota'd downstream appears — a cloud provider, or a
multi-tenant deployment where one user's burst starves another. At that point the
limiter is a `complete()` decorator and `maxToolCalls` keeps doing its unrelated
job. Read `05-retry-circuit-breaker.md` next — retries and rate limits are the two
halves of treating a flaky, quota'd downstream with respect, and aptkit has bits
of the first and none of the second.

## Project exercises

### Add a token-bucket rate limiter as a provider decorator
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a `RateLimitedModelProvider implements ModelProvider` that
  wraps another provider, refills a token bucket at a configured requests/second,
  and `await`s (or rejects) when the bucket is empty before delegating to the
  inner `complete()`.
- **Why it earns its place:** builds the limiter at the right seam and forces the
  wait-vs-reject decision — the core backpressure tradeoff.
- **Files to touch:** new
  `packages/providers/ratelimit/src/rate-limited-provider.ts`, reusing
  `ModelProvider` from `packages/runtime/src/model-provider.ts`.
- **Done when:** a test fires N+1 requests against a bucket of size N and asserts
  the N+1th waits (or rejects) rather than calling the inner provider immediately.
- **Estimated effort:** `1–4hr`

### Write the test that pins maxToolCalls as work-bounding (not rate)
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a test driving `runAgentLoop` with `maxToolCalls: 2` and a
  fixture that keeps requesting tools, asserting exactly 2 tool calls fire and
  the loop then forces a final answer.
- **Why it earns its place:** proves you can distinguish a work budget from a rate
  limit — the exact confusion this concept exists to clear up.
- **Files to touch:** new test in `packages/runtime/test/`, using
  `packages/runtime/src/run-agent-loop.ts:101` and
  `packages/agents/query/src/fixture-provider.ts`.
- **Done when:** the test asserts tool-call count caps at `maxToolCalls` and the
  final turn was forced (no tools offered).
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "How does aptkit handle rate limiting?"**
It doesn't — and that's correct for its design. The default model is local Gemma
on Ollama, which has no quota and never returns a 429, so there's nothing to rate
limit against. Load shows up as latency, not rejection. A limiter would slot in as
a `complete()` decorator the day a quota'd cloud provider joins.

```
  local Gemma:  burst → slower (queues internally)   → no limiter needed
  cloud quota:  burst → 429 rejection                → limiter at complete()
```
Anchor: *no quota downstream → no rate limit to enforce.*

**Q: "Isn't `maxToolCalls` a rate limiter?"**
No — it's a work budget. It caps the *total* tool calls in one run regardless of
time; a rate limiter caps requests *per interval*. `maxToolCalls` stops a runaway
loop; a rate limiter respects a downstream quota. Different trigger, different
purpose.

```
  maxToolCalls:  count-based · "≤4 total this run"  · stops runaway loop
  rate limiter:  time-based  · "≤N per second"      · respects a quota
```
Anchor: *`run-agent-loop.ts:101` — `toolCalls.length >= maxToolCalls`, no clock.*

## See also

- `05-retry-circuit-breaker.md` — the other half of respecting a flaky downstream
- `01-llm-caching.md` — the sibling `complete()` decorator
- `04-agents-and-tool-use` — where `maxToolCalls` bounds the investigation
