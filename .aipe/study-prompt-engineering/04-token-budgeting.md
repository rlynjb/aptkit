# 04 — Token budgeting and context window management

**Industry name(s):** context window management / token budgeting / cost
accounting. **Type:** Industry standard.

## Zoom out, then zoom in

Token counting is not optional. It's the hygiene that separates a prompt system
that works on test inputs from one that survives real workspaces. AptKit has
three pieces of this: a context-window guard that refuses oversized requests, a
hard cap on tool-result size, and a usage ledger that sums tokens and cost. Look
at where they sit.

```
  Zoom out — where the token budget is enforced

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  MAX_TOOL_RESULT_CHARS truncation · maxTokens cap            │
  │  ★ usage-ledger: sum tokens, estimate cost ★                 │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                             │  request flows down
  ┌─ Provider layer (packages/providers/local) ─▼───────────────┐
  │  ★ ContextWindowGuardedProvider: estimate, refuse if over ★  │ ← and here
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. The pattern: estimate the input size *before* the call, reserve room
for the output, refuse if it won't fit, truncate the biggest variable input (tool
results), and account for what you spent. AptKit does all of that — with one
honest caveat: it estimates tokens as `characters / 3`, not with a real
tokenizer.

## Structure pass

**Layers.** Three: *truncation* (cap each tool result at 16K chars before it
re-enters the prompt), the *guard* (estimate the whole request, refuse if over
budget), and the *ledger* (sum what was actually spent).

**Axis — held constant: "where does the token budget get enforced?"**

```
  One question down the stack: where's the budget enforced?

  ┌─ tool-result truncation ──┐  → at INGEST: cap each result at 16K chars
  │ MAX_TOOL_RESULT_CHARS     │
  └───────────────────────────┘
  ┌─ context-window guard ────┐  → at SEND: estimate request, refuse if over
  │ estimateContextWindow     │
  └───────────────────────────┘
  ┌─ usage ledger ────────────┐  → AFTER: sum tokens, estimate USD cost
  │ summarizeUsage            │
  └───────────────────────────┘
```

**Seam — the guard's refuse/allow decision.** The load-bearing seam is
`estimate.ok`. Above it, a request is just data; at it, the guard decides whether
the request fits the local model's window. The axis (budget enforcement) flips
here from "accumulating" to "checked." Cross it over budget and the call never
happens — `ContextWindowExceededError` is thrown and the fallback chain moves on.

## How it works

#### Move 1 — the mental model

You already manage a fixed-size buffer: you know its capacity, you reserve space
for what must fit, and you reject or truncate what won't. A context window is that
buffer. Capacity is the model's max tokens; the reserved space is the output; the
thing you truncate is the largest variable input.

```
  The context window as a fixed buffer

  ┌──────────────── maxTokens (e.g. 8192) ───────────────────┐
  │ system prompt │ tool results │ history │  RESERVED output │
  │   (mostly     │  (truncated  │         │  (outputReserve  │
  │    constant)  │   at 16K ch) │         │   = 768)         │
  └──────────────────────────────────────────────────────────┘
   availableInputTokens = maxTokens - outputReserve
   if estimatedInputTokens > availableInputTokens → refuse
```

#### Move 2 — the walkthrough

**Truncation at ingest — `MAX_TOOL_RESULT_CHARS`.** The biggest variable input to
an agent prompt is tool results: a metric timeseries can be huge. Before a tool
result re-enters the message history, the loop truncates it to 16,000 characters
with a `...[truncated]` marker. **Breaks if missing:** one fat tool result blows
the window mid-run, and the failure shows up three turns later as a context-length
error with no obvious cause. This is the specific bug the spec warns about — a
chain that works on small inputs and silently breaks at scale.

```
  Tool-result truncation — cap the variable input at ingest

  tool returns 80,000-char JSON
        │
        ▼ truncate(JSON.stringify(result))
  "...[truncated]"  (16,000 chars max)
        │
        └─ re-enters messages bounded; the window can't blow from one big result
```

**Estimate before send — the guard.** The local provider wraps another provider
and, before delegating, estimates the request's input tokens (system + all
messages + tool schemas) and compares against `maxTokens - outputReserve`. Over
budget → it throws `ContextWindowExceededError` and emits a `warning` trace.
**Breaks if missing:** you send a too-big request to a small local model and get a
provider error instead of a clean skip to the next provider in the fallback chain.

```
  Context guard — estimate, reserve, refuse

  estimateModelRequestTokens(request) = ceil(allText.length / 3)
        │
        ▼
  availableInputTokens = maxTokens - outputReserve(768)
        │
   estimated <= available ?  ── yes ──► delegate to wrapped provider
        │
        no ──► throw ContextWindowExceededError (fallback chain continues)
