# Streaming

Streaming responses · token streaming (Industry standard)

Streaming, as the industry means it, is tokens appearing one at a time — the ChatGPT typewriter effect. aptkit does **not** do that for LLM output. Be blunt about it: aptkit's NDJSON stream carries trace *events* (the agent's steps), not model tokens. Studio shows "ran coverage gate → called tool → validated JSON," not characters materializing. That's correct for what aptkit builds, and it's a real gap for chat surfaces. LLM token streaming is **not yet exercised**.

## Zoom out, then zoom in

The thing aptkit streams lives above the model, in the trace layer — not inside `complete()`.

```
aptkit — what actually streams
┌─────────────────────────────────────────────┐
│ Studio UI — renders a live step list          │
├─────────────────────────────────────────────┤
│ ★ NDJSON stream of CapabilityEvent records     │  ← you are here (EVENTS)
├─────────────────────────────────────────────┤
│ Agent loop — emits an event per step           │
├─────────────────────────────────────────────┤
│ ModelProvider.complete() → full response       │  ← blocks until done, no token stream
│ (no completeStream method exists)               │
└─────────────────────────────────────────────┘
```

The pattern is "stream the orchestration, not the generation." The question people *think* this answers is "how do I show text as it generates?" — but aptkit answers a different one: "how do I show the agent's progress live?" Like a CI pipeline UI streaming "step 1 ✓, step 2 running" versus a terminal printing a command's stdout char by char. Different streams, different granularity.

## Structure pass

Two streams could exist; only one does. Trace the **state** axis — what's mid-flight when the stream emits.

```
STATE axis — what's in flight per emit?
Stream                     emits                       exists in aptkit?
──────────────────────────────────────────────────────────────────────
Trace events (NDJSON)      one CapabilityEvent/step    YES ←★
Token stream (chat)        one token/delta             NO (gap)
complete()                 whole ModelResponse at once  YES (blocking)
```

The seam is `complete()`. It's blocking — it returns the *entire* response when the model is done, no intermediate tokens. So the trace stream emits at step boundaries (between `complete()` calls), never inside one. There is no `completeStream` method on the provider; the token-granularity stream simply isn't wired.

## How it works

**Mental model.** Two stream granularities. aptkit streams the coarse one (events between model calls); the industry's "streaming" means the fine one (tokens inside a model call). Hold both in your head and the gap is obvious.

```
Two granularities of "streaming"
  EVENT stream (aptkit has this)
    ──[gate ran]──[tool called]──[json validated]──[done]──▶  (per agent step)

  TOKEN stream (aptkit does NOT have this)
    ──T──h──e── ──s──k──y── ──i──s── ──b──l──u──e──▶          (per token, inside one call)
    └ would need completeStream() on ModelProvider; complete() blocks instead
```

**What the NDJSON layer actually moves.** It serializes trace records, one JSON object per line.

```ts
// packages/runtime/src/ndjson-stream.ts:31-33  (encodeNdjsonRecord)
export function encodeNdjsonRecord(value: unknown): string {
  return JSON.stringify(value) + '\n';   // one CapabilityEvent per line
}
```

NDJSON (newline-delimited JSON) is "one parseable object per line" — perfect for a stream because a reader can `split('\n')` and `JSON.parse` each line as it arrives. But the `value` here is a `CapabilityEvent` — a trace record like `{type:'tool_use', name, ...}` — not a token delta. The transport is stream-shaped; the payload is event-shaped.

**Why complete() can't stream tokens.** Look back at the contract: it returns `Promise<ModelResponse>` (see `01-what-an-llm-is.md`). A `Promise` resolves once, with the whole value. There's no `AsyncIterable`, no callback per delta — so token streaming is architecturally absent, not just unimplemented.

```
  current:  complete(req): Promise<ModelResponse>   ← resolves ONCE, full text
  needed:   completeStream(req): AsyncIterable<Delta> ← yields per token (gap)
```

**Why it's fine here.** aptkit's surfaces are analytics and RAG — structured-output capabilities (see `04-structured-outputs.md`), not free-form chat. You can't usefully stream a half-built JSON object to a validator; you need the whole thing to parse it. And the user-facing value is "watch the agent work," which the event stream nails. Token streaming earns its keep on chat UIs where perceived latency matters; aptkit doesn't have one yet.

