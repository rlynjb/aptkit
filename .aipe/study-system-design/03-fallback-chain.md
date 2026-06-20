# Fallback chain — cross-provider recovery + the context guard

**Industry names:** Failover / fallback chain / Chain-of-Responsibility / decorator stack. **Type:** Industry standard.

## Zoom out, then zoom in

These two pieces live in the provider band, and the trick is that they're *also* providers — they satisfy the same `ModelProvider` port (`01-provider-abstraction.md`) while wrapping other providers. Find them between the loop and the vendor APIs.

```
  Zoom out — where fallback + guard live

  ┌─ Runtime core ──────────────────────────────────────────┐
  │  runAgentLoop → model.complete(request)                  │
  └───────────────────────────┬──────────────────────────────┘
                              │  (model is a composed provider)
  ┌─ Provider layer — packages/providers ──────▼──────────────┐
  │  ★ ContextWindowGuardedProvider ★  (pre-flight guard)     │ ← we are here
  │            │ delegates if within budget                   │
  │            ▼                                              │
  │  ★ FallbackModelProvider ★  (try p0, then p1, then p2)    │ ← and here
  │     ├─► anthropic adapter ─► Anthropic API                │
  │     └─► openai adapter    ─► OpenAI API                   │
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. You've written this without thinking about it: try the cache, on miss try the DB, on miss try the origin. A fallback chain is that, for model providers — try provider A, and if it throws, try provider B. The pattern is **failover through a Chain-of-Responsibility**, and because each link satisfies the same port, you can also slot a **guard** in front that rejects work *before* it's sent. Two mechanisms, one seam: recovery after a failure, and prevention before one.

## Structure pass

**Layers:** the composed provider is a stack — guard on top, fallback under it, concrete adapters at the bottom. One axis explains the whole stack.

**Axis — where does failure get contained?**

```
  "where does a failure stop?" — traced down the stack

  ┌─ context guard ──────────┐  → contains OVERSIZE before send
  │ estimate tokens, reject  │    (throws ContextWindowExceededError)
  └────────────┬─────────────┘
  ┌─ fallback chain ─────────┐  → contains PROVIDER failure
  │ try next on throw        │    (tries p1, p2; rethrows abort)
  └────────────┬─────────────┘
  ┌─ adapter (anthropic) ────┐  → contains NOTHING; propagates
  │ SDK call may throw       │    (rate limit, 5xx, bad key)
  └──────────────────────────┘
```

The failure-containment answer flips at each level, and *that ordering is the design*. The guard catches the failure that hasn't happened yet (oversize request); the chain catches the failure that did happen (a provider threw); the adapter catches nothing and lets the throw bubble up to whoever wraps it. The seam that matters: the boundary between "this provider threw" and "should we try the next one" — that's the `shouldFallback` decision. Hand off to How it works.

## How it works

#### Move 1 — the mental model

The fallback shape is a linear scan with an early return on success and an accumulator for failures. You've written this exact loop trying a list of candidates until one works. The kernel: walk the providers in order, `return` the first success, record each failure, and if you fall off the end, throw an aggregate error carrying every attempt.

```
  The fallback kernel — linear scan, first success wins

  providers = [p0, p1, p2]
  attempts = []
  ┌────────────────────────────────────────────────┐
  │ for p in providers:                              │
  │    if signal aborted: throw  ◄── abort is sacred │
  │    try:                                          │
  │       resp = p.complete(req)                     │
  │       return resp           ◄── first success    │
  │    catch err:                                    │
  │       if abort: throw                            │
  │       attempts.push({p.id, err})                 │
  │       if not shouldFallback(err): throw err      │
  │       (else continue to next p)                  │
  └────────────────────────────────────────────────┘
  throw ProviderFallbackError(attempts)  ◄── all failed
```

The guard is simpler — it's a gate, not a loop: estimate the request's tokens, compare to the budget, reject or delegate.

```
  The guard kernel — a gate before the call

  estimate = estimateContextWindow(request)
  if not estimate.ok:
     emit warning
     throw ContextWindowExceededError   ◄── never reaches the wrapped provider
  return provider.complete(request)      ◄── within budget, pass through
