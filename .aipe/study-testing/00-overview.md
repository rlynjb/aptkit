# Overview — the testing system in one page

Before the lenses, the shape. AptKit's test suite has three tiers and one spine.
The spine is the **replay loop**: live run → artifact → eval → promote → deterministic
replay. Everything else hangs off it.

## The test pyramid, as built

```
  AptKit's pyramid — wide deterministic base, one E2E cap

  ┌─ E2E (Playwright, port 4187) ────────────────────────────┐
  │  tests/studio/studio-smoke.spec.ts                       │  7 tests
  │  cards navigate · fixture run bumps counter · panels show │  1 file
  └───────────────────────────────────────────────────────────┘
  ┌─ Integration (fixture replay through the real agent) ────┐
  │  packages/agents/*/scripts/replay-fixture.ts             │  4 of 5
  │  FixtureModelProvider → runAgentLoop → assert shape+text  │  agents
  └───────────────────────────────────────────────────────────┘
  ┌─ Unit (node --test on built dist) ───────────────────────┐
  │  20 *.test.ts files, ~80 cases                           │  the base
  │  evals · runtime · tools · context · prompts · workflows  │
  │  providers · agents · core re-export surface              │
  └───────────────────────────────────────────────────────────┘
```

The pyramid is the right shape — wide unit base, a thin integration band, one E2E
cap. No inversion, no all-E2E flakiness. The runner is **Node's built-in test
runner** (`node --test dist/test/*.test.js`), not jest or vitest. Confirmed in
every package's `test` script: `npm run build && node --test dist/test/*.test.js`.
Tests run against *built* `dist`, so a type error fails the test run before a
single assertion executes — the compile is the first gate.

## The spine — the replay loop

```
  Live, non-deterministic ─────────────────► Frozen, deterministic

  ┌─ live provider ─┐   ┌─ artifact ──┐   ┌─ eval ──────┐   ┌─ promoted ──┐
  │ OpenAI/Anthropic│──►│ *.json in   │──►│ shape +     │──►│ fixture     │
  │ replay:model    │   │ artifacts/  │   │ secret scan │   │ (frozen)    │
  │ (real tokens)   │   │ replays/    │   │ eval:replays│   │ promote:    │
  └─────────────────┘   └─────────────┘   └─────────────┘   │ replay      │
                                                            └──────┬──────┘
                                                                   │ replay:promoted
                                                                   ▼
                                                          deterministic
                                                          regression test
                                                          (no model call)
```

Read it left to right: you spend real tokens *once* to capture how the model
behaved, prove the capture is well-formed, then freeze it. From then on the test
replays the frozen responses — same input, same output, every CI run, zero tokens,
zero flakiness. This is the golden-master pattern adapted to an LLM. The deep walk
is `03-promote-to-fixture-baseline.md`.

## What's solid, what's thin (the headline)

**Solid:**
- The eval seam (`packages/evals/`) is the best-tested code in the repo — 14 cases
  across structural-diff, detection-scorer, rubric-judge, replay-runner.
- Every agent has a deterministic unit test that swaps in a scripted/fixture
  provider. No agent test calls a live model.
- The provider seam is tested at the boundary: fallback chain, context-window
  guard, structured-generation retry all have direct tests.

**Thin / missing (full detail in `audit.md`):**
- `runAgentLoop` — the bounded agent loop, the single most load-bearing function
  in the repo — has **no direct unit test**. It's only exercised transitively.
- `rubric-improvement` has a unit test but **no fixture replay and no promoted
  baseline** — the only agent left out of the regression loop.
- **No CI test gate.** The only workflow is `publish-core.yml`; it does not run
  `npm test`, `eval:replays`, or the Playwright smoke. Tests are local-only.
- Error/edge coverage is uneven: structured-generation and fallback test their
  failure branches well; the agents mostly test the happy path.

## Where to go next

`audit.md` walks all seven lenses with `file:line` grounding. The numbered files
deep-dive the five patterns the repo exercises deliberately enough to name.
