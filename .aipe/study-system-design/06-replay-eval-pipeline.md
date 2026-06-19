# Replay-eval pipeline — record, score, promote, replay deterministically

**Industry names:** Record-replay testing / golden-fixture / snapshot eval / VCR-style cassette. **Type:** Industry standard (the live→artifact→eval→promote→replay loop is project-specific).

## Zoom out, then zoom in

This is the testing/observability backbone, and it cuts *across* the whole system — it touches the provider seam, the agent loop, the filesystem, and the eval package. Find it as the band at the bottom of the system map that everything else feeds into.

```
  Zoom out — where the replay pipeline lives

  ┌─ Capability layer ──────────────────────────────────────┐
  │  agent.method() runs the bounded loop, emits a trace     │
  └───────────────────────────┬──────────────────────────────┘
                              │  live run writes →
  ┌─ Testing/observability — evals + scripts + artifacts ────▼┐
  │  ★ artifact JSON ★ → ★ eval ★ → ★ promote ★ → ★ fixture ★ │ ← we are here
  │  evals: structural-diff, detection-scorer, rubric-judge   │
  │  FixtureModelProvider replays recorded ModelResponse[]    │
  └───────────────────────────┬──────────────────────────────┘
                              │  fixture replays satisfy the SAME provider port
  ┌─ Provider layer ──────────▼──────────────────────────────┐
  │  FixtureModelProvider (a ModelProvider with NO vendor)   │
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. You've hit the core problem this solves: an LLM is non-deterministic, so you *can't* write `assertEqual(agent.run(), expected)` — run it twice, get two answers. The pattern is **record-replay**: capture a real run's model responses to a file, then replay those exact responses through the same agent so the run becomes deterministic and free. Once it's deterministic you can assert on it like any other test. The four-beat loop — **live run → artifact → eval → promote-to-fixture** — is how a non-deterministic system gets a regression suite.

## Structure pass

**Layers:** a live run (non-deterministic, costs tokens) → an artifact (a frozen record) → an eval (a verdict) → a fixture (a replayable baseline). Trace one axis through it.

**Axis — guarantees: deterministic vs best-effort?**

```
  "is this deterministic?" — traced through the pipeline

  ┌─ live run ──────────┐  → NON-deterministic (real model, real tokens)
  │ real provider       │
  └──────────┬──────────┘
  ┌─ artifact ──────────┐  → FROZEN (a recorded snapshot of one run)
  │ JSON on disk        │
  └──────────┬──────────┘
  ┌─ promote → fixture ─┐  → DETERMINISTIC (recorded responses, replayable)
  │ modelResponses[]    │
  └──────────┬──────────┘
  ┌─ fixture replay ────┐  → DETERMINISTIC + FREE (no network, no tokens)
  │ FixtureModelProvider│
  └─────────────────────┘
```

The determinism guarantee flips exactly once — at promotion. Before it, you have a frozen record of *what happened once*; after it, you have a *repeatable* baseline. That flip is the seam: promotion is the step that turns observability data into a test. And the mechanism that makes replay possible is, again, the provider port (`01-`) — a fixture is just a `ModelProvider` that returns canned responses. Hand off to How it works.

## How it works

#### Move 1 — the mental model

The shape is record-then-replay through a swappable provider. You've used this if you've ever recorded HTTP responses (VCR cassettes, Polly, MSW) and replayed them in tests. The kernel: a fixture holds an ordered list of `ModelResponse`s; a `FixtureModelProvider` hands them out one per `complete()` call, in sequence; the agent runs identically but talks to the recording instead of the model.

```
  The record-replay kernel

  RECORD (once, live):                 REPLAY (forever, free):
  ┌────────────────────┐               ┌────────────────────────┐
  │ real provider       │              │ FixtureModelProvider     │
  │ complete() → resp ──┼─► captured   │ responses = [r0, r1, r2] │
  │ (×N turns)          │   into        │ complete() → responses   │
  └────────────────────┘   fixture     │            [index++]     │
                                        │ index past end → throw   │
                                        └────────────────────────┘
        agent loop is IDENTICAL in both — only the provider swapped
