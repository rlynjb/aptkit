# Pass 1 — the testing audit (7 lenses)

The risk map, not the coverage percentage. Each lens is walked against the real
suite with `file:line` grounding. Lenses that find nothing get `not yet exercised`
with a buildable target. Worst-first inside each lens.

The inventory of what exists: **20 `*.test.ts` files, ~80 `node --test` cases**, one
Playwright spec (7 tests), four agent fixture-replay scripts, and the eval seam in
`packages/evals/`. Runner is Node's built-in test runner over built `dist` — no
jest, no vitest. Confirmed: every package `test` script is
`npm run build && node --test dist/test/*.test.js`.

---

## 1. what-is-tested-and-what-isnt

The coverage map by risk, not by line count.

**Best-tested — the eval seam (`packages/evals/`).** This is correct prioritization:
the code that decides whether *other* code is correct is itself the most tested.
- `structural-diff.test.ts` — 3 cases, all six rule types + failure-path collection.
- `detection-scorer.test.ts` — 3 cases, full match / partial / unexpected.
- `rubric-judge.test.ts` — 4 cases, prompt build + validator + retry.
- `replay-runner.test.ts` — 4 cases, all four artifact types + invalid + empty.

**Well-tested seams.** The provider boundary, where failure originates:
- `packages/providers/fallback/test/fallback-provider.test.ts:1` — 4 cases incl.
  abort-doesn't-fallback and custom predicates.
- `packages/providers/local/test/context-window-guard.test.ts:1` — 4 cases incl.
  throw-before-touching-wrapped-provider.
- `packages/runtime/test/structured-generation.test.ts:1` — 6 cases incl. retry,
  exhaustion, abort-vs-bad-JSON.

**The biggest gap — `runAgentLoop` has no direct test.** `packages/runtime/src/run-agent-loop.ts`
is the bounded agent loop: the single most load-bearing function in the repo
(it owns the turn budget, the tool-dispatch cycle, the trace emission). Confirmed
no test file references `runAgentLoop` directly. It's exercised only transitively
through agent tests (e.g. `recommendation-agent.test.ts:106`). So the loop's own
boundary conditions — maxTurns hit, tool throws mid-loop, empty model response —
are never asserted in isolation.
- **The move:** add `packages/runtime/test/run-agent-loop.test.ts` driving a
  `ScriptedModelProvider` that forces (a) maxTurns exhaustion, (b) a tool handler
  that throws, (c) a model response with no tool_use and no parseable JSON. Assert
  the loop terminates and emits the right `CapabilityEvent` sequence each time.

**Untested support modules.** `validate.ts` and `schema-summary.ts` in the anomaly
and diagnostic agents have no dedicated test (only exercised through the agent
happy path). `categories.ts` (the 10 anomaly categories) is data, low risk.

→ The risk inversion: the eval utilities (lower blast radius) are exhaustively
tested; `runAgentLoop` (highest blast radius — changing it ripples to every agent)
is tested only by accident of its callers. Close that one gap first.

---

## 2. test-design-and-levels

The pyramid, as-built — and it's the right shape. See `00-overview.md` for the
diagram. Wide unit base (~80 cases), thin integration band (4 fixture-replay
scripts), one E2E cap (7 Playwright tests). No inversion.

**Mocking is honest, not over-done.** The agent tests don't mock the agent — they
inject a fake `ModelProvider` at the one real seam and run the *actual* agent loop,
the *actual* tool registry, the *actual* JSON parser. Example:
`recommendation-agent.test.ts:42` builds a `ScriptedModelProvider` with two real
`ModelResponse` objects, wires a real `InMemoryToolRegistry`
(`recommendation-agent.test.ts:85`), and asserts on real agent output
(`recommendation-agent.test.ts:108`). That's testing the code, not the mock.

