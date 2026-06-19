# 01 — Live stream consumption

**Industry names:** incremental streaming fetch · chunked-response consumption · client-side NDJSON streaming. **Type:** Industry standard (the browser `ReadableStream` + async-iterator pattern), applied to a project-specific NDJSON envelope.

---

## Zoom out — where this lives

This is the seam between "the server is doing work" and "the UI shows it happening." Everything else in Studio is plumbing around it.

```
  Where live stream consumption sits

  ┌─ UI layer (browser) ──────────────────────────────────────┐
  │  AgentReplayShell.startReplay()                            │
  │     │ calls runServer(fixture, mode, { onEvent })          │
  │     ▼                                                      │
  │  api.ts runReplayStream  ◄── ★ THIS CONCEPT ★             │ ← we are here
  │     reads response.body chunk by chunk,                    │
  │     turns each NDJSON line into onEvent() / finalPayload   │
  └─────────────────────────┬──────────────────────────────────┘
                            │  POST + chunked HTTP response
  ┌─ Network boundary ──────▼──────────────────────────────────┐
  │  content-type: application/x-ndjson   (study-networking)   │
  └─────────────────────────┬──────────────────────────────────┘
  ┌─ Service layer (Vite dev middleware) ◄──── streams records ┐
  │  vite.config.ts streamReplayResponse → res.write(record\n) │
  └─────────────────────────────────────────────────────────────┘
```

The question it answers: **how do you paint a trace event the instant it happens, instead of spinning until the whole run finishes?** You know the answer in shape already — it's the same idea as a `fetch()` with loading/success/error states, except instead of one resolution you get a sequence of partial resolutions, each one a `setState`.

## Structure pass

Trace one axis — **"when does the UI learn something new?"** — down the layers, and watch the answer flip.

```
  axis: "when does the UI get new information?"

  ┌─ classic fetch().json() ─────────────────┐
  │  UI learns everything AT THE END (await) │   → one moment
  └────────────────────────────┬──────────────┘
                               │  the seam flips here
  ┌─ streamed NDJSON consume ──▼──────────────┐
  │  UI learns on EACH \n-delimited record    │   → many moments
  └────────────────────────────┬──────────────┘
      ┌──────────────────────────────────────┐
      │ innermost: TextDecoder across chunks  │   → bytes, not yet lines
      └────────────────────────────────────────┘
```

- **Layers:** browser `fetch` → `response.body` ReadableStream → byte chunks → decoded text → buffered lines → parsed records → typed events → React state.
- **The load-bearing seam** is `response.body`. Above it you're in promise-resolves-once land; below it you're in iterate-until-done land. That flip is the entire pattern.
- **The trap seam** is the chunk↔line boundary: TCP gives you bytes in arbitrary chunks, and a JSON record can be split across two chunks. Whoever joins bytes into lines must hold a buffer across chunk boundaries. In this repo that's the runtime's `decodeNdjsonStream`, not Studio — Studio just feeds it raw `Uint8Array`s.

## How it works

### Move 1 — the mental model

You've consumed a `fetch` a thousand times: `await fetch(url).then(r => r.json())` — one request, one body, one resolution. Now picture the body never fully arriving at once. Instead it dribbles in as byte chunks, and you read them off a reader in a loop until the server says "done." Each complete line you can carve out of that dribble is a fact you can act on immediately.

```
  The pattern: a pull loop over a byte stream

      ┌───────────────────────────────────────┐
      │  reader = response.body.getReader()     │
      └───────────────────┬─────────────────────┘
                          │
              ┌───────────▼────────────┐
       ┌────► │  { done, value } =      │
       │      │     await reader.read() │
       │      └───────────┬─────────────┘
       │            done? │
       │        no ◄──────┼──────► yes ──► stop
       │                  ▼
       │      ┌────────────────────────┐
       │      │ buffer += value;        │
       │      │ split off complete      │
       │      │ lines; parse each;      │
       │      │ dispatch per type       │
       │      └───────────┬─────────────┘
       └──────────────────┘  loop
```

The strategy in one sentence: **pull byte chunks in a loop, accumulate into a line buffer, and emit one decoded record every time a newline completes a line.**

### Move 2 — the walkthrough

#### Part A — turning the body into an async iterable

The browser hands you `response.body` as a `ReadableStream<Uint8Array>`. The runtime decoder wants an `AsyncIterable`. The adapter bridges them: a generator that reads the stream and yields each chunk.

