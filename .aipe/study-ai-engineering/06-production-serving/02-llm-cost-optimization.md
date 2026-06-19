# LLM cost optimization (measure first, then route cheap)

**Industry names:** LLM cost optimization, model routing / cascading, cost observability · *Industry standard*

## Zoom out, then zoom in

LLM calls cost money per token, and the bill is the sum over every call in every
chain. You can't optimize what you don't measure — so the first move is always
*instrumentation*: count the tokens, price them, attribute them to a run. Then you
optimize: route the easy work to cheap models (or no model at all), and only escalate
to expensive ones when needed. AptKit has the measurement layer built and one real
optimization shipped; the model-cascade is a marked next step.

```
  Zoom out — where cost is measured and optimized

  ┌─ Routing layer ───────────────────────────────────────────────┐
  │  ★ heuristic parseIntent BEFORE the LLM (a real cost win) ★      │ ← optimization
  └───────────────────────────────┬────────────────────────────────┘
                                   │ runAgentLoop emits model_usage events
  ┌─ Runtime / Trace layer ────────▼────────────────────────────────┐
  │  ★ usage-ledger: summarizeUsage / estimateCost (measurement) ★   │ ← instrumentation
  └───────────────────────────────┬────────────────────────────────┘
                                   │ ModelProvider.complete()
  ┌─ Provider layer ───────────────▼────────────────────────────────┐
  │  fallback chain (orderable cheap-first)  — model cascade: not yet │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: cost optimization is two disciplines. *Measurement* — sum input/output
tokens per run and price them so you know where the money goes. *Reduction* — do
less expensive work: skip the LLM when a rule suffices, use a cheap model when it's
adequate, cache repeats. The question this file answers: what does AptKit actually
measure, and what has it actually optimized? Answer: it measures usage and cost per
run (usage-ledger), and it optimizes by routing intent with a free heuristic before
spending an LLM call. Cheap→expensive *model* routing isn't built yet, though the
fallback chain is the natural place for it.

## Structure pass

**Layers.** Three: the *routing* layer (decides whether to call an LLM at all), the
*trace/ledger* layer (measures what was spent), and the *provider* layer (where a
cheap-first model order would live). Measurement spans all three via the trace;
optimization currently lives at routing.

**Axis — cost: how many tokens/dollars does this path spend, and is the spend
necessary?** Trace it. At routing, a keyword match spends *zero* tokens for the easy
case — necessary spend avoided. At the loop, each turn's `model_usage` is recorded —
spend made visible. At the ledger, the events are summed and priced — spend
quantified. The cheapest spend is the call you didn't make.

```
  One question — "what does this path cost, and must it?"

  ┌─ routing ───┐  → keyword match = 0 tokens (avoid the call entirely)
  ┌─ loop ──────┐  → each turn records model_usage (make spend visible)
  ┌─ ledger ────┐  → summarizeUsage + estimateCost (quantify the spend)
  ┌─ provider ──┐  → cheap-first order COULD save (not yet exercised)
```

**Seams.** The optimization seam is `parseIntent` vs `classifyIntent` — the cheap
heuristic stands in front of the expensive LLM classifier, and the LLM is only
reached when you choose to. The measurement seam is the `model_usage` trace event —
the loop emits it on every model turn, and the ledger consumes the trace. Both seams
are where a cost decision (or measurement) attaches.

## How it works

You already know profiling before optimizing: you don't guess where a program is
slow, you measure, then fix the hot path. LLM cost is identical — measure tokens per
chain, find the expensive calls, then cut them (skip the model, downgrade the model,
or cache). AptKit gives you the profiler (the ledger) and one fix already applied
(heuristic routing).

### Move 1 — the mental model

```
  Cost optimization — measure, then reduce

  MEASURE                              REDUCE
  ───────────────────────────         ──────────────────────────────
  count input + output tokens         skip the LLM (rule/heuristic)
  per run (model_usage events)        use a cheaper model when adequate
  price them (estimateCost)           cache identical calls
  attribute to a chain                order providers cheap-first
        │                                   │
        └──── you can't reduce ─────────────┘
              what you haven't measured
