# LLM cost optimization

*LLM cost optimization · model routing (Industry standard)*

Here's the thing aptkit gets right that most teams don't: it *measures* cost. The usage ledger (`estimateCost`) is real, it works, it's wired into the trace. What aptkit doesn't do yet is *act* on the measurement. The fallback chain looks like routing — it tries one provider, then another — but it routes on *failure*, not on *cost or quality*. That distinction is the whole file. You have the speedometer; you don't have the gear-shift.

## Zoom out, then zoom in

Cost optimization has two halves, and aptkit owns exactly one of them. ★ Measurement (what did this call cost?) is shipped. Routing (which model *should* this call go to?) is `not yet exercised`.

```
Cost optimization: measure → decide → route
┌──────────────────────────────────────────────────────────────────────┐
│  MEASURE  (SHIPPED)                                                    │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ usage-ledger.ts: summarizeUsage → estimateCost → formatCost    │    │
│  │   tokens in/out  ──pricingForModel──▶  $ per call              │    │
│  └────────────────────────────┬───────────────────────────────────┘  │
│                                ▼ feeds                                 │
│  DECIDE  (NOT YET EXERCISED)                                           │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ "is the cheap model good enough for THIS request?"             │    │
│  └────────────────────────────┬───────────────────────────────────┘  │
│                                ▼ drives                                │
│  ROUTE  (NOT YET EXERCISED — and NOT what the fallback chain does)     │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ cheap model (Gemma, $0) ──good?──▶ done                        │    │
│  │                          ──not good?──▶ escalate (Sonnet, $$)  │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

The fallback chain (`FallbackModelProvider`) lives in the ROUTE box's *shape* but not its *trigger*. It escalates on **exception**, never on **"the cheap answer wasn't good enough."**

## Structure pass

One axis: **failure-based vs quality/cost-based routing**.

- **Failure-based (shipped — `FallbackModelProvider`).** Try provider A; if `complete()` *throws*, try provider B. The trigger is an error. A working-but-bad answer from A never triggers a fallback — the chain considers it a success and returns it.
- **Quality/cost-based (the gap — a router).** Try the *cheap* model; inspect the result; escalate to the expensive model only if the cheap result fails a quality gate. The trigger is a *validation verdict*, not an exception.
- **The seam they share.** Both are `ModelProvider`s composed of an ordered list of providers. The router is the fallback chain with the gate moved from `catch` to `if (!validate(result))`.

That's the precise distinction to hold: **same composition, different trigger.**

## How it works

**Move 1 — the mental model: routing is a fallback whose trigger is quality, not failure.**

```
Two triggers, one composition
                 ┌─────────────────────────────────────────────┐
  FALLBACK CHAIN │ for provider in [A, B, C]:                   │
  (shipped)      │   try:    return await provider.complete()   │
                 │   catch:  continue   ← trigger = EXCEPTION    │
                 └─────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────┐
  QUALITY ROUTER │ for model in [cheap, expensive]:             │
  (the gap)      │   res = await model.complete()               │
                 │   if validate(res): return res               │
                 │   else: continue     ← trigger = BAD RESULT   │
                 └─────────────────────────────────────────────┘