```
  responseBodyChunks — ReadableStream → AsyncGenerator

  get a reader from the stream
  loop forever:
     { done, value } = await reader.read()    // one chunk (or done)
     if done:    return                        // stream exhausted
     if value:   yield value                   // hand the chunk upward
  finally:       reader.releaseLock()           // always release
```

What breaks without it: `decodeNdjsonStream` expects `for await...of`; a raw `ReadableStream` isn't iterable that way in all engines, so you'd have to inline the read-loop into the decoder. Separating it keeps the decoder transport-agnostic — it doesn't know or care that the bytes came from a browser fetch versus a Node socket. **`reader.releaseLock()` in `finally` is the load-bearing detail**: drop it and the stream's lock leaks if the consumer aborts mid-read, and you can't re-acquire a reader.

#### Part B — decoding bytes into records (lives in the runtime package)

This is the part Studio delegates. The runtime's `decodeNdjsonStream` holds a `TextDecoder` and a string buffer across chunks, carves complete lines on `\n`, and yields a result per line — `{ ok: true, value }` or `{ ok: false, warning }` for a malformed line, never throwing.

```
  Layers-and-hops — bytes to typed records

  ┌─ chunk (Uint8Array) ─┐  hop 1: decode(chunk,{stream:true})
  │  raw bytes from wire │ ─────────────────────────────────►
  └──────────────────────┘                  ┌─ buffer (string) ─┐
                                             │ may end mid-line  │
                          hop 2: find \n,    └─────────┬──────────┘
                          slice complete line          │
                                             ┌─ line (string) ───▼┐
                          hop 3: JSON.parse  │ one JSON record    │
                                             └─────────┬───────────┘
                          hop 4: yield        ┌─ record ──────────▼┐
                                             │ {ok,value}|{ok:false}│
                                             └─────────────────────┘
```

The buffer is what makes split records safe: a chunk can end with `{"type":"eve` and the next begins `nt",...}\n` — the decoder holds the partial in `buffer` until the newline arrives. The `{ stream: true }` flag on `TextDecoder.decode` is the multi-byte-UTF8 equivalent: a 3-byte character split across chunks is held, not corrupted. (Mechanism owned by `study-runtime-systems` / `study-networking`; Studio relies on it.)

#### Part C — dispatching records by envelope type

Studio wraps every payload in a `{ type }` envelope so one stream carries three kinds of message. The consumer switches on it.

```
  the NDJSON envelope (one stream, three message kinds)

  {"type":"event",  "event":{…CapabilityEvent…}}   ← 0..N of these
  {"type":"event",  "event":{…}}
  {"type":"result", "result":{…final payload…}}    ← exactly 1, last
  {"type":"error",  "error":"…"}                    ← OR this, instead
```

```
  dispatch loop (pseudocode)

  finalPayload = null
  for await (record of decodeNdjsonStream(chunks)):
     if not record.ok:                 // malformed line
        onEvent(synthetic warning event)   // surface, don't crash
        continue
     value = record.value
     if value.type == 'event' and isCapabilityEvent(value.event):
        onEvent(value.event)           // → live trace setState
     else if value.type == 'result':
        finalPayload = value.result    // stash the final
     else if value.type == 'error':
        throw new Error(value.error)   // abort the run
  if not finalPayload: throw 'ended without a result'
  return mapResult(finalPayload)
```

What breaks if you drop the envelope: you couldn't tell a mid-stream trace event from the terminal result on the same channel. The envelope lets one HTTP response carry the whole run — progress *and* outcome — without a second request. **The `finalPayload` null-check is the load-bearing termination guard**: if the stream closes after the last event but before a `result` record (server crash mid-run), you throw "ended without a result" rather than silently returning stale or undefined UI state.

#### Part D — the `onEvent` callback into React state

`runReplayStream` doesn't touch React. It takes an `onEvent` callback. The shell supplies one that appends to `liveTrace`:

```
  onEvent (supplied by AgentReplayShell)

  onEvent = (event) =>
     setLiveTrace(current =>
        runCounter.current === nextRunId      // §02 stale-run guard
           ? [...current, event]               // append → re-render
           : current)                          // stale run → drop
```

This is the inversion that keeps the layers clean: the network module knows nothing about React; the React module knows nothing about chunk decoding. They meet at one callback. Each call is a `setState`, so the trace list repaints per event — that's the "live" in live stream consumption. (The `runCounter` guard is the whole of `02-stale-run-guard.md`; the per-event re-render cost is `study-performance-engineering`.)

