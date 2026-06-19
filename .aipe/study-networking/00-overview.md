# 00 — Overview: AptKit on the wire

## The whole system in one frame

Before any single concept, here's every place a byte leaves a process in this repo. Two network boundaries, full stop.

```
  AptKit — every network boundary in the system

  ┌─ Browser (Studio UI) ───────────────────────────────────────┐
  │  React panel → fetch('/api/stream/replay', POST)            │
  └───────────────────────────┬──────────────────────────────────┘
                              │  BOUNDARY 1: HTTP, plain (localhost dev)
                              │  request: JSON body  ▼  response: chunked NDJSON
  ┌─ Node (Vite dev server) ──▼──────────────────────────────────┐
  │  configureServer middleware → runReplay() → agent loop       │
  │       │                                                       │
  │       │  ModelProvider.complete(request)                      │
  └───────┼───────────────────────────────────────────────────────┘
          │  BOUNDARY 2: HTTPS, TLS 1.2/1.3 (SDK owns every byte)
          ▼
  ┌─ Provider (Anthropic / OpenAI API) ──────────────────────────┐
  │  api.anthropic.com  /  api.openai.com                        │
  └───────────────────────────────────────────────────────────────┘
```

Boundary 1 is the only protocol the repo *wrote*. Boundary 2 is delegated end-to-end to a vendor SDK. Everything in this guide hangs off these two lines.

## Verdict first — what to look at, ranked

You came here asking "what's the networking story?" Here's the call before the breakdown.

1. **The repo does not hand-roll HTTP to model APIs. It delegates.** `AnthropicModelProvider.complete()` calls `this.client.messages.create(...)`; `OpenAIModelProvider.complete()` calls `this.client.chat.completions.create(...)`. The SDK owns DNS resolution, the TCP socket, the TLS handshake, HTTP/1.1 framing, keep-alive reuse, and its own retry policy. The repo's contribution at this boundary is *one thing*: it forwards `request.signal` so an abort propagates into the in-flight HTTP request. This is the most important fact in the whole guide — don't go looking for socket code that isn't there.

2. **The one protocol the repo built itself is chunked NDJSON over HTTP** — `apps/studio/vite.config.ts:887` (`streamReplayResponse`) writes newline-delimited JSON records to an open `res`, and the browser reassembles them with `decodeNdjsonStream` (`packages/runtime/src/ndjson-stream.ts:103`). This is NOT WebSocket and NOT Server-Sent Events. It's a plain HTTP response that never closes until the work is done, streaming `{type:'event'}` records as the agent loop runs and a final `{type:'result'}` record at the end. The most load-bearing line is `res.setHeader('x-accel-buffering', 'no')` — without it a reverse proxy would buffer the whole response and the "realtime" trace would arrive all at once at the end.

3. **Network failure is handled at the application layer, not the transport layer.** `FallbackModelProvider.complete()` (`packages/providers/fallback/src/fallback-provider.ts:47`) tries providers in order; when one throws, it records the attempt and moves to the next. The surprising-but-correct choice: it does **not** distinguish a 429 rate-limit from a 500 from a DNS failure from a timeout. Any error that isn't an abort triggers the same move — fall to the next provider. There's no backoff, no jitter, no circuit breaker. For a two-provider chain that's the right call; the next section is honest about where it stops scaling.

4. **Cancellation is the repo's cleanest network primitive.** `AbortSignal` threads from the agent loop (`run-agent-loop.ts:103`) through `ModelRequest.signal` (`model-provider.ts:45`) into the SDK call, and independently through `decodeNdjsonStream`'s `signal?.throwIfAborted()` checks (`ndjson-stream.ts:112,123`). One signal aborts both the upstream HTTPS request and the downstream stream decode.

5. **Same-origin, single-port, dev-only.** Studio runs on one Vite dev server (port 4187 in the Playwright config, `playwright.studio.config.ts:10`). The browser and the API live at the same origin, so there is no CORS, no preflight, no cross-origin cookie story. This is a preview/replay tool, not a deployed service.

## The on-the-wire path, condensed

```
  One Studio replay run — the full network trip

  browser fetch POST /api/stream/replay
    │  hop 1: HTTP request, JSON body {fixtureId, mode}
    ▼
  Vite middleware (Node)
    │  hop 2: HTTPS POST (SDK) → api.openai.com  ── per model turn
    ▼  hop 3: HTTPS 200 + JSON body ◄── per model turn
  agent loop emits CapabilityEvent
    │  hop 4: res.write(ndjson record) ── streamed as each event fires
    ▼
  browser decodeNdjsonStream yields records live
    │  hop 5: res.end() after final {type:'result'}
    ▼
  panel renders trace + result
```

Hops 2/3 repeat once per model turn (up to `maxTurns`, e.g. 6 for the recommendation agent). Hop 4 fires every time the agent loop emits a `step` / `tool_call_*` / `model_usage` event — that's what makes the trace appear live in the UI instead of all at once.

## `not yet exercised` — named honestly

These are absent because the repo delegates them or genuinely lacks the mechanism. Each entry says when it would matter.

| Topic | Status | When it becomes relevant |
| --- | --- | --- |
| Explicit DNS handling / caching | `not yet exercised` | Only if the repo stopped delegating to the SDK and opened sockets itself. The OS + SDK resolve `api.openai.com`; no repo code touches a hostname-to-IP step. |
| Manual TLS config (cert pinning, custom CA, mTLS) | `not yet exercised` | Would matter for a corporate proxy or a self-hosted gateway. The SDK uses Node's default trust store. |
| Connection pooling / keep-alive tuning | `not yet exercised` (delegated) | The SDK's HTTP agent pools sockets; the repo never sets `maxSockets` or `keepAlive`. Relevant at high request concurrency, which a single-user Studio doesn't hit. |
| HTTP/2 | `not yet exercised` | Provider APIs and the SDK may negotiate it, but no repo code depends on multiplexing. |
| WebSocket | `not yet exercised` | The repo uses one-way chunked HTTP instead. A bidirectional realtime feature (live client→server commands mid-stream) would need it. |
| Server-Sent Events (SSE) | `not yet exercised` | The closest *standard* to what the repo built. AptKit chose raw NDJSON over `text/event-stream` — see `06`. SSE would buy auto-reconnect and `EventSource` in the browser for free. |
| Rate-limit (429) backoff / `Retry-After` | `not yet exercised` (notable) | The fallback chain switches provider on *any* error including 429, rather than backing off and retrying the same provider. Honest gap — see `07` and `08`. |
| Circuit breaker | `not yet exercised` | With only two providers and no sustained traffic, there's no half-open/trip state to manage. Relevant once a provider's failures should stop being retried for a cooldown window. |

## Where to go next

- The full path and boundary inventory: `01-network-map.md`
- The piece the repo actually built: `06-websockets-sse-streaming-and-realtime.md`
- The honest risk ranking: `08-networking-red-flags-audit.md`
