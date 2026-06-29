# Token economics

Token economics · cost accounting (Industry standard)

Every token costs money — input tokens and output tokens, at different rates, per model. If you don't tally it, you find out from the bill. aptkit has a cost ledger: it sums token usage from the trace and multiplies by a per-model rate. Be honest about the gap, though — only the gpt-4.1 tiers are priced. Anthropic and Gemma return `undefined` cost. For Gemma that's correct (local has no per-call price); for Anthropic it's an unwired tier.

## Zoom out, then zoom in

The ledger reads the same trace the event stream emits, and turns usage into dollars.

```
aptkit — where cost is counted
┌─────────────────────────────────────────────┐
│ Caller / Studio — "what did this run cost?"    │
├─────────────────────────────────────────────┤
│ ★ usage-ledger: summarizeUsage → estimateCost  │  ← you are here
├─────────────────────────────────────────────┤
│ Trace of model_usage events (from complete())  │
├─────────────────────────────────────────────┤
│ ModelResponse.usage { input, output tokens }   │
└─────────────────────────────────────────────┘
```

The pattern is "meter the resource at the boundary and price it after." The question: *what did this agent run cost, in dollars?* You've metered API usage before — a rate-limit counter, a billing dashboard. Same shape: tally units, multiply by price. The only twist is two rates (input cheaper than output) and that the price table is partial.

## Structure pass

Two functions, two jobs: sum the usage, then price it. Trace the **cost** axis — where a number turns into money, and where it can't.

```
COST axis — from tokens to dollars
Step                    output                          priced?
──────────────────────────────────────────────────────────────────
summarizeUsage(trace)   total in/out tokens + est flag  n/a (just counts)
estimateCost(...)       dollars                          ←★ seam
  pricingForModel        rate per million                 gpt-4.1* only
  → OpenAI tiers          number                           YES
  → Anthropic / Gemma     undefined → cost undefined       NO (gap)
```

The seam is `pricingForModel`. Up to it, every provider produces a clean token count. Past it, only OpenAI models map to a rate; everything else falls through to `undefined`, and `estimateCost` returns no dollar figure. The honest read: aptkit *meters* every provider but *prices* only one.

## How it works

**Mental model.** Two stages: aggregate, then price. `summarizeUsage` walks the trace and adds up tokens (carrying an `estimated` flag, since some counts are guesses — see `02-tokenization.md`). `estimateCost` looks up a per-million rate and multiplies.

```
Token economics — two stages
  trace events ──summarizeUsage──▶ {inputTokens, outputTokens, estimated}
                                          │
                                          ▼ estimateCost(provider, usage, model)
                              pricingForModel(model) ──▶ rate? 
                                  ┌──────────┴──────────┐
                            gpt-4.1*                  other
                                │                       │
                  (tokens/1e6)*rate = $          undefined (no price)
```

**Summing usage from the trace.** It folds every `model_usage` event into one total and remembers whether any count was estimated.

```ts
// packages/runtime/src/usage-ledger.ts:24-42  (summarizeUsage)
// walk trace, for each model_usage event:
//   inputTokens  += event.input
//   outputTokens += event.output
//   estimated    = estimated || event.estimated   // sticky: one estimate taints the total
```

The `estimated` flag is honesty propagation — if any token count came from the char-ratio guesser rather than a real count, the whole summary is flagged estimated. You never present a guessed number as if it were measured.

**The cost formula.** Plain unit math: tokens per million times price per million.

```ts
// packages/runtime/src/usage-ledger.ts:49-68  (estimateCost)
const pricing = pricingForModel(modelName);                  // :55
if (!pricing) return undefined;                              // no rate → no cost
const cost = (tokens / 1_000_000) * pricing.pricePerMillion; // :57-58
```

```ts
// packages/runtime/src/usage-ledger.ts:70-78  (pricingForModel) — the partial table
if (model.includes('gpt-4.1-nano')) return { ... };  // :74
if (model.includes('gpt-4.1-mini')) return { ... };  // :75
if (model.includes('gpt-4.1'))      return { ... };  // :76
return undefined;   // Anthropic, Gemma, anything else → unpriced
```

The order matters: `nano` and `mini` are checked before the bare `gpt-4.1` so the more specific tier wins (otherwise `gpt-4.1-nano` would match the `gpt-4.1` branch first). That ordered-prefix check is the whole pricing engine.

