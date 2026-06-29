# Study — Networking · Overview

The question this guide answers: **what actually happens on the wire in aptkit, where can it fail, and which protocol semantics does the code rely on?**

Verdict first: aptkit is a TypeScript monorepo whose entire network surface is **one HTTP verb against one local origin** — `POST http://localhost:11434/api/*` to a local Ollama daemon — plus a **dev-only HTTP middleware** in Studio and a **static-asset fetch** from GitHub Pages. The cloud SDKs (Anthropic, OpenAI) carry their own HTTP stacks but aren't reached by the local default path. The durable database wire (`pg` over TCP to Supabase) lives in the companion repo **buffr**, not here. There is no TLS in the hot path, no DNS worth resolving (it's `localhost`), no realtime transport, and — the headline risk — **no per-call timeout on any outbound `fetch`**.

## The whole network surface in one diagram

Every byte aptkit puts on a wire, and where it goes.

```
  aptkit network surface — every origin it talks to

  ┌─ Process: Node (agent / CLI / Studio dev server) ──────────────┐
  │                                                                 │
  │  GemmaModelProvider ───────┐                                    │
  │  OllamaEmbeddingProvider ──┤                                    │
  │       (the client)         │ HTTP POST  (plain, no TLS)         │
  │                            ▼                                    │
  └────────────────────────────┼───────────────────────────────────┘
                               │  loopback only
                  ┌────────────▼────────────┐
                  │  Ollama daemon            │  ← origin: localhost:11434
                  │  /api/chat  /api/embed    │     (same machine)
                  └───────────────────────────┘

  ┌─ Provider SDKs (NOT on the local default path) ────────────────┐
  │  AnthropicModelProvider → api.anthropic.com   (SDK owns wire)  │
  │  OpenAIModelProvider    → api.openai.com      (SDK owns wire)  │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ Studio (apps/studio) ─────────────────────────────────────────┐
  │  dev server: vite middleware  /api/model-status, /api/stream/* │
  │              (HTTP/1.1 on 127.0.0.1:4187, NDJSON streaming)    │
  │  prod build: static assets fetched from GitHub Pages over HTTPS │
  └─────────────────────────────────────────────────────────────────┘

  ┌─ buffr (companion repo, NOT this codebase) ────────────────────┐
  │  pg Pool → Supabase Postgres over TCP (the durable wire)       │
  └─────────────────────────────────────────────────────────────────┘
```

## Ranked findings

1. **No per-call timeout on the Ollama `fetch` — a wedged daemon hangs the agent forever.** Both `defaultHttpTransport` in `packages/providers/gemma/src/gemma-provider.ts:201-215` and `packages/retrieval/src/ollama-embedding-provider.ts:60-75` call `fetch` with only an optional `AbortSignal` and no `AbortController` timeout. The signal threads from `run-agent-loop.ts:91` but nothing ever *fires* it on a deadline. If Ollama accepts the TCP connection and then stalls (model loading, OOM, swap), the `await fetch` never resolves. This is the single highest-consequence network gap. → `07-timeouts-retries-pooling-and-backpressure.md`, `08-networking-red-flags-audit.md`.

2. **The transport is a clean seam (`GemmaChatTransport` / `EmbedTransport`) — network is fully injectable, so tests never touch a socket.** `gemma-provider.ts:19-25` and `ollama-embedding-provider.ts:18-22` define a function-type port; the real `fetch` is just the default adapter. This is the strongest design choice on the network axis: the HTTP boundary is mockable without a server. → `01-network-map.md`, `03-tcp-udp-connections-and-sockets.md`.

3. **One verb, one shape, fail-loud on non-2xx — no retries, no backoff, no idempotency handling.** Every transport is `POST` + `content-type: application/json` + `stream:false`, and `if (!res.ok) throw`. A transient 503 from Ollama is a hard error, not a retry. That's the right call for a single-user local daemon, but it's the first thing that breaks under any flakiness. → `05-http-semantics-caching-and-cors.md`, `07-timeouts-retries-pooling-and-backpressure.md`.

## Reading order

```
  00  overview            ← you are here
  01  network-map         the full on-the-wire path, every boundary
  02  dns-routing         names & addressing (mostly `not yet exercised`)
  03  tcp-udp-sockets     connections, loopback, the fetch socket lifecycle
  04  tls-trust           encryption in transit (`not yet exercised` locally)
  05  http-semantics      methods, status, headers, CORS, caching
  06  websockets-sse      realtime & streaming (NDJSON, not websockets)
  07  timeouts-retries    the timeout gap, pooling, backpressure
  08  red-flags-audit     ranked network-failure risks
```

## `not yet exercised` in this repo

- **DNS resolution** — every outbound call targets `localhost`/`127.0.0.1`; no hostname is ever resolved by aptkit code. (`02`)
- **TLS / certificate trust** — the local Ollama wire is plain HTTP; no `https:` origin, no cert pinning, no termination point in aptkit. Cloud SDK TLS is owned by the vendor SDKs. (`04`)
- **HTTP/2, connection multiplexing, keep-alive tuning** — never configured; left to the Node `fetch` (undici) defaults. (`03`)
- **WebSockets, Server-Sent Events** — no long-lived bidirectional transport. Streaming is one-shot NDJSON over a plain HTTP response in Studio dev, and `stream:false` to Ollama. (`06`)
- **Retries, backoff, jitter, request collapsing, circuit breakers** — none in aptkit's HTTP layer. The `FallbackModelProvider` switches *providers* on error but does not retry a *call*. (`07`)
- **Connection pooling on the HTTP side** — no `Agent`/pool tuning. (Pooling exists only in buffr's `pg.Pool`, a different repo and a different protocol.) (`07`)
- **CORS** — the Studio dev middleware is same-origin; no `Access-Control-*` headers are set. (`05`)

## Cross-links to neighboring guides

- **study-distributed-systems** — partial failure when the Ollama daemon or Supabase is unreachable; the `FallbackModelProvider` chain as a coordination pattern.
- **study-performance-engineering** — latency of the synchronous `await fetch`, the cost of no connection reuse, NDJSON streaming as a time-to-first-byte lever.
- **study-debugging-observability** — the `if (!res.ok) throw` error text is the only network-failure signal; NDJSON trace events as the on-the-wire observability record.
- **study-security** — *whether* the loopback boundary and the (gitignored) API keys are safe; this guide only covers *what's on the wire*.
