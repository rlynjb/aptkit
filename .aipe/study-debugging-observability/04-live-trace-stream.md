# Live trace stream

*Industry name(s): server-streamed telemetry / NDJSON streaming / live trace tailing.
Type label: Industry standard (NDJSON over HTTP); the wiring is project-specific.*

## Zoom out, then zoom in

You know how `tail -f` shows a log filling in line by line as it's written, instead of
waiting for the file to be done? The live trace stream is `tail -f` for an agent run:
each `CapabilityEvent` is serialized to one line and pushed to the browser the instant
it's emitted, so the Studio trace panel fills in *while the agent is still thinking*.

```
  Zoom out — where the stream lives

  ┌─ Studio UI layer (apps/studio) ─────────────────────────────┐
  │  AgentReplayShell: liveTrace state ──► TracePanel renders    │ ← consumer end
  └───────────────────────────────▲──────────────────────────────┘
                                   │  one NDJSON line per event (HTTP)
  ┌─ Transport: Vite dev middleware ────────────────────────────┐
  │  ★ /api/stream/replay ★  streamReplayResponse: res.write(..) │ ← we are here
  └───────────────────────────────▲──────────────────────────────┘
                                   │  encodeCapabilityEvent(event)
  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  trace sink.emit(event)  +  ndjson-stream.ts (encode/guard)  │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **serialize each event as one self-delimiting line and flush it
immediately.** NDJSON — newline-delimited JSON — is the format; one event per line; the
newline is the record boundary. The question it answers: *what is the agent doing right
now, before the run finishes?*

## The structure pass

**Layers.** The *emitter* (the runtime sink), the *encoder/transport* (NDJSON + HTTP
chunked write), and the *decoder/consumer* (the browser parsing lines into React state).

**One axis — "is the run finished?"** Trace it across the layers — the whole point is that
the answer is "no, but you can see it anyway":

```
  axis = "must the run finish before this layer sees the event?"

  ┌─ emitter ─────────────┐  NO — emits mid-run, per action
  └──────────┬────────────┘
             │  seam: res.write() per event (chunked, flushed)
  ┌─ transport ───────────┐  NO — writes each line as it arrives
  └──────────┬────────────┘
             │  seam: parse-on-newline in the browser
  ┌─ consumer (UI) ───────┐  NO — appends each event to state, re-renders
  └───────────────────────┘
```

**The load-bearing seam is `res.write()` per event** (not `res.end(allEvents)`). That's
what flips the system from "batch, then send" to "stream as you go." The second seam is
the *newline*: it's the record delimiter that lets the consumer parse a partial response
into complete events without waiting for the body to close. Lose the per-event write and
you're back to a spinner until the run ends; lose the newline framing and the consumer
can't tell where one event stops.

## How it works

### Move 1 — the mental model

One event becomes one line: `JSON.stringify(event) + "\n"`. The server writes lines into
an open HTTP response; the client reads the response as a stream, splits on newlines, and
parses each complete line into an event. The final line is the result, not an event.

```
  The pattern — one event per newline-terminated line

  emit(e1) → {"type":"model_usage",...}\n  ─┐
  emit(e2) → {"type":"tool_call_start",...}\n│  written one at a time
  emit(e3) → {"type":"tool_call_end",...}\n  │  into an open response
  ...                                         │
  done     → {"type":"result","result":{...}}\n ┘  the closing line
                    │
            client splits on \n, JSON.parse each, dispatches by envelope
