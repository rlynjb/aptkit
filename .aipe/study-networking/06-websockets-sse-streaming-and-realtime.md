# 06 — WebSockets, SSE, streaming, and realtime

**Industry name(s):** server-push streaming / line-delimited protocol (NDJSON) / chunked HTTP transfer. **Type:** Industry standard (the framing); Project-specific (the record envelope).

## Zoom out — where this concept lives

This is the file for the one networking thing AptKit actually built. It lives entirely on connection 1 (browser↔Node) — the realtime transport that makes the agent trace appear live.

```
  Zoom out — the built protocol lives on connection 1

  ┌─ UI (browser) ────────────────────────────────────────────┐
  │  fetch → response.body.getReader() → decodeNdjsonStream    │ ← we are here
  │  yields {type:'event'} records as they arrive               │
  └───────────────────────────┬────────────────────────────────┘
                              │  ★ CHUNKED NDJSON over HTTP (built) ★
                              │  NOT WebSocket, NOT SSE
  ┌─ Service (Node/Vite) ─────▼────────────────────────────────┐
  │  agent loop emits CapabilityEvent → res.write(ndjson)       │
  └──────────────────────────────────────────────────────────────┘
```

## Zoom in — narrow to the concept

The verdict first: AptKit streams agent progress to the browser as **newline-delimited JSON over a single, long-held, chunked HTTP response**. It is *not* a WebSocket (no bidirectional channel, no upgrade handshake) and *not* Server-Sent Events (no `text/event-stream`, no `EventSource`, no `data:` framing). It's the simplest thing that works: the server keeps writing `{...}\n` records to an open response, and the client reassembles them as bytes arrive. The question this file answers: *how do you turn a one-shot HTTP response into a live event feed using nothing but chunked writes and a line delimiter?*

## The structure pass

**Layers.** Encoding layer (one record → one `JSON.stringify(...)\n` line). Framing layer (newlines delimit records; partial lines buffer across chunk boundaries). Transport layer (chunked HTTP, the long-held socket from file `03`). Consumption layer (browser reader + decoder yielding records live).

**Axis — control (who decides when the next record appears?).**

```
  One axis (who drives the stream) across layers

  ┌─ server (agent loop) ─┐  → the SERVER decides: emits when it has an event
  ┌─ transport (HTTP) ────┐  → neither: just carries bytes as written
  ┌─ client (decoder) ────┐  → the CLIENT reacts: yields whatever arrived

  one-way push: server drives, client follows. No client→server mid-stream.
```