**One design wrinkle: two implementations of the same seam.** The unit tests define
an inline `ScriptedModelProvider` class (`recommendation-agent.test.ts:128`,
`query-agent.test.ts:72`, `rubric-judge.test.ts:51`) while the replay scripts use
the package `FixtureModelProvider` (`packages/agents/query/src/fixture-provider.ts:3`).
They are byte-for-byte the same idea — replay a `ModelResponse[]` array by index,
throw when exhausted. The inline copies exist because the test predates or sits
beside the shipped class. Not a bug, but the duplication means a fix to replay
semantics (say, supporting `signal` abort mid-replay) has to land in five places.
- **The move:** export `FixtureModelProvider` from a shared test util and delete the
  inline copies. Low priority — the duplication is stable — but worth a note.

→ See `01-replay-as-test.md` for the deep walk on this seam.

---

## 3. tests-as-design-pressure

Where the code is easy or hard to test, and what that says about the design.

**Easy to test = clean injection.** Every agent constructor takes `model`, `tools`,
`workspace`, and `trace` as explicit options (`recommendation-agent.test.ts:98`).
Nothing reaches for a global, a singleton, or `process.env` inside the hot path.
That's why the tests are short: no elaborate setup to reach the code under test.
This is a deep-module / dependency-injection win — the design *is* the testability.
The full treatment is a `study-software-design` finding; referenced, not re-audited.

**One spot of test friction: tests must build first.** Because `test` is
`npm run build && node --test dist/test/*.test.js`, you cannot run a single test
against source — the whole package compiles first. For a fast inner loop this is
friction (a one-line test change costs a full `tsc -b`). It buys type-checking as a
gate, which is the right trade for a published library, but it means nobody runs
tests in a tight TDD loop. Accepted cost, named honestly.

**No untestable tangle found.** There's no code that needs a live network, a real
clock, or a database to reach — the provider seam and the in-memory tool registry
absorb all of it. That absence is itself the finding: the architecture earned its
testability.

---

## 4. determinism-isolation-and-flakiness

The axis that matters most for an LLM repo. AptKit's entire testing thesis is
*manufacture determinism around a non-deterministic core.*

**The unit + fixture tiers are fully deterministic.** No agent test calls a live
model. Every model response is either inline-scripted or loaded from a fixture
JSON and replayed by index (`query-agent.test.ts:10` loads
`revenue-by-state-query.json` and feeds `fixture.modelResponses`). Replay is
index-based and total: `FixtureModelProvider` throws
`fixture model exhausted after N responses`
(`packages/agents/query/src/fixture-provider.ts:15`) if the agent asks for one more
turn than recorded — so a behavior change that adds a turn fails loudly instead of
silently hanging. → deep walk in `01-replay-as-test.md`.

**Time and ordering are handled.** Where a timestamp is needed, the artifact carries
an explicit ISO `createdAt` that the eval validates with `Date.parse`
(`packages/evals/src/assertions.ts:87`) rather than comparing to `Date.now()`. File
listing is sorted for determinism: `listReplayArtifacts` sorts entries
(`packages/evals/src/replay-runner.ts:43`) and the test asserts the sorted order
(`replay-runner.test.ts:31`). The temp-dir tests use `mkdtemp`
(`replay-runner.test.ts:26`) so they're isolated per run — no shared-state ordering
bug.

**The one place flakiness can enter: Playwright.** The E2E spec waits on real UI
state. It's written defensively — `expect.poll` on the run counter
(`tests/studio/studio-smoke.spec.ts:67`) rather than a fixed sleep, and a 5s
`expect` timeout (`playwright.studio.config.ts:7`). `trace: 'retain-on-failure'`
(`playwright.studio.config.ts:13`) keeps a Playwright trace for post-mortem. The
risk isn't the assertions, it's the dev server: `webServer` boots Vite on port 4187
with a 30s timeout (`playwright.studio.config.ts:15`). If the build is cold, that
boot can race the timeout on a slow machine. Low frequency, real possibility.
- **The move:** if it ever flakes, raise the `webServer.timeout` and pre-build the
  Studio app in CI before the smoke step.

→ Determinism is the headline strength of this suite. The fixture replay is the
mechanism; `01-replay-as-test.md` is the deep dive.

---

