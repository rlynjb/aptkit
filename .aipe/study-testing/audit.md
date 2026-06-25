# Pass 1 — the testing audit (7 lenses)

The risk map, not the coverage percentage. Each lens is walked against the real
suite with `file:line` grounding. Lenses that find nothing get `not yet exercised`
with a buildable target. Worst-first inside each lens.

The inventory of what exists: **30 `*.test.ts` files, ~128 `node --test` cases**, one
Playwright spec (7 tests), four agent fixture-replay scripts, and the eval seam in
`packages/evals/`. Runner is Node's built-in test runner over built `dist` — no
jest, no vitest. Confirmed: every package `test` script is
`npm run build && node --test dist/test/*.test.js`, including the new
`@aptkit/memory` package (`packages/memory/package.json:21`).

The recent growth is the **personal-agent / RAG packages** — a Gemma provider, an
in-memory retrieval stack, a profile injector, a precision@k metric, a
`rag-query` agent, and now `@aptkit/memory` (retrieval-based episodic conversation
memory). They were built test-first, and they introduce a *second*
isolation seam below the existing provider seam: the **injectable transport** —
inject the HTTP call inside a provider so its real decode logic runs against
recorded bytes with no live Ollama. That's significant enough to earn its own
pattern file → `06-injectable-transport.md`. The new memory tests reuse the *same*
injectable seam at the store layer — `InMemoryVectorStore` + a deterministic fake
`EmbeddingProvider` — so the whole remember→recall round-trip is reproducible with
no live Ollama (`packages/memory/test/conversation-memory.test.ts:9`). The pg
integration tests for the vector store (DATABASE_URL-gated) live in a separate repo
(buffr) and are out of scope here.

---

## 1. what-is-tested-and-what-isnt

The coverage map by risk, not by line count.

**Best-tested — the eval seam (`packages/evals/`).** This is correct prioritization:
the code that decides whether *other* code is correct is itself the most tested.
- `structural-diff.test.ts` — 3 cases, all six rule types + failure-path collection.
- `detection-scorer.test.ts` — 3 cases, full match / partial / unexpected.
- `rubric-judge.test.ts` — 4 cases, prompt build + validator + retry.
- `replay-runner.test.ts` — 4 cases, all four artifact types + invalid + empty.
- `precision-at-k.test.ts` — 12 cases, hand-computed precision@k + recall@k incl.
  duplicate-id dedup, k>retrieved denominator, and the not-well-formed branches
  (k≤0, empty retrieved, empty relevant set). New; the ranked-retrieval metric for
  the RAG packages.

**Well-tested seams.** The provider boundary, where failure originates:
- `packages/providers/fallback/test/fallback-provider.test.ts:1` — 4 cases incl.
  abort-doesn't-fallback and custom predicates.
- `packages/providers/local/test/context-window-guard.test.ts:1` — 4 cases incl.
  throw-before-touching-wrapped-provider.
- `packages/runtime/test/structured-generation.test.ts:1` — 6 cases incl. retry,
  exhaustion, abort-vs-bad-JSON.
- `packages/providers/gemma/test/gemma-provider.test.ts:1` — 8 cases. The standout
  new provider test: it injects a fake `chat` transport so the *real* Gemma decode
  runs against a recorded blob. Covers messy-blob→tool_use decode (`:29`), outbound
  tool render into the system prompt (`:51`), retry-then-succeed (`:81`),
  give-up-after-maxToolCallAttempts (`:96`), no-retry-on-prose (`:112`), abort (`:126`),
  and unique tool_use id across turns (`:138`). → deep walk in `06-injectable-transport.md`.

**Well-tested — the retrieval stack (`packages/retrieval/`).** New, and tested at
each layer with an injected fake (no live Ollama):
- `in-memory-vector-store.test.ts` — 5 cases: cosine ranking order, k respect,
  upsert-replaces-not-duplicates, and dimension-mismatch throws on both upsert and
  search (`:46`, `:54`).
- `ollama-embedding-provider.test.ts` — 3 cases: nomic id + 768 dim, injected
  `embed` transport one-vector-per-text, abort forwarding (`:30`).
- `pipeline.test.ts` — 5 cases: chunk sizing + overlap, index→query round-trip
  ranks the planted chunk top, and the **dimension guard** —
  `createRetrievalPipeline` throws when `provider.dimension !== store.dimension`
  (`:74`), catching a wiring bug at construction instead of at query time.
- `search-knowledge-base-tool.test.ts` — 6 cases incl. registry round-trip with
  `durationMs`, `top_k` honored, the **minTopK floor** (a weak model passing
  `top_k:1` is lifted back to the floor so it can't starve its own retrieval,
  `:77`), exact-match meta filter, the **hallucinated-filter test** (an invented
  filter key absent from all chunks is ignored, not allowed to zero out results,
  `:105`), and `filterToolsForPolicy` selectability.