```

### Move 2 — the walkthrough

**Encoding — `encodeNdjsonRecord` / `encodeCapabilityEvent`.** One function:
`JSON.stringify(value) + "\n"`. Bridge: it's `console.log(JSON.stringify(x))` except the
newline is load-bearing, not cosmetic. What breaks without the trailing `\n`: two events
concatenate into one un-parseable line; the delimiter *is* the framing.

**The server tee — `streamReplayResponse`.** It sets NDJSON headers (`content-type:
application/x-ndjson`, `cache-control: no-cache`, `x-accel-buffering: no` to defeat proxy
buffering), then runs the replay with an `onEvent` callback that writes each event wrapped
in `{ type: 'event', event }`. When the run finishes it writes one final
`{ type: 'result', result }` line; on throw it writes `{ type: 'error', error }`. Bridge:
an SSE handler, but plain NDJSON over a chunked response. What breaks without
`x-accel-buffering: no`: a buffering proxy holds the lines until the response closes, and
the "live" stream arrives all at once at the end — defeating the entire purpose.

```
  Layers-and-hops — one event, runtime to browser

  ┌─ Runtime ────────┐  emit(event)        ┌─ Vite middleware ──────┐
  │ trace sink       │ ───────────────────►│ onEvent(event):        │
  │ (in runReplay)   │                     │  res.write(            │
  └──────────────────┘                     │   encodeNdjsonRecord(  │
                                            │    {type:'event',event}))│
                                            └──────────┬─────────────┘
                                       HTTP chunk      │ {"type":"event",...}\n
                                                       ▼
                                            ┌─ Browser (AgentReplayShell) ─┐
                                            │ read chunk, split \n,        │
                                            │ setLiveTrace([...prev, event])│
                                            │ → TracePanel re-renders       │
                                            └───────────────────────────────┘
   Network boundary crossed here: same in-process CapabilityEvent, now a JSON line on
   the wire, re-typed on the other side by isCapabilityEvent().
```

**Decoding — `decodeNdjsonStream` and the partial-line problem.** HTTP chunks don't
respect line boundaries: a chunk can end mid-JSON. The decoder buffers across chunks,
emits a record only when it finds a newline, and keeps the leftover partial line in the
buffer for the next chunk. Bridge: a streaming CSV parser that holds an incomplete row
until the rest arrives. What breaks without the cross-chunk buffer: any event split across
two TCP chunks fails to parse and is lost.

```
  Execution trace — decodeNdjsonStream buffering across chunks

  chunk A = '{"type":"event","ev'        buffer='{"type":"event","ev'   no \n → wait
  chunk B = 'ent":...}\n{"type":"res'     buffer+=B → first \n found
                                          → yield {"type":"event",...}
                                          buffer='{"type":"res'          no \n → wait
  chunk C = 'ult",...}\n'                 buffer+=C → \n found → yield result
```

**The runtime guard — `isCapabilityEvent`.** After a JSON round-trip the TypeScript union
is gone; the parsed value is `unknown`. This guard re-establishes the discriminant: it
checks `type`, `capabilityId`, `timestamp`, then switches on `type` to verify the
arm-specific fields. Bridge: a Zod-lite schema check at the trust boundary. What breaks
without it: a malformed or hostile line would be treated as a valid event downstream;
`decodeCapabilityEventLines` uses it as the `validate` hook so bad lines become bounded
warnings, not crashes.

**The client append — `AgentReplayShell`.** Each event from `onEvent` is appended to
`liveTrace` state, but guarded by `runId`: if a newer run has started
(`runCounter.current !== nextRunId`), stale events are dropped. Bridge: the classic
stale-closure guard in a React effect. What breaks without it: events from an abandoned
run would bleed into the trace of the new one.

### Move 2 variant — the load-bearing skeleton

```
  the kernel:  encode(event)+"\n"  →  res.write per event  →  buffer-split-on-newline
               →  re-validate each line
