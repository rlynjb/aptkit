# Streaming for Perceived Latency

*Industry names: progressive rendering, server-sent events / NDJSON
streaming, time-to-first-feedback, perceived latency. Type: Industry
standard (incremental delivery).*

## Zoom out, then zoom in

An agent run takes seconds — several model turns plus tool calls. If the
UI shows nothing until the run finishes, the user stares at a spinner the
whole time. Streaming changes *when the user sees something*: each trace
event is flushed to the client the instant it's emitted, so steps and tool
calls appear live. Total time is unchanged; the *felt* latency drops to the
first event.

```
  Zoom out — where streaming sits

  ┌─ Client layer (React/Studio) ──────────────────────┐
  │  read NDJSON stream → render each event as it lands │ ← we are here (consumer)
  └──────────────────────────▲──────────────────────────┘
                            │  one NDJSON line per event, flushed live
  ┌─ Service layer (Vite middleware) ─┴─────────────────┐
  │  ★ streamReplayResponse ★  res.write(encode(event)) │ ← we are here (producer)
  └──────────────────────────▲──────────────────────────┘
                            │  trace.emit(event) during the run
  ┌─ Runtime layer (agent loop) ──────┴─────────────────┐
  │  emits step / tool_call_* / model_usage as it runs  │
  └──────────────────────────────────────────────────────┘
```

Zoom in: the agent loop already emits trace events as it works
(**01-turn-and-tool-budget.md** shows where). Streaming hooks a callback
into that emit so each event is written to the HTTP response as a newline-
delimited JSON record — and the client decodes records as they arrive.

## The structure pass

**Layers:** runtime (emits events) → service (writes each as an NDJSON
line) → client (decodes incrementally).

**Axis — lifecycle / when feedback arrives:** trace *when* the user sees
output across the streaming vs buffered approach.

```
  One axis — "when does the user see the first output?"

  ┌─ buffered (no stream) ──────────┐   ┌─ streamed (NDJSON) ─────────────┐
  │ run fully → serialize → send    │   │ event0 → flush → ... → result   │
  │ first byte arrives at END       │   │ first byte arrives at FIRST EVENT│
  │ TTFB ≈ total run time           │   │ TTFB ≈ first model turn          │
  └──────────────────────────────────┘   └──────────────────────────────────┘
```

**The seam that matters:** the HTTP response boundary, and specifically
whether the body is written *once at the end* or *incrementally during the
run*. Same total bytes, same total time — but the streamed side flips
time-to-first-byte from "end of run" to "first event," which is the entire
perceived-latency win.

## How it works

You know how `Suspense` + a skeleton lets a page show structure before the
data loads, so it *feels* fast even though the data takes the same time?
Streaming is that for an agent run — except instead of a skeleton, the user
sees the actual work happening: "calling tool X… got result… thinking…
done." The mechanism is just: write to the response as you go instead of
buffering, and parse on the client as it arrives.

### Move 1 — the mental model: emit → flush → decode, per event

```
  The kernel — incremental delivery

  run starts
    │
    ├─ emit step      → res.write(JSON + "\n")  → client decodes, renders
    ├─ emit tool_call → res.write(JSON + "\n")  → client decodes, renders
    ├─ emit usage     → res.write(JSON + "\n")  → client decodes, renders
    │
    └─ run ends → res.write(result + "\n") → res.end()
                                 │
                          client sees final result, stops reading
```

### Move 2 — the step-by-step walkthrough

**The producer side: write-as-you-emit.** The service sets an NDJSON
content type and disables buffering, then runs the agent with an `onEvent`
callback that writes each event as a record:
`res.write(encodeNdjsonRecord({ type: 'event', event }))`. Bridge from
what you know: it's the difference between `res.json(bigArray)` (one write
at the end) and calling `res.write(line)` in a loop. Each write flushes a
complete line to the socket. The load-bearing header is `x-accel-buffering:
no` (and `cache-control: no-cache`) — without it a proxy could buffer the
whole response and re-collapse it into a single late delivery, undoing the
stream. When the run finishes, one final `{ type: 'result', result }` line
carries the structured output, then `res.end()`.