```

**Move 2 — step by step.**

**Part A — what's shipped: the cost meter.** The ledger turns trace events into a dollar figure. It's honest about scope — only OpenAI gpt-4.1 tiers are priced, and `provider !== 'openai'` returns `undefined`, which is exactly correct for local Gemma:

```ts
// packages/runtime/src/usage-ledger.ts:70-78
export function pricingForModel(provider: string, modelName: string): UsagePricing | undefined {
  if (provider !== 'openai') return undefined;           // ← Gemma / local: no per-call price
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.startsWith('gpt-4.1'))      return { inputUsdPerMillion: 2,   outputUsdPerMillion: 8 };
  return undefined;
}
```

`estimateCost` (`usage-ledger.ts:49-68`) divides token counts by a million and multiplies by these rates. The local-first consequence is structural: **when the model is Gemma, every call costs $0**, so the only optimization left is *don't call the expensive model unless you have to* — which is routing.

**Part B — what's shipped that *looks* like routing but isn't: the fallback chain.** The loop tries each provider in order; the trigger to move on is a *caught exception*:

```ts
// packages/providers/fallback/src/fallback-provider.ts:50-86
for (let index = 0; index < this.providers.length; index += 1) {
  const provider = this.providers[index];
  try {
    const response = await provider.complete(request);
    this.lastSelectedProvider = { providerId: provider.id, /* ... */ };
    return { ...response, model: response.model ?? provider.defaultModel }; // ← ANY success returns
  } catch (error) {                                                          // ← only an ERROR continues
    if (isAbortError(error) || request.signal?.aborted) throw error;
    attempts.push(/* ... */);
    if (!this.shouldFallback(error, provider)) throw error;                  // ← gate is on the error
    // ... continue to next provider ...
  }
}
```

Read line 54: *any* successful `complete()` returns immediately. A cheap model that returns garbage-but-valid prose is a "success" here. The chain never escalates for quality — only for crashes. That's the gap in one sentence: **`shouldFallback(error, provider)` gates on an error; a quality router would gate on `validate(response)`.**

**Part C — the gap, drawn: a quality-gated router.** Here's current-state-vs-future-state:

```
Move 2.5 — fallback chain (shipped) vs quality router (the gap)
CURRENT: FallbackModelProvider              FUTURE: QualityRoutedProvider
┌────────────────────────────────┐         ┌────────────────────────────────────┐
│ for p in providers:            │         │ for m in [gemma, sonnet]:          │
│   try:                         │         │   res = await m.complete(req)      │
│     return p.complete(req)     │ ──────▶ │   if validate(res): return res     │
│   catch e:                     │         │   // valid? cheap won. done at $0  │
│     if shouldFallback(e):      │         │   // invalid? escalate to $$       │
│       continue                 │         │ throw RoutingExhausted(...)        │
│ throw ProviderFallbackError    │         │                                    │
│                                │         │ trigger = QUALITY, not exception   │
│ trigger = EXCEPTION            │         │                                    │
└────────────────────────────────┘         └────────────────────────────────────┘
```

The router reuses the structured-generation validators (`generateStructured`'s `validate`) as the quality gate. Gemma produces a structured answer; if it parses and validates, you spent $0 and you're done. Only on a validation miss do you pay for Sonnet.

**Move 3 — the principle.** Measure first, route second, and never confuse failover with routing. Failover protects *availability* (the provider is down). Routing protects *cost* (the cheap model is good enough). They share a loop but answer different questions. aptkit has the meter and the failover loop; the missing piece is moving the gate from `catch` to `if (!valid)`.

## Primary diagram

```
Where each piece lives — and the one-line move that closes the gap
┌─────────────────────┬──────────────────────────┬───────────────────────────┐
│ Piece               │ Status                   │ Trigger                   │
├─────────────────────┼──────────────────────────┼───────────────────────────┤
│ Cost ledger         │ SHIPPED                  │ — (passive measurement)   │
│ Fallback chain      │ SHIPPED                  │ exception (availability)  │
│ Quality router      │ NOT YET EXERCISED        │ validation miss (cost)    │
└─────────────────────┴──────────────────────────┴───────────────────────────┘
              THE MOVE: gate on  if (!validate(res))  instead of  catch(error)
