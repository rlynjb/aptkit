# 05 — HTTP semantics, caching, and CORS

**Industry name(s):** HTTP methods/status/headers / caching / CORS / browser policy. **Type:** Industry standard.

## Zoom out — where this concept lives

HTTP rides on top of TCP (and TLS on connection 2). It's the layer where methods, status codes, and headers live — the part of the wire the repo's own code touches most directly, on connection 1.

```
  Zoom out — HTTP semantics live on connection 1 (repo-owned)

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  fetch POST + JSON  ── reads status, headers, streamed body │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ HTTP semantics the REPO defines ★
                              │  methods · status · content-type · no-cache
  ┌─ Service (Node/Vite) ─────▼────────────────────────────────┐
  │  middleware: 405 on wrong method, sets ndjson + no-cache    │
  └───────────────────────────┬────────────────────────────────┘
                              │  HTTP semantics the SDK defines (conn 2)
  ┌─ Provider ────────────────▼────────────────────────────────┐
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

This is the networking layer where the repo writes real, opinionated code — historically only on connection 1, and now on connection 3 too. On connection 1 the middleware picks methods (POST for actions, GET for reads), returns status codes (405 for the wrong method, 400 for errors), sets content types (`application/json` vs `application/x-ndjson`), and disables caching on the stream. On connection 3 (the new Ollama `fetch`) the repo also authors HTTP semantics — it chooses POST, sets `content-type: application/json`, and *consumes* the response status itself (`if (!res.ok) throw` — `gemma-provider.ts:210`, `ollama-embedding-provider.ts:69`), which is the status-handling the SDK did invisibly on connection 2. CORS is the dog that doesn't bark: same-origin means there's no cross-origin story at all. On connection 2, all HTTP semantics belong to the SDK.

## The structure pass

**Layers.** Connection 1 HTTP (repo-defined: the middleware's method/status/header choices). Connection 2 HTTP (SDK-defined: the provider request's method/headers/status handling).

**Axis — control (who decides the HTTP semantics?).**

```
  One axis (control of HTTP semantics) across connections

  connection 1:  the REPO decides
    POST vs GET · 405/400 · content-type · cache-control

  connection 2:  the SDK decides
    POST to /messages · Bearer header · retries on 5xx
```

Control flips at the SDK boundary: the repo authors connection-1 semantics line by line, and authors *nothing* on connection 2. That's the seam — the place HTTP authorship changes hands.

**Seams.** The load-bearing seam is the set of three response headers in `streamReplayResponse` (`vite.config.ts:900-902`): `content-type: application/x-ndjson`, `cache-control: no-cache`, `x-accel-buffering: no`. These three lines are the contract that makes the stream behave as a stream rather than a cached, buffered, mistyped blob. Strip any one and the realtime behavior breaks in a specific way.

## How it works

### Move 1 — the mental model

You already write this every day: an Express/Next API route that checks `req.method`, returns `res.status(405)` on the wrong verb, sets a `content-type`, and sends a body. AptKit's middleware is exactly that, with one twist — the streaming routes set headers that tell every intermediary "do not buffer or cache this; let it flow." The pattern: *HTTP headers are how you tell the browser and any proxy how to treat the response* — and for a stream you have to actively opt out of the defaults that would ruin it.

```
  The HTTP-semantics shape on connection 1

  request:   POST /api/stream/replay   {fixtureId, mode}
                │  method gate: POST? else 405
                ▼
  response headers:  content-type: application/x-ndjson
                     cache-control: no-cache
                     x-accel-buffering: no
                │
                ▼
  body:      streamed NDJSON records, then end
```

### Move 2 — walking the semantics one at a time

**Method as intent: POST for actions, GET for reads.** Every replay/promote/save route gates on `req.method !== 'POST'` and returns 405 otherwise; every listing route (`/api/replays`, `/api/promoted-fixtures`, `/api/model-status`) gates on GET. This is ordinary REST verb hygiene — POST when there's a body and a side effect, GET for idempotent reads. Boundary condition: the gate is the *first* thing each handler does, so a wrong-method request never reaches the work.

```
  Method gate — POST routes vs GET routes

  POST: /api/stream/replay, /api/replay/save, /api/replays/promote
        │ if method !== POST → 405 method not allowed
  GET:  /api/replays, /api/promoted-fixtures, /api/model-status
        │ if method !== GET → 405 method not allowed