```
  Producer — one line per event, flushed

  setHeader content-type: application/x-ndjson
  setHeader x-accel-buffering: no        ◄── stops proxy re-buffering (load-bearing)

  run(body, onEvent = (event) => res.write(encode({ type:'event', event })))
  res.write(encode({ type:'result', result }))
  res.end()
```

**The wire format: NDJSON (one JSON object per line).** Each record is a
complete JSON value followed by `\n`. Bridge: it's a log file where every
line stands alone — you don't need the whole file to parse one line. That's
what makes it streamable: the client can parse line N without waiting for
line N+1. A single buffered JSON array couldn't do this — you can't parse
half a JSON array.

```
  NDJSON on the wire — each line independently parseable

  {"type":"event","event":{"type":"step",...}}\n          ← parse now
  {"type":"event","event":{"type":"tool_call_start",...}}\n← parse now
  {"type":"result","result":{...}}\n                      ← final
```

**The consumer side: decode across chunk boundaries.** The runtime ships a
streaming decoder, `decodeNdjsonStream`, that buffers partial input and
only yields a record when it has a complete line — preserving partial lines
across chunk boundaries. Bridge: it's the same problem as reassembling TCP
segments into messages — bytes arrive in arbitrary chunks, and you can't
parse until you have a full line. Drop the partial-line buffering and a line
split across two network chunks would fail to parse. It also bounds warnings
(`DEFAULT_MAX_WARNINGS = 25`) so a flood of malformed lines can't grow
memory unbounded.

```
  Consumer — buffer until newline, then yield

  chunk arrives → buffer += chunk
  while buffer has a newline:
     line = buffer up to newline
     buffer = rest                  ◄── partial line survives to next chunk
     yield decode(line)
```

### Move 3 — the principle

**Latency you can't reduce, you can still hide — by delivering output
incrementally.** The run still takes its full wall-clock time; streaming
just moves the user's first feedback from the end to the first event.
The general lesson: for any operation that's slow but produces
intermediate, meaningful state, stream that state — perceived performance
is a real performance dimension, and it's often the cheapest one to
improve.

## Primary diagram

The full streaming path, producer to consumer, with the TTFB win marked.

```
  Streaming for perceived latency — full recap

  ┌─ Runtime: agent loop ─────────────────────────────────────┐
  │ trace.emit(step) … emit(tool_call_start) … emit(usage)    │
  └───────────────────────────────┬────────────────────────────┘
                                  │ onEvent callback
  ┌─ Service: streamReplayResponse ▼───────────────────────────┐
  │ headers: x-ndjson, no-cache, x-accel-buffering:no          │
  │ each event → res.write(encodeNdjsonRecord({type:'event'})) │ ── flush ──►
  │ end        → res.write({type:'result'}); res.end()         │
  └───────────────────────────────┬────────────────────────────┘
                                  │ NDJSON over HTTP (line per event)
  ┌─ Client: decodeNdjsonStream ──▼────────────────────────────┐
  │ buffer chunks → yield each complete line → render live     │
  │ TTFB ≈ first event, NOT end of run  ◄── the perceived win  │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every Studio replay stream route uses it — recommendation,
monitoring, diagnostic, query, rubric-improvement
(`apps/studio/vite.config.ts:385-448`). When you press "run" in Studio,
the trace panel fills with steps and tool calls live instead of jumping
from empty to fully-populated at the end.

**Code — the producer, `apps/studio/vite.config.ts:887-918`:**

```
res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
res.setHeader('cache-control', 'no-cache');
res.setHeader('x-accel-buffering', 'no');                  ← stop proxy buffering

