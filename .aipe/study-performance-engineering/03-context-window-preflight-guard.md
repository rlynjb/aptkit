# Context-Window Pre-Flight Guard

*Industry names: fail-fast guard, admission control, pre-flight check,
context-budget check. Type: Industry standard (request admission).*

## Zoom out, then zoom in

A model call that won't fit the context window costs you the full
round-trip latency only to fail or get silently truncated. This guard
sits in front of one provider and answers a cheaper question first: "will
this even fit?" — before you pay for the trip.

```
  Zoom out — where the guard sits

  ┌─ Agent / fallback layer ───────────────────────────┐
  │  FallbackModelProvider tries providers in order     │
  └──────────────────────────┬──────────────────────────┘
                            │  complete(request)
  ┌─ Provider-decorator layer ▼─────────────────────────┐
  │  ★ ContextWindowGuardedProvider ★                   │ ← we are here
  │  estimate input tokens → fits? → pass : throw       │
  └──────────────────────────┬──────────────────────────┘
                            │  only if it fits
  ┌─ Wrapped provider (local) ▼─────────────────────────┐
  │  the actual model.complete() — the expensive hop    │
  └──────────────────────────────────────────────────────┘
```

Zoom in: it's a decorator around a `ModelProvider`. Before delegating to
the real `complete()`, it estimates the prompt's token count and, if that
exceeds the available budget, throws instead of calling. The estimate is
deliberately crude — that's the interesting tradeoff.

## The structure pass

**Layers:** fallback chain (picks providers) → guard decorator (admits or
rejects) → wrapped provider (does the work).

**Axis — failure containment:** where does an over-budget request fail,
and how expensive is that failure? Trace it.

```
  One axis — "where does an oversize prompt fail, and what does failing cost?"

  ┌─ Without guard ─────────────────────────┐
  │ send → provider truncates/rejects        │ → fails AFTER the round-trip
  │                                          │   (latency paid, maybe billed)
  └──────────────────────────────────────────┘

  ┌─ With guard ────────────────────────────┐
  │ estimate locally → throw                 │ → fails BEFORE the trip
  │   (microseconds, no network)             │   (fallback moves on instantly)
  └──────────────────────────────────────────┘
```

**The seam that matters:** the `estimate.ok` decision inside `complete()`.
On one side the request becomes a real network call; on the other it
becomes a thrown `ContextWindowExceededError` the fallback chain catches.
That single boolean flips the failure from "expensive and remote" to
"cheap and local."

## How it works

You know how a form validates a field on the client before submitting,
so an obviously-bad value never costs a server round-trip? Same move,
same tradeoff: the client-side check is fast but approximate (it can't
know everything the server knows), yet it catches the obvious failures
cheaply. The guard is client-side validation for a model request, and its
"approximate" part is the token estimate.

### Move 1 — the mental model: estimate, compare, gate

```
  The kernel — pre-flight gate

  request ──► estimate input tokens (length / charsPerToken)
                       │
                       ▼
              available = maxTokens - outputReserve
                       │
            estimate <= available ?
              │ yes                  │ no
              ▼                      ▼
        delegate to provider    throw ContextWindowExceededError
        (pay for the trip)      (no trip; fallback moves on)
```

### Move 2 — the step-by-step walkthrough

**The token estimate (the approximate part).** The guard sums the text of
the system prompt, every message, and every tool schema, then divides the
character count by `charsPerToken` (default 3) and rounds up. Bridge from
what you know: it's the same as estimating a payload size by string length
before you bother serializing it — fast, and good enough to catch the
obvious cases. The load-bearing caveat: real tokenization is BPE, not
characters/3, so this can be off in either direction. It's a guard rail,
not a meter. If it under-estimates, a slightly-too-big prompt slips
through; if it over-estimates, a prompt that would have fit gets rejected.
Acceptable for a coarse local gate; wrong if you treat it as exact.

```
  Token estimate — what gets counted

  text = system + all message text + (tool.name + desc + JSON(schema)) for each tool
  estimatedInputTokens = ceil(text.length / 3)
                                          └─ the heuristic; real BPE varies by content
```

