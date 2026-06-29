# Timeouts, Retries, Pooling, and Backpressure

**Deadlines · retry/backoff · connection pools · overload control** — *Industry standard*

## Zoom out — where resilience would live

This is the topic where aptkit has the most *absences*, and the absences are the lesson. Timeouts, retries, pooling, and backpressure are the resilience layer wrapped around a network call. aptkit's outbound `fetch` has a cancellation *path* but no deadline that fires it, no retry, and no tuned pool. Here's where that layer sits — mostly empty.

```
  Zoom out — the resilience layer around the fetch

  ┌─ Caller (agent loop) ──────────────────────────────────────┐
  │  passes AbortSignal down (mechanism present)               │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌─ Provider transport ──────▼─────────────────────────────────┐
  │  await fetch(url, {signal?})                                │ ← we are here
  │  ✗ no timeout  ✗ no retry  ✗ no backoff  ✗ no pool tuning   │
  └──────────────────────────┬─────────────────────────────────┘
                             │
  ┌─ Ollama daemon ───────────▼─────────────────────────────────┐
  │  may stall (model load / OOM) with the socket open          │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A **timeout** bounds how long you'll wait; a **retry** re-sends a failed request, ideally with **backoff** (increasing delay) and **jitter** (randomized delay, so retries don't synchronize into a thundering herd); a **connection pool** reuses sockets to amortize handshakes; **backpressure** is how a consumer signals "slow down" to a producer. The question: which of these does aptkit have? Verdict — a clean *cancellation mechanism* but no *deadline policy*, no retries at the HTTP layer, and pooling/backpressure left to defaults. The headline is the timeout gap.

## Structure pass — the skeleton

**Layers:** caller deadline → transport timeout → retry policy → pool → backpressure. aptkit has wiring at the caller layer (the signal) and nothing actively bounding the transport.

**Axis traced — "what bounds the wait?"**

```
  One question down the resilience stack: "what bounds the wait?"

  ┌────────────────────────────────────────────┐
  │ caller: AbortSignal threaded through         │  → CAN bound, if fired
  └────────────────────────────────────────────┘
      ┌────────────────────────────────────────┐
      │ transport: await fetch(…, {signal?})     │  → nothing fires the signal ✗
      └────────────────────────────────────────┘
          ┌────────────────────────────────────┐
          │ retry policy                          │  → none ✗
          └────────────────────────────────────┘
              ┌────────────────────────────────┐
              │ undici pool                       │  → default, untuned
              └────────────────────────────────┘

  the mechanism exists at the top; nothing at the transport actually bounds the wait
```

**Seam — the `AbortSignal` pass-through.** The signal is threaded from `run-agent-loop.ts:91` through `provider.complete()` into `...(signal ? {signal} : {})` (`gemma-provider.ts:73, 208`). That's the seam where a timeout *would* attach — and the gap is that nothing attaches one.

## How it works

### Move 1 — the mental model

You've written `fetch` with `AbortController` + `setTimeout` to bound a slow API. aptkit wired the `AbortController` half (the signal flows everywhere) but never wrote the `setTimeout` half. The shape, with the missing piece marked:

```
  The bounded-call pattern — aptkit has the wire, not the timer

   ┌─ present ─────────────────────────────────────────┐
   │ caller creates signal → passes to complete()       │
   │ → passes to fetch(…, {signal})                     │
   │ → if signal.abort() fires, undici kills the socket │
   └────────────────────────────────────────────────────┘
   ┌─ MISSING ─────────────────────────────────────────┐
   │ const c = new AbortController()                     │
   │ setTimeout(() => c.abort(), DEADLINE)  ← never written
   │ → so the signal only fires if an OUTER caller aborts│
   └────────────────────────────────────────────────────┘
