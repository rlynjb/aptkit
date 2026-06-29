# HTTP Semantics, Caching, and CORS

**Industry name:** HTTP/1.1 semantics / caching / CORS / browser fetch policy · *Industry standard*

## Zoom out, then zoom in

This is the application layer — the methods, status codes, and headers that ride on top of the connection. Here's where aptkit speaks HTTP.

```
  Zoom out — where HTTP semantics are decided

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  Studio browser: fetch('/api/...', {method, headers, body}) │
  └───────────────────────────┬────────────────────────────────┘
                              │ same-origin HTTP (dev) — methods, status, headers
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  vite middleware: checks req.method, sets res statusCode +  │
  │    content-type, cache-control, x-accel-buffering           │
  └───────────────────────────┬────────────────────────────────┘
                              │
  ┌─ Provider layer ─────────▼─────────────────────────────────┐
  │  Gemma transport: POST /api/chat, content-type json,        │
  │    res.ok check, res.status in the thrown error             │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** HTTP semantics are the rules everyone agrees on so a request means the same thing on both ends: `GET` reads, `POST` writes, `2xx` succeeded, `4xx` you-messed-up, `5xx` I-messed-up, and headers carry the metadata. aptkit speaks a small, disciplined subset. The pattern to learn: **HTTP is a contract of methods + status + headers, and the repo uses exactly the parts it needs — POST for actions, the `res.ok` boundary for errors, a few cache and streaming headers — and nothing more.**

## Structure pass

**Layers:** browser `fetch` (UI) → vite middleware (Service) → Gemma/Ollama transport (Provider). HTTP semantics appear at each.

**Axis — "what does each side promise via the HTTP envelope?"** Trace it:

```
  Axis — the HTTP contract — across the surfaces

  surface              method      success signal     error signal       headers that matter
  ──────────────────────────────────────────────────────────────────────────────────────────
  Studio → /api/...    GET / POST  response.ok        4xx/5xx + {error}  content-type: json
  middleware handlers  guards POST 200 + json body    405 method-not-... content-type, cache-control
  Gemma → Ollama       POST        res.ok (2xx)       throw on !res.ok   content-type: json
  stream endpoints     POST        ndjson body        error record       content-type: x-ndjson
```

**Seam:** the `res.ok` / `response.ok` check is the seam where "the server answered" flips to "the server answered with a failure." Everything before it is transport success; everything after is application-level error handling. That boundary is drawn explicitly in the Gemma transport (`throw on !res.ok`).

## How it works

#### Move 1 — the mental model

You write `fetch(url, { method: 'POST', headers, body })` constantly. That object *is* HTTP semantics: the method says what kind of action, the headers carry metadata (content type, caching), the body is the payload, and the response comes back with a status code you branch on. The kernel: **request = method + headers + body; response = status + headers + body; `2xx` means it worked.**

```
  The pattern — request/response envelope

  REQUEST                         RESPONSE
  ┌──────────────────┐            ┌──────────────────┐
  │ POST /api/chat    │            │ 200 OK            │
  │ content-type:json │  ───────►  │ content-type:json │
  │ { ...body... }    │            │ { ...body... }    │
  └──────────────────┘            └──────────────────┘
        ▲ method+headers              ▲ status decides
          decide intent                 success vs failure
