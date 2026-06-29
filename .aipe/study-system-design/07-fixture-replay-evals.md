# 07 — Fixture-replay evals (deterministic testing of a non-deterministic agent)

> **Subtitle:** Record-replay testing / Golden-fixture evaluation for LLMs —
> *Industry standard (record-replay), repo-specific pipeline.* The recorded
> `ModelResponse[]` is the fixture; `FixtureModelProvider` is the replay
> adapter (a `ModelProvider` like any other in `01`); the scorers + the
> promote step are the eval pipeline.

## Zoom out — where this sits

An agent's output depends on a model, which is non-deterministic — you can't
write `assert(output === expected)` against a live LLM. aptkit's answer: record
a live run's model responses into a fixture, then replay that fixture through
the *same* agent code via a fake provider. The agent is real; the model is
recorded; the run is now deterministic and assertable.

```
  Zoom out — replay in the stack

  ┌─ Eval / test layer ────────────────────────────────────────────────┐
  │  scorers: precision@k · recall@k · rubric-judge · structural-diff    │
  │  replay-runner · promote-replay-to-fixture                           │
  │  packages/evals/src/*                                                │
  └───────────────────────────┬──────────────────────────────────────────┘
                              │ runs the real agent, but with…
  ┌─ Model port (01) ─────────▼──────────────────────────────────────────┐
  │  ★ FixtureModelProvider ★  implements ModelProvider                   │ ← we are here
  │  replays recorded ModelResponse[] in order, deterministically         │
  └───────────────────────────┬──────────────────────────────────────────┘
                              │ reads
  ┌─ Storage ─────────────────▼──────────────────────────────────────────┐
  │  fixtures: packages/agents/*/fixtures/*.json + fixtures/promoted/*.json│
  │  artifacts: artifacts/replays/*.json (a recorded run + its trace + eval)│
  └─────────────────────────────────────────────────────────────────────────┘
```

The key move: `FixtureModelProvider` is *just another adapter behind the model
port* (`01`). The agent can't tell it from gemma or Claude — it calls
`complete()` and gets a `ModelResponse`. That's what makes the swap to
deterministic testing free.

## Structure pass — layers, axis, seam

Layers: the **live recording** (a real run → artifact), the **fixture** (the
promoted golden), the **replay** (fixture → agent → assert). Trace one axis —
**is this deterministic** — across the lifecycle:

```
  axis traced: "is this run reproducible?"

  ┌─ live run ──────────────────┐   NO — real model, non-deterministic output
  └──────────────┬───────────────┘
       seam ═════╪═════  ← determinism flips: live model → recorded responses
  ┌─ promote ─────▼─────────────┐   the run's ModelResponse[] frozen into a fixture
  └──────────────┬───────────────┘
  ┌─ replay ──────▼─────────────┐   YES — FixtureModelProvider replays the frozen responses
  └─────────────────────────────┘
```

The seam is the **promote step** — the moment a non-deterministic run becomes a
deterministic baseline. Before it, you have a recording; after it, you have a
test oracle. That's the boundary the whole pattern turns on.

## How it works

### Move 1 — the mental model

You know fixtures from frontend testing: instead of hitting a real API, you
return `fixtures/user.json` so the test is fast and stable. This is that,
applied to the model — except the fixture is a *sequence* of responses (one per
loop turn), replayed in order.

```
  the pattern — record once, replay deterministically

  LIVE:    agent ─► real model ─► ModelResponse[] ──record──► artifact.json
                                                                 │ promote
                                                                 ▼
  REPLAY:  agent ─► FixtureModelProvider ─► responses[index++] ─► same output, every time
                       │
                       └─ exhausted? throw (the run asked for more turns than recorded)
```

The agent code is identical in both modes. Only the provider behind the port
changes.

### Move 2 — the parts

**The replay adapter** (`packages/agents/recommendation/src/fixture-provider.ts:3-18`):

