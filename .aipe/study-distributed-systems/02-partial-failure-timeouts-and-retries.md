# 02 — Partial Failure, Timeouts, and Retries

**Industry names:** partial failure · deadlines/timeouts · retries with backoff and jitter · failure classification (retryable vs terminal) · circuit breaker. **Type:** Industry standard.

## Zoom out, then zoom in

This is the most consequential file in the guide. The single biggest distributed-systems gap in the repo lives here: **there is no deadline on the Ollama path.**

```
  Zoom out — where deadlines should live (and don't)

  ┌─ Orchestration ───────────────────────────────────────────────┐
  │  runAgentLoop  — bounds TURNS (maxTurns=8) but not TIME         │
  └───────────────────────────────┬────────────────────────────────┘
  ┌─ Provider port ────────────────▼────────────────────────────────┐
  │  ★ FallbackModelProvider ★  — advances on THROW only            │ ← we are here
  └───────────────────────────────┬────────────────────────────────┘
  ┌─ Transport ────────────────────▼────────────────────────────────┐
  │  ★ GemmaProvider.fetch() ★  — NO timeout, NO AbortController     │ ← and here
  └───────────────────────────────┬────────────────────────────────┘
  ┌─ External node ────────────────▼────────────────────────────────┐
  │  Ollama daemon :11434  — can be down, slow, or WEDGED            │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: **partial failure** is the defining hazard of distributed systems. A local function either returns or throws. A remote call has a *third* outcome: it never comes back. The daemon isn't crashed (you'd get a connection-refused throw) — it's *wedged*: TCP connected, request accepted, no response, ever. A **deadline** is the only tool that converts that third outcome back into a thrown error you can handle. The repo doesn't have one.

## Structure pass — layers, one axis, the seams

**Layers** (the call stack of one model request): `runAgentLoop` → `FallbackModelProvider.complete` → `GemmaProvider.complete` → `fetch` → Ollama.

**The one axis: *how does each layer bound the work below it?*** Three kinds of bound exist; trace which each layer has:

```
  "what bounds the work below this layer?"  — traced downward

  ┌─────────────────────────────────────────────┐
  │ runAgentLoop     bound = TURN count (≤8)     │  ✓ count, ✗ time
  └──────────────────┬──────────────────────────┘
       ┌─────────────▼───────────────────────────┐
       │ FallbackProvider  bound = list LENGTH    │  ✓ count, ✗ time
       └─────────────┬───────────────────────────┘   advances only on THROW
             ┌───────▼─────────────────────────────┐
             │ GemmaProvider   bound = parse RETRIES │  ✓ count, ✗ time
             └───────┬─────────────────────────────┘
                   ┌─▼─────────────────────────────────┐
                   │ fetch()   bound = NONE             │  ✗ count, ✗ time  ← the hole
                   └────────────────────────────────────┘
```

Every layer bounds *count* — turns, list length, parse attempts. **Not one bounds time.** That's the finding in one diagram: the system can't run forever in turns, but it can hang forever on a single turn.

**The seam that matters: the `fetch` boundary** (`gemma-provider.ts:201`). Failure classification flips here — above it, a thrown error is classified (retryable? advance the chain) and a hang is *not even visible*; at the wire, a hang produces no event at all.

## How it works

### Move 1 — the mental model

You know this from the browser: a bare `fetch()` with no `AbortController` will spin forever if the server holds the socket open. You've hit the loading spinner that never resolves. Same primitive here — the fix is the same too: attach a deadline, and on expiry, abort and throw.

```
  The deadline kernel — race the work against a clock

         start request ────────────────►  response (the good path)
              │
              ├──── timer (e.g. 30s) ────►  fires first → ABORT → throw TimeoutError
              │
         whichever resolves first wins; the loser is cancelled