```

**The honest caveat — `charsPerToken = 3`.** The estimate is `text.length / 3`.
That's a heuristic, not a tokenizer. For English it's roughly right; for dense
JSON, code, or non-Latin scripts it drifts. **Breaks subtly:** the estimate can
under-count, the guard says "fits," and the real tokenizer disagrees at the
provider. A real `tiktoken`/`@anthropic-ai/tokenizer` count would remove the
drift. The repo chose the heuristic for zero-dependency portability; the cost is
estimation error near the boundary.

**Account after — the usage ledger.** `summarizeUsage` folds the `model_usage`
trace events into one row: input tokens, output tokens, turns, and an `estimated`
flag. `estimateCost` turns that into USD using per-million pricing. **Breaks if
missing:** you ship a chain with no idea what it costs per run until the invoice
arrives. Honest gap: pricing only covers `gpt-4.1-*` (`pricingForModel` returns
`undefined` for any non-openai provider), so Anthropic runs report tokens but no
cost.

#### Move 2.5 — current state vs future state

Two pieces are built-but-inert and worth naming honestly.

```
  Phase A (now)                          Phase B (buildable)
  ─────────────                          ───────────────────
  tokens ≈ length / 3                    real tokenizer count
  compactSystem declared, unused         compactSystem used when near 80%
  no cache_control directives            prefix-cache the static system block
  cost: gpt-4.1-* only                   cost across all providers
```

The 80% rule (if you're using >80% of the window you're one model change from
breaking) has no enforcement here — the guard checks a hard fit, not a headroom
margin. `compactSystem` exists in the type for exactly this (swap to the shorter
prompt under budget pressure) but nothing reads it yet. And there are no prefix-
cache / `cache_control` directives — keeping the static system block at the front
so a provider can cache it is a structure decision the repo hasn't made.

#### Move 3 — the principle

Count before you send, reserve for the output, truncate the variable input, and
account for what you spent. The estimate doesn't have to be perfect — it has to
exist *before* the call, so a too-big prompt is a clean refusal you control, not a
provider error you discover at scale.

## Primary diagram

The full budget path for one local-guarded run.

```
  Token budget — ingest to accounting

  tool result ──► truncate(16K chars) ──► messages
                                            │
  system + messages + tool schemas ─────────┤
                                            ▼
                          estimateModelRequestTokens = ceil(len/3)
                                            │
                  available = maxTokens - outputReserve(768)
                                            │
                   estimated <= available ? ── no ──► throw → fallback chain
                                            │ yes
                                            ▼
                                  provider.complete()
                                            │ usage{input,output}
                                            ▼
        summarizeUsage(trace) → { inputTokens, outputTokens, turns }
                                            │
                       estimateCost(provider, usage, model) → USD (gpt-4.1-* only)
```

## Implementation in codebase

**Use cases.** The guard wraps any provider for local/small-model runs and the
fallback chain. Truncation runs on every tool result in every agent. The ledger
feeds Studio's cost displays and replay summaries.

Truncation at ingest:

```
  packages/runtime/src/run-agent-loop.ts  (lines 52–57, 162)

  const MAX_TOOL_RESULT_CHARS = 16_000;
  function truncate(value: string): string {
    if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
    return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
  }
  ...
  resultContent = truncate(JSON.stringify(result));
       │
       └─ this cap is what stops one fat tool result from blowing the window
          mid-run. Without it, the chain works on small inputs and dies at scale.
```

The guard — estimate, reserve, refuse:

```
  packages/providers/local/src/context-window-guard.ts  (lines 57–67, 73–102)

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const estimate = estimateContextWindow(request, this.options);
    if (!estimate.ok) {
      this.options.trace?.emit({ type: 'warning', ... });
      throw new ContextWindowExceededError(estimate);   ← clean refusal, fallback continues
    }
    return this.provider.complete(request);
  }
  ...
  const availableInputTokens = Math.max(0, maxTokens - outputReserve);  ← reserve output room
  return { ..., ok: estimatedInputTokens <= availableInputTokens };
