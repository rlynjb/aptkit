# The context window is a fixed budget

**Subtitle:** The window as a token budget · guard, don't truncate · *Industry standard, aptkit-specific guard*

## Zoom out, then zoom in

Before any token math, here's where the budget lives in aptkit. The guard is one
box wrapped around the provider — everything above it builds a request, the guard
weighs that request, and only then does the model see it.

```
  Zoom out — where the budget check sits

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  agent loop assembles system + messages + tool schemas       │
  └───────────────────────────┬─────────────────────────────────┘
                              │ ModelRequest
  ┌─ Guard layer ─────────────▼─────────────────────────────────┐
  │  ★ ContextWindowGuardedProvider ★  estimate → ok? → pass     │ ← we are here
  │  not ok → THROW ContextWindowExceededError                   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ only if it fits
  ┌─ Provider / model ────────▼─────────────────────────────────┐
  │  local Gemma — has a HARD finite input slot                  │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. The context window is the total number of tokens the model can read
in one call — system prompt, every message, every tool schema, all of it, summed.
It is not "memory" and it is not elastic. When you overflow it, a cloud model
errors and a local model silently produces garbage. aptkit's answer is unusual
and worth internalizing: it does not try to manage eviction or compress history.
It *weighs the request before sending it* and refuses to send one that won't fit.

## Structure pass

**Layers.** Capability assembles the request → guard estimates and gates →
provider runs the model. The guard is a decorator: same `ModelProvider`
interface, wrapped around the real one.

**Axis — what happens when input is too big?** Trace it. Most systems would
*truncate* (drop old messages) or *summarize* (compress history). aptkit does
neither at this layer. It *throws*. The estimate runs first
(`context-window-guard.ts:59`), and if `estimate.ok` is false the call never
reaches the model (`:60-68`). The request is rejected whole, not trimmed.

**Seam.** The load-bearing boundary is `complete()` on the guard
(`context-window-guard.ts:57`). Above it: a request that might be too big. Below
it: a request that provably fits, or no call at all. The axis "is this within
budget?" flips exactly here — above, unknown; below, guaranteed.

## How it works

### Move 1 — the mental model

You know a fixed-size buffer — a ring buffer, or a `<div style="height:400px">`
with `overflow: hidden`. There's a hard ceiling, and content past it is either
clipped or it errors. The context window is that buffer, measured in tokens. The
twist: aptkit doesn't clip silently. It's a buffer that *refuses the write* when
the write wouldn't fit — closer to a bounded queue that throws on overflow than a
scrollable div that hides what spills.

```
  The window as a token budget

  maxTokens ┌─────────────────────────────────────────────┐
            │ system prompt        ▓▓▓▓                    │
            │ messages (history)   ▓▓▓▓▓▓▓▓▓▓▓▓▓            │
            │ tool schemas         ▓▓▓                      │  ← input tokens
            ├─────────────────────────────────────────────┤
            │ outputReserve (768)  ░░░░  reserved for reply │  ← can't be used by input
            └─────────────────────────────────────────────┘
   availableInputTokens = maxTokens − outputReserve
   if estimatedInput > availableInput → THROW, never send
