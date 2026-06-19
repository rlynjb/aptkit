# Study — Networking (AptKit)

What actually happens on the wire in this repo, where it can fail, and which protocol semantics the code leans on.

The honest one-line verdict up front: **AptKit hand-rolls almost no network code.** Two vendor SDKs (`@anthropic-ai/sdk`, `openai`) own every byte that crosses a TLS socket to a model API — DNS, TCP, TLS, HTTP framing, connection reuse all live inside them. The repo's *own* networking is exactly one thing it built itself: a chunked **NDJSON-over-HTTP** stream between the Studio Vite dev server and the browser, plus an application-level **provider fallback chain** that decides what to do when an SDK call throws. That's the whole surface. This guide teaches the protocols underneath all of it and is honest about everything the repo does not yet exercise.

## Reading order

```
  00-overview.md                          ← start here: the on-the-wire map + ranked findings
  01-network-map.md                       the full path, every boundary, every hop
  02-dns-routing-and-addressing.md        how api.anthropic.com / localhost resolve (SDK + Vite own it)
  03-tcp-udp-connections-and-sockets.md   the sockets underneath, who opens/closes them
  04-tls-and-trust-establishment.md       HTTPS to providers, plain HTTP for the dev loop
  05-http-semantics-caching-and-cors.md   methods, status codes, headers, no-cache, same-origin
  06-websockets-sse-streaming-and-realtime.md  the NDJSON chunked stream (NOT WS/SSE) — the built piece
  07-timeouts-retries-pooling-and-backpressure.md  cancellation via AbortSignal, fallback vs backoff
  08-networking-red-flags-audit.md        ranked risks grounded in real file:line
```

Each concept file follows the shared `format.md` template: Zoom out → Structure pass → How it works → Primary diagram → Implementation → Elaborate → Interview defense → Validate → See also.

## The two pieces of real network code

```
  AptKit networking — the entire surface

  ┌─ delegated (you wrote zero bytes of wire code) ──────────────┐
  │  agent loop → ModelProvider.complete() → vendor SDK          │
  │                                            │                  │
  │                            HTTPS POST to api.anthropic.com /  │
  │                            api.openai.com  (SDK owns it all)  │
  └──────────────────────────────────────────────────────────────┘

  ┌─ built (the repo's own protocol) ────────────────────────────┐
  │  Vite middleware → res.write(ndjson) → browser fetch() →     │
  │  decodeNdjsonStream() reassembles records as they arrive      │
  └──────────────────────────────────────────────────────────────┘
```

## Cross-links to neighboring guides

- **study-runtime-systems** — the async I/O underneath every `await provider.complete()`, the event loop, and `AbortSignal` cancellation plumbing. Networking is where that I/O goes; runtime-systems is how it's scheduled.
- **study-system-design** — the `ModelProvider` abstraction, the capability seam, and the NDJSON client/server handoff as an *architectural* boundary (this guide treats the same handoff as a *protocol*).
- **study-distributed-systems** — provider failover as partial-failure handling across external systems; `ProviderFallbackError` as the give-up semantics.
- **study-security** — whether the trust boundaries here are safe (API keys, the path-traversal guard on `/api/replay/save`). This guide describes *what crosses* the boundary; security judges *whether it's safe*.

## Honesty markers

Topics labelled `not yet exercised` in `00-overview.md` and the audit are absent on purpose, not by oversight: explicit DNS handling, manual TLS config, connection-pool tuning, HTTP/2, WebSocket, SSE, 429/rate-limit backoff, and circuit breakers. The repo either delegates them to a dependency or genuinely doesn't have the mechanism. Where a topic is delegated, the guide teaches the protocol and names the SDK that owns it. Where it's absent, the guide says when it would become relevant.
