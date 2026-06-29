# WebSockets, SSE, Streaming, and Realtime

**Industry name:** streaming / long-lived transports / chunked transfer (NDJSON) · *Industry standard*

## Zoom out, then zoom in

"Realtime" usually means a long-lived connection pushing updates. aptkit has exactly one streaming surface — and it's worth being precise about *which* mechanism it is, because it's not the one people assume.

```
  Zoom out — the one streaming path

  ┌─ UI layer ─────────────────────────────────────────────────┐
  │  Studio browser: reads response.body as a ReadableStream    │
  │    for await (record of decodeNdjsonStream(chunks)) {...}   │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ ONE HTTP response, streamed in chunks ★
                              │     (not a WebSocket, not SSE)
  ┌─ Service layer ──────────▼─────────────────────────────────┐
  │  vite middleware: res.write(ndjson) per event, res.end()    │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The verdict first: this is **NDJSON over a single chunked HTTP response**, not WebSockets and not Server-Sent Events. The server holds one response open and writes newline-delimited JSON records as the agent runs; the browser reads the response body incrementally. It's one-way (server→client), tied to one request, and it ends when the work ends. The pattern to learn: **streaming a response body is the simplest realtime mechanism — no new protocol, no reconnect logic, just don't call `end()` until you're done.**

## Structure pass

**Layers:** agent loop (emits events) → middleware (encodes + writes) → browser (decodes + dispatches).

**Axis — "who controls the connection's lifetime, and which way do messages flow?"** Trace it across the realtime options, real and absent:

```
  Axis — connection direction + lifetime — across realtime mechanisms

  mechanism        direction        lifetime              in this repo?
  ──────────────────────────────────────────────────────────────────────
  NDJSON-over-HTTP server → client  one request          ★ YES (Studio stream)
  SSE              server → client  long-lived, reconnect   NO (not yet exercised)
  WebSocket        bidirectional    long-lived              NO (not yet exercised)
  polling          client → server  repeated requests       NO
```

**Seam:** the seam is `res.write()` vs `res.end()` on the server. As long as the handler keeps writing without ending, the response stays open and the client keeps receiving — that single decision *is* the streaming behavior.

## How it works

#### Move 1 — the mental model

You know how a `fetch` resolves once with a whole body. Now imagine the server never finishes that body — it keeps appending lines, and you read them as they land instead of waiting for the end. That's chunked transfer: one response, delivered in pieces. The kernel: **server writes records and flushes; client reads the body stream record by record; the connection closes when the server calls `end()`.**

```
  The pattern — NDJSON over one streamed response

  server                                   client
    │ ── 200, content-type: x-ndjson ─────► │  (headers first)
    │ ── {"type":"event",...}\n ──────────► │  read + dispatch
    │ ── {"type":"event",...}\n ──────────► │  read + dispatch
    │ ── {"type":"result",...}\n ─────────► │  read final
    │ ── res.end() ───────────────────────► │  stream done
    │                                       │
    one connection, server pushes, client pulls chunks as they arrive
```

What breaks if you forget: if the server buffers instead of flushing each record (or an intermediary buffers it), the "realtime" illusion collapses — the client gets everything at once at the end. That's exactly what the `x-accel-buffering: no` header defends against.

#### Move 2 — walking the stream in this repo

**The server writes one NDJSON record per event, then ends.** `streamReplayResponse` sets the streaming headers and writes as the agent emits (`apps/studio/vite.config.ts:888-919`):

```ts
res.setHeader('content-type', 'application/x-ndjson; charset=utf-8'); // newline-delimited JSON
res.setHeader('cache-control', 'no-cache');                          // don't cache a live stream
res.setHeader('x-accel-buffering', 'no');                            // tell proxies: don't buffer

const result = await run(body, (event) => {
  res.write(encodeNdjsonRecord({ type: 'event', event }));           // one line per trace event
});
res.write(encodeNdjsonRecord({ type: 'result', result }));           // final line: the result
// ... finally { res.end(); }                                        // close → client knows it's done
```

The `onEvent` callback is wired straight into the agent's trace sink, so every `step` / `tool_call_start` / `model_usage` event becomes a line on the wire the instant it's emitted. Errors are written as a `{type:'error'}` record rather than crashing the stream.

**The browser reads the response body as a `ReadableStream`.** `runReplayStream` POSTs, then iterates the body (`apps/studio/src/api.ts:126-166`):

```ts
const response = await fetch(endpoint, { method: 'POST', headers, body });
if (!response.body) { /* fall back to json error */ }

