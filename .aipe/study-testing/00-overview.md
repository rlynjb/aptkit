# Overview — the suite at a glance

One page. The shape of aptkit's test suite, the numbers, and the single move
that makes a non-deterministic system assertable.

## Zoom out — where testing sits

```
  The suite across the system

  ┌─ Tooling ────────────────────────────────────────────────┐
  │  node --test (built-in, zero deps) · Playwright (1 smoke) │
  │  no jest, no vitest, no mock framework                    │
  └────────────────────────────┬─────────────────────────────┘
                               │ runs per package
  ┌─ aptkit packages ──────────▼─────────────────────────────┐
  │  runtime · tools · context · retrieval · memory ·        │
  │  prompts · evals · workflows · providers · 6 agents      │
  │  30 source test files (test/*.test.ts)        ★ HERE      │
  └────────────────────────────┬─────────────────────────────┘
                               │ same VectorStore / ModelProvider contracts
  ┌─ buffr (companion repo) ───▼─────────────────────────────┐
  │  5 db-gated tests · real Postgres · --test-concurrency=1 │
  │  PgVectorStore implements aptkit's VectorStore           │
  └────────────────────────────────────────────────────────────┘
```

## The numbers (verified)

- **30 source test files** — `grep -rl "node:test" packages`, counting
  `test/*.test.ts` only (not built `dist/` copies).
- **Runner:** Node's built-in (`node --test dist/test/*.test.js` per package).
  Zero test dependencies. TDD throughout.
- **1 e2e:** `tests/studio/studio-smoke.spec.ts` (Playwright, 111 lines, dev
  server on port 4187).
- **buffr:** 5 integration tests against real Postgres, env-gated on
  `DATABASE_URL`, serial (`--test-concurrency=1`).
- **8 promoted fixtures** across 4 analytics agents
  (`packages/agents/*/fixtures/promoted/*.json`) — timestamped golden masters.

## The one move

Everything testable here traces to **dependency inversion on the model
boundary.** The agents depend on a port, not a vendor SDK:

```
  Why the suite is deterministic — the seam

  ┌─ agent code (under test, runs UNCHANGED) ─┐
  │  prompt → runAgentLoop → tool → parse     │
  └────────────────────┬───────────────────────┘
                       │ ModelProvider.complete()   ← the seam
        ┌──────────────┴──────────────┐
        ▼ in test                     ▼ in production
  FixtureModelProvider          GemmaModelProvider / Anthropic / OpenAI
  (replays recorded             (real model, real network)
   ModelResponse[])
```

Swap the adapter at the seam, the assembly above is unchanged. In test it's a
fake replaying recorded responses; in production it's a real model. Same port.
That's why `recommendation-agent.test.ts` can assert the *exact* trace event
sequence and the *exact* assigned id — nothing above the seam is random.

## The verdict (full version in audit.md)

**Strong** where it counts: the load-bearing contracts (`ModelProvider`,
`EmbeddingProvider`, `VectorStore`) and the deterministic AI boundaries (prompt
assembly, tool dispatch, output parsing, decode/retry) are all directly tested.
Error paths — retry, give-up, abort, dimension-mismatch, fallback-exhaustion,
scorer well-formedness — are tested, not just happy paths. No network, time, or
randomness in any aptkit test.

**Three gaps, ranked:**
1. `runAgentLoop` — the orchestration kernel — has no direct unit test (only
   transitive via 6 agents). Cheap to fix; highest leverage.
2. No shared `VectorStore` contract test across aptkit's `InMemoryVectorStore`
   and buffr's `PgVectorStore` — `not yet exercised`.
3. `rubric-improvement` has no `replay:promoted` script (the other 4 agents do)
   — its golden-master path is `not yet exercised`.

**Accepted, not a gap:** no Studio UI unit tests. Studio is a manual preview
harness displaying traces tested upstream; the Playwright smoke guards boot +
replay. Adding component tests would test the harness, not the product.
