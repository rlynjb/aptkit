# 06 — Fixture-replay evals

**Industry name(s):** record/replay testing · golden-file / snapshot baselines ·
deterministic eval harness over a non-deterministic model. **Type:** Industry
standard (project-specific promotion pipeline).

## Zoom out, then zoom in

The model is non-deterministic; CI has to be deterministic. This pattern is how
aptkit reconciles those: record a real model run as an artifact, judge it, *promote*
the good ones to fixtures, and replay fixtures deterministically forever after — with
the agent code completely unchanged, because the fixture *is* a `ModelProvider`.

```
  Zoom out — where replay sits

  ┌─ live run ─────────┐   ┌─ artifact ─────┐   ┌─ promoted fixture ──┐
  │ real gemma/cloud   │──►│ JSON: output + │──►│ ModelResponse[] as  │
  │ via runAgentLoop   │   │ trace + eval   │   │ a correctness baseline
  └────────────────────┘   └────────────────┘   └──────────┬───────────┘
                                                            │ replay
  ┌─ runtime: same runAgentLoop, model = FixtureModelProvider ▼┐ ← here
  │ deterministic: scored with precision@k / structural-diff / rubric │
  └────────────────────────────────────────────────────────────┘
```

The question: *how do you test an agent whose model output changes every run, without
mocking away the very thing you want to test?* The answer is to make the recorded
output a drop-in `ModelProvider` — the same seam from file `01`, used for
determinism. Here's the loop.

## Structure pass

**Layers:** live run (records) → artifact (the recording) → promotion (the judgment)
→ fixture (the baseline) → replay (deterministic re-run + scoring).

**Axis traced — *what makes the run deterministic?***

```
  One axis — "what provides the model output?" — live vs replay

  ┌─ live run ──────────────┐   real provider → different output each time.
  └──────────┬───────────────┘
  ┌─ FixtureModelProvider ──▼┐  recorded ModelResponse[] → same output every time.
  └──────────────────────────┘  swapping THIS one box flips determinism on.
```

**Seam:** the `ModelProvider` boundary — again. `FixtureModelProvider` satisfies it,
so determinism is a one-line swap. The eval scorers sit at a second seam: they read
the *output*, not the model, so the same scorer judges live and replayed runs.

## How it works

### Move 1 — the mental model

You've used snapshot tests: capture a component's render once, fail the test if it
changes. This is that for an *agent trajectory* — but the snapshot is the model's
responses, and "replaying" them re-runs the real loop, tools and all, against a
frozen model. The agent code is exercised for real; only the model is frozen.

```
  The record/replay loop — the shape

  RECORD:   live model → run loop → artifact { output, trace, eval, modelTurns }
  JUDGE:    eval scorers → is it correct?
  PROMOTE:  good artifact → fixtures/promoted/*.json (the baseline)
  REPLAY:   FixtureModelProvider(modelResponses) → same loop → score vs baseline
            └── deterministic: no model call, full agent code path ──┘
```

### Move 2 — the walkthrough

**The fixture provider is a `ModelProvider` that reads from a list.** This is the
hinge — 18 lines, and it's why no agent code changes between live and replay:

```ts
// packages/agents/recommendation/src/fixture-provider.ts:3
export class FixtureModelProvider implements ModelProvider {
  readonly id = 'fixture';
  private index = 0;
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);                    // records what the loop asked
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
    return response;                                // hands back the next recorded turn
  }
}
```

**What breaks if missing:** without a fixture *provider*, you'd mock `complete()`
inline in each test, and the mock would drift from the real provider's response shape.
Because the fixture *is* a `ModelProvider`, it goes through the identical loop path —
including tool execution, the forced synthesis turn, and trace emission. Note it
records the `requests` too, so a test can assert *what the loop asked the model*, not
just what came back. It throws on exhaustion, which catches a loop that took more
turns than the fixture recorded — a real regression signal.

**The artifact is the recording.** A live or Studio run produces a JSON artifact
(`artifacts/replays/*.json`) keyed by `schemaVersion`, `capabilityId`, `provider`,
`fixture`, the per-capability `output`, the `trace` (the `CapabilityEvent` stream from
file `05`), the `eval` result, and `modelTurns` (the `ModelResponse[]` to replay). The
shape is asserted by `assertReplayArtifactShape` (`packages/evals/src/assertions.ts:58`)
— so a malformed artifact fails before it can become a baseline.

