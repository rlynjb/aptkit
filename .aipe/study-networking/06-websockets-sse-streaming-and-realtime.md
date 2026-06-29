# WebSockets, SSE, Streaming, and Realtime

**Long-lived connections · server-push · streaming responses · reconnect** — *Industry standard*

## Zoom out — where realtime would live

Realtime means the server keeps pushing after the request — WebSockets (bidirectional), SSE (server→client), or chunked streaming (one response, many chunks). aptkit has exactly one of these, and it's the simplest: **chunked NDJSON over a plain HTTP response** in Studio's dev server. No WebSockets, no SSE, no reconnect logic. Here's where the one streaming wire sits.

```
  Zoom out — the streaming response in Studio dev

  ┌─ Browser (Studio UI) ──────────────────────────────────────┐
  │  fetch('/api/stream/query/replay') → read body stream      │ ← we are here
  └──────────────────────────┬─────────────────────────────────┘
                             │  HTTP/1.1, chunked, application/x-ndjson
  ┌─ Vite dev middleware ─────▼─────────────────────────────────┐
  │  streamReplayResponse: write(event)… write(result) end()    │
  └──────────────────────────┬─────────────────────────────────┘
                             │  agent runs in-process (no further wire)
  ┌─ Agent loop ──────────────▼─────────────────────────────────┐
  │  emits CapabilityEvent on each step → encoded as NDJSON line │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — the concept

A **WebSocket** is a full-duplex connection that stays open for two-way messages; **SSE** is a one-way server-push channel; **chunked streaming** is a single HTTP response whose body arrives in pieces over time. The question: does aptkit keep any connection alive to push data as it's produced? Yes — one, and it's chunked streaming, not a socket protocol. The model's *generation* isn't streamed (it's `stream:false` to Ollama); what streams is the *agent's trace*, one event per line, so the UI can show progress live.

## Structure pass — the skeleton

**Layers:** event source (agent loop) → encoder (NDJSON) → transport (chunked HTTP write) → consumer (browser body reader). One direction only: server → browser.

**Axis traced — "which direction does data flow, and when?"**

```
  One question across the realtime options: "direction + timing?"

  ┌────────────────────────────────────────────────┐
  │ WebSocket     │ both ways, anytime               │  → NOT used
  │ SSE           │ server→client, anytime           │  → NOT used
  │ chunked NDJSON│ server→client, during one request│  → ★ THIS is used
  │ Ollama chat   │ stream:false → one full response │  → NOT streamed
  └────────────────────────────────────────────────┘

  aptkit streams the TRACE (chunked), not the model TOKENS
```

**Seam — the `onEvent` callback inside `streamReplayResponse`.** The agent loop emits events synchronously; the transport turns each into an NDJSON line and writes it to the open response. That callback is the joint between "agent produced an event" and "byte on the wire."

## How it works

### Move 1 — the mental model

You know how a streaming `fetch` lets you read `response.body` chunk by chunk instead of waiting for the whole thing? That's the entire realtime mechanism here. The server holds the response open and writes one JSON line per agent step; the browser reads them as they land.

```
  The chunked-NDJSON pattern — one response, many lines, held open

   client: fetch('/api/stream/…') ──► [response stays open]
                                          │
   server: write({type:'event', event:…})\n   ← agent step 1
           write({type:'event', event:…})\n   ← agent step 2
           write({type:'event', event:…})\n   ← tool call, usage…
           write({type:'result', result:…})\n ← final
           end()                                ← close → browser sees EOF
                                          │
   client: decodeNdjsonStream(chunks) ──► values[] as they arrive
```

### Move 2 — walking the stream

**The agent loop is the event source.** As `runAgentLoop` runs, it emits `CapabilityEvent`s — `step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error` (the discriminated union guarded by `isCapabilityEvent`, `ndjson-stream.ts:41-62`). These are produced *synchronously* during the run, one per moving part.

**The transport writes each event as an NDJSON line, on an open response.** `streamReplayResponse` sets the streaming headers, then passes an `onEvent` callback into the run that writes each event immediately:

```ts
// apps/studio/vite.config.ts:900-918
res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
res.setHeader('cache-control', 'no-cache');
res.setHeader('x-accel-buffering', 'no');        // flush chunks, don't buffer
try {
  const body = await readJsonBody(req);
  const result = await run(body, (event) => {
    res.write(encodeNdjsonRecord({ type: 'event', event }));   // ← one line per step, live
  });
  res.write(encodeNdjsonRecord({ type: 'result', result }));   // ← final record
} catch (error) {
  res.write(encodeNdjsonRecord({ type: 'error', error: ... })); // errors as a line too
} finally {
  res.end();                                                    // close → browser EOF
}
```

The `res.write(...)` calls happen *during* the run, so the browser receives progress before the agent finishes. `encodeNdjsonRecord` (`runtime/src/ndjson-stream.ts:31-33`) is just `JSON.stringify(value) + '\n'` — the newline is the record delimiter. Note the layering comment in the code: runtime owns the *encoding* (`encodeNdjsonRecord`), Studio owns the *transport* (the `res.write`). The seam is clean.

**The consumer reassembles lines across chunk boundaries.** TCP doesn't respect line boundaries — a chunk can split mid-JSON. `decodeNdjsonStream` (`ndjson-stream.ts:103-135`) buffers partial lines and only yields a value when it sees a newline:

```ts
// packages/runtime/src/ndjson-stream.ts:111-125 (the reassembly kernel)
buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
let newlineIndex = buffer.search(/\r?\n/);
while (newlineIndex >= 0) {
  const line = buffer.slice(0, newlineIndex);     // a complete line
  buffer = buffer.slice(newlineIndex + newlineLength);
  yield decodeNdjsonLine(line, ++lineNumber, options);   // emit it
  newlineIndex = buffer.search(/\r?\n/);
}
// leftover partial line stays in `buffer` for the next chunk
```

```
  Execution trace — chunk boundary splits a line

  chunk 1 arrives: '{"type":"event","ev'
    buffer = '{"type":"event","ev'   search('\n') = -1 → yield nothing, hold it

  chunk 2 arrives: 'ent":{...}}\n{"type":"result"'
    buffer = '{"type":"event","event":{...}}\n{"type":"result"'
    newline at idx 30 → line = '{"type":"event",...}' → YIELD
    buffer = '{"type":"result"'      → hold, wait for its newline
