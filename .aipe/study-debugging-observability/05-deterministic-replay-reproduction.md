# Deterministic replay (the reproduction time machine)

**Industry name(s):** record-replay / deterministic reproduction / fixture-based
replay. **Type:** Industry standard.

## Zoom out, then zoom in

A bug you can't reproduce is a bug you can't fix. With an LLM in the loop that's
the default state — the same prompt gives a different answer every run. This
mechanism removes the model's nondeterminism by *recording* its responses once
and *replaying* them forever, so a failing run becomes a fixed, re-runnable
artifact.

```
  Zoom out — where reproduction lives

  ┌─ Runtime layer ───────────────────────────────────────────┐
  │  runAgentLoop(model: ModelProvider)                        │
  │       ▲ depends only on the provider CONTRACT              │
  └───────┼─────────────────────────────────────────────────────┘
          │ swap the implementation behind the contract
  ┌───────┴──────────────┐         ┌──────────────────────────┐
  │ live provider        │   vs    │ ★ FixtureModelProvider ★  │ ← we are here
  │ (Gemma/Anthropic)    │         │  replays recorded         │
  │ nondeterministic     │         │  ModelResponse[]          │
  └──────────────────────┘         └──────────────────────────┘
```

Zoom in: the question is *how do you reproduce a run whose core component is
nondeterministic?* You don't make the model deterministic — you replace it,
behind the same contract, with a tape recorder. The agent loop can't tell the
difference, so the run is identical every time.

## The structure pass

**Layers.** Runtime (the loop, depends on `ModelProvider`) and Provider (the
implementation — live or fixture). The seam between them is the whole game.

**Axis — trace it on `dependency`: what does the loop depend on?**

```
  "what does runAgentLoop depend on?"

  ┌─ loop ─────────────────────────────────────────┐
  │ depends on  ModelProvider.complete()  ── the    │  → THE CONTRACT
  │             interface, never a vendor SDK        │     (an abstraction)
  └─────────────────────────┬───────────────────────┘
                            │ which implementation? loop doesn't care
        ┌────────────────────┼────────────────────┐
        ▼                                          ▼
  live provider                          FixtureModelProvider
  (cloud / Ollama)                        (recorded responses[])
  nondeterministic                        deterministic, offline
```

**Seam.** The `ModelProvider` contract. The dependency axis answer — "the loop
depends on the *interface*" — is what makes reproduction free: because the loop
never names a concrete provider, you substitute a fixture at the seam with zero
loop changes. This is dependency inversion doing double duty: it's the same seam
that makes providers swappable for *production* (Anthropic / OpenAI / Gemma) and
swappable for *reproduction* (live → fixture). One boundary, two payoffs.

## How it works

### Move 1 — the mental model

You've mocked a `fetch()` in a test by handing the component a fake that returns
canned JSON — the component doesn't know it's not the real network. A fixture
provider is exactly that, for the model: a fake `complete()` that returns the
next recorded response off a tape instead of calling a live model.

```
  The pattern — replace the nondeterministic source with a tape

  record once:   live run ──► responses[] captured ──► fixture.json
                                                          │
  replay N times:                                         ▼
     loop turn 1 ─► fixture.complete() ─► responses[0]   ┐
     loop turn 2 ─► fixture.complete() ─► responses[1]   │ same tape →
     loop turn 3 ─► fixture.complete() ─► responses[2]   │ same run →
                          │                              │ same result
                    index++ each call                    ┘
```

The tape head (`index`) advances per call; feed the same tape and the run is
byte-identical.

### Move 2 — the step-by-step walkthrough

**The fixture provider — a tape head over recorded responses.** It implements
the same `ModelProvider` contract the live providers do, but `complete()` just
returns the next recorded response:

```typescript
// packages/agents/recommendation/src/fixture-provider.ts (shape)
class FixtureModelProvider implements ModelProvider {
  private index = 0;
  private readonly requests: ModelRequest[] = [];      // captures what was asked (audit)
  constructor(private readonly responses: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);                        // record the request side too
    return this.responses[this.index++];                // tape head advances; deterministic
    // (throws when responses run out — a deterministic "ran off the tape" signal)
  }
}
```

Two details earn their keep. The `index++` is the tape head — each call consumes
one recorded response in order, so the loop's turn N always sees response N.
Recording `requests` keeps the *other* side of the conversation for audit — you
can check the loop asked what you expected. Running off the end throws, which is
a *deterministic* failure (the recording was too short for this code path) rather
than a silent wrong answer.

**The recorded shape — what a tape contains.** Fixtures are recorded
`ModelResponse[]` stored as JSON (`packages/agents/*/fixtures/*.json` and
`fixtures/promoted/*.json`). Promoted fixtures are timestamped, auto-generated
correctness baselines — *not* hand-edited, because editing them changes what the
test asserts (a must-not-change constraint from the project context).

**The full reproduction pipeline.** Reproduction isn't just the fixture — it's a
loop: a live run produces an artifact, the artifact is evaluated, a good one is
promoted to a fixture, and the fixture replays deterministically forever.

```
  Layers-and-hops — the record→replay pipeline

  ┌─ live run ──┐ hop 1: run with    ┌─ artifact ──────────┐
  │ runAgentLoop│ real provider      │ artifacts/replays/  │
  │ + live model│ ─────────────────► │ *.json {trace,      │
  └─────────────┘                    │  output, eval, ...}  │
                                     └──────────┬───────────┘
                          hop 2: eval (structural-diff /
                                 detection / rubric)  │
                                                       ▼
                                     ┌─ promote ──────────────┐
                                     │ promote:replay →         │
                                     │ fixtures/promoted/*.json │
                                     └──────────┬───────────────┘
                          hop 3: replay deterministically
                                                       ▼
                                     ┌─ replay run ───────────┐
                                     │ FixtureModelProvider    │
                                     │ replay:promoted scripts │
                                     │ → identical trajectory  │
                                     └─────────────────────────┘
```

