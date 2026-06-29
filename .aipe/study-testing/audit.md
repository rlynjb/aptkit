# Pass 1 — The 7-lens testing audit

One section per lens. Each names what aptkit actually does, grounded in real
files, or emits `not yet exercised`. Verdict-first; worst-first inside each
lens. Where a finding has a dedicated pattern file, this audit cross-links
rather than restating.

Scope note: aptkit has **30 source `.test.ts` files** (`packages/**/test/*.test.ts`,
verified by `find packages -path '*/test/*.test.ts'`) plus one Playwright smoke
spec (`tests/studio/studio-smoke.spec.ts`). Every package uses Node's built-in
runner — `grep -rl "node:test" packages` hits all of them. The integration
layer (real Postgres) lives in the companion repo **buffr**, not here.

---

## 1. what-is-tested-and-what-isnt

**The risk map, not the percentage.** What's the most important, most complex
code, and does it have tests?

```
  Coverage by risk — load-bearing code vs its test

  package / unit                      tested?   how
  ──────────────────────────────────  ───────   ─────────────────────────
  runAgentLoop (the spine)            ✗ DIRECT  only via agent tests
  GemmaModelProvider (tool emulation) ✓✓        gemma-provider.test.ts (9 its)
  FallbackModelProvider               ✓✓        fallback-provider.test.ts
  ContextWindowGuardedProvider        ✓         context-window-guard.test.ts
  generateStructured (retry kernel)   ✓✓        structured-generation.test.ts
  InMemoryVectorStore (cosine)        ✓✓        in-memory-vector-store.test.ts
  retrieval pipeline (index/query)    ✓         pipeline.test.ts
  search_knowledge_base tool          ✓✓        search-knowledge-base-tool.test.ts
  conversation memory (remember/recall)✓✓       conversation-memory.test.ts
  eval scorers (precision/detect/diff)✓✓        evals/test/* (4 files)
  rubric judge (LLM-as-judge harness) ✓✓        rubric-judge.test.ts
  replay-runner (artifact eval)       ✓✓        replay-runner.test.ts
  each agent (6 capabilities)         ✓         <agent>-agent.test.ts each
  prompt render / profile inject      ✓         prompts.test.ts, profile-injector.test.ts
  workspace schemaSummary             ✓         workspace-summary.test.ts
  usage/cost ledger                   ✓         usage-ledger.test.ts
  ndjson stream helpers               ✓         ndjson-stream.test.ts
  Studio UI components                ✗         smoke only, no unit/component
```

**Verdict: coverage tracks risk well, with one glaring hole.** The riskiest
single piece of code — `runAgentLoop`, the bounded loop every agent depends on
— has no test of its own. `packages/runtime/test/` contains `ndjson-stream`,
`structured-generation`, and `usage-ledger`, but no `run-agent-loop.test.ts`.

That matters because the loop holds the most subtle invariants in the repo:
the `maxTurns = 8` budget (`run-agent-loop.ts:87`), the `forceFinal` flag that
fires on the last turn or when the token budget is spent
(`run-agent-loop.ts:102`), and abort propagation. Those are exactly the
"unknown-unknowns" a regression would hide in. They're covered transitively —
`recommendation-agent.test.ts` runs the loop end to end and asserts the exact
trace sequence (`['model_usage','tool_call_start','tool_call_end','model_usage','step']`)
— but transitive coverage doesn't pin the boundary (what happens at turn 8
exactly? when budget is spent mid-loop?). **The move: add
`run-agent-loop.test.ts` that drives the loop with a scripted provider and
asserts the turn cap, the forced-final turn, and abort mid-loop.**

The other honest gap is Studio: no component or unit tests, only the smoke
spec (lens 2). For a manual preview tool that's a defensible call — but it
means a broken `RagQueryWorkspace` render only surfaces if the smoke spec
happens to click into it.

---

## 2. test-design-and-levels

**The pyramid as-built.**

```
  The pyramid

         ╱╲          E2E: 1 file, 7 Playwright tests
        ╱  ╲         (studio-smoke.spec.ts) — clicks cards,
       ╱    ╲        asserts headings + run-counter increments
      ╱──────╲
     ╱        ╲      INTEGRATION: real Postgres, but in buffr,
    ╱          ╲     skipped without DATABASE_URL. Zero in aptkit.
   ╱────────────╲
  ╱   UNIT +     ╲   the body: ~29 files. fast, deterministic,
 ╱   CONTRACT     ╲  network-free. mix of pure-function unit and
╱──────────────────╲ contract/replay (fake provider → real agent)
```

