# Testing & Correctness — the audit (Pass 1)

The verdict first: this suite is **good** where it counts. The hard part of
testing an AI system is making a non-deterministic core deterministic enough
to assert against, and aptkit solves that with one move repeated everywhere —
inject the model behind a port (`ModelProvider`) and feed it recorded
responses. Every agent, every provider, every eval is fixture-able because of
that one seam. The suite is built on Node's built-in test runner
(`node --test`, zero deps), and 30 source test files
(`grep -rl "node:test" packages`, counting `test/*.test.ts` only) cover the
load-bearing contracts.

Where it's weak is honest and bounded: the bounded agent loop
(`runAgentLoop`) has no direct unit test, there are zero UI/component tests,
and the cross-repo `VectorStore` contract (aptkit's in-memory vs buffr's
pgvector) is `not yet exercised` by a shared contract test.

This file walks the 7-lens inventory. Significant patterns are cross-linked to
their Pass 2 file.

The seam that splits this guide from study-ai-engineering: **determinism.**
If the assertion is "equals the expected value," it's a test → here. If the
assertion is "is this model output good enough / did it regress," it's an
eval → study-ai-engineering. They MEET in aptkit constantly — a deterministic
harness (the fixture provider, the scripted provider) wrapping a probabilistic
core (Gemma, Claude, GPT). Each finding below states which half it is.

---

## 1. what-is-tested-and-what-isnt — the risk map

Not the percentage; the risk. Where would a silent break hurt most, and is
there a test standing guard?

```
  Risk map — critical paths vs test coverage

  ┌─ LOAD-BEARING CONTRACTS ──────────────┬─ guarded by ──────────────┐
  │  ModelProvider.complete() port        │  every provider test +    │
  │  (the swap/fallback/fixture seam)     │  every agent test (★★★)   │
  ├───────────────────────────────────────┼───────────────────────────┤
  │  EmbeddingProvider / VectorStore      │  in-memory-vector-store +  │
  │  (RAG + memory contracts)             │  pipeline + memory (★★★)  │
  ├───────────────────────────────────────┼───────────────────────────┤
  │  search_knowledge_base tool           │  search-knowledge-base-    │
  │  (hallucination-tolerant filter)      │  tool.test.ts (★★★)       │
  ├───────────────────────────────────────┼───────────────────────────┤
  │  Gemma tool-call emulation/decode     │  gemma-provider.test.ts   │
  │  (no native tool-calling)             │  9 cases (★★★)            │
  ├───────────────────────────────────────┼───────────────────────────┤
  │  structured-output parse + retry      │  structured-generation +  │
  │  (parseAgentJson)                     │  agent tests (★★)         │
  ├───────────────────────────────────────┼───────────────────────────┤
  │  runAgentLoop (bounded loop)          │  NO DIRECT TEST — only    │
  │  the orchestration kernel             │  transitive via 6 agents  │
  ├───────────────────────────────────────┼───────────────────────────┤
  │  Studio React UI (3 custom pages +    │  NO UNIT TEST — 1 repo-   │
  │  AgentReplayShell)                    │  level Playwright smoke   │
  ├───────────────────────────────────────┼───────────────────────────┤
  │  PgVectorStore ↔ InMemoryVectorStore  │  NO SHARED CONTRACT TEST  │
  │  cross-repo contract                  │  (not yet exercised)      │
  └───────────────────────────────────────┴───────────────────────────┘
```

**The good news, stated plainly.** The most important code — the
`ModelProvider` port and the retrieval contracts — is the *best* tested. That
is the right shape. The contracts that ripple across packages when changed
(`packages/runtime/src` provider types, `packages/retrieval/src` embedding +
store contracts) each have direct tests, and the agents that compose them have
fixture-driven tests on top.

