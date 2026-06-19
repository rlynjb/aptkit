# Retry, backoff, and circuit breakers (and which one you actually have)

**Industry names:** retry with backoff, failover, circuit breaker · *Industry standard*

## Zoom out, then zoom in

Things fail transiently — a model returns malformed JSON, a provider has a blip.
Retry is "try again." Backoff is "wait longer between tries." A circuit breaker is
"stop trying a thing that keeps failing, and remember it failed." These are three
*different* resilience tools, and they're constantly confused. AptKit has two of the
family — *content retry* and *failover* — and notably **not** a circuit breaker.
Being precise about which is which is the whole point of this file.

```
  Zoom out — where each resilience tool lives

  ┌─ Structured-generation layer ─────────────────────────────────┐
  │  ★ generateStructured: retry on parse/validate fail (maxAttempts 2) ★│ ← content retry
  └───────────────────────────────┬────────────────────────────────┘
                                   │ model.complete()
  ┌─ Provider layer ───────────────▼────────────────────────────────┐
  │  ★ FallbackModelProvider: try next provider on error (failover) ★ │ ← failover
  │  ★ ContextWindowGuardedProvider: fail fast (throw before call) ★  │ ← fail fast
  │  ✗ circuit breaker: no open/half-open state, no failure memory    │ ← absent
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: *retry* re-attempts the same operation; *backoff* spaces the attempts;
*failover* switches to a different backend; a *circuit breaker* tracks failures over
time and "opens" to stop calling a known-bad dependency, then "half-opens" to probe
recovery. The question this file answers: which of these does AptKit have, exactly?
Answer: it retries *content* failures (`generateStructured`, maxAttempts 2 — re-prompt
when the output won't validate), and it *fails over* between providers (the fallback
chain). It does **not** back off, and it has **no** circuit breaker — the fallback
chain has zero failure-count memory, so it retries a dead provider on every request.

## Structure pass

**Layers.** Two carry resilience: *structured-generation* (content retry — re-prompt
on a bad parse) and the *provider* layer (failover + fail-fast). They handle different
failure *kinds*: content vs transport.

**Axis — failure: what kind of failure is this, and how is it handled?** Trace it. A
*validation* failure (model output won't parse) → retry with a stricter prompt
(content retry). A *transport* failure (provider throws) → try the next provider
(failover). A *too-big* request → throw before calling (fail fast). A *repeatedly-dead*
provider → ... nothing special; it's retried every time (the breaker gap). Each
failure kind meets a different tool — except the one that has no tool.

```
  One question — "what handles THIS failure?"

  ┌─ bad model output ──┐  → content retry (generateStructured, 2 attempts)
  ┌─ provider throws ───┐  → failover (FallbackModelProvider → next provider)
  ┌─ request too big ───┐  → fail fast (guard throws before the call)
  ┌─ provider keeps dying┐ → ✗ NO circuit breaker (retried every time)
```

**Seams.** The content-retry seam is inside `generateStructured` (re-prompt loop).
The failover seam is `FallbackModelProvider.complete` (try-next). A circuit breaker
would need a *new* stateful seam — one that remembers failure counts across calls —
and that seam doesn't exist. The distinction between failover (stateless try-next) and
a breaker (stateful stop-calling) is exactly what's load-bearing here.

## How it works

You already know retrying a flaky HTTP request, and you know a fuse that blows to stop
a short-circuit from burning the house down. Retry is "try the request again";
backoff is "wait a bit longer each time so you don't hammer a struggling server"; a
circuit breaker is the fuse — after enough failures it *stops* trying and fails fast,
sparing both you and the dependency.

### Move 1 — the mental model

```
  The resilience family — four distinct tools

  RETRY        try the same op again            (AptKit: content only)
  BACKOFF      wait longer between tries         (AptKit: none)
  FAILOVER     try a DIFFERENT backend           (AptKit: fallback chain)
  CIRCUIT      remember failures, OPEN to stop   (AptKit: NONE)
  BREAKER      calling, HALF-OPEN to probe

  retry/backoff = same target, spaced
  failover      = switch target
  breaker       = stop calling a target that keeps failing