```

#### Move 2 — the step-by-step walkthrough

**The fallback chain — try each provider in order.** The chain holds an ordered array of providers and loops over them. The bridge: it's the candidate-scan you'd write to try multiple API keys until one isn't rate-limited. The first provider whose `complete()` resolves wins — the chain returns immediately and records which provider was selected.

```
  Execution trace — a fallback run, [anthropic, openai]

  index 0: anthropic.complete(req)  → throws "rate_limit"
           shouldFallback(err)? → true → attempts=[{anthropic, rate_limit}]
           emit warning "trying fallback provider"
  index 1: openai.complete(req)     → resolves ✓
           lastSelectedProvider = {openai, gpt-4.1}
           return response   ◄── chain stops here
```

**Abort is sacred — never fall back on a cancellation.** Before each attempt and inside the catch, the chain checks for an abort. If the caller cancelled (the `AbortSignal` fired), the chain *rethrows* rather than trying the next provider. The boundary condition: without this, cancelling a request would silently trigger fallback attempts against every provider — you'd cancel one call and accidentally make three more.

**The `shouldFallback` decision — not every error deserves a retry.** After a non-abort throw, the chain consults a `shouldFallback(error, provider)` predicate (defaults to always-true). If it returns false, the chain stops and rethrows that error immediately. The bridge: this is the difference between a *retryable* error (rate limit, 503) and a *fatal* one (malformed request, auth failure) — you don't want to burn your second provider on an error that will fail there too.

```
  Layers-and-hops — fallback delegating across adapters

  ┌─ FallbackModelProvider ─┐ hop 1: complete(req)  ┌─ anthropic adapter ─┐
  │ for index in providers  │ ─────────────────────►│ messages.create     │
  └──────────┬──────────────┘ hop 2: throws ◄────────└─────────────────────┘
       hop 3 │ shouldFallback? + not aborted → next
             ▼
  ┌─ FallbackModelProvider ─┐ hop 4: complete(req)  ┌─ openai adapter ────┐
  │ index = 1               │ ─────────────────────►│ chat.completions    │
  └──────────┬──────────────┘ hop 5: resolves ◄──────└─────────────────────┘
       hop 6 │ return response (model = openai)
             ▼
```

**Exhaustion throws an aggregate.** If every provider throws, the chain throws a `ProviderFallbackError` carrying the full `attempts` array — provider id, model, and error message for each. The bridge: this is the "all retries exhausted" error you've thrown from a retry loop, but it preserves *why each one failed* so the caller can diagnose. A single opaque "all providers failed" string would lose the diagnostic trail.

**The context guard — reject oversize before sending.** Separately, the guard wraps *one* provider. On `complete()`, it estimates the request's token count (system + messages + tool schemas, at a `charsPerToken` ratio), subtracts an `outputReserve`, and if the estimate exceeds the available input budget it throws `ContextWindowExceededError` *without calling the wrapped provider*. The bridge: it's client-side input validation — reject the bad request before it costs a network round-trip and a vendor rejection.

#### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** Fallback: an ordered provider list + a linear scan + return-on-first-success + an attempts accumulator + an aggregate throw on exhaustion. Guard: a token estimate + a budget comparison + reject-or-delegate.

2. **Name each part by what breaks if removed.**
   - Remove the **abort check** → cancelling a request triggers fallback attempts against every remaining provider. You cancel once, you pay N times.
   - Remove the **`shouldFallback` predicate** → every error falls through to the next provider, including fatal ones that will fail identically there — wasted calls and a delayed, misleading final error.
   - Remove the **attempts accumulator** → on total failure you get "all providers failed" with no per-provider reason. Undiagnosable.
   - Remove the **guard's pre-flight estimate** → oversize requests are sent and rejected by the vendor, costing a round-trip and (depending on vendor) sometimes tokens.

3. **Skeleton vs hardening.** Skeleton (fallback): the ordered scan + first-success return + exhaustion throw. Hardening: the abort check, the `shouldFallback` predicate, the warning trace events, `lastSelectedProvider` tracking. Skeleton (guard): estimate + compare + reject. Hardening: the `outputReserve`, the configurable `charsPerToken`, the warning event.

The interview payoff: name the **abort-is-sacred** rule. Most people describe a fallback chain as "try the next one on any error." The production-scar detail is that cancellation must *short-circuit* the chain — otherwise a user hitting "stop" silently fans out to every provider. That's the bug you only know about if you've shipped one.

#### Move 3 — the principle

Compose resilience at the seam, not in the caller. Because failover and the size guard both satisfy the same `ModelProvider` port, the agent loop stays dead simple — it calls `complete()` and knows nothing about retries or budgets. Resilience is a stack of decorators you assemble at construction time, and the caller never changes. That's the dividend of having a clean seam (`01-`).

## Primary diagram

The full recap — guard on top, chain under it, adapters at the bottom, the two failure-containment points marked.

```
  Fallback chain + context guard — full picture

  ┌─ runtime ────────────────────────────────────────────────┐
  │  runAgentLoop → composedProvider.complete(request)        │
  └──────────────────────────────┬────────────────────────────┘
                                 │
  ┌─ ContextWindowGuardedProvider ▼ ──────────────────────────┐
  │  estimate tokens vs (maxTokens - outputReserve)           │
  │    over budget? ─► throw ContextWindowExceededError ◄──────┼─ containment 1
  │    within?      ─► delegate ↓                             │
  └──────────────────────────────┬────────────────────────────┘
  ┌─ FallbackModelProvider ───────▼───────────────────────────┐
  │  for p in [anthropic, openai]:                            │
  │    aborted? ─► rethrow                                     │
  │    try p.complete → success ─► return (record selected)   │
  │    catch ─► record attempt; shouldFallback? next : rethrow│ ◄─ containment 2
  │  all failed ─► throw ProviderFallbackError(attempts)      │
  └────────────┬──────────────────────────┬────────────────────┘
               ▼ HTTPS                     ▼ HTTPS
        ┌────────────┐              ┌────────────┐
        │ Anthropic  │              │  OpenAI    │
        └────────────┘              └────────────┘
