# 08 — Networking red-flags audit

**Industry name(s):** protocol/network-failure risk audit. **Type:** Project-specific.

## Zoom out — where this concept lives

This is the verdict file: every networking risk in the repo, ranked by consequence, each grounded in real `file:line`. It spans both boundaries from the network map.

```
  Zoom out — risks live at the two boundaries

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  stream: no resume, no client timeout                      │ ← risks here
  └───────────────────────────┬────────────────────────────────┘
                              │ boundary 1 (NDJSON, repo-owned)
  ┌─ Service (Node) ──────────▼────────────────────────────────┐
  │  fallback: 429-blind, no backoff, no circuit breaker        │ ← and here
  └───────────────────────────┬────────────────────────────────┘
                              │ boundary 2 (SDK-owned)
  ┌─ Provider ────────────────▼────────────────────────────────┐
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

The honest framing: AptKit is a single-user dev/preview tool, so most "networking risks" are *correctly accepted* trades, not bugs. This audit ranks them by what would actually bite — and, critically, separates "real risk for this repo's purpose" from "would matter only at a scale the repo doesn't target." Each item names the evidence and the move that closes it.

## The ranked findings

```
  Risk ranking — consequence, for THIS repo's purpose

  ┌──────────────────────────────────────────────────────────┐
  │ R1  429-blind failover (no backoff/Retry-After)   MEDIUM  │
  │ R2  No client-side stream timeout                 MEDIUM  │
  │ R3  Stream has no resume after a drop             LOW-MED │
  │ R4  No app-visible timeout on provider call       LOW     │
  │ R5  No circuit breaker                            LOW     │
  │ R6  Plaintext connection 1 (dev-only)             LOW*    │
  └──────────────────────────────────────────────────────────┘
  * LOW for dev; becomes HIGH the day Studio is deployed as-is
```

### R1 — 429-blind failover (MEDIUM)

**What.** `FallbackModelProvider.complete()` treats every non-abort error identically: a 429 rate-limit triggers the same "switch provider" move as a 500. No backoff, no `Retry-After` honored, no per-status logic. **Evidence:** `packages/providers/fallback/src/fallback-provider.ts:64-85` — the catch block records the attempt and continues regardless of error type. **Consequence:** under sustained load, a 429 on the primary immediately shifts all traffic to the fallback, which can then *also* 429 — both providers' quotas exhaust in lockstep instead of one backing off and recovering. **Why accepted today:** two providers with independent quota + no sustained traffic means switching is a fine 429 response, and per-status logic is unneeded complexity for a single-user tool. **The move:** add a 429-aware policy in the existing `shouldFallback(error, provider)` predicate (`fallback-provider.ts:13,73`) — on 429, back off and retry the same provider per `Retry-After` before failing over. One-predicate change; the seam is already there.

### R2 — No client-side stream timeout (MEDIUM)

**What.** The browser's stream-read loop (`responseBodyChunks`, `api.ts:169-180`) awaits `reader.read()` with no timeout. If the server stalls mid-stream (agent loop wedged, provider hung past the SDK's timeout in a way that doesn't propagate), the loop waits indefinitely and the panel hangs with no error. **Evidence:** `apps/studio/src/api.ts:172` — `await reader.read()` in an unbounded `while (true)`. The `runReplayStream` `fetch` call (`api.ts:126`) also passes no `signal`, so there's no wired way to abort a wedged stream from the UI. **Consequence:** a stuck run shows as a frozen panel rather than a timeout error; the user has to reload. **Why partly accepted:** the server's `finally { res.end() }` (`vite.config.ts:916`) closes the stream on most failures, which unblocks the reader — so this only bites when the server stalls *without* throwing. **The move:** thread an `AbortSignal` into the `runReplayStream` fetch (the `decodeNdjsonStream` decoder already supports `signal` — `ndjson-stream.ts:25`) and drive it from a UI timeout or a cancel button.

### R3 — Stream has no resume after a drop (LOW-MEDIUM)

**What.** If connection 1 drops mid-run, there's no recovery — no last-event-id, no reconnect, no replay of missed records. The client throws "ended without a result" (`api.ts:164`) and the run is lost. **Evidence:** the NDJSON protocol carries no sequence/offset; `runReplayStream` has no reconnect path (`api.ts:119-166`). **Consequence:** a transient network blip on a long run discards all progress; the user re-runs from scratch. **Why accepted:** this is the explicit trade for choosing NDJSON over SSE (file `06`) — SSE's `EventSource` gives auto-reconnect + `Last-Event-ID` for free, but its GET-only constraint conflicts with the POST-body requirement. For a localhost dev loop where connection 1 rarely drops, no-resume is fine. **The move:** only if Studio is deployed over a flaky network — then add sequence numbers to records and a resume endpoint, or switch boundary 1 to SSE and move the body into query/init.

### R4 — No app-visible timeout on the provider call (LOW)

**What.** The repo sets no timeout on `provider.complete()`; it relies entirely on the SDK's default request timeout. **Evidence:** `openai-provider.ts:39-48` / `anthropic-provider.ts:29-39` pass only `signal` as request options — no `timeout`. The client constructors set none either (`openai-provider.ts:30`). **Consequence:** a hung provider call blocks until the SDK's default timeout fires; the app can't tune that window per-capability. **Why accepted:** the SDK default is sane, and the `AbortSignal` path gives the app a way to cancel out-of-band anyway. **The move:** if a capability needs a tighter bound, pass `timeout` to the SDK client constructor or wrap the call in an `AbortSignal` + timer.

### R5 — No circuit breaker (LOW)

**What.** A provider that fails every call still gets tried on every run (after the previous provider in the chain fails). There's no trip/cooldown state that stops hammering a known-down provider. **Evidence:** `fallback-provider.ts:47` — the loop is stateless across calls; `lastSelectedProvider` is recorded but not used to skip a recently-failed provider. **Consequence:** wasted latency + cost retrying a dead provider on every run. **Why accepted:** two providers + low call volume means the wasted attempt is one failed request, not a cascade; a circuit breaker's half-open/trip machinery is overkill. **The move:** relevant only at volume — track per-provider failure counts and skip a tripped provider for a cooldown window.

### R6 — Plaintext connection 1 (LOW for dev, HIGH if deployed)

**What.** The browser↔Node connection is plain HTTP (`http://localhost:4187`), no TLS. **Evidence:** relative-URL fetches (`api.ts:126`) against a plain-HTTP Vite dev server; baseURL `http://127.0.0.1:4187` in `playwright.studio.config.ts:10`. **Consequence in dev:** none — same machine, nothing to eavesdrop. **Consequence if deployed as-is:** the stream (and any future credential on it) would cross the network in cleartext. **Why accepted:** Studio is explicitly a dev/preview tool, not a deployed service. **The move:** before any deployment, terminate TLS on connection 1 (proxy or HTTPS server) and re-check the `x-accel-buffering` header against the chosen proxy (file `05`).