**Well-tested — conversation memory (`packages/memory/`).** New package, episodic
retrieval-based memory (`remember`/`recall` over an injected embedder + vector store).
Tested at the same injectable seam as retrieval — `InMemoryVectorStore` + a
deterministic dim-4 fake `EmbeddingProvider` keyed off keyword presence, so cosine
ranking is exact and the tests can't flake (`conversation-memory.test.ts:9`). Five
cases across two files, each pinning a real boundary:
- **remember→recall round-trip from a paraphrased query** — store two exchanges,
  recall with a *different* phrasing (`'which editor do I prefer'` vs the stored
  `'what editor do I use'`), assert the neovim row ranks first and carries its
  `conversationId` (`conversation-memory.test.ts:26`).
- **the kind-filter on a SHARED store** — the seam that makes memory safe to mix into
  the document corpus. Pre-seed the store with a foreign document chunk (no `kind`
  tag), remember one exchange, recall, and assert *every* hit's id starts with
  `memory:` — proving the over-fetch-then-filter logic
  (`conversation-memory.ts:97`) keeps document rows out of recall even when search
  itself has no metadata filter (`conversation-memory.test.ts:38`).
- **the dimension guard** — `createConversationMemory` throws when the embedder's
  dimension (4) disagrees with the store's (768), at construction
  (`conversation-memory.test.ts:51`, guarding `conversation-memory.ts:62`). Same
  wiring-bug-caught-early discipline as the retrieval pipeline's guard.
- **custom format + kind** — a non-default `kind:'episode'` and `format` produce the
  expected id (`episode:c9:0`) and rendered text, confirming the namespacing is
  driven by the option, not hard-coded (`conversation-memory.test.ts:56`).
- **the `search_memory` tool through a registry** — `createMemoryTool` wires into a
  real `InMemoryToolRegistry` and is called by name; asserts the recalled neovim row
  comes back in the `memories` payload (`memory-tool.test.ts:20`). Mirrors the
  `search-knowledge-base-tool` registry round-trip — the tool layer is tested the
  same way the document tool is.

What's NOT yet exercised in memory: no per-conversation counter collision test (the
`counters` map at `conversation-memory.ts:71` is exercised only implicitly via the
`:0` suffix in the custom-kind case), no empty-store recall returning `[]`, and the
`recall` `k`-slice/over-fetch math (`fetchK = max(k*4, 20)`,
`conversation-memory.ts:94`) is not driven with enough rows to prove the slice
actually trims. Low risk — buildable targets, not bugs.

**Tested — context + the rag-query agent.** `profile-injector.test.ts` (6 cases)
covers start/end placement, heading adjacency, and that the injected result still
renders via `renderPromptTemplate` with placeholders intact (`:61`).
`rag-query-agent.test.ts` (3 cases) runs the real `runAgentLoop` against a scripted
provider that emits a `tool_use` then prose: asserts the tool fired and the
synthesized answer came back (`:77`), the profile reached the system prompt (`:91`),
and uses `scorePrecisionAtK` to assert the Paris doc ranks first (`:106`).

**The biggest gap — `runAgentLoop` has no direct test.** `packages/runtime/src/run-agent-loop.ts`
is the bounded agent loop: the single most load-bearing function in the repo
(it owns the turn budget, the tool-dispatch cycle, the trace emission). Confirmed
no test file references `runAgentLoop` directly. It's exercised only transitively
through agent tests (now six of them, e.g. `recommendation-agent.test.ts:106` and
`rag-query-agent.test.ts:77`). So the loop's own boundary conditions — maxTurns
hit, tool throws mid-loop, empty model response — are still never asserted in
isolation. The new `rag-query` agent test adds another transitive caller but does
not close the direct gap.
- **The move:** add `packages/runtime/test/run-agent-loop.test.ts` driving a
  `ScriptedModelProvider` that forces (a) maxTurns exhaustion, (b) a tool handler
  that throws, (c) a model response with no tool_use and no parseable JSON. Assert
  the loop terminates and emits the right `CapabilityEvent` sequence each time.

**Untested support modules.** `validate.ts` and `schema-summary.ts` in the anomaly
and diagnostic agents have no dedicated test (only exercised through the agent
happy path). `categories.ts` (the 10 anomaly categories) is data, low risk. The
`rag-query` agent is unit-tested but has **no fixture-replay and no promoted
baseline** — like `rubric-improvement` it sits outside the golden-master loop
(its `package.json` has `ask`/`eval` scripts but no `replay:fixture`,
`replay:promoted`, or `fixtures/`). `chunker.ts`'s edge behavior is covered by
`pipeline.test.ts`, but the `defaultHttpTransport` real-`fetch` path in the Gemma
and Ollama providers is exercised by nothing in the suite — live-only by design
(see `06-injectable-transport.md`, "Where the seam stops").

