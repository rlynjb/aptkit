# Rate limiting & backpressure

*Rate limiting & backpressure · flow control (Industry standard)*

This is the cleanest example of why local-first makes some serving concerns *unforced*. Rate limiting exists because a shared, metered resource pushes back — a cloud provider returns 429 when you exceed your quota, and if you don't slow down, you waste calls and get throttled harder. aptkit's default is Gemma on Ollama: a process on your own machine. Ollama doesn't hand you a 429. There's no shared quota to blow. So aptkit has *no* flow control, and `not yet exercised` here isn't a lapse — it's the correct answer for the default deployment. The file is about the move you make the moment a cloud provider enters the picture.

## Zoom out, then zoom in

Flow control is three mechanisms working together: cap how many requests run *at once* (concurrency), hold the overflow (a queue), and refuse when the queue is full (backpressure). ★ aptkit has none of them because the local default never pushes back — the unbounded path is fine until the resource downstream isn't yours.

```
Flow control: cap → queue → reject (none of this exists in aptkit today)
┌───────────────────────────────────────────────────────────────────────────┐
│  callers ─────────────────────────────────────────────────────┐            │
│   ●●●●●●●●●●                                                    │            │
│        │                                                       ▼            │
│   ┌────────────────────┐   full?  ┌──────────────────────────────────┐    │
│   │  QUEUE (bounded)    │ ───yes──▶│ BACKPRESSURE: reject fast (429)   │    │
│   │  [ ][ ][ ][ ][ ]    │          │ caller retries/sheds load          │    │
│   └─────────┬──────────┘          └──────────────────────────────────┘    │
│             │ dequeue when a slot frees                                     │
│             ▼                                                               │
│   ┌────────────────────┐                                                    │
│   │ CONCURRENCY CAP = N │  at most N in flight                              │
│   │  [run][run][run]    │                                                    │
│   └─────────┬──────────┘                                                    │
│             ▼                                                               │
│        ┌──────────┐   local Gemma: no 429, no quota → cap unforced          │
│        │ PROVIDER │   cloud provider: 429 on overage → cap REQUIRED         │
│        └──────────┘                                                         │
└───────────────────────────────────────────────────────────────────────────┘
```

The three are a pipeline: the cap protects the provider, the queue absorbs bursts, and backpressure protects *you* from an unbounded queue eating memory while latency climbs.

## Structure pass

One axis: **what pushes back, and where.**

- **Concurrency cap.** A semaphore: at most N requests in flight to the provider. Protects the downstream from your bursts. Seam: a `ModelProvider` decorator that acquires a slot before `complete()` and releases after.
- **Bounded queue.** When all N slots are busy, new requests wait in a fixed-size queue. Smooths bursts so you don't drop work that would've fit a moment later. Seam: inside the same decorator.
- **Backpressure (reject).** When the queue is *also* full, refuse immediately rather than queue forever. An unbounded queue is the classic outage: latency climbs, memory grows, nothing recovers. Seam: the queue's full-branch.

aptkit's current structure: the fallback chain and `generateStructured` call `provider.complete()` directly, with **zero** of the above. Every request goes straight through. Fine for a local process; a liability against a metered cloud endpoint.

## How it works

**Move 1 — the mental model: a semaphore with a waiting room and a bouncer.** Concurrency cap = how many get in. Queue = the waiting room. Backpressure = the bouncer turning people away when the room's full.

```
The three as one component
   request ──▶ acquire slot?
                 │ yes → run, release slot when done
                 │ no  → room in queue?
                          │ yes → wait, run when a slot frees
                          │ no  → REJECT now (backpressure)
```

The non-obvious part is *backpressure*. New engineers add the cap and the queue and stop — then the queue grows unbounded under sustained load, memory balloons, and every request times out. The reject branch is what keeps a busy system *responsive-or-honest* instead of *slow-then-dead*.

**Move 2 — step by step.**

**Part A — what exists today: the unbounded path.** The fallback chain calls straight through with no gate. Look at the loop — `provider.complete(request)` runs the instant it's reached, however many callers are doing the same:

```ts
// packages/providers/fallback/src/fallback-provider.ts:50-55  (no concurrency gate)
for (let index = 0; index < this.providers.length; index += 1) {
  const provider = this.providers[index];
  request.signal?.throwIfAborted();
  try {
    const response = await provider.complete(request);   // ← fires immediately, no slot acquire
```

Nothing here counts in-flight requests or waits for a slot. Against Ollama that's correct — the bottleneck is the local GPU, which serializes naturally. Against a cloud provider with a requests-per-minute quota, a hundred concurrent agent runs would fire a hundred simultaneous calls and earn a wall of 429s.

**Part B — the gap, drawn.** Current-state-vs-future-state for the provider call:

```
Move 2.5 — provider call: current vs flow-controlled
CURRENT (direct, unbounded)              FUTURE (capped + queued + backpressure)
┌──────────────────────────────┐        ┌────────────────────────────────────────┐
│ async complete(req) {         │        │ async complete(req) {                   │
│   return inner.complete(req)  │ ─────▶ │   if (inFlight >= N && queue.full)      │
│ }                             │        │     throw RateLimitedError  ← reject    │
│                               │        │   await acquireSlot()       ← cap/queue │
│ // N callers → N live calls   │        │   try { return inner.complete(req) }    │
│ // cloud → 429 storm          │        │   finally { releaseSlot() }             │
└──────────────────────────────┘        └────────────────────────────────────────┘
```

This is the same decorator-provider shape as the context guard and the (proposed) cache — a `ModelProvider` wrapping a `ModelProvider`, doing bookkeeping around the inner `complete()`. `acquireSlot()` is a small async semaphore: resolve immediately if under the cap, else push a resolver into the bounded queue, else throw.

**Part C — when it actually matters.** Don't add this to the local default. Add it on the *cloud* leg:

```
Where the gate belongs in a mixed chain
   FallbackModelProvider([
     gemmaLocal,                    ← no gate: local GPU serializes itself
     rateLimited(anthropicCloud, {  ← gate HERE: respect the provider quota
       concurrency: 4,
       queueSize: 50,
     }),
   ])
```

The cap value comes from the provider's published rate limit (read `claude-api` for Anthropic's tiers), not a guess. Backpressure (reject) is better than infinite queueing because a fast "no" lets the caller shed load or retry with backoff (see `05-retry-circuit-breaker.md`) — a silently-growing queue gives you neither.

**Move 3 — the principle.** Flow control is about protecting a resource that pushes back. If nothing downstream pushes back — a local process you fully own — flow control is dead weight. Add it exactly at the boundary where a metered resource lives, sized to that resource's published limit, with a reject branch so an overload fails fast instead of melting slowly. Local-first lets you skip it honestly; going cloud forces it.

## Primary diagram

```
The three mechanisms, what each protects, and when aptkit needs them
┌──────────────────┬────────────────────────┬───────────────────────────────┐
│ Mechanism        │ Protects                │ Needed when                   │
├──────────────────┼────────────────────────┼───────────────────────────────┤
│ Concurrency cap  │ the downstream provider │ cloud provider with a quota   │
│ Bounded queue    │ throughput under bursts │ bursty load + a cap           │
│ Backpressure     │ YOU (memory/latency)    │ always, once a queue exists   │
└──────────────────┴────────────────────────┴───────────────────────────────┘
   local Gemma needs NONE of these — the local GPU is the natural limiter
```

## Elaborate

- **The unbounded queue is the trap, not the missing cap.** Most teams remember the concurrency cap and forget backpressure. A cap + an unbounded queue under sustained overload = climbing latency, growing memory, eventual OOM — slower and slower until it dies. The reject branch is the difference between a degraded-but-honest system and an outage.
- **Per-provider, not global.** The cap belongs *on the cloud leg of the fallback chain*, sized to that provider's limit — not as one global gate over all providers. Gemma and Anthropic have totally different limiters (local GPU vs RPM quota); a shared cap would starve one to protect the other.
- **It composes with retry.** A fast backpressure reject is only useful if the caller does something sane with it — retry with exponential backoff and jitter. That's the next file. Reject + dumb-immediate-retry just re-floods the queue.