```

## Implementation in codebase

**Use cases.** Construct a `FallbackModelProvider([anthropic, openai])` and pass it as the `model` to any agent — now an Anthropic outage or rate-limit transparently routes to OpenAI, and the agent code is unchanged. Wrap a provider in `ContextWindowGuardedProvider` when running against a smaller local-model context window, so an over-long `WorkspaceDescriptor` summary gets rejected with a clear error instead of a confusing vendor truncation. Both are composed at the call site, not baked into the loop.

**The fallback scan** — `packages/providers/fallback/src/fallback-provider.ts` (lines 47–89):

```
  async complete(request) {
    const attempts = [];
    for (let index = 0; index < this.providers.length; index += 1) {  ← line 50, scan
      const provider = this.providers[index];
      request.signal?.throwIfAborted();                ← line 52, abort BEFORE attempt
      try {
        const response = await provider.complete(request);
        this.lastSelectedProvider = { ... };           ← record the winner
        return { ...response, model: response.model ?? provider.defaultModel };
      } catch (error) {                                                 ← first success
        if (isAbortError(error) || request.signal?.aborted) throw error; ← line 65, sacred
        attempts.push({ providerId: provider.id, ... });   ← accumulate the failure
        if (!this.shouldFallback(error, provider)) throw error;  ← line 73, fatal? stop
        if (index < this.providers.length - 1) {
          this.trace?.emit({ type: 'warning', ... });    ← line 78, "trying fallback"
        }
      }
    }
    throw new ProviderFallbackError(attempts);           ← line 88, aggregate on exhaustion
  }
       │
       └─ Line 52 + 65 are abort-is-sacred (checked before AND inside catch). Line 73
          is the fatal-vs-retryable gate. Line 88 preserves every attempt's reason —
          remove the accumulator and total failure becomes undiagnosable.
```

**The guard gate** — `packages/providers/local/src/context-window-guard.ts` (lines 57–70):

```
  async complete(request) {
    request.signal?.throwIfAborted();
    const estimate = estimateContextWindow(request, this.options);    ← line 59
    if (!estimate.ok) {                                               ← line 60
      this.options.trace?.emit({ type: 'warning',
        message: `Skipping local provider ...: estimated ${...} input tokens
                  exceed ${...}.` });                                 ← lines 61-66
      throw new ContextWindowExceededError(estimate);                 ← line 67
    }
    return this.provider.complete(request);                           ← line 69, pass-through
  }
       │
       └─ Line 67 throws BEFORE the wrapped provider is called (line 69 only runs
          when within budget). That ordering is the whole point: reject oversize
          before it costs a round-trip.
