# Usage metrics ledger

*Industry name(s): metrics derivation / token accounting / cost attribution. Type label:
Project-specific (the ledger is AptKit's; deriving metrics from an event stream is
standard).*

## Zoom out, then zoom in

You know how you can `reduce` an array of order rows into a single `{ total, count }`
summary without storing the total anywhere — it's computed from the rows on demand? The
usage ledger is exactly that, over the trace: it folds the `model_usage` events into one
tokens-and-cost summary. There's no separate metrics store; the trace *is* the source.

```
  Zoom out — where the ledger lives

  ┌─ Studio UI layer ───────────────────────────────────────────┐
  │  metric tiles: Turns · Tokens · Cost   (AgentReplayShell)    │
  └───────────────────────────────▲──────────────────────────────┘
                                   │  TokenUsageSummary + CostEstimate
  ┌─ Runtime layer (packages/runtime) ──────────────────────────┐
  │  ★ usage-ledger.ts ★  summarizeUsage · estimateCost ·        │ ← we are here
  │                       modelTurnCount · pricingForModel       │
  └───────────────────────────────▲──────────────────────────────┘
                                   │  reads model_usage events
  ┌─ the trace (CapabilityEvent[]) ─────────────────────────────┐
  │  [ model_usage, tool_call_*, step, ... ]                     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **derive metrics by folding the event stream, never instrument
twice.** The only inputs are `model_usage` events; the outputs are a token summary, a
turn count, and a USD cost estimate. The question it answers: *how much did this run cost,
in tokens and dollars, and how many model turns did it take?*

## The structure pass

**Layers.** The *source* (the trace), the *fold* (the ledger functions), and the
*display* (Studio tiles, artifact `modelTurns`, eval report).

**One axis — "where does the number live?"** Trace it:

```
  axis = "where does a metric physically live?"

  ┌─ source: model_usage events ─┐  the ONLY place tokens are stored
  └──────────────┬───────────────┘
                 │  seam: pure fold (summarizeUsage / modelTurnCount)
  ┌─ derived: TokenUsageSummary ─┐  computed on demand, stored nowhere
  └──────────────┬───────────────┘
                 │  seam: pricing lookup (estimateCost)
  ┌─ cost: CostEstimate (USD) ───┐  computed from summary + price table
  └──────────────────────────────┘
```

**The load-bearing seam is the fold itself** — `summarizeUsage` takes a
`readonly CapabilityEvent[]` and returns a value. It's pure: same trace in, same numbers
out, no side effects, no stored aggregate. That purity is why the Studio tile, the
artifact's `modelTurns`, and the CLI report can't drift apart — they all call the same
fold over the same events. The second seam, `pricingForModel`, is where the system
crosses from "facts we measured" (tokens) to "facts we looked up" (price per token), and
it's the leaky one.

## How it works

### Move 1 — the mental model

Filter the trace to `model_usage` events, sum their token fields, count them, then
multiply by a per-token price. Three reduces and a lookup.

```
  The pattern — fold the receipts into a ledger

  trace ──► filter(type === 'model_usage') ──► [ r1, r2, r3 ]
                                                  │
            reduce: sum in+out tokens, count ─────┤
                                                  ▼
            TokenUsageSummary { inputTokens, outputTokens,
                                totalTokens, turns, estimated }
                                                  │
            pricingForModel(provider, model) ─────┤  (lookup, may be undefined)
                                                  ▼
            CostEstimate { inputCost, outputCost, totalCost, USD }
```

### Move 2 — the walkthrough

**`summarizeUsage` — the fold.** It reduces the trace into one summary row, skipping any
event that isn't `model_usage`. For each receipt it adds `inputTokens` and `outputTokens`
(defaulting missing ones to 0), bumps `turns`, carries the latest `model` name, and OR's
in the `estimated` flag. Bridge: `array.reduce` accumulating an order total. What breaks
without it: every consumer would re-implement the same sum, and they'd disagree the
moment one forgot to default a missing token field.

```
  Execution trace — summarizeUsage over the sample artifact's 3 model_usage events

  start  { in:0,  out:0,  total:0,   turns:0, estimated:false }
  r1     in 900,  out 80  → { in:900,  out:80,  total:980,  turns:1 }
  r2     in 760,  out 75  → { in:1660, out:155, total:1815, turns:2 }
  r3     in 1020, out 210 → { in:2680, out:365, total:3045, turns:3 }
  result { inputTokens:2680, outputTokens:365, totalTokens:3045, turns:3 }