```

The discipline in one line: instrument first. A "cost optimization" you can't
measure before and after is a guess.

### Move 2 — the moving parts

**Measurement: the usage ledger.** Bridge from a billing meter — the loop emits a
`model_usage` event per model turn (provider, model, input tokens, output tokens).
`summarizeUsage` walks a run's trace and sums those into a `TokenUsageSummary`;
`estimateCost` multiplies the summed tokens by per-million pricing for the model and
returns a dollar `CostEstimate`. Boundary condition: pricing is only known for the
models in the table (currently the gpt-4.1 family) — an unknown model returns
`undefined` cost, so the estimate is honest about what it can't price.

```
  Pattern — trace → summary → cost

  run trace ──► summarizeUsage ──► { inputTokens, outputTokens }
                                          │
                                  estimateCost(provider, usage, model)
                                          │ pricing table lookup
                                          ▼
                              { inputCost, outputCost, totalCost } | undefined
```

**Optimization 1 (shipped): heuristic before LLM.** Bridge from a cache-before-compute
guard — before paying for an LLM to classify intent, AptKit checks the raw query for
keywords (`parseIntent`). The easy cases route for *zero* tokens. Only when you want
real classification do you call `classifyIntent`, a deliberately tiny 16-token call.
Boundary condition: the heuristic is dumb on purpose — it's the free fast path; the
LLM is the escalation, not the default. (Full mechanics in
`../04-agents-and-tool-use/04-tool-routing.md`.)

```
  Pattern — heuristic-first routing (cost-first)

  query ──► parseIntent (keyword match, 0 tokens) ──► routed?
                │ want a real classification?
                ▼
          classifyIntent → model.complete({ maxTokens: 16 })  ← tiny, bounded call
```

**Optimization 2 (available, not yet a cascade): cheap-first provider order.** Bridge
from a tiered cache (L1 cheap, L2 expensive) — the fallback chain tries providers in
*order*. Order it cheap-model-first and you get a crude cost cascade: the cheap
provider answers when it can; the expensive one is only reached on failure. Boundary
condition: today the chain falls through on *error*, not on *quality* — it's failover
ordered by cost, not a true cascade that escalates when the cheap model's answer is
inadequate. A real cascade (try cheap, validate, escalate if bad) isn't built.

```
  Comparison — failover-ordered-cheap vs a true cascade

  TODAY (failover, orderable)          NOT YET (quality cascade)
  ──────────────────────────────       ──────────────────────────────────
  try cheap → on ERROR → try costly    try cheap → on BAD ANSWER → try costly
  cost saved only when cheap works     cost saved on every adequate cheap answer
  no quality check between tiers       validate cheap output, escalate if weak
```

### Move 3 — the principle

Measure per chain, then cut the most expensive necessary-seeming call you can prove
is unnecessary. The biggest cost win is structural, not parametric: the cheapest
token is the one you never spend, so a rule that answers without the model beats any
model-tuning. After that, match the model to the difficulty (cheap by default,
expensive on demand) and cache repeats. AptKit's order is right — it built the meter
first and pulled the highest-leverage lever (skip-the-LLM routing) — and it leaves
the model cascade as a measured, deliberate next step rather than a premature
complication.

## Primary diagram

The full cost picture: a free routing decision, a metered loop, a priceable summary,
and the cheap-first provider lever.

```
  LLM cost optimization — full picture

  ROUTING (reduce — shipped)
  query ─► parseIntent (0 tokens) ─┐
          classifyIntent (16 tok) ─┴─► capability   ← cheapest token = uncalled
        │
  RUNTIME LOOP (measure)
  each model turn ─► emit model_usage { provider, model, in/out tokens }
        │
  USAGE LEDGER (measure)
  summarizeUsage(trace) ─► { inputTokens, outputTokens }
        │ estimateCost(provider, usage, model)  (pricing table)
        ▼
  { totalCost } | undefined (unknown model = honestly unpriced)
        │
  PROVIDER (reduce — available, not a cascade)
  fallback chain ordered cheap-first → cheap answers; costly only on error
        └─ true quality cascade (escalate on bad answer): NOT YET
