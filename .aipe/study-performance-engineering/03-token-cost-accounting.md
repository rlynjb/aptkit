# Token cost accounting

**Industry name:** token usage metering / LLM cost accounting · **Type:** Industry standard (LLM systems)

The one piece of performance telemetry the repo actually wires: turning per-turn token counts into a summed, priced, provider-neutral ledger.

---

## Zoom out, then zoom in

For an LLM system the dominant variable cost is tokens — input you send, output you get back, per model, per call. Everything else (CPU, the linear scan) is rounding error next to the API bill. This is the one cost axis the repo measures end-to-end: the loop emits a usage event per turn, and a ledger sums and prices them.

```
  Zoom out — where the meter lives

  ┌─ Runtime loop ────────────────────────────────────────────┐
  │  runAgentLoop: each turn emits ↓                           │
  │     trace.emit({ type:'model_usage', inputTokens, ... })  │ ← the meter reading
  └───────────────────────────┬───────────────────────────────┘
                              │ CapabilityEvent[] (NDJSON trace)
  ┌─ Ledger layer ────────────▼───────────────────────────────┐
  │  ★ summarizeUsage(trace) → estimateCost(provider, model) ★ │ ← we are here
  └───────────────────────────┬───────────────────────────────┘
                              │ CostEstimate
  ┌─ Display layer ───────────▼───────────────────────────────┐
  │  formatCost() → Studio panel / replay summary             │
  └────────────────────────────────────────────────────────────┘
```

The reading is taken inside the loop; the accounting lives in `packages/runtime/src/usage-ledger.ts`. The pattern is: meter at the source (per turn), aggregate provider-neutrally (sum a trace), price at the edge (look up per-model rates).

## The structure pass

Trace **the cost axis — "how is one run's dollar cost computed?"** across the three layers.

```
  Axis: "what is this run's token cost?" — across the meter → ledger seam

  ┌─ loop ──────────────────┐  seam   ┌─ ledger ─────────────────────┐
  │ raw counts per turn:     │ ══╪══►  │ summed counts + price lookup  │
  │ inputTokens/outputTokens │ (flips) │ → USD                         │
  │ tied to ONE provider     │         │ provider-neutral (reduce over │
  │                          │         │ trace, then price by name)    │
  └──────────────────────────┘         └───────────────────────────────┘
```

- **Layers:** loop emits raw per-turn counts → ledger sums them into a `TokenUsageSummary` → `estimateCost` prices by provider/model name.
- **Axis:** dollar cost. It is a *raw count* at the loop, an *aggregate* at the ledger, a *price* at the edge.
- **Seam:** the `CapabilityEvent` trace (`model_usage` event). The loop emits without knowing how it's aggregated; the ledger sums without knowing which provider produced it. The provider-coupling flips to provider-neutral across that seam.

## How it works

#### Move 1 — the mental model

You know how a `reduce` collapses an array of rows into one total. The ledger is exactly that — `trace.reduce(...)` over the event stream, picking out the `model_usage` rows and summing their token fields. The only twist is that pricing is a *separate* step keyed by model name, because the same token count costs different money on different models.

