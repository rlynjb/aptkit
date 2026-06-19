# 01 — Network map

**Industry name(s):** request path / network topology / boundary inventory. **Type:** Language-agnostic.

## Zoom out — where this concept lives

Every other file in this guide zooms into one slice of the wire. This file is the slice they all sit inside: the complete path a byte travels and the boundaries it crosses. Here's the whole system as bands, with the two network boundaries marked.

```
  Zoom out — the two boundaries, top to bottom

  ┌─ UI layer (browser) ──────────────────────────────────────┐
  │  React panel   →   fetch()                                 │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ BOUNDARY 1 ★  HTTP (same-origin, dev)
  ┌─ Service layer (Node / Vite dev server) ──▼─────────────────┐
  │  configureServer middleware → runReplay → agent loop        │
  │  ModelProvider.complete()                                   │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ BOUNDARY 2 ★  HTTPS (SDK-owned)
  ┌─ Provider layer (external) ──▼──────────────────────────────┐
  │  api.anthropic.com   /   api.openai.com                     │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

A network map answers one question: *if I follow a single user action, every place does it leave a process, and what promise does each crossing make?* For AptKit the answer is short — two crossings — but each one has a completely different protocol, trust model, and failure story. The map is the skeleton; the rest of the guide is the anatomy.

## The structure pass

**Layers.** Three bands: browser (UI), Node/Vite (service), external provider. The repo's code lives entirely in the first two; the third is someone else's server.

**Axis — trust (what can each side see or tamper with?).** Trace it down the stack:

```
  One axis (trust) traced across the two boundaries

  ┌─ browser ─┐  B1  ┌─ Node/Vite ─┐  B2  ┌─ provider ─┐
  │ untrusted │ ════►│  trusted    │ ════►│  external  │
  │ (user JS) │ same │  holds keys │ TLS  │  3rd party │
  └───────────┘ origin└────────────┘ HTTPS└────────────┘
        │                   │                   │
   sees only what      holds ANTHROPIC_     never sees the
   the stream sends    API_KEY in env       API key directly
```

The trust answer *flips at both boundaries*. At B1, the browser is untrusted code talking to a server that holds secrets — but it's same-origin plaintext localhost, so the channel itself isn't defended (it doesn't need to be in dev). At B2, the Node process is the trusted party authenticating *itself* to an external service over TLS with a bearer key. That's two different trust postures, which is exactly why they're studied as separate boundaries.

**Seams.** Boundary 1 is the seam where the repo's own protocol (NDJSON) lives — it's load-bearing because the *direction of streaming* flips here (server pushes records to a passive browser reader). Boundary 2 is the seam where the repo *stops owning the protocol* — control of the wire flips from repo code to SDK code. Both are worth studying before either side's internals.

## How it works

### Move 1 — the mental model

You know how a `fetch()` in a React app crosses exactly one boundary — your code to your API — and everything past that is the backend's problem? AptKit is that, plus one more hop the backend makes that *you* happen to own the code for (the SDK call). The mental model is a two-hop relay: the browser hop you fully control, and the provider hop you delegate.

```
  The relay shape — two hops, one delegated

  [browser] ──hop A (you own)──► [Node] ──hop B (SDK owns)──► [provider]
       ▲                            │                              │
       └──── stream back ───────────┘                              │
            (you own)            ◄──── JSON response (SDK owns) ────┘
```

### Move 2 — walking the path one crossing at a time

**The browser kicks off a request (hop A, outbound).** A Studio panel calls `fetch(endpoint, { method:'POST', body: JSON.stringify({fixtureId, mode}) })`. This is an ordinary same-origin HTTP request: the browser opens (or reuses) a TCP connection to the Vite dev server, sends a POST with a JSON body. Nothing exotic — the boundary condition is that the *response* won't be a normal one-shot body; it'll be a long-lived stream (file `06`).

```
  Hop A — browser to Node, request

  ┌─ UI ──────┐  POST /api/stream/replay        ┌─ Service ─┐
  │ fetch()   │ ──────────────────────────────► │ Vite mw   │
  │           │  body: {fixtureId, mode}         │           │
  └───────────┘                                  └───────────┘
```

**Node receives it and starts the agent loop.** The Vite `configureServer` middleware reads the JSON body off the request stream, picks a fixture, and calls `runReplay`. Inside that, the agent loop calls `ModelProvider.complete()`. Up to here, zero bytes have left the machine on the provider side — it's all in-process.

**The provider call crosses boundary 2 (hop B, outbound + inbound).** `complete()` hands off to the SDK's `messages.create` / `chat.completions.create`. *This is where the repo's network involvement ends and the SDK's begins.* The SDK resolves the hostname, opens a TLS connection, POSTs the request, waits for the full JSON response, and returns it. The repo passes `request.signal` so the call is cancellable, and nothing else.

```
  Hop B — Node to provider, delegated to SDK

  ┌─ Service ─┐  client.chat.completions.create   ┌─ Provider ─┐
  │ provider  │ ════════ HTTPS POST ═════════════►│ api.openai │
  │ .complete │ ◄═══════ 200 + JSON body ═════════│  .com      │
  └───────────┘   (SDK owns DNS/TCP/TLS/HTTP)      └────────────┘
```

**Events stream back across boundary 1 (hop A, inbound).** As the agent loop runs — every `step`, `tool_call_start`, `model_usage` event — the middleware writes an NDJSON record to the still-open response. The browser's `decodeNdjsonStream` yields each record as it arrives. When the loop finishes, a final result record is written and the response ends.

```
  Hop A — Node to browser, streamed response

  ┌─ Service ─┐  res.write(ndjson) per event   ┌─ UI ───────┐
  │ Vite mw   │ ──────────────────────────────►│ decode     │
  │           │  res.write({type:'result'})    │ Ndjson     │
  │           │  res.end()                      │ Stream     │
  └───────────┘                                 └────────────┘