Control sits entirely on the server — it's a *push* stream. The client can't send anything back mid-stream (that's precisely what would require a WebSocket). This one-directionality is *why* NDJSON-over-HTTP is sufficient and a WebSocket would be overkill.

**Seams.** Two load-bearing seams. (1) The newline delimiter — it's the entire framing protocol; lose it and records run together unparseably. (2) The cross-chunk buffer in `decodeNdjsonStream` — TCP doesn't respect record boundaries, so a chunk can split a JSON record in half; the buffer that holds the partial line until the rest arrives is the difference between a working decoder and one that throws on every split record. This is the part most people forget.

## How it works

### Move 1 — the mental model

You know how `console.log` writes one line at a time and you read them as they appear? NDJSON streaming is `console.log` over HTTP: the server writes one self-contained JSON object per line, the client reads lines as they land. The "realtime" feeling is just *the socket never closing between writes*. No special protocol — a JSON object, a newline, repeat.

```
  The NDJSON-over-HTTP shape — one record per line, socket stays open

  server writes:   {"type":"event","event":{...}}\n   ← record 1
                   {"type":"event","event":{...}}\n   ← record 2
                   {"type":"event","event":{...}}\n   ← record 3 (as loop runs)
                   {"type":"result","result":{...}}\n  ← final record
                   <socket closes>
  client reads:    splits on \n, JSON.parse each line, yields as it arrives
```

### Move 2 — the load-bearing skeleton

This concept has a clear kernel. Here's the smallest thing that's still the pattern, then each part named by what breaks without it.

**The kernel:** `encode one JSON value + newline` → `write to open response (don't close)` → `client buffers bytes` → `split on newline` → `parse + yield each complete line` → `repeat until socket closes`.

**Part 1 — the newline delimiter (framing).** Each record is `JSON.stringify(value) + '\n'`. The newline is the *only* thing separating records. **What breaks without it:** records concatenate into `{...}{...}` which is not valid JSON — the client can't tell where one ends and the next begins. The newline is the entire wire protocol.

```
  Framing — newline is the record boundary

  encodeNdjsonRecord(value)  =  JSON.stringify(value) + "\n"
       │
       └─ drop the \n → {"a":1}{"b":2} → unparseable. The delimiter IS the protocol.
```

**Part 2 — the long-held response (transport).** The server calls `res.write(record)` repeatedly without `res.end()` between writes. **What breaks without it:** if the server closed after the first write, you'd have a normal one-shot response — no streaming, no realtime. Holding the socket open (file `03`) is what makes it a stream.

**Part 3 — the cross-chunk buffer (reassembly).** TCP delivers bytes in arbitrary chunks that don't align to record boundaries. A chunk might end mid-record: `{"type":"ev`. The decoder appends each chunk to a buffer, scans for newlines, emits complete lines, and *keeps the trailing partial* for the next chunk. **What breaks without it:** every record split across two TCP chunks would fail to parse. This is the part people forget — they assume one chunk equals one record. It doesn't.

```
  Reassembly — buffer holds partial lines across chunk boundaries

  chunk A: '{"type":"event"...}\n{"type":"ev'   ← second record is incomplete
       │  buffer = '{"type":"ev'  (held)
       │  emit:   {"type":"event"...}            ← complete one yielded
  chunk B: 'ent",...}\n'                          ← rest of the split record
       │  buffer = '{"type":"ev' + 'ent",...}\n'
       │  emit:   {"type":"event",...}            ← now complete, yielded
       │  buffer = ''  (clean)
```

**Part 4 — the typed envelope (application framing).** Each record has a `type`: `'event'`, `'result'`, or `'error'`. **What breaks without it:** the client couldn't distinguish a progress event from the final answer from a failure. The envelope is how one stream carries three different kinds of message. `{type:'result'}` arriving is how the client knows it's done (not the socket closing — that could be a truncation). `{type:'error'}` is how a failure rides in a body that's already committed to 200 (file `05`).

```
  Typed envelope — three message kinds over one stream

  {type:'event',  event:  CapabilityEvent}   ← live progress (many)
  {type:'result', result: {...}}             ← the final answer (one)
  {type:'error',  error:  "..."}             ← failure (instead of result)
       │
       └─ client switches on type; 'result' means success, 'error' means throw,
          'event' means update the UI
```

**Optional hardening (not the kernel).** Malformed-line tolerance: the decoder returns a bounded `warning` instead of throwing on a bad line (`maxWarnings`, default 25). Abort support: `signal?.throwIfAborted()` between records. Both are robustness on top of the kernel — strip them and it still streams; keep them and a single corrupt line or a user cancel doesn't kill the run.

### Move 2.5 — why NDJSON and not WebSocket or SSE

This is the "most surprising choice" the verdict promised. AptKit had three options and picked the plainest.

```
  Comparison — three realtime transports, why AptKit chose NDJSON

  WebSocket        bidirectional, upgrade handshake, own framing
                   → overkill: client never sends mid-stream
  SSE              one-way, text/event-stream, EventSource, auto-reconnect
                   → closer fit, but EventSource is GET-only (no POST body)
                     and reconnect/last-event-id is unused here
  NDJSON/HTTP ★    one-way, plain chunked HTTP, any body shape, trivial server
                   → CHOSEN: POST a body, stream JSON back, decode with a
                     tiny generator. Nothing the use case doesn't need.
```

The deciding factor: the request needs a **POST body** (`{fixtureId, mode}`), and the browser's `EventSource` (the SSE client) only does GET. NDJSON over a POST response sidesteps that with no loss — the stream is one-way anyway, so SSE's reconnect machinery would go unused. WebSocket's bidirectionality is pure overhead for a server-push feed. NDJSON is the floor that meets every requirement. The honest cost: you give up SSE's free auto-reconnect and `EventSource`'s built-in parsing — if the socket drops mid-run, the client just fails (file `07`); there's no resume. For a dev tool, that's the right trade.

### Move 3 — the principle

The principle: *a stream is just a response you refuse to finish, plus a delimiter*. You don't need a streaming framework or a special protocol to get realtime server-push — chunked HTTP plus newline framing plus a cross-chunk buffer is the whole thing. Reach for WebSocket only when the client must talk back mid-stream; reach for SSE when you want free reconnect on a GET; reach for raw NDJSON when you just need to push records over a POST and own the format. AptKit correctly picked the floor.

## Primary diagram

The complete stream, server to client, every layer.

```
  AptKit NDJSON stream — full picture, connection 1

  ┌─ Service (Node) ───────────────────────────────────────────┐
  │  agent loop emits CapabilityEvent                           │
  │     │  encodeNdjsonRecord({type:'event', event}) + "\n"     │
  │     ▼  res.write(...)  ── socket stays OPEN                  │
  │  ...repeat per event...                                     │
  │     │  res.write({type:'result', result}) + "\n"            │
  │     ▼  res.end()  ── socket closes                          │
  └───────────────────────────┬────────────────────────────────┘
                              │ chunked HTTP body (NDJSON)
                              │ headers: x-ndjson · no-cache · no-buffering
  ┌─ UI (browser) ────────────▼────────────────────────────────┐
  │  response.body.getReader()                                  │
  │     │  responseBodyChunks() yields Uint8Array chunks        │
  │     ▼  decodeNdjsonStream: buffer → split \n → parse        │
  │  switch(record.type):                                       │
  │     'event'  → onEvent(event)   (UI updates live)           │
  │     'result' → finalPayload     (the answer)                │
  │     'error'  → throw                                        │
  └──────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** This stream runs on every non-fixture Studio replay across all six agent panels (`/api/stream/replay`, `/api/stream/monitoring/replay`, etc. — `vite.config.ts:385-448`). It's what makes the trace panel fill in step-by-step as the agent thinks, rather than freezing until the run completes. Fixture-mode runs use the non-streaming `/api/replay` route instead.

**Server: encode + write + don't close.** `apps/studio/vite.config.ts:904-917` (`streamReplayResponse`):

```
  vite.config.ts  (streamReplayResponse, lines 904–917)

  const result = await run(body, (event) => {
    res.write(encodeNdjsonRecord({ type: 'event', event }));  ← one record per agent event,
  });                                                          ←   socket stays open
  res.write(encodeNdjsonRecord({ type: 'result', result }));  ← final record
  ...
  } finally { res.end(); }                                     ← only now: close
       │
       └─ the onEvent callback IS the stream's heartbeat: every CapabilityEvent the
          agent loop emits becomes a wire record in real time