```

**Status codes: 405 wrong method, 400 on error, 200 implicit success.** Wrong verb → 405. Any thrown error (bad JSON body, validation failure, missing key) → `res.statusCode = 400` plus a JSON `{error}`. Success is an implicit 200. The streaming route is the exception — it *can't* cleanly set a non-200 status mid-stream because headers are already sent, so it reports errors *inside the stream body* as an `{type:'error'}` record instead. That's a deliberate consequence of streaming: once you've written a chunk, the status line is locked.

```
  Status semantics — and why streaming is different

  non-stream:  error → res.statusCode = 400 → JSON {error}
  stream:      error → res.write({type:'error', ...})  ← status already 200,
                       can't change it; error rides in the body
```

**Content-type: `application/json` vs `application/x-ndjson`.** The `sendJson` helper sets `application/json`. The streaming route sets `application/x-ndjson; charset=utf-8` — telling the client this is newline-delimited JSON, not one JSON document. Get this wrong (send `application/json`) and a strict client might try to `JSON.parse` the whole stream as one object and fail on the second record.

**Caching: `no-cache` + `x-accel-buffering: no` keep the stream live.** `cache-control: no-cache` stops the browser/proxy from caching the response. `x-accel-buffering: no` is the critical one for proxies (nginx-style): it says "don't buffer this response before forwarding." Without it, a reverse proxy collects the whole response and delivers it at once — the "realtime" trace arrives all at the end. In dev there's no proxy so it's harmless, but it's the line that makes the design correct *for* deployment.

```
  Caching headers — what each prevents

  cache-control: no-cache    → browser/proxy won't serve a stale copy
  x-accel-buffering: no      → proxy won't buffer → records flow live
       │
       └─ without x-accel-buffering, a proxy makes the stream non-realtime
          by collecting everything before forwarding
```

**CORS: absent because same-origin.** The browser fetches relative URLs (`/api/...`) against the dev server's own origin. Same-origin requests never trigger CORS — no preflight `OPTIONS`, no `Access-Control-Allow-Origin` header needed, no credentials negotiation. This is `not yet exercised` by design: a deployed Studio with the UI and API on different origins would need CORS headers; the single-origin dev setup doesn't.

### Move 3 — the principle

HTTP headers are a *contract with intermediaries you can't see*. The repo's connection-1 code reads cleanly as "ordinary API route" — except for three header lines that exist entirely for a reverse proxy that isn't there yet. The principle: when you build a streaming endpoint, you author the headers for the deployment, not the dev environment. The `x-accel-buffering: no` line is harmless today and load-bearing the day someone puts nginx in front of it.

## Primary diagram

The full HTTP-semantics picture on connection 1, both directions.

```
  AptKit HTTP semantics — connection 1, repo-defined

  ┌─ UI (browser) ─────────────────────────────────────────────┐
  │  fetch(POST, content-type: application/json, JSON body)    │
  │     ▲ reads response.ok, response.body (stream)            │
  └─────┼───────────────────────────────────────────────────────┘
        │ request: POST + JSON          │ response
  ┌─────▼───────────────────────────────┴───────────────────────┐
  │  Vite middleware                                             │
  │   1. method gate → 405 if wrong verb                        │
  │   2. set headers: x-ndjson · no-cache · x-accel-buffering   │
  │   3. stream body; errors → {type:'error'} record            │
  │   4. non-stream routes: 400 + {error} on failure            │
  └──────────────────────────────────────────────────────────────┘
  (same origin → no CORS, no preflight)
```

## Implementation in codebase

**Use cases.** Method gates and status codes fire on every API call. The three streaming headers fire on every streaming replay. CORS never fires — there's no cross-origin request to handle.

**The method gate + 405, repeated on every route.** `apps/studio/vite.config.ts:385-390` (representative):

```
  vite.config.ts  (/api/stream/replay handler, lines 385–390)

  server.middlewares.use('/api/stream/replay', async (req, res) => {
    if (req.method !== 'POST') {        ← verb gate, first thing
      res.statusCode = 405;             ← Method Not Allowed
      sendJson(res, { error: 'method not allowed' });
      return;                           ← never reaches the work
    }
    await streamReplayResponse(req, res, ...);
  });
```

**The three streaming headers — the load-bearing contract.** `apps/studio/vite.config.ts:899-902`:

```
  vite.config.ts  (streamReplayResponse, lines 899–902)

  // Keep transport concerns in Studio while runtime owns the NDJSON encoding.
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8'); ← "this is NDJSON"
  res.setHeader('cache-control', 'no-cache');                          ← no stale cache
  res.setHeader('x-accel-buffering', 'no');                            ← proxy: don't buffer
       │
       └─ these three lines ARE the stream's HTTP contract; the comment names the
          separation — Studio owns transport headers, runtime owns the record format