## Project exercises

Phase 5. Case B — `not yet exercised`, build the gate from scratch, and put it only on the cloud leg.

### Concurrency-capped request queue

- **Exercise ID:** `EX-SERVE-04a` — concurrency-cap-queue
- **What to build:** A `RateLimitedProvider` decorator wrapping any `ModelProvider`: an async semaphore caps in-flight `complete()` calls at N, overflow waits in a bounded queue of size Q, and a request arriving when both are full throws a `RateLimitedError` (backpressure). Mirror the `ContextWindowGuardedProvider` decorator shape.
- **Why it earns its place:** It's the canonical flow-control primitive and forces the backpressure decision — the one most engineers skip.
- **Files to touch:** new `packages/providers/local/src/rate-limited-provider.ts` (mirror `context-window-guard.ts`), export from `index.ts`.
- **Done when:** with N=2, Q=2, a 5th concurrent call rejects immediately while the first two run; releasing a slot dequeues the next; tests assert both the cap and the reject.
- **Estimated effort:** `1–4hr`

### Wire the gate onto the cloud leg only

- **Exercise ID:** `EX-SERVE-04b` — cloud-leg-flow-control
- **What to build:** Compose `RateLimitedProvider` around the cloud provider *inside* a `FallbackModelProvider`, leaving the local Gemma leg ungated. Source the cap from the provider's published limit.
- **Why it earns its place:** It proves the per-provider point — flow control belongs at the metered boundary, not globally.
- **Files to touch:** the chain-assembly call site that constructs `FallbackModelProvider`, `packages/providers/fallback/src/fallback-provider.ts` (composition only, no edit needed to the class).
- **Done when:** local calls bypass the gate; cloud calls are capped; a test asserts the local leg is never throttled.
- **Estimated effort:** `1–4hr`

### Backpressure-reject telemetry

- **Exercise ID:** `EX-SERVE-04c` — backpressure-telemetry
- **What to build:** Emit a trace event on every backpressure reject so Studio can show how often you're shedding load — the signal that the cap is too low or you need more capacity.
- **Why it earns its place:** A reject you can't see is a silent failure; the reject rate is the metric that tells you to scale.
- **Files to touch:** `packages/providers/local/src/rate-limited-provider.ts`, event types in `packages/runtime/src/events.ts`.
- **Done when:** each reject emits one event; a replay shows the reject count.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Why does aptkit have no rate limiting?**

```
local Gemma on Ollama: no quota, no 429, GPU serializes naturally
   nothing downstream pushes back → flow control would be dead weight
   add it exactly when a metered cloud provider joins the chain
```

Anchor: flow control protects a resource that pushes back — the local default has none, so skipping it is correct, not negligent.

**Q: You add a concurrency cap and a queue. What's still missing?**

```
cap + unbounded queue, sustained overload:
   latency ↑, memory ↑, OOM  ── slow then dead
cap + BOUNDED queue + reject:
   fast "no" ── caller sheds load ── system stays honest
```

Anchor: the backpressure reject is the piece everyone forgets — without it the queue grows until the process dies.

**Q: Where exactly does the cap go in a fallback chain?**

```
[ gemmaLocal (no gate), rateLimited(anthropic, N=4) ]
   per-provider, sized to THAT provider's published limit — not one global cap
```

Anchor: each provider has a different limiter, so the cap is per-leg and sourced from the provider's real quota, never a global guess.

## See also

- [`05-retry-circuit-breaker.md`](./05-retry-circuit-breaker.md) — what the caller does with a backpressure reject: backoff and retry.
- [`01-llm-caching.md`](./01-llm-caching.md) — the other `ModelProvider` decorator; fewer calls means less pressure on the cap.
- [`02-llm-cost-optimization.md`](./02-llm-cost-optimization.md) — routing decides *which* provider gets the load the cap then shapes.
