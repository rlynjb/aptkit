# 07 — Timeouts, retries, pooling, and backpressure

**Industry name(s):** failure handling / cancellation / failover / connection pooling. **Type:** Industry standard (the patterns); Project-specific (the fallback chain).

## Zoom out — where this concept lives

This file covers what happens when the network doesn't cooperate — slow, failing, or overloaded. The repo's own answer lives at the application layer (the fallback chain) and in cancellation (`AbortSignal`); the transport-layer answers (pooling, SDK retries) are delegated.

```
  Zoom out — failure handling, split across layers

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  AbortSignal can cancel a run → stops the stream decode     │
  └───────────────────────────┬────────────────────────────────┘
                              │  signal threads down
  ┌─ Service (Node) ──────────▼────────────────────────────────┐
  │  ★ FallbackModelProvider: app-level failover (built) ★      │
  │  AbortSignal → SDK call cancellation                        │
  └───────────────────────────┬────────────────────────────────┘
                              │  delegated: timeouts, retries, pooling
  ┌─ Provider (SDK) ──────────▼────────────────────────────────┐
  │  SDK owns: socket pool, per-request timeout, 5xx retries    │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

Verdict first: AptKit's failure story is **failover, not retry**. When a provider call throws, the `FallbackModelProvider` moves to the next provider in the chain — it does not back off and retry the *same* provider, and it does not distinguish a 429 rate-limit from a 500 from a timeout. There's no jitter, no backoff curve, no circuit breaker. Cancellation, by contrast, is clean and first-class: one `AbortSignal` cancels both the upstream provider call and the downstream stream decode. Timeouts and connection pooling are entirely the SDK's job. This file is honest about what's built, what's delegated, and what's genuinely missing.

## The structure pass

**Layers.** Cancellation layer (`AbortSignal`, repo-owned, threads everywhere). Failover layer (`FallbackModelProvider`, repo-owned, app-level). Transport-resilience layer (timeouts, retries, pooling — SDK-owned).

**Axis — failure (where does it originate, propagate, get contained?).**

```
  One axis (failure containment) down the stack

  ┌─ fallback chain ──┐  → CONTAINS: catches throw, tries next provider
  ┌─ provider.complete┐  → PROPAGATES: SDK throws on timeout/5xx/network
  ┌─ SDK transport ───┐  → ORIGINATES + partially absorbs (its own retries)

  failure is born in the SDK, may be absorbed by SDK retries, propagates as a
  throw, and is finally contained by the fallback chain switching providers
```

The containment answer flips at the fallback boundary: below it, failure propagates as exceptions; at it, failure is swallowed and converted into "try the next provider." That seam is the repo's entire network-failure strategy.

**Seams.** The load-bearing seam is the `try/catch` in `FallbackModelProvider.complete()` (`fallback-provider.ts:54-85`): it's where a thrown network error becomes a failover decision. The second seam is `signal?.throwIfAborted()` (`run-agent-loop.ts:99`, `fallback-provider.ts:52`): the point where a user cancel short-circuits everything, and crucially where the chain *refuses* to treat an abort as a fallback-worthy error.

## How it works

### Move 1 — the mental model

You know how a `try/catch` around a `fetch` lets you fall back to a cached value when the network dies? The fallback chain is that, looped over a list of providers: try provider 1, catch, try provider 2, catch, … give up. And cancellation is the `AbortController` you already pass to `fetch` — same `signal`, threaded through one extra layer (the `ModelRequest`) into the SDK.

```
  The failover-loop shape

  for each provider in [primary, ...fallbacks]:
      check abort                       ← bail immediately if cancelled
      try:    return provider.complete()  ← success → done
      catch:  if abort → rethrow (not a fallback)
              record attempt
              continue to next provider
  all failed → throw ProviderFallbackError(attempts)