```

## Implementation in codebase

**Use cases.** Studio and replay summaries show per-run token usage and an estimated
cost by feeding the run's trace through the ledger. Every query routed by keyword
instead of the LLM classifier is a saved call. The fallback chain's order is a
config decision a deployment can set cheap-first.

**Measurement — summarize and price**, `packages/runtime/src/usage-ledger.ts:25-89`:

```
  usage-ledger.ts  (lines 50-68, 71-78)

  export function estimateCost(provider, usage, modelName) {
    const pricing = pricingForModel(provider, modelName);
    if (!pricing) return undefined;                          ← unknown model: honest n/a
    const inputCost  = (usage.inputTokens  / 1_000_000) * pricing.inputUsdPerMillion;
    const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
    return { currency: 'USD', inputCost, outputCost,
             totalCost: inputCost + outputCost, …, estimated: true };
  }

  export function pricingForModel(provider, modelName) {     ← the price table
    if (provider !== 'openai') return undefined;
    if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1,  output: 0.4 };
    if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4,  output: 1.6 };
    if (normalized.startsWith('gpt-4.1'))      return { inputUsdPerMillion: 2,    output: 8 };
    return undefined;
  }
       │
       └─ the nano/mini/full tiers in this table ARE the cheap→expensive
          ladder a cascade would climb — note nano is 20x cheaper than full
          on input. The data to route by cost is right here; the router isn't.
```

`summarizeUsage` (`usage-ledger.ts:25`) sums the `model_usage` events the loop emits
(`run-agent-loop.ts:111-122`), and `formatCost` (`usage-ledger.ts:81`) renders it for
compact Studio displays.

**Optimization — heuristic before LLM**, `packages/agents/query/src/intent.ts:4-29`:

```
  intent.ts  (lines 4-10, 17-22)

  export function parseIntent(raw) {              ← 0 tokens, runs first
    if (text.includes('monitoring')) return 'monitoring';
    …
  }
  export async function classifyIntent(model, query) {   ← the escalation
    const response = await model.complete({ …, maxTokens: 16 });  ← tiny, bounded
    return parseIntent(text);
  }
       │
       └─ the free path handles the easy cases; the LLM is reached only when
          you want real classification, and even then it's a 16-token call.
          This is the shipped cost win. See 04-tool-routing.md.