### Move 3 — the principle

A streamed response is just a `fetch` whose body resolves many times instead of once. The instant you stop `await`-ing the *whole* body and start iterating its *chunks*, "loading → done" becomes "a sequence of partial dones," and each partial done is a render. Keep the byte→line→record→event decode pipeline transport-agnostic and meet React at exactly one callback, and the same consumer works for a browser fetch, a Node socket, or a test harness.

## Primary diagram

```
  Live stream consumption — full pipeline

  ┌─ Service (Vite middleware) ─────────────────────────────────┐
  │ streamReplayResponse: res.write(encodeNdjsonRecord(rec))     │
  │   one {type:event} per trace emit, then {type:result}        │
  └───────────────────────────────┬──────────────────────────────┘
                                  │ chunked HTTP, application/x-ndjson
  ┌─ Network boundary ────────────▼──────────────────────────────┐
  │  ...}\n  ...}\n  ...}\n   (records may split across chunks)   │
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ UI: api.ts ──────────────────▼──────────────────────────────┐
  │ responseBodyChunks(body)   reader.read() loop → Uint8Array    │
  │            │                                                  │
  │            ▼                                                  │
  │ decodeNdjsonStream  (runtime)  TextDecoder + buffer + split   │
  │            │  yields {ok,value} per line                      │
  │            ▼                                                  │
  │ switch(value.type):  event→onEvent  result→stash  error→throw │
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ UI: React state ─────────────▼──────────────────────────────┐
  │ onEvent → setLiveTrace([...current, event])  (guarded §02)    │
  │ visibleTrace = replay?.trace ?? liveTrace  → <TracePanel/>    │
  │ final: setReplay({...result, runId, completedAt})             │
  └────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

### Use cases

Reached for exactly when a workspace runs an agent against a **live provider** (anthropic/openai), not a fixture. `startReplay` branches: fixture mode runs locally in the browser and returns a finished result; provider mode calls `runServer`, which is the streaming path (`AgentReplayShell.tsx:117-119`). So the stream consumer fires when you click "Run Anthropic" or "Run OpenAI" in Recommendation, Monitoring, Diagnostic, Query, or Rubric Improvement — five of the six workspaces, each via its own `runServer*` wrapper in `api.ts`.

### Code, line by line

```
  apps/studio/src/api.ts:169-180  — the body→chunks adapter

  async function* responseBodyChunks(body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();          ← lock the stream, one reader
    try {
      while (true) {
        const { done, value } = await reader.read();  ← pull one chunk
        if (done) return;                     ← server closed → stop
        if (value) yield value;               ← hand chunk to decoder
      }
    } finally {
      reader.releaseLock();                    ← ALWAYS release (abort-safe)
    }
  }
       │
       └─ without the finally/releaseLock, an aborted run leaks the
          stream lock and the body can't be re-read (load-bearing)
```

```
  apps/studio/src/api.ts:126-166  — fetch + dispatch

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId, mode }),  ← POST body → why not SSE/EventSource
  });
  if (!response.body) {                          ← no stream? read error JSON
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? 'streaming replay failed');
  }

  let finalPayload: any = null;
  for await (const record of decodeNdjsonStream(responseBodyChunks(response.body))) {
    if (!record.ok) {                            ← malformed line:
      options.onEvent?.({ type: 'warning', … }); ←   surface as a trace warning,
      continue;                                  ←   do NOT crash the run
    }
    const value = record.value;
    if (!isRecord(value) || typeof value.type !== 'string') continue;  ← envelope guard
    if (value.type === 'event' && isCapabilityEventRecord(value.event)) {
      options.onEvent?.(value.event);            ← live → setLiveTrace (§02)
      continue;
    }
    if (value.type === 'result') { finalPayload = value.result; continue; }  ← stash final
    if (value.type === 'error') { throw new Error(…); }   ← server-side run error
  }
  if (!response.ok) throw new Error('streaming replay failed');
  if (!finalPayload) throw new Error('streaming replay ended without a result');  ← termination guard
  return mapResult(finalPayload);                ← shape the final into R
       │
       └─ note the two failure layers: a malformed LINE is recoverable
          (warning + continue); a missing RESULT or an error RECORD is fatal
