# Model-usage accounting — tokens and cost from the trace

*Industry names: usage metering · cost attribution · token accounting. Type: project-specific (a pure reduction over model_usage events).*

## Zoom out — where this lives

The trace (`01`) carries a `model_usage` event per turn with input/output token counts. This file is the *derived* reader: a pure function that folds those events into a per-run usage summary and an estimated USD cost. It's the closest thing the repo has to a metric — but it's a post-run summary, not a live counter, and that distinction is the whole point.

```
  Zoom out — the derived reader of the event stream

  ┌─ Runtime: runAgentLoop ─────────────────────────────────────────┐
  │  per turn: emit { type:'model_usage', inputTokens, outputTokens,│
  │            provider, model, estimated }   run-agent-loop.ts:112  │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ CapabilityEvent[]
  ┌─ Runtime: usage-ledger ───▼──────────────────────────────────────┐
  │  ★ summarizeUsage(trace) ★  → { inputTokens, outputTokens,       │
  │     totalTokens, turns, estimated }     usage-ledger.ts:25-42    │
  │  estimateCost(provider, usage, model) → USD   :50-68             │ ← we are here
  └───────────────────────────┬──────────────────────────────────────┘
                              │ consumed by:
       ┌──────────────────────┼───────────────────┐
       ▼                      ▼                   ▼
  Studio metric strip   replay artifact      buffr tokens_used col
  (TracePanel summary)  (durationMs+usage)   (per-message)
```

## Zoom in — what it is

`summarizeUsage` (`packages/runtime/src/usage-ledger.ts:25-42`) reduces a `CapabilityEvent[]` to one `TokenUsageSummary` — total input/output tokens, turn count, and an `estimated` flag. `estimateCost` (`:50-68`) multiplies that by per-million pricing to get a USD figure. The question it answers: *how many tokens did this run cost, and how much money is that?*

## How it works

### Move 1 — the mental model

You already know this shape: it's `array.reduce()` summing a cart total. Each line item has a price; you fold the array into a running sum. Here each `model_usage` event is a line item with token counts; `summarizeUsage` folds them into a total. Nothing fancier than that.

```
  The pattern — reduce model_usage events into one total

  trace = [ step, model_usage{in:120,out:90}, tool_call_start,
            tool_call_end, model_usage{in:300,out:40}, step ]
                        │ filter type==='model_usage', sum
                        ▼
   { inputTokens:420, outputTokens:130, totalTokens:550, turns:2 }
```

### Move 2 — the walkthrough

**The reduction — skip everything that isn't usage.** `usage-ledger.ts:25-42`:

```ts
export function summarizeUsage(trace: readonly CapabilityEvent[]): TokenUsageSummary {
  return trace.reduce((summary, event) => {
    if (event.type !== 'model_usage') return summary;          // ignore non-usage events
    const inputTokens = event.inputTokens ?? 0;                // missing counts → 0, not NaN
    const outputTokens = event.outputTokens ?? 0;
    return {
      inputTokens:  summary.inputTokens  + inputTokens,
      outputTokens: summary.outputTokens + outputTokens,
      totalTokens:  summary.totalTokens  + inputTokens + outputTokens,
      modelName:    event.model || summary.modelName,
      turns:        summary.turns + 1,                         // one model_usage = one turn
      estimated:    summary.estimated || event.estimated === true,  // sticky: any estimate taints the total
    };
  }, { inputTokens:0, outputTokens:0, totalTokens:0, modelName:'', turns:0, estimated:false });
}
```

The load-bearing detail is `estimated`. It's *sticky* — once any turn reports estimated tokens, the whole summary is flagged estimated. That's honesty propagation: you can't show a confident total that's secretly part-guessed. Gemma via Ollama returns real `prompt_eval_count`/`eval_count` (`gemma-provider.ts:117-125`, `estimated: false`), so a local run is exact; a provider that estimates taints the run, and the UI can say so.

**Cost — and the honest refusal.** `estimateCost` (`:50-68`) only produces a number if pricing exists for that provider/model. And `pricingForModel` (`:71-77`) covers exactly one provider:

```ts
export function pricingForModel(provider: string, modelName: string): UsagePricing | undefined {
  if (provider !== 'openai') return undefined;               // ← Anthropic, Gemma: no pricing
  const n = modelName.toLowerCase();
  if (n.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (n.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (n.startsWith('gpt-4.1'))      return { inputUsdPerMillion: 2,   outputUsdPerMillion: 8 };
  return undefined;
}
```