```

### Move 2 — walking what's there and what's not

**Timeout — the mechanism is plumbed, the policy is absent.** The signal threads cleanly. `runAgentLoop` accepts a `signal` (`run-agent-loop.ts:91`) and calls `signal?.throwIfAborted()` before each turn (`:99`) and passes it to the model call (`:108`). The provider checks it (`gemma-provider.ts:53, 63`) and forwards it to `fetch`. So if *something* aborts the signal, the whole chain unwinds correctly.

```ts
// packages/providers/gemma/src/gemma-provider.ts:69-74
lastResponse = await this.chat({
  model: this.defaultModel,
  messages,
  stream: false,
  ...(request.signal ? { signal: request.signal } : {}),   // signal forwarded — but who fires it?
});
```

What's missing: nowhere does aptkit create an `AbortController` and `setTimeout(() => controller.abort(), ms)`. So the `await fetch` has no deadline of its own. **Consequence, concretely:** Ollama is loading a 9B model into VRAM, the HTTP connection is accepted but the response is stalled for 40 seconds — `await fetch` simply waits the whole 40s (or forever, if the load wedges), and the agent turn blocks. The only escape is an outer caller aborting, which in the CLI/agent path nothing does. This is finding #1 in the overview and #1 in the red-flags audit.

**Retry — none at the HTTP layer.** `if (!res.ok) throw` (`gemma-provider.ts:210`) is terminal. A transient 503 doesn't retry; it throws. There's no backoff, no jitter, no retry-after handling. The *tool-call* retry loop in the Gemma provider (`gemma-provider.ts:62-89`) is **not** a network retry — it re-prompts the model to fix malformed JSON over the *same kind* of call, not because the HTTP failed. Don't confuse the two: the loop hardens *parsing*, not *transport*.

**Provider fallback ≠ call retry.** The `FallbackModelProvider` tries providers in order and records failed attempts (`fallback/src/...`), switching from, say, Gemma to a cloud provider on error. That's resilience at the *provider* granularity — "this provider failed, try the next one" — not "this call failed, retry it." A single provider's transient blip still surfaces as a failure unless a *different* provider is configured behind it. It's a real failover mechanism, just at a coarser grain than HTTP retry.

```
  Two different "retries" — don't conflate them

  tool-call loop (gemma-provider.ts:62)   provider fallback (FallbackModelProvider)
  ┌──────────────────────────────┐        ┌──────────────────────────────┐
  │ same provider, re-prompt for  │        │ provider A fails → try B      │
  │ valid JSON tool call          │        │ (coarse-grain failover)       │
  │ NOT a network retry           │        │ NOT a per-call retry          │
  └──────────────────────────────┘        └──────────────────────────────┘
  neither one re-sends a failed HTTP request to the same Ollama endpoint
```

**Pooling — undici default, untuned.** aptkit talks to one origin (`localhost:11434`), so undici's keep-alive pool likely serves repeated calls from one warm socket. But there's no `http.Agent`, no `maxSockets`, no `keepAlive` config — it's whatever the runtime defaults are. For a single-user local tool that's correct (no concurrency pressure). Real connection-pool tuning exists only in buffr's `pg.Pool` (`buffr/src/db.ts:4-6`) — a different protocol, a different repo, and even there it's `new pg.Pool({connectionString})` with default sizing, no `connectionTimeoutMillis`/`idleTimeoutMillis`/`max`. So pooling is `not yet exercised` as a tuned concern on either side.

**Backpressure — partial, on the streaming response.** The NDJSON stream writes synchronously with `res.write` (`vite.config.ts:908`) and never checks the return value or waits for `drain`. Node's socket buffers absorb the writes; for a short agent trace that's fine. There's no explicit backpressure handling — if a slow client couldn't keep up with a huge trace, writes would buffer in memory. For the trace sizes here (a handful of events) that's a non-issue, but it's the absent mechanism worth naming. On the read side, `decodeNdjsonStream` is a pull-based async generator, which gives the *consumer* natural backpressure (it pulls when ready).

### Move 2.5 — current state vs the obvious fix

The timeout gap has a small, contained fix. What's striking is how little has to change, because the mechanism is already plumbed.

```
  Comparison — timeout today vs the one-function fix

  TODAY                                  FIX (transport-local)
  ┌──────────────────────────────┐      ┌──────────────────────────────┐
  │ await fetch(url, {signal?})   │      │ const c = new AbortController()│
  │ signal only from outer caller │ ───► │ const t = setTimeout(          │
  │ → wedged Ollama hangs forever │      │   () => c.abort(), DEADLINE)   │
  │                               │      │ fetch(url, {signal: merge(     │
  │                               │      │   signal, c.signal)})          │
  │                               │      │ finally clearTimeout(t)        │
  └──────────────────────────────┘      └──────────────────────────────┘
  no contract change — the transport already accepts a signal
