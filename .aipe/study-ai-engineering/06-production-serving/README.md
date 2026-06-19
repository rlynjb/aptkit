# 06 — Production serving

What it takes to run LLM agents in production: serving them cheaply, defending them
against attack, and keeping them up when providers misbehave. AptKit exercises some
of this for real (cost measurement, the injection-defense allowlist, content-retry,
the fallback chain) and leaves the rest as well-marked foundations (caching, rate
limiting, true circuit breaking). The files are honest about which is which.

## Files

- **[01-llm-caching.md](01-llm-caching.md)** — Prompt / semantic / exact caches.
  NOT exercised in AptKit — taught as a foundation. Anthropic prompt caching would
  attach at the provider adapter seam; an exact-match cache keyed on
  `hash(system+messages)` is the Case B exercise. Shorter file.
- **[02-llm-cost-optimization.md](02-llm-cost-optimization.md)** — Cheap-model-first
  routing, measure per-chain. AptKit has the *measurement* (usage-ledger:
  `summarizeUsage`/`estimateCost`) and a real cost win (heuristic-before-LLM intent
  routing). No cheap→expensive model routing yet; the fallback chain can be ordered
  cheap-first.
- **[03-prompt-injection.md](03-prompt-injection.md)** — Attack and defenses.
  AptKit's *real* defenses: the least-privilege tool allowlist (a hijacked model can
  only call read-only tools), structured-output validation as the only output path,
  and a secret-scanner in evals. Honest gap: no sanitization of tool results before
  feeding them back. Security-shaped.
- **[04-rate-limiting-backpressure.md](04-rate-limiting-backpressure.md)** — Provider
  rate limits, request queues, backpressure. NOT exercised — taught as a foundation.
  `maxToolCalls` bounds per-run fan-out, not cross-run concurrency. A
  concurrency-limited provider wrapper is the Case B exercise. Shorter file.
- **[05-retry-circuit-breaker.md](05-retry-circuit-breaker.md)** — Retry+backoff vs
  circuit breaker. AptKit has *content* retry (`generateStructured`, maxAttempts 2)
  and a *fallback chain* (failover) — but NOT a circuit breaker (no failure-count
  state). The distinction is the lesson. Adding backoff is the Case A exercise.

## Reading order

```
  Start → 02 (cost — what's measured, what's optimized)
        → 01 (caching — the cost lever not yet pulled)
        → 03 (injection — the real security content)
        → 05 (retry vs breaker — what failover is and isn't)
        → 04 (rate limiting — the backpressure foundation)
```
