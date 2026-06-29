# Retry & circuit breaker

*Retry & circuit breaker · transient vs sustained failure (Industry standard)*

aptkit has *some* of this, and it's important to be exact about which parts. There's a bounded retry (`generateStructured` retries up to `maxAttempts`), and there's failover across providers (the fallback chain). What there isn't: exponential backoff with jitter, and a circuit breaker. The clean way to hold it: retry is for *transient* failures (a blip — try again in a moment), a circuit breaker is for *sustained* failures (the provider is down — stop hammering it). aptkit handles transient at a crude grain and has nothing for sustained. This file draws the line precisely.

## Zoom out, then zoom in

Two failure regimes, two tools. ★ Retry assumes the next attempt might work; the breaker assumes it won't and stops trying. aptkit owns a blunt version of the first regime and none of the second.

```
Failure regimes and their tools (★ = the dividing line)
┌────────────────────────────────────────────────────────────────────────────┐
│  TRANSIENT failure (a blip: timeout, one 503)                                │
│   ┌──────────────────────────────────────────────────────────────────┐     │
│   │ RETRY ── try again, ideally with growing delay + jitter            │     │
│   │   aptkit: bounded retry (generateStructured maxAttempts=2)         │     │
│   │           BUT no delay, no backoff, no jitter   ── NOT YET         │     │
│   └──────────────────────────────────────────────────────────────────┘     │
│  ★────────────────────────────────────────────────────────────────────────★│
│  SUSTAINED failure (provider down for minutes)                               │
│   ┌──────────────────────────────────────────────────────────────────┐     │
│   │ CIRCUIT BREAKER ── stop calling; fail fast; probe occasionally     │     │
│   │   aptkit: NONE ── retries keep hammering a dead provider           │     │
│   └──────────────────────────────────────────────────────────────────┘     │
│  (failover across providers — the fallback chain — is SHIPPED, sits across   │
│   both: it switches provider on failure, but doesn't back off or trip)       │
└────────────────────────────────────────────────────────────────────────────┘
```

The danger of having retry without a breaker: under a sustained outage, retries become a self-inflicted DDoS on a service that's already struggling.

## Structure pass

One axis: **how long the failure lasts.**

- **Bounded retry (shipped — `generateStructured`).** A fixed attempt count (default 2). On a failed *validation*, it appends a strict-JSON suffix and tries again. It's a retry, but a *crude* one: no delay between attempts, no exponential growth, no jitter. Good for "the model returned slightly-off JSON," wrong for "the network hiccuped" (instant retry hits the same hiccup).
- **Failover (shipped — `FallbackModelProvider`).** On an *exception*, switch to the next provider. Sits across both regimes — it reacts to failure by changing provider — but it has no backoff and no concept of "this provider is dead, stop including it."
- **Exponential backoff + jitter (the gap).** Wait `base · 2^attempt` ± random jitter between retries. Spreads retry load so a recovering provider isn't re-flooded by everyone retrying in lockstep.
- **Circuit breaker (the gap).** Track failures per provider; after a threshold, *open* the circuit (fail fast without calling); after a cooldown, go *half-open* (let one probe through); on success, *close*. Stops the retry-storm against a sustained outage.

## How it works

**Move 1 — the mental model: retry is optimism, the breaker is learned pessimism.** Retry says "that was probably a fluke." The breaker says "I've seen this fail N times in a row; I'm not asking again until I've waited."

```
The breaker state machine (the piece aptkit lacks entirely)
        ┌─────────┐  failures ≥ threshold   ┌────────┐
        │ CLOSED  │ ──────────────────────▶ │  OPEN  │
        │ (calls  │                          │ (fail  │
        │  flow)  │ ◀──── probe succeeds ─┐  │  fast) │
        └────┬────┘                       │  └───┬────┘
             ▲                            │      │ cooldown elapsed
             │                       ┌────┴──────▼──┐
             └──── probe succeeds ───│  HALF-OPEN   │
                                     │ (one probe)  │
                  probe fails ──────▶│  → back to OPEN
                                     └──────────────┘
```

**Move 2 — step by step.**

**Part A — what's shipped: the bounded retry.** `generateStructured` loops up to `maxAttempts` (default 2), and the retry's only adaptation is a strict suffix on the prompt — no wait:

```ts
// packages/runtime/src/structured-generation.ts:57-64, 92-95
const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 2);      // ← fixed count, default 2
// ...
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  options.signal?.throwIfAborted();
  const messages = attempt === 1 ? baseMessages : appendStrictSuffix(baseMessages, strictSuffix); // ← only adaptation
  // ... call model, parse, validate ...
  attempts.push({ attempt, rawText, error: parsed.error });
  if (attempt < maxAttempts) emitWarning(/* ... */);                   // ← retries IMMEDIATELY, no delay
}
```

Read it precisely: this is a **bounded retry** (capped attempts), **not** exponential backoff (no growing delay) and **not** a circuit breaker (no cross-call failure memory). It's tuned for *output-shape* failures — the model's JSON was slightly off — where an instant retry with a firmer instruction genuinely helps. For *transport* failures it's the wrong tool: an instant retry hits the same network blip.

**Part B — what's shipped: failover.** The fallback chain switches provider on an exception. Its gate, `shouldFallback`, decides whether to continue — but it defaults to "always continue" and has no delay or trip logic:

```ts
// packages/providers/fallback/src/fallback-provider.ts:64-85
} catch (error) {
  if (isAbortError(error) || request.signal?.aborted) throw error;
  attempts.push(attempt);
  if (!this.shouldFallback(error, provider)) throw error;   // ← gate, default () => true
  if (index < this.providers.length - 1) {
    this.trace?.emit({ type: 'warning', /* ... */            // ← warn, then immediately try next
      message: `Provider ${provider.id} failed (...); trying fallback provider.` });
  }
}
// no backoff between providers; no memory that provider A is DOWN
```

Failover is real resilience — if provider A is down, you reach provider B. But it re-includes A on the *next* request even if A has failed the last fifty times. A breaker would short-circuit A and go straight to B.

**Part C — the gaps, drawn.** Two distinct moves:

```
Move 2.5 — current vs future for the fallback chain
CURRENT (immediate failover)             FUTURE (backoff + per-provider breaker)
┌────────────────────────────────┐      ┌──────────────────────────────────────┐
│ for p in providers:            │      │ for p in providers:                   │
│   try: return p.complete(req)  │      │   if breaker[p].isOpen(): continue ◀── skip dead provider
│   catch e:                     │ ───▶ │   try: r = p.complete(req)            │
│     continue immediately       │      │        breaker[p].recordSuccess()     │
│                                │      │        return r                       │
│ // re-tries dead provider      │      │   catch e:                            │
│ //   every request, no wait    │      │        breaker[p].recordFailure()     │
│                                │      │        await backoff(attempt) ± jitter │
└────────────────────────────────┘      │        continue                       │
                                         └──────────────────────────────────────┘
```

Backoff goes *between* attempts: `delay = base · 2^attempt`, then add random jitter so a fleet of clients doesn't retry in a synchronized thundering herd. The breaker is per-provider state: count failures, open after a threshold, skip the provider while open, probe after a cooldown.

**Move 3 — the principle.** Match the tool to the failure's duration. Transient → retry, and retry *politely* (growing delay + jitter) so you don't re-flood a recovering service. Sustained → trip a breaker and fail fast, because retrying a dead service wastes your latency budget and worsens its outage. aptkit's bounded retry is fine for *output-shape* misses; it has neither the backoff for transient *transport* failures nor the breaker for sustained ones.

## Primary diagram

```
What aptkit has, what it lacks, and which failure each addresses
┌──────────────────────────┬──────────────────┬──────────────────────────────┐
│ Tool                     │ Status           │ Failure it's for             │
├──────────────────────────┼──────────────────┼──────────────────────────────┤
│ Bounded retry (maxAtt=2) │ SHIPPED          │ output-shape (bad JSON)      │
│ Failover (fallback chain)│ SHIPPED          │ provider A down → use B      │
│ Backoff + jitter         │ NOT YET EXERCISED│ transient transport blip     │
│ Circuit breaker          │ NOT YET EXERCISED│ sustained outage (stop hammer)│
└──────────────────────────┴──────────────────┴──────────────────────────────┘
   retry = optimism (try again) · breaker = pessimism (stop trying)
```

## Elaborate

