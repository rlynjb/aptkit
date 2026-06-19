# Token economics — the cost ledger (and its honest blind spot)

**Industry names:** token accounting, cost tracking, usage metering · *Industry standard*

## Zoom out, then zoom in

Every model call costs money, priced per token, with output tokens far more
expensive than input. If you can't sum that across a run, you're flying blind on
the one operational number that scales with usage. AptKit keeps a ledger — it
sums token usage from the trace and estimates dollars. Here's where it sits.

```
  Zoom out — where the cost ledger lives

  ┌─ Studio / replay summary ───────────────────────────────────────┐
  │  renders "1,240 in / 6,100 out · $0.05" per run                  │
  └───────────────────────────────▲──────────────────────────────────┘
                                   │  reads
  ┌─ Runtime: usage-ledger.ts ─────┴──────────────────────────────────┐
  │  ★ summarizeUsage · estimateCost · pricingForModel ★ ←THIS CONCEPT │
  └───────────────────────────────▲──────────────────────────────────┘
                                   │  sums model_usage events
  ┌─ Trace (CapabilityEvent[]) ────┴──────────────────────────────────┐
  │  model_usage { provider, model, inputTokens, outputTokens }        │
  └───────────────────────────────▲──────────────────────────────────┘
                                   │  emitted per model call
  ┌─ Runtime: agent loop / structured gen ─┴───────────────────────────┐
  │  emit model_usage from response.usage (the real counts)            │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: token economics is the discipline of attaching a running cost to LLM
work. AptKit does it by summing `model_usage` trace events into a usage row, then
multiplying by per-million-token pricing. And here's the honest part you have to
hold throughout: **pricing is only wired for OpenAI gpt-4.1.** For Anthropic — and
every other provider — `pricingForModel` returns `undefined`, and the cost shows
as `n/a`. The token counts are real for every provider; the *dollar* number isn't.

## Structure pass

**Layers.** Three: *emission* (each model call emits a `model_usage` event with
real token counts), *aggregation* (`summarizeUsage` folds all events into one
row), *pricing* (`estimateCost` × `pricingForModel` turns tokens into dollars).

**Axis — guarantees: is this number measured, estimated, or missing?** Trace it.
Token counts: **measured** (the provider's `estimated: false` numbers flow through
unchanged). The usage *sum*: measured, as long as every call reported usage. The
dollar cost: **measured-for-OpenAI-gpt-4.1, missing-for-everything-else** — a hard
`undefined` past that one family. The guarantee degrades sharply at the pricing
layer.

**Seam.** The seam is `pricingForModel(provider, modelName)`. On one side, real
token counts that exist for every provider. On the other, a dollar rate that
exists for exactly one provider's one model family. That `undefined` return is the
blind spot — and it's load-bearing because it silently turns "$0.05" into "n/a"
for Anthropic, the repo's *default* provider.

## How it works

You've summed line items into an invoice total: iterate rows, accumulate, multiply
by a rate. The cost ledger is that, with the rate table being the part that's only
half-filled.

### Move 1 — the mental model

A trace is a list of events; some are `model_usage`. The ledger is a fold over
that list (sum the token counts) followed by a rate lookup (tokens → dollars).

```
  The ledger — fold then price

  trace: [ step, tool_call_*, model_usage₁, …, model_usage₂, … ]
                                   │              │
                                   └──────┬───────┘
                                          ▼  summarizeUsage (fold)
                      { inputTokens: Σin, outputTokens: Σout, turns: N }
                                          │
                                          ▼  estimateCost (rate lookup)
                      pricingForModel(provider, model) ─┬─ found  → $ total
                                                        └─ undefined → n/a