```

**The estimate** — `packages/providers/local/src/context-window-guard.ts` (lines 73–103):

```
  const outputReserve = options.outputReserve ?? 768;                 ← line 80
  const charsPerToken = options.charsPerToken ?? 3;                   ← line 81
  const estimatedInputTokens = estimateModelRequestTokens(request, charsPerToken);
  const availableInputTokens = Math.max(0, maxTokens - outputReserve);← line 83
  return { ..., ok: estimatedInputTokens <= availableInputTokens };

  // estimateModelRequestTokens sums system + every message + every tool schema
  // estimateTextTokens = Math.ceil(text.length / charsPerToken)      ← line 102
       │
       └─ It's a chars/token HEURISTIC (default 3), not a real tokenizer. Honest
          coarse guard — a request right at the edge could be mis-admitted. The
          outputReserve carves out room for the response so the answer doesn't
          blow the window after the input fits. (audit.md red-flag 5.)
```

## Elaborate

The fallback chain is Chain-of-Responsibility applied to providers, and the guard is a Decorator applied to one provider. Both are only possible because of the port from `01-provider-abstraction.md` — they *are* providers, so they nest. This is the cleanest demonstration in the repo that a good seam composes: you can stack guard-over-fallback-over-adapters, or fallback-over-guarded-locals, and the agent loop above never knows.

The coordination-under-partial-failure view — what happens when failures cross a *process* boundary, retries with backoff, idempotency — belongs to study-distributed-systems when generated. Here it's all in-process and synchronous: one chain, one thread, sequential attempts. The token-counting accuracy question (real tokenizer vs heuristic) touches study-ai-engineering's cost-management lens.

Next: `06-replay-eval-pipeline.md` shows the third kind of provider — the fixture provider, which fails by *running out of recorded responses* rather than by a network error.

## Interview defense

**Q: How does your system survive one model provider going down?**

A fallback chain that satisfies the same provider interface. Try providers in order, return the first success, accumulate failures, and throw an aggregate error only if all of them fail. The agent loop above it doesn't change — it just calls `complete()`.

```
  for p in [anthropic, openai]:
    try p.complete(req) → return        ← first success wins
    catch → record, try next
  all failed → throw ProviderFallbackError(attempts)
```

Anchor: `fallback-provider.ts:47-89`.

**Q: What's the subtle bug in a naive fallback chain?**

Treating cancellation as a retryable error. If the user aborts and you fall through to the next provider, you fan one cancelled request out to N providers. Abort must short-circuit the chain — rethrow immediately, both before the attempt and inside the catch.

```
  naive:   any throw → try next   (abort fans out to every provider ✗)
  correct: abort → rethrow now; only non-abort errors fall through ✓
```

Anchor: `fallback-provider.ts:52` and `:65` (the two abort checks).

## Validate

1. **Reconstruct.** Write the fallback scan from memory: the loop, the abort checks, the success return, the `shouldFallback` gate, the exhaustion throw. Check against `fallback-provider.ts:47-89`.
2. **Explain.** Why does the guard throw *before* calling the wrapped provider (`context-window-guard.ts:67` vs `:69`)? What does the ordering buy?
3. **Apply.** You stack `ContextWindowGuardedProvider` over a `FallbackModelProvider`. A request is oversize. Which error fires, and is any provider ever called? (Hint: the guard is on top.)
4. **Defend.** A teammate sets `shouldFallback` to always-true. Name one error class where that wastes a call, and explain what the predicate should return for it.

## See also

- `01-provider-abstraction.md` — the port that makes both of these composable.
- `02-bounded-agent-loop.md` — the caller that's oblivious to all this resilience.
- `06-replay-eval-pipeline.md` — the fixture provider, a third port implementation.
- `audit.md` lens 6 — failure handling; red-flag 5 on the token heuristic.
