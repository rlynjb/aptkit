# NDJSON stream handoff — runtime emits, Studio streams to the UI

**Industry names:** NDJSON / JSON-lines streaming / Server-Sent-Events-style progressive response / event-trace streaming. **Type:** Industry standard.

## Zoom out, then zoom in

This is a flow that crosses three layers — runtime (produces events), Studio's Vite middleware (encodes + ships them), and the React UI (decodes + renders). Find the seam where one `CapabilityEvent` becomes one line of text on the wire.

```
  Zoom out — where the stream handoff lives

  ┌─ UI layer — apps/studio/src (React) ────────────────────┐
  │  click "Replay" → fetch POST → decode NDJSON stream      │ ← we are here (consumer)
  └───────────────────────────┬──────────────────────────────┘
                              │  HTTP, content-type: application/x-ndjson
  ┌─ Service layer — apps/studio/vite.config.ts middleware ──▼┐
  │  ★ streamReplayResponse ★  res.write(encodeNdjsonRecord)  │ ← we are here (transport)
  └───────────────────────────┬──────────────────────────────┘
                              │  onEvent callback
  ┌─ Runtime core — packages/runtime ─────────▼──────────────┐
  │  runAgentLoop emits CapabilityEvent[] to a trace sink     │ ← we are here (producer)
  │  ndjson-stream.ts: encodeNdjsonRecord / decodeNdjsonStream│
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. You know the pain this solves: an agent run takes seconds, and if the UI waits for the whole thing to finish before showing anything, the user stares at a spinner with no idea what's happening. The pattern is **progressive streaming over NDJSON** — newline-delimited JSON, one event per line — so the server flushes each trace event the instant it happens and the client renders it live. It's the same instinct as a streaming chat response, but here the stream carries *structured trace events* (tool calls, model usage, steps), not just tokens. The clean part: the runtime owns *what* an event is, Studio owns *how it travels*.

## Structure pass

**Layers:** runtime (event producer) → Vite middleware (transport) → React (consumer). One axis explains the split.

**Axis — state ownership: who owns the trace?**

```
  "who owns the event / trace state?" — traced across the hops

  ┌─ runtime ───────────┐  seam   ┌─ Studio middleware ─┐  seam  ┌─ React UI ──────┐
  │ PRODUCES events     │ ══╪════► │ ENCODES per line    │ ══╪═══►│ ACCUMULATES into│
  │ (emit to sink)      │ (flips) │ (writes, no buffer) │(flips) │ liveTrace state │
  │ owns NOTHING durable│         │ owns NOTHING        │        │ owns the trace  │
  └─────────────────────┘         └─────────────────────┘        └─────────────────┘
```

Ownership of the trace state flips twice: the runtime *produces* but never *holds* it (it emits to a caller's sink); the middleware *relays* but never holds it (write-and-forget); the React client is the first place the trace *accumulates* as durable state. That's the design — the runtime stays stateless about observability, and storage is the consumer's choice (React state here, a JSON array in a script elsewhere). The seam that matters: the `encodeNdjsonRecord` boundary, where a typed `CapabilityEvent` becomes a line of bytes. Hand off to How it works.

## How it works

#### Move 1 — the mental model

The shape is a producer-consumer stream framed by newlines. You've consumed one of these reading a streaming `fetch` response, or tailing a log file line by line. The kernel: the producer `JSON.stringify`s each event and appends `\n`; the consumer reads chunks, splits on newlines, and parses each complete line as it arrives. The newline is the frame delimiter — that's the entire protocol.

```
  The NDJSON frame protocol

  produce:  {"type":"event","event":{...}}\n   ← one event, one line
            {"type":"event","event":{...}}\n
            {"type":"result","result":{...}}\n  ← terminal record
            (or)  {"type":"error","error":"..."}\n

  consume:  buffer += chunk
            while buffer has '\n':
               line = buffer up to '\n'
               yield JSON.parse(line)
               buffer = rest                    ← partial line stays buffered