```

**Encoding: the newline is added here.** `packages/runtime/src/ndjson-stream.ts:31-33`:

```
  ndjson-stream.ts  (encodeNdjsonRecord, lines 31–33)

  export function encodeNdjsonRecord(value: unknown): string {
    return `${JSON.stringify(value)}\n`;   ← the \n that frames every record
  }
       │
       └─ runtime owns the format; Studio owns the transport (the headers). Clean seam.
```

**Client: the cross-chunk buffer — the part that's easy to get wrong.** `packages/runtime/src/ndjson-stream.ts:103-135` (`decodeNdjsonStream`):

```
  ndjson-stream.ts  (decodeNdjsonStream, lines 107–135)

  let buffer = '';
  for await (const chunk of chunks) {
    options.signal?.throwIfAborted();                  ← abort support (hardening)
    buffer += decoder.decode(chunk, { stream: true }); ← append; bytes may split a record
    let newlineIndex = buffer.search(/\r?\n/);
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);      ← one COMPLETE record
      buffer = buffer.slice(newlineIndex + newlineLength); ← keep the rest (maybe partial)
      yield decodeNdjsonLine(line, ...);               ← parse + emit
      newlineIndex = buffer.search(/\r?\n/);
    }
  }
  if (buffer.trim()) yield decodeNdjsonLine(buffer, ...); ← flush final partial at EOF
       │
       └─ buffer surviving across loop iterations is the load-bearing part: it holds a
          half-arrived record until the next chunk completes it. {stream:true} on the
          decoder handles multibyte chars split across chunk boundaries too