→ The risk inversion: the eval utilities (lower blast radius) are exhaustively
tested; `runAgentLoop` (highest blast radius — changing it ripples to every agent)
is tested only by accident of its callers. Close that one gap first.

---

## 2. test-design-and-levels

The pyramid, as-built — and it's the right shape. See `00-overview.md` for the
diagram. Wide unit base (~128 cases across 30 files), thin integration band
(4 fixture-replay scripts), one E2E cap (7 Playwright tests). No inversion — the
RAG and memory packages grew the base, not the cap. (Note the cap did *not* grow
with the new RAG Studio card — see the smoke gap in lens 4.)

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

**A second, deliberate seam — not duplication.** The new RAG packages add a *finer*
isolation seam below the provider: inject the HTTP transport (`chat` on
`GemmaModelProvider`, `embed` on `OllamaEmbeddingProvider`) so the provider's own
decode logic runs against recorded bytes. This is not the same as the
`ScriptedModelProvider` duplication above — it's a different seam at a different
layer, and it earns its own pattern file because it tests code (Gemma's tool-call
emulation) that the coarse provider-swap seam can't reach. → `06-injectable-transport.md`.

→ See `01-replay-as-test.md` for the deep walk on the coarse provider seam.

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

**The new providers are deterministic at the wire.** `GemmaModelProvider` and
`OllamaEmbeddingProvider` both default to a real `fetch`-based transport but accept
an injected one in tests (`gemma-provider.test.ts:30`,
`ollama-embedding-provider.test.ts:18`). Every provider test feeds a recorded async
function, so no test opens a socket to Ollama — the provider decode runs for real
against frozen bytes. The retrieval embedders in the higher-level tests are
deterministic keyword/hash fakes (`pipeline.test.ts:18`,
`rag-query-agent.test.ts:22`), and the memory tests use the same kind of fake
(`conversation-memory.test.ts:9` — a keyword-keyed dim-4 embedder), so the whole
index/remember→query/recall→rank→answer path is reproducible with no live Ollama.
→ deep walk in `06-injectable-transport.md`.

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

**Smoke gap — the new RAG card isn't smoked.** Studio gained a `RagQueryWorkspace`
card backed by a deterministic-in-browser RAG runner (`runRagQueryFixtureReplay` in
`apps/studio/src/agent-runners.ts:167` — a *real* retrieval pipeline with the fake
embedder + `InMemoryVectorStore` + a recorded Gemma response replayed through the
loop), wired into the gallery (`apps/studio/src/main.tsx`,
`apps/studio/src/RagQueryWorkspace.tsx:21`). The Playwright spec does NOT cover it:
its `pages` list enumerates six cards
(`tests/studio/studio-smoke.spec.ts:3`) — recommendation, monitoring, diagnostic,
query, rubric-improvement, runtime-utilities — and there's no RAG (or memory) entry,
no `grep` hit for `rag`/`Rag`/`RAG`/`memory` anywhere in the spec. So the one Studio
card that runs a full retrieval+agent path in the browser is the one card with no
E2E assertion that it still opens, runs its fixture, bumps the counter, and renders
its answer panel. Honest read: **not yet exercised.**
- **The move:** add a `{ card: 'RAG Query Agent', heading: '…' }` entry to the
  `pages` array (covers the open/navigate path) plus one fixture-run case mirroring
  the Query test (`studio-smoke.spec.ts:71`) — click Run, poll the counter, assert
  the Answer panel renders. The runner is already deterministic, so the test is
  cheap; nobody added the card to the list.

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
- **The RAG packages test their error/boundary paths deliberately — the strongest
  new edge coverage in the repo.** Each one defends against a *weak local model*:
  - dimension-mismatch throws on upsert AND search
    (`in-memory-vector-store.test.ts:46`, `:54`), and the pipeline rejects a
    provider/store dimension mismatch at *construction* (`pipeline.test.ts:74`) —
    a wiring bug caught before any query runs.
  - the `minTopK` floor lifts a model's `top_k:1` back up so it can't starve its
    own retrieval (`search-knowledge-base-tool.test.ts:77`).
  - the hallucinated-filter case: an invented filter key absent from every chunk is
    *ignored*, not allowed to wipe all results
    (`search-knowledge-base-tool.test.ts:105`) — the matcher only excludes a hit
    that HAS the key with a different value (`search-knowledge-base-tool.ts:105`).
  - `scorePrecisionAtK` / `scoreRecallAtK` have explicit not-well-formed branches
    (k≤0, empty retrieved, empty relevant set) returning `{ok:false}` rather than
    NaN from a zero denominator (`precision-at-k.test.ts:37`, `:52`, `:96`, `:105`),
    plus a distinct-id dedup case (`:28`).
  - the Gemma provider gives up cleanly after `maxToolCallAttempts` and returns raw
    text instead of looping forever on un-parseable JSON
    (`gemma-provider.test.ts:96`), and rejects a pre-aborted signal (`:126`).
  - **conversation memory** mirrors the same discipline: the dimension guard throws
    at construction when embedder ≠ store (`conversation-memory.test.ts:51`), and the
    kind-filter boundary is tested directly — recall over a store that *also* holds a
    foreign document chunk returns only `memory:`-prefixed rows
    (`conversation-memory.test.ts:38`), proving the over-fetch-then-filter doesn't
    leak documents into recall.

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