**The available budget (reserve the output).** Available input isn't the
whole window — it's `maxTokens - outputReserve` (default reserve 768). You
subtract room for the model's *answer* before deciding if the *input*
fits. Drop the reserve and a prompt that exactly fills the window leaves
no room to respond — the call would fit going in and fail coming out. The
reserve is what makes "fits" mean "fits *and* can answer."

```
  Budget math

  window:    [████████████████████████████████]  maxTokens
  reserve:                              [██████]  outputReserve (768) — for the answer
  available: [██████████████████████████]          maxTokens - outputReserve
             ↑ the prompt must fit in HERE, not the whole window
```

**The gate (throw, don't call).** If `estimatedInputTokens >
availableInputTokens`, the guard emits a `warning` trace event and throws
`ContextWindowExceededError` carrying the estimate. It never calls the
wrapped provider. Bridge: it's an early `return`/`throw` guard clause —
the cheap rejection at the top of a function that stops the expensive body
from running. Because it throws rather than returns a sentinel, the
fallback chain treats it like any provider failure and moves to the next
candidate automatically.

```
  The gate — fail fast, hand off

  if (!estimate.ok):
     trace.emit(warning: "skipping local provider, est X > avail Y")
     throw ContextWindowExceededError(estimate)   ─────► FallbackProvider catches,
                                                          tries next provider
  else:
     return provider.complete(request)            ─────► the real (expensive) hop
```

### Move 3 — the principle

**Reject the doomed request before you pay its latency — even with an
imperfect check.** The value isn't precision; it's that the check is
*cheap* (local, microseconds) relative to what it prevents (a full
round-trip that fails). The general lesson: admission control trades a
fast approximate test for avoiding a slow definite cost — and a crude
estimate that's right most of the time beats no estimate at all, as long
as you don't mistake it for exact.

## Primary diagram

The full guard, from estimate to gate to handoff.

```
  Context-window pre-flight guard — full recap

  ┌─ Fallback layer ──────────────────────────────────────────┐
  │ FallbackModelProvider: try providers in order, on throw   │
  │ move to next                                              │
  └───────────────────────────────┬────────────────────────────┘
                                  │ complete(request)
  ┌─ Guard decorator ─────────────▼────────────────────────────┐
  │ estimateModelRequestTokens(request, charsPerToken=3)       │
  │   text = system + messages + tool schemas                  │
  │   est  = ceil(text.length / 3)         ◄── crude heuristic  │
  │ available = maxTokens - outputReserve(768)                 │
  │                                                            │
  │ est <= available ?                                         │
  │   ── yes ──► provider.complete(request)  ──► real model hop │
  │   ── no  ──► emit warning; throw ContextWindowExceededError │
  │                                  └──► fallback tries next  │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Wraps the *local* provider in the fallback chain. The
local model has the smallest context window, so it's the one most likely
to be handed a prompt it can't hold — the guard lets the chain skip it
instantly and fall through to a cloud provider with a bigger window,
instead of wasting a local round-trip on a doomed call.

**Code — the gate, `packages/providers/local/src/context-window-guard.ts:57-71`:**

```
async complete(request: ModelRequest): Promise<ModelResponse> {
  request.signal?.throwIfAborted();
  const estimate = estimateContextWindow(request, this.options);
  if (!estimate.ok) {                                     ← the gate
    this.options.trace?.emit({
      type: 'warning',
      capabilityId: this.options.capabilityId,
      message: `Skipping local provider ${this.provider.id}: estimated `
        + `${estimate.estimatedInputTokens} input tokens exceed `
        + `${estimate.availableInputTokens}.`,                ← observable why
      timestamp: timestamp(),
    });
    throw new ContextWindowExceededError(estimate);       ← fail BEFORE the hop
  }
  return this.provider.complete(request);                 ← only reached if it fits
}
```

**Code — the budget math, `context-window-guard.ts:73-89`:**

```
const maxTokens = options.maxTokens;
const outputReserve = options.outputReserve ?? 768;       ← reserve room for the answer
const charsPerToken = options.charsPerToken ?? 3;         ← the heuristic divisor
const estimatedInputTokens = estimateModelRequestTokens(request, charsPerToken);
const availableInputTokens = Math.max(0, maxTokens - outputReserve);
return {
  estimatedInputTokens, maxTokens, outputReserve, availableInputTokens,
  ok: estimatedInputTokens <= availableInputTokens,        ← the boolean the gate reads
};
```

**Code — the crude estimate, `context-window-guard.ts:91-103`:**

```
export function estimateModelRequestTokens(request: ModelRequest, charsPerToken = 3): number {
  const text = [
    request.system ?? '',
    ...request.messages.map(messageText),                  ← all message text
    ...(request.tools ?? []).map((tool) =>                 ← tool schemas count too
      `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
  return estimateTextTokens(text, charsPerToken);
}