```ts
export class FixtureModelProvider implements ModelProvider {   // it's a ModelProvider (01)
  id = 'fixture';
  private index = 0;
  constructor(private responses: ModelResponse[]) {}
  async complete(request) {
    this.requests.push(request);              // record what was asked (for inspection)
    const r = this.responses[this.index];     // next recorded response, in order
    this.index += 1;
    if (!r) throw new Error('fixture exhausted');  // more turns than recorded → loud fail
    return r;
  }
}
```

An index pointer over an array of recorded responses. Turn 0 gets
`responses[0]`, turn 1 gets `responses[1]`. If the agent loops more turns than
were recorded, it throws — a recording that no longer matches the loop's
behavior fails loudly instead of silently diverging.

**The artifact** (`artifacts/replays/*.json`) — a recorded run:
`schemaVersion`, `capabilityId`, `provider`, `fixture`, the per-capability
output (recommendations / anomalies / answer), the `trace` (the
`CapabilityEvent`s from `04`), and `modelTurns` (the responses to replay). It's
the full record of one run.

**The promote step** (`scripts/promote-replay-to-fixture.mjs`): takes a
validated artifact and writes its `modelTurns` into
`fixtures/promoted/*.json`, timestamped. This is the determinism seam — a live
recording becomes a correctness baseline. Promoted fixtures are
*regenerated, never hand-edited* (editing them changes test meaning —
`.aipe/project/context.md`).

**The scorers** (`packages/evals/src/`) — how a replay is judged:

- `scorePrecisionAtK` / `scoreRecallAtK` (`precision-at-k.ts:47-78`) — ranked
  retrieval metrics. Precision: of the top-k retrieved IDs, what fraction are
  relevant (denominator `min(k, retrieved)`). Recall: of all relevant IDs, what
  fraction appear in top-k (denominator `|relevant|`).
- `rubric-judge.ts` (`RubricJudge`, lines 72-105) — an LLM-as-judge that scores
  output against a rubric, with a validated `RubricJudgment` shape.
- `detection-scorer.ts` (`scoreDetections`, lines 29-83) — checks anomaly
  outputs against expected counts/categories.
- `replay-runner.ts` (`evaluateReplayArtifact`, lines 47-67) — asserts an
  artifact's shape and extracts a `ReplayArtifactEvalSummary`.

```
  layers-and-hops — the full record→replay→score loop

  ┌─ live ──────────┐ hop1: real run         ┌─ artifact.json ───────────┐
  │ agent + real    │ ─────────────────────► │ modelTurns + trace + output│
  │ model           │                        └────────────┬───────────────┘
  └─────────────────┘            hop2: promote │ (determinism seam)
                                               ▼
  ┌─ fixtures/promoted/*.json ─────────────────────────────────────────────┐
  │  the frozen ModelResponse[] baseline                                    │
  └────────────┬─────────────────────────────────────────────────────────────┘
   hop3: replay │ node --test
                ▼
  ┌─ agent + FixtureModelProvider ─► output ─► scorers (precision@k / rubric) │
  │  deterministic; assertable                                               │
  └───────────────────────────────────────────────────────────────────────────┘
```

#### Move 2 variant — the load-bearing skeleton

The replay kernel: **a fixture (recorded responses) + a replay adapter behind
the model port + the exhaustion guard**. What breaks if each goes:

- **the fixture (recorded `ModelResponse[]`)** — gone, and there's nothing to
  replay; you're back to a live, non-deterministic model in tests.
- **the replay adapter being a `ModelProvider`** — gone (a bespoke test
  harness instead), and you're no longer exercising the *real* agent code path;
  the test stops proving the production loop works.
- **the exhaustion guard (`throw` when responses run out)** — gone, and a loop
  that runs more turns than recorded would get `undefined` and fail in a
  confusing way instead of saying "fixture exhausted." It's the part that keeps
  a drifted recording honest.

