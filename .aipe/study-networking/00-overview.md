# 00 — Overview: AptKit on the wire

## The whole system in one frame

Before any single concept, here's every place a byte leaves a process in this repo. Three network boundaries now — the third (local Ollama) is new this session.

```
  AptKit — every network boundary in the system

  ┌─ Browser (Studio UI) ───────────────────────────────────────┐
  │  React panel → fetch('/api/stream/replay', POST)            │
  └───────────────────────────┬──────────────────────────────────┘
                              │  BOUNDARY 1: HTTP, plain (localhost dev)
                              │  request: JSON body  ▼  response: chunked NDJSON
  ┌─ Node (Vite dev server) ──▼──────────────────────────────────┐
  │  configureServer middleware → runReplay() → agent loop       │
  │       │                              │                        │
  │       │ ModelProvider.complete()     │ Gemma/Ollama embed     │
  └───────┼──────────────────────────────┼────────────────────────┘
          │  B2: HTTPS, TLS (SDK)         │  B3: HTTP, plain (NEW)
          ▼                               ▼  repo-owned fetch
  ┌─ Cloud provider ─────────────┐  ┌─ Local Ollama daemon ───────┐
  │  api.anthropic.com           │  │  http://localhost:11434     │
  │  api.openai.com   (keyed,TLS)│  │  /api/chat · /api/embed     │
  └──────────────────────────────┘  └──────────────────────────────┘
```

Boundary 1 is a protocol the repo *wrote* (NDJSON stream). Boundary 2 is delegated end-to-end to a vendor SDK (cloud, keyed, TLS). **Boundary 3 is new and important: the repo *wrote the HTTP client itself*** — a plain `fetch` to a local Ollama daemon, no SDK, no auth, no TLS. So the repo now has two opposite postures toward a model API: delegate the wire (B2) or own the wire (B3). That contrast is the spine of the updated guide.

## Verdict first — what to look at, ranked

You came here asking "what's the networking story?" Here's the call before the breakdown.

1. **The repo delegates HTTP to *cloud* model APIs — but now hand-rolls it to the *local* one.** `AnthropicModelProvider.complete()` calls `this.client.messages.create(...)`; `OpenAIModelProvider.complete()` calls `this.client.chat.completions.create(...)`. The SDK owns DNS resolution, the TCP socket, the TLS handshake, HTTP/1.1 framing, keep-alive reuse, and its own retry policy. **The new contrast:** `GemmaModelProvider` and `OllamaEmbeddingProvider` do *not* delegate — they call `fetch()` against `http://localhost:11434` directly (`gemma-provider.ts:204`, `ollama-embedding-provider.ts:63`), and the repo itself writes the request body, checks `res.ok`, and throws on non-2xx (`if (!res.ok) throw new Error(\`ollama HTTP ${res.status}...\`)`). So the right framing is no longer "the repo writes no socket code" — it's "the repo delegates the wire for cloud (keyed, TLS) and owns the wire for local (no auth, plaintext)." Same `ModelProvider` contract, two networking postures.

2. **The one protocol the repo built itself is chunked NDJSON over HTTP** — `apps/studio/vite.config.ts:887` (`streamReplayResponse`) writes newline-delimited JSON records to an open `res`, and the browser reassembles them with `decodeNdjsonStream` (`packages/runtime/src/ndjson-stream.ts:103`). This is NOT WebSocket and NOT Server-Sent Events. It's a plain HTTP response that never closes until the work is done, streaming `{type:'event'}` records as the agent loop runs and a final `{type:'result'}` record at the end. The most load-bearing line is `res.setHeader('x-accel-buffering', 'no')` — without it a reverse proxy would buffer the whole response and the "realtime" trace would arrive all at once at the end.

3. **Network failure is handled at the application layer, not the transport layer.** `FallbackModelProvider.complete()` (`packages/providers/fallback/src/fallback-provider.ts:47`) tries providers in order; when one throws, it records the attempt and moves to the next. The surprising-but-correct choice: it does **not** distinguish a 429 rate-limit from a 500 from a DNS failure from a timeout. Any error that isn't an abort triggers the same move — fall to the next provider. There's no backoff, no jitter, no circuit breaker. For a two-provider chain that's the right call; the next section is honest about where it stops scaling.

4. **Cancellation is the repo's cleanest network primitive.** `AbortSignal` threads from the agent loop (`run-agent-loop.ts:103`) through `ModelRequest.signal` (`model-provider.ts:45`) into the SDK call, and independently through `decodeNdjsonStream`'s `signal?.throwIfAborted()` checks (`ndjson-stream.ts:112,123`). One signal aborts both the upstream HTTPS request and the downstream stream decode.

5. **Same-origin, single-port, dev-only.** Studio runs on one Vite dev server (port 4187 in the Playwright config, `playwright.studio.config.ts:10`). The browser and the API live at the same origin, so there is no CORS, no preflight, no cross-origin cookie story. This is a preview/replay tool, not a deployed service.