```

The part people trip on: a `4xx`/`5xx` *is still a successful round trip* — the bytes arrived. `fetch` does NOT throw on `404` or `500`; you have to check `res.ok` yourself. Forgetting that is the classic HTTP-client bug.

#### Move 2 — walking the HTTP in this repo

**The Gemma transport draws the success/failure line explicitly.** It does what raw `fetch` won't do for you — turns a non-2xx status into a thrown error (`packages/providers/gemma/src/gemma-provider.ts:204-214`):

```ts
const res = await fetch(`${base}/api/chat`, {
  method: 'POST',                                 // POST: this is an action with a body
  headers: { 'content-type': 'application/json' },// declare the body's media type
  body: JSON.stringify(payload),
  ...(signal ? { signal } : {}),
});
if (!res.ok) {                                    // ← the seam: 2xx vs everything else
  throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`); // status + body in the message
}
return (await res.json()) as OllamaChatResponse;  // 2xx → parse the JSON body
```

`res.ok` is `true` only for `200–299`. A `500` from a crashed Ollama, a `404` from a wrong path — both fall into the `throw`, carrying the status code and the server's error text. The embedding transport mirrors this exactly (`packages/retrieval/src/ollama-embedding-provider.ts:69-71`). This is the one place aptkit's code decides HTTP success.

**The Studio middleware enforces method semantics.** Each route guards its method and returns `405` for the wrong one (`apps/studio/vite.config.ts`, e.g. `:218-231` for `/api/promoted-fixtures` which only allows `GET`, and the POST-only replay/promote routes):

```ts
server.middlewares.use('/api/promoted-fixtures', async (req, res) => {
  if (req.method !== 'GET') {                 // GET = read-only listing
    res.statusCode = 405;                      // 405 Method Not Allowed
    sendJson(res, { error: 'method not allowed' });
    return;
  }
  // ...
});
```

```
  Layers-and-hops — method-guarded routes

  ┌─ UI: browser ──────────┐  hop A: GET /api/replays      ┌─ Service: middleware ─┐
  │  fetch('/api/replays') │ ────────────────────────────► │ if method!=GET → 405  │
  │                        │ ◄──── 200 + {replays:[...]} ── │ else read dir → json  │
  └────────────────────────┘                                └────────────────────────┘
```

Read endpoints are `GET`; actions (run a replay, promote a fixture, save an artifact) are `POST`. The `405` for a mismatched method is correct HTTP — it tells the client "right URL, wrong verb."

**Errors are a `4xx` plus a JSON `{error}` body.** Handlers wrap work in try/catch and on failure set `res.statusCode = 400` and send `{ error: message }` (`vite.config.ts:227-230` and throughout). The client mirrors this — it reads the body and throws the `error` field if `!response.ok` (`apps/studio/src/api.ts:13-16`, `:200-204`). So the contract is consistent end to end: status code says *category*, JSON body says *detail*.

**Caching headers appear once, on the stream.** `streamReplayResponse` sets `cache-control: no-cache` and `x-accel-buffering: no` (`vite.config.ts:901-903`) so the NDJSON trace isn't cached or buffered by an intermediary. There is no HTTP caching strategy anywhere else — no `ETag`, no `Cache-Control: max-age`, no conditional requests. That's `not yet exercised` and appropriate: the dynamic endpoints are all `POST` actions or freshly-read listings, which shouldn't be cached.

**CORS is `not yet exercised`.** Every Studio `fetch` is same-origin (`/api/...` against the page's own origin), so no cross-origin headers (`Access-Control-Allow-Origin`, preflight `OPTIONS`) appear or are needed. The static Pages build has no API at all. CORS becomes relevant only if Studio's UI and its API ever live on different origins — they don't.

**Cookies, sessions, auth headers:** `not yet exercised` in aptkit. The cloud SDKs carry the API key (an `Authorization`-style header) internally; aptkit's own HTTP never sets an auth header because loopback Ollama needs none and the Studio dev API is unauthenticated local tooling.

#### Move 3 — the principle

The principle: **HTTP gives you a shared vocabulary — use the parts that carry meaning and skip the rest.** aptkit uses `POST` for actions, `GET` for reads, `405` for verb mismatches, `4xx`+JSON for errors, and the `res.ok` check to draw the success line — and deliberately uses *no* caching, CORS, or cookies because none of its traffic needs them. Knowing which HTTP features a system *doesn't* use, and why, is as much a sign of understanding as knowing the ones it does.

## Primary diagram

```
  HTTP semantics recap — methods, status, headers, end to end

  Browser ──GET /api/replays──────────────► middleware ── method guard ─► 405 or 200+json
  Browser ──POST /api/replay {fixtureId}──► middleware ── runReplay ────► 200+result / 400+{error}
  Browser ──POST /api/stream/...──────────► middleware ── ndjson ───────► content-type x-ndjson,
                                                                            cache-control no-cache
  Gemma   ──POST /api/chat {messages}─────► Ollama ──── res.ok? ────────► json / throw(status+body)

  used:    POST, GET, 200, 400, 405, content-type, cache-control, x-accel-buffering
  unused:  CORS, cookies, ETag/conditional caching, auth headers  (not yet exercised)
```

## Elaborate

HTTP's genius is that the envelope (method + status + headers) means the same thing to every client and server, so you can reason about a request without reading the handler. The discipline aptkit shows — `GET` for reads, `POST` for actions, explicit `405`/`400`, a hand-rolled `res.ok` gate — is exactly the subset that matters for a small tool. The streaming `content-type: application/x-ndjson` is the one place HTTP semantics get interesting, and it bridges straight into `06` (realtime). For *whether* the unauthenticated dev API is a problem, see `study-security`; this file owns *what the HTTP says*, not *whether it's safe*.

## Interview defense

**Q: "How do you handle HTTP errors from your model provider?"**
Lead with the trap and how you avoid it: "`fetch` doesn't throw on `4xx`/`5xx` — a `500` is still a completed round trip — so my Gemma transport explicitly checks `res.ok` and throws an error carrying the status code and the response body. That turns a transport-level non-2xx into a normal exception the agent loop can catch." Then the breadth: "On the Studio side, read endpoints are `GET`, actions are `POST`, wrong verbs get `405`, and errors come back as a `4xx` with a JSON `{error}` the client re-throws."

```
  sketch: the res.ok seam

  fetch ──► response arrives (round trip OK)
                 │
            res.ok?  ──yes──► parse json
                 └──no──────► throw(status + body)   ← fetch won't do this for you
```

Anchor: *a 500 is a successful round trip — you have to check `res.ok` yourself.*

## See also

- `06-websockets-sse-streaming-and-realtime.md` — the `x-ndjson` streaming response in detail
- `03-tcp-udp-connections-and-sockets.md` — the connection HTTP rides on
- `07-timeouts-retries-pooling-and-backpressure.md` — what `res.ok` doesn't protect you from (a hang)