```

- **Drop the per-event `res.write`** (batch with `res.end`) → no live view; you wait for
  the whole run. The stream is gone, only the result remains.
- **Drop the trailing newline** → no record framing; the consumer can't split events.
- **Drop the cross-chunk buffer** → events split by TCP boundaries are silently lost.
- **Drop the re-validation guard** → untyped JSON flows downstream as if it were a typed
  event.

**Skeleton vs hardening:** encode + write + split + validate is the skeleton.
`x-accel-buffering: no`, the bounded `maxWarnings`, the `runId` staleness guard,
`AbortSignal` checks in the stream loop — hardening that makes it robust under proxies,
floods, and re-runs.

### Move 3 — the principle

The principle is **the wire format is the in-memory format, plus a delimiter.** Because a
`CapabilityEvent` serializes to exactly one JSON line, the same value the agent loop
emits is the same value the dashboard renders — no DTO, no transform, no second schema.
NDJSON is the minimal possible framing: a newline. That minimalism is why the live stream
and the saved artifact's `trace[]` are the *same events* — one tee writes to both. Live
observability and persisted observability stop being two systems and become one stream
with two sinks.

## Primary diagram

The whole stream, one frame.

```
  Live trace stream — emit, encode, transport, decode, render

  ┌─ Runtime ───────────────────────────────────────────────────┐
  │ runReplay: sink.emit(event) → onEvent(event)                 │
  └───────────────┬──────────────────────────────────────────────┘
                  │ encodeNdjsonRecord({type:'event',event})  (ndjson-stream.ts:31-38)
                  ▼
  ┌─ Vite middleware /api/stream/replay (vite.config.ts:385-396,887-918) ─┐
  │ headers: x-ndjson, no-cache, x-accel-buffering:no                     │
  │ res.write(line) per event  ·  final res.write({type:'result',...})    │
  └───────────────┬───────────────────────────────────────────────────────┘
                  │ HTTP chunked response (lines, possibly split mid-line)
                  ▼
  ┌─ Browser ────────────────────────────────────────────────────┐
  │ decode: buffer across chunks, split on \n (decodeNdjsonStream) │
  │ validate each line (isCapabilityEvent)                         │
  │ AgentReplayShell: setLiveTrace([...prev, event])  (runId-guarded)│
  │ → TracePanel renders Turns/Tools/Warnings/Tokens live          │
  └────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases in this repo.** Every Studio "Run" against a live provider streams: the five
`/api/stream/*/replay` routes (`vite.config.ts:385-448`) all use `streamReplayResponse`.
Fixture mode runs in-process and sets the trace at the end instead. The `TracePanel`
(`components.tsx:129-180`) shows the filling trace with a live `Turns/Tools/Warnings`
summary.

**The encoder + guard — `packages/runtime/src/ndjson-stream.ts`:**

```
  ndjson-stream.ts — encode and re-validate

  :31  export function encodeNdjsonRecord(value) {
  :32    return `${JSON.stringify(value)}\n`;          ← the \n IS the record framing
       }
  :36  export function encodeCapabilityEvent(event) { return encodeNdjsonRecord(event); }

  :41  export function isCapabilityEvent(value): value is CapabilityEvent {
  :43    if (typeof value.type !== 'string') return false;       ← envelope checks
  :44    if (typeof value.capabilityId !== 'string') return false;
  :45    if (typeof value.timestamp !== 'string') return false;
  :47    switch (value.type) {                                   ← re-establish the
  :53      case 'tool_call_end':                                   discriminant after
              return typeof value.durationMs === 'number';         JSON erased the types
  :54      case 'model_usage':
              return typeof value.provider === 'string' && ...;
       } }
```

**The server write loop — `apps/studio/vite.config.ts:887-918`:**

```
  streamReplayResponse — flush per event, then the result

  :900  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  :902  res.setHeader('x-accel-buffering', 'no');     ← defeat proxy buffering (live!)
  :906  const result = await run(body, (event) => {
  :907    res.write(encodeNdjsonRecord({ type: 'event', event }));  ← one line per event
        });
  :909  res.write(encodeNdjsonRecord({ type: 'result', result }));  ← closing line
  :911  } catch (error) {
  :912    res.write(encodeNdjsonRecord({ type: 'error', ... }));    ← error as a line
  :916  } finally { res.end(); }
        │
        └─ comment at :899: "Keep transport concerns in Studio while runtime owns the
           NDJSON record encoding." The encoder is shared runtime; the HTTP wiring is
           Studio's. That seam is why the same encoder serves the artifact too.
```

**The client append — `apps/studio/src/AgentReplayShell.tsx:114-119`:**