```

The non-obvious part is on the consumer: a network chunk doesn't respect line boundaries. One chunk might contain two and a half lines. So the consumer buffers, emits only *complete* lines, and keeps the partial tail for the next chunk. Get that wrong and you try to `JSON.parse` half an object.

#### Move 2 — the step-by-step walkthrough

**The runtime emits typed events to a sink.** As the agent loop runs (`02-`), it calls `trace?.emit(event)` for each `CapabilityEvent` — `step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`. The runtime doesn't know or care where the events go; it just emits to whatever `CapabilityTraceSink` the caller passed. The bridge: it's an event emitter / callback — the producer fires events, the listener decides what to do. The boundary condition: the runtime holds *no* trace state, so the same loop works whether the sink streams to a browser or pushes to an array in a test.

**Studio's middleware turns the sink into writes.** The Vite middleware (`streamReplayResponse`) sets `content-type: application/x-ndjson`, `cache-control: no-cache`, and `x-accel-buffering: no` (tells any proxy *not* to buffer), then runs the agent with an `onEvent` callback that does `res.write(encodeNdjsonRecord({ type:'event', event }))` — one line per event, flushed immediately. When the run finishes it writes a terminal `{ type:'result', result }` line; on error, a `{ type:'error', error }` line; `finally` ends the response. The bridge: it's an HTTP handler that flushes incrementally instead of building a body and sending it once. The boundary condition: `x-accel-buffering: no` is load-bearing — without it, a proxy might buffer the whole stream and defeat the entire point (the client sees nothing until the end).

```
  Layers-and-hops — an event crossing producer → wire → consumer

  ┌─ runtime loop ──────┐ hop 1: emit(CapabilityEvent)  ┌─ Studio middleware ─┐
  │ trace.emit(event)   │ ─────────────────────────────►│ onEvent callback    │
  └─────────────────────┘                               └─────────┬───────────┘
                                              hop 2 │ res.write(encodeNdjsonRecord)
                                                     ▼  (one line, flushed now)
                          ┌─ HTTP (application/x-ndjson) ──────────────────────┐
                          │  {"type":"event","event":{...}}\n  ...             │
                          └──────────────────────────────────┬──────────────────┘
  ┌─ React UI ──────────┐ hop 4: onEvent(event) → setLiveTrace([...t, event])  │
  │ decodeNdjsonStream  │ ◄───────────────────────── hop 3: read chunk, split  ▼
  │ → live trace render │   on '\n', JSON.parse each complete line
  └─────────────────────┘