Hardening on top: the promote pipeline, the timestamped baselines, the request
recording for inspection, the schema-version assertion in `replay-runner`.

### Move 2.5 — Studio's in-browser replay (a third consumer)

The same fixture idea runs entirely in the browser for the Studio demo. The RAG
Query page (`apps/studio/src/RagQueryWorkspace.tsx`) wires a *fake* embedder + an
`InMemoryVectorStore` + recorded responses, scored with precision@k — so the
static GitHub Pages demo runs a real agent with zero backend. Same pattern, a
different deployment of it: the model port lets the fake provider slot in client-side.

### Move 3 — the principle

To test a non-deterministic system, freeze the non-deterministic part and
replay it through the real code. Because the model is behind a port (`01`), the
fake is just another adapter — the agent loop, the tool dispatch, the parsing
all run for real, and only the model's answers are recorded. The promote step
is the discipline: a recording becomes a baseline deliberately, and you never
edit the baseline by hand.

## Primary diagram

```
  fixture-replay evals — full recap

  ┌─ LIVE run ─────────────────────────────────────────────────────────┐
  │  agent + real model ─► artifact.json { modelTurns, trace, output }  │
  └───────────────────────────┬─────────────────────────────────────────┘
              promote (the determinism seam) │ regenerate, never hand-edit
                                             ▼
  ┌─ fixtures/promoted/*.json (golden baseline) ───────────────────────┐
  └───────────────────────────┬─────────────────────────────────────────┘
              replay │ FixtureModelProvider (a ModelProvider, 01)
                     ▼  index++ over responses; exhausted → throw
  ┌─ agent (REAL code) ─► output ─► scorers ───────────────────────────┐
  │  precision@k · recall@k · rubric-judge · detection · structural-diff │
  │  deterministic · assertable · node --test                          │
  └─────────────────────────────────────────────────────────────────────┘
       gap: rubric-improvement agent's replay:promoted not wired into root pipeline
```

## Elaborate

This is record-replay (VCR-style) testing specialized for LLM agents, plus an
eval harness (the scorers). The promote-to-fixture flow is the "golden file"
discipline: a known-good output frozen as the baseline, regenerated rather than
edited. precision@k / recall@k are the standard information-retrieval metrics
for the RAG path; rubric-judge is the LLM-as-judge pattern for grading
open-ended output. The broader testing-strategy questions (coverage, isolation,
flakiness, the eval seam) belong to `study-testing`; this file owns only the
*architectural* part — that the model port makes deterministic replay a free
adapter swap. One honest gap: `rubric-improvement` has no `replay:promoted`
wired into the root pipeline (audit red-flag #5).

## Interview defense

**Q: How do you test an agent when the model is non-deterministic?**
Record a live run's model responses into a fixture, then replay that fixture
through the *real* agent via a fake provider. Because the model sits behind the
`ModelProvider` port, the fake is just another adapter — the loop, tools, and
parsing all run for real; only the model's answers are frozen. The run is now
deterministic and assertable.

```
  agent ─► FixtureModelProvider (replays recorded ModelResponse[]) ─► same output
```
*Anchor:* "The fake provider is just another adapter behind the model port."

**Q: What keeps a stale fixture from silently passing?**
The exhaustion guard — if the agent loops more turns than were recorded,
`FixtureModelProvider` throws "fixture exhausted" instead of returning
`undefined`. And promoted fixtures are regenerated, never hand-edited, so the
baseline always reflects a real run.

```
  responses[index++] ── index past end? ──► throw  (drifted recording fails loud)
```
*Anchor:* "Promoted fixtures are correctness baselines — regenerated, not edited."

## See also

- `00-overview.md` — replay artifacts on the full map
- `01-provider-abstraction.md` — the model port the fake provider implements
- `02-retrieval-as-a-tool.md` — what precision@k scores
- `04-capability-event-trace.md` — the trace embedded in a replay artifact
- `study-testing` — the broader correctness / eval-seam discipline