```

The token estimate — the `/3` heuristic, stated plainly:

```
  packages/providers/local/src/context-window-guard.ts  (lines 91–103)

  export function estimateModelRequestTokens(request, charsPerToken = 3): number {
    const text = [ request.system ?? '', ...messages, ...toolSchemas ].join('\n');
    return estimateTextTokens(text, charsPerToken);
  }
  export function estimateTextTokens(text, charsPerToken = 3): number {
    return Math.ceil(text.length / charsPerToken);   ← NOT a tokenizer; drifts on JSON/non-Latin
  }
       │
       └─ honest weakness: a real tokenizer would remove the near-boundary drift.
          The /3 was chosen for zero-dependency portability.
```

The ledger and its pricing gap:

```
  packages/runtime/src/usage-ledger.ts  (lines 26–43, 77–84)

  export function summarizeUsage(trace): TokenUsageSummary {
    return trace.reduce((summary, event) => {
      if (event.type !== 'model_usage') return summary;
      return { inputTokens: summary.inputTokens + (event.inputTokens ?? 0), ... };
    }, { inputTokens: 0, ..., turns: 0, estimated: false });
  }
  ...
  export function pricingForModel(provider, modelName): UsagePricing | undefined {
    if (provider !== 'openai') return undefined;   ← Anthropic runs: tokens yes, cost no
    if (normalized.startsWith('gpt-4.1')) return { inputUsdPerMillion: 2, outputUsdPerMillion: 8 };
    return undefined;
  }
```

## Elaborate

Budgeting is the most operational concept in this guide, and AptKit's choices
read like real engineering tradeoffs. The `/3` heuristic is the kind of decision
that's right until it isn't: it keeps the local provider dependency-free and is
fine for English prose, but a workspace whose tool results are dense JSON will see
the estimate under-count and the guard wave through requests the real tokenizer
rejects. The fix is a real tokenizer behind the same `estimateTextTokens`
interface — the seam is already in the right place.

Three buildable increments, in priority order: (1) record the `model_usage`-based
budget headroom and warn at 80% — the rule everyone quotes but nobody enforces
here; (2) wire `compactSystem` to swap in under budget pressure; (3) prefix-cache
the static system block (`cache_control` on Anthropic) since the system prompt is
constant across turns and is the cheapest token-saving win available — the repo
already keeps the stable content at the front, which is the precondition.

This connects to 03 (`compactSystem` is the declared-but-unused variant slot), 05
(token/cost belongs in the eval summary so you catch a chain that got more
expensive after a prompt change), and the provider fallback chain (a guard refusal
is what makes the chain skip a too-small model gracefully).

## Interview defense

**Q: How do you stop a chain from blowing the context window?**
Three moves: truncate the largest variable input at ingest (tool results capped at
16K chars), estimate the whole request before sending and refuse over budget while
reserving room for the output, and account for what you spent. The refusal is the
key — a too-big prompt becomes a clean error you control and the fallback chain
skips, not a provider error you hit at scale.

```
  truncate(16K) → estimate(sys+msgs+tools) vs (max - reserve) → refuse | send
                              ▲
                       reserve output room BEFORE checking fit
```
Anchor: "`MAX_TOOL_RESULT_CHARS` at `run-agent-loop.ts:52`, guard at
`context-window-guard.ts:73`."

**Q: What's wrong with `length / 3` for token counting?**
It's a heuristic, not a tokenizer. Fine for English, drifts on dense JSON, code,
and non-Latin scripts — it under-counts, the guard says "fits," and the real
tokenizer disagrees at the provider near the boundary. The fix is a real tokenizer
behind the same `estimateTextTokens` seam.
Anchor: "`charsPerToken = 3` at `context-window-guard.ts:100`."

## Validate

- **Reconstruct:** Draw the context window as a buffer with the three regions and
  the reserve.
- **Explain:** Why does the guard subtract `outputReserve` (768) *before*
  comparing in `context-window-guard.ts:81`? What goes wrong if it didn't?
- **Apply:** A workspace's tool results are dense JSON and the `/3` estimate
  under-counts. Where do you swap in a real tokenizer, and what stays unchanged?
- **Defend:** Argue for enforcing an 80% headroom warning (not just a hard fit
  check) given that the model can be upgraded under you.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — the truncation that keeps tool results in budget.
- [03-prompts-as-code.md](03-prompts-as-code.md) — the unused `compactSystem` variant slot.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — token/cost in the eval summary.