**The red flag the lens looks for** — "the most important / most complex code
is the least tested" — is **partially present, in one spot.** `runAgentLoop`
(`packages/runtime/src/run-agent-loop.ts`) is the single most complex piece of
control flow in the repo: it's the bounded loop that drives model→tool→model
turns with a hard `maxTurns` budget. It has **no direct unit test.** It's
exercised only transitively, through the six agent tests
(`recommendation`, `anomaly-monitoring`, `diagnostic-investigation`, `query`,
`rubric-improvement`, `rag-query`) that all call into it via their
`ScriptedProvider`/`FixtureModelProvider`. That coverage is real — the loop's
happy path and tool-dispatch path are genuinely walked — but its own boundary
conditions (exactly hitting `maxTurns`, a tool throwing mid-loop, an empty
content response) have no test that targets *the loop* as the unit. → the fix
is named in lens 5.

The other two gaps are lower-risk by design: the Studio UI is a manual preview
harness (its job is to *show* traces, not own correctness), and the cross-repo
contract gap is structural — buffr lives in a separate repo, so a shared
contract test needs a home neither repo currently provides. Both are named
honestly in lenses 4 and 6.

---

## 2. test-design-and-levels — the pyramid as-built

The verdict: **a healthy pyramid with a deliberately thin top.** Wide base of
fast unit tests, a middle band of fixture-driven agent integration tests, and
a single smoke test at the e2e tip. No inverted pyramid, no slow flaky e2e
sprawl.

```
  The pyramid as-built

        ╱╲           e2e:  1 Playwright smoke (tests/studio/
       ╱  ╲                studio-smoke.spec.ts, 111 lines, port 4187)
      ╱────╲
     ╱      ╲        integration: 6 agent tests + buffr's 5 db-gated
    ╱  agent ╲       tests (real Postgres, --test-concurrency=1)
   ╱  + repo  ╲
  ╱────────────╲
 ╱   unit (~23) ╲    unit: contracts, scorers, parsers, providers,
╱────────────────╲   stores — pure, in-process, sub-second
```

**The base is real unit tests, not over-mocked theater.** The red flag here —
"heavy mocking that tests the mock, not the code" — is mostly **absent**, and
the reason is the design. Look at `in-memory-vector-store.test.ts:6`: it
upserts three vectors and asserts the aligned one ranks first by *actual cosine
score* (`Math.abs(hits[0].score - 1) < 1e-9`). It isn't mocking the store;
it's exercising the real cosine scan. Same for `precision-at-k.test.ts` — the
ranking and relevant set are fixed, and precision/recall are computed by hand
(`2/3`, `3/5`) and asserted exactly. These tests prove the code, not a stub.

**The "mock" in the agent tests is a test double, and it's the right kind.**
The scripted/fixture provider (`FixtureModelProvider`,
`packages/agents/recommendation/src/fixture-provider.ts:3`) isn't a mock of an
internal collaborator you'd normally distrust — it's a *fake* that replays
recorded `ModelResponse[]` deterministically through the real `ModelProvider`
port. The agent code under test runs unchanged; only the network boundary is
substituted. That's substitution at a genuine seam, not mock-the-thing-you're-
testing. → see `01-injected-model-port.md` for the full walk.

**The middle band is fixture-driven integration.** The six agent tests
(`recommendation-agent.test.ts`, etc.) wire a real `InMemoryToolRegistry`, a
real prompt package, the real `runAgentLoop`, and the real validator — only
the model is faked. So the test exercises the whole capability assembly
(prompt → loop → tool dispatch → parse → validate) end to end, deterministically.
`recommendation-agent.test.ts:113` even asserts the exact trace event sequence
(`model_usage`, `tool_call_start`, `tool_call_end`, `model_usage`, `step`) —
that's an integration assertion on the orchestration, not a unit stub.