6. **The local Ollama boundary trades TLS+auth for locality — and that's the whole point.** Boundary 3 is plain HTTP with no `Authorization` header (`gemma-provider.ts:201-215`, `ollama-embedding-provider.ts:60-74`). Unlike boundary 1 (browser↔Node, same process tree), boundary 3 crosses to a *separate process* — the Ollama daemon — but still on `localhost`, so the bytes never leave the machine. No key is needed because Ollama trusts anything that can reach its port; no TLS because there's no network to eavesdrop. The surprising-but-correct consequence: the dimension contract (`OllamaEmbeddingProvider.dimension = 768`, `ollama-embedding-provider.ts:40`) is a *one-way door* enforced at wiring time (`pipeline.ts:22`), not on the wire — a corpus embedded at 768-dim can only be queried by a 768-dim provider. The transport is dumb; the safety is in the wiring assertion. **What's notably absent:** no timeout on either `fetch`, so a wedged Ollama daemon hangs the call until the caller's `AbortSignal` fires (Gemma threads `signal`; the embedder threads it too — `ollama-embedding-provider.ts:55`). See `07` and `08`.

   **New caller, same wire (`@aptkit/memory`):** `conversation-memory.ts` adds episodic memory but opens **no socket of its own** — it imports only *types* from `@aptkit/retrieval` (`import type { EmbeddingProvider, VectorStore, VectorHit }`, `conversation-memory.ts:1`) and reaches the network solely through the injected `EmbeddingProvider`. In practice that's `OllamaEmbeddingProvider`, so every `remember(turn)` is one `embed([formatted])` round-trip and every `recall(query)` is one `embed([query])` round-trip — both POST `/api/embed` (`conversation-memory.ts:76,90`). This is a new *consumer* of boundary 3's embed transport, not a new boundary or protocol: same plaintext localhost `fetch`, same missing timeout, same dimension one-way door (memory asserts `embedder.dimension === store.dimension` at construction, `conversation-memory.ts:62`). Nothing networking-specific to learn here beyond "the embed wire now has one more caller."

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

When the configured provider is Gemma instead of a cloud SDK, hops 2/3 change shape: they become a repo-owned `fetch POST http://localhost:11434/api/chat` returning a single non-streaming JSON body (`{ message: { content } }`), and Gemma may make *up to `maxToolCallAttempts`* (default 2) round-trips *per agent turn* — one for the tool call, plus a retry with a corrective nudge if the JSON came back malformed (`gemma-provider.ts:62-89`). The embedding path is its own hop: `fetch POST :11434/api/embed` for `nomic-embed-text`, one request returning a `number[][]` of 768-dim vectors.

## `not yet exercised` — named honestly

These are absent because the repo delegates them or genuinely lacks the mechanism. Each entry says when it would matter.

| Topic | Status | When it becomes relevant |
| --- | --- | --- |
| Explicit DNS handling / caching | `not yet exercised` | The OS + SDK resolve `api.openai.com`; boundary 3's `localhost` resolves to the loopback (`127.0.0.1`) with no real DNS lookup. No repo code touches a hostname-to-IP step. |
| Manual TLS config (cert pinning, custom CA, mTLS) | `not yet exercised` | Would matter for a corporate proxy or a self-hosted gateway. The SDK uses Node's default trust store; boundary 3 runs no TLS at all (plaintext localhost). |
| Connection pooling / keep-alive tuning | `not yet exercised` (delegated/default) | The SDK's HTTP agent pools sockets; the repo never sets `maxSockets` or `keepAlive`. Boundary 3's `fetch` uses Node's global undici pool with defaults — the repo tunes nothing. Relevant at high request concurrency, which a single-user Studio doesn't hit. |
| Timeout on the local Ollama `fetch` | `not yet exercised` (notable) | Neither `gemma-provider.ts` nor `ollama-embedding-provider.ts` sets a request timeout; a hung daemon blocks until the caller's `AbortSignal` fires (or forever if none was passed). Relevant the moment a stalled local model should fail fast. See `07`/`08`. |
| Auth / TLS on boundary 3 | `not yet exercised` (by design) | Ollama trusts any local caller and runs plaintext. Would matter only if Ollama were exposed off-host (a remote inference box), at which point boundary 3 would need a key and TLS like boundary 2. |
| pgvector / Supabase transport (Postgres wire, pooling, DB TLS) | `not yet exercised` (lives in `buffr`) | The retrieval package ships only `InMemoryVectorStore`; the planned pgvector-over-Supabase path (`docs/gemma-rag-supabase-plan.md`) is a *separate repo's* network surface, not AptKit's. |
| HTTP/2 | `not yet exercised` | Provider APIs and the SDK may negotiate it, but no repo code depends on multiplexing. |
| WebSocket | `not yet exercised` | The repo uses one-way chunked HTTP instead. A bidirectional realtime feature (live client→server commands mid-stream) would need it. |
| Server-Sent Events (SSE) | `not yet exercised` | The closest *standard* to what the repo built. AptKit chose raw NDJSON over `text/event-stream` — see `06`. SSE would buy auto-reconnect and `EventSource` in the browser for free. |
| Rate-limit (429) backoff / `Retry-After` | `not yet exercised` (notable) | The fallback chain switches provider on *any* error including 429, rather than backing off and retrying the same provider. Honest gap — see `07` and `08`. |
| Circuit breaker | `not yet exercised` | With only two providers and no sustained traffic, there's no half-open/trip state to manage. Relevant once a provider's failures should stop being retried for a cooldown window. |

## Where to go next

- The full path and boundary inventory: `01-network-map.md`
- The piece the repo actually built: `06-websockets-sse-streaming-and-realtime.md`
- The honest risk ranking: `08-networking-red-flags-audit.md`
