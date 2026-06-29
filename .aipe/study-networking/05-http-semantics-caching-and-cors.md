# HTTP Semantics, Caching, and CORS

**Methods · status codes · headers · caching · CORS** — *Industry standard*

## Zoom out — where HTTP semantics live

HTTP is the contract layer on top of the socket: which verb, which status, which headers. aptkit uses a deliberately tiny slice of it — one method, one content type, and a binary read of the status. Here's where that contract sits.

```
  Zoom out — HTTP semantics in the transport + Studio middleware

  ┌─ aptkit outbound ──────────────────────────────────────────┐
  │  POST /api/chat   content-type: application/json            │ ← we are here
  │  if (!res.ok) throw    ← status semantics, binary           │
  └──────────────────────────┬─────────────────────────────────┘
                             │  HTTP/1.1
  ┌─ Ollama daemon ───────────▼─────────────────────────────────┐
  │  200 + JSON  |  non-2xx → thrown error                       │
  └──────────────────────────────────────────────────────────────┘

  ┌─ Studio inbound (dev) ─────────────────────────────────────┐
  │  GET /api/model-status (405 on wrong verb)                  │
  │  POST /api/stream/* → 200 + application/x-ndjson            │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

**HTTP semantics** are the agreed meanings of methods (GET reads, POST writes), status codes (2xx ok, 4xx your fault, 5xx mine), and headers (content negotiation, caching, cookies). **Caching** is reusing a prior response; **CORS** is the browser's cross-origin permission gate. The question: which of these does aptkit actually rely on? Answer — a narrow, opinionated subset, and the omissions (no caching, no CORS, no conditional requests) are as telling as what's there.

## Structure pass — the skeleton

**Layers:** method choice → content negotiation → status interpretation → caching/CORS policy. aptkit fully uses the first three at a minimal level and skips the fourth.

**Axis traced — "how much of HTTP's vocabulary is used?"**

```
  One question across HTTP's feature set: "is this used?"

  ┌──────────────────────────────────────────────┐
  │ methods       │ POST out, GET/POST in          │  → minimal, used
  │ status codes  │ res.ok (2xx) vs throw          │  → binary, used
  │ content-type  │ application/json, x-ndjson     │  → used
  │ caching       │ cache-control: no-cache (stream)│ → only on the stream
  │ cookies/auth  │ none                            │  → not used
  │ CORS          │ none (same-origin dev)          │  → not used
  │ conditional   │ ETag / If-None-Match           │  → not used
  └──────────────────────────────────────────────┘
```

**Seam — `res.ok`.** The single most important HTTP semantic in aptkit is the boundary between 2xx and everything else. `res.ok` is `true` for 200–299; anything else throws. That one boolean is aptkit's entire status-code policy.

## How it works

### Move 1 — the mental model

You know how a `fetch().then(res => { if (!res.ok) throw })` in a React app collapses every error status into one catch? That's aptkit's whole HTTP error model. The shape:

```
  The binary-status pattern — 2xx is success, all else is failure

   POST /api/chat ──► Ollama ──► response
                                   │
                            ┌──────┴──────┐
                       res.ok (2xx)    !res.ok (3xx/4xx/5xx)
                            │               │
                       parse JSON      throw `ollama HTTP ${status}`
                            │               │
                         return        bubbles up to caller