```

**Error-as-body on the stream vs 400 on non-stream.** Stream errors: `vite.config.ts:910-914` writes `{type:'error'}` into the open body (status is already 200). Non-stream errors: e.g. `vite.config.ts:359-361` sets `res.statusCode = 400` and sends `{error}`. The split is the direct consequence of "you can't change the status after the first chunk."

**Same-origin fetches, no CORS.** `apps/studio/src/api.ts` — every `fetch` uses a relative path (`'/api/model-status'`, `'/api/replays'`, the streaming endpoints). No `Origin` mismatch, so the browser never issues a preflight.

**Connection 3 — the repo authors request method + status handling on the wire to Ollama.** `packages/providers/gemma/src/gemma-provider.ts:204-213`:

```
  gemma-provider.ts  (defaultHttpTransport, lines 204–213)

  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',                              ← repo picks the verb (body + side effect)
    headers: { 'content-type': 'application/json' },  ← repo sets the request content-type
    body: JSON.stringify(payload),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {                                 ← repo CONSUMES the status itself
    throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);  ← non-2xx → throw
  }
  return (await res.json()) as OllamaChatResponse;  ← repo parses the body
       │
       └─ this is the HTTP-semantics work the SDK did invisibly on connection 2:
          choose method, set content-type, branch on status, parse JSON. On
          connection 3 it's repo code line by line. (No streaming here — Ollama
          is called with stream:false, so it's one request → one JSON body.)
```

The embedder mirrors this against `/api/embed` (`ollama-embedding-provider.ts:63-73`), including the same `if (!res.ok) throw` status branch. Note these are non-streaming on the wire — `stream: false` in the payload (`gemma-provider.ts:72`) — so unlike connection 1's NDJSON, connection 3 is an ordinary one-shot request/response with a normal status line the repo reads directly.

## Elaborate

The "error in the body, not the status" pattern is the single most important HTTP lesson for streaming, and it generalizes to your AdvntrCue streaming work: once you've flushed the first byte of a streamed LLM response, you've committed to 200, so a mid-stream failure (provider drops, generation errors) has to be communicated *inside* the stream — a sentinel record, a special token — not via status code. AptKit does this explicitly with the `{type:'error'}` record, and the browser's stream loop checks for it (`api.ts:158`). This is also why the design needs a final `{type:'result'}` record: the client can't rely on status to know success, so it relies on receiving a result record before the stream ends. That "ended without a result" check (`api.ts:164`) is the streaming equivalent of a non-200 status.

## Interview defense

**Q: How does the streaming endpoint report an error if it already sent a 200?**

```
  status locked at 200 → write {type:'error'} into the body → client throws
```

It can't change the status after the first chunk, so it writes an `{type:'error'}` record into the open response body (`vite.config.ts:911`); the client's stream loop sees the type and throws (`api.ts:158`). Non-streaming routes use a real 400. **Anchor:** the status line is committed at first flush — streaming errors live in the body.

**Q: Why is there no CORS?**

The browser fetches relative URLs against the dev server's own origin, so every request is same-origin and never triggers a preflight or `Access-Control-*` negotiation. A deployed split-origin Studio would need it — `not yet exercised`. **Anchor:** same-origin by relative URL.

**Q: What does `x-accel-buffering: no` do and when does it matter?**

It tells a reverse proxy not to buffer the response, so NDJSON records flow to the client as written instead of being collected and delivered at the end. Harmless in dev (no proxy), load-bearing in production. **Anchor:** authored for the deployment, not the dev box.

## Validate

1. **Reconstruct:** List the three streaming headers and what each prevents.
2. **Explain:** Why does the streaming route report errors in the body instead of a 400? (Status committed at first chunk — `vite.config.ts:900,911`.)
3. **Apply:** Behind nginx the trace arrives all at once at the end. Which header is missing or overridden? (`x-accel-buffering: no` — `vite.config.ts:902`.)
4. **Defend:** Why is no CORS config correct here? (Same-origin relative URLs; cross-origin is `not yet exercised`.)

## See also

- `06-websockets-sse-streaming-and-realtime.md` — the body format these headers describe
- `04-tls-and-trust-establishment.md` — the channel these requests ride in (conn 2)
- `08-networking-red-flags-audit.md` — the deploy-time risks in these header choices
- study-security — the path-traversal guard on `/api/replay/save` (a different boundary concern)