```

Two folds in one pass really — token totals *and* a turn count (how many model
calls happened). The pricing step is a pure lookup that can come up empty, and
when it does, the dollar number is honestly absent rather than guessed wrong.

### Move 2 — the step-by-step walkthrough

#### Each model call emits its real usage

When a model call returns, the runtime reads `response.usage` (the provider's
real, `estimated: false` counts) and emits a `model_usage` event carrying the
provider id, model name, and token counts. That event is the ledger's only input.

```
  Emission — one event per model call (pseudocode)

  response = await model.complete(request)
  if response.usage:
    trace.emit({
      type: 'model_usage',
      provider: model.id,                  // 'anthropic' | 'openai' | …
      model:    response.model,            // exact model that answered
      inputTokens:  response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      estimated:    response.usage.estimated   // false for real providers
    })
```

Boundary condition: if a provider returns no usage (OpenAI can, on some calls),
no event is emitted, and that call silently contributes zero to the totals. The
sum is only as complete as the events.

#### summarizeUsage folds the events into one row

`summarizeUsage` reduces the whole trace, ignoring every event that isn't
`model_usage`, accumulating input/output/total tokens, counting turns, and OR-ing
the `estimated` flag (if *any* call was estimated, the whole summary is flagged
estimated).

```
  summarizeUsage — the fold (execution trace)

  start: { in:0, out:0, total:0, turns:0, estimated:false }
  see model_usage{in:1200,out:300} → { in:1200, out:300, total:1500, turns:1, … }
  see step (skip)                   → unchanged
  see model_usage{in:900, out:5800} → { in:2100, out:6100, total:8200, turns:2, … }
  result: 2,100 in / 6,100 out over 2 turns
                       ▲ output dwarfs input — the economics in one line
```

Notice the shape of real numbers: **output tokens run ~5× input here**, which is
typical — a long synthesized answer costs far more than the prompt that asked for
it, and output is also priced higher per token. That asymmetry is *the* lesson of
token economics: the expensive thing is what the model *writes*, not what you
*send*. (`modelTurnCount` is the same count standalone, for traces that lack token
fields — it just counts `model_usage` events.)

#### pricingForModel turns tokens into dollars — for one provider

`estimateCost` looks up a per-million rate and multiplies. The lookup is where the
blind spot lives: it returns a rate *only* for OpenAI gpt-4.1 / mini / nano, and
`undefined` for anything else — including Anthropic, the repo's default.

```
  Pricing — the half-filled rate table (layers-and-hops)

  ┌─ estimateCost ──────┐  pricingForModel(provider, model)  ┌─ rate table ─────┐
  │ in: tokens + names  │ ──────────────────────────────────►│ openai gpt-4.1   │
  │                     │                                     │   → $2 / $8      │
  │                     │◄── rate OR undefined ───────────────│ openai mini/nano │
  └─────────┬───────────┘                                     │ anthropic → ✗    │
            │                                                 │ everything → ✗   │
   rate? ───┤                                                 └──────────────────┘
       found ─► (in/1e6)·inRate + (out/1e6)·outRate = $ total
   undefined ─► return undefined ─► formatCost → "n/a"
```

So a query run on Anthropic (default `claude-sonnet-4-6`) shows real token counts
and `n/a` dollars. The ledger isn't lying — it's declining to print a number it
doesn't have a rate for. `formatCost(undefined)` is literally `'n/a'`.

### Move 3 — the principle

Track cost where the truth lives — at the per-call level, in tokens, summed across
the run — and never fabricate the parts you can't measure. AptKit gets the
measurable half exactly right: real token counts, a clean fold, output-dominates-
input visibility. And it's honest about the unmeasured half: a missing rate yields
`undefined` → `n/a`, not a confident-but-wrong dollar figure. A cost number you
can't trust is worse than no number; the ledger refuses to print one.

## Primary diagram

The full ledger, emission to dollars, with the blind spot marked.

```
  Token economics — the complete ledger

  ┌─ Per model call (agent loop / structured gen) ───────────────────┐
  │  emit model_usage { provider, model, inputTokens, outputTokens,  │
  │                     estimated: false }   ← real provider counts   │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  trace: CapabilityEvent[]
  ┌─ summarizeUsage (fold) ────────▼──────────────────────────────────┐
  │  { inputTokens: Σ, outputTokens: Σ (~5× input), totalTokens,      │
  │    turns, modelName, estimated: OR of all }                       │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  estimateCost(provider, usage, model)
  ┌─ pricingForModel ──────────────▼──────────────────────────────────┐
  │  provider === 'openai' && model startsWith gpt-4.1 → rate         │
  │  ELSE → undefined            ← ANTHROPIC + all others: BLIND SPOT  │
  └───────────────────────────────┬──────────────────────────────────┘
              rate ────────────────┤──────────────── undefined
                  ▼                              ▼
       $ total (estimated: true)        formatCost → "n/a"