```

### Move 2 — the load-bearing skeleton

**The kernel:** `ordered provider list` + `try each in turn` + `abort-aware short-circuit` + `record-and-continue on failure` + `give-up error carrying all attempts`.

**Part 1 — the ordered list (failover order).** Providers are tried in array order: `[primary, ...fallbacks]`. **What breaks without it:** no list, no failover — a single provider failure is fatal. The order encodes preference (try the configured primary first).

**Part 2 — try-each-in-turn (the loop).** A `for` loop calls `provider.complete(request)`; the first success returns immediately. **What breaks without it:** you'd only ever try one provider.

**Part 3 — the abort short-circuit (don't fail over a cancel).** Before each attempt, `request.signal?.throwIfAborted()`. Inside the catch, `if (isAbortError(error) || request.signal?.aborted) throw error` — an abort is rethrown, *not* recorded as a failed attempt. **What breaks without it:** a user cancel would be mistaken for a provider failure, and the chain would pointlessly hammer every remaining provider with a request the user already abandoned. This is the part that's easy to forget — and getting it wrong wastes money and time on cancelled work.

```
  Abort short-circuit — a cancel is NOT a fallback trigger

  user aborts → signal.aborted = true
       │
  loop: throwIfAborted() → throws immediately, no more providers tried
  catch: isAbortError? → rethrow, do NOT push to attempts[]
       │
       └─ without this, cancel → "provider failed" → try next → waste
```

**Part 4 — record-and-continue (failover proper).** On a non-abort error, push `{providerId, model, error}` to `attempts[]`, emit a `warning` trace event, and continue to the next provider. **What breaks without it:** you'd lose the diagnostic trail of *why* each provider failed.

**Part 5 — the give-up error (`ProviderFallbackError`).** If every provider fails, throw `ProviderFallbackError(attempts)` — one error carrying every attempt's failure message. **What breaks without it:** the caller would only see the last provider's error, not the full picture of "openai: quota; anthropic: timeout."

```
  Give-up — one error carries the whole failure history

  ProviderFallbackError:
    "all model providers failed: openai: rate_limit; anthropic: 500"
       │
       └─ the .attempts array is the post-mortem: every provider, every reason
```

### Move 2.5 — what's delegated and what's missing (honest)

The kernel above is the *whole* repo-owned failure strategy. Everything else is delegated or absent.

```
  Comparison — built vs delegated vs missing

  BUILT (repo):     failover across providers, abort short-circuit,
                    attempt recording, give-up error
  DELEGATED (SDK):  per-request timeout, retry on 5xx/network,
                    connection pool / keep-alive
  MISSING:          backoff + jitter on the SAME provider,
                    429-specific handling (Retry-After),
                    circuit breaker (cooldown after repeated failures)
```

**Timeouts and same-provider retries are the SDK's.** The repo sets no timeout and no retry count on the provider call. Both SDKs have built-in defaults (a request timeout, automatic retries on transient 5xx/network errors with their own backoff). So a *transient blip* is absorbed by the SDK before the fallback chain ever sees it; the fallback chain only engages when the SDK has *exhausted its own retries* and thrown.

```
  Two-level failure handling — SDK retries first, THEN failover

  provider.complete()
       │  SDK: retry transient errors (own backoff) ── absorbs blips
       ▼  still failing → throw
  fallback chain: catch → next provider ── absorbs provider-level outages
