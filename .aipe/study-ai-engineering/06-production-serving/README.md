# 06 — Production serving

> Anchor: LLM application engineering. · Curriculum: Phase 6 (no curriculum file
> in this repo; exercises cite real aptkit/buffr paths instead).

This is the section where you'd expect cloud war stories — cache hit rates, a
per-token cost dashboard, a rate limiter eating 429s, a circuit breaker tripping
on a dead provider. aptkit has almost none of that, and that's the honest
lesson. aptkit is **local-first**: the default model is Gemma `gemma2:9b` running
on local Ollama (`packages/providers/gemma/src/gemma-provider.ts:47`). Zero
cloud, zero rate limits, zero provider bill. So most production-serving concepts
here are `not yet exercised` — taught as the pattern, anchored to the *nearest
thing* aptkit actually built, with Case-B exercises for when it goes cloud.

Read that as a feature, not an apology. Knowing what you *didn't* build, and why,
and exactly where it would slot in, is the senior signal. The strong file in this
section is `03` — prompt injection — because aptkit's architecture answers it
structurally, not with a band-aid LLM.

## Files (self-contained per concept)

1. `01-llm-caching.md` — the 3 cache layers (exact / semantic / prompt) as the
   pattern; aptkit's `FixtureModelProvider` replay is the nearest exact-match
   cache (for tests, not production); production caching `not yet exercised`.
2. `02-llm-cost-optimization.md` — the usage ledger; pricing covers OpenAI
   gpt-4.1 only; the fallback chain is failover-by-availability, not
   cost-routing (gap); Gemma is free because it's local.
3. `03-prompt-injection.md` — the strongest story here: tool-call schema as the
   only structured-output path, least-privilege tool policies, and
   model-names-a-tool / your-code-runs-it via the registry. Input sanitization
   and an output-safety LLM are `not yet exercised`.
4. `04-rate-limiting-backpressure.md` — the pattern, then the honest gap; the
   loop's `maxToolCalls`/`maxTurns` bound *work*, not request *rate*.
5. `05-retry-circuit-breaker.md` — aptkit's three retries (Gemma's tool-call
   nudge, `generateStructured`'s parse retry, the loop's recovery turn) plus
   fallback failover; exponential backoff and a real circuit breaker are
   `not yet exercised`. Precise on why retry ≠ breaker.
