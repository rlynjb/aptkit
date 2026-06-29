# E — Production Serving for Agents

What single-call serving becomes once the unit is an autonomous loop or a topology — the same problems compound across turns and concurrent agents.

Anchor: single-agent + multi-agent (both).

Single-call serving (caching, cost, backpressure, retry/breaker) lives in `.aipe/study-ai-engineering/06-production-serving/`. This sub-section covers the three places that version is insufficient because the unit issues many calls. aptkit has one of the relevant controls (tool-result truncation); the rest are `not yet exercised`.

## Files

1. [01-cross-turn-caching.md](01-cross-turn-caching.md) — caching across turns and runs, not one request. Not yet exercised.
2. [02-fan-out-backpressure.md](02-fan-out-backpressure.md) — a concurrency cap on a supervisor's fan-out. Not exercised (no fan-out).
3. [03-per-tool-circuit-breaking.md](03-per-tool-circuit-breaking.md) — a breaker per tool, fed back to the agent. Not yet exercised; truncation is the one real serving control aptkit has.