## 5. edge-cases-and-error-paths

The happy path is well-covered. Error branches are covered *unevenly* — strong in
the runtime/provider layer, thin in the agents.

**Strong error coverage:**
- structured-generation retries on bad JSON, returns structured failure on
  exhaustion, and *throws* on abort instead of converting cancellation into bad
  JSON (`structured-generation.test.ts` — the abort case is the subtle one and it's
  tested).
- fallback throws `ProviderFallbackError` when every provider fails and does NOT
  fall back on abort (`fallback-provider.test.ts`).
- context-window guard throws before touching the wrapped provider when the request
  is too large (`context-window-guard.test.ts`).
- The structural-diff evaluator has a dedicated failure-path test asserting the
  exact `issues[].path` list for six simultaneous rule failures
  (`structural-diff.test.ts:43`).
- The rubric validator rejects bad verdict and out-of-range score
  (`rubric-judge.test.ts:96`).
- The replay runner reports invalid artifacts without throwing
  (`replay-runner.test.ts:63`) and returns a clean empty report for zero paths
  (`replay-runner.test.ts:71`).

**Thin error coverage — the agents.** The agent unit tests assert the happy path
(valid model output → valid recommendation/answer/diagnosis). What's NOT tested:
- model returns malformed JSON that the agent can't parse (the agent's own recovery,
  distinct from the runtime's `generateStructured` retry).
- a tool handler throws mid-loop (only `unsafe_write` throwing-if-called is set up
  as a guard at `query-agent.test.ts:60`, but it's asserting it's *not* advertised,
  not testing recovery when a real tool throws).
- empty results (anomaly agent returning `[]` — the assertion exists in
  `assertAnomalyShape` at `assertions.ts:20` but no agent test drives it).
- **The move:** one error-path case per agent: feed the scripted provider a
  malformed final turn and assert the agent surfaces a clean failure rather than
  throwing an unhandled exception.

**Boundary values that ARE tested:** query answer length floor (`assertQueryAnswerShape`
rejects < 20 chars, `assertions.ts:52`, tested at `query-agent.test.ts:50`),
empty-array anomaly shape, numeric tolerance in structural diff
(`structural-diff.test.ts:32`).

---

## 6. testing-ai-features

The standout lens. This is where AptKit earns the study. The repo wraps a
non-deterministic core in a deterministic harness at four levels.

**Level 1 — the provider seam is the test seam.** Every agent depends on
`ModelProvider.complete()` and nothing else from the model. Swap the live provider
for a `FixtureModelProvider` and the entire agent becomes deterministic with zero
code change. This is the load-bearing move. → `01-replay-as-test.md`.

**Level 2 — structural shape assertions, not string equality.** You can't assert an
LLM's prose equals a fixed string. So the eval asserts *shape*: required paths
exist, arrays have the right count, text contains a substring
(`packages/evals/src/structural-diff.ts:20`, the six-rule evaluator). The
artifact-shape assertions (`assertRecommendationShape`, `assertAnomalyShape`,
`assertDiagnosticShape`, `assertQueryAnswerShape` in `assertions.ts`) pin the
contract without pinning the content. → `02-structural-shape-assertions.md`.

**Level 3 — detection scoring (matched/missed/unexpected).** The anomaly detector's
output is scored against expected categories/metrics/scopes/severities, producing a
fractional `score` plus `matched`/`missed`/`unexpected` lists
(`packages/evals/src/detection-scorer.ts:29`). This is the half-step from
deterministic assertion toward probabilistic eval — it tolerates partial correctness
and reports degree. → `04-detection-scoring.md`.

**Level 4 — rubric LLM-as-judge.** `RubricJudge` (`packages/evals/src/rubric-judge.ts:72`)
uses a *second* model call to score prose quality against a rubric. This is
genuinely probabilistic evaluation — the deep "why score instead of assert" teaching
belongs to `study-ai-engineering`. But the *deterministic* parts ARE tested here:
the prompt builder (`buildRubricJudgeSystemPrompt`, tested at `rubric-judge.test.ts:86`),
the output validator (`createRubricJudgmentValidator`, tested at
`rubric-judge.test.ts:96`), and the retry-on-malformed path
(`rubric-judge.test.ts:156`) all run against a scripted provider. The seam where
testing hands off to evaluation is exactly here.

