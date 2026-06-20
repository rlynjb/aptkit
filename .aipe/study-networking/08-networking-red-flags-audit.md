# 08 — Networking red-flags audit

**Industry name(s):** protocol/network-failure risk audit. **Type:** Project-specific.

## Zoom out — where this concept lives

This is the verdict file: every networking risk in the repo, ranked by consequence, each grounded in real `file:line`. It spans both boundaries from the network map.

```
  Zoom out — risks live at all three boundaries

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  stream: no resume, no client timeout (R2,R3)              │ ← risks here
  └───────────────────────────┬────────────────────────────────┘
                              │ boundary 1 (NDJSON, repo-owned)
  ┌─ Service (Node) ──────────▼────────────────────────────────┐
  │  fallback: 429-blind, no backoff, no circuit breaker (R1,R5)│ ← and here
  └──────────┬───────────────────────────────┬─────────────────┘
             │ boundary 2 (SDK-owned)         │ boundary 3 (repo fetch)
  ┌─ Cloud ──▼───────────────┐  ┌─ Ollama ────▼────────────────┐
  │ no app timeout (R4)      │  │ no fetch timeout (R7)        │ ← and here (NEW)
  │                          │  │ plaintext+keyless off-box(R8)│
  └──────────────────────────┘  └──────────────────────────────┘
```

## Zoom in — narrow to the concept

The honest framing: AptKit is a single-user dev/preview tool, so most "networking risks" are *correctly accepted* trades, not bugs. This audit ranks them by what would actually bite — and, critically, separates "real risk for this repo's purpose" from "would matter only at a scale the repo doesn't target." Each item names the evidence and the move that closes it.

## The ranked findings

```
  Risk ranking — consequence, for THIS repo's purpose

  ┌──────────────────────────────────────────────────────────┐
  │ R1  429-blind failover (no backoff/Retry-After)   MEDIUM  │
  │ R2  No client-side stream timeout                 MEDIUM  │
  │ R7  No timeout on the local Ollama fetch          MEDIUM  │
  │ R3  Stream has no resume after a drop             LOW-MED │
  │ R8  Boundary 3 plaintext+keyless if host off-box  LOW**   │
  │ R4  No app-visible timeout on provider call       LOW     │
  │ R5  No circuit breaker                            LOW     │
  │ R6  Plaintext connection 1 (dev-only)             LOW*    │
  └──────────────────────────────────────────────────────────┘
  * LOW for dev; becomes HIGH the day Studio is deployed as-is
  ** LOW while Ollama is localhost; HIGH the moment host points off-machine
```

### R1 — 429-blind failover (MEDIUM)

**What.** `FallbackModelProvider.complete()` treats every non-abort error identically: a 429 rate-limit triggers the same "switch provider" move as a 500. No backoff, no `Retry-After` honored, no per-status logic. **Evidence:** `packages/providers/fallback/src/fallback-provider.ts:64-85` — the catch block records the attempt and continues regardless of error type. **Consequence:** under sustained load, a 429 on the primary immediately shifts all traffic to the fallback, which can then *also* 429 — both providers' quotas exhaust in lockstep instead of one backing off and recovering. **Why accepted today:** two providers with independent quota + no sustained traffic means switching is a fine 429 response, and per-status logic is unneeded complexity for a single-user tool. **The move:** add a 429-aware policy in the existing `shouldFallback(error, provider)` predicate (`fallback-provider.ts:13,73`) — on 429, back off and retry the same provider per `Retry-After` before failing over. One-predicate change; the seam is already there.

### R2 — No client-side stream timeout (MEDIUM)