```

### Move 3 — the principle

A network map is worth drawing *first* because it tells you which problems are yours and which are someone else's. AptKit's map has exactly one boundary the repo defends and tunes (boundary 1) and one it delegates wholesale (boundary 2). Most "why is this slow / why did this fail" questions resolve the moment you know which side of which boundary you're on.

## Primary diagram

The full map, both boundaries, both directions, every hop labelled.

```
  AptKit network map — complete

  ┌─ UI (browser) ───────────────────────────────────────────────┐
  │  React panel                                                  │
  │     │  fetch POST {fixtureId,mode}        ▲ decodeNdjsonStream │
  └─────┼─────────────────────────────────────┼───────────────────┘
        │ B1: HTTP req (same-origin)           │ B1: chunked NDJSON resp
  ┌─────▼─────────────────────────────────────┴───────────────────┐
  │  Service (Vite dev server, Node)                               │
  │  configureServer mw → runReplay → agent loop                   │
  │     │  ModelProvider.complete(request)     ▲ ModelResponse     │
  └─────┼─────────────────────────────────────┼───────────────────┘
        │ B2: HTTPS POST (SDK)                 │ B2: 200 + JSON (SDK)
  ┌─────▼─────────────────────────────────────┴───────────────────┐
  │  Provider (external)  api.anthropic.com / api.openai.com       │
  └────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** This map is traversed on exactly one user action: clicking "Run" on any of the six Studio agent panels in a non-fixture mode. Fixture mode short-circuits boundary 2 entirely (the `FixtureModelProvider` returns canned responses with no network), which is itself a teaching point — fixture mode exercises only boundary 1.

**Boundary 1, outbound — the browser request.** `apps/studio/src/api.ts:126-130`:

```
  apps/studio/src/api.ts  (runReplayStream, lines 126–130)

  const response = await fetch(endpoint, {     ← opens the HTTP request
    method: 'POST',                            ← always POST (carries a body)
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId, mode }), ← the only data the browser sends
  });
       │
       └─ no credentials, no custom origin — same-origin dev request;
          the response body is what matters, not the request
```

**Boundary 1, server side — the middleware.** `apps/studio/vite.config.ts:385-396` registers `/api/stream/replay`; the actual transport lives in `streamReplayResponse` (`vite.config.ts:887`). See file `06` for the line-by-line.

**Boundary 2 — the delegated SDK call.** `packages/providers/openai/src/openai-provider.ts:39-48`:

```
  packages/providers/openai/src/openai-provider.ts  (complete, lines 39–48)

  const response = await this.client.chat.completions.create(
    { model, messages, ... },                ← the SDK builds the HTTPS request
    request.signal ? { signal: request.signal } : undefined,
  );                                          ← the ONLY repo control over the wire
       │
       └─ everything network (DNS, TCP, TLS, retries) is inside the SDK;
          the repo's whole contribution at this boundary is the abort signal
```

## Elaborate

This two-boundary shape is the default for a "thin server in front of an LLM" app, and you've shipped its cousin: in AdvntrCue, the Next.js serverless function is the equivalent of the Node middleware here, the OpenAI call is boundary 2, and the streaming response back to the Next.js client is boundary 1. The difference is that AdvntrCue's boundary 1 is a deployed HTTPS endpoint with real origins; AptKit's is a localhost dev server. Same topology, different trust posture — which is exactly why the trust axis (above) is the right lens for this map.

## Interview defense

**Q: Walk me through every network hop when a user runs a non-fixture replay.**

```
  fetch POST ─► Vite mw ─► (per turn) HTTPS to provider ─► back
              B1            B2 (SDK)                       B1 stream
```

Browser POSTs JSON over same-origin HTTP (B1). The middleware runs the agent loop; each model turn makes an SDK-owned HTTPS call to the provider (B2), repeating up to `maxTurns`. As the loop emits events, the server writes NDJSON records back over the still-open B1 response; a final result record closes it. **Anchor:** two boundaries — one I own (NDJSON), one I delegate (SDK).

**Q: Which parts of this would change in production?**

Boundary 2 wouldn't change at all — same SDK, same delegation. Boundary 1 would: it'd move from a localhost dev server to a deployed HTTPS origin, which introduces TLS termination, possible CORS, and a real reverse proxy that makes `x-accel-buffering: no` load-bearing. **Anchor:** the provider hop is environment-independent; the browser hop is where deployment bites.

## Validate

1. **Reconstruct:** Draw the two boundaries from memory. Name the protocol and trust posture of each.
2. **Explain:** Why does fixture mode exercise only boundary 1? (Answer: `FixtureModelProvider` returns canned `ModelResponse[]` with no SDK call — `vite.config.ts:756`.)
3. **Apply:** A user reports the trace appears all at once at the end instead of live. Which boundary, which line? (B1; `x-accel-buffering` / buffering — `vite.config.ts:902`.)
4. **Defend:** Why is it correct that the repo owns no code at boundary 2? (Delegation: the SDK is the contract; re-implementing HTTP/TLS would be strictly worse and is the whole reason `ModelProvider` wraps a vendor client.)

## See also

- `02-dns-routing-and-addressing.md` — how each boundary's hostname resolves
- `06-websockets-sse-streaming-and-realtime.md` — boundary 1's NDJSON protocol in full
- `08-networking-red-flags-audit.md` — the risks living at each boundary
- study-system-design — the same two boundaries as *architectural* seams
