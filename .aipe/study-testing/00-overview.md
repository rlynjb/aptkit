# Overview — Testing in one page

One screen, the whole testing story, before you open anything else.

```
  aptkit testing — the whole picture

  ┌─ Test runner ────────────────────────────────────────────────┐
  │  node --test  (built-in, zero test deps — no jest, no vitest) │
  │  per package: node --test dist/test/*.test.js                 │
  │  30 source .test.ts files across 14 packages                  │
  └───────────────────────────────────┬───────────────────────────┘
                                      │
        ┌─────────────────────────────┼─────────────────────────────┐
        ▼                             ▼                             ▼
  ┌─ UNIT ────────────┐   ┌─ CONTRACT / REPLAY ───┐   ┌─ INTEGRATION ─────┐
  │ pure functions    │   │ fake providers feed   │   │ real Postgres     │
  │ scorers, parsers, │   │ recorded responses    │   │ (buffr, separate  │
  │ vector math,      │   │ through real agents   │   │ repo)             │
  │ prompt render     │   │ FixtureModelProvider  │   │ --test-concurrency│
  │                   │   │ promoted fixtures =   │   │ =1, app_id='test' │
  │                   │   │ correctness baselines │   │ skip if no DB URL │
  └───────────────────┘   └───────────────────────┘   └───────────────────┘
        │                             │                             │
        └────────────── all deterministic ──────────┘   (DB-gated)
                                      │
                          ┌───────────▼────────────┐
                          │ E2E (thin)             │
                          │ Playwright smoke only  │
                          │ tests/studio/          │
                          │ studio-smoke.spec.ts   │
                          │ no component/unit UI   │
                          └────────────────────────┘
```

## The verdict, ranked

1. **The injected-contract design makes the whole suite fast and
   network-free.** Every provider (`GemmaModelProvider({ chat })`,
   `OllamaEmbeddingProvider({ embed })`, `FallbackModelProvider({ providers })`)
   takes its expensive I/O as a constructor argument. Tests pass a fake; no
   `:11434`, no cloud key, no flake. This is the single best thing about the
   suite. → `01-injectable-transport-seam.md`

2. **The biggest coverage gap is the agent loop itself.** `runAgentLoop`
   (`packages/runtime/src/run-agent-loop.ts`) — the bounded loop that is the
   spine of every agent — has **no direct unit test**. It's exercised only
   transitively through agent tests. Its `maxTurns` budget, `forceFinal` last
   turn, and abort handling are not pinned in isolation. → audit lens 1.

3. **The AI seam is tested at the deterministic boundary, correctly.** Prompt
   assembly, tool dispatch, output parsing, retry-on-bad-JSON, fixture
   replay — all the *deterministic* parts of the LLM features have tests. The
   *probabilistic* part (is the answer good?) hands off to study-ai-engineering
   via the eval scorers. The line is drawn in the right place. → audit lens 6.

## What's strong

- Error paths are tested as first-class, not afterthoughts: abort signals,
  dimension mismatch (throws loud), retry-then-give-up, fallback exhaustion,
  zero-denominator scoring. The boundary conditions get their own `it()`.
- A real bug became a named regression test (the hallucinated `{textContains}`
  filter). → `03-regression-test-from-a-real-bug.md`
- Determinism is engineered, not lucky: fake embedders are keyword-presence
  hashes, fixtures are recorded byte-for-byte, tool-use ids are a counter not
  a UUID — so cross-turn uniqueness is testable.

## What's missing (honest gaps)

- No direct `runAgentLoop` test (gap #2 above).
- No UI component/unit tests for Studio — only a repo-level Playwright smoke
  spec that clicks cards and checks headings render.
- `rubric-improvement` has no `replay:promoted` script wired into the root
  pipeline (other agents do), so its trajectory isn't regression-guarded the
  same way.
- The one true integration test (real Postgres) lives in buffr and is `skip`ped
  unless `DATABASE_URL` is set — green CI does not prove the pgvector binding.