```

### Move 2 — the guard, step by step

**Estimating the input.** aptkit can't tokenize without the model, so it
approximates: characters divided by a fixed `charsPerToken` of 3. It sums every
part of the request — system, each message, and each tool's name + description +
JSON schema. From `context-window-guard.ts:91-98`:

```ts
export function estimateModelRequestTokens(request: ModelRequest, charsPerToken = 3): number {
  const text = [
    request.system ?? '',
    ...request.messages.map(messageText),
    ...(request.tools ?? []).map((tool) => `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
  return estimateTextTokens(text, charsPerToken);   // Math.ceil(text.length / 3)
}
```

The lesson hiding here: tool schemas count against your budget. A model with ten
verbose tool definitions burns window before the conversation even starts.

```
  estimateModelRequestTokens — what gets weighed

  ┌─ system ─┐  ┌─ messages[] ─┐  ┌─ tools[] (name+desc+schema) ─┐
  │  text    │  │  text per    │  │  JSON.stringify(inputSchema) │
  └────┬─────┘  └──────┬───────┘  └──────────────┬───────────────┘
       └───────────────┴──── join('\n') ─────────┘
                            │
                   length / 3, ceil
                            ▼
                   estimatedInputTokens
```

**Computing the budget and gating.** The available slot is `maxTokens` minus a
reserve set aside for the model's own reply (default 768). If the estimate
exceeds that, `ok` is false. From `context-window-guard.ts:80-88`:

```ts
const estimatedInputTokens = estimateModelRequestTokens(request, charsPerToken);
const availableInputTokens = Math.max(0, maxTokens - outputReserve);   // reserve room for the reply
return { /* ... */ ok: estimatedInputTokens <= availableInputTokens };
```

```
  The gate

   estimatedInput ──► [ <= availableInput ? ] ──► yes ──► provider.complete()
                              │
                              └──── no ──► emit warning ──► throw
```

**Refusing, not truncating.** This is the whole point. When it doesn't fit, the
guard emits a trace warning and throws — it does not drop messages to make room.
From `context-window-guard.ts:60-68`:

```ts
if (!estimate.ok) {
  this.options.trace?.emit({ type: 'warning', /* ...skipping local provider... */ });
  throw new ContextWindowExceededError(estimate);   // refuse — let the caller decide
}
return this.provider.complete(request);
```

Why refuse? Because the guard wraps the *local* provider, and aptkit has a
fallback chain. A throw here is a signal: "this won't fit on Gemma — try the next
provider." Truncating would silently corrupt the request; throwing keeps the
decision honest and routes around the limit instead of through it.

**The other half — bounding growth in the loop.** The guard checks one request.
But a multi-turn agent loop *grows* the message list every turn, and a single
huge tool result could blow the window in one shot. So the loop caps every tool
result before appending it. From `run-agent-loop.ts:52-57`:

```ts
const MAX_TOOL_RESULT_CHARS = 16_000;
function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}
```

That truncated string is what gets pushed back as a `tool_result` message
(`run-agent-loop.ts:162,167,189`). So there are two distinct moves: the *loop*
truncates tool results (to bound growth), and the *guard* refuses the whole
request (to enforce the ceiling). Different layers, different jobs.

```
  Two layers, two strategies

  run-agent-loop          truncate tool result to 16k chars   (bound growth)
        │ appends bounded messages
        ▼
  ContextWindowGuard      estimate whole request, refuse if over  (enforce ceiling)
```

### Move 3 — the principle

Treat the window as a hard budget you measure *before* spending, not a buffer you
overflow and clean up after. aptkit splits the work: bound per-item growth where
the data enters (the loop's 16k truncation), and gate the total at the boundary
to the model (the guard's throw). Refusing beats silently truncating, because a
refusal can be routed — to another provider, a smaller prompt, fewer tools — while
a silent truncation just degrades the answer with no signal.

## Primary diagram

```
  The full context-budget story in aptkit

  agent loop                          guard                        local model
  ┌──────────────┐  ModelRequest      ┌──────────────────┐         ┌──────────┐
  │ system       │ ─────────────────► │ estimate tokens  │         │ Gemma    │
  │ messages[]   │  (each tool result │  (chars / 3)     │         │ finite   │
  │ tools[]      │   capped at 16k)   │                  │  fits   │ input    │
  │              │                    │ <= maxTokens     │ ──────► │ slot     │
  │              │                    │   − reserve(768)?│         │          │
  └──────────────┘                    └────────┬─────────┘         └──────────┘
                                               │ over budget
                                               ▼
                                  throw ContextWindowExceededError
                                  → fallback chain picks another provider
   above: assemble & bound growth   │   at the seam: measure & gate   │   below: run
```

## Elaborate

aptkit's guard is deliberately *not* a context-management system. There's no
sliding window, no summarization, no eviction policy — and that's a design stance,
not a gap. The reasoning: a local model swap is cheap (the fallback chain exists),
so when a prompt won't fit, the right move is to route to a model that *can* hold
it, not to mutilate the prompt. The `charsPerToken: 3` estimate is intentionally
conservative — it over-counts slightly so a borderline request errs toward "too
big" rather than overflowing at runtime. The cost is false rejections on
prose-heavy requests; the benefit is never silently corrupting a request. If you
wanted true context management (summarize-old-turns, drop-least-relevant), it
would live as another `ModelProvider` decorator beside this one — `not yet
exercised` in the repo. Read `02-lost-in-the-middle.md` next: even when content
*fits* the window, where it sits inside the window changes whether the model uses
it.

## Project exercises

### Add a "near-budget" warning band to the guard

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend `estimateContextWindow` to return a `nearLimit`
  boolean (e.g. estimated input > 90% of available) and have
  `ContextWindowGuardedProvider.complete` emit a `warning` trace when `nearLimit`
  is true but the request still fits — so you see the cliff before you fall off it.
- **Why it earns its place:** proves you understand the budget is a gradient, not
  a binary, and that observability belongs at the boundary where the decision is
  made.
- **Files to touch:** `packages/providers/local/src/context-window-guard.ts`, and
  a test under `packages/providers/local/test/` constructing requests at 50% and
  95% of budget.
- **Done when:** `node --test` shows a near-limit request passes AND emits exactly
  one warning, while an in-budget request emits none.
- **Estimated effort:** `<1hr`

### Make tool-result truncation budget-aware instead of fixed

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** thread a `maxToolResultChars` option through
  `RunAgentLoopOptions` so a caller can shrink the 16k cap when running against a
  small-window model, defaulting to the current constant.
- **Why it earns its place:** the fixed 16k is a magic number that assumes a
  generous window; making it a knob shows you see how per-item bounding and the
  total budget are coupled.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`, plus a test in
  `packages/runtime/test/` asserting a small cap truncates a large result.
- **Done when:** a test passing `maxToolResultChars: 200` produces a `tool_result`
  ending in `...[truncated]`, and the default is unchanged.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Your prompt is too long for the model. What does aptkit do?"**
It refuses, it does not trim. The `ContextWindowGuardedProvider` estimates the
request's tokens (chars / 3) before sending, and if input would exceed
`maxTokens − outputReserve` it throws `ContextWindowExceededError`. The throw is a
routing signal for the fallback chain, not a dead end.

```
  too big ──► guard estimates ──► over budget ──► THROW
                                                   │
                                       fallback chain ──► next provider
   (never silently drops messages)
```
Anchor: *the guard gates `complete()` at `context-window-guard.ts:60` — refuse, then route.*

**Q: "A loop runs many turns. What stops the window from growing unbounded?"**
Two separate mechanisms. The agent loop truncates every tool result to 16k chars
before appending it (`run-agent-loop.ts:54`), so no single tool call can blow the
window. And the guard re-checks the *whole* assembled request on every turn, so
even accumulated growth gets gated. Per-item bounding plus total gating.

```
  per turn:  tool result ──► truncate 16k ──► append to messages[]
  every call: whole request ──► guard estimate ──► gate
```
Anchor: *the loop bounds per-item (`MAX_TOOL_RESULT_CHARS`); the guard enforces the ceiling.*

## See also

- `02-lost-in-the-middle.md` — fitting the window isn't enough; position matters
- `03-prompt-chaining.md` — splitting one big prompt into cheaper per-step contexts
- `../01-llm-foundations/02-tokenization.md` — where `charsPerToken` comes from
- `../01-llm-foundations/08-provider-abstraction.md` — the fallback chain the throw routes into
