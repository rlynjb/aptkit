# Overview — the testing system in one page

Before the lenses, the shape. AptKit's test suite has three tiers and one spine.
The spine is the **replay loop**: live run → artifact → eval → promote → deterministic
replay. Everything else hangs off it.

## The test pyramid, as built

```
  AptKit's pyramid — wide deterministic base, one E2E cap

  ┌─ E2E (Playwright, port 4187) ────────────────────────────┐
  │  tests/studio/studio-smoke.spec.ts                       │  7 tests
  │  6 cards navigate · fixture run bumps counter · panels    │  1 file
  │  show — RAG card NOT covered (gap, see audit lens 4)      │
  └───────────────────────────────────────────────────────────┘
  ┌─ Integration (fixture replay through the real agent) ────┐
  │  packages/agents/*/scripts/replay-fixture.ts             │  4 of 6
  │  FixtureModelProvider → runAgentLoop → assert shape+text  │  agents
  └───────────────────────────────────────────────────────────┘
  ┌─ Unit (node --test on built dist) ───────────────────────┐
  │  30 *.test.ts files, ~128 cases                          │  the base
  │  evals · runtime · tools · context · prompts · workflows  │
  │  providers (incl. gemma) · retrieval · memory · agents    │
  │  (incl. rag-query) · core re-export surface               │
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
- The eval seam (`packages/evals/`) is the best-tested code in the repo — now ~26
  cases across structural-diff, detection-scorer, rubric-judge, replay-runner, and
  the new hand-computed precision@k / recall@k.
- Every agent has a deterministic unit test that swaps in a scripted/fixture
  provider. No agent test calls a live model.
- The provider seam is tested at the boundary: fallback chain, context-window
  guard, structured-generation retry all have direct tests.
- **The new RAG packages add a second isolation seam — the injectable transport.**
  `GemmaModelProvider` and `OllamaEmbeddingProvider` take their HTTP call as a
  constructor option, so the *real* provider decode (Gemma's tool-call emulation)
  runs against recorded bytes with no live Ollama. This is the new pattern worth
  studying → `06-injectable-transport.md`. The RAG packages also carry the repo's
  strongest error/boundary coverage (dimension guards, the minTopK floor, the
  hallucinated-filter case, precision@k not-well-formed branches).
- **`@aptkit/memory` is fully tested at the same injectable-store seam.** Five cases
  across two files (`packages/memory/test/`) drive the remember→recall round-trip,
  the kind-filter on a shared store, the dimension guard, and the `search_memory`
  tool through a real registry — all against `InMemoryVectorStore` + a deterministic
  fake embedder, no live Ollama. The store is injected, so the exact logic that runs
  with a `PgVectorStore` in production is what the tests exercise.

**Thin / missing (full detail in `audit.md`):**
- `runAgentLoop` — the bounded agent loop, the single most load-bearing function
  in the repo — still has **no direct unit test**. It's only exercised transitively
  (now by six agents, including the new `rag-query`).
- `rubric-improvement` AND `rag-query` have unit tests but **no fixture replay and
  no promoted baseline** — two agents left out of the regression loop.
- **No CI test gate.** The only workflow is `publish-core.yml`; it does not run
  `npm test`, `eval:replays`, or the Playwright smoke. Tests are local-only.
- **The new Studio RAG card is not smoked.** `RagQueryWorkspace` (the in-browser
  deterministic RAG runner, `agent-runners.ts:167`) is wired into the gallery but is
  absent from the Playwright `pages` list — the smoke covers six cards, not it. One
  missing card entry + one fixture-run case closes it (audit lens 4).
- Error/edge coverage is uneven by area: the runtime/provider layer and the new
  RAG packages test their failure branches well; the *legacy* agents
  (recommendation/monitoring/diagnostic/query) mostly test the happy path.
- The real-`fetch` transports (`defaultHttpTransport`) are exercised by nothing in
  the suite — live-only by design (see `06-injectable-transport.md`).

## Where to go next

`audit.md` walks all seven lenses with `file:line` grounding. The numbered files
deep-dive the five patterns the repo exercises deliberately enough to name.