**What.** The browser's stream-read loop (`responseBodyChunks`, `api.ts:169-180`) awaits `reader.read()` with no timeout. If the server stalls mid-stream (agent loop wedged, provider hung past the SDK's timeout in a way that doesn't propagate), the loop waits indefinitely and the panel hangs with no error. **Evidence:** `apps/studio/src/api.ts:172` — `await reader.read()` in an unbounded `while (true)`. The `runReplayStream` `fetch` call (`api.ts:126`) also passes no `signal`, so there's no wired way to abort a wedged stream from the UI. **Consequence:** a stuck run shows as a frozen panel rather than a timeout error; the user has to reload. **Why partly accepted:** the server's `finally { res.end() }` (`vite.config.ts:916`) closes the stream on most failures, which unblocks the reader — so this only bites when the server stalls *without* throwing. **The move:** thread an `AbortSignal` into the `runReplayStream` fetch (the `decodeNdjsonStream` decoder already supports `signal` — `ndjson-stream.ts:25`) and drive it from a UI timeout or a cancel button.

### R7 — No timeout on the local Ollama fetch (MEDIUM)

**What.** Both repo-owned transports to Ollama call `fetch` with no timeout. If the daemon accepts the connection but never responds (model still loading, OOM, stuck generation), the `await fetch(...)` blocks. **Evidence:** `packages/providers/gemma/src/gemma-provider.ts:202-215` and `packages/retrieval/src/ollama-embedding-provider.ts:60-74` — each `fetch` passes `method`/`headers`/`body`/`signal` only, no `timeout` and no `dispatcher`. Unlike the cloud SDKs, there is no built-in default timeout underneath to backstop it. **Consequence:** a wedged local model hangs the call. Gemma threads `request.signal` and the embedder threads `options.signal`, so a *caller-driven* cancel can unwedge it — but a bare `embedder.embed(texts)` with no options has no signal and can hang indefinitely. **Why partly accepted:** on localhost the daemon either answers fast or is plainly down (connection refused, which `fetch` rejects on quickly); the indefinite-hang case is the narrow "accepted-then-silent" one. **The move:** wrap each `fetch` in an `AbortSignal.timeout(ms)` (or combine it with the caller's signal via `AbortSignal.any`) so a stuck daemon fails fast instead of hanging. One line per transport; the `signal` plumbing is already there.

### R8 — Boundary 3 is plaintext + keyless if `host` ever points off-box (LOW now, HIGH off-host)

**What.** The Ollama transports send model prompts over plain HTTP with no `Authorization` header. **Evidence:** `gemma-provider.ts:204-209` / `ollama-embedding-provider.ts:62-68` — `fetch` with `content-type: application/json` and nothing else; `host` defaults to `http://localhost:11434` but is a constructor option (`gemma-provider.ts:48`, `ollama-embedding-provider.ts:47`). **Consequence in dev:** none — bytes never leave the machine. **Consequence if `host` is set to a remote box:** prompts (and any sensitive content in them) cross a real network unauthenticated and in cleartext, readable by anyone on the path. **Why accepted today:** Ollama is local; locality *is* the trust model (see `04`). **The move:** if Ollama ever moves off-host, swap the injectable transport (`GemmaChatTransport` / `EmbedTransport`) for an HTTPS+keyed one — the seam exists precisely so this is a transport swap, not a provider rewrite. Until then it's `not yet exercised`.

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

  DNS / addressing ........ delegated (SDK + OS); localhost loopback  [02]
  TCP / sockets ........... conn1 long-held; conn2/conn3 pooled       [03]
  TLS / trust ............. conn2 SDK-owned; conn1+conn3 plaintext    [04]
  hand-rolled HTTP client . BUILT — Gemma/Ollama fetch to :11434      [01,04]
  HTTP semantics .......... repo-authored on conn1 + conn3            [05]
  caching ................. no-cache + x-accel-buffering on stream    [05]
  CORS .................... not yet exercised (same-origin)           [05]
  WebSocket ............... not yet exercised (uses NDJSON)           [06]
  SSE ..................... not yet exercised (uses NDJSON over POST)  [06]
  chunked streaming ....... BUILT — the repo's one stream protocol    [06]
  timeouts ................ SDK has default; Ollama fetch has NONE (R7)[07]
  retries (network) ....... SDK-level (cloud); none for Ollama        [07]
  retries (parse) ......... BUILT — Gemma tool-call re-ask loop       [07]
  backoff / jitter ........ not yet exercised (R1)                    [07]
  connection pooling ...... delegated (SDK + undici); untuned         [03,07]
  HTTP/2 .................. not yet exercised                         [overview]
  backpressure ............ bounded by maxTurns, not transport        [07]
  circuit breaker ......... not yet exercised (R5)                    [07]
  cancellation ............ BUILT — AbortSignal end to end (incl. B3) [07]
  pgvector/Supabase wire .. not yet exercised (lives in buffr)        [overview]
```

## The honest summary

Three real things to fix *if the use case grows*: R1 (429-blind failover), R2 (no client stream timeout), and R7 (no timeout on the local Ollama fetch — the new one). All three have a designed seam to fix them in (`shouldFallback`, the decoder's `signal` support, and the Ollama transports' existing `signal` plumbing) — none is a redesign. Everything else is either delegated correctly (cloud DNS/TLS/pooling/SDK retries) or an accepted trade for a single-user dev tool (no resume, no circuit breaker, plaintext dev). **Two** items now flip from LOW to HIGH on a single config decision: R6 (deploying Studio without TLS on connection 1) and R8 (pointing the Ollama `host` off-machine without adding TLS+auth to boundary 3). The repo's networking is still small and honest, but it grew a hand-rolled HTTP client this session — so "correctly delegated" is no longer the whole story; for the local boundary, the repo owns the wire and therefore owns the timeout and trust gaps too.

## Interview defense

**Q: What's the most consequential networking risk in this repo?**

```
  R1: failover treats 429 like any error → both quotas exhaust in lockstep
```

The fallback chain is 429-blind — it switches providers on a rate-limit instead of backing off (`fallback-provider.ts:64-85`). At volume that drains both providers' quotas together. It's MEDIUM not HIGH because two independent-quota providers + low traffic makes switching reasonable today, and the fix is a one-predicate change in the existing `shouldFallback` hook. **Anchor:** the gap is real but gated, and the seam to close it already exists.

**Q: Which risk would you escalate before any deployment?**

Two, and both flip on a single config decision. R6 — connection 1 is plaintext HTTP; deploying as-is sends the stream in cleartext, so TLS termination on connection 1 is the gate. R8 — boundary 3 is plaintext and keyless; the moment someone points the Ollama `host` at a remote box, prompts cross the network unauthenticated, so an HTTPS+keyed transport is the gate there. **Anchor:** both are LOW in the local/dev shape and HIGH the instant the bytes leave the machine.

**Q: The repo grew a hand-rolled HTTP client this session — what's the cost of owning the wire?**

```
  delegate the wire (cloud SDK) → SDK owns timeout + retries + TLS
  own the wire   (Ollama fetch) → REPO owns them, and skipped two
```

When the repo delegated the cloud wire to an SDK, it inherited a sane default timeout and transient-retry policy for free. Hand-rolling the Ollama `fetch` means the repo now owns those decisions — and it took none of them: no timeout (R7) and no network retry. That's the real cost of owning the wire: the conveniences the SDK gave invisibly become explicit gaps. **Anchor:** owning the wire means owning the timeout — and the repo hasn't yet.

## Validate

1. **Reconstruct:** Rank R1–R6 and give the one-line consequence of each.
2. **Explain:** Why is R1 MEDIUM and not HIGH for this repo? (Two independent-quota providers + no sustained load + a gated one-predicate fix.)
3. **Apply:** A deployed Studio hangs panels under load. Which two findings are likely in play? (R2 no client timeout + R1 cascading 429s.)
4. **Defend:** Justify accepting R3 (no stream resume). (Explicit NDJSON-over-SSE trade for the POST-body requirement; localhost rarely drops connection 1.)

## See also

- `00-overview.md` — the `not yet exercised` table these risks map to
- `04-tls-and-trust-establishment.md` — R8's boundary-3 plaintext+keyless posture in full
- `06-websockets-sse-streaming-and-realtime.md` — R3's NDJSON-vs-SSE trade in full
- `07-timeouts-retries-pooling-and-backpressure.md` — R1/R2/R4/R5/R7 mechanics + Gemma's parse-retry
- study-security — R6/R8 and the API-key + keyless-local boundaries judged for safety
- study-distributed-systems — R1/R5 as partial-failure handling at scale