**Promotion is the judgment step.** `scripts/promote-replay-to-fixture.mjs` takes an
artifact, re-validates its shape (`import { assertReplayArtifactShape }`), and writes
it into `fixtures/promoted/` as a timestamped baseline. **This is the load-bearing —
and most dangerous — step:** promotion is a human asserting "this run was correct."
Promote a buggy run and the bug becomes the oracle (audit.md red-flag #5). The
must-not-change constraint in the project context is explicit: promoted fixtures are
regenerated via `promote:replay`, never hand-edited, because editing them changes what
the tests *mean*.

```
  Layers-and-hops — record to baseline to CI

  ┌─ live/Studio run ─┐ hop1: run loop, real model   ┌─ artifacts/replays/*.json ─┐
  │ runAgentLoop      │ ────────────────────────────►│ output+trace+eval+modelTurns│
  └───────────────────┘                              └─────────────┬───────────────┘
                                  hop2: promote:replay (human judges correct)
                                                      ▼
  ┌─ CI: node --test ─┐ hop4: score   ┌─ fixtures/promoted/*.json (baseline) ──────┐
  │ replay + scorers  │◄──────────────│ replayed via FixtureModelProvider           │
  └───────────────────┘ hop3: deterministic re-run, no model call                  │
```

**The scorers judge the output, not the model.** Evals read the run's *output* and
score it, so the same scorer works live and replayed (`packages/evals`):

- **`scorePrecisionAtK` / `scoreRecallAtK`** (`precision-at-k.ts:47`/`:68`) — ranked-
  retrieval metrics. Precision@k = distinct relevant ids in top-k ÷ min(k, retrieved);
  recall@k = distinct relevant ids in top-k ÷ |relevant|. The `ok` flag separates
  *well-formed* from *good*: a score of 0 with `ok:true` is a valid bad result;
  `ok:false` means the inputs made the metric undefined (k≤0, empty set). That
  distinction is the careful part — it stops a degenerate input from masquerading as a
  failing model.
- **`evaluateStructuralDiff` / `assertRequiredPaths`** (`structural-diff.ts:20`/`:49`)
  — rule-based shape assertions on the output.
- **`scoreDetections`** (`detection-scorer.ts:29`) — for the anomaly agents.
- **`rubric-judge`** — an LLM-as-judge scorer for qualitative output.

**Studio closes the loop interactively.** Studio's middleware runs replays in two
modes (`apps/studio/vite.config.ts:757`): `fixture` mode constructs a
`FixtureModelProvider(fixture.modelResponses)`; live mode uses a real provider. The
UI lets you run, inspect the trace, and promote — the whole record/judge/promote cycle
without leaving the browser.

**Move 2.5 — current state.** The pipeline is shipped for 5 of 6 agents. The project
context flags the gap honestly: `rubric-improvement` has no `replay:promoted` script
wired into the root pipeline, so it's recorded/replayable but not in the promoted-
fixture CI loop yet.

### Move 3 — the principle

To test a non-deterministic dependency deterministically, don't mock it away — *record
it behind the same contract the real one satisfies*, and make "is this recording
correct?" an explicit, human-gated promotion step. The recording exercises your real
code path; the contract keeps the recording honest; the promotion gate is where
correctness is decided, so guard it.

## Primary diagram

The full record → judge → promote → replay loop, with the seams marked.

```
  Fixture-replay evals — full picture

  ┌─ RECORD (live / Studio) ──────────────────────────────────────────┐
  │ runAgentLoop(model = real gemma/cloud)                             │
  │  → artifact JSON { output, trace, eval, modelTurns }               │
  │    shape checked by assertReplayArtifactShape (evals/assertions.ts)│
  └───────────────────────────────┬────────────────────────────────────┘
                                  │ promote:replay  ← HUMAN judges correct
                                  ▼  (promote-replay-to-fixture.mjs)
  ┌─ BASELINE ────────────────────────────────────────────────────────┐
  │ fixtures/promoted/*.json  — timestamped correctness oracle         │
  │ MUST NOT be hand-edited (regenerated only)                         │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │ replay (node --test / Studio fixture mode)
                                  ▼
  ┌─ REPLAY (deterministic) ──────────────────────────────────────────┐
  │ runAgentLoop(model = FixtureModelProvider(modelResponses))         │
  │  same loop, same tools, frozen model → scored by:                  │
  │  precision@k · recall@k · structural-diff · detection · rubric-judge│
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is record/replay testing (VCR-style cassettes, golden files) specialized to
agents: the cassette is `ModelResponse[]`, and "play the cassette" means re-run the
real loop. The reason it earns a system-design file rather than living in
`study-testing` is that it's an *architectural* consequence of the model seam — the
same `ModelProvider` contract that enables provider-swapping (file `01`) is what makes
deterministic replay a one-line swap. The promotion gate is the project-specific
spine: it's where the system decides what "correct" means, and the must-not-change
constraint exists because that decision is load-bearing.

The deeper testing concerns — coverage, flakiness, the eval-quality seam — belong to
**`study-testing`**. The retrieval-quality metrics (precision/recall@k as IR concepts)
belong to **`study-ai-engineering`**.

## Interview defense

**Q: How do you test an agent when the model output changes every run?**
Record a real run's `ModelResponse[]` and replay them through a `FixtureModelProvider`
that satisfies the same `ModelProvider` contract — so the *real* loop, tools, and
trace run against a frozen model. Determinism is a one-line provider swap, not a mock.
Anchor: *the fixture IS a provider; the loop can't tell it's not live.*

```
  live:   loop(real provider)    → different each run
  replay: loop(FixtureProvider)  → identical each run  ← one box swapped
```

**Q: What's the riskiest step and how is it guarded?**
Promotion. A human asserts a recorded run was correct; promote a buggy one and the bug
becomes the test oracle. It's guarded by shape validation on promote
(`assertReplayArtifactShape`) and a hard rule that promoted fixtures are regenerated,
never hand-edited. Anchor: *promotion is where "correct" is decided — guard it, don't
edit it.*

**Q: What does the `ok` flag in the scorers buy you?**
It separates "well-formed but bad" (score 0, `ok:true`) from "undefined input"
(`ok:false`) — so a degenerate test input (k≤0, empty relevant set) can't masquerade
as a failing model. Anchor: *a 0 score with `ok:true` is a real failure; `ok:false` is
a malformed test.*

## See also

- `01-provider-neutral-model-seam.md` — the `ModelProvider` contract replay exploits.
- `04-bounded-agent-loop.md` — the loop replayed against the fixture.
- `05-capability-event-trace.md` — the trace stored in the artifact.
- **`study-testing`** — coverage, flakiness, eval-design quality.
- **`study-ai-engineering`** — precision/recall@k as retrieval metrics.
