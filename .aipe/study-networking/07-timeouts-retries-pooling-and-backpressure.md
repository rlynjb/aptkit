# Timeouts, Retries, Pooling, and Backpressure

**Industry name:** resilience patterns / deadline propagation / connection pooling / flow control · *Industry standard*

## Zoom out, then zoom in

This is the file about what keeps a network call from hanging, retrying forever, or drowning a downstream. It's also the file with the sharpest honest gap in the repo.

```
  Zoom out — where resilience controls live (and don't)

  ┌─ Service layer ────────────────────────────────────────────┐
  │  agent loop: maxTurns bound (caps total work)              │
  │  FallbackModelProvider: retries across PROVIDERS, not hops │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Provider layer ─────────▼─────────────────────────────────┐
  │  Gemma fetch: AbortSignal pass-through ✓ ... but NO timeout │ ← ★ the gap ★
  │  Ollama embed fetch: same — NO timeout                     │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Storage layer (buffr) ──▼─────────────────────────────────┐
  │  pg.Pool: bounded connections = the system's only real     │
  │    backpressure (connect() queues when all are busy)        │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** Verdict first: **the repo has cancellation but no deadline, retries across providers but not across network attempts, and backpressure only in buffr's pool.** The Ollama `fetch` honors a caller's `AbortSignal` but sets no timeout of its own — so a wedged daemon hangs until something else aborts it. The pattern to learn: **resilience is four separate knobs — timeout, retry, pool, backpressure — and a system can have some and not others; naming which is which is the skill.**

## Structure pass

**Layers:** caller (sets deadlines, ideally) → transport (`fetch` / `pg.Pool`) → downstream.

**Axis — "what stops this from waiting forever or overloading the next layer?"** Trace each knob:

```
  Axis — what bounds the work — knob by knob

  knob          where it lives                       present?
  ────────────────────────────────────────────────────────────────
  cancellation  request.signal → fetch signal        YES (pass-through)
  timeout       (would be AbortSignal.timeout)        NO  ← the gap
  retry (net)   none at the HTTP layer                NO
  retry (logic) tool-call parse-retry in Gemma        YES (app-level)
  fallback      FallbackModelProvider across providers YES (different mechanism)
  pool          buffr pg.Pool                          YES (buffr only)
  backpressure  pg.Pool connection cap (queues)        YES (buffr only)
  iteration cap agent loop maxTurns                    YES (bounds the loop)
```

**Seam:** the seam is `request.signal` — the boundary where a caller's intent to cancel crosses into the transport. It's wired (the signal is forwarded), but nothing upstream ever attaches a *deadline* to that signal, so the wire is there with no current to run through it.

## How it works

#### Move 1 — the mental model

Think of a `fetch` with a loading spinner that never stops. The request went out, the server is stuck, and your UI waits forever because nothing told `fetch` "give up after N seconds." That's a missing timeout. The four resilience knobs answer four different "what if" questions:

```
  The pattern — four independent knobs

  timeout   ──► "what if it never answers?"     bound the WAIT
  retry     ──► "what if it fails transiently?" try AGAIN (with backoff)
  pool      ──► "what if I call it constantly?" REUSE connections
  backpressure ► "what if I call faster than    SLOW the caller down
                  it can serve?"
```

The part people conflate: **a retry without a timeout is useless** — if the first attempt hangs forever, you never reach the retry. And **fallback (try a different provider) is not retry (try the same call again)**. The repo has fallback and app-level parse-retry but no network timeout, which is precisely the dangerous combination.

#### Move 2 — walking the knobs in this repo

**Cancellation is wired; the deadline is missing.** The Gemma transport forwards `request.signal` into `fetch` (`packages/providers/gemma/src/gemma-provider.ts:203-209`):

```ts
return async ({ signal, ...payload }) => {
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),   // ✓ if a caller aborts, fetch aborts
  });                                 // ✗ but nothing sets a timeout-based signal
  // ...
};
```

And `complete()` checks the signal between attempts (`gemma-provider.ts:52,63`: `request.signal?.throwIfAborted()`). So cancellation *works* — if a caller passes an `AbortSignal` that fires, the call unwinds cleanly. The gap: **no code in the repo constructs an `AbortSignal.timeout(ms)` and passes it in.** A wedged Ollama (model loading, GPU stuck, daemon hung) leaves the `fetch` pending with no deadline. The embedding transport has the identical shape and identical gap (`packages/retrieval/src/ollama-embedding-provider.ts:62-68`).

```
  Layers-and-hops — the missing deadline

  ┌─ caller (agent loop) ──────┐   no AbortSignal.timeout attached
  │  model.complete(request)   │ ─────────────────────────────────┐
  └────────────────────────────┘                                   │
                              request.signal (maybe present,        │
                              but never a timeout)                  ▼
  ┌─ transport ────────────────────────────────────────────────────┐
  │  fetch(..., { signal })  ── hangs indefinitely if Ollama wedged │
  └──────────────────────────┬──────────────────────────────────────┘
                  hop C: HTTP │ ... no response ...
                             ▼
                      ┌─ Ollama (stuck) ─┐
                      │ never replies     │
                      └───────────────────┘
