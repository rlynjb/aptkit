# 06 — Production serving (LLM side)

> Anchor: LLM application engineering (loopd-shaped) — Phase 5.
> Mostly `not yet exercised`: aptkit is local-first and zero-cloud by default.

This sub-section is honest about a gap. aptkit's default is local-first
(Gemma via Ollama, no cloud call), so most production-serving hardening —
caching, rate limiting, circuit breakers — `not yet exercised`. What *is*
present: the fallback chain (a primitive serving concern), the
structured-generation retry (a bounded retry, not backoff), and the
context-window guard. Each file marks current state and names the exercise.

## Files

- `01-llm-caching.md` — `not yet exercised`; prompt/semantic/exact-match caches and where they'd hook in.
- `02-llm-cost-optimization.md` — the cost ledger exists; model routing is `not yet exercised`.
- `03-prompt-injection.md` — the tool-schema-as-only-output-path defense aptkit already has; sanitization is the gap.
- `04-rate-limiting-backpressure.md` — `not yet exercised`; the local default makes this unforced.
- `05-retry-circuit-breaker.md` — bounded retry exists (`generateStructured`, fallback); backoff/breaker is `not yet exercised`.

Read `03-prompt-injection.md` first — it has the most real code.