The scripts that drive this live in `scripts/*.mjs`
(`replay-promoted-fixtures.mjs`, `promote-replay-to-fixture.mjs`,
`eval-replay-artifacts.mjs`). The artifact carries the full `trace` (the
`CapabilityEvent` stream from `01`), so a reproduced run regenerates the same
trajectory you'd read backward in `04`. **That's the link to debugging:** once a
bug is captured as a fixture, you can re-read its trajectory as many times as you
want, offline, free.

### Move 2.5 — current state vs the partition with study-testing

This pipeline is the shared backbone between *reproduction* (this guide) and
*correctness-before-release* (`study-testing`). The line:

```
  Comparison — who owns what on the replay pipeline

  this guide (debugging)          study-testing (correctness)
  ──────────────────────          ───────────────────────────
  "reproduce the failing run"     "assert the run is still right"
  the fixture as a repro seed     the fixture as a baseline
  the trace as evidence           the eval scorers as the verdict
  read backward (04)              structural-diff / detection / rubric / precision@k
```

Same artifacts, different question. Reach for `study-testing` for the assertion
side; this file owns only the *reproduction* half.

### Move 2 variant — the load-bearing skeleton

```
  Kernel of deterministic replay

  1. a swap seam (ModelProvider)   ── substitute the nondeterministic part
  2. a recording (responses[])     ── the captured nondeterminism, frozen
  3. an ordered tape head (index)  ── replay in the same order as recorded
  4. run-off-end throws            ── deterministic failure, not silent drift
```

- **Drop the swap seam** and you can't replace the model — you're stuck
  reproducing against a live, nondeterministic provider; no reproduction.
- **Drop the ordered tape head** and turn N might get response M; the run
  diverges from what was recorded.
- **Drop the run-off-end throw** and a code path the recording didn't cover
  returns `undefined`, producing a confusing wrong answer instead of a clear
  "tape too short" error.

**Skeleton vs hardening.** The four are the kernel. Hardening: capturing the
`requests` side for audit, the promote-to-baseline step, the eval scorers. The
bare reproduction needs only the tape and the head.

### Move 3 — the principle

Don't fight nondeterminism — quarantine it behind a seam and freeze it. The model
is the only nondeterministic part of the loop, so the entire reproduction
strategy is "make the model swappable, record it once, replay it forever." The
seam that lets you do this is the *same* dependency-inversion boundary you built
for swapping providers in production — reproduction comes free with good
architecture.

## Primary diagram

```
  Deterministic replay — the reproduction time machine

  ┌─ Runtime layer ─────────────────────────────────────────────────┐
  │  runAgentLoop  ── depends on ──►  ModelProvider.complete()  ─── seam│
  └──────────────────────────────────────┬─────────────────────────────┘
              ┌─────────────────────────────┼──────────────────────────┐
              ▼ (production / record)        ▼ (reproduce / replay)     │
  ┌─ live provider ─────────┐      ┌─ FixtureModelProvider ───────────┐ │
  │ Gemma / Anthropic / ... │      │ responses[index++]  (tape head)   │ │
  │ nondeterministic        │      │ throws when tape ends             │ │
  └───────────┬─────────────┘      └───────────────┬───────────────────┘ │
              │ run → artifact (trace+output+eval)  │ identical trajectory │
              ▼                                      ▼                      │
  ┌─ artifacts/replays/*.json ──► eval ──► promote ──► fixtures/promoted/ ──┘
  │  the captured run            scorers   baseline    the frozen tape       │
  └────────────────────────────────────────────────────────────────────────┘
```

## Elaborate

Record-replay is an old debugging idea (rr, time-travel debuggers, VCR-style
HTTP fixtures) reframed for LLM systems, where the nondeterministic component is
the model rather than the network or the clock. The repo's contribution is
recognizing that the provider abstraction it already needed for vendor
neutrality *is* the record-replay seam — no separate test harness, just a second
implementation of `ModelProvider`. If you've used `nock` or VCR cassettes for
HTTP, this is the same pattern aimed one layer up, at the model call.

Read next: `04-reading-the-trajectory-backward.md` (debugging a reproduced run),
`study-testing` (the assertion side of the same pipeline).

## Interview defense

**Q: How do you reproduce a bug when the model is nondeterministic?**
Quarantine the nondeterminism behind the provider seam. Record the model's
responses once into a fixture, then replay them through a `FixtureModelProvider`
that returns the next recorded response per call. The loop depends on the
`ModelProvider` interface, so it can't tell the fixture from the real model — the
run is byte-identical every time.

```
  loop ─► ModelProvider seam ─► [ live (record) | fixture (replay) ]
```

**Q: What's the part people forget?**
Run-off-the-end must *throw*, not return `undefined`. A tape shorter than the
code path is a real error — silently returning nothing gives you a confusing
wrong answer instead of a clear "recording too short." Deterministic failure
beats silent drift.

**Q: How does this connect to debugging vs testing?**
Same pipeline, two questions. For debugging, the fixture is a reproduction seed
and the trace is evidence I read backward. For testing (`study-testing`), the
fixture is a correctness baseline and the eval scorers are the verdict. The
promote-to-fixture step is the bridge between them.

## See also

- `04-reading-the-trajectory-backward.md` — debugging the reproduced trajectory.
- `01-capability-event-trace.md` — the trace an artifact carries.
- `06-hallucination-tolerant-retrieval-guard.md` — a bug frozen as a regression test.
- `study-testing` — the eval/assertion side of the replay pipeline.
- `study-system-design` — the provider abstraction as a production seam.