```

The non-obvious bit: the fixture provider is *stateful* — it has a cursor (`index`) that advances each call. The agent's N model calls must line up with the N recorded responses in order. If they don't (the agent calls the model an extra time), the cursor runs off the end and it throws. That's a feature — it catches the agent's control flow drifting.

#### Move 2 — the step-by-step walkthrough

**Beat 1 — the live run writes an artifact.** A replay script constructs an agent with a *real* provider (or a fixture), runs it, and serializes everything into an artifact JSON: `schemaVersion`, `capabilityId`, `createdAt`, `durationMs`, `provider`, `fixture`, the per-capability output, the `trace` (every `CapabilityEvent`), the `eval` result, and `modelTurns`. The bridge: it's a structured log of one run, but complete enough to *reconstruct* the run. The boundary condition: the artifact must capture the model responses faithfully, or you can't promote it to a replayable fixture later.

```
  artifact top-level keys (artifacts/replays/*.json)
  { schemaVersion, capabilityId, createdAt, durationMs,
    provider:{id,model}, fixture:{id,path},
    <output: recommendations | anomalies | diagnosis | answer>,
    trace:[CapabilityEvent...], eval:{name,ok,issues}, modelTurns }
```

**Beat 2 — the eval scores the artifact.** `evaluateReplayArtifact` first asserts the artifact's *shape* (right keys, right types per capability), then the per-capability evaluators score the *content*. Three evaluators, three jobs:
- **structural-diff** — rule-based: required paths present, values equal, counts in range, text matches. The bridge: it's schema validation plus assertions, returning `{ ok, issues[] }`.
- **detection-scorer** — for monitoring: did we detect the expected anomalies? Returns a 0–1 score = `(requirements - failures) / requirements`, plus matched/missed/unexpected lists. The bridge: it's precision/recall as a single ratio.
- **rubric-judge** — LLM-as-judge: scores the output against named rubric dimensions, returns a verdict and a fix. The bridge: it's a code review, automated, with a scoring scale.

```
  Layers-and-hops — an artifact through the eval

  ┌─ scripts/eval-replay ─┐ hop 1: read artifacts/replays/*.json
  │ resolve paths         │ ────────────────────────────────────►┐
  └───────────────────────┘                                       │
  ┌─ evals/replay-runner ─┐ hop 2: assertCapabilityReplayShape    ▼
  │ evaluateReplayArtifact│ ──► dispatch by capabilityId ─► structural-diff /
  └───────────┬───────────┘                                detection-scorer / rubric
       hop 3  │ aggregate → ReplayArtifactEvalReport {ok, checked, failed, results}
              ▼ exit 1 if any failed
```

**Beat 3 — promotion freezes a fixture.** `promote-replay-to-fixture.mjs` takes a passing artifact and constructs a *promoted fixture*: it copies the source fixture's inputs, then builds a `modelResponses` array containing a single response whose text block is the JSON-stringified output (IDs stripped, non-ASCII normalized), with usage totals summed from the trace's `model_usage` events, labeled `promoted-${providerId}-replay`. It adds `promotion` metadata (source artifact path, timestamp) and writes it to `fixtures/promoted/` with a timestamped filename. The bridge: it's "snapshot this passing run as the new golden." The boundary condition (and a must-not-change rule): **promoted fixtures are correctness baselines** — hand-editing one changes what the test *means*. They're regenerated via `promote:replay`, never edited.

**Beat 4 — replay runs the fixture deterministically.** `replay-promoted-fixtures.mjs` loads each promoted fixture and replays it through a `FixtureModelProvider`, which returns the recorded `modelResponses` in order — no network, no tokens, no non-determinism. The output is asserted against the fixture's expectations. The bridge: this is your unit test suite, except the "function" is an LLM agent and the "mock" is a recorded conversation. The boundary condition: replay catches *regressions in the agent's own logic* (prompt changes, parsing changes, loop changes) — it does *not* catch model drift, because the model's responses are frozen. That's the deliberate tradeoff: you trade "does the live model still behave" for "does our code still process a known conversation correctly."

```
  Execution trace — a fixture replay, agent makes 2 model calls

  FixtureModelProvider(responses = [r0, r1])
  call 1: complete(req) → r0   index 0→1
  call 2: complete(req) → r1   index 1→2
  (agent stops — 2 calls, 2 responses, cursor exhausted cleanly) ✓

  drift case: agent makes a 3rd call → index 2 past end → THROW
              → the test fails loudly (control flow changed)
```

#### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** A faithful artifact of a run + a `FixtureModelProvider` that replays recorded `ModelResponse[]` in order through the same provider port + a promotion step that freezes a passing artifact into a fixture + an eval that scores it.

2. **Name each part by what breaks if removed.**
   - Remove the **fixture provider** → no way to make a run deterministic; every test calls the real model and is flaky and expensive. You're back to "can't assert on an LLM."
   - Remove the **ordered cursor** in the fixture provider → responses come back in the wrong order or get reused; the replay no longer mirrors the recorded run.
   - Remove the **promotion step** → artifacts are just logs; nothing becomes a repeatable baseline. You can observe but not regression-test.
   - Remove the **shape assertion before scoring** → the scorer runs on a malformed artifact and produces a misleading verdict instead of a clear "wrong shape" error.

3. **Skeleton vs hardening.** Skeleton: artifact + fixture provider + promotion + replay. Hardening: the three different evaluators (structural/detection/rubric — different rigor for different outputs), the ID-stripping and ASCII normalization on promotion (so fixtures are stable), the usage-totaling, the `schemaVersion` for forward-compat. The loop works with just the skeleton; the hardening makes the baselines clean and the verdicts trustworthy.

The interview payoff: name **what replay does and doesn't catch**. People pitch record-replay as "now my LLM tests are deterministic" and stop there. The senior detail is that freezing the model responses means replay catches *your code's* regressions (prompt edits, parser changes, loop changes) but is *blind to model drift* by design — and that's exactly why you *also* keep live runs and a rubric-judge. Naming that boundary shows you understand the tradeoff you bought.

#### Move 2.5 — coverage gap

One agent is outside the deterministic net. Worth seeing:

```
  Phase A (now)                          Phase B (full coverage)
  ─────────────                          ────────────────────────
  4 agents: replay:promoted wired        all 5 agents wired into the
  into the root pipeline                 promoted-replay pipeline
  rubric-improvement: NOT wired          rubric-improvement: wired
       │                                       │
       └─ can drift under a model              └─ regression-protected like
          update with no test catching it         the other four
```

The cost to close it: add a `replay:promoted` script for rubric-improvement and a promoted fixture. Notable because rubric-improvement is *also* the agent with the widest tool grant (it can `save_judgment` — `04-`), so it's the one you'd most want protected. (audit red-flag 3.)

#### Move 3 — the principle

To test a non-deterministic system, freeze the non-determinism at a seam. You can't assert on an LLM's output directly, but you *can* assert on your code's behavior given a fixed model conversation — by recording the conversation once and replaying it through the same provider port. The provider abstraction (`01-`) is what makes this possible: the fixture is just another `ModelProvider`. A clean seam isn't only for swapping vendors; it's the hook your whole test strategy hangs on.

## Primary diagram

The full recap — the four beats, the determinism flip, the three evaluators.

```
  Replay-eval pipeline — full picture

  ┌─ live run ───────────────────────────────────────────────────────────┐
  │  agent + REAL provider → emits trace → script serializes              │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 ▼  artifacts/replays/*.json  (frozen record)
  ┌─ eval (packages/evals + scripts/eval-replay-artifacts) ───────────────┐
  │  assert shape → score:  structural-diff | detection-scorer | rubric    │
  │  → ReplayArtifactEvalReport { ok, checked, failed, results[] }         │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 ▼  if passing →  promote-replay-to-fixture.mjs
  ┌─ promotion (determinism FLIPS here) ──────────────────────────────────┐
  │  copy inputs + modelResponses:[recorded] + promotion metadata          │
  │  → fixtures/promoted/<timestamp>-<id>.json  (correctness baseline)     │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 ▼  replay-promoted-fixtures.mjs
  ┌─ deterministic replay (no network, no tokens) ────────────────────────┐
  │  FixtureModelProvider(modelResponses) → agent runs identically         │
  │  → assert output  (catches CODE regressions; blind to MODEL drift)     │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** After a live run against OpenAI, you save the artifact (`artifacts/replays/2026-...-voucher-dropoff-w10-on-openai.json`), eval it, and if it passes, promote it — now there's a deterministic fixture that runs in CI for free and fails the moment someone changes the recommendation prompt in a way that breaks parsing. The detection-scorer runs on monitoring artifacts to verify the agent caught the anomalies it should have. The rubric-judge runs when you want a *quality* verdict, not just a shape check.

**The fixture provider** — `packages/agents/recommendation/src/fixture-provider.ts` (lines 3–18, mirrored in every agent):

```
  export class FixtureModelProvider implements ModelProvider {  ← line 3, the PORT
    id = 'fixture';                                             ← line 4
    defaultModel = 'fixture-model';
    requests: ModelRequest[] = [];   ← captures calls for inspection
    private index = 0;               ← line 7, the CURSOR (stateful)

    constructor(private responses: ModelResponse[]) {}          ← line 9, recorded responses

    async complete(request) {
      this.requests.push(request);                              ← line 12
      const response = this.responses[this.index];              ← line 13, by cursor
      this.index += 1;                                          ← line 14, advance
      if (!response) throw ...;                                 ← line 15, exhausted → throw
      return response;
    }
  }
       │
       └─ It's a ModelProvider (line 3) with NO vendor — the agent can't tell the
          difference. The cursor (line 7,13,14) makes it ordered and stateful; running
          off the end (line 15) is how the test catches the agent's control flow drifting.
```

**The promotion transform** — `scripts/promote-replay-to-fixture.mjs` (lines 32–79):

```
  assertReplayArtifactShape(artifact);                          ← lines 32-37, validate first
  const source = load(artifact.fixture.path);                   ← line 39, original inputs
  const promoted = {
    ...source,                                                  ← line 46, keep inputs
    modelResponses: [{                                          ← lines 52-67, the FREEZE
      content: [{ type:'text', text: stripIds(JSON.stringify(artifact.<output>)) }],
      usage: sumModelUsageFromTrace(artifact.trace),            ← lines 60-62
      model: `promoted-${providerId}-replay`,                   ← line 65
    }],
    promotion: { sourceArtifact, provider, promotedAt, note },  ← lines 68-73
  };
  writeFile(`fixtures/promoted/${timestampSlug}-${id}.json`, promoted);  ← lines 76-79
       │
       └─ Lines 52-67 ARE the determinism flip: the recorded output becomes a
          replayable modelResponses entry. IDs stripped + ASCII normalized (lines 89-112)
          so the fixture is STABLE across promotions. Hand-editing this file changes
          the test's meaning — that's why it's regenerated, never edited (must-not-change).
```

**The eval summary shape** — `packages/evals/src/replay-runner.ts` (lines 5–24, 47–94):

```
  ReplayArtifactEvalSummary = { path, ok, issues, capabilityId, provider,
    fixture, recommendationCount, anomalyCount, diagnosisPresent, answerPresent };  ← 5-16
  ReplayArtifactEvalReport = { ok, checked, failed, results[] };                    ← 18-24

  evaluateReplayArtifact(artifact):                              ← lines 47-67
    assertCapabilityReplayArtifactShape(artifact);               ← line 48, shape FIRST
    // then extract metadata + counts
  evaluateReplayArtifactFiles(paths):                            ← lines 70-94
    for each file: read, parse, evaluateReplayArtifact           ← lines 81-85, sequential
    aggregate → { ok, checked, failed }                          ← lines 87-93
       │
       └─ Line 48 asserts shape before scoring — a malformed artifact gets a clear
          "wrong shape" error, not a misleading score. Lines 81-85 loop files one at a
          time (linear, no parallelism — fine for tens of fixtures; audit lens 7).
```

## Elaborate

This is record-replay testing (VCR cassettes in Ruby, Polly.js, nock, MSW in the JS world) applied to LLM agents. The twist for AI: the "response" you record isn't an HTTP body, it's a `ModelResponse` in the run's own neutral format, replayed through the provider port. The promotion step is the addition that makes it a *workflow* rather than a one-off mock — observability data (artifacts) gets promoted into test assets (fixtures) on a passing run, so your regression suite grows from real runs.

The *eval methodology* itself — what makes a good rubric, how to calibrate an LLM judge, detection precision/recall as a model-quality metric — belongs to study-ai-engineering when generated; that guide owns evals as an AI-quality discipline. This guide owns the pipeline as *observability and testing infrastructure*: the artifact is the durable record (`audit.md` lens 3), the fixture is the source-of-truth for expected behavior, and the determinism flip at promotion is the architectural seam. The schema shapes (artifact keys, fixture structure, `CapabilityEvent`) are normalized in study-data-modeling.

Next: this closes the loop with `01-provider-abstraction.md` — the fixture provider is the third kind of port implementation, the one with no vendor at all.

## Interview defense

**Q: How do you regression-test a non-deterministic LLM agent?**

Record-replay. Capture a real run's model responses into a fixture, then replay them through a `FixtureModelProvider` (which satisfies the same provider interface). The agent runs identically but talks to the recording, so the run is deterministic and free — now you can assert on it like any unit test.

```
  live run → artifact (record) → promote → fixture (modelResponses[])
  → FixtureModelProvider replays in order → deterministic, no tokens
```

Anchor: `fixture-provider.ts:3-18` (the replay), `promote-replay-to-fixture.mjs:52-67` (the freeze).

**Q: What does replay catch, and what is it blind to?**

It catches regressions in *your* code — prompt edits that break parsing, loop changes, a wrong tool-call count (the cursor runs off the end and throws). It's blind to *model drift* by design, because the responses are frozen. That's why you also keep live runs and the rubric-judge — replay protects your logic, live runs catch the model changing.

```
  replay catches:  prompt/parser/loop regressions  (frozen conversation)
  replay misses:   model behavior drift            (need live + rubric-judge)
```

Anchor: `fixture-provider.ts:15` (cursor exhaustion throws on drift); the three evaluators in `packages/evals/src`.

## Validate

1. **Reconstruct.** Write `FixtureModelProvider.complete` from memory — the cursor, the advance, the exhaustion throw. Check against `fixture-provider.ts:3-18`.
2. **Explain.** Where does determinism "flip" in the pipeline, and what does the promotion step actually transform? (Hint: `promote-replay-to-fixture.mjs:52-67`.)
3. **Apply.** You change the recommendation agent's prompt and a promoted-fixture replay starts failing. Is that a real regression or a false alarm — and how do you tell? (Hint: replay is blind to model drift but catches code changes.)
4. **Defend.** `rubric-improvement` has no `replay:promoted` coverage and the widest tool grant (audit red-flag 3, `04-`). Argue why that's the highest-priority gap to close.

## See also

- `01-provider-abstraction.md` — the port the fixture provider satisfies.
- `02-bounded-agent-loop.md` — the loop whose trace fills the artifact.
- `04-capability-as-tool-policy.md` — why rubric-improvement's gap matters most.
- `05-multi-agent-pipeline.md` — fixtures let each pipeline stage be tested alone.
- `audit.md` lens 3 (artifact as source of truth), lens 4 (fixture vs cache), red-flag 3.
- study-ai-engineering (when generated) — the eval methodology itself.