```

The trap in one line: "we have a fallback chain" is *not* "we have a circuit breaker."
One switches targets; the other remembers and stops.

### Move 2 — the moving parts

**Content retry (have it).** Bridge from a parser that re-prompts on bad input —
`generateStructured` calls the model, parses+validates the output, and on failure
*re-attempts with a stricter suffix* appended ("output ONLY valid JSON…"), up to
`maxAttempts` (default 2). Boundary condition: this retries a *content* failure (the
output didn't validate), not a *network* failure — a thrown provider error short-
circuits the loop and returns `{ ok: false }` immediately, it isn't retried.

```
  Pattern — content retry (re-prompt on invalid output)

  for attempt in 1..maxAttempts (default 2):
    messages = attempt==1 ? base : base + strictSuffix   ← escalate the prompt
    response = complete(...)        ← a THROW here returns {ok:false} (no retry)
    parsed = validate(response)
    if parsed.ok: return parsed     ← success
    // else: try again, stricter
  return { ok: false, attempts }    ← exhausted
```

**Failover (have it).** Bridge from a load balancer trying the next backend — the
`FallbackModelProvider` holds an ordered provider list. On a thrown `complete`, it
checks `shouldFallback`, records the attempt, and tries the *next* provider; abort
errors pass straight through; all-failed throws `ProviderFallbackError` with every
attempt. Boundary condition: it's *stateless across calls* — it has no memory that a
provider failed last time, so the very next request starts from provider 0 again and
re-tries the dead one.

```
  Pattern — failover (stateless try-next)

  for provider in [p0, p1, p2]:        ← always starts at p0
    try complete() → return
    catch:
      if abort → rethrow
      if !shouldFallback → rethrow
      record attempt; next provider
  all failed → throw ProviderFallbackError(attempts)
       │
       └─ NEXT request also starts at p0 — no memory of p0 being dead
