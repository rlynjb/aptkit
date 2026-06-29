# Study — Networking · Overview

The whole networking surface of aptkit in one page: what crosses a wire, where it can fail, and which protocol semantics the code leans on. This is a curriculum guide — it teaches the transport fundamentals, then anchors each one to the real bytes this repo moves (or honestly marks `not yet exercised` where the repo never touches the wire).

## The honest verdict first

aptkit barely touches the network on purpose. The whole monorepo is built around an **injectable transport seam**: every place that *could* hit the wire takes a function you can swap for a recorded response, so the tests run with zero sockets open. The one place the repo *does* open a socket itself is a plain HTTP `POST` to a local Ollama daemon on `localhost:11434` — no TLS, no DNS, no auth, no proxy. The cloud providers (Anthropic, OpenAI) hand the wire entirely to a vendor SDK, so the repo's own networking code never sees those bytes. The durable database lives in the companion repo **buffr**, which opens a `pg.Pool` to Supabase Postgres.

So the networking story is small and sharp. That is the lesson, not a gap: a system that pushes the wire to the edges and injects it everywhere else is *testable*, and you'll see that pattern repeated in every file here.

```
  aptkit's entire on-the-wire surface — one frame

  ┌─ aptkit (this repo) ──────────────────────────────────────┐
  │                                                            │
  │  GemmaModelProvider ─── fetch POST ──► localhost:11434     │ ← plain HTTP
  │  OllamaEmbeddingProvider ─ fetch POST ─► localhost:11434   │   loopback
  │                                                            │
  │  AnthropicModelProvider ─► @anthropic-ai/sdk ─► (the wire) │ ← SDK owns it
  │  OpenAIModelProvider ────► openai sdk ───────► (the wire)  │   (HTTPS, not us)
  │                                                            │
  │  Studio dev server (vite middleware) ── HTTP+NDJSON ──► browser
  │  Studio static build ──────────────────► GitHub Pages (HTTPS, static)
  └────────────────────────────────────────────────────────────┘
                              │ buffr consumes @rlynjb/aptkit-core
                              ▼
  ┌─ buffr (companion repo) ──────────────────────────────────┐
  │  pg.Pool ──── TCP (pg wire protocol) ──► Supabase Postgres │ ← long-lived
  └────────────────────────────────────────────────────────────┘   pool
```

## Ranked findings — what to look at first

1. **No per-call timeout on the Ollama `fetch` (highest consequence).** Both `GemmaModelProvider`'s `defaultHttpTransport` (`packages/providers/gemma/src/gemma-provider.ts:201-215`) and `OllamaEmbeddingProvider`'s (`packages/retrieval/src/ollama-embedding-provider.ts:60-75`) call `fetch` with no `AbortSignal.timeout`. A wedged Ollama daemon — model still loading, GPU stuck — makes the agent loop hang indefinitely. The only escape is a caller-supplied `request.signal`, which nothing in-repo supplies a deadline for. → `07-timeouts-retries-pooling-and-backpressure.md`, `08-networking-red-flags-audit.md`.

2. **The injectable transport seam is the load-bearing design choice.** `GemmaChatTransport` and `EmbedTransport` are function types the constructor accepts; the real `fetch` is the *default*, not the only path. This is why the entire test suite runs offline and why swapping Ollama for a remote inference server is a one-arg change. It's also the seam where control flips from "in-process pure function" to "bytes on a socket." → `01-network-map.md`, `03-tcp-udp-connections-and-sockets.md`.

3. **The repo offloads all hard networking to dependencies.** TLS, DNS, HTTP/2, connection pooling to cloud APIs, retry/backoff — none of it is in aptkit's code, because the Anthropic/OpenAI SDKs and `pg` own it. That's the right call for a toolkit (don't reimplement an HTTP client), but it means the repo can't *demonstrate* those mechanisms. The files below teach them anyway and label the boundary plainly. → `04-tls-and-trust-establishment.md`, `02-dns-routing-and-addressing.md`.

## Reading order

```
  foundations            00-overview            (you are here)
       ↓
  the map                01-network-map         every boundary, one diagram
       ↓
  addressing             02-dns-routing-and-addressing
       ↓
  transport              03-tcp-udp-connections-and-sockets
       ↓
  encryption             04-tls-and-trust-establishment
       ↓
  application            05-http-semantics-caching-and-cors
       ↓
  realtime               06-websockets-sse-streaming-and-realtime
       ↓
  resilience             07-timeouts-retries-pooling-and-backpressure
       ↓
  the audit              08-networking-red-flags-audit   ranked risks
```

Read top to bottom the first time. After that, `08` is the file you reopen — it's the ranked risk list with evidence.

## `not yet exercised` in this repo

The repo never touches these. Each file below teaches the concept and says exactly when it would become relevant here.

- **DNS resolution** — every endpoint is `localhost` (loopback, no lookup) or hidden inside a vendor SDK / `DATABASE_URL`. → `02`.
- **TLS handshake / certificates / termination** — the only socket aptkit opens is plain HTTP to loopback. TLS exists only inside the SDKs and the `pg` connection in buffr. → `04`.
- **HTTP/2, HTTP/3, connection reuse, keep-alive at the app layer** — aptkit's `fetch` calls are single-shot; reuse is the SDK's job. → `03`, `07`.
- **WebSockets / SSE** — no long-lived bidirectional transport anywhere. Studio's "streaming" is NDJSON over a single HTTP response body, which is a different mechanism (one-way chunked transfer). → `06`.
- **Retries, backoff, jitter, request collapsing, circuit breakers at the HTTP layer** — `FallbackModelProvider` retries across *providers*, not across *network attempts*; there is no transport-level retry. → `07`.
- **Proxies, CDNs, edge/origin split, load balancing** — GitHub Pages serves the static Studio build behind its own CDN, but that's infrastructure the repo configures via a workflow, not code it runs. → `02`.

## Cross-links to neighboring guides

- **`study-distributed-systems`** — partial failure, the fallback chain as a coordination pattern, idempotency of the Ollama call. Networking owns *what happens on the wire*; distributed-systems owns *correctness when the wire fails mid-coordination*.
- **`study-performance-engineering`** — latency budgets, the cost of a synchronous round-trip per agent turn, why the missing timeout is also a tail-latency problem.
- **`study-debugging-observability`** — the trace events (`CapabilityEvent`) and NDJSON stream are how you'd *see* a network failure; that guide owns the evidence trail, this one owns the failure mechanism.