The boundary condition everyone should clock: **the default provider is Gemma, and Gemma has no pricing entry** — so the default run shows accurate *tokens* but `$n/a` for cost (`formatCost` returns `'n/a'` on `undefined`, `:81-86`). This is deliberate: a local Gemma run *is* free (no API bill), and rather than invent a fake number, the code refuses. Honest, but a cost-observability blind spot the moment someone wants a real dollar figure on the default path (named in `audit.md` red-flag #5).

**Where the summary surfaces.** Three consumers, one reduction:

```
  Layers-and-hops — one summary, three displays

  summarizeUsage(trace)
       │
       ├─► Studio TracePanel summary strip  "Tokens 550"  (components.tsx:416)
       ├─► replay artifact  { ...usage, durationMs }  (recorded baseline)
       └─► buffr persists per-turn  tokens_used = in+out  (supabase-trace-sink.ts:73-78)
```

Note buffr persists tokens *per message row*, not as the summary — the summary is recomputed by reading the rows back. The trace stays the single source; everyone derives.

### Move 2.5 — current state vs a real metric

This is a *summary*, not a *metric*, and the gap is worth drawing.

```
  Phase A (now) — post-run summary        Phase B (a real metric system)
  ──────────────────────────────         ──────────────────────────────
  summarizeUsage(trace) after the run     counter.inc(tokens) live, per turn
  per-run, recomputed on demand           aggregated across runs / users / time
  no thresholds, no alerts                histograms, p50/p99, alert on spend
  shown in one panel + one DB column      Prometheus/OTel/Datadog scrape
  ── NOT YET EXERCISED beyond Phase A ──
```

There is no metrics backend in this repo (a grep for prometheus/opentelemetry/statsd/datadog returns nothing). Token accounting is a reduction over one run's trace, computed when something asks. Cross-run aggregation, spend alerting, and rate limiting on cost are `not yet exercised` — they'd matter when buffr serves many users and a runaway loop could rack up a bill. The migration path is gentle: the `model_usage` event is already the right granularity; a metrics system would *also* subscribe to the stream rather than replace `summarizeUsage`.

### Move 3 — the principle

**A derived metric should read the same event stream as everything else — don't emit a second, divergent counter.** The temptation is to also `counter.inc()` token totals at emit time, creating a parallel number that can drift from the trace. aptkit instead derives the total *from* the trace, so the summary can never disagree with the trajectory it summarizes. One source, many reductions. (And: refuse to estimate what you can't price — `$n/a` beats a confident lie.)

## Primary diagram

```
  Usage accounting — reduce, price, display

  ┌─ model_usage events (run-agent-loop.ts:112) ─────────────────────┐
  │  { provider, model, inputTokens, outputTokens, estimated }       │
  └───────────────────────────┬──────────────────────────────────────┘
       summarizeUsage(trace)   ▼  (filter type==='model_usage', sum)
  ┌─ TokenUsageSummary ──────────────────────────────────────────────┐
  │  totalTokens · turns · estimated (sticky)                        │
  └───────────────────────────┬──────────────────────────────────────┘
       estimateCost()          ▼  pricingForModel(provider, model)
  ┌─ CostEstimate | undefined ───────────────────────────────────────┐
  │  openai → $X.XX        anthropic / gemma → undefined → "$n/a"     │
  └───────────────────────────────────────────────────────────────────┘
   consumers: Studio strip · replay artifact · buffr tokens_used column
```

## Elaborate

Token accounting is the agent-era version of request metering. What's specific here is the `estimated` flag's stickiness — token counts come from the provider, and not all providers return them honestly (some estimate by re-tokenizing), so the summary tracks whether *any* turn was a guess and propagates that doubt to the total. That's a small idea with a big payoff: a cost figure you can trust to tell you when it can't be trusted.

The relationship to performance engineering: `durationMs` (on `tool_call_end`) and token counts (on `model_usage`) are the two quantitative signals in the trace, and they're recorded together in the replay artifact. But this guide stops at *accounting* — turning the numbers into budgets, baselines, and bottleneck analysis is `study-performance-engineering`. The seam is sharp: here we sum what happened; there they decide whether it was too slow or too expensive.

## Interview defense

**Q: How do you account for token usage and cost in your agent runs?**

Every model turn emits a `model_usage` event with input/output token counts. `summarizeUsage` is a pure reduce over the trace that sums them into a per-run total; `estimateCost` multiplies by per-million pricing. Crucially I *derive* the total from the same event stream the trace uses — I don't keep a separate counter that could drift.

```
  model_usage events ──reduce──► token total ──price──► USD (or $n/a)
```

One-line anchor: *one event stream, many reductions — the cost summary can't disagree with the trajectory because it's computed from it.*

**Q: What's missing, and what would you watch for?**

Two things. First, pricing only covers OpenAI, so the default Gemma path shows accurate tokens but `$n/a` — honest, since a local run is free, but a blind spot for real cost. Second, this is a post-run *summary*, not a live metric: no cross-run aggregation, no spend alerting. The sticky `estimated` flag is the detail I'd call out — it propagates "this total is partly a guess" so a dashboard never shows a confident number that's secretly estimated.

## See also

- `01-capability-event-trace.md` — the `model_usage` event this reduces.
- `02-trace-replay-as-debugger.md` — the Studio strip that shows the token total.
- `03-persisted-trajectory-backward-read.md` — buffr's `tokens_used` persistence.
- Cross-guide: `study-performance-engineering` (budgets/latency from the same numbers); `study-ai-engineering` (the provider token reporting).
