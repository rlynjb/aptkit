# Token-Cost Ledger

*Industry names: usage accounting, token metering, cost attribution,
spend instrument. Type: Industry standard (LLM cost measurement).*

## Zoom out, then zoom in

You can't manage a cost you can't see. For an LLM system the cost is
tokens, and the only place tokens are reported is in the provider's
response. This pattern catches that report at the source (the loop),
sums it, and converts it to dollars.

```
  Zoom out — where the ledger sits

  ┌─ Provider layer ───────────────────────────────────┐
  │  model.complete() → response.usage {input, output} │ ← tokens born here
  └──────────────────────────┬──────────────────────────┘
                            │  emit model_usage event per turn
  ┌─ Runtime layer ─────────▼───────────────────────────┐
  │  ★ usage-ledger ★  summarizeUsage → estimateCost    │ ← we are here
  └──────────────────────────┬──────────────────────────┘
                            │  usage + costEstimate per run
  ┌─ UI / report layer ─────▼───────────────────────────┐
  │  Studio replay list, CLI summary  → formatCost      │
  └──────────────────────────────────────────────────────┘
```

Zoom in: it's a `reduce` over trace events that produces one summary
row — total tokens, turn count, an "is this estimated?" flag — and a
pricing lookup that turns that row into USD. The whole thing is the
budget-vs-baseline instrument: it's how you know whether a prompt change
made a run cheaper.

## The structure pass

**Layers:** provider (emits raw token counts) → runtime ledger (sums and
prices) → report surface (formats).

**Axis — trust in the number:** how trustworthy is the cost figure as you
move down the layers? Trace it and watch where confidence drops.

```
  One axis — "how trustworthy is the cost number?" — down the layers

  ┌─ Provider ──────────────────────────────┐
  │ Anthropic: real tokens (estimated:false)│ → high trust in TOKENS
  │ local guard: length/3 estimate          │ → low trust (heuristic)
  └────────────────┬─────────────────────────┘
       seam: tokens → dollars (needs a price table)
  ┌─ Ledger ───────▼─────────────────────────┐
  │ pricingForModel: openai gpt-4.1-* only   │ → DOLLARS trustworthy
  │ everything else → undefined              │   ONLY for one family
  └────────────────┬─────────────────────────┘
       seam: undefined cost → "n/a" string
  ┌─ Report ───────▼─────────────────────────┐
  │ formatCost(undefined) = "n/a"            │ → honest about the gap
  └──────────────────────────────────────────┘
```

**The seam that matters:** the tokens→dollars conversion in
`pricingForModel`. Tokens are trustworthy (the provider reports them);
dollars are only trustworthy for the one model family in the price table.
That seam is exactly where the repo's biggest measurement gap lives —
the default provider (Anthropic) crosses it and comes out as `n/a`.

## How it works

You know how a shopping cart sums line items into a subtotal, then
applies a tax rate to get a total? The ledger is that, for an agent run:
each model turn is a line item (input tokens, output tokens), the
summary is the subtotal, and the per-million-token price is the rate.
The wrinkle is that the "tax rate" only exists for some products — for
the rest, the total is honestly blank rather than wrong.

### Move 1 — the mental model: fold events → row → dollars

```
  The pipeline — three transforms

  [model_usage, model_usage, ...]   ← N trace events (one per turn)
            │  summarizeUsage (reduce)
            ▼
  { inputTokens, outputTokens, totalTokens, turns, estimated }  ← one row
            │  estimateCost (price lookup × tokens)
            ▼
  { inputCost, outputCost, totalCost }  OR  undefined  ← dollars (or honest gap)
            │  formatCost
            ▼
  "$0.0042"  OR  "n/a"
```

### Move 2 — the step-by-step walkthrough

**The line item: the `model_usage` event.** Every turn, the loop reads
`response.usage` and emits a `model_usage` trace event with
`inputTokens`, `outputTokens`, and an `estimated` flag. Bridge from what
you know: it's like logging one row per DB query with its row-count — you
emit the measurement at the exact point the work happened, so nothing has
to reconstruct it later. The `estimated` flag is the honesty bit: if the
provider gave real counts it's `false`; if something guessed (e.g. a
provider that didn't return usage), it's `true`.

```
  One turn → one line item

  turn k:  complete() → response.usage = { inputTokens: 1820, outputTokens: 240 }
                                    │
                                    ▼ emit
           model_usage { inputTokens: 1820, outputTokens: 240, estimated: false }
```

