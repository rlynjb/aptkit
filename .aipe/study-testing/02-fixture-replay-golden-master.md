# Fixture replay & golden-master

**Subtitle:** Golden-master / characterization testing / recorded-response
replay — *Industry-standard* pattern, *Project-specific* fixture lifecycle.

## Zoom out, then zoom in

A single recorded model reply tests one provider call. But an *agent* is a
whole trajectory — model says "call this tool," tool runs, model reads the
result, model answers. To regression-test that you need to replay the entire
sequence deterministically. That's what the fixture layer does, and it's the
testing/observability backbone named in context.md.

```
  Zoom out — where fixtures sit in the eval lifecycle

  ┌─ Live run ────────────────────────────────────────────────────┐
  │  real provider → real agent loop → emits trace + modelTurns    │
  └───────────────────────────────┬────────────────────────────────┘
                                  │  saved as
  ┌─ Artifact ────────────────────▼────────────────────────────────┐
  │  artifacts/replays/*.json  (output + trace + eval + modelTurns) │
  └───────────────────────────────┬────────────────────────────────┘
                                  │  promote:replay  (timestamped)
  ┌─ Fixture ─────────────────────▼────────────────────────────────┐
  │  fixtures/promoted/*.json  ★ THE GOLDEN MASTER ★                │ ← here
  │  recorded ModelResponse[]  — a correctness baseline             │
  └───────────────────────────────┬────────────────────────────────┘
                                  │  replayed by
  ┌─ Deterministic replay ────────▼────────────────────────────────┐
  │  FixtureModelProvider → real agent → assert same trajectory     │
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: a fixture is a recorded array of `ModelResponse[]`. `FixtureModelProvider`
hands them back one per `complete()` call, in order. Drive a real agent with it
and the agent can't tell it's not talking to a live model — but the run is
byte-identical every time.

## Structure pass

**Layers:** recorded bytes (the fixture file) → `FixtureModelProvider` (the
replay shim) → real agent loop (the thing under test) → assertions on
output + trace.

**Axis — "what is allowed to vary between two runs?":**

```
  One axis: "what can change run-to-run?"

  ┌─ live run ────────────┐   EVERYTHING (model is stochastic)
  └───────────┬───────────┘
              │  seam ═══════ promote: freeze the bytes
  ┌─ fixture ▼────────────┐   NOTHING (recorded constants)
  └───────────┬───────────┘
  ┌─ replay  ▼────────────┐   only the agent's deterministic
  │  real agent loop       │   control flow runs; output is fixed
  └────────────────────────┘
```

**The seam:** `promote:replay`. Before it, output varies with the model. After
it, the recorded responses are frozen and the only thing that can change the
test result is *aptkit's own code* — which is exactly what a regression test
should detect.

## How it works

### Move 1 — the mental model

Golden-master / characterization testing: capture the output of a system you
trust today, freeze it, and fail the test if the output ever differs. You've
seen the shape in snapshot testing — render a component, save the HTML, fail if
it changes. Same idea, but the "snapshot" here is the recorded *conversation*
between agent and model, and the thing replayed is the model's side.

```
  Golden-master replay — freeze the model's side, run the agent for real

   recorded ModelResponse[]      FixtureModelProvider        real agent
   ┌───────────────────────┐     ┌─────────────────┐     ┌──────────────┐
   │ [0] tool_use: search   │ ──► │ complete() #1 →[0]│ ──► │ dispatch tool│
   │ [1] text: "the answer" │ ──► │ complete() #2 →[1]│ ──► │ return answer│
   └───────────────────────┘     └─────────────────┘     └──────┬───────┘
                                  index advances each call        │
                                                          assert trajectory
