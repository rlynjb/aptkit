# Study — Testing & Correctness · AptKit

The question this guide answers: **how do you know the code works — and will keep
working after the next change — when the most interesting part of the system is a
non-deterministic LLM?**

That last clause is the whole story for AptKit. Most of the repo is ordinary
deterministic TypeScript (a tool registry, a prompt renderer, a usage ledger) and
gets ordinary unit tests. But the agents call a model, and a model is not
deterministic — you cannot assert `equals` on its output. AptKit's answer is to
build a **deterministic harness around the non-deterministic core**: record the
model's responses once, replay them forever, and assert on the replay. That seam
is what makes this repo worth a testing study.

The recent RAG / personal-agent packages (a Gemma provider, a retrieval stack, a
profile injector, a precision@k metric, a `rag-query` agent, and `@aptkit/memory`)
push this further with a **second, finer isolation seam**: inject the HTTP transport
*inside* a provider — or the vector store *inside* the engine — so the real decode /
recall logic runs against recorded bytes and an in-memory store, with no live Ollama.
That's `06-injectable-transport.md` — the new pattern, sitting one layer below the
replay seam. `@aptkit/memory` is the latest instance: its store is injected, so the
remember→recall round-trip, the kind-filter on a shared store, the dimension guard,
and the `search_memory` tool are all tested with `InMemoryVectorStore` + a fake
embedder (`packages/memory/test/`, 5 cases). (The vector store's pg integration
tests, DATABASE_URL-gated, live in a separate repo, buffr, and are out of scope
here.)

## The seam that organizes everything

```
  Two kinds of correctness check — know which half you're in

  ┌─ DETERMINISTIC (this guide) ─────────────────────────────┐
  │  given a known input, assert a known output.             │
  │  node --test, equals, deepEqual, fixture replay.         │
  │  "did this break?" → red/green, no judgment call.        │
  └──────────────────────────────────────────────────────────┘
                            │  meets at the agent boundary
                            ▼
  ┌─ PROBABILISTIC (study-ai-engineering) ───────────────────┐
  │  given a live model output, is it good enough / did it   │
  │  regress? rubric LLM-as-judge, detection scoring.        │
  │  "is this good?" → a score, a verdict, not a hard equal. │
  └──────────────────────────────────────────────────────────┘
```

AptKit straddles the line on purpose. The structural-diff assertions, the fixture
replay, the Playwright smoke — all deterministic, all here. The rubric judge that
scores prose quality with another model call — that's probabilistic evaluation,
and the deep teaching of *why you'd score instead of assert* lives in
`study-ai-engineering`. This guide covers it only as a tested seam: the judge's
prompt assembly and output validation are deterministic and ARE tested here.

## Reading order

1. **`audit.md`** — the 7-lens audit. Start here. It's the risk map: what's tested,
   what isn't, where the gaps are, marked honestly. Every other file is a deep-dive
   on something the audit flags.
2. **`01-replay-as-test.md`** — the load-bearing pattern. `FixtureModelProvider`
   replays recorded `ModelResponse[]` so an agent test never calls a live model.
   Read this before anything else in Pass 2.
3. **`02-structural-shape-assertions.md`** — how you assert on LLM JSON without
   pinning exact strings: required-path + rule-based structural diff.
4. **`03-promote-to-fixture-baseline.md`** — the golden-master lifecycle: a live run
   becomes a saved artifact, gets eval'd, then gets promoted into a frozen
   regression baseline.
5. **`04-detection-scoring.md`** — matched/missed/unexpected scoring for the
   anomaly detector, the half-step from assertion toward evaluation.
6. **`05-playwright-smoke-gate.md`** — the one E2E test: does the Studio UI still
   wire up and run fixtures end to end?
7. **`06-injectable-transport.md`** — the newest pattern, from the RAG / Gemma
   packages: a *finer* isolation seam below the provider. Inject the HTTP transport
   so the real provider decode (Gemma's tool-call emulation, the embedder) runs
   against recorded bytes with no live Ollama. Read after `01` — it's the seam that
   sits one layer beneath it.

## Cross-links to other study guides

- **`study-ai-engineering`** — the probabilistic half: rubric judge as eval, the
  eval-set discipline, regression-by-score. This guide tests the harness; that one
  evaluates the model.
- **`study-data-modeling`** — replay artifacts and fixtures are this repo's data
  model, and here they double as test data. The artifact schema (`schemaVersion`,
  `trace`, `eval`, `modelTurns`) is the contract both guides lean on.
- **`study-system-design`** — the `ModelProvider` seam. The reason testing is
  cheap here is the same reason the architecture is clean: everything depends on
  `ModelProvider.complete()`, so the test swaps a fixture provider for a live one
  at exactly that seam.
- **`study-debugging-observability`** — `CapabilityEvent` traces are evidence. The
  same NDJSON trace that debugs a run is asserted on in tests (`events.map(e => e.type)`).
- **`study-software-design`** — "hard to test" as a design smell. AptKit's agents
  are easy to test *because* the provider is injected; that's a deep-module win
  covered there, referenced not re-audited here.