**The subtotal: `summarizeUsage` folds the events.** A `reduce` walks
the trace, skips every non-`model_usage` event, and accumulates input,
output, total, turn count, and a sticky `estimated` flag (once any turn
is estimated, the whole summary is flagged estimated). Drop this and you
have raw events but no run-level number to compare against a baseline —
the fold is what makes "this run cost X tokens" a single value.

```
  Execution trace — summarizeUsage over 3 turns

  start:           { in:0,    out:0,  turns:0, estimated:false }
  + turn0 (1820/240): { in:1820, out:240, turns:1, estimated:false }
  + turn1 (1500/180): { in:3320, out:420, turns:2, estimated:false }
  + turn2 (900/310):  { in:4220, out:730, turns:3, estimated:false }
                       └─ total = 4950 tokens, 3 billed turns
```

**The rate lookup: `pricingForModel`.** Given a provider and model name,
return per-million-token input/output prices — or `undefined` if unknown.
Here's the blunt part: it returns `undefined` for *every* provider that
isn't `'openai'`, and within OpenAI only the `gpt-4.1-*` family is priced.
The repo's default model is `claude-sonnet-4-6`. So the default run's
cost lookup returns `undefined`. This is the load-bearing gap: the
instrument works perfectly except at the one spot it's used most.

```
  pricingForModel — the rate table (and its hole)

  provider != 'openai'        → undefined   ◄── Anthropic (the DEFAULT) lands here
  'gpt-4.1-nano'              → 0.10 / 0.40
  'gpt-4.1-mini'             → 0.40 / 1.60
  'gpt-4.1'                  → 2.00 / 8.00
  anything else              → undefined
```

**The total + format: `estimateCost` → `formatCost`.** `estimateCost`
multiplies tokens by the per-million rate (`tokens / 1e6 × price`); if
the rate is `undefined`, it returns `undefined`. `formatCost` turns a
present estimate into `$0.0042` (4 decimals under a cent, 2 above) and a
missing one into the literal string `'n/a'`. The `n/a` is the honest
move — it tells you "I measured tokens but I don't know the price," which
is true, rather than printing a fake `$0.00`.

```
  estimateCost(provider, usage, model)
     pricing = pricingForModel(...)
     if !pricing → return undefined            ◄── Anthropic path
     inputCost  = inputTokens  / 1e6 × inPrice
     outputCost = outputTokens / 1e6 × outPrice
     total = inputCost + outputCost

  formatCost(undefined) = "n/a"   ◄── the gap, surfaced honestly
```

### Move 3 — the principle

**Measure at the source, sum at the boundary, and be honest where the
number is unknown.** The ledger gets the first two right — tokens are
captured the instant they're reported and folded into one row. The third
is half-done: it's honest (`n/a` rather than a fake number), but the gap
is at the default provider, so the instrument is blind exactly where it's
needed. The general lesson: a cost instrument with a hole at the default
configuration is barely an instrument — close the hole first.

## Primary diagram

The full ledger, from token birth to formatted cost, with the gap marked.

