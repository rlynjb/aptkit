# 05 — Production Serving for Agents

**Anchor: single-agent + multi-agent (both).**

`study-ai-engineering/06-production-serving/` covers caching, cost, backpressure, and circuit-breaking for a *single LLM call*. This sub-section does **not** re-teach those — it covers the three places where the single-call version is insufficient because the unit of execution is a loop or a topology that issues many calls, often repeatedly against the same tool.

aptkit has the building blocks (a usage ledger, truncation, per-loop caps, swappable providers, a fallback chain) but is honest about what it doesn't have yet (no cross-turn cache, no fan-out limiter, no per-tool breaker) — because it runs one agent at a time against a local model where these pressures are mild.

1. `01-cross-turn-caching.md` — caching across turns and runs (not yet exercised; prefix-cache-ready).
2. `02-fan-out-backpressure.md` — concurrency caps for parallel agents (not yet exercised; no fan-out).
3. `03-per-tool-circuit-breaking.md` — bounding a flaky tool inside a loop (the loop has the hook; no breaker yet).