for await (const record of decodeNdjsonStream(responseBodyChunks(response.body))) {
  // record.value.type === 'event'  → options.onEvent(event)   (live UI update)
  // record.value.type === 'result' → finalPayload = result
  // record.value.type === 'error'  → throw
}
```

`responseBodyChunks` adapts the browser's `ReadableStream` reader into an async iterable of `Uint8Array` chunks (`api.ts:169-180`); `decodeNdjsonStream` (from `@aptkit/runtime`) splits those bytes on newlines and parses each line, tolerating a partial trailing line until the next chunk completes it.

```
  Layers-and-hops — the live event stream

  ┌─ Service: agent loop ──────┐
  │  emit(step/tool_call/...)  │
  └─────────────┬──────────────┘
       onEvent  │  res.write(ndjson line)
                ▼
  ┌─ Service: middleware (one open response) ──────────────────┐
  │  content-type: x-ndjson · no-cache · x-accel-buffering: no  │
  └─────────────┬──────────────────────────────────────────────┘
   hop: chunked HTTP body, server → browser, one line at a time
                ▼
  ┌─ UI: browser ──────────────────────────────────────────────┐
  │  response.body.getReader() → decodeNdjsonStream → onEvent() │
  └────────────────────────────────────────────────────────────┘
```

**Why NDJSON-over-HTTP and not SSE or WebSocket — the load-bearing choice.** The data flow here is strictly one-way (server reporting progress) and strictly bounded to one request (run this replay, stream its trace, finish). SSE would add an `EventSource` and a reconnect protocol the use case doesn't want — you don't want to *resume* a finished replay. A WebSocket would add a bidirectional, long-lived connection and a framing protocol for a job that never receives client messages mid-flight. NDJSON-over-a-response-body is the minimum that does the job: no new protocol, no reconnect state, the connection's end *is* the signal that the run is complete. The surprising part — that "streaming" here is just not calling `end()` early — is also the cheapest correct answer.

**No reconnect, no heartbeat, no resume.** Because the stream is one-shot, there's no reconnection logic, no keep-alive ping, no last-event-id resume. If the connection drops mid-replay, the client throws and the run is simply re-issued. That's `not yet exercised` as a *resilience* feature and correct for a local dev tool — it would matter only for long-running, resumable, or multi-client realtime, which this isn't.

**WebSockets / SSE / realtime pub-sub:** `not yet exercised` anywhere in aptkit. (Vite's own HMR uses a WebSocket in dev, but that's the dev server's machinery, not aptkit's code.) They'd become relevant if Studio needed to push updates *not* tied to a single request — live multi-user collaboration, a server-initiated notification — none of which exists.

#### Move 3 — the principle

The principle: **match the transport to the data flow, not to the buzzword.** "Streaming" reflexively suggests WebSockets, but a one-way, single-request progress feed is best served by streaming an HTTP response body — fewer moving parts, no reconnect protocol, the connection lifetime carries the "done" signal for free. Reaching for a WebSocket here would be adding a bidirectional long-lived channel to a problem that is neither bidirectional nor long-lived.

## Primary diagram

```
  Realtime recap — NDJSON over one streamed HTTP response

  agent emits ─► middleware res.write(line) ─chunked HTTP─► browser reads line ─► UI updates
       │                    │                                      │
   trace events     headers: x-ndjson,                    decodeNdjsonStream
   (step, tool,     no-cache, x-accel-buffering:no         splits on \n, tolerates
    model_usage)            │                               partial trailing line
       │            res.write(result line)                         │
       └────────────► res.end()  ◄── the "done" signal ──► loop exits, returns result

  NOT used: WebSocket (bidirectional), SSE (reconnect)  — not yet exercised
```

## Elaborate

NDJSON-over-HTTP is the same shape the LLM provider APIs use for token streaming (`data:` lines for OpenAI, event streams for Anthropic) — the repo applies the pattern one level up, streaming *trace events* instead of tokens. The lineage is chunked transfer encoding from HTTP/1.1, which predates both SSE and WebSockets and remains the simplest way to push a bounded sequence. The runtime's `encodeNdjsonRecord` / `decodeNdjsonStream` pair (in `@aptkit/runtime`) is the reusable core; Studio just wires it to a response body. For how these streamed events become a debugging trail, see `study-debugging-observability`; for the latency characteristics of streaming vs buffering, see `study-performance-engineering`.

## Interview defense

**Q: "You said it streams — is that a WebSocket?"**
Correct the assumption directly: "No — it's NDJSON over a single chunked HTTP response. The data flow is one-way and tied to one request: run a replay, stream its trace events as newline-delimited JSON, end the response when the run finishes. A WebSocket would add a bidirectional long-lived channel I never use; SSE would add reconnect semantics I don't want for a one-shot job. The connection ending *is* the 'done' signal." Then the detail that shows you built it: "I set `x-accel-buffering: no` so an intermediary doesn't buffer the stream and kill the realtime feel."

```
  sketch: not-end()-yet is the whole trick

  res.write(event)  ──► client sees it now
  res.write(event)  ──► ... and now
  res.end()         ──► done (no reconnect needed)
```

Anchor: *streaming a response body is just not calling `end()` until you're finished — match the transport to a one-way bounded flow.*

## See also

- `05-http-semantics-caching-and-cors.md` — the `x-ndjson` content-type and the headers that keep the stream live
- `03-tcp-udp-connections-and-sockets.md` — the single connection the stream rides on
- `07-timeouts-retries-pooling-and-backpressure.md` — what happens if the stream never ends (no timeout)