export function estimateTextTokens(text: string, charsPerToken = 3): number {
  if (charsPerToken <= 0) throw new Error('charsPerToken must be greater than 0');
  return Math.ceil(text.length / charsPerToken);          ← length/3 — known imprecision
       │
       └─ real BPE tokenization varies by content; this can over- or under-shoot.
          The move when the margin is tight: call the provider's token-count endpoint.
}
```

## Elaborate

This is admission control specialized for context windows — the same idea
as a load balancer rejecting a request before it reaches an overloaded
backend, scaled down to one provider. The honest tradeoff is the
length/3 estimate: it's chosen for speed and zero dependencies, accepting
that it's approximate. That's the right call for a *guard* whose job is to
catch the obvious over-budget cases cheaply; it would be the wrong call
for a precise token *budgeter*. It pairs with the cost ledger
(**02-token-cost-ledger.md**), which uses the same kind of estimate when a
provider doesn't report real tokens, and with the fallback chain (a
partial-failure concern owned by **study-distributed-systems**) — the
guard's `throw` is what makes the chain skip the local provider
gracefully. For the provider-hop latency framing, see
**study-distributed-systems**.

## Interview defense

**Q: How do you avoid paying for a model call you know will overflow the
context window?**

A pre-flight guard: estimate the prompt's token count from its character
length, subtract a reserve for the output, and if the estimate exceeds the
budget, throw before calling. The throw makes the fallback chain skip that
provider for free.

```
  est = ceil(text.length / 3)
  est > maxTokens - outputReserve ? throw : call
```

Anchor: `context-window-guard.ts:57-71`.

**Q: length/3 isn't real tokenization. Why is that acceptable?**

Because it's a guard, not a meter. Its job is catching the obvious
oversize cases cheaply and locally; being approximate is fine as long as
nobody treats it as exact. If a borderline prompt needs a precise call, I
swap in the provider's token-count endpoint behind the same interface.

Anchor: `context-window-guard.ts:100-103`.

## Validate

1. **Reconstruct:** write the gate from memory — estimate, available
   budget (with reserve), the `ok` comparison, throw-vs-delegate. Check
   `context-window-guard.ts:57-89`.
2. **Explain:** why subtract `outputReserve` before comparing? (A prompt
   that fills the whole window leaves no room for the answer.)
3. **Apply:** `maxTokens = 8192`, `outputReserve = 768`, a prompt of
   24,000 characters. Does the guard pass or throw, and is that decision
   trustworthy? (est = ceil(24000/3) = 8000 > 7424 → throws; trustworthy
   as a coarse call, but the 8000 is a heuristic.)
4. **Defend:** a teammate wants to raise `charsPerToken` to 4 to "let more
   prompts through." What does that trade? (Fewer rejections but more
   doomed calls slip through and fail remotely — it loosens the guard.)

## See also

- **02-token-cost-ledger.md** — the same length-based estimate for cost.
- **01-turn-and-tool-budget.md** — bounding turn *count* vs turn *size*.
- **audit.md** — lens 5 (I/O bottlenecks) and red flag #3 (the heuristic).
- **study-distributed-systems** — the fallback chain and provider-hop latency.