try {
  const body = await readJsonBody(req);
  const result = await run(body, (event) => {              ← onEvent fires per emit
    res.write(encodeNdjsonRecord({ type: 'event', event }));  ← flush one line now
  });
  res.write(encodeNdjsonRecord({ type: 'result', result }));  ← final structured output
} catch (error) {
  res.write(encodeNdjsonRecord({ type: 'error', error: ... }));
} finally {
  res.end();                                               ← close the stream
}
```

**Code — the line encoder, `packages/runtime/src/ndjson-stream.ts:31-33`:**

```
export function encodeNdjsonRecord(value: unknown): string {
  return `${JSON.stringify(value)}\n`;                     ← exactly one parseable line + newline
}
```

**Code — the partial-line-safe decoder,
`packages/runtime/src/ndjson-stream.ts:103-135`:**

```
let buffer = '';
for await (const chunk of chunks) {
  buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
  let newlineIndex = buffer.search(/\r?\n/);
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex);
    buffer = buffer.slice(newlineIndex + newlineLength);   ← partial line survives
    yield decodeNdjsonLine(line, ++lineNumber, options);   ← parse complete line only
    newlineIndex = buffer.search(/\r?\n/);
  }
}
       │
       └─ without the buffer, a line split across two chunks would fail to parse
```

## Elaborate

NDJSON streaming is the lightweight cousin of SSE/WebSockets — no protocol
upgrade, just a content type and incremental writes, which is why it fits a
Vite middleware cleanly. The repo deliberately splits responsibility: the
runtime owns the *record encoding* (`encodeNdjsonRecord`) while Studio owns
the *transport* (the headers, `res.write`) — the comment at
`vite.config.ts:899` says exactly this. That seam keeps the perceived-
latency win provider- and transport-agnostic. It pairs with the cost ledger
(**02-token-cost-ledger.md**) — the `model_usage` events that stream live
are the same events the ledger later folds — and with the trace events as
an observability surface (**study-debugging-observability**). For the
network-transport mechanics, see **study-networking**.

## Interview defense

**Q: An agent run takes 6 seconds. How do you make the UI feel responsive
without making the run faster?**

Stream the trace events. The loop already emits a step/tool-call/usage
event at each stage; I write each one to the HTTP response as an NDJSON
line the moment it's emitted, and the client decodes lines as they arrive.
Total time is the same, but time-to-first-feedback drops from 6 seconds to
the first event.

```
  emit → res.write(line) → client renders   (per event)
  TTFB: end-of-run → first-event
```

Anchor: `vite.config.ts:887-918`, `ndjson-stream.ts:31-33`.

**Q: Why NDJSON and not a single JSON response?**

Because you can parse one NDJSON line without the rest of the stream; you
can't parse half a JSON array. NDJSON is what makes incremental delivery
possible. The consumer buffers partial lines across chunk boundaries so a
line split mid-network still parses.

Anchor: `ndjson-stream.ts:103-135`.

## Validate

1. **Reconstruct:** write the producer loop from memory — headers, per-
   event write, final result, end. Check `vite.config.ts:887-918`.
2. **Explain:** why does `x-accel-buffering: no` matter for perceived
   latency? (A buffering proxy would re-collapse the stream into one late
   delivery, erasing the win.)
3. **Apply:** a `model_usage` line arrives split across two TCP chunks.
   How does `decodeNdjsonStream` avoid a parse error?
   (`ndjson-stream.ts:103-135` — it buffers until it sees a newline.)
4. **Defend:** does streaming reduce the run's total latency or cost?
   (No — it reduces *perceived* latency only; total time and tokens are
   unchanged.)

## See also

- **02-token-cost-ledger.md** — the streamed `model_usage` events, folded.
- **06-bounded-json-scan.md** — another bounded-work guard in the runtime.
- **audit.md** — lens 7 (rendering/client performance).
- **study-debugging-observability** — the trace events as observability.
- **study-networking** — the NDJSON-over-HTTP transport.
