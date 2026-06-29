# LLM cost optimization

**Subtitle:** Measure tokens, price them, route the cheap thing first · the usage ledger · *Industry standard*

## Zoom out, then zoom in

Before any tactic: you can't optimize a cost you don't measure. Here's where the
measuring instrument sits in aptkit — and where the pricing it feeds quietly
runs out of data.

```
  Zoom out — where cost gets measured in aptkit

  ┌─ Agent run ─────────────────────────────────────────────────┐
  │  every model turn emits a `model_usage` trace event          │
  │  (run-agent-loop.ts:111, structured-generation.ts:131)       │
  └───────────────────────────┬─────────────────────────────────┘
                              │ trace events
  ┌─ Usage ledger ────────────▼─────────────────────────────────┐
  │  ★ summarizeUsage  → sum tokens across turns                │ ← the instrument
  │  ★ estimateCost    → tokens × price                          │
  └───────────────────────────┬─────────────────────────────────┘
                              │ pricingForModel(provider, model)
  ┌─ Price table ─────────────▼─────────────────────────────────┐
  │  OpenAI gpt-4.1 family ONLY · Gemma=$0 · Anthropic=undefined │ ← the gap
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. aptkit *measures* tokens well — every turn emits a `model_usage`
event and `summarizeUsage` sums them. What it can't fully *price* is anything
outside the OpenAI gpt-4.1 family. Gemma is free because it's local, so $0 is
correct. Anthropic pricing is `undefined` — a real gap, not a free lunch. And
the famous "route cheap models first" tactic? aptkit has a fallback chain that
looks like it but optimizes *availability*, not cost.

## Structure pass

**Layers.** Run → ledger → price table. The ledger is provider-neutral (it sums
whatever turns happened); the price table is provider-*specific* (it only knows
OpenAI).

**Axis — cost.** Trace a dollar. Tokens are counted at the model boundary
(`response.usage`), summed by `summarizeUsage`, then multiplied by a per-million
rate in `pricingForModel`. The dollar amount is only as good as that last
multiply — and for Gemma it's $0 (local), for Anthropic it's `undefined`
(unpriced).

**Seam.** The load-bearing boundary is `pricingForModel(provider, modelName)`
(`packages/runtime/src/usage-ledger.ts:71`). Above it, token counts are real and
provider-neutral. Below it, the answer depends entirely on whether the table has
a row. The axis "do we know what this cost?" flips here: known for OpenAI,
$0-and-correct for Gemma, `undefined`-and-blind for Anthropic.

## How it works

### Move 1 — the mental model

You know how a phone bill separates *metered usage* (minutes used) from the *rate
plan* (cents per minute)? The ledger is that exact split. `summarizeUsage` reads
the meter; `pricingForModel` is the rate plan. Swap the model and the meter
keeps reading — but if the rate plan has no row for that model, the bill comes
back blank.

```
  Meter vs. rate plan — two separate jobs

  meter (provider-neutral)            rate plan (provider-specific)
  ┌────────────────────────┐         ┌─────────────────────────────┐
  │ summarizeUsage:        │  tokens │ pricingForModel:            │
  │  sum inputTokens       │ ──────► │  gpt-4.1     $2 / $8 per M   │
  │  sum outputTokens      │         │  gpt-4.1-mini $0.4 / $1.6    │
  │  count turns           │         │  gpt-4.1-nano $0.1 / $0.4    │
  └────────────────────────┘         │  everything else → undefined │
                                      └─────────────────────────────┘
   meter always works · bill only prints if the plan has a row
```

### Move 2 — the instrument, the pricing, and the routing it doesn't do

**The meter — `summarizeUsage`.** It folds every `model_usage` event into one
row, ignoring everything else. `packages/runtime/src/usage-ledger.ts:25`:

```ts
export function summarizeUsage(trace: readonly CapabilityEvent[]): TokenUsageSummary {
  return trace.reduce<TokenUsageSummary>(
    (summary, event) => {
      if (event.type !== 'model_usage') return summary;   // only count model turns
      const inputTokens = event.inputTokens ?? 0;
      const outputTokens = event.outputTokens ?? 0;
      return {
        inputTokens: summary.inputTokens + inputTokens,    // accumulate in
        outputTokens: summary.outputTokens + outputTokens, // accumulate out
        totalTokens: summary.totalTokens + inputTokens + outputTokens,
        modelName: event.model || summary.modelName,
        turns: summary.turns + 1,                          // one turn = one call
        estimated: summary.estimated || event.estimated === true,
      };
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '', turns: 0, estimated: false },
  );
}
```

Provider-neutral by design — it never asks *which* model, only sums what the
turns reported.

**The rate plan — `pricingForModel`.** This is where provider-neutrality ends
hard. `packages/runtime/src/usage-ledger.ts:71`:

```ts
export function pricingForModel(provider: string, modelName: string): UsagePricing | undefined {
  if (provider !== 'openai') return undefined;            // ← Gemma, Anthropic: no row
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.startsWith('gpt-4.1'))      return { inputUsdPerMillion: 2,   outputUsdPerMillion: 8   };
  return undefined;                                       // any other openai model: blind
}
```

Read the first line carefully: `if (provider !== 'openai') return undefined`.
Gemma returns `undefined` and that's *correct* — local Gemma costs $0, so
`estimateCost` returning nothing is the truth. Anthropic also returns `undefined`
and that's a *gap* — a paid model with no row prices as blank, not as $0. Same
return value, opposite meaning. Know the difference cold.

**The routing aptkit doesn't do.** The classic cost tactic is "send the easy
prompt to the cheap model, escalate only hard ones." aptkit has a chain that
*looks* like it — `FallbackModelProvider` tries providers in order. But read why
it iterates: it falls to the next provider on *error*, not on cost or quality.
`packages/providers/fallback/src/fallback-provider.ts:47`:

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  const attempts: FallbackAttempt[] = [];
  for (let index = 0; index < this.providers.length; index += 1) {
    const provider = this.providers[index];
    try {
      const response = await provider.complete(request);   // try this provider
      this.lastSelectedProvider = { providerId: provider.id, model: response.model ?? provider.defaultModel };
      return { ...response, model: response.model ?? provider.defaultModel };
    } catch (error) {                                       // ← only errors advance the chain
      // ...record attempt, maybe fall through to next provider...
    }
  }
  throw new ProviderFallbackError(attempts);
}
```