```

**`modelTurnCount` — the count without tokens.** A thinner fold: it counts `model_usage`
events regardless of whether token fields are present. Bridge: `array.filter(...).length`.
Why it's separate: a fixture or a provider that doesn't report usage still has *turns* you
can count, even when you can't sum tokens. What breaks without it: the artifact's
`modelTurns` would be wrong (zero) for any run missing token data.

**`estimateCost` — tokens to money.** It looks up a price via `pricingForModel`, and if
found, multiplies `tokens / 1_000_000` by the per-million rate for input and output
separately. Bridge: `quantity × unit_price`, with the unit being "per million tokens."
What breaks without the price: it returns `undefined`, and the display shows `n/a`.

**`pricingForModel` — the lookup, and the leak.** It returns a rate *only* for
`provider === 'openai'` and only for `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`. Everything
else — Anthropic, any other OpenAI model — returns `undefined`. Bridge: a price table with
most rows missing. The boundary condition that bites: an Anthropic run produces real token
counts but `n/a` cost, and the UI can't distinguish "free" from "we don't have the price."
This is red-flag #2 in the audit.

**`formatCost` — the display rule.** Sub-cent costs print with 4 decimals
(`$0.0042`), `undefined` prints `n/a`, exact zero prints `$0.00`. Bridge: currency
formatting with a "we don't know" sentinel.

### Move 2 variant — the load-bearing skeleton

```
  the kernel:  filter to model_usage  →  reduce to a summary  →  price the summary
```

- **Drop the filter** → you'd sum token fields off non-usage events (which don't have
  them) and get garbage; the discriminant is what makes the fold safe.
- **Drop the token-default (`?? 0`)** → one `model_usage` event with a missing
  `inputTokens` turns the whole total into `NaN`. The default is load-bearing precisely
  because providers don't always report usage.
- **Drop the pricing lookup** → no cost, only tokens. The system degrades to token
  accounting, which is still useful.

**Skeleton vs hardening:** the fold + lookup is the skeleton. The `estimated` flag,
`formatCost`'s sub-cent precision, the separate `modelTurnCount` — hardening that makes
the numbers trustworthy and presentable.

### Move 3 — the principle

The principle is **single source of truth for derived numbers.** Because tokens live
*only* in `model_usage` events and every metric is a pure fold over them, there is exactly
one place a token can be counted and exactly one way to count it. No separate counter to
keep in sync, no "the dashboard says X but the report says Y." For a system where the
metric (cost) directly maps to money, that consistency is worth more than the convenience
of a stored aggregate. The cost of the choice: the metrics are only as complete as the
price table, and that table is the one piece that *isn't* derived — it's hand-maintained,
and it's incomplete.

## Primary diagram

The full derivation, one frame.

```
  Usage metrics ledger — from receipts to dollars

  ┌─ the trace ─────────────────────────────────────────────────┐
  │  model_usage(in:900,out:80) ... model_usage(in:1020,out:210) │
  └───────────────┬──────────────────────────────────────────────┘
                  │ filter type==='model_usage'
                  ▼
  ┌─ summarizeUsage (usage-ledger.ts:25-42) ────────────────────┐
  │  TokenUsageSummary { inputTokens, outputTokens, totalTokens,│
  │                      turns, modelName, estimated }          │
  └───────┬───────────────────────────────────┬─────────────────┘
          │ modelTurnCount (:45-47)             │ estimateCost (:50-68)
          ▼                                     ▼
  ┌─ artifact.modelTurns ──┐        ┌─ pricingForModel (:71-78) ──────────┐
  │  (also Studio "Turns") │        │  openai/gpt-4.1* → rate ; else undef │
  └────────────────────────┘        └───────────────┬──────────────────────┘
                                                     ▼
                                     ┌─ CostEstimate (USD) → formatCost → "$0.00"|"n/a"
                                     └───────────────────────────────────────────────┘
   No storage layer: every number is recomputed from the trace on demand.
```

## Implementation in codebase

**Use cases in this repo.** Studio's metric tiles (Turns / Tokens / Cost) call
`summarizeUsage` and `estimateCost` on the visible trace (`AgentReplayShell.tsx:162-164`).
Every `runReplay` stamps `modelTurns: modelTurnCount(trace)` onto the artifact
(`vite.config.ts:568`, `:611`, etc.). The CLI eval report and the promoted-fixture
summaries call the same folds (`vite.config.ts:1003`, `:1049`).

**The fold — `packages/runtime/src/usage-ledger.ts:25-47`:**

```
  usage-ledger.ts — summarizeUsage + modelTurnCount

  :26  return trace.reduce((summary, event) => {
  :28    if (event.type !== 'model_usage') return summary;   ← skip non-receipts
  :29    const inputTokens = event.inputTokens ?? 0;          ← default missing → 0
  :30    const outputTokens = event.outputTokens ?? 0;        ← (load-bearing: no NaN)
  :31    return { inputTokens: summary.inputTokens + inputTokens, ... ,
  :37             turns: summary.turns + 1,                    ← one per receipt
  :38             estimated: summary.estimated || event.estimated === true };  ← sticky
  :41  }, { ...zeros..., turns: 0, estimated: false });

  :45  export function modelTurnCount(trace) {
  :46    return trace.filter((e) => e.type === 'model_usage').length;  ← count, no tokens
  :47  }
        │
        └─ both are PURE folds over the same events. That's why the Studio tile, the
           artifact's modelTurns, and the CLI report cannot disagree.