```

## Implementation in codebase

**Use cases.** Studio's replay summaries and the replay-summary displays read the
ledger to show per-run token counts and (for OpenAI runs) an estimated dollar
cost. `modelTurnCount` is used where a trace's turn count matters but token fields
may be absent. Every agent run that emits `model_usage` feeds it.

**The fold**, `packages/runtime/src/usage-ledger.ts:25-42`:

```
  packages/runtime/src/usage-ledger.ts  (lines 25-42)

  return trace.reduce((summary, event) => {
    if (event.type !== 'model_usage') return summary;   ← ignore non-usage events
    const inputTokens  = event.inputTokens ?? 0;
    const outputTokens = event.outputTokens ?? 0;
    return {
      inputTokens:  summary.inputTokens  + inputTokens,
      outputTokens: summary.outputTokens + outputTokens,
      totalTokens:  summary.totalTokens  + inputTokens + outputTokens,
      modelName:    event.model || summary.modelName,
      turns:        summary.turns + 1,                  ← count model calls
      estimated:    summary.estimated || event.estimated === true,  ← sticky flag
    };
  }, { inputTokens:0, outputTokens:0, totalTokens:0, modelName:'', turns:0, estimated:false });
       │
       └─ One pass, two aggregates (tokens + turns). The estimated flag is
          OR-ed: one estimated call taints the whole summary as estimated.
```

**The blind spot**, `packages/runtime/src/usage-ledger.ts:71-77`:

```
  packages/runtime/src/usage-ledger.ts  (lines 71-77)

  export function pricingForModel(provider, modelName): UsagePricing | undefined {
    if (provider !== 'openai') return undefined;        ← ANTHROPIC → undefined!
    const normalized = modelName.toLowerCase();
    if (normalized.startsWith('gpt-4.1-nano')) return { in: 0.1, out: 0.4 };
    if (normalized.startsWith('gpt-4.1-mini')) return { in: 0.4, out: 1.6 };
    if (normalized.startsWith('gpt-4.1'))      return { in: 2,   out: 8   };
    return undefined;                                   ← any other model → n/a
  }
       │
       └─ The repo's DEFAULT provider is Anthropic (claude-sonnet-4-6), and
          its cost is unmeasured here. Note out-rate is 4× in-rate for
          gpt-4.1 ($8 vs $2) — the output-dominates-cost asymmetry, priced.