```

**Fail fast (have it).** Bridge from a guard clause — the context guard throws
*before* calling the provider when a request won't fit. Boundary condition: failing
fast is what makes failover efficient — a doomed call to a small provider errors
instantly, so the chain moves on without a wasted round-trip. (Detail in
`../02-context-and-prompts/01-context-window.md`.)

**Circuit breaker (do NOT have it).** Bridge from a fuse with memory — a breaker
counts failures; past a threshold it *opens* (fails fast without calling, sparing the
dead dependency); after a cooldown it *half-opens* (lets one probe through); success
*closes* it again. Boundary condition: AptKit's fallback chain has none of this state
— no failure counter, no open/half-open, no cooldown. A flapping provider is hammered
on every single request.

```
  Comparison — failover (have) vs circuit breaker (don't)

  FAILOVER (FallbackModelProvider)     CIRCUIT BREAKER (absent)
  ──────────────────────────────       ──────────────────────────────────
  stateless: try next on error         stateful: counts failures over time
  retries a dead provider every call   OPENS to STOP calling a dead one
  no cooldown, no probe                 HALF-OPENS to probe recovery
  bounds ONE request's failure          protects the dead dependency + your latency
```

### Move 2.5 — the precise distinction (the interview crux)

```
  retry/backoff   →  same provider, try again (spaced)        [content retry: yes; backoff: no]
  failover        →  different provider on error              [yes — fallback chain]
  circuit breaker →  remember failures, stop calling, probe   [NO]

  AptKit: content-retry + failover + fail-fast.  NOT backoff, NOT a breaker.
```

### Move 3 — the principle

Match the tool to the failure, and name what you have precisely. Retry the failures
that are transient and idempotent (a malformed parse — re-prompt). Fail over when a
*different* backend can succeed where this one failed. Add a circuit breaker when a
dependency *stays* down and you need to stop hammering it — which requires *state*
(failure counts, open/half-open) that failover deliberately lacks. The senior move is
refusing to call failover a circuit breaker: they solve different problems, and
conflating them means you think you have protection you don't.

## Primary diagram

The full resilience picture: content retry, failover, fail-fast — and the breaker
that's absent.

```
  Resilience tools in AptKit — full picture

  STRUCTURED GENERATION
  generateStructured: complete → validate → invalid? re-prompt (strict)  [retry: content]
        │  up to maxAttempts (default 2); a THROW → {ok:false} (not retried)
        ▼ model.complete()
  PROVIDER STACK (decorators)
  ┌──────────────────────────────────────────────────────────────────┐
  │  ContextWindowGuardedProvider → throw BEFORE call   [fail fast]    │
  │  FallbackModelProvider → try p0 → p1 → p2 on error  [failover]     │
  │       │ abort → rethrow; all fail → ProviderFallbackError          │
  │       └─ NO failure memory: next request restarts at p0            │
  │  ✗ CircuitBreakerProvider → open/half-open/closed   [NOT BUILT]    │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** When a model returns prose where JSON was required,
`generateStructured` re-prompts with a stricter instruction (content retry). When a
primary provider throws, the fallback chain reaches the next one (failover). When a
request is too big for a local model, the guard throws instantly so failover moves on
(fail fast). When a provider flaps repeatedly, AptKit just retries it every time —
the missing breaker.

**Content retry**, `packages/runtime/src/structured-generation.ts:54-99`:

```
  structured-generation.ts  (lines 57-93)

  const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 2);   ← default 2
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const messages = attempt === 1 ? baseMessages
                   : appendStrictSuffix(baseMessages, strictSuffix);  ← escalate prompt
    try { response = await options.model.complete({...}); }
    catch (error) {
      …
      return { ok: false, error: message, attempts };                 ← THROW: no retry
    }
    const parsed = parseValidatedJson(rawText, options.validate);
    if (parsed.ok) return { ok: true, value: parsed.value, ... };     ← success
    // else: loop, stricter
  }
       │
       └─ this retries CONTENT failures (output won't validate), NOT network
          failures — a thrown complete() returns {ok:false} immediately.
          And there's no backoff between attempts.
```

**Failover (not a breaker)**, `packages/providers/fallback/src/fallback-provider.ts:47-89`:

```
  fallback-provider.ts  (lines 50-77, 88)

  for (let index = 0; index < this.providers.length; index += 1) {   ← always from 0
    try {
      const response = await provider.complete(request);
      this.lastSelectedProvider = { providerId: provider.id, ... };
      return { ...response, model: ... };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) throw error; ← abort passthrough
      attempts.push(attempt);
      if (!this.shouldFallback(error, provider)) throw error;          ← predicate gate
      // else warn + try next
    }
  }
  throw new ProviderFallbackError(attempts);                           ← all failed
       │
       └─ no failure-count field, no open/half-open state, no cooldown.
          The loop restarts at index 0 every call, so a dead p0 is retried
          on EVERY request. That is failover, not a circuit breaker.
```

**Fail fast**, `packages/providers/local/src/context-window-guard.ts:57-68`: throws
`ContextWindowExceededError` before `provider.complete` when the estimate exceeds the
budget — the fast error the fallback chain skips past.

## Elaborate

These four tools come from distributed-systems resilience (the circuit breaker is
Nygard's *Release It!* pattern), and the confusion between *failover* and *circuit
breaker* is a classic interview filter. Failover answers "this backend failed — is
there another?" Circuit breaking answers "this backend keeps failing — should I stop
asking?" They compose: a mature stack fails over *and* breaks (stop calling the dead
provider, fail over to the healthy one, probe the dead one occasionally). Retry and
backoff are orthogonal — they apply to *the same* target, and backoff is what keeps a
retry storm from finishing off a struggling server.

AptKit's honest position: it has content-retry (the right tool for flaky model
*output*) and failover (the right tool when a *spare provider* exists), plus fail-fast
to make failover snappy. It lacks backoff and a breaker — so against a *persistently*
failing provider it both hammers the dead one (no breaker) and doesn't space its
attempts (no backoff). For low-traffic interactive use that's tolerable; at scale it's
the next hardening step, and the fallback chain is the natural place to add both.

Adjacent concepts: the failover chain in the error-recovery table
(`../04-agents-and-tool-use/06-error-recovery.md`), the fail-fast guard
(`../02-context-and-prompts/01-context-window.md`), and rate limiting, which pairs with
backoff on 429s (`04-rate-limiting-backpressure.md`).

## Project exercises