```

**Client: switching on the typed envelope.** `apps/studio/src/api.ts:138-161` (`runReplayStream`):

```
  api.ts  (runReplayStream, lines 148–161)

  if (value.type === 'event' && isCapabilityEventRecord(value.event)) {
    options.onEvent?.(value.event);   ← live UI update
    continue;
  }
  if (value.type === 'result') { finalPayload = value.result; continue; } ← the answer
  if (value.type === 'error')  { throw new Error(...); }                  ← failure
  ...
  if (!finalPayload) throw new Error('streaming replay ended without a result');
       │
       └─ "ended without a result" is the truncation guard: the socket closing is NOT
          proof of success — only a 'result' record is. Missing it = the run was cut off
```

**Client: adapting the browser stream to the decoder.** `apps/studio/src/api.ts:169-180` (`responseBodyChunks`) wraps `response.body.getReader()` as an async generator so the runtime's `decodeNdjsonStream` (which knows nothing about browsers) can consume it. That's the seam where the framework-agnostic decoder meets the browser-specific `ReadableStream`.

## Elaborate

NDJSON is the same line-delimited-JSON pattern you've consumed before — it's how the Anthropic/OpenAI *streaming* APIs frame tokens (SSE in their case), how `jq` reads logs, how Kafka-ish pipelines move records. The insight worth keeping: line-delimited is the *cheapest* framing that's still self-describing — each line is independently parseable, so a reader can start anywhere and recover. Where this maps to your shipped work: AdvntrCue streams GPT-4 tokens to the browser, which is the same "refuse to finish the response" move; the difference is AptKit streams *structured trace events* (whole JSON objects) rather than text deltas, so NDJSON's one-object-per-line framing fits perfectly where SSE's `data:` text framing fits token streams. Same family, different record granularity. If AptKit ever needed the client to *steer* a run mid-flight (cancel a specific tool, inject a hint), that's the day NDJSON-over-HTTP runs out and a WebSocket earns its place — until then it's correctly avoided.

## Interview defense

**Q: Is this WebSocket, SSE, or something else? Why?**

```
  NDJSON over chunked HTTP POST — chosen because: one-way + needs a POST body
```

Neither — it's newline-delimited JSON over a long-held chunked HTTP response. WebSocket is overkill (the client never talks back mid-stream); SSE almost fits but `EventSource` is GET-only and the request needs a POST body (`{fixtureId, mode}`). NDJSON over a POST response is the floor that meets every requirement. **Anchor:** the POST-body requirement is what rules out SSE.

**Q: What's the part of the decoder people get wrong?**

```
  chunk boundaries ≠ record boundaries → buffer the partial line
```

Assuming one TCP chunk equals one record. It doesn't — a chunk can split a JSON record in half. The decoder keeps a `buffer` across chunks, emits only complete (newline-terminated) lines, and holds the trailing partial for the next chunk (`ndjson-stream.ts:108-135`). **Anchor:** the cross-chunk buffer is the load-bearing, most-forgotten part.

**Q: How does the client know the run succeeded vs got truncated?**

It waits for a `{type:'result'}` record. The socket closing is *not* proof of success — that could be truncation. If the stream ends with no result record, the client throws "ended without a result" (`api.ts:164`). **Anchor:** success is a record, not a closed socket.

## Validate

1. **Reconstruct:** Write the four kernel parts (delimiter, open response, cross-chunk buffer, typed envelope) and what breaks without each.
2. **Explain:** Why does `decodeNdjsonStream` keep a `buffer` across loop iterations? (Records split across TCP chunks — `ndjson-stream.ts:108`.)
3. **Apply:** A run's trace shows the first 3 events then stops, no error, no result. What does the client do and what does it mean? (Throws "ended without a result" — `api.ts:164`; the stream was truncated.)
4. **Defend:** Justify NDJSON over SSE here. (POST body needed; one-way stream; SSE's GET-only `EventSource` and reconnect machinery would go unused.)

## See also

- `03-tcp-udp-connections-and-sockets.md` — the long-held socket this rides on
- `05-http-semantics-caching-and-cors.md` — the three headers that make it stream
- `07-timeouts-retries-pooling-and-backpressure.md` — cancellation and the no-resume limit
- study-system-design — the NDJSON client/server handoff as an architectural seam
- study-runtime-systems — the async generators (`for await`) that drive the decode