```

The kernel of a timeout: **a clock racing the work, with a cancel on the loser.** Drop the cancel and you have a "timeout" that reports failure but leaves the request running — a leak. Drop the clock and you have what the repo has now: wait forever.

### Move 2 — walking the mechanism

**Part 1 — the failover chain, and the trap inside it.** The chain (`FallbackModelProvider`) tries providers in order, records each failure, and on exhaustion throws a `ProviderFallbackError` carrying every attempt. Here's the real loop:

```typescript
// packages/providers/fallback/src/fallback-provider.ts:50-86
for (let index = 0; index < this.providers.length; index += 1) {
  const provider = this.providers[index];
  request.signal?.throwIfAborted();               // honors a caller-supplied abort
  try {
    const response = await provider.complete(request);   // ← if this HANGS, we hang here
    this.lastSelectedProvider = { providerId: provider.id, model: ... };
    return { ...response, model: ... };           // success → return, don't try the rest
  } catch (error) {                               // ← the chain ONLY advances on a THROW
    if (isAbortError(error) || request.signal?.aborted) throw error;
    attempts.push({ providerId: provider.id, error: ... });   // record the failure
    if (!this.shouldFallback(error, provider)) throw error;    // terminal error → stop
    // else: emit a warning and loop to the next provider
  }
}
throw new ProviderFallbackError(attempts);        // all failed → aggregate error
```

The load-bearing line is `await provider.complete(request)`. **The chain advances on a thrown error and on nothing else.** A provider that's *slow* — not failing, just wedged — never throws, so the `await` never resolves, and the chain never reaches the next provider. Your fallback exists precisely to survive a bad provider, and the one failure mode it can't survive is the most common real-world one: a hang. That's the surprising, load-bearing fact about this seam.

There's one escape hatch, and it's caller-controlled: `request.signal?.throwIfAborted()` and the `isAbortError` check. If the *caller* passes an `AbortSignal` and trips it, the chain bails. But nothing in the chain *creates* a deadline — it only honors one handed in.

**Part 2 — the transport, where the deadline is missing.** Down at the wire:

```typescript
// packages/providers/gemma/src/gemma-provider.ts:201-215
function defaultHttpTransport(host: string): GemmaChatTransport {
  const base = host.replace(/\/$/, '');
  return async ({ signal, ...payload }) => {
    const res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),          // ← timeout ONLY if caller passed a signal
    });
    if (!res.ok) {
      throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);  // a 500 DOES throw
    }
    return (await res.json()) as OllamaChatResponse;
  };
}
```

Read the `fetch` options: `method`, `headers`, `body`, and `signal` *only if the caller supplied one*. There is no `AbortController` created here, no `setTimeout` arming one. A non-OK HTTP status throws (good — that propagates to the chain, which advances). But a daemon that accepts the POST and never answers produces no status and no throw. The `await fetch(...)` sits forever.

**Part 3 — failure classification (the part the repo does have).** Not every failure should be retried. The chain distinguishes via `shouldFallback(error, provider)` — a terminal error (e.g. the context-window guard's `ContextWindowExceededError` from `context-window-guard.ts:34`) re-throws immediately instead of advancing, because trying the same oversized prompt on the next provider is pointless. That's real failure classification: *retryable* (advance) vs *terminal* (stop). The missing half is *timeout* as a third class.

```
  Failure taxonomy — what the chain does with each class

  error thrown by provider.complete()
        │
        ├─ AbortError / signal aborted   → re-throw (caller cancelled)     ✓ handled
        ├─ shouldFallback() == false      → re-throw (terminal, e.g. too big) ✓ handled
        ├─ shouldFallback() == true       → record + advance to next         ✓ handled
        └─ NO ERROR, just slow            → ∞ hang, no class, no event       ✗ THE GAP
```

**Part 4 — what's `not yet exercised`, and where it would attach.**

- **Backoff + jitter** — `not yet exercised`. There is no retry *loop* on the network call to back off; the chain tries each provider exactly once. Backoff/jitter attach the day you add "retry the *same* provider N times before advancing" — and the moment you do, you need jitter so that if many callers hit a recovering daemon at once they don't synchronize into a thundering herd.
- **Circuit breaker** — `not yet exercised`. The chain *records* attempts (`attempts.push`) but never *trips*: provider #1 can fail on every single call and the chain keeps trying it first, paying the full failure latency each time. A breaker would, after K consecutive failures, skip provider #1 for a cooldown window. Attach point: a per-provider failure counter on `FallbackModelProvider`.
- **Deadline propagation** — `not yet exercised`. Even with a per-call timeout, the *right* design passes a single deadline down the whole stack (loop budget → split across providers) so the total time is bounded, not just each hop. Attach point: thread a `deadline` through `ModelRequest`.

### Move 2.5 — current state vs the fix

This concept is built-but-incomplete, so here's the Phase A / Phase B.

```
  Phase A (now)                          Phase B (the fix)
  ─────────────────────────────────────  ────────────────────────────────────
  fetch(url, { ...maybe signal })         const ac = new AbortController();
  no timer                                const t = setTimeout(() => ac.abort(),
  caller MAY pass a signal                              TIMEOUT_MS);
                                          fetch(url, { signal: ac.signal })
  wedged daemon → ∞ hang                    .finally(() => clearTimeout(t));
                                          wedged daemon → abort → throw at TIMEOUT_MS
                                          → chain catches → advances to next provider