**Verdict: a healthy pyramid, not inverted.** The base is wide and fast; e2e
is thin and used only where it earns its place (a click-through smoke for a
manual UI). No suite of slow brittle browser tests pretending to be unit tests.

**No over-mocking.** The thing that usually rots a unit suite — mocks that
test the mock — is mostly absent here, and the reason is structural. The fakes
aren't `jest.mock()` stubs of internal calls; they're real implementations of
the *same public contract* production uses. `ScriptedProvider` and
`FixtureModelProvider` both `implements ModelProvider`
(`recommendation-agent.test.ts:128`, `fixture-provider.ts:3`). The fake
embedder in `search-knowledge-base-tool.test.ts:14` is a real
`EmbeddingProvider` — a keyword hash, but a genuine embed function. So the test
exercises the real agent loop, real tool registry, real cosine ranking; only
the *byte source* (model output, embedding vector) is swapped. That's contract
testing, not mock theater. → `01-injectable-transport-seam.md`.

The one place the level is thin: the seam *between* aptkit's contracts and a
real backend. The `VectorStore` contract is unit-tested with `InMemoryVectorStore`
here and integration-tested with `PgVectorStore` in buffr — but nothing in
aptkit proves the two are interchangeable. The shared contract is the only
guarantee, and it's untested as a cross-repo invariant.

---

## 3. tests-as-design-pressure

**Where is code hard to test because the design is tangled?** Mostly: it isn't.
This is a study-software-design finding and is cross-linked, not re-audited
there.

**Verdict: the design is testable by construction, and that's the headline.**
The reason every expensive thing is fakeable is that aptkit never reaches for a
vendor SDK or a global; it depends on an *injected contract*. `GemmaModelProvider`
doesn't `import { Ollama }` and call it — it takes `chat` as a constructor arg
(`gemma-provider.test.ts:30`). `OllamaEmbeddingProvider` takes `embed`
(`ollama-embedding-provider.test.ts:18`). The agents take `{ model, tools,
trace }`. There is no singleton, no module-level client, no `process.env` read
in the hot path. That's the "deep module / inverted dependency" design paying
off as testability — the clean side of the smell.

**The one residual smell:** the global timestamp. `events.ts:31` calls
`new Date().toISOString()` to stamp every `CapabilityEvent`. It's the only
non-injected source of nondeterminism in `src`
(`grep -rn "new Date()\|Date.now()\|Math.random"` over non-test src returns
exactly one hit). Tests dodge it by asserting on `event.type` sequences, never
on `timestamp`. That works, but it means a test *can't* pin timestamp behavior
without monkeypatching `Date`. If timestamps ever become load-bearing (ordering,
dedup), inject a clock the way everything else is injected. Cross-link:
study-software-design treats "hard to test" as the smell; here it's a near-miss
that the rest of the design avoids.

---

## 4. determinism-isolation-and-flakiness

**Tests that depend on time, network, ordering, or shared state.** A flaky test
trains people to ignore red.

```
  Sources of nondeterminism — and how each is neutralized

  source            production            in tests
  ────────────────  ────────────────────  ──────────────────────────
  network (model)   Ollama :11434 / cloud  injected chat/providers fake
  network (embed)   Ollama nomic           injected embed fake
  embedding values  768-dim float vectors  keyword-presence hash (exact)
  model output      stochastic LLM          recorded ModelResponse[]
  tool_use ids      —                       counter: gemma-<name>-<n>
  wall-clock time   new Date() (events.ts)  not asserted on
  fs ordering       directory scan          listReplayArtifacts sorts
  DB shared state   one Postgres            beforeEach DELETE, concurrency=1
```

**Verdict: determinism is engineered, and the suite is effectively
flake-free.** Three deliberate choices stand out:

- **Fake embedders are keyword-presence hashes, not random.** `conversation-memory.test.ts:9`
  maps "neovim"→dim0, "coffee"→dim1, with a bias dim that keeps every vector
  non-zero. Cosine ranking is then *exact*, so `recall('which editor')` always
  returns the neovim row. No tolerance windows, no "usually passes."

