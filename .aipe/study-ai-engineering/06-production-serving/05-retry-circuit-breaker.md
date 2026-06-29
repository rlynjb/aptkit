# Retry & circuit breaker

**Subtitle:** Try again vs. stop trying · they are not the same pattern · *Industry standard*

## Zoom out, then zoom in

Before mechanism: a retry re-attempts a failed call; a circuit breaker *stops*
retrying once a downstream is clearly dead, so you don't hammer a corpse. Here's
where both sit in aptkit — it has three flavors of the first and none of the
second.

```
  Zoom out — retry layers in aptkit (and the breaker that's missing)

  ┌─ generateStructured ──── parse retry (maxAttempts 2, strict suffix) ┐
  │  ┌─ runAgentLoop ─────── recovery turn (one extra call to conclude) │
  │  │  ┌─ FallbackProvider ─ failover (try next provider on error)     │
  │  │  │  ┌─ GemmaProvider ─ tool-call nudge (retry JSON, default 2)    │
  │  │  │  │     ▼ complete()  → local Ollama                            │
  │  │  │  └──────────────────────────────────────────────────────────┘ │
  │  │  └────────────────────────────────────────────────────────────── ┘
  │  └─────────────────────────────────────────────────────────────────┘
  └──────────────────────────────────────────────────────────────────────┘
   ★ CIRCUIT BREAKER (open/half-open state) = not yet exercised
   ★ EXPONENTIAL BACKOFF (growing delays)   = not yet exercised
```

Now zoom in. aptkit retries at four nested layers — but every one is a *fixed,
bounded* retry: try again immediately, a capped number of times, then give up. It
has no exponential backoff (no growing delay between tries) and no circuit breaker
(no state that says "this provider is down, stop trying for a while"). The
fallback provider is the *nearest* thing to a breaker — it fails *over* on error
— but failover is not breaking. Be precise about that.

## Structure pass

**Layers.** Four retry shells nested around `complete()`, each catching a
different failure: bad JSON (Gemma nudge), off-schema output
(`generateStructured`), an unparseable final answer (recovery turn), a dead
provider (fallback). The breaker would be a *fifth* shell with memory — and it's
absent.

**Axis — failure.** Trace what each retry recovers from. Gemma's nudge recovers a
*botched tool-call format*. `generateStructured` recovers *invalid JSON against a
schema*. The recovery turn recovers an *unparseable conclusion*. Fallback
recovers a *provider error*. None of them recovers a *persistently dead
downstream gracefully* — they'd just retry into the same wall, because no state
remembers the wall is there.

**Seam.** The retry seams are the `for` loops inside each function; the breaker
seam *would* be a stateful wrapper at `complete()`
(`packages/runtime/src/model-provider.ts:54`). The axis "do we remember past
failures?" flips at a breaker — and aptkit has nothing on that axis. Every retry
here is memoryless.

## How it works

### Move 1 — the mental model

You know how a flaky `fetch` gets wrapped in a retry loop — try up to 3 times,
then throw? That's aptkit's retries: bounded, memoryless, immediate. A circuit
breaker is the *next* idea you learn after retries bite you: once failures pile
up, the breaker "opens" and fails fast *without* calling the downstream at all,
then after a cooldown goes "half-open" to test one request. Retry asks "did this
call work?"; a breaker asks "is this downstream even worth calling right now?"

```
  Retry (memoryless) vs. Circuit breaker (stateful)

  RETRY                          CIRCUIT BREAKER  ← not in aptkit
  ┌──────────────────┐          ┌────────────────────────────────┐
  │ try → fail → try  │          │ CLOSED  → calls flow            │
  │ → fail → try → ✗  │          │   too many fails ──►            │
  │ (forgets each time)│          │ OPEN    → fail fast, no call    │
  │                    │          │   cooldown ──►                  │
  │                    │          │ HALF-OPEN → test one, decide    │
  └──────────────────┘          └────────────────────────────────┘
   asks: did THIS call work?      asks: is the downstream worth calling?
```

### Move 2 — aptkit's three retries and the failover that isn't a breaker

**Retry 1 — Gemma's tool-call nudge.** Gemma has no native tool-calling, so it's
asked to emit JSON; when the JSON is botched, aptkit re-asks with a corrective
nudge, up to `maxToolCallAttempts` (default 2). `packages/providers/gemma/src/gemma-provider.ts:62`:

```ts
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {     // bounded: default 2 (:49)
  request.signal?.throwIfAborted();
  const messages =                                               // on retry, append the nudge
    attempt === 0 ? baseMessages : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];
  lastResponse = await this.chat({ model: this.defaultModel, messages, stream: false, ... });
  raw = lastResponse.message?.content ?? '';
  if (wantsTool) {
    const call = parseToolCall(raw);
    if (call) return this.toResponse([{ type: 'tool_use', ... }], lastResponse);  // good JSON, done
    if (looksLikeToolAttempt(raw)) continue;                     // botched → retry with nudge
  }
  break;                                                         // plain prose is a real answer
}
```

The `RETRY_NUDGE` (`:35`) literally tells Gemma "your previous reply was not a
valid tool call." No delay, no backoff — immediate re-ask, capped at 2.

**Retry 2 — `generateStructured` parse retry.** When structured output fails
validation, it re-asks once more with a strict JSON-only suffix, `maxAttempts`
default 2. `packages/runtime/src/structured-generation.ts:62`:

```ts
const maxAttempts = Math.max(1, options.retry?.maxAttempts ?? 2);   // bounded: default 2
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const messages = attempt === 1 ? baseMessages : appendStrictSuffix(baseMessages, strictSuffix);  // nudge on retry
  // ...call model, parse, validate...
  if (parsed.ok) return { ok: true, value: parsed.value, rawText, attempts };
  // else record and loop with the strict suffix
}
```

Same shape as Gemma's: re-ask with a stricter instruction, capped, no delay.

**Retry 3 — the loop's recovery turn.** If the agent's final answer can't be
parsed into the expected shape, the loop fires *one* extra call dedicated to
producing the structured conclusion. `packages/runtime/src/run-agent-loop.ts:204`:

```ts
async function runRecoveryTurn<T>(options, userPrompt): Promise<string | null> {
  try {
    options.signal?.throwIfAborted();
    const response = await options.model.complete({
      system: 'You are concluding a completed investigation. Output ONLY the structured answer ...',
      messages: [{ role: 'user', content: userPrompt }],   // a single corrective attempt
      maxTokens: 2048,
      signal: options.signal,
    });
    return textFromContent(response.content);
  } catch (error) { /* warn, return null */ }
}
```

One shot, no backoff. Three retries, three failures, one pattern: bounded
immediate re-ask.

**The failover that is *not* a breaker.** `FallbackModelProvider` tries providers
in order and moves to the next *on error*. That's failover. `packages/providers/fallback/src/fallback-provider.ts:47`:

```ts
for (let index = 0; index < this.providers.length; index += 1) {
  const provider = this.providers[index];
  try {
    return { ...await provider.complete(request), model: ... };   // success → return
  } catch (error) {
    if (isAbortError(error) || request.signal?.aborted) throw error;
    attempts.push({ providerId: provider.id, model: provider.defaultModel, error: ... });
    if (!this.shouldFallback(error, provider)) throw error;
    // else fall through to the next provider — NO state remembered for next time
  }
}
throw new ProviderFallbackError(attempts);
```

Here's the precise distinction: a breaker would *remember* that provider A keeps
failing and skip it on the *next* request without trying. This chain has no
memory — every request starts fresh at provider A, retries it, fails, and falls
to B again. It fails *over* (sideways to another provider) but never *opens*
(stops trying the bad one). No open/half-open state → not a circuit breaker.

```
  Fallback chain (no memory)        vs.   Circuit breaker (has memory)
  req1: A fails → try B ✓                 req1: A fails → try B ✓ (A's fail counted)
  req2: A fails → try B ✓                 req2: A is OPEN → skip A, straight to B
  req3: A fails → try B ✓                 ...cooldown... → half-open → test A once
   always retries the dead provider        stops calling the dead provider
```

### Move 3 — the principle

A retry is memoryless: it re-attempts *this* call and forgets. A circuit breaker
is stateful: it remembers a downstream is failing and stops calling it to protect
both sides. aptkit built three bounded memoryless retries plus failover because
its downstream is local Gemma — failures are usually a botched response (fix with
a nudge), not a dead server (which needs a breaker). Exponential backoff and a
breaker earn their place against a *remote, rate-limited, sometimes-down*
provider. Until that's in the chain, they're `not yet exercised` — and calling
the fallback chain a "circuit breaker" in an interview would be wrong.