```

**The fix is one line and it's not in the repo.** A `signal: AbortSignal.timeout(30_000)` (or merging a timeout with the caller's signal) in `defaultHttpTransport` would bound the wait. That's the move — named here, not present in the code.

**Retry exists, but at the application layer, not the network layer.** Gemma's `complete()` retries the *model call* when the response isn't a valid tool call, appending a corrective nudge (`gemma-provider.ts:57-89`):

```ts
const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;  // default 2
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
  const messages = attempt === 0 ? baseMessages : [...baseMessages, { role: 'user', content: RETRY_NUDGE }];
  lastResponse = await this.chat({ ... });        // each attempt is a fresh HTTP call
  const call = parseToolCall(raw);
  if (call) return ...;                            // good tool call → done
  if (looksLikeToolAttempt(raw)) continue;         // botched JSON → retry with nudge
  break;
}
```

This is a *semantic* retry (the model produced bad JSON), not a *transport* retry (the network failed). There's no backoff, no jitter — and critically, since each attempt is a `fetch` with no timeout, a hang on attempt 1 means the retry never runs.

**Fallback is a different resilience mechanism.** `FallbackModelProvider` (used by Studio's live modes, `apps/studio/vite.config.ts:820-829`) tries the primary provider, and on failure moves to the next provider in the chain, emitting trace events. That's resilience against *a whole provider being down*, not against *one network attempt hanging*. It composes over the missing timeout, not in place of it — see `study-distributed-systems` for the fallback chain as a partial-failure pattern.

**The agent loop's `maxTurns` bounds total work.** Each agent runs `runAgentLoop` with a turn cap (recommendation agent: `maxTurns 6`). This bounds how many model round-trips a single capability makes — a different axis of "don't run forever" that caps the *count* of network calls, not the *duration* of any one.

**Pooling and backpressure live only in buffr.** `pg.Pool` (`buffr/src/db.ts:4`) reuses connections (see `03`) and, crucially, provides the system's *only* real backpressure: when every pooled connection is checked out, `pool.connect()` (used by `PgVectorStore.upsert`, `buffr/src/pg-vector-store.ts`) *queues* rather than opening unbounded sockets. That queue is flow control — it slows the caller when Postgres is saturated. aptkit's own HTTP path has no equivalent: nothing limits concurrent in-flight Ollama calls, so a burst of agent turns could fan out unbounded requests at the daemon. `not yet exercised` as a real risk because the agents run sequentially, but the mechanism isn't there.

**Request collapsing / dedup / circuit breakers:** `not yet exercised`. No identical-in-flight-request coalescing, no circuit breaker that trips after N failures, no rate limiter. None are needed for sequential local agents, but all would matter under concurrency.

#### Move 3 — the principle

The principle: **timeout, retry, pool, and backpressure are four independent knobs, and the dangerous failure is having retry/fallback without a timeout — because a hang on the first attempt starves everything downstream of it.** aptkit has cancellation wired (the signal flows) but no deadline set, fallback across providers but no transport retry, and backpressure only where `pg.Pool` happens to provide it. The single highest-leverage fix is a timeout on the Ollama `fetch`; everything else is appropriately scoped to a sequential local toolkit.

## Primary diagram

```
  Resilience recap — what's wired, what's missing

  CALLER         caller could attach AbortSignal.timeout ... but doesn't
       │
       ▼
  TRANSPORT  fetch(signal) ── cancellation ✓ ── timeout ✗ ──► hang risk
       │     Gemma parse-retry ✓ (app-level, no backoff/jitter)
       │     transport-level network retry ✗
       │
  PROVIDER   FallbackModelProvider ── try next provider on failure ✓
       │     (resilience vs provider-down, not vs hang)
       │
  LOOP       runAgentLoop maxTurns ── bounds CALL COUNT ✓
       │
  STORAGE    buffr pg.Pool ── reuse ✓ ── connect() queues = backpressure ✓
            (the only flow control in the system)
```

## Elaborate

These patterns come from production RPC stacks (gRPC deadlines, Finagle's circuit breakers, every database client's pool) where the lesson was learned the hard way: an unbounded wait is how one slow dependency takes down a whole service. The repo is small enough that the missing timeout hasn't bitten — local Ollama on a dev laptop rarely wedges — but the *mechanism* is the same one that causes cascading outages at scale. The `AbortSignal` plumbing is already in place, which means the fix is genuinely one line; the absence is an omission, not an architectural problem. See `study-performance-engineering` for why the missing timeout is also a tail-latency issue, and `study-distributed-systems` for the fallback chain under partial failure.

## Interview defense

**Q: "What happens if your model server hangs?"**
Answer with the honest verdict and the fix: "Right now it hangs — the `fetch` to Ollama forwards a caller's `AbortSignal` so cancellation works, but nothing sets a timeout, so a wedged daemon leaves the call pending indefinitely. The one-line fix is an `AbortSignal.timeout` in the transport. I have fallback across providers and an app-level retry for malformed tool calls, but neither helps if attempt one never returns — which is exactly why the missing timeout is the most consequential gap." That answer shows you can tell the four knobs apart and rank them.

```
  sketch: retry without timeout = useless

  attempt 1 ──► HANG (no deadline) ──► retry never reached ✗
  attempt 1 ──► TIMEOUT after Ns ───► retry runs ✓
                     ▲ the missing knob
```

Anchor: *a retry without a timeout never fires — bound the wait first.*

## See also

- `08-networking-red-flags-audit.md` — the missing timeout ranked as the #1 risk
- `03-tcp-udp-connections-and-sockets.md` — the pg.Pool that provides the only backpressure
- `study-distributed-systems` (neighbor guide) — the fallback chain as partial-failure coordination