```
  AgentReplayShell — append, guarded against stale runs

  :114  const onEvent = (event) => {
  :115    setLiveTrace((current) =>
            runCounter.current === nextRunId ? [...current, event] : current);
                              └─ drop events from an abandoned earlier run
        };
  :117  const result = modeToRun === 'fixture'
  :118    ? await runFixture(fixtureToRun)              ← fixture: no stream, set at end
  :119    : await runServer(..., { onEvent });          ← live: stream via onEvent
  :120  setLiveTrace(result.trace);                     ← reconcile to authoritative array
```

The `setLiveTrace(result.trace)` at the end is the reconciliation step: the streamed
events were a live preview, and the final authoritative `trace` array from the result
replaces them — guaranteeing the displayed trace exactly equals what was captured.

## Elaborate

NDJSON-over-HTTP is the pragmatic middle between Server-Sent Events and WebSockets:
no `EventSource` ceremony, no socket lifecycle, just a chunked response you read with a
stream reader. It's the format `kubectl logs -f`, Docker, and many CLI tools stream in.
The two non-obvious correctness details — cross-chunk buffering and re-validation after
the JSON round-trip — are exactly the things people get wrong the first time they
hand-roll streaming: they assume a chunk equals a line (it doesn't) and that a parsed
JSON object is still typed (it isn't). AptKit handles both in `ndjson-stream.ts`. The
architectural payoff named in the server comment is the real lesson: by keeping
*encoding* in runtime and *transport* in Studio, the same `encodeCapabilityEvent` serves
the live stream and the persisted artifact, so they can never represent the same event
two different ways. Read `01-structured-trace-events.md` for the event being streamed and
`02-replay-artifact-as-snapshot.md` for where the same stream gets persisted.

## Interview defense

**Q: Why NDJSON over HTTP instead of SSE or WebSockets?**
Because the payload is a stream of independent JSON records and the only framing needed is
a newline. NDJSON is the minimal format: `res.write(JSON.stringify(e)+"\n")` on the server,
split-on-newline on the client — no socket lifecycle, no event-type ceremony. The trade is
you handle buffering and parsing yourself.

```
  SSE                    NDJSON
  text/event-stream      application/x-ndjson
  data: lines + parsing  one JSON object per line
  EventSource API        plain stream reader
```

Anchor: `vite.config.ts:900-909`, `ndjson-stream.ts:31-38`.

**Q: A chunk arrives ending mid-JSON. What stops it from corrupting the trace?**
The decoder buffers across chunks and only emits a record when it sees a newline, holding
the partial line for the next chunk (`decodeNdjsonStream`, `ndjson-stream.ts:103-135`).
Without that buffer, any event split by a TCP boundary is lost. And after parsing,
`isCapabilityEvent` re-validates because the JSON round-trip erased the TypeScript types.

**Q: What single header makes this "live" rather than "all at once at the end"?**
`x-accel-buffering: no` (`vite.config.ts:902`), plus writing per event instead of
batching. A buffering proxy would otherwise hold every line until the response closed,
turning a live stream into a delayed dump.

## Validate

1. **Reconstruct:** write `encodeNdjsonRecord` from memory and explain why the trailing
   `\n` is load-bearing. Check against `ndjson-stream.ts:31-33`.
2. **Explain:** why does `streamReplayResponse` call `res.write` per event but only one
   `res.write` for the result (`vite.config.ts:906-909`)? What's the role distinction
   between an `event` line and the `result` line?
3. **Apply to a scenario:** the Studio trace panel shows nothing until the run finishes,
   then everything at once. Which two things would you check — the per-event write, or the
   `x-accel-buffering` header (`:902`)?
4. **Defend the decision:** argue why keeping *encoding* in runtime and *transport* in
   Studio (`vite.config.ts:899`) lets the live stream and the saved artifact share one
   source of truth.

## See also

- `01-structured-trace-events.md` — the event being serialized.
- `02-replay-artifact-as-snapshot.md` — the same stream, persisted instead of streamed.
- `03-usage-metrics-ledger.md` — the metric tiles the live trace updates.
- `05-degradation-warning-traces.md` — `warning` events that stream in alongside the rest.