```
  Pattern — meter → reduce → price

  trace: [step, model_usage(in=1200,out=300),
                tool_call_end, model_usage(in=1500,out=250), ...]
              │
              │ reduce: keep only model_usage, sum tokens, count turns
              ▼
  TokenUsageSummary { inputTokens: 2700, outputTokens: 550, turns: 2 }
              │
              │ estimateCost(provider, model): look up $/M-token rate
              ▼
  CostEstimate { inputCost, outputCost, totalCost, estimated: true }
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — meter at the source.** Every turn that returns usage emits one `model_usage` event with the raw counts. This is the reading; it happens inside the loop, once per round-trip:

```ts
// packages/runtime/src/run-agent-loop.ts:111-122
if (response.usage) {
  trace?.emit({
    type: 'model_usage',
    capabilityId,
    provider: model.id,                               // ← which provider produced it
    model: response.model ?? model.defaultModel ?? 'unknown',
    inputTokens: response.usage.inputTokens,           // ← the meter reading
    outputTokens: response.usage.outputTokens,
    estimated: response.usage.estimated,               // ← did the PROVIDER count, or did we guess?
    timestamp: timestamp(),
  });
}
```

The `estimated` flag is the honest part: if the provider reported real token counts, it is `false`; if aptkit had to approximate (a provider that does not return usage), it is `true`. That flag rides all the way through to the final summary.

**Step 2 — aggregate provider-neutrally.** `summarizeUsage` reduces the whole trace into one row. It does not care which provider, which agent, or how many tools ran — it sums every `model_usage` event:

```ts
// packages/runtime/src/usage-ledger.ts:25-42
export function summarizeUsage(trace: readonly CapabilityEvent[]): TokenUsageSummary {
  return trace.reduce<TokenUsageSummary>((summary, event) => {
    if (event.type !== 'model_usage') return summary;          // ← ignore everything else
    const inputTokens = event.inputTokens ?? 0;
    const outputTokens = event.outputTokens ?? 0;
    return {
      inputTokens:  summary.inputTokens  + inputTokens,
      outputTokens: summary.outputTokens + outputTokens,
      totalTokens:  summary.totalTokens  + inputTokens + outputTokens,
      modelName: event.model || summary.modelName,
      turns: summary.turns + 1,                                 // ← turns = count of usage events
      estimated: summary.estimated || event.estimated === true, // ← sticky: one estimate taints all
    };
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '', turns: 0, estimated: false });
}
```

Note `turns` is derived by counting `model_usage` events — the same count `02-bounded-loop-cost-ceiling.md`'s ceiling bounds. The ledger and the loop ceiling are looking at the same number from two ends: the loop *caps* it, the ledger *reports* it.

**Step 3 — price at the edge.** `estimateCost` converts tokens to dollars via a per-model rate table:

```ts
// packages/runtime/src/usage-ledger.ts:50-78
export function estimateCost(provider, usage, modelName): CostEstimate | undefined {
  const pricing = pricingForModel(provider, modelName);
  if (!pricing) return undefined;                              // ← unknown model → no estimate
  const inputCost  = (usage.inputTokens  / 1_000_000) * pricing.inputUsdPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return { currency: 'USD', inputCost, outputCost,
           totalCost: inputCost + outputCost, ...pricing, estimated: true };
}
// pricingForModel only knows openai gpt-4.1 family (lines 71-78)
```

**Where it breaks — the pricing table is a stub.** `pricingForModel` returns `undefined` for any provider that is not `openai`, and only knows the `gpt-4.1` family. So a run on Anthropic (`claude-sonnet-4-6`, the repo default) or local Gemma gets **no cost estimate** — `estimateCost` returns `undefined` and the display falls back to `'n/a'` (`formatCost`, line 81-86). The *metering* is complete (token counts flow for every provider); the *pricing* covers one provider. That is the honest gap: usage is fully accounted, cost is only priced for OpenAI. Adding Anthropic pricing is one entry in `pricingForModel` — the seam is built, the table is just short.

#### Move 3 — the principle

Meter the dominant cost at its source, aggregate it provider-neutrally, and price it at the edge where vendor specifics live. The split matters: counting tokens (mechanism) and pricing them (policy) are different concerns, so a missing price never breaks the count. This repo gets the *measurement* right end-to-end and leaves the *pricing table* partial — which is the correct failure mode, because a wrong price is worse than a missing one, and an accurate token count is useful even with no dollar figure attached.

## Primary diagram

```
  Token cost accounting — full picture

  ┌─ runAgentLoop (per turn) ─────────────────────────────────────┐
  │  await model.complete() → response.usage                       │
  │  emit model_usage { provider, model, inTok, outTok, estimated }│ ← METER
  └───────────────────────────┬────────────────────────────────────┘
                              │  CapabilityEvent[] trace (NDJSON)
  ┌─ usage-ledger ────────────▼────────────────────────────────────┐
  │  summarizeUsage(trace)  = reduce, keep model_usage, sum         │ ← AGGREGATE
  │     → { inputTokens, outputTokens, turns, estimated }           │   (provider-neutral)
  │  estimateCost(provider, usage, model)                           │ ← PRICE
  │     → pricingForModel(): openai gpt-4.1 ONLY  (else undefined)  │   (vendor-specific, partial)
  │  formatCost() → "$0.0042" | "$0.00" | "n/a"                     │ ← DISPLAY
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

Token accounting is the bedrock observability primitive for any LLM product — it is the per-request cost meter, and without it you cannot set a budget, catch a prompt that doubled its input tokens, or attribute spend to a capability. The `estimated` flag is the mark of an honest implementation: it refuses to claim a real count it had to guess at. The partial pricing table is a known, named limitation (`audit.md` notes OpenAI-only pricing), not a hidden bug — and it is the kind of gap that is one PR away from closed.

This is the only fully-wired *measurement* in the repo. Everything else in `audit.md` is `not yet exercised`. If you wanted to seed the missing latency baseline (`audit.md` red flag #2), this ledger is the template: it already proves the trace stream can carry a measured number from the loop to a summary.

## Interview defense

**Q: How do you track LLM cost in this system?**
The loop emits a `model_usage` trace event per turn with raw input/output token counts and an `estimated` flag. `summarizeUsage` reduces the trace into one provider-neutral total; `estimateCost` prices it by model name. The split means a missing price never breaks the count.

```
  per turn → model_usage(inTok, outTok)
       │ reduce over trace
       ▼
  summary { inputTokens, outputTokens, turns, estimated }
       │ price by model name
       ▼
  CostEstimate (USD)   — or undefined for unpriced models
```
Anchor: "meter at the source, sum neutrally, price at the edge."

**Q: What's incomplete about it?**
The pricing table. `pricingForModel` only knows the OpenAI gpt-4.1 family — Anthropic and Gemma runs get no dollar estimate, just `n/a`. But metering is complete for every provider; only pricing is partial. That's the right failure mode: an accurate token count with no price beats a wrong price.

Anchor: "usage fully metered, cost priced for one provider — the table's short, not the meter."

## See also

- `02-bounded-loop-cost-ceiling.md` — the loop that emits the usage events; same turn-count from the other end
- `audit.md` — Lens 2 (this is the one real instrumentation), Lens 8 (red flag #2, no latency baseline)
- `study-ai-engineering` — token budgets, prompt-size cost, eval scoring
- `study-debugging-observability` — the trace-event stream this rides on
