# Promoted-fixture golden master — regression on a non-deterministic core

**Industry name:** golden-master / snapshot regression testing, specialized as a
recorded-response replay. Type label: Industry standard (record-replay variant).

## Zoom out, then zoom in

This is where study-testing and study-ai-engineering MEET. The fixture replay
itself is deterministic (a test) but what it *guards against* is regression in a
non-deterministic core (an eval concern). aptkit promotes a recorded model run
to a permanent baseline.

```
  Zoom out — the record → promote → replay lifecycle

  ┌─ live run (probabilistic) ───────────────────────────────┐
  │  real model → agent → output + recorded ModelResponse[]   │
  └──────────────────────────┬───────────────────────────────┘
                             │ scripts/promote-replay-to-fixture.mjs
  ┌─ promoted fixture (frozen) ▼─────────────────────────────┐
  │  fixtures/promoted/<name>-promoted-<timestamp>.json      │
  │  ★ a correctness BASELINE — never hand-edited ★          │
  └──────────────────────────┬───────────────────────────────┘
                             │ replay:promoted (in `npm test`)
  ┌─ replay (deterministic) ──▼──────────────────────────────┐
  │  FixtureModelProvider replays it → agent → assert output  │
  │  holds (e.g. --count recommendationCount)                 │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** A live model run is recorded as `ModelResponse[]`. Once you've
eyeballed that the agent produced a *good* output, you "promote" the recording
to a timestamped fixture — a frozen baseline. From then on, `npm test` replays
that recording through the agent and asserts the output still holds. If a code
change to the agent (prompt assembly, parsing, validation) breaks the output,
the replay catches it. The question: *how do you regression-test an agent whose
upstream model is non-deterministic?* Freeze a known-good model recording and
re-run the deterministic agent against it forever.

## Structure pass

**Layers:** live recording → promoted baseline → deterministic replay.
**One axis — mutability / who may change this artifact:**

```
  Axis: who is allowed to change the artifact?

  ┌─ live artifact ─┐  seam   ┌─ promoted fixture ─┐
  │ regenerated each│ ═══╪══►  │ FROZEN baseline    │
  │ run (volatile)  │ (flips) │ regen via promote:  │
  └─────────────────┘         │ replay, NOT by hand │
                              └─────────────────────┘
```

The mutability axis flips at promotion: before, the artifact is volatile output
of a model run; after, it's a baseline that defines what "correct" means. That
flip is why the constraint "promoted fixtures are correctness baselines — editing
them changes test meaning" is load-bearing (project context, must-not-change).

## How it works

### Move 1 — the mental model

You know snapshot testing from frontend — Jest's `toMatchSnapshot()` records a
component's render and fails the next run if it changes. This is the same idea
with the snapshot moved to the *input* side. Instead of snapshotting the
agent's output, aptkit snapshots the model's *responses* (the volatile upstream)
and replays them, so the agent's output becomes reproducible and assertable.

```
  The pattern — snapshot the volatile input, replay it

  record:   real model → ModelResponse[] ──┐
                                            ▼ promote (once, after review)
  baseline: fixtures/promoted/...-<ts>.json
                                            │
  guard:    replay through agent ───────────┘ → assert output count/shape holds
```

### Move 2 — the walkthrough

#### Promotion is wired into the agent's `npm test`

Four analytics agents fold the promoted replay directly into their test script:

```jsonc
// packages/agents/recommendation/package.json
"test": "npm run build && node --test dist/test/*.test.js && node ../../../scripts/replay-promoted-fixtures.mjs --count recommendationCount",
"replay:promoted": "npm run build && node ../../../scripts/replay-promoted-fixtures.mjs --count recommendationCount"
```

So `npm test` runs the unit tests *and then* replays the promoted fixture and
asserts `recommendationCount` holds. A regression in the agent's parse/validate
that drops a recommendation fails the test run. The `--count <field>` is the
assertion: the deterministic agent, fed the frozen recording, must still produce
the same number of structured items.

#### The fixtures are timestamped and live in the package

```
  packages/agents/recommendation/fixtures/promoted/
    voucher-dropoff-w10-on-openai-promoted-2026-06-18-16-53-02.json
    voucher-dropoff-w10-on-openai-promoted-2026-06-18-17-20-55.json
  packages/agents/anomaly-monitoring/fixtures/promoted/
    sp-revenue-monitoring-fixture-promoted-2026-06-18-18-37-26.json
  packages/agents/diagnostic-investigation/fixtures/promoted/...
  packages/agents/query/fixtures/promoted/...