```

```
  apps/studio/vite.config.ts:887-918  — the producing side (dev server)

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');     ← defeat proxy buffering so
                                                ←   chunks flush immediately
  const result = await run(body, (event) => {
    res.write(encodeNdjsonRecord({ type: 'event', event }));  ← one line per emit
  });
  res.write(encodeNdjsonRecord({ type: 'result', result }));  ← terminal line
       │
       └─ encodeNdjsonRecord just does JSON.stringify(v) + '\n'
          (packages/runtime/src/ndjson-stream.ts:31) — the newline IS the framing
```

The wire contract (headers, framing, why chunked-POST instead of SSE) belongs to `study-networking`; the server-side stream origination to `study-system-design` (`ndjson-stream-handoff`).

## Elaborate

This pattern is the browser-native answer to the same problem WebSockets and SSE solve — server pushing incremental data — but reached via the Streams API on a plain `fetch`. The reason Studio uses chunked-`fetch` + NDJSON rather than `EventSource` is concrete: `EventSource` is GET-only and can't carry a JSON request body, but each replay needs to POST `{ fixtureId, mode }`. NDJSON-over-POST keeps the request expressive and the response streamable. The envelope-with-`type` is the same move GraphQL subscriptions and JSON-RPC streaming make: multiplex heterogeneous messages (progress vs result vs error) over one ordered channel.

What to read next: `02-stale-run-guard.md` (what keeps `onEvent` from corrupting state when you re-run), then `study-networking` for the wire, then `study-runtime-systems` for the `for await` / event-loop interleaving.

## Interview defense

**Q: How does the trace panel update live instead of all at once?**
The replay endpoint streams NDJSON — one `{type:"event"}` line per trace event, a final `{type:"result"}` line. Client-side I read `response.body` as a `ReadableStream`, adapt it to an async iterable, and feed it to a decoder that buffers bytes and yields one record per `\n`. Each `event` record fires an `onEvent` callback that does `setLiveTrace(c => [...c, event])`, so React repaints per event. The body resolves many times, not once.

```
  reader.read() loop → buffer+split → onEvent(setState) → repaint per event
```
Anchor: `api.ts:138-161`.

**Q: What's the part people forget?**
Two. First, the line buffer across chunk boundaries — TCP splits records arbitrarily, so a record can span two chunks; you hold a partial in a buffer until the newline. Second, the termination guard: if the stream closes without a `result` line, throw "ended without a result" rather than returning undefined. Both are about not trusting the stream to be tidy.

Anchor: buffer at `ndjson-stream.ts:108-119`; termination at `api.ts:164`.

**Q: Why not EventSource / WebSocket?**
EventSource is GET-only; the replay needs a POST body (`fixtureId`, `mode`). WebSocket is overkill for a one-shot run-and-done — no bidirectional need. Chunked-`fetch` + NDJSON is the minimal fit.

```
  POST {fixtureId,mode} ──► chunked NDJSON response ──► done (no socket kept open)
```

## Validate

1. **Reconstruct:** from memory, write `responseBodyChunks` and the dispatch loop. Must include `releaseLock` in `finally` and the `finalPayload` null-check. (`api.ts:169-180, 126-166`)
2. **Explain:** why is `runReplayStream` parameterized with a `mapResult` callback rather than returning the raw payload? (Each agent's result shape differs — `toReplayResult` vs `toMonitoringReplayResult` at `api.ts:107, 95` — so the consumer is generic and the caller supplies the shaping.)
3. **Apply:** a malformed line arrives mid-stream. Trace what happens. (`record.ok === false` → synthetic warning event via `onEvent` → `continue`; the run survives, the warning shows in the trace panel — `api.ts:139-147`.)
4. **Defend:** the server crashes after emitting 3 events but before the result line. What does the user see? (Three trace events painted, then the loop ends with `finalPayload === null`, the `throw` fires, `startReplay`'s catch sets `error`, and the workspace shows the error state — `AgentReplayShell.tsx:126-127`.)

## See also

- `02-stale-run-guard.md` — the `runCounter` guard wrapping `onEvent`.
- `03-shared-replay-shell.md` — where `startReplay` and `liveTrace` live.
- `00-overview.md` — the stream→state→render diagram in context.
- Cross-guide: `study-networking` (NDJSON wire), `study-system-design` (`ndjson-stream-handoff`, `client-stream-handoff`), `study-runtime-systems` (async stream consumption).