## Primary diagram

```
  Four retries (built, memoryless) and the breaker (absent, stateful)

  BUILT — bounded, immediate, no backoff:
   ┌ Gemma nudge        ─ re-ask botched tool JSON  · cap 2 · :62
   ├ generateStructured ─ re-ask off-schema JSON    · cap 2 · :62
   ├ recovery turn      ─ one call to conclude       · cap 1 · :204
   └ fallback failover  ─ try next provider on error · :47   (NO memory)

  NOT YET EXERCISED — stateful / timed:
   ┌ exponential backoff ─ growing delay between tries
   └ circuit breaker     ─ open / half-open / closed state at complete()
```

## Elaborate

The reason aptkit stops at retries is the failure profile of a local model: the
common failure is "the model returned the wrong *shape*," which a corrective
re-ask fixes, not "the server is down for 30 seconds," which is what backoff and
breakers exist for. Hammering `localhost` with immediate retries costs nothing and
usually works on attempt 2. The moment a remote provider with real outages joins
the fallback chain, immediate memoryless retries become a liability — they'd
amplify load on a struggling downstream — and that's exactly when a breaker (and
backoff) slot in as a stateful `complete()` wrapper. Read
`04-rate-limiting-backpressure.md` for the complementary downstream-respect
pattern aptkit also skipped for the same local-first reason.

## Project exercises

### Add exponential backoff to one existing retry
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** add a configurable delay between attempts in
  `generateStructured`'s retry loop that grows per attempt (e.g. 100ms, 200ms,
  400ms), honoring the abort signal during the wait.
- **Why it earns its place:** turns a memoryless immediate retry into a
  load-respecting one — the first upgrade a remote provider forces.
- **Files to touch:** `packages/runtime/src/structured-generation.ts` (the loop
  at `:62`).
- **Done when:** a test asserts the second attempt is delayed and that an abort
  mid-wait throws promptly.
- **Estimated effort:** `1–4hr`

### (Case B) Build a circuit-breaker provider decorator
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a `CircuitBreakerModelProvider implements ModelProvider`
  wrapping an inner provider with closed/open/half-open state: count failures,
  open after a threshold (fail fast without calling), half-open after a cooldown
  to test one request.
- **Why it earns its place:** builds the exact thing the fallback chain is *not*,
  proving you can articulate failover ≠ breaking with running code.
- **Files to touch:** new
  `packages/providers/breaker/src/circuit-breaker-provider.ts`, reusing
  `ModelProvider` from `packages/runtime/src/model-provider.ts`; reference
  `packages/providers/fallback/src/fallback-provider.ts:47` for the contrast.
- **Done when:** a test drives the inner provider to fail past the threshold and
  asserts the breaker then *fails fast* (inner `complete` not called) until the
  cooldown elapses.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "Walk me through aptkit's retry strategy."**
Four layers, all bounded and memoryless. Gemma re-asks a botched tool-call with a
nudge (cap 2). `generateStructured` re-asks off-schema JSON with a strict suffix
(cap 2). The agent loop fires one recovery turn if the final answer won't parse.
And `FallbackModelProvider` fails over to the next provider on error. No backoff,
no state — each just re-attempts and forgets.

```
  Gemma nudge → generateStructured → recovery turn → fallback failover
   all: try again, capped, immediate, no memory of past failures
```
Anchor: *`gemma-provider.ts:62`, `structured-generation.ts:62`, `run-agent-loop.ts:204`.*

**Q: "Isn't the fallback chain a circuit breaker?"**
No — and the distinction matters. The chain fails *over*: on error it tries the
next provider, but it keeps no memory, so every request re-tries the dead provider
from the top. A breaker *opens* — it remembers the failures and stops calling the
bad provider until a cooldown. Failover is sideways; breaking is stateful.

```
  fallback:  req1..N each retry dead provider A → fall to B   (no memory)
  breaker:   A trips OPEN → skip A entirely → half-open later (memory)
```
Anchor: *`fallback-provider.ts:47` has no open/half-open state — failover, not breaking.*

## See also

- `04-rate-limiting-backpressure.md` — the complementary downstream-respect gap
- `02-llm-cost-optimization.md` — the fallback chain's availability job
- `01-llm-foundations/08-provider-abstraction.md` — the `complete()` seam all retries wrap