```

8 promoted fixtures across 4 agents. The timestamp in the filename is the
record-keeping: a promoted fixture is a moment-in-time good run, and you keep the
old ones rather than overwriting (the recommendation agent has two). Regenerated
via `promote:replay`, never hand-edited — editing one silently changes what
"correct" means.

#### The replay reuses the `01` fake

The replay path is the same `FixtureModelProvider` from `01` — the promoted JSON
is just a recorded `ModelResponse[]` loaded from disk instead of written inline
in a test. One seam, two entry points: inline arrays for unit tests, promoted
files for regression. `scripts/replay-promoted-fixtures.mjs` loads the fixture,
drives the agent, and checks the `--count` field.

#### The shape-validation layer underneath

`replay-runner.test.ts` (in `@aptkit/evals`) tests the machinery that validates
replay artifacts — across all four capability types (`recommendation`,
`monitoring`, `diagnostic`, `query`), asserting `checked === 4`, `failed === 0`,
and that an invalid artifact is *reported, not thrown* (`:63`). That's the
deterministic test of the regression infrastructure itself.

### Move 2 variant — the load-bearing skeleton

Kernel: **a frozen recording of a known-good model run + a deterministic replay
+ an output invariant the replay asserts.** What breaks without each:

- **Drop the frozen recording** → there's nothing to replay against; you're back
  to hitting a non-deterministic model in CI, which can't have a stable assert.
- **Drop the deterministic replay** → the recording is dead data; nothing
  re-runs the agent against it, so a regression goes uncaught.
- **Drop the output invariant** (the `--count` assert) → the replay runs but
  asserts nothing; it's exercise without verification.

Optional hardening: timestamping + keeping old fixtures (audit trail, not
correctness), and the shape-validator (`replay-runner`) that guards the artifact
format itself.

### Move 3 — the principle

To regression-test a system with a non-deterministic dependency, freeze the
dependency's output at a known-good moment and re-run the deterministic part
against it. The frozen recording converts "did the model do well today" (an
eval, unstable) into "does my code still handle the known-good model output" (a
test, stable). The promotion step is the human judgment that the recording *is*
good — after that, the machine guards it.

## Primary diagram

```
  Promoted-fixture golden master — full picture

  ┌─ once, with human review ─────────────────────────────────┐
  │  real model run → recorded ModelResponse[]                 │
  │         │ promote-replay-to-fixture.mjs                     │
  │         ▼                                                   │
  │  fixtures/promoted/<name>-promoted-<timestamp>.json  FROZEN│
  └──────────────────────────┬─────────────────────────────────┘
                             │ every `npm test` (4 agents)
  ┌──────────────────────────▼─────────────────────────────────┐
  │  FixtureModelProvider(loaded responses) → agent runs        │
  │     → assert --count <field> holds                          │
  │  + replay-runner validates artifact SHAPE (4 types)         │
  └─────────────────────────────────────────────────────────────┘
       regression in agent code → count drifts → test fails
```

## Elaborate

Golden-master testing comes from legacy-code refactoring (Feathers,
characterization tests): capture current behavior, then refactor freely with the
capture as a tripwire. aptkit applies it to the LLM era — the "behavior" being
characterized is the agent's deterministic processing of a fixed model output.

The honest gap (audit lens 7, fix #3): `rubric-improvement` has **no
`replay:promoted` script** — its `package.json` test is just
`build && node --test dist/test/*.test.js`, no promoted replay appended. The
other four analytics agents have it; rubric-improvement's golden-master
regression path is `not yet exercised`. Closing it is low effort: add the
`replay:promoted` script and append it to `test`, matching the recommendation
agent's shape.

## Interview defense

**Q: How do you regression-test an agent when the model that drives it is
non-deterministic?**
Promote a known-good recorded run to a frozen fixture, then replay that fixture
through the agent on every test and assert an output invariant (e.g. the
recommendation count). The model's output is frozen, so the agent's processing
becomes reproducible and a code regression shows up as drift.

```
  good run → freeze recording → replay forever → assert count holds
            (human reviews once)  (machine guards after)
```

Anchor: *promotion converts "did the model do well today" into "does my code
still handle known-good output" — eval to test.*

**Q: Why are promoted fixtures never hand-edited?**
Because the fixture *defines* correct. Editing it changes what the test
considers a pass — you'd be moving the goalposts and calling it green. They're
regenerated via `promote:replay` (a fresh reviewed run), not patched.

```
  hand-edit a baseline = silently redefine "correct" → test passes for the
  wrong reason. Regenerate via promote:replay instead.
```

Anchor: *the mutability flip at promotion is the whole point — a baseline you
can edit isn't a baseline.*

## See also

- `01-injected-model-port.md` — the `FixtureModelProvider` the replay reuses.
- `05-bug-to-regression-test.md` — the other regression discipline: bug → test.
- `audit.md` lens 6 (AI features) and lens 7 fix #3 (rubric-improvement gap).
- study-ai-engineering — the eval half: scoring whether the model output is good
  before promotion.