**The promote-to-fixture lifecycle ties it together.** `eval:replays` validates a
saved live-run artifact (`scripts/eval-replay-artifacts.mjs`), `promote:replay`
freezes a good one into a baseline (`scripts/promote-replay-to-fixture.mjs`), and
`replay:promoted` regression-tests against the frozen baseline. →
`03-promote-to-fixture-baseline.md`.

**Red flag check — is any LLM seam untested at the boundary?** Mostly no. Prompt
assembly is tested (rubric, prompt packages). Output parsing is tested
(`parseAgentJson` at `recommendation-agent.test.ts:122`, structured-generation).
Tool dispatch is tested transitively. The one boundary NOT directly tested is the
agent loop's own dispatch/termination logic — see lens 1, `runAgentLoop`.

---

## 7. testing-red-flags-audit

Consolidated checklist against this repo. ✓ = clean, ✗ = present, ⚠ = partial.

```
  ✓  Inverted pyramid (all-E2E)            — no; wide unit base, 1 E2E spec
  ✓  Tests that test the mock              — no; agents run real loop+registry
  ✓  Flaky time/network/ordering deps      — no; replay+sorted+mkdtemp+explicit ISO
  ✓  Happy-path-only on the eval seam      — no; failure paths exhaustively tested
  ✗  Most load-bearing code least tested   — YES; runAgentLoop has no direct test
  ✗  No CI test gate                       — YES; only publish-core.yml, runs no tests
  ⚠  Error paths on the agents             — thin; agents test happy path mostly
  ⚠  One capability outside the loop       — rubric-improvement: no fixture/promoted
  ⚠  Duplicated test seam                  — inline ScriptedModelProvider ×3 + class
```

### ✗ No CI test gate — the highest-leverage fix

`.github/workflows/` contains only `publish-core.yml`. It does not run `npm test`,
`npm run eval:replays`, or `npm run smoke:studio`. Confirmed: no `npm test` /
`node --test` / `eval:replays` / `smoke` step anywhere in the workflows. So the
entire deterministic suite — the thing this whole guide is about — runs only when a
human remembers to run it locally. A regression can be published.
- **The move:** add a `test.yml` workflow that runs `npm ci`, `npm test --workspaces`,
  `npm run eval:replays`, and `npm run smoke:studio` on PR. The suite is already
  deterministic and CI-safe (no live model, no secrets needed for the fixture
  tiers) — it's ready to be gated; nobody wired the gate.

### ⚠ rubric-improvement is outside the regression loop

`packages/agents/rubric-improvement` has a unit test
(`rubric-improvement-agent.test.ts`, 3 cases) but **no `replay:fixture` script, no
`replay:promoted` script, and no promoted fixture** — confirmed: its `package.json`
has only a `test` script, unlike the other four agents which each have
`replay:fixture`. Its `fixtures/brief-quality-actionability.json` exists but nothing
replays it in the pipeline. So the one agent whose entire job is *quality judgment*
is the one agent without a deterministic quality-regression baseline.
- **The move:** add `scripts/replay-fixture.ts` + a `replay:fixture` / `replay:promoted`
  pair mirroring the query agent, then promote a reviewed run.

### ✗ runAgentLoop untested — see lens 1.

### Note on recommendation's wiring (a quiet good)

`recommendation`'s `test` script appends the promoted-fixture replay:
`... && node ../../../scripts/replay-promoted-fixtures.mjs --count recommendationCount`.
So for the recommendation agent, the golden-master regression runs *as part of
`npm test`*. The other three agents (monitoring/diagnostic/query) have standalone
`replay:promoted` scripts that are NOT in their `test` script — so their baselines
only run when invoked explicitly. Inconsistent; recommendation's pattern is the one
to copy.