```

**The client reads chunks and reassembles lines.** `runReplayStream` does the `fetch` POST, gets `response.body` (a `ReadableStream`), and feeds it to `decodeNdjsonStream` — an async generator that accumulates a buffer, finds `\n` boundaries (handling both `\n` and `\r\n`), yields each complete line parsed, and keeps the partial tail. For each yielded record it dispatches: `type:'event'` → call `onEvent`; `type:'result'` → capture the final payload; `type:'error'` → throw. The bridge: it's `for await (const line of stream)` over a chunked response. The boundary condition: a malformed line doesn't kill the stream — it's surfaced as a warning event and skipped, so one bad record doesn't lose the rest of the run.

**React accumulates into live state.** The `onEvent` callback in `AgentReplayShell` does `setLiveTrace(current => [...current, event])`, guarded by a `runId` check so a stale run's events don't pollute a newer run's trace. When the result arrives, it swaps `liveTrace` for the authoritative `replay.trace`. The bridge: it's `setState` appending to an array on each event — the same thing you'd do rendering a live feed. The boundary condition: the `runId` guard prevents a race where you start a new replay before the old one's events stop arriving.

```
  Execution trace — events accumulating in React

  start replay #5 → liveTrace = []
  event(model_usage) → runId==5 → liveTrace = [u0]
  event(tool_call_start) → liveTrace = [u0, ts0]
  event(tool_call_end)   → liveTrace = [u0, ts0, te0]
  result arrives → replay.trace = [authoritative full trace]  (liveTrace superseded)
  (if user started replay #6 mid-stream → runId!=5 → stale events dropped)
```

#### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** A producer that emits typed events to a sink + a one-event-per-line encoding (`JSON.stringify + \n`) + a buffered, newline-framed decoder on the consumer + a terminal record (`result`/`error`) so the consumer knows the stream is done.

2. **Name each part by what breaks if removed.**
   - Remove the **newline framing** → the consumer can't tell where one JSON object ends and the next begins; you'd need length-prefixing or a different protocol.
   - Remove the **consumer-side buffer** → you `JSON.parse` partial lines from chunk boundaries and crash on the first split object.
   - Remove the **terminal record** → the consumer can't distinguish "stream still going" from "stream finished"; it doesn't know when it has the final result.
   - Remove `x-accel-buffering: no` (the proxy hint) → a buffering proxy holds the whole stream and the client sees nothing until the end — the streaming is silently defeated.

3. **Skeleton vs hardening.** Skeleton: emit-to-sink, line encoding, buffered decode, terminal record. Hardening: the malformed-line warning (don't drop the whole stream on one bad line), the `runId` staleness guard, the `\r\n` handling, the `no-cache`/`x-accel-buffering` headers. The stream *works* with just the skeleton; the hardening makes it robust to proxies, races, and partial corruption.

The interview payoff: name the **consumer-side buffering across chunk boundaries**. The naive mental model is "each chunk is a line." The production reality is that TCP chunks split mid-object, so the decoder *must* buffer and only emit complete lines. That's the bug that bites everyone who writes their first streaming parser, and naming it shows you've actually consumed one.

#### Move 3 — the principle

Separate what an event *is* from how it *travels*. The runtime defines the event shape and emits to an abstract sink; the transport layer decides the framing and the wire format; the consumer decides storage. Because the seam between them is just "emit a typed event," the same runtime streams to a browser, writes to a file, or pushes to a test array — without knowing which. Push transport concerns out of the producer and the producer stays reusable.

## Primary diagram

The full recap — producer, encode, wire, decode, accumulate, with the terminal record marked.

```
  NDJSON stream handoff — full picture

  ┌─ runtime (producer) ──────────────────────────────────────────────────┐
  │  runAgentLoop → trace.emit(CapabilityEvent)  (step/tool/usage/warn/err) │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │  onEvent callback
  ┌─ Studio middleware (transport) ▼──────────────────────────────────────┐
  │  content-type: application/x-ndjson; x-accel-buffering: no             │
  │  per event:  res.write(encodeNdjsonRecord({type:'event', event}))\n    │
  │  at end:     res.write({type:'result', result})\n   ◄── terminal       │
  │  on throw:   res.write({type:'error', error})\n                        │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 ▼  HTTP chunked stream
  ┌─ React UI (consumer) ──────────────────────────────────────────────────┐
  │  decodeNdjsonStream(responseBodyChunks):                                │
  │    buffer chunks → split on \n / \r\n → JSON.parse complete lines       │
  │    event → onEvent → setLiveTrace([...t, e]) (runId-guarded)            │
  │    result → finalPayload ;  error → throw ;  malformed → warn + skip    │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** You click "Replay" on the recommendation panel in Studio. Instead of a frozen spinner, you watch the trace fill in live: `model_usage` (the first turn ran), `tool_call_start get_segments`, `tool_call_end (340ms)`, another model turn, then the final recommendations. That live feedback is the whole reason Studio streams instead of returning one blob. The same `runAgentLoop` events, when run from a script, get pushed into an array and serialized into a replay artifact (`06-`) — same producer, different sink.

**The producer side — emit to a sink** — `packages/runtime/src/events.ts` (lines 1–28) and the loop's emits:

```
  CapabilityEvent =                                   ← events.ts lines 1-24
    | { type:'step', capabilityId, role, content, timestamp }
    | { type:'tool_call_start', capabilityId, toolName, args, timestamp }
    | { type:'tool_call_end', capabilityId, toolName, result?, error?, durationMs, ts }
    | { type:'model_usage', capabilityId, provider, model, inputTokens?, ..., ts }
    | { type:'warning', ... } | { type:'error', ... };
  type CapabilityTraceSink = { emit(event: CapabilityEvent): void };  ← lines 26-28
       │
       └─ The runtime emits to a SINK (lines 26-28), not to a stream or a file. It
          owns the event SHAPE, not its destination. Same loop → browser / file / array.
```

**The transport side — write one line per event** — `apps/studio/vite.config.ts` (lines 887–918):

```
  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8'); ← line 900
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');                            ← line 902, NO proxy buffer
  try {
    const result = await run(body, (event) => {
      res.write(encodeNdjsonRecord({ type: 'event', event }));         ← line 907, per-event flush
    });
    res.write(encodeNdjsonRecord({ type: 'result', result }));         ← line 909, terminal
  } catch (error) {
    res.write(encodeNdjsonRecord({ type: 'error', error: ... }));      ← on throw
  } finally { res.end(); }
       │
       └─ Line 902 (x-accel-buffering: no) is load-bearing — without it a proxy buffers
          the whole stream and the client sees nothing until the end. Line 907 flushes
          each event the instant it's emitted; line 909 is the terminal record.
```

**The encoder** — `packages/runtime/src/ndjson-stream.ts` (lines 31–33):

```
  export function encodeNdjsonRecord(value) {
    return `${JSON.stringify(value)}\n`;             ← stringify + newline frame
  }
       │
       └─ The entire wire protocol: one object → one line. The \n is the frame
          delimiter the consumer splits on. Runtime owns this; Studio just calls it.
```

**The consumer side — buffered decode** — `packages/runtime/src/ndjson-stream.ts` (lines 103–134) + `apps/studio/src/api.ts` (lines 119–166):

```
  // ndjson-stream.ts — the buffered decoder
  let buffer = '';
  for await (const chunk of chunks) {                ← line 111
    buffer += decode(chunk);                          ← line 113, accumulate
    let nl = buffer.search(/\r?\n/);                  ← line 115, find frame end
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (/* \r\n? 2 : 1 */)); ← line 118-119, keep the tail
      yield decodeNdjsonLine(line, ...);              ← parse ONLY complete lines
      nl = buffer.search(/\r?\n/);
    }
  }
  // flush final buffered line after stream ends      ← lines 128-134

  // api.ts — dispatch each record
  for await (const record of decodeNdjsonStream(responseBodyChunks(response.body))) {
    if (!record.ok) { onEvent(warning); continue; }   ← line 139-145, malformed → warn+skip
    if (value.type === 'event') onEvent(value.event);  ← line 152-154
    if (value.type === 'result') finalPayload = value.result;  ← line 156
    if (value.type === 'error') throw ...;             ← line 160
  }
       │
       └─ Lines 113-119 are the chunk-boundary fix: buffer, split on \n, keep the
          partial tail. The malformed-line branch (api.ts 139-145) skips one bad record
          without losing the stream — robustness, not skeleton.
```

**The React accumulation** — `apps/studio/src/AgentReplayShell.tsx` (lines 91–131):

```
  const [liveTrace, setLiveTrace] = React.useState<CapabilityEvent[]>([]);  ← line 92
  const onEvent = (event) => {
    setLiveTrace((current) =>
      runCounter.current === nextRunId ? [...current, event] : current);    ← lines 114-116
  };
  // ...after the run:
  setLiveTrace(result.trace);   ← swap live accumulation for authoritative trace
       │
       └─ Lines 114-116: append each event to React state, BUT only if this is still
          the current run (runId guard) — prevents a stale run's late events from
          polluting a newer run's trace. visibleTrace = replay?.trace ?? liveTrace (161).
```

## Elaborate

NDJSON (newline-delimited JSON, a.k.a. JSON Lines) is the pragmatic middle ground between Server-Sent Events and a full WebSocket: it works over a plain HTTP response, needs no special server protocol, and is trivially parseable. AptKit uses it because the runtime already produces a *stream of discrete typed events* — a perfect fit for one-object-per-line. The deliberate split is that the runtime owns the encoding helpers (`ndjson-stream.ts`) but the transport headers and route wiring live in Studio (`vite.config.ts`) — "keep transport concerns in Studio while runtime owns the record encoding," per the code's own comment.

The *wire-level* view — TCP framing, HTTP chunked transfer-encoding, connection lifecycle, proxy buffering mechanics — belongs to study-networking when generated; that guide owns what happens on the wire. The *runtime* view — async generators, backpressure, the event loop driving `for await` — belongs to study-runtime-systems. This guide owns the *architectural* split: producer emits typed events, transport frames them, consumer accumulates — three layers, two seams, clean ownership at each.

Next: `06-replay-eval-pipeline.md` shows the *other* sink for these same events — a script that serializes the trace into a durable artifact instead of streaming it.

## Interview defense

**Q: How do you show an agent's progress live instead of waiting for it to finish?**

Stream the trace as NDJSON. The runtime emits typed events to a sink; the server writes each one as a JSON line (`{...}\n`) and flushes immediately; the client reads the chunked response, splits on newlines, and renders each event as it arrives. A terminal `result` line signals completion.

```
  emit event → res.write(JSON.stringify(event)+'\n')  → client splits on \n → render
  ...                                                  → terminal {type:'result'} line
```

Anchor: `vite.config.ts:887-918` (server), `api.ts:119-166` (client), `ndjson-stream.ts:31-33` (encode).

**Q: What's the classic bug in writing the stream consumer?**

Assuming each network chunk is one complete line. TCP splits objects across chunks, so you must buffer and only parse *complete* lines, keeping the partial tail for the next chunk. Parse a chunk directly and you'll `JSON.parse` half an object and crash.

```
  wrong:   JSON.parse(chunk)                     ← chunk may be half a line ✗
  right:   buffer += chunk; split on \n;
           parse complete lines; keep the tail   ✓
```

Anchor: `ndjson-stream.ts:113-119` — the buffer + split + keep-tail loop.

## Validate

1. **Reconstruct.** Write the consumer loop from memory: accumulate buffer, find `\n`, parse complete lines, keep the tail. Check against `ndjson-stream.ts:111-134`.
2. **Explain.** Why does the runtime emit to a *sink* (`events.ts:26-28`) instead of writing to the stream directly? What does that buy? (Hint: the same loop also feeds a script's array — `06-`.)
3. **Apply.** A proxy in front of Studio buffers the whole response so the client sees nothing until the end. Which one header fixes it, and why? (Hint: `vite.config.ts:902`.)
4. **Defend.** A teammate wants to drop the `runId` guard in `onEvent` (`AgentReplayShell.tsx:114-116`) as "unnecessary." Describe the race it prevents.

## See also

- `02-bounded-agent-loop.md` — the loop that emits these events.
- `06-replay-eval-pipeline.md` — the other sink: a script serializing the trace to an artifact.
- `01-provider-abstraction.md` — the same "owns the shape, not the destination" instinct.
- `audit.md` lens 2 (the Studio flow), lens 3 (the trace is append-only, caller-owned).
- study-networking / study-runtime-systems (when generated) — wire framing and async generators.
