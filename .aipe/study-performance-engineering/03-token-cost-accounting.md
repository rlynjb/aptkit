# Token cost accounting

*Industry names: usage ledger / token metering / LLM cost attribution. Type:
Project-specific (over an industry-standard idea).*

## Zoom out, then zoom in

With an LLM app the bill is tokens, and tokens are invisible unless you count
them. The question this file answers: **how does aptkit turn a run into a
number of tokens and a dollar figure — and where does that accounting stop short
of being a baseline?** The answer: every model call emits a usage event, the
runtime sums those events, and a pricing table converts the sum to USD.

```
  Zoom out — where cost accounting lives

  ┌─ Client (apps/studio) ──────────────────────────────────────┐
  │  shows durationMs + token usage + estimated $ per replay     │
  └───────────────────────────┬──────────────────────────────────┘
                              │  trace[] (CapabilityEvent[])
  ┌─ Runtime (packages/runtime) ▼────────────────────────────────┐
  │  loop emits model_usage events  →  summarizeUsage()           │
  │  →  estimateCost(provider, usage, model)  ★ THIS CONCEPT ★    │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  per-call token counts
  ┌─ Provider (packages/providers/*) ▼───────────────────────────┐
  │  each complete() returns usage:{inputTokens, outputTokens}    │
  └───────────────────────────────────────────────────────────────┘

  cost is reconstructed from the trace, not the provider's invoice — provider-
  neutral by construction. the gap: it's per-run, never aggregated into a baseline.
```

The pattern: **derive cost from the event stream, not from the vendor.** Each
`complete()` reports its own token counts; the loop records them as trace
events; a pure reducer sums them; a pricing table prices them. Because it rides
on the trace, the same accounting works for Anthropic, OpenAI, or a local Gemma
run — the cost number is computed the same way regardless of who served the
tokens.

## The structure pass

Trace the **cost** axis from "tokens spent" to "dollars shown."

```
  One axis (cost) traced from provider to UI

  ┌─ provider ─────────────┐  reports    ┌─ runtime ledger ──────┐
  │ usage:{in,out,estimated}│ ══════════► │ summarizeUsage sums   │
  └─────────────────────────┘             │ estimateCost prices   │
                                          └──────────┬────────────┘
                                            ★ flips here: tokens → USD
                                                     ▼
                                          ┌─ studio ──────────────┐
                                          │ formatCost → "$0.0123"│
                                          └───────────────────────┘
```

- **Layers:** provider (raw counts) → runtime (sum + price) → Studio (format).
- **Axis:** cost, in two units — tokens upstream of the pricing table, dollars
  downstream.
- **Seam:** `estimateCost`. This is where the axis-answer flips from
  provider-neutral token counts to a USD figure that depends on a *provider +
  model* pricing lookup. It's also where the accounting is most fragile — the
  table only knows OpenAI gpt-4.1.

## How it works

#### Move 1 — the mental model

You know how a request's trace is a list of events you can `reduce` over to
compute anything you want after the fact? Cost here is exactly that — a `reduce`
over the `model_usage` events in the trace. The tokens were already emitted; the
ledger is a pure function that folds them up.

