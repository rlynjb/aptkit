# Study — Networking (AptKit)

What actually happens on the wire in this repo, where it can fail, and which protocol semantics the code leans on.

The honest one-line verdict up front: **AptKit hand-rolls almost no network code for its *cloud* providers, but it now hand-rolls a real HTTP client for its *local* one.** Two vendor SDKs (`@anthropic-ai/sdk`, `openai`) own every byte that crosses a TLS socket to a cloud model API — DNS, TCP, TLS, HTTP framing, connection reuse all live inside them. The repo's *own* networking is now three things it built itself: (1) a chunked **NDJSON-over-HTTP** stream between the Studio Vite dev server and the browser; (2) an application-level **provider fallback chain** that decides what to do when a provider call throws; and (3) — new this session — a pair of **hand-rolled `fetch` clients to a local Ollama daemon** (`http://localhost:11434`): `GemmaModelProvider` POSTing `/api/chat` and `OllamaEmbeddingProvider` POSTing `/api/embed`, both plaintext, no auth, with the repo writing the request, the non-2xx error path, and (for Gemma) a retry loop itself. This guide teaches the protocols underneath all of it and is honest about everything the repo does not yet exercise.

## Reading order

```
  00-overview.md                          ← start here: the on-the-wire map + ranked findings
  01-network-map.md                       the full path, every boundary, every hop
  02-dns-routing-and-addressing.md        how api.anthropic.com / localhost resolve (SDK + Vite own it)
  03-tcp-udp-connections-and-sockets.md   the sockets underneath, who opens/closes them
  04-tls-and-trust-establishment.md       HTTPS to providers, plain HTTP for the dev loop
  05-http-semantics-caching-and-cors.md   methods, status codes, headers, no-cache, same-origin
  06-websockets-sse-streaming-and-realtime.md  the NDJSON chunked stream (NOT WS/SSE) — the built piece
  07-timeouts-retries-pooling-and-backpressure.md  cancellation via AbortSignal, fallback vs backoff, Gemma's repo-owned retry loop
  08-networking-red-flags-audit.md        ranked risks grounded in real file:line
```

A note on the third boundary: the SDK-vs-hand-rolled contrast is now the guide's sharpest lesson. Anthropic/OpenAI delegate the wire to a vendor SDK (cloud, keyed, TLS); Gemma/Ollama-embeddings own the wire in repo code (localhost, no auth, plaintext). Same `ModelProvider`/`EmbeddingProvider` contract, opposite networking posture. Every file below now contrasts the two.

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

  ┌─ built (the repo's own protocol — boundary 1) ───────────────┐
  │  Vite middleware → res.write(ndjson) → browser fetch() →     │
  │  decodeNdjsonStream() reassembles records as they arrive      │
  └──────────────────────────────────────────────────────────────┘

  ┌─ built (the repo's own HTTP client — boundary 3, NEW) ───────┐
  │  GemmaModelProvider.complete() → fetch POST :11434/api/chat   │
  │  OllamaEmbeddingProvider.embed() → fetch POST :11434/api/embed│
  │  repo writes: request body, non-2xx throw, Gemma retry loop   │
  └──────────────────────────────────────────────────────────────┘
```

## Cross-links to neighboring guides

- **study-runtime-systems** — the async I/O underneath every `await provider.complete()`, the event loop, and `AbortSignal` cancellation plumbing. Networking is where that I/O goes; runtime-systems is how it's scheduled.
- **study-system-design** — the `ModelProvider` abstraction, the capability seam, and the NDJSON client/server handoff as an *architectural* boundary (this guide treats the same handoff as a *protocol*).
- **study-distributed-systems** — provider failover as partial-failure handling across external systems; `ProviderFallbackError` as the give-up semantics.
- **study-security** — whether the trust boundaries here are safe (API keys, the path-traversal guard on `/api/replay/save`). This guide describes *what crosses* the boundary; security judges *whether it's safe*.

## Honesty markers

Topics labelled `not yet exercised` in `00-overview.md` and the audit are absent on purpose, not by oversight: explicit DNS handling, manual TLS config, connection-pool tuning, HTTP/2, WebSocket, SSE, 429/rate-limit backoff, and circuit breakers. The repo either delegates them to a dependency or genuinely doesn't have the mechanism. Where a topic is delegated, the guide teaches the protocol and names the SDK that owns it. Where it's absent, the guide says when it would become relevant.

One scope marker: **pgvector / Supabase networking is not in this repo.** The retrieval package ships only an `InMemoryVectorStore`; any pgvector-over-Postgres transport (a separate TCP wire protocol, connection pooling, TLS to a managed database) lives in the `buffr` repo, not here — see `docs/gemma-rag-supabase-plan.md` for the plan, but it is `not yet exercised` in AptKit's own network surface.