```

No 429-means-retry, no 404-means-empty, no 3xx-means-redirect. One bit.

### Move 2 — walking the semantics

**Method: always POST for the API wires.** Both Ollama endpoints are `POST` (`gemma-provider.ts:205`, `ollama-embedding-provider.ts:64`) because each carries a JSON body (the chat messages, the texts to embed). There's no GET — these aren't cacheable reads, they're requests that produce computed output. Inside Studio's dev middleware, the read endpoints use GET and reject other verbs with **405**:

```ts
// apps/studio/vite.config.ts:218-224
server.middlewares.use('/api/promoted-fixtures', async (req, res) => {
  if (req.method !== 'GET') {
    res.statusCode = 405;                              // method-not-allowed, correct semantics
    sendJson(res, { error: 'method not allowed' });
    return;
  }
  ...
});
```

That 405 is the one place aptkit-adjacent code uses a status code *meaningfully* rather than as a binary.

**Content negotiation: `application/json` out, `application/x-ndjson` for streams.** The outbound transports set `content-type: application/json` (`gemma-provider.ts:206`) and parse the response with `res.json()`. Studio's JSON responses set the same on the way out (`vite.config.ts:884`), and the *streaming* responses set the NDJSON content type plus cache directives:

```ts
// apps/studio/vite.config.ts:900-903
res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
res.setHeader('cache-control', 'no-cache');     // never cache a live trace
res.setHeader('x-accel-buffering', 'no');       // tell any proxy: don't buffer, flush chunks
```

`x-accel-buffering: no` is a deliberate touch — it's the nginx directive that disables proxy buffering so NDJSON chunks reach the browser as they're written, not batched at the end. Even though the dev server has no nginx in front, the header is correct for the day one does.

**Status interpretation: 2xx or throw.** The error model is `if (!res.ok) throw new Error(...)` in both transports (`gemma-provider.ts:210`, `ollama-embedding-provider.ts:69`), with the status code and response body interpolated into the message. The consequence: a `503 model loading` from Ollama is a hard failure that bubbles up through `complete()`, not a signal to wait and retry. A `404` (wrong path) and a `500` (Ollama crash) are indistinguishable to the caller beyond the message string. That's the right altitude for a local tool — but it means no status-aware behavior (no retry-after, no backoff on 429). → `07`.

**Caching: none on the API path, `no-cache` on streams.** There's no `Cache-Control`, no `ETag`, no `If-None-Match` on the outbound wires — every chat and embed call hits Ollama fresh. That's correct: LLM generation isn't idempotent or cacheable at the HTTP layer. The only cache directive in the system is `no-cache` on the NDJSON stream, which is the *anti*-cache (don't store a live trace). The production caching that matters — GitHub Pages serving Studio's static assets with CDN cache headers — is GitHub's, not aptkit's.

**CORS: not present — same-origin by construction.** The Studio dev middleware sets no `Access-Control-Allow-Origin` and no preflight handling, because the React app and the middleware are the *same origin* (`127.0.0.1:4187`). The browser never makes a cross-origin request, so CORS never engages. In the Pages build there's no API at all — the agents run in-browser against fixtures — so again, no cross-origin call. CORS is `not yet exercised` because the architecture never crosses an origin.

```
  Layers-and-hops — Studio dev, same origin (no CORS gate)

  ┌─ Browser :4187 ─┐  POST /api/stream/query/replay   ┌─ Vite :4187 ─┐
  │  React fetch()  │ ───────────same origin─────────► │  middleware  │
  └─────────────────┘  ◄── x-ndjson chunks ──────────  └──────────────┘
       no Origin mismatch → browser never sends a preflight
```

### Move 3 — the principle

HTTP gives you a rich vocabulary — verbs, status families, conditional requests, cache validators, CORS — and the discipline is to use exactly the slice your problem needs. aptkit's problem is "send a JSON body to a local computed endpoint and read the result," so it uses POST + JSON + a binary status check, and nothing else. The risk isn't under-use; it's that the binary status check throws away information (429 vs 500) that a more resilient client would act on. When the wire is local and single-user, that information has no use. When it isn't, the missing status-awareness is the first thing you'd add.

## Primary diagram

The full HTTP-semantics surface: what's used, what's deliberately absent.

```
  aptkit HTTP semantics — the used slice and the absent rest

  OUTBOUND (aptkit → Ollama)
  ┌──────────────────────────────────────────────────────────┐
  │ POST /api/chat | /api/embed                                │
  │ content-type: application/json                             │
  │ res.ok ? parse JSON : throw `ollama HTTP ${status}`        │
  │ ✗ no caching  ✗ no retry-after  ✗ no conditional GET      │
  └──────────────────────────────────────────────────────────┘

  INBOUND (browser → Studio dev middleware)
  ┌──────────────────────────────────────────────────────────┐
  │ GET  /api/model-status, /api/promoted-* → 405 on wrong verb│
  │ POST /api/stream/* → 200 application/x-ndjson              │
  │       cache-control: no-cache, x-accel-buffering: no       │
  │ ✗ no CORS headers (same-origin)  ✗ no cookies/auth         │
  └──────────────────────────────────────────────────────────┘
```

## Elaborate

The HTTP spec's depth — idempotency, safe methods, cache validators, the 4xx/5xx split — exists for the public web, where clients and servers are written by strangers and must agree on meaning without a conversation. aptkit's client and server (well, Ollama) have a fixed, known contract, so the rich semantics buy little. The one place richer semantics would pay off is resilience: a 429-aware client could back off instead of failing, a 503-aware client could wait for model load. That's a `07` concern. For *whether* the missing CORS/auth is a security gap, see **study-security** — this guide only describes the semantics on the wire.

## Interview defense

**Q: How does your client handle HTTP error statuses?**
Binary: `res.ok` means 2xx, anything else throws with the status and body interpolated. There's no status-specific handling — a 429 and a 500 both just throw. For a single-user local Ollama that's the honest model; the cost is no retry-after or backoff awareness, which I'd add the moment the wire became flaky or remote.

```
  res.ok → parse JSON
  !res.ok → throw `ollama HTTP ${status}: ${body}`   (one path for all errors)
```
Anchor: *"one bit of status policy — 2xx or throw."*

**Q: Do you handle CORS?**
No, and I don't need to — Studio's UI and its dev middleware are the same origin, and the production build has no API at all (in-browser fixtures). CORS never engages because nothing crosses an origin.

## See also

- `06-websockets-sse-streaming-and-realtime.md` — the NDJSON streaming response in detail
- `03-tcp-udp-connections-and-sockets.md` — the socket these semantics ride on
- `07-timeouts-retries-pooling-and-backpressure.md` — the status-awareness aptkit doesn't have
- `00-overview.md` — CORS/caching under `not yet exercised`