```

**The notable gap: failover treats every error the same.** A 429 (rate-limited, *retry me later*) gets the identical treatment as a 500 (server error, *try elsewhere*): switch providers. For a 429, the textbook move is back off and retry the *same* provider after `Retry-After` — switching providers might just hit the same rate-limit policy on the other one. AptKit doesn't do this. **Why it's still the right call here:** with a two-provider chain and no sustained traffic, switching to the other provider *is* a reasonable response to a 429 (the other provider has independent quota), and adding per-status-code logic would be complexity the use case doesn't need. The honest cost: at higher volume, you'd want 429-aware backoff so you don't exhaust both providers' quotas in lockstep. **The seam to add it** already exists — the optional `shouldFallback(error, provider)` predicate (`fallback-provider.ts:13,73`) lets a caller decide per-error whether to fall over; a 429-aware policy would live there.

**Backpressure: bounded by `maxTurns`, not by the network.** There's no flow-control on the stream — the server writes records as fast as the agent loop emits them. What prevents runaway is the agent loop's hard turn budget (`maxTurns`, e.g. 6), which caps how many provider round-trips (and thus how many events) a run can produce. So backpressure is a *work* bound, not a *transport* bound. For a single-user dev tool with a low turn cap, the network never becomes the bottleneck.

### Move 3 — the principle

The principle: *failure handling lives at two layers, and you should know which layer owns which failure*. Transient network blips are the SDK's problem (it retries the same endpoint with backoff); provider-level outages are the application's problem (the fallback chain switches endpoints). Conflating them — putting app-level retries on top of SDK retries — multiplies wait times and costs. AptKit gets the split right by *not* adding a retry layer; its one gap (429-specific handling) is a known, gated extension point, not an oversight.

## Primary diagram

The full failure-and-cancellation picture across layers.

```
  AptKit failure handling — full picture

  ┌─ UI / agent loop ──────────────────────────────────────────┐
  │  AbortSignal ── signal.throwIfAborted() before each step    │
  └───────────────────────────┬────────────────────────────────┘
                              │ signal threads into request
  ┌─ FallbackModelProvider ───▼────────────────────────────────┐
  │  for provider in [primary, ...fallbacks]:                   │
  │     throwIfAborted()  ── cancel = rethrow, NOT failover     │
  │     try complete() → success → return                       │
  │     catch → record attempt, warning event, next provider    │
  │  all fail → throw ProviderFallbackError(attempts)           │
  └───────────────────────────┬────────────────────────────────┘
                              │ provider.complete(request, {signal})
  ┌─ SDK (delegated) ─────────▼────────────────────────────────┐
  │  per-request timeout · retry 5xx/network (own backoff)      │
  │  connection pool / keep-alive                               │
  │  abort: signal cancels the in-flight HTTPS request          │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The fallback chain wraps the primary provider on every non-fixture Studio run (`vite.config.ts:819-828`, `providerWithConfiguredFallback`) — e.g. OpenAI primary with Anthropic fallback. Cancellation is reachable wherever an `AbortSignal` is threaded (the agent loop, structured generation, the stream decoder).

**The failover loop with the abort short-circuit.** `packages/providers/fallback/src/fallback-provider.ts:47-89`:

```
  fallback-provider.ts  (complete, lines 47–89)

  for (let index = 0; index < this.providers.length; index += 1) {
    const provider = this.providers[index];
    request.signal?.throwIfAborted();               ← cancel bails BEFORE trying
    try {
      const response = await provider.complete(request);
      this.lastSelectedProvider = { providerId: provider.id, ... };
      return { ...response, model: response.model ?? provider.defaultModel };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) throw error;  ← cancel ≠ failover
      attempts.push({ providerId: provider.id, model: provider.defaultModel,
                      error: ... });                ← record WHY it failed
      if (!this.shouldFallback(error, provider)) throw error;  ← per-error opt-out seam
      if (index < this.providers.length - 1) {
        this.trace?.emit({ type: 'warning', ... });  ← observable failover
      }
    }
  }
  throw new ProviderFallbackError(attempts);         ← give-up, carries all attempts
       │
       └─ no backoff, no jitter, no per-status logic: any non-abort error → next
          provider. The shouldFallback predicate is where 429-aware logic WOULD go
```

**The give-up error packs every attempt.** `packages/providers/fallback/src/fallback-provider.ts:16-24`:

```
  fallback-provider.ts  (ProviderFallbackError, lines 16–24)

  super(`all model providers failed: ${attempts.map(a =>
        `${a.providerId}: ${a.error}`).join('; ')}`);
  this.attempts = attempts;                          ← full post-mortem on the error
```

**Cancellation threads through the agent loop into the SDK.** `packages/runtime/src/run-agent-loop.ts:99-109` calls `signal?.throwIfAborted()` then passes `signal` into `model.complete({..., signal})`; the provider forwards it to the SDK (`openai-provider.ts:47`, `anthropic-provider.ts:38`) as the SDK's request-options `signal`. One `AbortController` cancels the whole chain down to the in-flight HTTPS request.