```
  Token-cost ledger — full recap

  ┌─ Provider ────────────────────────────────────────────────┐
  │ Anthropic → real tokens, estimated:false                  │
  │ OpenAI    → real tokens, estimated:false                  │
  └───────────────────────────────┬────────────────────────────┘
                                  │ runAgentLoop emits one model_usage
                                  ▼ event per turn
  ┌─ Runtime: usage-ledger ───────────────────────────────────┐
  │ summarizeUsage(trace)  → { in, out, total, turns, est }   │
  │ estimateCost(provider, usage, model)                      │
  │    └─ pricingForModel: openai gpt-4.1-* ✓ | else undefined │
  │       └─ ANTHROPIC (default) → undefined  ◄── the gap      │
  └───────────────────────────────┬────────────────────────────┘
                                  ▼
  ┌─ Report (Studio replay list / CLI) ───────────────────────┐
  │ formatCost → "$0.0042"  |  "n/a" (when price unknown)     │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** The Studio replay list shows per-artifact `usage` and
`costEstimate` so you can compare two runs (`vite.config.ts:954-979`).
Promoted-fixture summaries compute usage and cost for every promoted
fixture (`vite.config.ts:1003-1008` and siblings). `modelTurnCount` is
stamped on every replay summary as the cheap "how many round-trips"
metric even when token fields are absent.

**Code — the fold, `packages/runtime/src/usage-ledger.ts:25-42`:**

```
return trace.reduce<TokenUsageSummary>(
  (summary, event) => {
    if (event.type !== 'model_usage') return summary;   ← only count usage events
    const inputTokens = event.inputTokens ?? 0;
    const outputTokens = event.outputTokens ?? 0;
    return {
      inputTokens:  summary.inputTokens  + inputTokens,
      outputTokens: summary.outputTokens + outputTokens,
      totalTokens:  summary.totalTokens  + inputTokens + outputTokens,
      modelName: event.model || summary.modelName,
      turns: summary.turns + 1,                          ← one turn per usage event
      estimated: summary.estimated || event.estimated === true,  ← sticky honesty flag
    };
  },
  { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '', turns: 0, estimated: false },
);
```

**Code — the rate table and its hole,
`packages/runtime/src/usage-ledger.ts:71-78`:**

```
export function pricingForModel(provider: string, modelName: string): UsagePricing | undefined {
  if (provider !== 'openai') return undefined;            ← ANTHROPIC (default) exits here
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.startsWith('gpt-4.1'))      return { inputUsdPerMillion: 2,   outputUsdPerMillion: 8 };
  return undefined;
       │
       └─ the repo default is claude-sonnet-4-6 → cost is "n/a" for every default run.
          The move: add an anthropic branch with claude pricing. Low effort, high signal.
}
```

**Code — honest formatting, `packages/runtime/src/usage-ledger.ts:81-86`:**

```
export function formatCost(costEstimate: CostEstimate | undefined): string {
  if (!costEstimate) return 'n/a';                       ← honest gap, not a fake $0.00
  if (costEstimate.totalCost === 0) return '$0.00';
  if (costEstimate.totalCost < 0.01) return `$${costEstimate.totalCost.toFixed(4)}`;  ← sub-cent precision
  return `$${costEstimate.totalCost.toFixed(2)}`;
}
```

## Elaborate

Token metering is the table-stakes instrument for any production LLM
system — without it you're flying blind on the line item that scales with
usage. The interesting design choice here is the `estimated` flag and the
`n/a` fallback: the ledger never lies about precision. The weakness is
scope, not honesty — the price table covers one OpenAI family while the
default provider is Anthropic, which reports real tokens (`estimated:
false`) but gets no dollar figure. Closing that is a few lines in
`pricingForModel`. This pairs with the turn budget
(**01-turn-and-tool-budget.md**) — the budget caps spend *before* a run,
the ledger measures spend *after*. For the trace events as a general
observability surface, see **study-debugging-observability**; for
provider economics at the system level, **study-ai-engineering**.

## Interview defense

**Q: How do you know what an agent run cost?**

Each model turn emits a usage event with input/output tokens; I fold
them into one row with a `reduce`, then multiply by a per-million-token
price. The key detail is honesty about precision — a sticky `estimated`
flag, and `n/a` rather than a fake `$0` when I don't have a price for
that model.

```
  events → reduce → { in, out, turns, estimated } → × price → $  | n/a
```

Anchor: `usage-ledger.ts:25-42`, `:81-86`.

**Q: What's broken about it today?**

The price table only covers OpenAI `gpt-4.1-*`, but the default provider
is Anthropic. So the default run reports real tokens but prints `n/a` for
cost — the instrument is blind at the most-used configuration. The fix is
an Anthropic pricing branch in `pricingForModel`.

Anchor: `usage-ledger.ts:71-77`.

## Validate

1. **Reconstruct:** write `summarizeUsage`'s reducer from memory —
   what does it skip, what does it sum, and why is `estimated` sticky?
   Check `usage-ledger.ts:25-42`.
2. **Explain:** why is printing `n/a` better than `$0.00` when the price
   is unknown? (`$0.00` is a wrong number; `n/a` is a true statement
   about missing data.)
3. **Apply:** a run on `claude-sonnet-4-6` reports 4950 tokens over 3
   turns. What does `formatCost` print today, and what one change fixes
   it? (`n/a`; add an anthropic branch to `pricingForModel`,
   `:71`.)
4. **Defend:** is it acceptable to ship a cost instrument that returns
   `n/a` for the default model? Argue both sides, then take the call.
   (No — close the gap first; the instrument's whole job is the default
   path.)

## See also

- **01-turn-and-tool-budget.md** — capping spend before the run.
- **03-context-window-preflight-guard.md** — the other place a
  length/3 token estimate appears.
- **audit.md** — lens 2 (measurement) and red flag #2 (Anthropic n/a).
- **study-debugging-observability** — the trace events as observability.
- **study-ai-engineering** — cost of serving at the system level.