## Lens coverage — every networking topic, walked

```
  Audit coverage — was every lens checked?

  DNS / addressing ........ delegated (SDK + OS); no repo hostname  [02]
  TCP / sockets ........... conn1 long-held (res.end), conn2 pooled  [03]
  TLS / trust ............. conn2 SDK-owned; conn1 plaintext dev      [04]
  HTTP semantics .......... repo-authored on conn1; 405/400/headers   [05]
  caching ................. no-cache + x-accel-buffering on stream    [05]
  CORS .................... not yet exercised (same-origin)           [05]
  WebSocket ............... not yet exercised (uses NDJSON)           [06]
  SSE ..................... not yet exercised (uses NDJSON over POST)  [06]
  chunked streaming ....... BUILT — the repo's one protocol           [06]
  timeouts ................ delegated to SDK; no app timeout (R4)     [07]
  retries ................. SDK-level only; app does failover (R1)    [07]
  backoff / jitter ........ not yet exercised (R1)                    [07]
  connection pooling ...... delegated to SDK; untuned                 [03,07]
  HTTP/2 .................. not yet exercised                         [overview]
  backpressure ............ bounded by maxTurns, not transport        [07]
  circuit breaker ......... not yet exercised (R5)                    [07]
  cancellation ............ BUILT — AbortSignal end to end            [07]
```

## The honest summary

Two real things to fix *if the use case grows*: R1 (429-blind failover) and R2 (no client stream timeout). Both have a designed seam to fix them in (`shouldFallback`, and the decoder's `signal` support) — neither is a redesign. Everything else is either delegated correctly (DNS, TLS, pooling, SDK retries) or an accepted trade for a single-user dev tool (no resume, no circuit breaker, plaintext dev). The one item that flips from LOW to HIGH on a single decision is R6 — the day someone deploys Studio without adding TLS to connection 1. The repo's networking is small, honest, and correctly delegated; the risks are mostly "what you'd add at scale," not "what's broken now."

## Interview defense

**Q: What's the most consequential networking risk in this repo?**

```
  R1: failover treats 429 like any error → both quotas exhaust in lockstep
```

The fallback chain is 429-blind — it switches providers on a rate-limit instead of backing off (`fallback-provider.ts:64-85`). At volume that drains both providers' quotas together. It's MEDIUM not HIGH because two independent-quota providers + low traffic makes switching reasonable today, and the fix is a one-predicate change in the existing `shouldFallback` hook. **Anchor:** the gap is real but gated, and the seam to close it already exists.

**Q: Which risk would you escalate before any deployment?**

R6 — connection 1 is plaintext HTTP. Fine on localhost, but deploying as-is sends the stream in cleartext. TLS termination on connection 1 is the gate. **Anchor:** LOW in dev, HIGH the moment it ships.

## Validate

1. **Reconstruct:** Rank R1–R6 and give the one-line consequence of each.
2. **Explain:** Why is R1 MEDIUM and not HIGH for this repo? (Two independent-quota providers + no sustained load + a gated one-predicate fix.)
3. **Apply:** A deployed Studio hangs panels under load. Which two findings are likely in play? (R2 no client timeout + R1 cascading 429s.)
4. **Defend:** Justify accepting R3 (no stream resume). (Explicit NDJSON-over-SSE trade for the POST-body requirement; localhost rarely drops connection 1.)

## See also

- `00-overview.md` — the `not yet exercised` table these risks map to
- `06-websockets-sse-streaming-and-realtime.md` — R3's NDJSON-vs-SSE trade in full
- `07-timeouts-retries-pooling-and-backpressure.md` — R1/R2/R4/R5 mechanics
- study-security — R6 and the API-key boundary judged for safety
- study-distributed-systems — R1/R5 as partial-failure handling at scale