**The principle.** Stream at the granularity your UI consumes. If the user waits on a *result* (parsed JSON), stream progress events. If the user reads *prose as it generates*, stream tokens. Picking the wrong granularity means either a frozen UI or a stream nobody can use.

## Primary diagram

What aptkit streams today versus the token stream it lacks — the whole comparison in one frame.

```
aptkit streaming, today vs the gap
  AGENT LOOP                                    STUDIO UI
  ──────────                                    ─────────
  step: gate    ──┐
  step: tool    ──┼─ encodeNdjsonRecord ──▶  NDJSON ──▶ live step list ✓
  step: validate──┘   (one event / line)               (EVENT granularity)

  complete(req) ──────────────────────────▶  Promise<ModelResponse>
       │                                       resolves ONCE, full text
       └─ no per-token emit  ✗  ── completeStream() NOT YET EXERCISED ──┘
                                              (TOKEN granularity = gap)
```

Top path ships and powers Studio. Bottom path is the unbuilt chat-streaming surface.

## Elaborate

Real token streaming rides Server-Sent Events (SSE) or chunked HTTP: the vendor sends `data: {delta}` lines, the SDK exposes an async iterator, you append deltas to a buffer. Both Anthropic and OpenAI support it natively (`stream: true`). NDJSON is the right transport choice for the event stream — it's the same family as SSE, just self-framed. The thing that makes token streaming *hard* in aptkit isn't transport, it's that structured output needs the complete text to validate, so a streaming chat surface would be a parallel path, not a retrofit of `generateStructured`. Read `04-structured-outputs.md` for why whole-response is load-bearing, and `01-what-an-llm-is.md` for the `Promise`-returns-once contract.

## Project exercises

### Add completeStream to the provider port

- **Exercise ID:** `EX-LLM-05a`
- **What to build:** This is unbuilt (Case B) — build it. Add an optional `completeStream(request): AsyncIterable<ModelDelta>` to the `ModelProvider` type, implement it for the Anthropic and OpenAI adapters using their native `stream: true` APIs, and feed deltas into the existing NDJSON encoder so a chat-style surface can render tokens live. Leave Gemma without it (provider declares it doesn't support streaming).
- **Why it earns its place:** This is the headline gap in Phase 1 — you'll learn the `Promise` vs `AsyncIterable` split, how SSE/chunked deltas accumulate into a final response, and why a streaming path can't reuse the validate-the-whole-thing structured loop.
- **Files to touch:** `packages/runtime/src/model-provider.ts` (54-58 the port type); `packages/providers/anthropic/src/anthropic-provider.ts` (28-61); `packages/providers/openai/src/openai-provider.ts`; `packages/runtime/src/ndjson-stream.ts` (31-33) to emit token records.
- **Done when:** an Anthropic call yields incremental deltas through the NDJSON stream, the accumulated deltas equal the non-streaming `complete()` result, and providers without support fall back to a single full-response emit.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: aptkit streams — does the UI show text generating token by token?**

```
  Studio shows:  [gate ✓]──[tool ✓]──[validated ✓]   ← EVENTS (per step)
  NOT:           T-h-e- -s-k-y- -i-s...               ← TOKENS (per delta)
                 └ no completeStream(); complete() blocks
```

No. It streams `CapabilityEvent` trace records (the agent's steps) over NDJSON, not model tokens. Anchor: *aptkit streams progress, not prose.*

**Q: Why no token streaming if the vendors support it?**

```
  complete(): Promise<ModelResponse>   resolves once → full text
  generateStructured needs FULL text to JSON.parse + validate
  → streaming a half-built object is useless to a validator
```

Because aptkit's surfaces are structured-output analytics, and you can't validate a partial JSON object — you need the whole response. A chat surface would be a separate path, not yet built. Anchor: *you can't validate half a JSON object.*

## See also

- [`04-structured-outputs.md`](./04-structured-outputs.md) — why whole-response is required.
- [`01-what-an-llm-is.md`](./01-what-an-llm-is.md) — `complete()` returns a `Promise` once.
- [`06-token-economics.md`](./06-token-economics.md) — usage is tallied from events, not a token stream.