**Level 0 — de-risk before scaffolding.** The riskiest assumption in the RAG work —
that Gemma2:9b, which has *no native tool-calling*, can be prompted to print a
parseable JSON tool call — was proven first in a throwaway spike
(`scripts/gemma-toolcall-spike.mjs`) that hits a live Ollama N times and runs the
exact `parseAgentJson` the real package will use, before any package or fixture
existed. That's the right order: find out if the seam is even possible for an hour
of live calls before building deterministic tests around it.

**Level 1 — the provider seam is the test seam.** Every agent depends on
`ModelProvider.complete()` and nothing else from the model. Swap the live provider
for a `FixtureModelProvider` and the entire agent becomes deterministic with zero
code change. This is the load-bearing move. → `01-replay-as-test.md`.

**Level 1.5 — the injectable transport (a finer seam, new).** For a provider that
is itself non-trivial — `GemmaModelProvider` has to *emulate* tool-calling because
Gemma has none — swapping the whole provider would skip the code worth testing. So
the new packages cut a seam one layer lower: inject the HTTP `chat`/`embed`
transport, run the *real* provider decode against recorded bytes. This is how the
single hardest piece of the RAG work — messy-blob→`tool_use` decoding — gets
direct coverage without a live Ollama (`gemma-provider.test.ts:29`). →
`06-injectable-transport.md`. The same injectable-store seam shows up once more in
`@aptkit/memory`: the engine's store is *injected*, so the remember→recall logic is
tested against `InMemoryVectorStore` + a fake embedder and is dimension-, kind-, and
ranking-correct with zero live calls (`conversation-memory.test.ts:9`). Production
swaps in a `PgVectorStore`; the logic under test is identical
(`conversation-memory.ts:48`).

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
  ⚠  Error paths on the agents             — thin; the legacy agents test happy path
                                             (the new RAG packages test theirs well)
  ⚠  Capabilities outside the loop         — rubric-improvement AND rag-query:
                                             unit-tested, no fixture/promoted baseline
  ⚠  Duplicated test seam                  — inline ScriptedModelProvider ×4 + class
                                             (rag-query adds another inline copy)
  ✓  LLM seam untested at the boundary     — no; Gemma decode tested at the wire
                                             via injectable transport (06-…)
  ✓  Live-network flakiness in unit tests  — no; transports injected, no Ollama call
  ⚠  New UI card unsmoked                  — YES; RagQueryWorkspace card has no
                                             Playwright entry (smoke covers 6 cards)
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

### ⚠ rag-query is also outside the regression loop (new)

`packages/agents/rag-query` ships with a solid unit test
(`rag-query-agent.test.ts`, 3 cases) and `ask` / `eval` scripts, but **no
`replay:fixture`, no `replay:promoted`, and no `fixtures/`** — confirmed against its
`package.json`. So like `rubric-improvement`, the newest agent has a unit test but
no frozen golden-master baseline. It's the natural next promotion target now that
the unit test exists; mirror the query agent's `replay-fixture.ts`.

### ⚠ Studio's RAG card is not in the smoke gate (new)

The Playwright `pages` list smokes six cards (`studio-smoke.spec.ts:3`); the new
`RagQueryWorkspace` (`apps/studio/src/RagQueryWorkspace.tsx`, runner
`agent-runners.ts:167`) isn't one of them. Same fix shape as any missing card: add
the entry plus one fixture-run case. See lens 4 → "Smoke gap." Distinct from the
agent-package gaps below — this is a UI E2E gap, not a fixture-replay gap.

### ✗ runAgentLoop untested — see lens 1.

### Note on recommendation's wiring (a quiet good)

`recommendation`'s `test` script appends the promoted-fixture replay:
`... && node ../../../scripts/replay-promoted-fixtures.mjs --count recommendationCount`.
So for the recommendation agent, the golden-master regression runs *as part of
`npm test`*. The other three agents (monitoring/diagnostic/query) have standalone
`replay:promoted` scripts that are NOT in their `test` script — so their baselines
only run when invoked explicitly. Inconsistent; recommendation's pattern is the one
to copy.