**The honest gap.** Gemma runs on local Ollama — no API, no per-token charge — so `undefined` cost is *correct*; the cost is electricity, not dollars-per-token. Anthropic, though, has real published rates that simply aren't in the table. So `estimateCost` returns `undefined` for a Sonnet run that genuinely cost money. That's the unwired tier, and it's the exercise.

**The principle.** Meter usage at the one boundary where it's observable (the model response), tally it centrally, and price it from a table you can extend. Keep metering universal even when pricing is partial — a token count with no price is still useful (budgets, comparisons); a missing token count is a hole you can't backfill.

## Primary diagram

The full path from a run's trace to a dollar figure (or an honest `undefined`).

```
Token economics — full path
  agent run ──▶ trace [model_usage, model_usage, ...]
                      │ summarizeUsage
                      ▼
        {inputTokens, outputTokens, estimated:bool}
                      │ estimateCost(provider, usage, modelName)
                      ▼
              pricingForModel(modelName)
        ┌──────────────┼───────────────────────┐
   gpt-4.1-nano    gpt-4.1-mini / gpt-4.1   anthropic / gemma / other
        │               │                          │
   (tok/1e6)*rate   (tok/1e6)*rate            undefined
        └──────┬────────┘                     (Gemma: correct — local)
            $ cost                            (Anthropic: gap — unwired tier)
```

The left branches return money; the right branch returns honesty.

## Elaborate

Input and output tokens price differently everywhere (output is typically 3–5× input) — a real table keys on `(model, direction)`, which aptkit's flat `pricePerMillion` flattens. Prompt caching (cached input tokens at a steep discount) is a third tier most vendors now offer and aptkit doesn't model — semantic/prompt caching is **not yet exercised**. The `estimated` flag ties straight back to `02-tokenization.md`: an estimated token count means an estimated cost, doubly so. Read `02-tokenization.md` for where the counts come from and `08-provider-abstraction.md` for why pricing is keyed on provider+model.

## Project exercises

### Add Anthropic Sonnet pricing tiers

- **Exercise ID:** `EX-LLM-06a`
- **What to build:** This is implemented for OpenAI (Case A) — extend it. Add Anthropic model tiers (e.g. the Sonnet line) to `pricingForModel`, with separate input/output rates per million, and update `estimateCost` to apply the right rate to input vs output token counts instead of a single flat rate.
- **Why it earns its place:** Phase 1 cost literacy means knowing input ≠ output pricing and that a partial table silently under-reports spend. You'll learn the ordered-prefix matching trap (specific tier before general) and the input/output split the current code flattens.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts` (70-78 `pricingForModel`, 49-68 `estimateCost`, 24-42 `summarizeUsage` if you split input/output).
- **Done when:** an Anthropic Sonnet run returns a non-undefined cost, input and output tokens are priced at their own rates, gpt-4.1 tiers still resolve correctly, and Gemma still returns `undefined` (local is unpriced by design).
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why does a Gemma run report no cost?**

```
  pricingForModel('gemma...') → undefined → estimateCost → undefined
  Gemma runs on LOCAL Ollama (:11434, no API key) → no per-token charge
  └ undefined is CORRECT here, not a bug
```

Because Gemma runs locally — there's no per-token API charge, so `undefined` is the honest answer. The cost is your electricity. Anchor: *local-first means no price tag, on purpose.*

**Q: So aptkit's cost accounting is complete?**

```
  metered:  OpenAI ✓  Anthropic ✓  Gemma ✓   (token counts: universal)
  priced:   OpenAI ✓  Anthropic ✗  Gemma n/a (rates: partial)
            └ Anthropic Sonnet runs cost money but report undefined cost
```

No — metering is universal, pricing isn't. Only gpt-4.1 tiers have rates; Anthropic is an unwired gap (real cost, no figure). Anchor: *aptkit meters everything, prices one vendor.*

## See also

- [`02-tokenization.md`](./02-tokenization.md) — where token counts (and the `estimated` flag) originate.
- [`08-provider-abstraction.md`](./08-provider-abstraction.md) — why pricing keys on provider + model.
- [`05-streaming.md`](./05-streaming.md) — usage is read from the same trace events.
