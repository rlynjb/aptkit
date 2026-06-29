# Token economics — what the trace costs in dollars

**Subtitle:** the usage ledger · tokens → USD · *Industry standard*

## Zoom out, then zoom in

Before you can answer "what did that run cost," see where the money math lives:
it reads the same trace events Studio shows, sums the tokens, and only sometimes
maps them to dollars.

```
  Zoom out — where cost is computed

  ┌─ Studio / replay summary ───────────────────────────────────┐
  │  shows tokens used and (when known) a USD estimate          │
  └───────────────────────────▲─────────────────────────────────┘
                              │ summarizeUsage / estimateCost
  ┌─ Runtime ─────────────────┴─────────────────────────────────┐
  │  ★ usage-ledger ★  sum model_usage events → tokens → $?     │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ model_usage events on the trace
  ┌─ Providers ───────────────▼─────────────────────────────────┐
  │  each complete() reports inputTokens/outputTokens in usage  │
  └──────────────────────────────────────────────────────────────┘
```

The model bills you per token, split into input (what you sent) and output (what
it wrote), at different per-million rates. aptkit's ledger reads the trace,
sums every `model_usage` event into a total, and then *tries* to price it. The
catch you must say out loud: pricing exists only for OpenAI's gpt-4.1 family.
Local Gemma is free (no price, returns undefined), and Anthropic pricing is a
real gap — `not yet exercised`.

## Structure pass

**Layers.** Provider (reports tokens) → trace (`model_usage` events) →
`summarizeUsage` (tokens total) → `estimateCost` (USD, maybe) → display
(`formatCost`).

**Axis — cost.** Trace the dollar signal. The provider knows tokens but not price.
`summarizeUsage` knows the token total but not price. `estimateCost` is the only
place price exists — and it only succeeds for `provider === 'openai'`. Everywhere
else the cost is `undefined`, which `formatCost` renders as `n/a`.

**Seam.** The flip is `pricingForModel`. Above it you have tokens (universal,
always available). Below it you have dollars (vendor-specific, mostly missing).
Tokens are the honest universal currency; USD is a privilege only one provider
currently enjoys.

## How it works

### Move 1 — the mental model

You know a request log where you `reduce` rows into a total — total bytes, total
latency? The usage ledger is that, over `model_usage` events, summing tokens.
Pricing is a second, optional step: a lookup table from (provider, model) to a
rate, applied to the total.

```
  reduce(events) → total, then optional price lookup

  [event, event, event] ──reduce──► { inputTokens, outputTokens, turns }
                                            │
                                  pricingForModel(provider, model)?
                                    found ──► × rate ──► USD
                                    none  ──► undefined ──► "n/a"
```

### Move 2 — the moving parts

**Summing the trace into a token total.** `summarizeUsage` folds every
`model_usage` event into one row — input, output, total, turn count, and whether
any count was estimated. From `packages/runtime/src/usage-ledger.ts:25`:

```ts
export function summarizeUsage(trace: readonly CapabilityEvent[]): TokenUsageSummary {
  return trace.reduce((summary, event) => {
    if (event.type !== 'model_usage') return summary;            // ← only usage events count
    const inputTokens = event.inputTokens ?? 0;
    const outputTokens = event.outputTokens ?? 0;
    return {
      inputTokens: summary.inputTokens + inputTokens,
      outputTokens: summary.outputTokens + outputTokens,
      totalTokens: summary.totalTokens + inputTokens + outputTokens,
      turns: summary.turns + 1,                                  // ← one turn per model call
      estimated: summary.estimated || event.estimated === true,  // ← sticky: any guess taints total
    };
  }, /* zero row */);
}
```

```
  summarizeUsage fold

  model_usage(in:120,out:40) ─┐
  model_usage(in:300,out:80) ─┼─► total: in:420 out:120 total:540 turns:2
  step/tool_call (ignored)  ─┘    estimated: true if ANY turn was estimated
```

**Pricing — and the cliff.** `estimateCost` looks up a rate and multiplies. But
`pricingForModel` short-circuits on the very first line for anything that isn't
OpenAI. From `packages/runtime/src/usage-ledger.ts:71`:

```ts
export function pricingForModel(provider: string, modelName: string): UsagePricing | undefined {
  if (provider !== 'openai') return undefined;                 // ← Gemma & Anthropic exit HERE
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.startsWith('gpt-4.1'))      return { inputUsdPerMillion: 2,   outputUsdPerMillion: 8 };
  return undefined;
}
```

```
  pricingForModel coverage

  provider = openai  ──► gpt-4.1      $2 / $8  per M (in/out)
                         gpt-4.1-mini $0.4 / $1.6
                         gpt-4.1-nano $0.1 / $0.4
  provider = gemma   ──► undefined  (LOCAL = FREE)
  provider = anthropic ► undefined  (GAP — not yet exercised)
```