- **Tool-use ids are a counter, not a UUID.** `gemma-provider.ts:111` builds
  `gemma-${name}-${this.toolUseCount}`. That's why
  `gemma-provider.test.ts:138` ("gives each decoded tool call a unique id
  across turns") can `assert.notEqual(a.id, b.id)` deterministically — a UUID
  would force the test to assert format instead of a concrete value.

- **Filesystem order is sorted, then asserted.** `replay-runner.test.ts:25`
  writes `b.json` then `a.json` and asserts the listing comes back `['a','b']`
  — `listReplayArtifacts` sorts, so directory-iteration order can't flake the
  test.

The DB layer (buffr) is the only place with real shared state, and it's
isolated correctly: `--test-concurrency=1` in the test script
(`buffr/package.json:8`) serializes the suite, `beforeEach` runs
`delete from agents.chunks where app_id = 'test'`
(`pg-vector-store.test.ts:19`), and the whole describe block is `skip`ped when
`DATABASE_URL` is absent (`pg-vector-store.test.ts:12`). → `05-db-integration-serialized.md`.

**The one ordering dependency to flag:** `ScriptedProvider` /
`FixtureModelProvider` return responses by an internal index that advances on
each `complete()` call (`fixture-provider.ts:13`). The test's correctness
depends on the agent calling the model in the exact order the fixture was
recorded. That's intended (it's how trajectory replay works), but it means a
prompt change that reorders model calls fails the replay — which is the point,
not a flake. It does throw a clear error on exhaustion
(`fixture model exhausted after N responses`), so a mismatch fails loud, not
silently.

---

## 5. edge-cases-and-error-paths

**Boundary values, empty/null, error branches.** The happy path is usually
tested; the rest often isn't.

**Verdict: error paths are treated as first-class — this is a strength.** The
suite tests failure as deliberately as success:

- **Abort.** Every provider that takes a signal has an abort test:
  `gemma-provider.test.ts:126` (rejects if already aborted),
  `ollama-embedding-provider.test.ts:30` (forwards signal to transport),
  `structured-generation.test.ts:157` (throws abort *instead of* converting
  cancellation into bad JSON — and asserts `model.requests.length === 0`, i.e.
  it never even called the model). `fallback-provider.test.ts:41` asserts an
  `AbortError` does *not* trigger fallback to the next provider.

- **Loud failure on dimension mismatch.** `in-memory-vector-store.test.ts:46`
  and `:54` both assert `/dimension/i` throws — the "one-way door" from
  context.md tested on both upsert and search. Same invariant tested in buffr's
  `PgVectorStore` (`pg-vector-store.test.ts:42`).

- **Retry then give up.** `gemma-provider.test.ts:81` retries one bad tool-call
  blob then succeeds; `:96` gives up after `maxToolCallAttempts` and returns raw
  text; `:112` asserts prose answers *don't* trigger a retry. `structured-generation.test.ts:115`
  exhausts retries and returns a structured failure with `trace.at(-1)?.type === 'error'`.

- **Zero-denominator / not-well-formed scoring.** `precision-at-k.test.ts:37`
  covers `k <= 0`, `:52` empty retrieval, `:105` empty relevant set — each
  returns `{ ok: false }` rather than `NaN`. The scorer's degenerate inputs are
  pinned.

- **Fallback exhaustion.** `fallback-provider.test.ts:26` asserts a
  `ProviderFallbackError` carrying the ordered attempt list when every provider
  fails.

The gap: `runAgentLoop`'s own error/termination branches (turn-cap hit,
budget-spent mid-loop) aren't pinned directly — see lens 1.

---

## 6. testing-ai-features

**The seam in practice: how the repo wraps a non-deterministic core in a
deterministic harness.** This is the most distinctive part of aptkit's testing
and the reason this lens is rich, not `not yet exercised`.

```
  The AI feature, split into deterministic vs probabilistic

  ┌─ DETERMINISTIC (tested here) ──────────────────────────────────┐
  │  prompt assembly    → assert system carries tool defs / profile │
  │  tool dispatch      → assert toolName, input, order             │
  │  output parsing     → parseAgentJson on prose-wrapped fences    │
  │  retry on bad JSON  → assert attempt count + warning trace      │
  │  fixture replay     → recorded ModelResponse[] → real agent      │
  │  eval scorers       → known input → hand-computed score          │
  └─────────────────────────────┬───────────────────────────────────┘
                               │  hands off the "is it good?" question to
                               ▼
  ┌─ PROBABILISTIC (study-ai-engineering) ─────────────────────────┐
  │  is the answer correct / grounded / non-circular?               │
  │  rubric-judge as LLM-as-judge, eval sets, replay diffs           │
  └─────────────────────────────────────────────────────────────────┘
```

**Verdict: the line is drawn in exactly the right place.** Every deterministic
seam of every LLM feature has a test:

- **Prompt assembly** is asserted, not assumed. `gemma-provider.test.ts:51`
  checks the offered tools get rendered into a `system` message so Gemma (which
  has no native tool-calling) can emulate it. `rag-query-agent.test.ts:91`
  asserts the injected profile lands in `model.lastSystem`. `rubric-judge.test.ts:86`
  asserts the rubric prompt is built generically (no hardcoded Dryrun
  dimensions — `assert.doesNotMatch(prompt, /D1 OBSERVATION/)`).

- **Output parsing** of messy model text is unit-tested directly:
  `recommendation-agent.test.ts:122` runs `parseAgentJson` on both a fenced
  ```` ```json ```` block and a `prefix {...} suffix` blob.
  `gemma-provider.test.ts:29` decodes a "messy blob" — prose wrapped around a
  fenced JSON tool call — into a clean `tool_use` block with input
  `{ location: 'Paris', unit: 'celsius' }`.

- **Tool dispatch** is asserted by trace: `recommendation-agent.test.ts:113`
  pins the full event sequence and asserts the unsafe write tool was *not*
  advertised (`model.requests[0].tools.length === 1`) — the least-privilege
  policy verified at the call boundary.

- **Fixture replay** regression-tests whole agent trajectories.
  → `02-fixture-replay-golden-master.md`.

- **The eval scorers** are the seam itself: deterministic logic
  (`scorePrecisionAtK`, `scoreDetections`, `evaluateStructuralDiff`,
  `RubricJudge`'s validator) unit-tested here with hand-computed expected
  values, then *used* against probabilistic output in study-ai-engineering.
  → `04-deterministic-eval-scorers.md`.

The honest seam handoff: `rubric-judge.test.ts` tests the *harness* around the
judge (prompt built, verdict validated, retry on malformed output, usage trace
emitted) with a `ScriptedProvider` returning canned judgments. It does **not**
test "does Claude actually judge Gemma well" — that's the probabilistic
question, and it correctly belongs to study-ai-engineering's eval discussion.

---

## 7. testing-red-flags-audit

Consolidated checklist, marked against this repo. The capstone.

```
  Red flag                                          aptkit
  ────────────────────────────────────────────────  ──────────────────────
  Most important code is least tested               ⚠ runAgentLoop untested
  Heavy mocking that tests the mock                  ✓ clear (contract fakes)
  Inverted pyramid (all e2e, slow, flaky)            ✓ clear (wide unit base)
  Tests depend on wall-clock time                    ✓ clear (timestamp unasserted)
  Tests depend on network                            ✓ clear (all I/O injected)
  Tests depend on run order                          ✓ clear (fs sorted; DB serialized)
  Flaky (pass/fail on rerun, no code change)         ✓ clear (determinism engineered)
  Zero tests on error/exception branches             ✓ clear (errors first-class)
  LLM feature untested at the boundary               ✓ clear (prompt/dispatch/parse tested)
  Shared mutable state across tests                  ✓ clear (DB beforeEach DELETE)
  No regression test after a real bug                ✓ clear (textContains filter)
  Promoted fixtures hand-edited                       ✓ clear (regenerated, not edited)
  UI logic untested                                  ⚠ Studio: smoke only, no unit
  Cross-repo contract untested                        ⚠ VectorStore swap unproven in CI
  Capability missing its replay guard                 ⚠ rubric-improvement no replay:promoted
```

**The four ⚠ items, ranked by leverage:**

1. **`runAgentLoop` has no direct test.** Highest leverage — it's the spine,
   it holds the subtlest invariants, and a regression there breaks every agent.
   Fix: a focused `run-agent-loop.test.ts` (turn cap, forced final, budget,
   abort). → lens 1.

2. **`rubric-improvement` is missing its `replay:promoted` script** in the root
   pipeline (noted in context.md; the other five agents have one). Its
   trajectory isn't golden-master-guarded like its siblings. Fix: wire the
   script so a prompt change to that agent is caught by replay like the others.
   → `02-fixture-replay-golden-master.md`.

3. **The `VectorStore` contract swap is unproven in aptkit CI.** `InMemoryVectorStore`
   (here) and `PgVectorStore` (buffr) share a contract that nothing tests as
   interchangeable. A method-signature drift would pass both repos' green suites
   and only break at integration. Fix: a contract test-suite both stores run
   against the same assertions. → `05-db-integration-serialized.md`.

4. **Studio has no component tests.** Lowest leverage (it's a manual preview
   tool) but worth naming: the smoke spec proves cards open and counters
   increment, not that any panel renders correct data. Acceptable for now.

Everything else is green. For a single-author repo this is an unusually
disciplined suite — the design choices (injected contracts, recorded fixtures,
hand-computed scorer expectations) are what buy that, and they're the patterns
documented in Pass 2.