```

Nothing above the transport changes: `complete()`, the agent loop, the caller all stay identical. The deadline lives entirely inside `defaultHttpTransport`. That's the payoff of having plumbed the signal already — the fix is local.

### Move 3 — the principle

Resilience is a ladder, and you climb it in response to observed failure, not preemptively. aptkit is at the bottom rung deliberately: one local origin, one user, no flakiness pressure — so no retries, no pool tuning, no backpressure machinery. That's defensible for everything *except the timeout*, because a timeout protects against a failure mode that exists even locally: a daemon that accepts a connection and then stalls. A timeout isn't resilience-for-scale; it's correctness-for-liveness. The principle: ship the timeout even when you skip the rest, because "wait forever" is never the right default.

## Primary diagram

The full resilience layer: what's present, what's absent, where the gap is.

```
  aptkit resilience layer — the timeout gap is the headline

  ┌─ TIMEOUT ──────────────────────────────────────────────────┐
  │  AbortSignal threaded caller→complete→fetch   ✓ mechanism   │
  │  AbortController + setTimeout to FIRE it       ✗ MISSING     │ ★ finding #1
  │  → wedged Ollama → await fetch hangs indefinitely           │
  └──────────────────────────────────────────────────────────────┘
  ┌─ RETRY / BACKOFF ──────────────────────────────────────────┐
  │  HTTP retry            ✗   |  backoff/jitter  ✗             │
  │  tool-call re-prompt   ✓ (parsing, not network)            │
  │  provider fallback     ✓ (coarse failover, not per-call)   │
  └──────────────────────────────────────────────────────────────┘
  ┌─ POOLING ──────────────────────────────────────────────────┐
  │  undici default, untuned (one origin)    not yet exercised  │
  │  buffr pg.Pool: default sizing, no timeouts (other repo)    │
  └──────────────────────────────────────────────────────────────┘
  ┌─ BACKPRESSURE ─────────────────────────────────────────────┐
  │  write: no drain handling (small traces, fine)             │
  │  read: pull-based async generator → natural backpressure ✓ │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

Timeouts, retries with jittered backoff, and circuit breakers are the canonical resilience kit for any service that calls another service — at scale they're the difference between a blip and a cascading outage. aptkit doesn't operate at that scale, so most of the kit is correctly absent. The timeout is the exception because it guards *liveness*, not throughput: a single hung call with no deadline can wedge an entire interactive session, and that's true at any scale, including one user. The cleanest version of this fix is the merged-signal pattern in Move 2.5 — a controller and a timer inside the transport, merged with the caller's signal so both an outer abort and a deadline can fire. See **study-distributed-systems** for how timeouts compose with the fallback chain under partial failure, and **study-performance-engineering** for how the missing connection-pool tuning and the synchronous `await fetch` shape latency.

## Interview defense

**Q: What happens if your model server hangs?**
Today, the call hangs with it — that's the gap. The `AbortSignal` is threaded end-to-end from the agent loop into `fetch`, but nothing fires it on a deadline, so a wedged Ollama (model load, OOM) holds the connection open and `await fetch` never resolves. The fix is local: an `AbortController` plus `setTimeout` inside the transport, merged with the caller's signal. No contract above it changes.

```
  signal threaded ✓  →  but no setTimeout to fire it ✗  →  hang
  fix: controller + timer in defaultHttpTransport, merged with caller signal
```
Anchor: *"I plumbed the cancellation mechanism but not the deadline policy — that's the one resilience piece I'd ship even at one user, because it's liveness, not scale."*

**Q: Do you retry failed calls?**
Not at the HTTP layer — `!res.ok` throws, terminal. There are two other "retries" that aren't network retries: the tool-call loop re-prompts the model for valid JSON, and `FallbackModelProvider` fails over to a different provider. Neither re-sends a failed HTTP request. For a local single-user daemon that's fine; a remote or flaky wire would want retry-with-backoff-and-jitter on idempotent calls.

## See also

- `03-tcp-udp-connections-and-sockets.md` — the socket the timeout would bound
- `06-websockets-sse-streaming-and-realtime.md` — backpressure on the NDJSON stream
- `08-networking-red-flags-audit.md` — the timeout gap ranked #1
- `00-overview.md` — retries/pooling/backpressure under `not yet exercised`