```

**The pricing leak — `usage-ledger.ts:71-78`:**

```
  pricingForModel — the one non-derived, incomplete piece

  :72  if (provider !== 'openai') return undefined;     ← Anthropic always → no price
  :74  if (normalized.startsWith('gpt-4.1-nano')) return { 0.1, 0.4 };
  :75  if (normalized.startsWith('gpt-4.1-mini')) return { 0.4, 1.6 };
  :76  if (normalized.startsWith('gpt-4.1'))      return { 2, 8 };
  :77  return undefined;                                ← any other model → no price
        │
        └─ a real Anthropic run reports tokens but cost = n/a. The UI can't tell
           "free" from "price unknown" — audit red-flag #2.
```

## Elaborate

Deriving metrics from an event log instead of maintaining counters is the same instinct
behind event-sourcing and behind Prometheus's "expose raw counters, aggregate at query
time." The trade is compute (you re-fold the trace every time) for correctness (no
counter to drift). At toolkit scale the trace is tiny — a handful of events — so the
re-fold is free, and the consistency is pure upside.

The pricing table is the seam where this clean derivation meets the messy real world.
Token counts are *measured* (the provider reports them, or the system estimates with the
`estimated` flag); prices are *looked up* against a table someone has to maintain as
vendors change pricing. The incompleteness (OpenAI-only, `gpt-4.1`-only) is a maintenance
gap, not a design flaw — but the design *hides* it, because `undefined` cost looks like
absent cost. The fix is small and named in the audit: add Anthropic rows and surface
"pricing unknown" distinctly. Read `study-performance-engineering` for the budget/latency
framing of these same numbers; this guide treats them as diagnostic signals only.

## Interview defense

**Q: Why derive token totals from the trace instead of keeping a running counter?**
Because the trace is already the single source of truth — tokens live only on
`model_usage` events. A pure fold means the dashboard, the artifact, and the CLI report
can't disagree; a counter would be a second thing to keep in sync. The cost is recomputing
on each read, which is free at this scale.

```
  running counter            derived fold
  count += tokens (mutated)  summarizeUsage(trace)  (recomputed, no state)
  can drift from trace       provably equals the trace
```

Anchor: `usage-ledger.ts:25-47`.

**Q: An Anthropic run shows cost `n/a`. Bug or expected?**
Expected given the code, but a real gap. `pricingForModel` returns `undefined` for any
non-OpenAI provider (`:72`), so cost can't be computed and `formatCost` prints `n/a`. The
deeper problem is the UI can't distinguish "we don't have the price" from "$0.00." Fix: add
Anthropic pricing and a distinct "pricing unknown" state. Anchor: `:71-86`.

**Q: What's the one line that prevents the token total from becoming NaN, and why is it
load-bearing?**
The `?? 0` defaults at `:29-30`. Providers don't always report usage; one `model_usage`
event with a missing `inputTokens` would poison the entire reduce with `NaN` without the
default. It's the kind of guard that looks incidental and is actually load-bearing.

## Validate

1. **Reconstruct:** write the `summarizeUsage` reduce from memory — the filter, the
   token defaults, the turn bump, the sticky `estimated` flag. Check against
   `usage-ledger.ts:25-42`.
2. **Explain:** why are `summarizeUsage` and `modelTurnCount` two functions instead of
   one (`usage-ledger.ts:45-47`)? What case needs turns without tokens?
3. **Apply to a scenario:** a run against `anthropic` shows 3 turns and 3045 tokens but
   `$ n/a`. Trace why through `estimateCost` → `pricingForModel` (`:50-78`) and name the
   one-line fix.
4. **Defend the decision:** argue why deriving metrics from the trace is the right call
   for this repo, and name the one piece of the ledger that *isn't* derived and is
   therefore the weak point.

## See also

- `01-structured-trace-events.md` — the `model_usage` event this folds over.
- `02-replay-artifact-as-snapshot.md` — `modelTurns` stamped onto the artifact.
- `04-live-trace-stream.md` — the live metric tiles fed by the same fold.
- `study-performance-engineering` — these numbers as cost/latency budgets.
