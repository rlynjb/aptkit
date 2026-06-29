# Context window

> The finite container (Industry standard)

The context window is a fixed-size box. System prompt, conversation history, retrieved documents, tool schemas, *and* the room reserved for the model's reply all share it. Add anything and something else has to give. Most failures here are silent — the model quietly truncates, or you blow the limit and get a cryptic provider error mid-generation. aptkit refuses to be silent: the context-window guard (`ContextWindowGuardedProvider`) estimates the input size *before* the call and throws a typed `ContextWindowExceededError` if it won't fit. It fails loud. It does not summarize or truncate — and that's the honest boundary.

## Zoom out, then zoom in

The window is one container with competing tenants. The guard sits as a decorator *in front of* the real provider: it measures everything that's about to be sent, subtracts a reserve for the output, and either delegates or throws.

```
The finite container + the guard in front of it (LAYERS)

  ┌─────────────────────── context window (maxTokens) ───────────────────────┐
  │ system prompt │ messages (history) │ tool schemas │  RESERVED for output  │
  │   competes    │      competes      │   competes   │   (outputReserve=768) │
  └───────────────────────────────────────────────────────────────────────────┘
        ▲
        │ measured by
  ┌─────┴───────────────────────────────────────────────┐
  │ ★ ContextWindowGuardedProvider (decorator)            │
  │   estimate input tokens → fits? delegate : THROW      │
  │   availableInput = maxTokens − outputReserve          │
  └───────────────────────────────────────────────────────┘
```

Everything left of the reserve competes for the same finite space; the guard is the bouncer that checks the total before anyone gets in.

## Structure pass

One axis: **the order of operations on every request — measure, decide, act**.

- **Measure** — `estimateModelRequestTokens` concatenates the system prompt, every message, and every tool schema into one string and divides by a char-per-token ratio. Char-count estimation, not a real tokenizer.
- **Decide** — `availableInputTokens = maxTokens − outputReserve` (default reserve 768). If the estimate exceeds that, the request doesn't fit.
- **Act** — fits → delegate to the wrapped provider unchanged. Doesn't fit → throw `ContextWindowExceededError` carrying the full estimate. No truncation, no summarization, no silent drop.

The seam: it's a `ModelProvider` decorator. It wraps *any* provider and presents the same `complete()` interface, so the guard is transparent to everything downstream — you compose it, you don't rewire for it.

## How it works

**Move 1 — the mental model.** The guard is a luggage scale at the gate. Before the bag goes on the plane it gets weighed; over the limit and you're turned away *at the gate*, not after the door closes mid-flight. The weight is estimated by length (char count), and a fixed amount of cargo space is always held back for the return payload (the model's output).

```
Guard decision on every complete() (PATTERN)

  request (system + messages + tools)
        │
        ▼  estimateModelRequestTokens   text.length / charsPerToken  (ceil)
   estimatedInputTokens
        │
        ▼  compare
   estimatedInputTokens ≤ (maxTokens − outputReserve) ?
        │                                   │
       yes                                 no
        ▼                                   ▼
  delegate to wrapped provider        throw ContextWindowExceededError
  (request passes through)            (carries the estimate; emits a warning)
```

**Move 2 — walk the pieces.**

**The decorator wraps any provider and guards its `complete()`.** It adds the check and otherwise gets out of the way.

```
context-window-guard.ts (57-69)              the measure→decide→act on each call
  async complete(request) {
    request.signal?.throwIfAborted();
    const estimate =
      estimateContextWindow(request, opts);  ─ MEASURE (59)
    if (!estimate.ok) {
      trace?.emit({ type:'warning', ... });  ─ observable: warn before failing (61-66)
      throw new ContextWindowExceededError(   ─ ACT-reject: loud, typed (67)
        estimate);
    }
    return this.provider.complete(request);   ─ ACT-accept: delegate unchanged (69)
  }
```

`packages/providers/local/src/context-window-guard.ts:57-69`. Notice it emits a `warning` trace event *before* throwing (61-66) — so the failure shows up in observability, not just as an exception. And it delegates the *unmodified* request when it fits (69): the guard never touches the payload, it only gates it.

**The budget is maxTokens minus a fixed output reserve.** You must leave room for the reply, or a request that "fits" still fails when the model tries to answer.

```
context-window-guard.ts (73-89)              the budget arithmetic
  estimateContextWindow(request, opts):
    outputReserve = opts.outputReserve ?? 768 ─ hold back room for the reply (78)
    estimatedInputTokens =
      estimateModelRequestTokens(req, cpt)     ─ measure the input (80)
    availableInputTokens =
      max(0, maxTokens − outputReserve)        ─ what's left for input (81)
    ok = estimatedInputTokens
         ≤ availableInputTokens                ─ the verdict (87)
```

`context-window-guard.ts:81` is the subtraction that makes the reserve real — the input budget is *not* the full window, it's the window minus 768 (default).