```

What *doesn't* change: the chain's catch logic already handles a thrown abort correctly (`isAbortError` re-throws a caller abort, but a *self*-armed timeout would be classified as retryable and advance). The fix is local — arm a clock in `defaultHttpTransport` — and the rest of the machinery is already shaped to receive it. That's the good news: the gap is a missing line, not a missing design.

### Move 3 — the principle

A timeout is not an error-handling nicety — it's how you make partial failure *observable*. Without a deadline, "slow" and "dead" are indistinguishable, and "indistinguishable from dead" means "hangs forever." Every remote call gets a deadline; the only question is what value and whether it's propagated. The repo bounds count everywhere and time nowhere, which is exactly backwards for the failure mode that actually occurs.

## Primary diagram

The full call stack with every bound labelled and the gap marked.

```
  One model request — bounds at every layer

  ┌─ runAgentLoop ──────────────────────────────────────────────┐
  │  for turn in 0..maxTurns(8):  ─ bound: COUNT ✓  TIME ✗        │
  └───────────────────────────┬──────────────────────────────────┘
                              │ ModelProvider.complete()
  ┌─ FallbackModelProvider ───▼──────────────────────────────────┐
  │  for provider in [p0, p1, …]:   ─ bound: LIST LENGTH ✓        │
  │    try p.complete()  ── success → return                      │
  │    catch  ── retryable → record + next ;  terminal → throw    │
  │           ── (no throw on HANG → stuck on this await) ✗       │
  └───────────────────────────┬──────────────────────────────────┘
                              │ GemmaProvider.complete()
  ┌─ GemmaProvider ───────────▼──────────────────────────────────┐
  │  for attempt in 0..maxAttempts:  ─ bound: PARSE RETRIES ✓     │
  │    fetch(/api/chat, { signal? })  ── NO TIMER ARMED ✗         │
  └───────────────────────────┬──────────────────────────────────┘
                              │ HTTP POST  (no deadline)
  ┌─ Ollama daemon :11434 ────▼──────────────────────────────────┐
  │  down → throws (refused) ✓ | wedged → silence → ∞ hang ✗      │
  └───────────────────────────────────────────────────────────────┘
```

## Elaborate

The deadline idea is old and load-bearing: it shows up in every serious RPC framework (gRPC deadlines, the `context.Context` deadline in Go, `AbortSignal.timeout()` in modern fetch). The deepest version is *deadline propagation* — a single budget set at the edge and subtracted as it flows down, so a request that's already spent 28 of its 30 seconds doesn't start a fresh 30-second retry three layers deep. aptkit hasn't needed that yet because the call stack is shallow and single-purpose, but the moment it adds retries, the absence of propagation becomes the next bug.

The circuit breaker (Nygard, *Release It!*) is the natural follow-on: timeouts stop one call from hanging; a breaker stops you from *paying the timeout* over and over on a node you already know is down. The chain's `attempts` array is the data a breaker would consume — it's recording the signal already, it just doesn't act on it.

## Interview defense

**Q: "Your fallback chain has three providers. Provider one hangs. What happens?"**
The honest answer, with the file open: "It hangs the whole call. The chain advances only on a thrown error — `await provider.complete()` at `fallback-provider.ts:55` — and a hung provider never throws. The `fetch` underneath (`gemma-provider.ts:201`) has no timeout of its own; it only honors a caller-supplied `AbortSignal`. So the slow provider defeats the chain whose entire job is to survive a bad provider. The fix is an `AbortController` armed with `setTimeout` in the transport; the chain's catch already treats an abort as advance-able."

```
  the trap, sketched

  chain:  try p0 ──await──► ∞   ✗ never advances to p1, p2
                  (p0 hangs, doesn't throw)
  fix:    arm timer → abort → throw → catch → try p1
```

Anchor: *the chain advances on a throw, so a hang — not a crash — is the failure it can't survive.*

**Q: "Difference between bounding turns and bounding time?"**
`maxTurns=8` stops an infinite agent loop — a *logical* runaway. A timeout stops a single hop that won't return — a *temporal* runaway. They're orthogonal: you can have 8 turns that each hang forever. The repo bounds the first and not the second.

Anchor: *count-bounds stop loops; time-bounds stop hangs; you need both.*

## See also

- `01-distributed-system-map.md` — seam 1 in the full map
- `03-idempotency-deduplication-and-delivery-semantics.md` — why a retry is only safe if the operation is idempotent
- `09-distributed-systems-red-flags-audit.md` — this is finding #1
- `study-networking` — socket-level timeouts, `keep-alive`, and what `fetch` does under the hood
- `study-runtime-systems` — `AbortController`, the event loop, and cancellation
