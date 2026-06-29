# Streaming — output that arrives in pieces

**Subtitle:** token streaming (the pattern) vs trace streaming (what aptkit does) · *Industry standard*

## Zoom out, then zoom in

Before you wire up a typing-cursor UI, see what aptkit actually streams: not model
tokens, but trace *events* describing what the agent is doing.

```
  Zoom out — what flows out of aptkit incrementally

  ┌─ Studio / client ───────────────────────────────────────────┐
  │  reads an NDJSON stream, one JSON object per line            │
  └───────────────────────────▲─────────────────────────────────┘
                              │ NDJSON (trace events)
  ┌─ Runtime ─────────────────┴─────────────────────────────────┐
  │  ★ emits CapabilityEvents ★ step / tool_call / model_usage  │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ complete() — awaited whole, stream:false
  ┌─ The model (Gemma) ───────▼─────────────────────────────────┐
  │  returns the FULL response at once (no token stream yet)    │
  └──────────────────────────────────────────────────────────────┘
```

There are two different things people call "streaming." Token streaming is the
model emitting its answer one token at a time so a UI can render it as it's
written — the ChatGPT typing cursor. Trace streaming is the *runtime* emitting
structured events ("started step", "calling tool", "used 312 tokens") as the
agent works. aptkit does the second and not yet the first. This file teaches token
streaming as the industry pattern, then shows you exactly where aptkit diverges
and why.

## Structure pass

**Layers.** Model (produces output) → provider adapter (awaits it whole) → runtime
(emits trace events) → NDJSON encoder → client (decodes line by line).

**Axis — granularity over time.** Trace how fine-grained the incremental data is.
The *ideal* token stream is per-token. aptkit's model call is all-or-nothing
(`stream: false`). But the *runtime* is incremental at the event level — you see
each step and tool call as it happens. So aptkit streams coarse (events) where the
ideal streams fine (tokens).

**Seam.** The flip is the provider adapter. Below it, today, a single awaited
response (no streaming). Above it, an incremental event stream. The adapter is
exactly where token streaming *would* be plumbed in later — and the seam already
exists.

## How it works

### Move 1 — the mental model

You know the difference between `const r = await fetch(url); await r.json()` and
reading `r.body.getReader()` chunk by chunk? The first waits for everything; the
second processes pieces as they land. Token streaming is the reader pattern
applied to the model's output.

```
  await-the-whole vs read-the-chunks

  await complete()        ┌───────────────────────────┐
   ───────────────────►   │ ...wait... full response  │   (aptkit today)
                          └───────────────────────────┘
  read chunks             ┌──┐┌──┐┌──┐┌──┐┌──┐
   ──────────────────►    │To││ke││ns││ as││…  │  ──► render live (the pattern)
                          └──┘└──┘└──┘└──┘└──┘
```

### Move 2 — the pattern: token streaming

In the industry pattern, the provider opens a streaming connection and yields
deltas; the runtime appends them to a buffer and pushes each delta to the client,
so a UI renders text as it's generated. The shape is an async iterator of
token-deltas. This is what you'd reach for to build a live "typing" answer.

```
  Token streaming (the pattern aptkit doesn't use yet)

  model ──► delta ──► delta ──► delta ──► [done]
                │        │        │
                ▼        ▼        ▼
            append to UI buffer, render each delta
```

### Move 2.5 — what aptkit actually does (current vs future)

**The model call is non-streaming, on purpose.** Gemma's adapter calls Ollama with
`stream: false` and awaits the entire response. The transport type bakes it in —
`packages/providers/gemma/src/gemma-provider.ts:22`:

```ts
export type GemmaChatTransport = (payload: {
  model: string;
  messages: { role: string; content: string }[];
  stream: false;          // ← literally typed false; no token streaming today
  options?: Record<string, unknown>;
  signal?: AbortSignal;
}) => Promise<OllamaChatResponse>;
```

```
  Gemma today:  POST /api/chat { stream:false } ──► await full reply
  token-level streaming from the model = not yet exercised
```

**What aptkit streams instead: NDJSON trace events.** The runtime emits a
discriminated union of `CapabilityEvent`s — and there's a real NDJSON codec for
them. The event union, `packages/runtime/src/events.ts:1`:

```ts
export type CapabilityEvent =
  | { type: 'step'; … }
  | { type: 'tool_call_start'; … }
  | { type: 'tool_call_end'; durationMs: number; … }
  | { type: 'model_usage'; provider: string; model: string; inputTokens?: number; … }
  | { type: 'warning'; … }
  | { type: 'error'; … };
```

And the streaming decoder that preserves partial lines across chunk boundaries —
`packages/runtime/src/ndjson-stream.ts:103`:

```ts
export async function* decodeNdjsonStream<T>(chunks: AsyncIterable<string | Uint8Array>, …) {
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    // split on \n, yield each COMPLETE line, keep the partial in buffer  ← chunk-boundary safe
  }
}
```

```
  aptkit streaming (real, today)

  runtime ─► {type:"step"}\n ─► {type:"tool_call_start"}\n ─► {type:"model_usage"}\n
                │                      │                            │
                ▼                      ▼                            ▼
         decodeNdjsonStream reassembles whole lines ─► Studio renders the trace
```

Studio's Vite middleware streams these NDJSON replay traces to the panel (apps/
studio). So the live thing you watch is the *agent's reasoning trace*, not the
model's text being typed out.

### Move 3 — the principle

Stream the unit your consumer needs, not the unit the model happens to produce.
For a chat UI, that's tokens. For an *observability* surface — which is what
aptkit's Studio is — it's structured events. aptkit picked event streaming because
its goal is to make agent behavior legible and replayable; token streaming is a
later, additive feature that drops into the existing provider seam.

## Primary diagram

```
  Two streams, one of them real today

  PATTERN (not yet):  model ─tokens→ adapter ─deltas→ runtime ─deltas→ UI types live
                                     ▲
                                     │ stream:false today (Gemma)
  REAL (today):       runtime ─CapabilityEvent→ NDJSON line → decodeNdjsonStream → Studio
                       step / tool_call_start / tool_call_end / model_usage / warning / error
   what arrives in pieces = TRACE EVENTS, not model tokens
```

## Elaborate

Token streaming over HTTP is usually Server-Sent Events or chunked transfer with
an async iterator of deltas; Ollama itself supports `stream: true`, so aptkit
could enable it at the adapter without touching agents. The reason it hasn't:
fixture replay and deterministic tests are simpler with whole responses, and the
product value so far is the trace, not the typing effect. Be honest about this in
interviews — "we stream traces, token streaming is a planned drop-in at the
provider seam." Read `01-what-an-llm-is.md` for the `complete()` contract that
would grow a streaming sibling, and `06-token-economics.md` for the `model_usage`
event that already rides the trace stream.

## Project exercises

### Add a streaming transport to the Gemma adapter
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a second Gemma transport that calls Ollama with `stream:true`,
  yields token deltas as an async iterator, and a thin `completeStream()` that
  re-emits them — keeping the existing `complete()` intact.
- **Why it earns its place:** proves token streaming is an additive change at the
  provider seam, not an agent rewrite — the whole point of the abstraction.
- **Files to touch:** `packages/providers/gemma/src/gemma-provider.ts`,
  `packages/providers/gemma/test/gemma-provider.test.ts`.
- **Done when:** a test drives the streaming transport and collects deltas into the
  same text the non-streaming path produces.
- **Estimated effort:** `1–2 days`

### Replay an NDJSON trace through the chunk-boundary decoder
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a test that feeds a CapabilityEvent NDJSON payload to
  `decodeNdjsonStream` in deliberately ugly chunk splits (mid-line, mid-`\r\n`) and
  asserts every event decodes intact.
- **Why it earns its place:** the partial-line buffering is the hard part of any
  stream decoder; this is the bug class real streaming work lives in.
- **Files to touch:** `packages/runtime/test/ndjson-stream.test.ts`.
- **Done when:** events decode correctly regardless of chunk boundaries.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Does aptkit stream the model's tokens?"**
No — the Gemma adapter calls Ollama with `stream:false` and awaits the full reply.
What aptkit streams is NDJSON *trace events* (step, tool_call, model_usage) so
Studio can show what the agent did. Token streaming is a planned drop-in at the
provider seam.

```
  expected: model ─tokens→ UI
  actual:   runtime ─CapabilityEvents (NDJSON)→ Studio   (stream:false to the model)
```
Anchor: *aptkit streams traces, not tokens — by design, for observability.*

**Q: "How would you add token streaming without breaking agents?"**
Add a streaming transport/method beside `complete()` at the provider layer;
agents that don't opt in keep awaiting whole responses. The seam already isolates
the model, so nothing above it needs to know.

```
  complete()        ──► whole response   (unchanged callers)
  completeStream()  ──► async iterator of deltas   (new, opt-in)
       both behind the SAME ModelProvider seam
```
Anchor: *streaming is additive at the provider seam, not an agent rewrite.*

## See also

- `01-what-an-llm-is.md` — the `complete()` contract a stream method would join
- `06-token-economics.md` — `model_usage`, an event that already rides the stream
- `08-provider-abstraction.md` — the seam where streaming would plug in