**Estimation is char-count, deliberately.** No tokenizer dependency; just length over a ratio.

```
context-window-guard.ts (91-103)             cheap, approximate, dependency-free
  estimateModelRequestTokens(req, cpt=3):
    text = [ system,                    ─────  everything that goes in...
             ...messages.map(text),
             ...tools.map(schema) ].join
    return ceil(text.length / cpt)      ─────  length ÷ 3 chars/token, rounded up (102)
```

`context-window-guard.ts:91-103`. The default is 3 chars per token (51). It's an approximation — a real tokenizer would be exact — but it's cheap, has no dependency, and `ceil` biases it to *over*-estimate, which is the safe direction for a guard.

**Move 3 — the principle.** Fail loud at the gate, not silent in the air. A guard that throws a typed error before the call is strictly better than a provider that truncates your context invisibly and gives you a confidently-wrong answer. The cost of that choice, stated honestly: the guard *only* rejects. It has no fallback — no summarize-then-retry, no drop-oldest-message. When it throws, the caller has to handle it. That's a real gap, and the Case B exercise fills it.

## Primary diagram

```
What the guard does — and pointedly does not — do

  MEASURE input (char/token estimate)      ████  context-window-guard.ts:91-103
  RESERVE output room (maxTokens−768)       ████  :81
  REJECT loud (typed error + warning event) ████  :67
  ─────────────────────────────────────────────
  TRUNCATE oldest messages                  ░░░░  not implemented
  SUMMARIZE to fit                          ░░░░  not implemented  ← Case B
  it gates; it never edits the payload to make it fit
```

## Elaborate

The over-estimate bias is intentional and correct for a guard. `Math.ceil(text.length / 3)` rounds up, and 3 chars/token is conservative for English (real ratios run ~4). A guard that errs toward over-estimating fails a few borderline-but-fine requests; a guard that under-estimates lets a too-big request through and you get the provider error you were trying to avoid. For a *gate*, false-positive-reject beats false-negative-admit.

The honest limitation worth saying out loud: this is a wall, not a valve. Production context management usually degrades gracefully — summarize old turns, drop the least-relevant retrieved chunk, or compress history — so a slightly-too-big request still succeeds with less context. aptkit's guard does none of that; it throws. That's defensible (loud beats silent) but incomplete, and the fix is a fallback strategy at the call site or in a smarter guard.

## Project exercises

### Add a truncation/summarization fallback instead of throwing

- **Exercise ID:** `EX-CTX-01a`
- **What to build:** A variant guard (or an option on the existing one) that, when the estimate is over budget, *reduces* the request to fit — drop-oldest-message and/or summarize history — before delegating, falling back to the throw only when even the reduced request won't fit. This extends the Phase 1 (context) context-window mechanism from "reject" to "degrade gracefully."
- **Why it earns its place:** It closes the one honest gap — the guard fails loud but never recovers. Graceful degradation is the production-grade behavior interviewers expect once you've shown you understand the finite container.
- **Files to touch:** `packages/providers/local/src/context-window-guard.ts` (`complete` 57-69; reuse `estimateContextWindow` 73-89).
- **Done when:** an over-budget request with droppable history succeeds with a reduced payload, and a request that can't be reduced enough still throws `ContextWindowExceededError`.
- **Estimated effort:** `1–2 days`

### Swap char-estimation for a real token count

- **Exercise ID:** `EX-CTX-01b`
- **What to build:** Make `estimateModelRequestTokens` pluggable so a real tokenizer can replace the `length / 3` heuristic, keeping the char-ratio as the dependency-free default.
- **Why it earns its place:** It tightens the estimate (fewer false rejects) while preserving the cheap fallback — a clean demonstration of the accuracy-vs-dependency tradeoff.
- **Files to touch:** `packages/providers/local/src/context-window-guard.ts:91-103`.
- **Done when:** the guard accepts an injected token-counter and falls back to char-estimation when none is provided.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: What does the context-window guard do when a request is too big?**

```
  estimate ≤ maxTokens − outputReserve ?  yes → delegate unchanged
                                          no  → emit warning + THROW ContextWindowExceededError
```

Anchor: `context-window-guard.ts:67` throws; `:69` delegates. It fails loud at the gate.

**Q: Why subtract `outputReserve` from `maxTokens`?**

Anchor: `:81` — the model needs room to *reply*; a request that fills the whole window leaves no space for output and fails mid-generation.

**Q: Why char-count estimation instead of a tokenizer, and what's the risk?**

```
  ceil(text.length / 3) — cheap, no dependency, over-estimates (safe for a gate)
  risk: rejects a few borderline-fine requests; never admits a too-big one
```

Anchor: `:102` — `Math.ceil(text.length / charsPerToken)`, default 3 (`:51`).

## See also

- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — *what* you put in the window matters too, not just how much.
- [03-prompt-chaining.md](03-prompt-chaining.md) — splitting work across calls keeps each request inside the window.
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — the `warning` event the guard emits.