```

**The cheap-first lever**, `packages/providers/fallback/src/fallback-provider.ts:50-89`:
the chain tries `this.providers` in array order. Ordering the array cheap-model-first
makes the cheap provider the default and the expensive one the fallback — a
cost-ordered failover. A *quality* cascade (escalate when the cheap answer is
inadequate) would need a validation step between tiers, which isn't built.

## Elaborate

The cost discipline mirrors classic performance engineering: profile, find the hot
path, optimize it, re-measure. For LLMs the "hot path" is token spend, and the
highest-leverage cut is almost always *structural* — skip the model, use a smaller
one, or cache — not turning down `max_tokens`. Model cascading (route easy queries to
a small cheap model, hard ones to a large model) is the industry's headline cost
pattern, and it depends entirely on having the measurement to know which queries are
"easy" and a quality signal to know when to escalate.

AptKit's pricing table encodes a real cheap→expensive ladder (nano → mini → full,
spanning 20× on input price), which is exactly the ladder a cascade would climb — the
data is present, the router isn't. The honest framing: AptKit measures cost and has
made the cheapest optimization (don't-call-the-LLM routing); the model cascade is a
deliberate, measurable next step, not a missing fundamental.

Adjacent concepts: the routing mechanics (`../04-agents-and-tool-use/04-tool-routing.md`),
the per-token economics being measured (`../01-llm-foundations/06-token-economics.md`),
caching as the other big cost lever (`01-llm-caching.md`), and the fallback chain
itself (`05-retry-circuit-breaker.md`).

## Project exercises

*Provenance: Phase 6 — Production serving (C6.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case A — measurement and heuristic routing exist; these
add reduction.*

### Exercise — assert a per-run cost budget in evals (Case A)

- **Exercise ID:** `[A6.3]` Phase 6, cost-measurement concept
- **What to build:** An eval assertion that runs `summarizeUsage`/`estimateCost` on a
  run's trace and fails if the run exceeds a configured token or dollar budget —
  turning the ledger from a display into a guardrail.
- **Why it earns its place:** Measurement without a threshold catches nothing; a
  budget assertion makes a regression that doubles token spend fail a test. It uses
  the existing ledger and is the natural completion of the measurement layer.
- **Files to touch:** `packages/evals/src/*`, `packages/runtime/src/usage-ledger.ts`
  (consume only), a fixture run.
- **Done when:** A run that exceeds the budget fails the eval; one under it passes.
- **Estimated effort:** `1–4hr`

### Exercise — a quality-aware model cascade (Case B)

- **Exercise ID:** `[B6.4]` Phase 6, model-cascading concept
- **What to build:** A `CascadingModelProvider` that calls a cheap model first,
  validates the result (schema parse, or a confidence check), and escalates to a more
  expensive model only when the cheap answer fails validation — logging the
  escalation rate so you can tune the threshold.
- **Why it earns its place:** This is the headline cost pattern and the real gap:
  AptKit can order providers cheap-first but only escalates on *error*, not on *bad
  answer*. A quality cascade saves on every adequate cheap answer and is a strong,
  measurable optimization.
- **Files to touch:** a new `packages/providers/cascade/src/*`,
  `packages/runtime/src/usage-ledger.ts` (measure savings), matching tests.
- **Done when:** Easy inputs are answered by the cheap model (and the ledger shows the
  saving); inputs the cheap model fails escalate to the expensive one; a test proves
  both paths.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: How would you cut the LLM bill on this system?**
"Measure first, then cut the most expensive unnecessary call. I'd draw the order:"

```
  measure: summarizeUsage + estimateCost per run (have it)
        │
  reduce: skip the LLM (heuristic routing — have it)
        → cheap model when adequate (cascade — gap)
        → cache repeats (gap)
```

"AptKit already measures — `usage-ledger.ts:50` prices a run's tokens — and it
already skips the LLM for easy intent classification via `parseIntent`
(`intent.ts:4`), which is the cheapest possible win: zero tokens. The next lever is a
quality cascade — cheap model first, escalate on a bad answer — which the pricing
table (nano is 20× cheaper than full) is already set up for; I just haven't built the
router."
*Anchor: the cheapest token is the one you never spend — skip-the-LLM beats any tuning.*

**Q: Your fallback chain is ordered cheap-first. Is that a cost cascade?**
"Partly. It's a cost-*ordered failover* — the cheap provider is the default and the
expensive one is reached on *error* (`fallback-provider.ts:50`). A true cascade
escalates on a *bad answer*, not just a failure — try cheap, validate, escalate if
weak. That needs a validation step between tiers, which isn't built. So I save cost
when the cheap model *works*, but not when it answers *poorly*."
*Anchor: failover-ordered-cheap saves on errors; a cascade saves on inadequacy.*

## Validate

- **Reconstruct:** From memory, write the cost pipeline: trace → `summarizeUsage` →
  `estimateCost` → dollars (or undefined). Check against `usage-ledger.ts:25-68`.
- **Explain:** Why does `estimateCost` return `undefined` for an unknown model
  (`usage-ledger.ts:55`)? (It only has pricing for the gpt-4.1 family; returning
  `undefined` is honest about what it can't price rather than guessing a wrong
  number.)
- **Apply:** A monitoring query arrives containing the literal word "monitoring." How
  many tokens does routing it cost, and why? (Zero — `parseIntent` keyword-matches it
  with no model call; the LLM classifier is never reached. `intent.ts:6`.)
- **Defend:** Why build the usage ledger *before* the model cascade? (You can't tune
  or justify a cascade without measuring the spend it saves; the ledger is the
  profiler that tells you whether the cascade is worth it and what to escalate on —
  `usage-ledger.ts:50`.)

## See also

- [01-llm-caching.md](01-llm-caching.md) — caching, the other major cost lever (not yet built)
- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — the fallback chain that can be ordered cheap-first
- [../04-agents-and-tool-use/04-tool-routing.md](../04-agents-and-tool-use/04-tool-routing.md) — the heuristic-first routing that is the shipped cost win
- [../01-llm-foundations/06-token-economics.md](../01-llm-foundations/06-token-economics.md) — the per-token economics being measured
- [../05-evals-and-observability/04-llm-observability.md](../05-evals-and-observability/04-llm-observability.md) — the trace events the ledger consumes
