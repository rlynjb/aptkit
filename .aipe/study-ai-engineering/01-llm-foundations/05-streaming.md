# Streaming — trace events stream, tokens do not

**Industry names:** token streaming (SSE), server-sent events, incremental decoding · *Industry standard*

## Zoom out, then zoom in

"Streaming" means two different things in an LLM app, and conflating them is a
classic interview trap. There's *token streaming* — the model's text arriving
word-by-word as it's generated — and there's *event streaming* — your app
pushing progress records to a UI as work happens. AptKit does one and not the
other. Here's the split.

```
  Zoom out — two kinds of streaming, one of them exercised

  ┌─ Studio UI (apps/studio) ───────────────────────────────────────┐
  │  reads an NDJSON response, renders trace events as they arrive   │
  └───────────────────────────────▲──────────────────────────────────┘
                                   │  ★ EVENT streaming (NDJSON) ★ ← EXERCISED
  ┌─ Studio Vite middleware ───────┴──────────────────────────────────┐
  │  res.write(encodeNdjsonRecord(...)) per CapabilityEvent           │
  └───────────────────────────────▲──────────────────────────────────┘
                                   │  trace.emit(event) during the run
  ┌─ Runtime: runAgentLoop / generateStructured ──┴────────────────────┐
  │  await model.complete(...)  → returns the WHOLE response           │
  │       ▲ TOKEN streaming ← NOT exercised (no token-by-token here)    │
  ┌───────┴────────────────────────────────────────────────────────────┐
  │ Provider: complete() : Promise<ModelResponse>  (awaited whole)       │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: AptKit **does not stream LLM tokens**. Every `model.complete()` returns
`Promise<ModelResponse>` — you `await` the entire response before doing anything
with it. But AptKit **does stream trace events**: as the agent loop runs, it
emits `CapabilityEvent` records (steps, tool calls, token-usage rows), and Studio
serializes those to the browser as NDJSON, line by line, while the run is still
in progress. The distinction is the whole lesson here.

## Structure pass

**Layers.** Two streams worth separating. The *model stream* (provider →
runtime): in principle could be token-by-token, but in AptKit it's a single
awaited response. The *event stream* (runtime → Studio → browser): genuinely
incremental, one NDJSON line per `CapabilityEvent`.

**Axis — guarantees: is data delivered incrementally or all-at-once?** Trace it.
Provider → runtime: **all-at-once** (`await` the whole `ModelResponse`). Runtime →
middleware: **incremental** (`trace.emit` fires per event during the run).
Middleware → browser: **incremental** (`res.write` per record, no buffering). The
guarantee flips from batch to streaming at the runtime's emit boundary — and
notably *not* at the model boundary.

**Seam.** The seam is `CapabilityTraceSink.emit(event)`. The runtime calls it the
instant something happens; the Studio middleware's sink turns each call into a
written NDJSON line. That seam is what makes the *event* stream live even though
the *model* call underneath it is a blocking await.

## How it works

You know two web primitives: `await fetch()` (you get the whole body, then act)
and a server-sent-events / NDJSON response (the body arrives in pieces and you
react to each). AptKit uses the first for the model and the second for traces.

### Move 1 — the mental model

Picture one agent turn. The model call is a blocking box — nothing emerges until
it's done. But *around* those boxes, the loop emits a steady drip of events that
flow straight to the UI.

```
  Two timelines in one run

  model calls (BLOCKING — await each whole):
    [████ complete() turn 1 ████][████ complete() turn 2 ████]
         ▲ no tokens until this box closes

  trace events (STREAMING — emitted as they happen):
    step ─ tool_call_start ─ tool_call_end ─ model_usage ─ step ─ …
       │       │                  │              │           │
       └───────┴──────────────────┴──────────────┴───────────┘
                      each → one NDJSON line to the browser, live
```

So the user watching Studio sees progress *between* model calls — "ran
`get_metric_timeseries`", "used 1,240 input tokens" — but they do *not* see the
model's answer typing itself out. The answer appears whole when its `complete()`
box closes.

### Move 2 — the step-by-step walkthrough

#### The model call is awaited whole

The contract returns a `Promise<ModelResponse>`, not an async iterator. The
runtime `await`s it and only then reads `response.content`. There is no
token-by-token path anywhere in the runtime or adapters.

```
  Token path — what actually happens (pseudocode)

  response = await model.complete(request)   // ← blocks until FULLY done
  text     = join(text blocks of response)   // ← only now is text available
  // no callback, no async iterator, no partial text