```

## Elaborate

- **The cost ledger only prices OpenAI on purpose.** `pricingForModel` returns `undefined` for everything non-OpenAI — that's not a bug, it's the local-first stance. Gemma has no per-call price, so `estimateCost` correctly returns `undefined` and the formatter shows `$0.00` / `n/a`. If you add Anthropic to the price table, do it deliberately and cite real rates (read `claude-api`).
- **Routing's payoff scales with the cheap model's hit rate.** If Gemma is good enough 80% of the time, you pay Sonnet on 20% of requests — an 80% cost cut on a cloud-only baseline. If Gemma is good enough 10% of the time, routing just adds a wasted Gemma call before every Sonnet call. Measure the gate's pass rate before you trust the router.
- **Don't route on a vibe — route on a validator.** The quality gate has to be programmatic (the same JSON validators `generateStructured` uses), not a second LLM judging the first. An LLM judge in the hot path is *more* cost, not less.

## Project exercises

Phase 5. Case B — measurement exists, the router doesn't.

### Quality-gated model router

- **Exercise ID:** `EX-SERVE-02a` — quality-gated-router
- **What to build:** A `QualityRoutedProvider` that takes an ordered `[cheap, expensive]` provider list and a `validate` predicate. It calls the cheap model, runs `validate` on the response, returns on pass, and escalates to the next model on a validation miss. Distinct from `FallbackModelProvider` because the trigger is the validator, not an exception.
- **Why it earns its place:** It closes the exact gap this file is about and forces you to articulate failover-vs-routing in code.
- **Files to touch:** new `packages/providers/fallback/src/quality-router.ts` (sibling to `fallback-provider.ts`), reuse a `JsonValidator` from `packages/runtime/src/json-output.ts`.
- **Done when:** a passing cheap result never calls the expensive provider (spy assertion), and a failing one does; emits a trace event on escalation.
- **Estimated effort:** `1–4hr`

### Anthropic pricing in the ledger

- **Exercise ID:** `EX-SERVE-02b` — anthropic-pricing-tiers
- **What to build:** Extend `pricingForModel` with current Anthropic per-million rates so `estimateCost` can price a cloud-fallback call. Read `claude-api` for the exact model ids and rates — do not guess.
- **Why it earns its place:** Routing without a price table is half-blind; this makes the router's cost claim auditable.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts:70-78`.
- **Done when:** an Anthropic model id returns a defined `UsagePricing`, with a test asserting the dollar math, and rates sourced from the skill (not memory).
- **Estimated effort:** `<1hr`

### Route-decision trace event

- **Exercise ID:** `EX-SERVE-02c` — route-decision-observability
- **What to build:** Emit a structured trace event from the router recording which model was selected and why (cheap-passed vs escalated), so Studio can show the routing decision and aggregate the gate pass rate.
- **Why it earns its place:** A router you can't observe is a router you can't tune — the pass rate is the metric that justifies the whole thing.
- **Files to touch:** `packages/providers/fallback/src/quality-router.ts`, the event types in `packages/runtime/src/events.ts`.
- **Done when:** every routed call emits one decision event with `{selectedModel, escalated, gatePassed}`, visible in a replay.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: aptkit has a fallback chain. Isn't that model routing?**

```
fallback:  A throws ──▶ try B          (trigger = AVAILABILITY)
routing:   A's answer fails gate ──▶ try B   (trigger = QUALITY/COST)
            └── same loop, the gate moved from catch{} to if(!valid){}
```

Anchor: failover answers "is the provider up?"; routing answers "is the cheap model good enough?" — same composition, different trigger.

**Q: How do you decide *when* to escalate to the expensive model without a human?**

```
cheap model ──▶ structured response ──▶ validate(res)
                                          pass → done ($0)
                                          fail → escalate ($$)
        the validator is the SAME one generateStructured already uses
```

Anchor: the quality gate has to be a programmatic validator, not a second LLM — an LLM judge in the hot path adds cost instead of cutting it.

**Q: Local-first means $0 per call. Why optimize cost at all?**

```
Gemma = $0  ──so optimization = "avoid the cloud call unless needed"
            ──router earns out the moment a paid provider joins the list
```

Anchor: local-first makes cost optimization *unforced today* and *pre-built for the day you add a cloud model* — which is exactly when an unmeasured router would surprise you.

## See also

- [`01-llm-caching.md`](./01-llm-caching.md) — the other way to cut cost: don't make the call at all.
- [`05-retry-circuit-breaker.md`](./05-retry-circuit-breaker.md) — the fallback chain's other role: availability, not cost.
- [`../05-evals-and-observability/README.md`](../05-evals-and-observability/README.md) — where the validators that gate the router come from.