**The same signal cancels the stream decode.** `packages/runtime/src/ndjson-stream.ts:112,123` — `options.signal?.throwIfAborted()` between chunks and between records. So cancelling a run stops both the upstream provider call and the downstream decode.

**No SDK timeout/retry/pool config — delegated.** The SDK clients (`openai-provider.ts:30`, `anthropic-provider.ts:25`) take `apiKey` only. No `timeout`, no `maxRetries`, no `httpAgent`. The SDK defaults apply: `not yet exercised` at the repo level.

## Elaborate

The two-level failure split (SDK retries transient blips, app fails over on outages) is the correct mental model for any "thin server in front of an external API" — and it's exactly the shape your AdvntrCue and dryrun work hint at: dryrun runs on-device Gemini Nano with an *API fallback*, which is the same "primary fails → switch source" move AptKit's chain makes, just across a device/cloud boundary instead of two clouds. The lesson that transfers: failover (switch source) and retry (try the same source again) are different tools for different failures, and stacking them naively multiplies latency. AptKit's deliberate *absence* of an app-level retry layer is the disciplined choice — it lets the SDK own retries and keeps the app layer focused on the one thing it's positioned to do (pick a different provider). The single gap worth flagging in a review is the 429 case; the `shouldFallback` hook is the designed place to close it, so it's a one-function extension, not a redesign.

## Interview defense

**Q: Retry or failover? What happens when a provider 429s?**

```
  any non-abort error → next provider. No backoff. No 429-special-casing.
```

Failover, not retry — at the app layer. The `FallbackModelProvider` catches any non-abort error and moves to the next provider; it does *not* back off and retry the same one, and it treats a 429 identically to a 500 (`fallback-provider.ts:64-85`). The SDK absorbs transient blips with its own retries first; the chain only engages after the SDK gives up. **Anchor:** failover switches endpoints; the SDK owns same-endpoint retries.

**Q: Is that 429 behavior correct?**

For two providers with independent quota and no sustained traffic, yes — the other provider has separate rate limits, so switching is a reasonable 429 response, and per-status logic would be unneeded complexity. At higher volume you'd add 429-aware backoff via the existing `shouldFallback(error, provider)` hook (`fallback-provider.ts:13`). **Anchor:** the extension seam already exists; it's a one-predicate change.

**Q: How does cancellation work end to end?**

```
  one AbortSignal → throwIfAborted in loop + decoder → cancels SDK request too
```

One `AbortSignal` threads from the agent loop (`run-agent-loop.ts:99`) through `ModelRequest.signal` into the SDK call (`openai-provider.ts:47`) *and* into the stream decoder (`ndjson-stream.ts:112`). The fallback chain rethrows an abort instead of failing over (`fallback-provider.ts:65`), so a cancel doesn't pointlessly hammer the remaining providers. **Anchor:** one signal, both directions, and the chain refuses to fail over on a cancel.

## Validate

1. **Reconstruct:** Write the five kernel parts of the fallback loop and what breaks without each.
2. **Explain:** Why does the chain rethrow an abort instead of recording it as a failed attempt? (A cancel isn't a provider failure; failing over would waste calls on abandoned work — `fallback-provider.ts:65`.)
3. **Apply:** Both providers fail. What does the caller receive and what's in it? (`ProviderFallbackError` with `.attempts` listing every provider + reason — `fallback-provider.ts:88`.)
4. **Defend:** Where would you add 429-aware backoff and why there? (The `shouldFallback` predicate — `fallback-provider.ts:13,73` — it's the designed per-error decision point.)

## See also

- `06-websockets-sse-streaming-and-realtime.md` — the no-resume limit (cancel/drop = no recovery)
- `03-tcp-udp-connections-and-sockets.md` — the SDK pool this delegates to
- `08-networking-red-flags-audit.md` — the 429 gap ranked among the risks
- study-distributed-systems — failover as partial-failure handling across external systems
- study-runtime-systems — `AbortSignal` plumbing and cooperative cancellation