```
  Pattern — fold the trace into a usage summary, then price it

  trace: [step, model_usage(120,40), tool_call, model_usage(900,60), step]
                      │                              │
                      └──────── reduce (sum) ────────┘
                                   ▼
            usage = { inputTokens:1020, outputTokens:100, turns:2 }
                                   ▼
            estimateCost("openai", usage, "gpt-4.1") → { totalCost: 0.00284 }
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — the loop emits a usage event per call.** Inside `runAgentLoop`, right
after each `model.complete`, if the response carries usage it's emitted as a
`model_usage` event — `run-agent-loop.ts:111-122`:

```ts
if (response.usage) {
  trace?.emit({
    type: 'model_usage',
    capabilityId,
    provider: model.id,
    model: response.model ?? model.defaultModel ?? 'unknown',
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    estimated: response.usage.estimated,   // ← did the provider COUNT or GUESS?
    timestamp: timestamp(),
  });
}
```

Note `estimated`. Gemma reports real counts from Ollama (`prompt_eval_count` /
`eval_count`, `gemma-provider.ts:120-125`, `estimated: false`); a provider that
can't count sets `estimated: true`. That flag rides all the way to the summary
so a downstream reader knows whether the number is measured or guessed.

**Step 2 — `summarizeUsage` folds the events.** A pure reducer over the trace —
`usage-ledger.ts:25-42`:

```ts
export function summarizeUsage(trace) {
  return trace.reduce((summary, event) => {
    if (event.type !== 'model_usage') return summary;   // ignore non-usage events
    const inputTokens = event.inputTokens ?? 0;
    const outputTokens = event.outputTokens ?? 0;
    return {
      inputTokens: summary.inputTokens + inputTokens,
      outputTokens: summary.outputTokens + outputTokens,
      totalTokens: summary.totalTokens + inputTokens + outputTokens,
      modelName: event.model || summary.modelName,
      turns: summary.turns + 1,                          // ← one turn per usage event
      estimated: summary.estimated || event.estimated === true,  // sticky: any guess → estimated
    };
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '', turns: 0, estimated: false });
}
```

The `estimated` flag is *sticky* — `||` means one estimated turn taints the
whole summary as estimated. That's honest: a sum that's part-measured,
part-guessed is a guess. `turns` here is literally the count of model
round-trips, the same unit `01-bounded-loop-cost-ceiling.md` bounds.

**Step 3 — `estimateCost` prices the sum.** The token→dollar conversion —
`usage-ledger.ts:50-68`:

```ts
const pricing = pricingForModel(provider, modelName);   // table lookup
if (!pricing) return undefined;                         // ← unknown model → no estimate
const inputCost  = (usage.inputTokens  / 1_000_000) * pricing.inputUsdPerMillion;
const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
return { currency: 'USD', inputCost, outputCost, totalCost: inputCost + outputCost, ... };
```

**The boundary condition — and the real weakness — is `pricingForModel`**
(`:71-78`):

```ts
export function pricingForModel(provider, modelName) {
  if (provider !== 'openai') return undefined;          // ← ONLY openai is priced
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.startsWith('gpt-4.1'))      return { inputUsdPerMillion: 2,   outputUsdPerMillion: 8 };
  return undefined;
}
```

This table knows *only* OpenAI gpt-4.1. Anthropic — the repo's default cloud
provider — returns `undefined`, so an Anthropic run reports tokens but **no
dollar figure**. Gemma is local and genuinely free, so `undefined` is correct
there. The design choice is the right one (`undefined` over a wrong number — a
made-up Anthropic price would be worse than none), but the coverage gap is real
and noted in the project context's open items.

**Step 4 — Studio formats and displays.** Every replay computes
`modelTurnCount(trace)` and a duration (`vite.config.ts:569-571`), and the
summary path runs `summarizeUsage` + `estimateCost` and formats with
`formatCost` (`usage-ledger.ts:81-86`), which shows 4 decimals under a cent and
2 above. That's where you see "$0.0028" next to a run.

#### Move 2 variant — the load-bearing skeleton

The kernel: **(1) a per-call token report tagged with provider+model, (2) a sum
over reports, (3) a price lookup keyed on provider+model, (4) an `estimated`
flag carried end to end.**

- Drop the per-call report → nothing to sum; cost is unknowable.
- Drop the `estimated` flag → you can't tell a measured bill from a guessed
  one; you'd trust a fabricated number.
- Drop the price lookup's `undefined`-on-unknown → you'd invent prices for
  models you don't know, reporting confident wrong dollars.

Optional hardening: the `formatCost` display rules, the per-provider table
expansion. The skeleton is report → sum → price → honesty flag.

#### Move 3 — the principle

Reconstruct cost from the event stream, not the vendor invoice, and it stays
provider-neutral and available *during* the run, not a month later on a bill.
The deeper rule: **carry an `estimated` flag through every aggregation so a
consumer always knows whether a number was counted or guessed** — a measured
sum and a guessed sum must never look identical. The honest limit on this repo:
this is per-run accounting, not a *baseline*. Nothing aggregates cost across
runs, sets a per-answer budget, or alerts on regression. It's the raw material
for a cost budget that nobody has assembled yet.

## Primary diagram

```
  Token cost accounting — trace to dollars, provider-neutral

  ┌─ Provider layer ────────────────────────────────────────────┐
  │  complete() → usage{ inputTokens, outputTokens, estimated }  │
  └───────────────────────────┬──────────────────────────────────┘
                              │ emitted per call
  ┌─ Runtime layer ───────────▼──────────────────────────────────┐
  │  trace[].filter(model_usage) → summarizeUsage (reduce/sum)   │
  │     → { inputTokens, outputTokens, turns, estimated(sticky) }│
  │  → estimateCost(provider, usage, model)                      │
  │       └ pricingForModel: openai gpt-4.1 ONLY → else undefined│
  └───────────────────────────┬──────────────────────────────────┘
                              │ CostEstimate | undefined
  ┌─ Client layer ────────────▼──────────────────────────────────┐
  │  formatCost → "$0.0028" / "n/a"  shown per replay            │
  └───────────────────────────────────────────────────────────────┘
       measured per run · NOT aggregated into a baseline (the gap)
```

## Elaborate

Metering tokens off the response is the standard pattern for LLM cost
attribution — the alternative (reconciling against the provider's billing API)
is laggy and provider-specific. Deriving from the trace also means cost is
computable in *replay*: a promoted fixture carries the original usage counts
(`vite.config.ts:1340-1344`), so even a deterministic re-run reports the cost of
the live run it was promoted from. Read next:
`01-bounded-loop-cost-ceiling.md` (what bounds the number of turns this sums
over) and `04-embedding-batching.md` (the *other* token/IO cost — embeddings —
which this ledger does not currently price).

## Interview defense

**Q: How do you track what an agent run costs?**

Verdict first: derive it from the trace, not the vendor invoice — provider-neutral
and available in real time. Each model call reports its token counts as a
`model_usage` event; a pure reducer sums them; a pricing table converts to USD.
The detail that signals you've shipped this: an `estimated` flag carried end to
end, sticky under `||`, so a part-guessed sum is reported as guessed — and a
pricing lookup that returns `undefined` for unknown models rather than inventing
a price.

```
  sketch while you talk:

  trace → filter(model_usage) → reduce(sum tokens, OR estimated flags)
        → estimateCost: pricingForModel(provider, model)  ← undefined if unknown
        → formatCost → "$0.0028"
```

One-line anchor: *"cost reconstructed from the event stream, with an honesty
flag so a guessed dollar never masquerades as a measured one."*

**Q: What's broken about it today?**

Two honest gaps. One: the pricing table only knows OpenAI gpt-4.1, so an
Anthropic run — the default cloud provider — reports tokens but no dollars.
Two: it's per-run, not a baseline. Nothing aggregates across runs or sets a
per-answer cost budget, so there's no regression signal. The accounting exists;
the *budget* built on it doesn't yet.

## See also

- `audit.md` — lens 2 (baselines), lens 1 (budget), the `estimated`-coverage
  open item.
- `01-bounded-loop-cost-ceiling.md` — bounds the turn count this sums over.
- `04-embedding-batching.md` — the embedding cost this ledger doesn't price.