*Provenance: Phase 6 — Production serving (C6.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case A — failover exists; these add backoff and a breaker.*

### Exercise — exponential backoff in the fallback chain (Case A)

- **Exercise ID:** `[A6.7]` Phase 6, retry/backoff concept
- **What to build:** Add optional retry-with-exponential-backoff to
  `FallbackModelProvider`: before moving to the next provider on a *retryable* error,
  retry the *current* provider up to K times with growing delays (jittered), gated by
  a `isRetryable(error)` predicate. Respect the abort signal during the wait.
- **Why it earns its place:** The chain currently abandons a provider on the first
  blip — but many provider errors (a transient 503) succeed on a quick retry. Adding
  backoff turns a too-eager failover into a calibrated one, and backoff is the named
  missing tool.
- **Files to touch:** `packages/providers/fallback/src/fallback-provider.ts`,
  `packages/providers/fallback/test/fallback-provider.test.ts`.
- **Done when:** A provider that fails once then succeeds is retried (not failed over)
  after a backoff; abort during the wait cancels promptly; a test proves both.
- **Estimated effort:** `1–4hr`

### Exercise — a circuit-breaker provider wrapper (Case A)

- **Exercise ID:** `[A6.8]` Phase 6, circuit-breaker concept
- **What to build:** A `CircuitBreakerProvider` implementing `ModelProvider` that
  tracks failures per wrapped provider: after N consecutive failures it *opens*
  (fails fast without calling for a cooldown), then *half-opens* to let one probe
  through, *closing* on success. Compose it under the fallback chain so a dead
  provider is skipped instead of re-hammered.
- **Why it earns its place:** This is the genuinely missing tool and the exact thing
  failover is *not*. Building the open/half-open/closed state machine demonstrates you
  know the difference cold — the interview crux of this file.
- **Files to touch:** a new `packages/providers/breaker/src/*`,
  `packages/runtime/src/model-provider.ts` (consume the interface), matching tests.
- **Done when:** After N failures the breaker opens and the next calls fail fast
  without touching the provider; after the cooldown one probe is allowed; success
  closes it; a test drives the full state cycle.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: Your fallback chain — is that a circuit breaker?**
"No, and that's the distinction that matters. I'd draw both:"

```
  FAILOVER (have it)              CIRCUIT BREAKER (don't)
  try p0 → p1 on error           count failures → OPEN (stop calling)
  stateless: next call           → HALF-OPEN (probe) → CLOSE (recovered)
  restarts at p0                 stateful: remembers the dead provider
```

"`FallbackModelProvider` (`fallback-provider.ts:50`) is *failover* — try-next-on-error,
with `shouldFallback` and abort passthrough. But it has no failure-count state and
restarts at provider 0 every call, so it re-hammers a dead provider. A breaker would
*remember* the failures and stop calling it, then probe to recover. I'd add a
`CircuitBreakerProvider` at the same seam if a provider flaps."
*Anchor: failover switches targets; a breaker remembers and stops.*

**Q: You retry structured generation. Do you retry network errors the same way?**
"No — different failures, different handling. `generateStructured`
(`structured-generation.ts:57`) retries *content* failures by re-prompting with a
stricter suffix, up to 2 attempts. But a thrown `complete` (a network error) returns
`{ok:false}` immediately — it's not retried there; transport failures are the
*provider* layer's job (failover). And there's no backoff between the content retries
yet."
*Anchor: retry content by re-prompting; handle transport at the provider layer.*

## Validate

- **Reconstruct:** From memory, write the content-retry loop (attempt, escalate
  prompt, validate, return or loop) and the failover loop (try-next, abort passthrough,
  all-fail throw). Check against `structured-generation.ts:57-99` and
  `fallback-provider.ts:50-88`.
- **Explain:** Why is the fallback chain not a circuit breaker
  (`fallback-provider.ts:50`)? (No failure-count state, no open/half-open, no cooldown
  — it restarts at provider 0 every call and re-tries a dead provider; a breaker
  remembers and stops.)
- **Apply:** Provider p0 is down for an hour and you get 600 requests. What does
  AptKit do, and what would a breaker do? (AptKit tries p0 first all 600 times, fails
  over to p1 each time — 600 wasted p0 calls. A breaker would open after N failures
  and skip p0 entirely until a probe succeeds. `fallback-provider.ts:50`.)
- **Defend:** Why is `generateStructured`'s retry a *content* retry, not a network
  retry (`structured-generation.ts:78-87`)? (It re-prompts when the output fails
  validation; a thrown `complete` returns `{ok:false}` without retrying — transport
  failures are handled by failover, a different layer.)

## See also

- [../04-agents-and-tool-use/06-error-recovery.md](../04-agents-and-tool-use/06-error-recovery.md) — failover in the full failure-mode table
- [04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md) — backoff pairs with rate limiting on 429s
- [01-llm-caching.md](01-llm-caching.md) — the same provider-decorator seam a breaker would use
- [../02-context-and-prompts/01-context-window.md](../02-context-and-prompts/01-context-window.md) — the fail-fast guard that speeds failover
- [../01-llm-foundations/04-structured-outputs.md](../01-llm-foundations/04-structured-outputs.md) — what the content retry re-validates