```

**The honest fallback**, `packages/runtime/src/usage-ledger.ts:81-86`:
`formatCost(undefined)` returns `'n/a'`; a real total under a cent renders with 4
decimals (`$0.0042`), otherwise 2 (`$0.05`). No rate → no fabricated number.

## Elaborate

Token economics is the operational reality behind every LLM feature: cost scales
linearly with tokens, and output tokens are priced several times higher than input
(gpt-4.1: $8/M out vs $2/M in). That asymmetry shapes design — it's why the agent
loop truncates tool results to 16k chars
(`../04-agents-and-tool-use/03-react-pattern.md`) and why a synthesis turn that
writes a long answer is the expensive part of a run. The ledger makes that
visible: summed input vs. output, side by side.

The Anthropic blind spot is the kind of honest gap this guide insists on naming.
It's not hard to fix — it's a missing branch in `pricingForModel` — but until it's
filled, the repo's *default* runs show `n/a` for cost, which means the ledger's
dollar number is only meaningful on the OpenAI path. The token counts, crucially,
are correct for every provider; only the rate table is incomplete. That's the
Project Exercise below, and it's a clean one: real published rates, one function,
one test.

This ties directly to observability: the `model_usage` events the ledger sums are
the same events that stream live to Studio (`05-streaming.md`) and get persisted
in replay artifacts for the eval layer (`../05-evals-and-observability/`). One
event format; cost is just one of the questions you ask it.

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case B — Anthropic cost is unmeasured; this fixes the
named blind spot.*

### Exercise — price the Anthropic models

- **Exercise ID:** `[C1.7]` Phase 1, token economics
- **What to build:** Extend `pricingForModel` with Anthropic's published
  per-million rates (Sonnet, Haiku, Opus families), keyed off `provider ===
  'anthropic'` and the model-name prefix, the same way the OpenAI branch works.
  Keep `undefined` for genuinely unknown models.
- **Why it earns its place:** It closes the single most visible gap in the
  foundations layer — the repo's *default* provider currently shows `n/a` cost —
  and proves you can read a published rate card and wire it without breaking the
  measured token half. "I made the default provider's cost measurable" is a crisp
  win.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts`,
  `packages/runtime/test/usage-ledger.test.ts`.
- **Done when:** A test computes a non-`n/a` dollar cost for a
  `claude-sonnet-4-6` usage row, and an unknown model still returns `undefined` →
  `n/a`.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How do you track LLM cost across a run?**
"Fold the trace, then price it. I'd draw it:"

```
  model_usage events ─► summarizeUsage ─► {Σin, Σout, turns}
                                              │
                                              ▼ pricingForModel
                                       rate? $ total : n/a
```

"`summarizeUsage` in `usage-ledger.ts:25` sums the `model_usage` events — real
provider counts, plus a turn count. Then `estimateCost` multiplies by a
per-million rate from `pricingForModel`. Output tokens dominate — gpt-4.1 prices
output at $8/M versus $2/M input — so the cost is mostly what the model writes."
*Anchor: cost lives at the per-call level, in tokens; output is the expensive half.*

**Q: What's the catch in your cost numbers?**
"Pricing is only wired for OpenAI gpt-4.1 — `pricingForModel:72` returns
`undefined` for Anthropic, which is the repo's *default* provider. So
default-provider runs show real token counts but `n/a` dollars. That's
deliberate: a missing rate yields `undefined` → `'n/a'`, not a wrong number. I'd
rather show no cost than a confident-but-fabricated one. Filling the Anthropic
rates is a one-function fix."
*Anchor: refuse to print a cost you can't measure — `n/a` beats wrong.*

## Validate

- **Reconstruct:** Write `summarizeUsage`'s fold — what it skips, what it
  accumulates, how `estimated` propagates. Check
  `packages/runtime/src/usage-ledger.ts:25-42`.
- **Explain:** Why is the `estimated` flag OR-ed rather than set from the last
  event? (One estimated call means the whole summary can't be called exact;
  sticky-true is the conservative choice — `usage-ledger.ts:37`.)
- **Apply:** A run uses `claude-sonnet-4-6` for 3 turns, 2k in / 9k out total.
  What does the cost show? (Real token counts; `pricingForModel('anthropic', …)`
  returns `undefined` → `estimateCost` returns `undefined` → `formatCost` →
  `'n/a'`. `usage-ledger.ts:72`, `:82`.)
- **Defend:** Why return `undefined` for unpriced models instead of $0? ($0 reads
  as "this was free," which is false; `undefined` → `n/a` is "unknown," which is
  true. `usage-ledger.ts:56`, `:82`.)

## See also

- [02-tokenization.md](02-tokenization.md) — the token counts the ledger sums
- [05-streaming.md](05-streaming.md) — the `model_usage` events streaming alongside the run
- [08-provider-abstraction.md](08-provider-abstraction.md) — why provider id is on every usage event
- [../05-evals-and-observability/](../05-evals-and-observability/) — the trace as a persisted, queryable artifact