**Rendering the result honestly.** `formatCost` turns the estimate (or its
absence) into a string. Undefined becomes `n/a`, zero becomes `$0.00`, tiny
amounts get four decimals. From `usage-ledger.ts:81`:

```ts
export function formatCost(costEstimate: CostEstimate | undefined): string {
  if (!costEstimate) return 'n/a';                              // ← Gemma/Anthropic land here
  if (costEstimate.totalCost === 0) return '$0.00';
  if (costEstimate.totalCost < 0.01) return `$${costEstimate.totalCost.toFixed(4)}`;
  return `$${costEstimate.totalCost.toFixed(2)}`;
}
```

```
  formatCost

  undefined ─► "n/a"        (no pricing table)
  0         ─► "$0.00"
  < 0.01    ─► "$0.0042"    (sub-cent precision)
  else      ─► "$1.23"
```

### Move 3 — the principle

Count in the universal unit (tokens) always; convert to the vendor unit (dollars)
only where you have a rate, and degrade to `n/a` honestly when you don't. Token
counts are an invariant you can always trust; cost is a derived, partial view.
Running on local Gemma makes the marginal dollar cost genuinely zero — the
economics question becomes latency and hardware, not API spend.

## Primary diagram

```
  From trace to dollars (or n/a)

  trace events                 usage-ledger                       display
  ┌──────────────┐ filter      ┌──────────────────────────┐       ┌────────┐
  │ model_usage  │ ──model_───►│ summarizeUsage → tokens  │       │ "540   │
  │ model_usage  │   usage     │ estimateCost:            │ ────► │  tok"  │
  │ step/tool…   │             │   openai → × rate → USD  │       │ "$0.01"│
  └──────────────┘             │   gemma/anthropic → undef│       │ or n/a │
                               └──────────────────────────┘       └────────┘
   tokens: always   │   USD: openai only — Gemma free, Anthropic a known gap
```

## Elaborate

The split-rate model (output usually 3–4× input price) is industry-wide, which is
why output length is the lever that moves cost most. aptkit's OpenAI-only pricing
table is a deliberate scoping decision recorded as a gap in the project's
context.md — Anthropic pricing should be added before any Claude-backed run can
report cost. The `estimated` flag matters here too: a cost built on estimated
token counts (see `02-tokenization.md`) is itself an estimate of an estimate. Read
`02-tokenization.md` for where token counts come from, and `08-provider-
abstraction.md` for the provider id that drives the pricing lookup.

## Project exercises

### Add Anthropic pricing to close the gap
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend `pricingForModel` to return rates for the claude-
  sonnet family when `provider === 'anthropic'`, plus tests asserting a non-zero
  `estimateCost` for an Anthropic-tagged usage summary.
- **Why it earns its place:** turns a documented gap into working code and forces
  you to reason about per-million input/output rates — real cost-engineering work.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts`,
  `packages/runtime/test/usage-ledger.test.ts`.
- **Done when:** an anthropic usage summary returns a defined `CostEstimate` and
  `formatCost` renders dollars, not `n/a`.
- **Estimated effort:** `1–4hr`

### Add a per-run cost cap warning
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a helper that takes a trace + a USD ceiling and emits a
  `warning` CapabilityEvent when `estimateCost` exceeds it (skipping when cost is
  `undefined`).
- **Why it earns its place:** budgets are how cost engineering shows up in
  production; this wires the ledger into the existing event stream.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts` (or a sibling),
  matching `test/`.
- **Done when:** a trace over budget emits exactly one warning; a free Gemma trace
  emits none.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "What did that Gemma run cost?"**
Nothing in dollars — `estimateCost` returns `undefined` for any non-OpenAI
provider, so `formatCost` shows `n/a`. The real cost of local Gemma is latency and
hardware, not API spend. We still track tokens; price is just unmapped.

```
  gemma usage → summarizeUsage → tokens ✓ → estimateCost → undefined → "n/a"
```
Anchor: *tokens are always counted; dollars exist only for OpenAI today.*

**Q: "Why count tokens if you can't always price them?"**
Tokens are the universal, vendor-neutral unit — context limits, latency, and any
future pricing all derive from them. Pricing is a thin, swappable lookup on top;
the token total is the durable signal.

```
  tokens (universal, always)  ──► pricing table (per-provider, optional) ──► USD
```
Anchor: *count in tokens, convert to dollars only where you have a rate.*

## See also

- `02-tokenization.md` — where the token counts in `usage` come from
- `08-provider-abstraction.md` — the provider id that selects (or fails) pricing
- `05-streaming.md` — `model_usage`, the event the ledger sums