```

The boundary condition that makes this hard to change is in the very next file:
`generateStructured` calls `parseAgentJson` + a validator on the *complete*
`rawText`. You cannot validate `{"verdict":` — JSON parsing needs the closing
brace. So the structured path *structurally requires* the whole response. That's
the main reason token streaming isn't bolted on: the repo's most important model
path can't consume a partial.

#### The event stream is genuinely incremental

While the model calls block, the loop emits `CapabilityEvent`s through a
`CapabilityTraceSink`. In Studio, that sink writes each event as an NDJSON line on
the open HTTP response — so the browser receives them as they happen.

```
  Event stream — runtime to browser (layers-and-hops)

  ┌─ Runtime ──────────┐ emit(event)  ┌─ Studio middleware ─────┐
  │ runAgentLoop emits │ ───────────► │ traceSink.emit(e) →     │
  │ step/tool/usage    │              │   res.write(            │
  │                    │              │     encodeNdjsonRecord( │
  │                    │              │       {type:'event',e}))│
  └────────────────────┘              └───────────┬─────────────┘
                                                  │ NDJSON line, live
                              content-type: application/x-ndjson
                              x-accel-buffering: no   (don't buffer!)
                                                  ▼
                                       ┌─ Browser ───────────┐
                                       │ decode line, render │
                                       └─────────────────────┘
```

The `x-accel-buffering: no` header is load-bearing — it tells any proxy not to
buffer the response, so lines actually reach the browser as written rather than
in one lump at the end. Drop it and "streaming" silently degrades to "all at the
end." After all events, the middleware writes one final `{type:'result', result}`
record so the client knows the run finished.

#### What NDJSON buys over SSE here

NDJSON is just "one JSON value per line." The runtime owns the *encoding*
(`encodeCapabilityEvent` / `encodeNdjsonRecord`); Studio owns the *transport*
(headers + `res.write`). The decoder side handles partial lines across chunk
boundaries — a half-written line at the end of one chunk is buffered until its
newline arrives. That's the only real subtlety in event streaming, and the runtime
ships it.

### Move 2.5 — current state vs. future state

Token streaming is built-but-absent; here's the honest comparison.

```
  Phase A (today) vs. Phase B (token streaming) — side by side

  ┌─ Phase A: TODAY ───────────────┐   ┌─ Phase B: TOKEN STREAMING ──────┐
  │ complete(): Promise<Response>  │   │ complete(): AsyncIterable<chunk>│
  │ await whole → parse → validate │   │ for await chunk: append to UI   │
  │ structured path: works (needs  │   │ structured path: CANNOT validate│
  │   the whole JSON)              │   │   a partial → must buffer to end │
  │ events: stream over NDJSON ✓   │   │ events: unchanged ✓             │
  └────────────────────────────────┘   └─────────────────────────────────┘

  what DOESN'T change: the trace/event stream and Studio's NDJSON transport
  what's HARD: structured generation needs the full response, so token
               streaming only helps non-structured paths (e.g. final prose)
```

The takeaway is *what doesn't have to change*: the event-streaming
infrastructure (sink, NDJSON encode, Studio transport) is independent of whether
the model streams tokens. Token streaming would change only the model seam, and
only for paths that emit free prose rather than JSON — which is why the right
first target is `QueryAgent`'s final text answer, not the rubric judge.

### Move 3 — the principle

Name your streams precisely. "Does it stream?" is two questions: does the *model*
stream tokens, and does the *app* stream progress? AptKit answers no and yes — and
that's a coherent design, not an oversight, because its highest-value model path
(structured generation) needs the whole response to validate it. The lesson:
streaming is valuable where you can *consume* partials (live prose, progress
UIs), and a liability where you can't (anything you must parse-and-validate as a
whole). Stream the thing you can use incrementally; await the thing you can't.

## Primary diagram

The full picture — blocking model calls inside a live event stream.

```
  Streaming in AptKit — the complete map

  ┌─ Provider ──────────────────────────────────────────────────────┐
  │  complete(request): Promise<ModelResponse>                       │
  │  TOKEN STREAMING: not exercised — whole response, then return    │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  await (blocks)
  ┌─ Runtime: runAgentLoop / generateStructured ─▼─────────────────────┐
  │  per step/tool/usage: trace.emit(CapabilityEvent)                  │
  │  structured path: parseAgentJson needs the WHOLE rawText           │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  emit() — incremental
  ┌─ Studio Vite middleware ───────▼──────────────────────────────────┐
  │  content-type: application/x-ndjson ; x-accel-buffering: no        │
  │  res.write(encodeNdjsonRecord({type:'event', event}))  per event   │
  │  …then res.write({type:'result', result})  at the end             │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  NDJSON lines, live
  ┌─ Browser ──────────────────────▼──────────────────────────────────┐
  │  decode line-by-line (partial-line safe), render trace as it lands │
  └─────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Studio's replay endpoints stream a run's trace to the browser so
you watch an agent's steps, tool calls, and token usage appear live. There are
five such endpoints (query, monitoring, diagnostic, rubric-improvement, and the
generic replay). The model calls *inside* each run are all blocking awaits — the
liveness comes entirely from the event stream wrapped around them.

**The model call is awaited whole**,
`packages/runtime/src/structured-generation.ts:68`: `response = await
options.model.complete({...})`. The contract itself,
`packages/runtime/src/model-provider.ts:57`, returns `Promise<ModelResponse>` —
there is no streaming signature in the type at all.

**The NDJSON encoder**, `packages/runtime/src/ndjson-stream.ts:31-38`:

```
  packages/runtime/src/ndjson-stream.ts  (lines 31-38)

  export function encodeNdjsonRecord(value: unknown): string {
    return `${JSON.stringify(value)}\n`;          ← one JSON value + newline
  }
  export function encodeCapabilityEvent(event: CapabilityEvent): string {
    return encodeNdjsonRecord(event);             ← trace event → one line
  }
       │
       └─ The runtime owns ENCODING. NDJSON = "one JSON per line," which is
          what lets the decoder split on newlines and the browser process
          events one at a time as they arrive.
```

**The Studio transport**, `apps/studio/vite.config.ts:899-917`:

```
  apps/studio/vite.config.ts  (lines 899-917)

  res.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('cache-control', 'no-cache');
  res.setHeader('x-accel-buffering', 'no');        ← don't let a proxy buffer!
  const result = await run(body, (event) => {
    res.write(encodeNdjsonRecord({ type: 'event', event }));  ← live, per event
  });
  res.write(encodeNdjsonRecord({ type: 'result', result }));  ← final record
       │
       └─ The onEvent callback IS the trace sink. Each emit during the run
          becomes a written line immediately — that's the streaming. The
          model awaits underneath stay blocking; only the events stream.
```

**The decoder handles partial lines**,
`packages/runtime/src/ndjson-stream.ts:103-135`: `decodeNdjsonStream` buffers a
half-line across chunk boundaries until its newline arrives, so a record split
across two network chunks still decodes intact — the one genuine subtlety of
consuming a stream.

## Elaborate

Token streaming is normally done with server-sent events (SSE) or a chunked
transfer where each chunk is a token delta; the UX win is the "typing" effect and
lower time-to-first-token. AptKit skips it for a principled reason already named:
its structured-output path can't consume a partial — `parseAgentJson` needs a
complete, balanced JSON document. You can't validate half a rubric judgment. So
token streaming would benefit only the *non-structured* paths that emit free
prose, primarily `QueryAgent.answer()`'s final text. That's the Project Exercise
below, and it's deliberately scoped to a non-structured path because that's the
only place the value is real and the cost is low.

Meanwhile the event stream is the more interesting engineering: it's how Studio
turns an opaque agent run into a live, debuggable timeline. NDJSON over a plain
HTTP response (no WebSocket, no SSE framing) is the minimal transport that works,
and the runtime/transport split (encode in runtime, write in Studio) keeps the
runtime UI-agnostic. The same `CapabilityEvent` records that stream live are also
what get persisted as replay artifacts and fed to the eval layer
(`../05-evals-and-observability/`) — one event format, three consumers: live UI,
persisted artifact, eval input.

Adjacent: the agent loop that emits the events
(`../04-agents-and-tool-use/03-react-pattern.md`); the structured path that
requires whole responses (`04-structured-outputs.md`); the trace events
themselves and the cost ledger that reads `model_usage`
(`06-token-economics.md`).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case B — token streaming is not exercised; this adds
it to the one path where it pays off.*

### Exercise — token-stream the query agent's final answer

- **Exercise ID:** `[C1.6]` Phase 1, streaming
- **What to build:** Add an optional streaming model path used *only* by
  `QueryAgent.answer()`'s final synthesis turn (free prose, no JSON to validate):
  a `completeStream()` that yields text deltas, plumbed through to the browser as
  `{type:'token', delta}` NDJSON records on the existing query replay endpoint.
  Leave `generateStructured` and every JSON path on the blocking `complete()`.
- **Why it earns its place:** It forces you to articulate *why* streaming is safe
  here (prose, consumed incrementally) and unsafe for structured paths (must
  validate the whole document) — the exact distinction this file teaches, made
  load-bearing by where you draw the line.
- **Files to touch:** `packages/runtime/src/model-provider.ts` (an optional
  streaming method), `packages/providers/openai/src/openai-provider.ts` (the SDK
  already supports `stream: true`), `packages/agents/query/src/query-agent.ts`,
  `apps/studio/vite.config.ts` (emit token records), Studio's query panel.
- **Done when:** Running a query replay in Studio shows the final answer arriving
  incrementally, while a rubric-judge replay still arrives whole; a test asserts
  the structured path never calls the streaming method.
- **Estimated effort:** `1–3d`

## Interview defense

**Q: Does your system stream?**
"Two different streams — I'd separate them on the whiteboard:"

```
  model → runtime:   await complete() → WHOLE response   (no token stream)
  runtime → browser: emit(event) → NDJSON line per event (live stream)
```

"Trace events stream to the Studio UI over NDJSON — steps, tool calls, token
usage appear live as the run progresses, `vite.config.ts:906`. But the model
calls themselves are blocking awaits, `model-provider.ts:57` — no token-by-token.
So: events stream, tokens don't."
*Anchor: "does it stream" is two questions — model tokens vs. app events.*

**Q: Why not stream the model's tokens too?**
"The structured path can't consume a partial. `generateStructured` runs
`parseAgentJson` plus a validator on the *complete* text — you can't validate half
a JSON document, `structured-generation.ts:85`. Token streaming would only help
the non-structured paths, like the query agent's final prose answer. So I'd stream
*that* path and leave anything I have to parse-and-validate on the blocking call."
*Anchor: stream what you can consume incrementally; await what you must parse whole.*

## Validate

- **Reconstruct:** Draw the two timelines — blocking `complete()` boxes and the
  event drip between them. Check the await at
  `packages/runtime/src/structured-generation.ts:68` and the emit at
  `apps/studio/vite.config.ts:906`.
- **Explain:** Why is `x-accel-buffering: no` set on the streaming response?
  (Tells proxies not to buffer, so each written NDJSON line reaches the browser
  live instead of all-at-end — `vite.config.ts:902`.)
- **Apply:** You want a live "typing" effect on the rubric judge's verdict. Can
  you? (No — the judge returns validated JSON via `generateStructured`, which
  needs the whole response; you'd have to buffer to the end anyway.
  `structured-generation.ts:85`.)
- **Defend:** Why does the runtime encode NDJSON while Studio writes it? (Keeps
  the runtime UI-agnostic — encoding is a runtime concern, transport is Studio's;
  `ndjson-stream.ts:36` vs `vite.config.ts:899-907`.)

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — why `complete()` returns a whole `Promise<ModelResponse>`
- [04-structured-outputs.md](04-structured-outputs.md) — the path that structurally needs the whole response
- [06-token-economics.md](06-token-economics.md) — the `model_usage` events that stream alongside the run
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the loop that emits the trace events
- [../05-evals-and-observability/](../05-evals-and-observability/) — the same events as persisted artifacts