**buffr's tests are the real-infrastructure integration band.** Across the repo
boundary, buffr's `test/pg-vector-store.test.ts` and `test/runtime.test.ts` run
against a **real Postgres** with `--test-concurrency=1`
(`buffr/package.json:8`), env-gated on `DATABASE_URL`
(`describe(..., { skip: url ? false : 'set DATABASE_URL to run' })`,
`buffr/test/pg-vector-store.test.ts:12`). Serial concurrency because they share
one database; gating because most checkouts won't have Postgres up. That's the
correct call for a test that touches a real stateful resource. (Integration
half of the determinism seam — the assertion is still "equals," but the
collaborator is real.)

**The thin top is deliberate, not neglect.** One Playwright smoke
(`tests/studio/studio-smoke.spec.ts`) boots the Studio dev server and checks
the UI renders + replays. No inverted pyramid. The cost accepted: UI behavior
beyond "it loads and replays" is unverified (lens 6).

---

## 3. tests-as-design-pressure — where testability reflects design

The verdict: **the design is testable because of one decision — dependency
inversion on every external boundary — and the suite is the proof the
boundary was drawn right.**

The standard reading is "hard-to-test code is a design smell" (cross-link:
study-software-design's deep-modules and the dependency-inversion finding).
aptkit shows the *inverse* — easy-to-test code as evidence of good design. Walk
the chain:

- **The model is a port, not an SDK call.** Nothing in the agents imports
  `@anthropic-ai/sdk` directly; they depend on `ModelProvider.complete()`. That
  single inversion is why `FixtureModelProvider` (18 lines,
  `recommendation/src/fixture-provider.ts`) can replace the entire network. If
  the agents called the SDK inline, you couldn't test them without a network or
  a heavyweight HTTP mock. → `01-injected-model-port.md`.

- **The transport is injected one level deeper, inside the provider.**
  `GemmaModelProvider` takes a `chat` transport in its constructor
  (`gemma-provider.test.ts:30`: `new GemmaModelProvider({ chat: async () => ... })`).
  So even the provider's *own* decode/retry logic is testable with recorded
  Ollama replies, no `:11434` running. This is the dependency-injection seam
  drawn at the right altitude — the provider owns the messy decode, the
  transport is swappable. → `02-injected-transport.md`.

- **Retrieval is two ports, and memory proves the boundary.** `EmbeddingProvider`
  and `VectorStore` are contracts; the tests inject a fake keyword embedder
  (`search-knowledge-base-tool.test.ts:14`, `rag-query-agent.test.ts:22`) so
  cosine ranking is exact and can't flake. The strongest design evidence: the
  memory engine (`conversation-memory.test.ts`) reuses those *same* two
  contracts with zero new test infrastructure — `remember` is the index path,
  `recall` is the query path. A boundary you can reuse for a second feature
  without new scaffolding is a boundary drawn at the right place.

**The red flag** — "a test that needs elaborate setup to reach the code" — is
**absent.** The heaviest setup in the suite is `seededPipeline()`
(`search-knowledge-base-tool.test.ts:32`): build a fake embedder, an in-memory
store, index two sentences. Five lines. No test in the repo needs a container,
a fixture server, or a mock framework to reach its subject — because the seams
are constructor parameters. (The one exception is buffr's db-gated tests, which
*need* Postgres by definition — and they gate honestly rather than mock it.)

---

## 4. determinism-isolation-and-flakiness — does red mean broken?

The verdict: **the suite is engineered for determinism, deliberately, and the
flakiness sources are designed out rather than tolerated.** A flaky suite
trains people to ignore red; this one shouldn't have that problem.

The four classic flakiness sources, checked against the repo:

```
  Flakiness source     → how aptkit removes it
  ─────────────────────────────────────────────────────────────
  network              → injected transport / fixture provider;
                         no test hits Ollama or a cloud API
  time / clock         → ids injected (idGenerator: () => 'rec-1',
                         recommendation-agent.test.ts:103); no
                         Date.now() in assertions
  randomness           → fake embedders are pure keyword-presence
                         functions; cosine ranking is exact
  shared state / order → each test builds its own store + registry;
                         buffr's stateful db tests run serial
                         (--test-concurrency=1)
```

**Network is the big one, and it's gone.** No test in the suite makes a network
call. The Gemma provider's tests feed recorded `gemma2:9b` replies through the
injected `chat` (`gemma-provider.test.ts:9`, the `recordedMessyToolCall`
constant). The embedders in retrieval/memory tests are deterministic keyword
functions — `search-knowledge-base-tool.test.ts:14` hashes words into a
fixed-dim vector; `rag-query-agent.test.ts:21` maps a 3-word vocab to a 3-dim
one-hot. Cosine similarity over those is exact, so `results[0].id === 'space#0'`
is a stable assertion, not a probabilistic one.

**Randomness in ids is injected out.** `recommendation-agent.test.ts:103`
passes `idGenerator: () => 'rec-1'` so the assigned recommendation id is
assertable. The Gemma provider generates unique tool-call ids
(`gemma-provider.test.ts:138` asserts `a.id !== b.id` across turns) — but the
test asserts *uniqueness*, not a specific value, so non-determinism in the id
itself doesn't make the test flaky.

**Ordering is controlled where state is shared.** Within aptkit every test
constructs fresh state (`new InMemoryVectorStore(3)`, `new InMemoryToolRegistry(...)`),
so order-independence is free. The one place shared state is real — buffr's
Postgres tests — runs serial via `--test-concurrency=1` (`buffr/package.json:8`).
That's the correct lever: don't pretend stateful db tests are isolated, just
serialize them.

**The red flag** — "passes/fails on rerun with no code change" — has **no
identified source** in the suite. The honest caveat: there's no flakiness
*detector* (no rerun-on-fail CI step, no `--test-shuffle`), so "no flaky tests"
is an inference from design, not a measured fact. → buildable target in lens 7.

---

## 5. edge-cases-and-error-paths — beyond the happy path

The verdict: **error paths are genuinely tested — this is a strength, not a
gap.** The suite consistently asserts the failure branch alongside the success
branch, which is rarer than it should be.

Walk the error-path coverage by package:

- **Provider retry + give-up.** `gemma-provider.test.ts` tests the *whole* retry
  ladder: an unparseable tool call retries then succeeds (`:81`), gives up after
  `maxToolCallAttempts` and returns raw text (`:96`), and a plain-prose answer
  does NOT trigger a wasteful retry (`:112`). Three branches of one mechanism,
  each asserted. It also tests abort: "throws if the request is already
  aborted" (`:126`).

- **Fallback chain failure modes.** `fallback-provider.test.ts` covers first-
  success (`:7`), all-providers-fail throwing `ProviderFallbackError` with the
  attempt list (`:26`), abort errors NOT triggering fallback (`:41`), and a
  custom `shouldFallback` predicate (`:57`). Every branch of the chain.

- **Context guard rejection.** `context-window-guard.test.ts:74` asserts the
  guard throws `ContextWindowExceededError` *before* touching the wrapped
  provider (`provider.calls === 0`) and emits a `warning` trace event. The
  error path is the point of the module, and it's tested.

- **Scorer well-formedness.** `precision-at-k.test.ts` is a model of boundary
  testing: `k <= 0` (`:37`), empty retrieval / zero denominator (`:52`),
  duplicate ids counted once (`:28`), `k` larger than retrieved length (`:19`).
  Each returns `{ ok: false }` rather than throwing or dividing by zero — and
  the test pins that.

- **Dimension mismatch fails loud.** Both `in-memory-vector-store.test.ts:46`
  and `conversation-memory.test.ts:51` assert a dimension-mismatch *throws*
  (`/dimension/i`). The one-way-door wiring error is tested as a hard failure.

- **The hallucination-tolerant filter.** `search-knowledge-base-tool.test.ts:105`
  tests that an invented filter key (`{ textContains: 'moon' }`) is *ignored*,
  not allowed to zero out results — this is a real bug→regression test (the
  pattern below).

**The fix for the lens-1 gap belongs here.** `runAgentLoop`'s error branches —
hitting `maxTurns` exactly, a tool handler throwing mid-loop, an empty-content
model response — are the untested boundary conditions. The buildable target:
add `packages/runtime/test/run-agent-loop.test.ts` with a `ScriptedProvider`
that returns one-more-tool-call-than-`maxTurns` and assert the loop terminates
at the budget; add a tool handler that throws and assert the loop emits an
`error`/`warning` event rather than hanging. The seam already exists — the loop
takes an injectable provider and registry — so the test is cheap to write.

**The red flag** — "zero tests on the error/exception branches" — is **the
opposite of true** for the providers, scorers, and stores. It's only true for
`runAgentLoop`'s own boundaries.

---

## 6. testing-ai-features — the deterministic harness around the probabilistic core

This is the lens that matters most for this repo, and aptkit's answer is the
spine of the whole suite. The verdict: **every deterministic boundary around
the LLM is tested as a test; the probabilistic model output itself is handed
off to evals.** That split is drawn cleanly.

```
  The determinism seam, in aptkit

  ┌─ DETERMINISTIC (tested HERE, study-testing) ──────────────┐
  │  prompt assembly   tool dispatch   output parsing         │
  │  (injectProfile)   (registry)      (parseAgentJson)       │
  │  fixture replay    decode/retry    structural-diff        │
  │  precision@k math  scorer well-formedness                 │
  └───────────────────────────┬───────────────────────────────┘
                              │  seam: "equals" vs "good enough"
  ┌─ PROBABILISTIC (handed to evals, study-ai-engineering) ───▼┐
  │  is the model's ANSWER good?  rubric-judge (LLM-as-judge)  │
  │  did the model REGRESS?       promoted-fixture golden mast.│
  └────────────────────────────────────────────────────────────┘
```

**The deterministic boundary is tested everywhere the model touches code:**

- **Prompt assembly** — `rag-query-agent.test.ts:91` asserts `injectProfile`
  put the profile string into the system prompt (`assert.match(model.lastSystem,
  /I prefer terse, data-first answers/)`). Pure string→string, fully
  deterministic, fully tested. Also `context/test/profile-injector.test.ts`.

- **Tool dispatch** — `recommendation-agent.test.ts:111` asserts the model was
  offered only the *allowed* tool (`tools.length === 1`, the least-privilege
  policy filtered out `unsafe_write_campaign`). The dispatch and policy are
  deterministic and tested.

- **Output parsing** — `parseAgentJson` extracts JSON from prose-wrapped model
  output; `recommendation-agent.test.ts:122` tests both fenced
  (` ```json ... ``` `) and inline (`prefix {...} suffix`) shapes. The model's
  output is messy and non-deterministic; the *parser* is deterministic and
  tested against recorded-messy inputs.

- **Tool-call decode/retry for a tool-less model** — `gemma-provider.test.ts`
  is the purest example. Gemma has no native tool-calling, so a tool call
  arrives as a fenced JSON blob inside prose. The provider decodes it into a
  clean `tool_use` block. The test feeds the recorded messy blob and asserts the
  clean decode. → `02-injected-transport.md`.

**Where it hands off to evals (study-ai-engineering's territory):**

- **LLM-as-judge** — `rubric-judge.test.ts` tests the *deterministic scaffolding*
  around the judge (prompt build `:86`, verdict/score validation `:96`, retry on
  malformed output `:156`) — but the actual judging (Claude scoring Gemma's
  output, anti-circular) is the probabilistic eval. The test pins the harness;
  the eval scores the model. This is the determinism seam *inside one module*.

- **Regression on model output** — promoted fixtures
  (`packages/agents/*/fixtures/promoted/*.json`) are timestamped golden masters
  of recorded `ModelResponse[]`. `replay:promoted` scripts replay them through
  the agent and assert the output count holds (`--count recommendationCount`).
  → `03-promoted-fixture-golden-master.md`.

- **Replay-artifact shape** — `replay-runner.test.ts` evaluates saved replay
  artifacts (`artifacts/replays/*.json`) for structural validity across all four
  analytics capability types, reporting bad artifacts without throwing (`:63`).

**The red flag** — "an LLM feature with no test at the boundary (prompt
assembly, tool dispatch, output parsing)" — is **absent.** Every one of those
deterministic boundaries has a test. That's the headline finding of this audit.

---

## 7. testing-red-flags-audit — the consolidated checklist (capstone)

Marked against this repo, worst-first.

```
  RED FLAG                                          VERDICT
  ───────────────────────────────────────────────────────────────────
  Most complex code is least tested                 PARTIAL — runAgentLoop
    (run-agent-loop.ts: no direct unit test,         has no direct test;
     only transitive via 6 agents)                    fix is cheap (lens 5)

  Heavy mocking that tests the mock                 ABSENT — fakes sit at
    not the code                                      real ports; real code
                                                      under test runs unchanged

  Inverted pyramid (all slow flaky e2e)             ABSENT — wide unit base,
                                                      1 deliberate smoke at tip

  Tests that depend on network/time/random          ABSENT in aptkit —
                                                      transport+ids injected,
                                                      embedders pure; buffr db
                                                      tests gated + serial

  Flaky tests (pass/fail on rerun, no change)       NO SOURCE FOUND — but no
                                                      detector either; "clean"
                                                      is inferred from design,
                                                      not measured

  Zero tests on error/exception branches            ABSENT — retry, give-up,
                                                      abort, dim-mismatch,
                                                      fallback-exhaustion,
                                                      scorer well-formedness
                                                      all tested

  Elaborate setup to reach the code                 ABSENT — heaviest setup is
                                                      5-line seededPipeline()

  No UI/component tests                              PRESENT (by design) — 0
                                                      unit tests on Studio; 1
                                                      Playwright smoke only

  Untested cross-repo contract                      PRESENT — PgVectorStore vs
                                                      InMemoryVectorStore share
                                                      VectorStore but no shared
                                                      contract test (not yet
                                                      exercised)

  Missing replay:promoted wiring                    PRESENT — rubric-improvement
                                                      has no replay:promoted
                                                      script (others do);
                                                      its golden-master path is
                                                      not yet exercised
```

**The three things to fix, ranked:**

1. **Write `run-agent-loop.test.ts`.** The loop is the orchestration kernel and
   the only complex-code/low-test mismatch in the repo. Target its own
   boundaries: `maxTurns` exactly hit, a tool throwing mid-loop, empty content.
   The injectable seam is already there; the test is cheap. Highest leverage.

2. **Add a shared `VectorStore` contract test.** aptkit's `InMemoryVectorStore`
   and buffr's `PgVectorStore` both implement `VectorStore`, but nothing asserts
   they agree on behavior (upsert-replaces-id, dimension-mismatch-throws,
   descending-cosine-order). A contract test suite parameterized over both
   implementations would pin the boundary that buffr depends on. Needs a home
   that can see both repos — currently `not yet exercised`.

3. **Wire `replay:promoted` for rubric-improvement.** Four analytics agents have
   the promoted-fixture regression path; `rubric-improvement` doesn't
   (`package.json` has no `replay:promoted` script). Its correctness-baseline
   path is `not yet exercised`. Low effort, closes the inconsistency.

**Not a fix — accept it:** the Studio UI has no unit tests. That's the right
call. Studio is a manual preview/replay harness whose job is to *display*
deterministic traces produced and tested upstream. The Playwright smoke
guards "it boots and replays." Adding component tests would test the harness,
not the product. Named, accepted, moving on.