The chain advances on a `catch`, never on "this model was good enough cheaper."
That makes it failover-by-*availability* (try local Gemma first, fall to cloud if
it dies), which *incidentally* favors the free model — but cost-aware quality
routing is `not yet exercised`.

### Move 3 — the principle

Split the meter from the rate plan so token-counting stays universal while
pricing stays a swappable table. aptkit nailed the meter and left the rate plan
half-populated on purpose: it only prices what it has actually run on the cloud
(OpenAI), and it tells the truth elsewhere — $0 for free-local Gemma, `undefined`
for unrun-but-paid Anthropic. The discipline isn't "price everything," it's
"never invent a number you can't back."

## Primary diagram

```
  The cost path, end to end — and where it goes blind

  every model turn
        │ emits model_usage { inputTokens, outputTokens, model }
        ▼
  ┌─ summarizeUsage ─────────┐   provider-neutral, always works
  │ Σ in · Σ out · turns     │
  └────────────┬─────────────┘
               │ (provider, model, tokens)
               ▼
  ┌─ estimateCost → pricingForModel ───────────────────────────┐
  │  openai gpt-4.1*  →  real $ ($2/$8, mini $0.4/$1.6, nano…)  │
  │  gemma (local)    →  undefined  = correct $0                │
  │  anthropic        →  undefined  = GAP (paid, but unpriced)  │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The whole reason cost optimization is mostly unbuilt here is the Gemma economics:
local inference has no per-token bill, so the headline tactics (cheap-model
routing, caching, batching) have no dollar payoff and aptkit didn't chase them.
The instrument is still worth its weight — the moment a paid provider enters the
fallback chain, `summarizeUsage` already counts the tokens and the only work left
is adding a pricing row. The clean next step is to fill in Anthropic pricing so
`undefined` stops meaning two different things. Read `01-llm-caching.md` for the
sibling lever (skip the call entirely) and `05-retry-circuit-breaker.md` for the
fallback chain's other job.

## Project exercises

### Add Anthropic pricing rows to the rate plan
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend `pricingForModel` so `provider === 'anthropic'` with
  known Claude model ids returns real per-million rates, leaving Gemma's $0/local
  case untouched.
- **Why it earns its place:** closes the `undefined`-means-two-things gap and
  forces you to reason about why $0 (free) and `undefined` (unpriced) must stay
  distinct.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts` (the
  `pricingForModel` branch at `:71`).
- **Done when:** a test asserts an Anthropic model yields a non-`undefined`
  `CostEstimate` while a Gemma model still yields `undefined`.
- **Estimated effort:** `<1hr`

### (Case B) Make the fallback chain cost-aware
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a design note + skeleton that orders the fallback providers
  cheapest-first using `pricingForModel`, distinguishing "advance on error"
  (today) from "advance on cost/quality" (the goal).
- **Why it earns its place:** the interview cliché is cheap-model routing;
  building it on top of the *availability* chain shows you know the two are
  different axes.
- **Files to touch:** new
  `packages/providers/fallback/src/cost-aware-fallback.ts` (skeleton),
  reference `packages/providers/fallback/src/fallback-provider.ts:47` and
  `packages/runtime/src/usage-ledger.ts:71`.
- **Done when:** a written note states why ordering by price is a different
  decision than failover, and where each belongs.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "Why does Gemma show $0 and Anthropic show nothing — isn't that the same?"**
No — they're opposite truths sharing one return value. Gemma runs locally, so $0
is the correct cost. Anthropic returns `undefined` because there's no pricing
row, so the system is *blind*, not free. The fix is adding a row, not treating
`undefined` as zero.

```
  pricingForModel returns undefined for BOTH:
   gemma     → local, no bill        → undefined == correct $0
   anthropic → paid, no row in table → undefined == GAP (unpriced)
```
Anchor: *`usage-ledger.ts:72` — `if (provider !== 'openai') return undefined`.*

**Q: "Doesn't the fallback chain already do cheap-model routing?"**
It looks like it but it doesn't. The chain advances only inside a `catch` — it
falls to the next provider on *failure*, not because a cheaper one was good
enough. Trying free-local Gemma first incidentally favors cost, but quality-aware
cost routing is unbuilt.

```
  fallback chain:   try A → on ERROR → try B → on ERROR → fail
  cost routing:     classify prompt → easy? cheap model : hard? big model
   different trigger (error vs. difficulty) → different decision
```
Anchor: *`fallback-provider.ts:64` — the chain only moves on `catch`.*

## See also

- `01-llm-caching.md` — the other dollar lever: skip the call entirely
- `05-retry-circuit-breaker.md` — the fallback chain's availability job
- `01-llm-foundations/06-token-economics.md` — where `usage` originates
