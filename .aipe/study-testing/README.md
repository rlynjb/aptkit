# Study — Testing & Correctness (aptkit)

How do you *know* this code works — and will keep working after the next
change? A good suite tells you what a change broke before your users do. A
suite that doesn't is decoration. This guide audits aptkit's tests against
that bar.

The headline: aptkit's tests are unusually good for a one-person repo. Zero
test dependencies (`node --test`, the built-in runner), TDD throughout, and a
**single load-bearing design move** that makes everything testable — every
expensive seam (the model, the embedder, the vector store, the transport) is
an *injected contract*, so a fake slots in where production wires a real one.
The same `ModelProvider` boundary that buys provider-swap and fallback is what
lets a recorded Gemma reply replace a live `:11434` call in a unit test.

## The seam that organizes this whole guide: determinism

```
  The fault line — which half is a finding here vs in study-ai-engineering

  ┌─ TESTING (here) ─────────────────────────────┐
  │  assertion = "equals the expected value"      │
  │  given known input → assert known output      │
  │  unit · integration · contract · regression   │
  └───────────────────────────────────────────────┘
                      │  they MEET when you test an AI feature:
                      │  a deterministic harness wrapping a
                      ▼  probabilistic core
  ┌─ EVALUATION (study-ai-engineering) ──────────┐
  │  assertion = "good enough / didn't regress"   │
  │  non-deterministic model output, scored        │
  │  precision@k · LLM-as-judge · rubric scoring   │
  └───────────────────────────────────────────────┘
```

aptkit is interesting precisely because it sits on this fault line. The
`scorePrecisionAtK` / `RubricJudge` machinery is an *evaluation* tool — but
its own tests (`packages/evals/test/*`) are pure *testing*: known ranking,
known relevant set, precision computed by hand, `assert.equal(score, 2/3)`.
The eval logic is deterministic and unit-tested here; the model output it
scores is probabilistic and belongs to study-ai-engineering. Every finding
below states which half it's on.

## What's in this folder

- `audit.md` — Pass 1. The 7-lens audit. Walks coverage, levels, design
  pressure, determinism, error paths, AI-feature testing, and a red-flag
  capstone. Start here for the verdict.
- `01-injectable-transport-seam.md` — the kernel pattern. Every provider takes
  its I/O as a constructor arg (`chat`, `embed`, an array of providers), so
  tests feed recorded bytes with no network. This is why the suite has zero
  network dependencies.
- `02-fixture-replay-golden-master.md` — `FixtureModelProvider` replays
  recorded `ModelResponse[]` deterministically; promoted fixtures are
  timestamped correctness baselines. Regression-tests agent trajectories
  across model/prompt changes.
- `03-regression-test-from-a-real-bug.md` — the `{textContains}` hallucinated
  filter bug → a test asserting a hallucinated filter key returns non-empty.
  A real bug pinned by a named test.
- `04-deterministic-eval-scorers.md` — the testing half of the eval seam:
  precision@k, detection-scorer, structural-diff scored against hand-computed
  expected values. Where testing meets evaluation.
- `05-db-integration-serialized.md` — buffr's `PgVectorStore` tests run against
  real Postgres with `--test-concurrency=1` and a `skip` guard when
  `DATABASE_URL` is unset. The one true integration layer in the system.

## Reading order

1. `audit.md` — the map and the verdict.
2. `01` and `02` — the two patterns that make everything else testable.
3. `03`, `04`, `05` — the specific techniques worth naming.

## Cross-links to other guides

- **study-ai-engineering** — the *evaluation* half. The rubric-judge as
  LLM-as-judge, the eval-set design, precision@k as a retrieval metric (not
  as a unit-test assertion). This guide tests the scorers; that guide uses
  them to grade models.
- **study-software-design** — "hard to test" is a design smell there, not
  re-audited here. aptkit's testability is downstream of its deep-module /
  injected-contract design; lens 3 below cross-links rather than duplicates.
- **study-debugging-observability** — the `CapabilityEvent` trace that tests
  assert on (`events.map(e => e.type)`) is the same trace that powers Studio
  replay and NDJSON observability. Tests and observability share one stream.