```

That buffering is the load-bearing part of any line-delimited streaming protocol: **drop it and a split chunk produces a JSON parse error on a valid record.** It's the streaming analog of why you can't `JSON.parse` a half-received body.

**Malformed lines warn, they don't crash the stream.** `decodeNdjsonLine` returns a bounded `malformed_line` warning instead of throwing (`ndjson-stream.ts:64-82`), capped at `maxWarnings` (default 25). So one corrupt line doesn't abort the whole trace — the stream is resilient to partial garbage.

**No reconnect, no resume — it's request-scoped.** This isn't a long-lived push channel; it's one HTTP request that streams its body and ends. There's no `Last-Event-ID`, no reconnect-with-offset, no heartbeat. If the connection drops mid-stream, the client just sees a truncated body — you re-run the request. That's fine because the underlying run is a *replay* (deterministic, cheap to redo), not a live subscription.

**Model tokens are NOT streamed.** The Ollama wire uses `stream:false` (`gemma-provider.ts:71`), so the *model's* output arrives as one buffered JSON blob, not token-by-token. What you see "streaming" in Studio is the agent's step trace, not live token generation. That's a deliberate scope cut: real token streaming would mean `stream:true` to Ollama and a second NDJSON layer — `not yet exercised`.

### Move 3 — the principle

Realtime has a ladder of cost: chunked streaming (cheapest, one direction, request-scoped) → SSE (server push, auto-reconnect) → WebSockets (full duplex, stateful). aptkit climbed exactly one rung — chunked NDJSON — because its realtime need is "show agent progress during a run," which is one-way and request-scoped. The discipline is matching the transport to the interaction: a trace doesn't need a socket, it needs a body that flushes. The one non-obvious requirement even at this rung is the chunk-boundary buffer — the part everyone forgets until a line splits.

## Primary diagram

The full streaming path: agent → encoder → chunked write → reassembly.

```
  aptkit realtime — chunked NDJSON, one direction, request-scoped

  ┌─ Agent loop (in-process) ──────────────────────────────────┐
  │  emit CapabilityEvent: step, tool_call_*, model_usage, …    │
  └──────────────────────────┬─────────────────────────────────┘
                             │  onEvent(event)
  ┌─ encoder (runtime) ───────▼─────────────────────────────────┐
  │  encodeNdjsonRecord(v) = JSON.stringify(v) + '\n'           │
  └──────────────────────────┬─────────────────────────────────┘
                             │  res.write(line)  ← Studio transport
  ┌─ HTTP/1.1 chunked body ───▼─────────────────────────────────┐
  │  …event\n …event\n …result\n  then res.end() (EOF)          │
  │  headers: x-ndjson · no-cache · x-accel-buffering:no        │
  └──────────────────────────┬─────────────────────────────────┘
                             │  TCP (chunks split lines freely)
  ┌─ Browser consumer ────────▼─────────────────────────────────┐
  │  decodeNdjsonStream: buffer partials → yield whole lines    │
  │  malformed line → bounded warning, stream survives          │
  │  no reconnect/resume (re-run the deterministic replay)      │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

NDJSON-over-chunked-HTTP is the workhorse of LLM tooling for exactly this reason: you want incremental output without the operational weight of WebSockets (connection state, reconnect, scaling sticky sessions). It degrades gracefully — a dropped connection is a truncated body, not a corrupted session — and it reuses the plain HTTP request you already have. The reassembly + bounded-warning design here is the careful part; it's what separates a toy streaming endpoint from one that survives real chunk boundaries and partial garbage. If aptkit ever needed live token streaming or a persistent subscription (push notifications from a long-running job), *that's* when SSE or WebSockets would earn their place. Today they're `not yet exercised`. See **study-distributed-systems** for the failure semantics of a dropped stream.

## Interview defense

**Q: How do you stream agent output to the UI?**
Chunked NDJSON over a plain HTTP response. The agent loop emits a `CapabilityEvent` per step; the dev middleware writes each as a JSON line on an open response, then a final result record, then closes. The client reassembles lines across TCP chunk boundaries with a buffer and tolerates malformed lines as bounded warnings. One direction, request-scoped — no WebSocket.

```
  agent emit → JSON.stringify+'\n' → res.write (live) → res.end (EOF)
  client buffers partial lines → yields whole records
```
Anchor: *"the chunk-boundary buffer is the part people forget — without it a split line is a false parse error."*

**Q: Why not WebSockets or SSE?**
The interaction is one-way and request-scoped — show progress during a run. Chunked streaming covers that with no connection state, no reconnect logic, and it reuses the HTTP request. WebSockets would be over-engineering for a trace. Also note: model tokens aren't streamed at all (`stream:false`); only the agent trace streams.

## See also

- `05-http-semantics-caching-and-cors.md` — the headers and content-type on the stream
- `03-tcp-udp-connections-and-sockets.md` — why chunks split lines (TCP is a byte stream)
- `07-timeouts-retries-pooling-and-backpressure.md` — backpressure on a streamed response
- `00-overview.md` — WebSockets/SSE under `not yet exercised`