- **Retry without backoff amplifies an outage.** When a provider is struggling, a fleet of clients retrying instantly and in lockstep is a thundering herd — the retries *are* the load that keeps it down. Exponential growth spreads attempts out; jitter de-synchronizes the fleet so they don't all retry on the same tick.
- **The breaker protects YOUR latency too.** It's not only about being kind to the provider. While the circuit is open, you fail fast (microseconds) instead of waiting out a timeout (seconds) on every call. Under a sustained outage, fail-fast is what keeps your own system responsive.
- **aptkit's retry is correctly scoped, just narrow.** Don't read "no backoff" as a bug in `generateStructured` — it's tuned for the failure it sees most on-device: the local model returning malformed JSON, where instant-retry-with-stricter-prompt is exactly right. The gap is that the *transport* and *sustained* regimes have no tool, not that the existing retry is wrong.
- **Local-first softens the urgency.** Gemma on Ollama rarely throws transient transport errors (no network), and a local process being "sustained down" is a different incident than a cloud outage. The backoff/breaker pair earns its keep the moment a cloud provider is in the chain.

## Project exercises

Phase 5. Case B — bounded retry and failover exist; backoff and the breaker do not.

### Exponential backoff with jitter

- **Exercise ID:** `EX-SERVE-05a` — backoff-with-jitter
- **What to build:** A `backoff(attempt)` helper (`base · 2^attempt` capped at a max, plus full jitter) and a delay between failover attempts in the fallback chain, so a transient blip isn't retried instantly.
- **Why it earns its place:** It's the difference between polite retry and a thundering herd — the single most-cited retry mistake in interviews.
- **Files to touch:** new `packages/providers/fallback/src/backoff.ts`, applied in the catch branch of `packages/providers/fallback/src/fallback-provider.ts:64-85`.
- **Done when:** delays grow exponentially across attempts, include jitter (two runs differ), are capped, and respect the abort signal during the wait; tests assert growth and the cap.
- **Estimated effort:** `1–4hr`

### Per-provider circuit breaker

- **Exercise ID:** `EX-SERVE-05b` — per-provider-circuit-breaker
- **What to build:** A `CircuitBreaker` (closed/open/half-open) tracked per provider in the fallback chain: open after a failure threshold, skip the open provider, half-open after a cooldown to probe, close on a successful probe. Wire it into the chain so a dead provider is short-circuited instead of retried every request.
- **Why it earns its place:** It's the missing tool for sustained failure and forces you to implement the state machine that defines the concept.
- **Files to touch:** new `packages/providers/fallback/src/circuit-breaker.ts`, integrated in `packages/providers/fallback/src/fallback-provider.ts`.
- **Done when:** after the threshold, the open provider is skipped without a call (spy assertion); after cooldown one probe is allowed; a successful probe closes the circuit. Tests cover all three transitions.
- **Estimated effort:** `1–2 days`

### Transport-vs-shape retry split

- **Exercise ID:** `EX-SERVE-05c` — classify-retryable-failures
- **What to build:** Classify failures in `generateStructured` so output-shape misses retry instantly (current behavior) while transport errors retry with backoff — different failures, different retry policy.
- **Why it earns its place:** It makes explicit the distinction this file rests on: the existing retry is right for shape, wrong for transport.
- **Files to touch:** `packages/runtime/src/structured-generation.ts:62-95`, reuse the `backoff` helper from `EX-SERVE-05a`.
- **Done when:** a validation failure retries with no delay; a thrown transport error retries with backoff; a test distinguishes the two paths.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: aptkit retries. Why is that not enough for a provider outage?**

```
transient blip:   retry → next attempt likely works
sustained outage: retry → retry → retry … all fail, all wait out a timeout
   ★ need a breaker: after N failures, STOP calling, fail fast, probe later
```

Anchor: retry is for blips; a breaker is for "it's actually down" — aptkit has the first and not the second.

**Q: Why exponential backoff *with jitter* — isn't a fixed delay simpler?**

```
fixed delay, many clients: all retry on the same tick → thundering herd
exp backoff + jitter:      delays grow AND de-synchronize → load spreads out
```

Anchor: jitter de-synchronizes the fleet so a recovering provider isn't re-flooded the instant it comes back.

**Q: Is the fallback chain a circuit breaker?**

```
fallback chain: A fails → try B   (per-request failover, no memory)
circuit breaker: A failed 50x → SKIP A entirely until cooldown
   the chain re-tries dead A every request; a breaker remembers
```

Anchor: failover switches provider on failure; a breaker *remembers* the failure and stops asking — the chain has the first, lacks the second.

## See also

- [`02-llm-cost-optimization.md`](./02-llm-cost-optimization.md) — the fallback chain's other axis: availability vs cost routing.
- [`04-rate-limiting-backpressure.md`](./04-rate-limiting-backpressure.md) — backoff is what a caller does with a backpressure reject.
- [`01-llm-caching.md`](./01-llm-caching.md) — the decorator-provider family the breaker would join.