```

The strategy in one sentence: **freeze the model's replies, run the real agent
on top, and fail if the trajectory changes.**

### Move 2 — the walkthrough

**The replay shim is tiny — that's the point.** `FixtureModelProvider`
implements `ModelProvider` and just hands back the next recorded response:

```ts
// packages/agents/recommendation/src/fixture-provider.ts:3
export class FixtureModelProvider implements ModelProvider {
  readonly id = 'fixture';
  private index = 0;
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);                 // captures what the agent sent
    const response = this.responses[this.index];
    this.index += 1;                             // advance, in order
    if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
    return response;
  }
}
```

Two load-bearing details: it `push`es each request (so a test can later assert
what the agent asked for), and it **throws loud on exhaustion** — if the agent
makes more model calls than the fixture recorded, you get
`fixture model exhausted after N responses`, not a silent `undefined`. A prompt
change that adds a model round-trip fails here with a clear message.

**Driving a real agent with it.** `recommendation-agent.test.ts:41` builds a
scripted two-response sequence (a `tool_use` then the final JSON) and runs the
real `RecommendationAgent`. It then asserts the *whole trajectory* by trace:

```ts
// packages/agents/recommendation/test/recommendation-agent.test.ts:113
assert.deepEqual(events.map((event) => event.type), [
  'model_usage', 'tool_call_start', 'tool_call_end', 'model_usage', 'step',
]);
```

That sequence is the golden master. If a refactor reorders the loop, drops the
tool call, or skips the synthesis turn, this `deepEqual` fails. It also asserts
the least-privilege policy held: `model.requests[0].tools.length === 1` — the
`unsafe_write_campaign` tool was never advertised to the model.

**The fixture lifecycle is a real pipeline, not ad-hoc files.** A live run
saves an artifact to `artifacts/replays/*.json`; `npm run promote:replay`
(`scripts/promote-replay-to-fixture.mjs`) timestamps it into
`fixtures/promoted/*.json`. There are 18 fixture files in the repo, including
promoted baselines like
`voucher-dropoff-w10-on-openai-promoted-2026-06-18-17-20-55.json`. The
timestamp in the name is the signal: **promoted fixtures are auto-generated and
must not be hand-edited** (context.md must-not-change constraint) — editing one
changes what "correct" means, so they're regenerated via the script, never by
hand.

```
  Layers-and-hops — the promote pipeline

  ┌─ Live ────────┐ hop1: run  ┌─ artifacts/replays ─┐ hop2: promote:replay
  │ real provider │ ─────────► │  *.json (variable)   │ ─────────────────┐
  └───────────────┘            └──────────────────────┘                  │
                                                                          ▼
  ┌─ Replay test ─┐ hop4: assert ┌─ fixtures/promoted ─────────────────┐ │
  │ real agent     │ ◄─────────── │  *-promoted-<timestamp>.json        │◄┘
  │ + FixtureModel │  trajectory  │  (frozen golden master)             │ hop3
  └────────────────┘              └──────────────────────────────────────┘
```

**The replay-runner validates artifact shape, separately.**
`replay-runner.test.ts:34` feeds four artifact types (recommendation,
monitoring, diagnostic, query) through `evaluateReplayArtifactFiles` and
asserts each is recognized by `capabilityId` and passes its shape eval. Bad
artifacts are reported without throwing (`:63`) — a malformed replay shows up
as `ok: false` with an issue path, not a crash.

### Move 2 variant — the kernel

Strip it down: **a recorded array + an index that advances + loud exhaustion.**
Remove the recording and there's nothing to replay. Remove the in-order index
and the agent gets the wrong reply for its current step. Remove the
exhaustion-throw and an extra model call silently returns `undefined` and the
failure surfaces somewhere confusing instead of at the source.

Optional hardening, not kernel: the promote script's timestamping, the
artifact shape validator, the precision@k eval attached to the artifact. Those
make fixtures durable and auditable; the replay itself needs only the three
parts above.

### Move 3 — the principle

Golden-master testing earns its place exactly when the output is too complex or
too expensive to assert by hand but stable enough to freeze — an agent
trajectory is both. The discipline that makes it trustworthy rather than
brittle: **the recorded baseline is regenerated by a script, never edited by
hand.** A hand-edited golden master is a lie about what the system produced.

## Primary diagram

```
  Fixture replay & golden-master — full lifecycle

  LIVE ──run──► artifacts/replays/*.json ──promote:replay──► fixtures/promoted/*.json
                                                              (frozen, timestamped)
                                                                      │
                              ┌───────────────────────────────────────┘
                              ▼
  ┌─ Replay test ───────────────────────────────────────────────┐
  │  new FixtureModelProvider(recorded)                          │
  │       └─ complete() #1 → responses[0]  (tool_use)            │
  │       └─ complete() #2 → responses[1]  (final text)          │
  │  run REAL agent ──► assert trace sequence == golden master    │
  │                 ──► assert tool policy (unsafe tool absent)    │
  │  exhaustion → throws loud (extra call = regression caught)     │
  └────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is characterization testing (Feathers, *Working Effectively with Legacy
Code*) crossed with the record/replay pattern from VCR-style HTTP libraries —
adapted to model conversations. The distinctive aptkit twist is the
*promotion* step: an artifact isn't a fixture until a script timestamps it,
which makes the baseline's provenance auditable (you can see it was the OpenAI
run from 2026-06-18). The gap, from audit lens 7: `rubric-improvement` has no
`replay:promoted` script wired into the root pipeline, so it's the one agent
whose trajectory isn't golden-master-guarded — worth fixing for parity. Where
this hands off: the *content* of the recorded answer (is it good?) is graded by
the eval scorers (`04-deterministic-eval-scorers.md`) and discussed as
evaluation in study-ai-engineering; replay only guarantees the *trajectory*
didn't drift.

## Interview defense

**Q: How do you regression-test an agent when the model is non-deterministic?**

> Record the model's replies from a run you trust, freeze them with a promote
> script, then replay them through the real agent with a FixtureModelProvider.
> The agent runs for real — real loop, real tool dispatch, real parsing — but
> the model's side is constant, so the only thing that can change the result is
> my own code. I assert the trace sequence as the golden master.

```
  recorded [tool_use, text] → FixtureProvider → real agent → assert trace seq
```

Anchor: *freeze the model's side; the trajectory is the snapshot.*

**Q: What stops a stale fixture from passing a broken agent?**

> Two things. The fixture throws loud on exhaustion, so if the agent makes a
> model call the recording doesn't cover — the common shape of a real change —
> the test fails with "fixture exhausted," not a false green. And fixtures are
> regenerated by the promote script, never hand-edited, so the baseline always
> reflects a real run. If correctness genuinely changed, you re-promote; you
> don't patch the JSON.

Anchor: *exhaustion fails loud; baselines are regenerated, not edited.*

## See also

- `01-injectable-transport-seam.md` — `FixtureModelProvider` is the seam used
  for a whole trajectory instead of one reply.
- `04-deterministic-eval-scorers.md` — grades the *content* the replay froze.
- `03-regression-test-from-a-real-bug.md` — the other regression style: a
  hand-written test for one specific bug.
- `audit.md` lens 6 (testing AI features) and lens 7 (rubric-improvement gap).
- study-ai-engineering — replay as eval / regression across model swaps.
