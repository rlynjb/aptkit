# Replay-as-test (fixture model provider)

**Industry names:** recorded-response testing · cassette / VCR-style replay ·
test double at the dependency seam. **Type:** Industry standard.

## Zoom out, then zoom in

```
  Zoom out — where the replay seam sits in AptKit

  ┌─ Studio / CLI (test driver) ─────────────────────────────┐
  │  node --test  ·  replay-fixture.ts  ·  Playwright          │
  └─────────────────────────────┬─────────────────────────────┘
                                │ constructs the agent with…
  ┌─ Agent layer ───────────────▼─────────────────────────────┐
  │  RecommendationAgent · QueryAgent · MonitoringAgent · …    │
  │  agent.propose() → runAgentLoop → model.complete()         │
  └─────────────────────────────┬─────────────────────────────┘
                                │  the ONE call into the model
  ┌─ Provider seam ─────────────▼─────────────────────────────┐
  │  interface ModelProvider { complete(req): ModelResponse }  │ ← ★ swap here ★
  │   live:    AnthropicProvider / OpenAIProvider              │
  │   test:    FixtureModelProvider (replays recorded array)   │
  └────────────────────────────────────────────────────────────┘
```

You know how a `fetch()` is the one seam between your component and the network, so
in tests you stub `fetch` and your component never knows the difference? Same move
here. `ModelProvider.complete()` is the *only* way any agent talks to a model.
Stub that one method with recorded responses and the entire agent — loop, tools,
parser — runs deterministically. That's the pattern: **replay-as-test**. The agent
can't tell a recording from a live model, because the seam is the same shape either
way.

## Structure pass

**Layers:** test driver → agent → provider seam → (live model | recorded array).

**Axis — determinism (who decides the output?):** trace it down the stack.

```
  One question down the stack: "is the output deterministic?"

  ┌─ test driver ────────────────┐   deterministic (it's just code)
  └──────────────┬───────────────┘
  ┌─ agent loop ─▼───────────────┐   deterministic GIVEN its inputs
  └──────────────┬───────────────┘
  ┌─ provider seam ▼─────────────┐   ★ the answer flips here ★
  │  live  → NON-deterministic   │
  │  fixture → deterministic     │
  └──────────────────────────────┘
```

**The seam:** `ModelProvider.complete()` is load-bearing because the determinism
axis *flips* across it. Above the seam everything is ordinary deterministic code;
below it, a live model is a coin flip. Put the test double exactly on the flip and
you've quarantined all the non-determinism behind one method. That's why this seam
is worth studying before the mechanics.

## How it works

### Move 1 — the mental model

The shape is a tape player. You recorded the model's turns once, in order. In test,
you press play: each `complete()` call hands back the next recorded turn.

```
  The replay tape — index walks forward, one turn per complete()

  recorded:  [ turn0 ]  [ turn1 ]  [ turn2 ]
                 ▲          ▲          ▲
  complete() #1 ─┘          │          │     index 0 → 1
  complete() #2 ────────────┘          │     index 1 → 2
  complete() #3 ───────────────────────┘     index 2 → 3
  complete() #4 ─────────────────────► THROW "exhausted"
```

The underlying strategy: **substitute the slow/non-deterministic dependency with a
pre-recorded script at the interface boundary.** The interface is the contract; the
recording satisfies it.

### Move 2 — the load-bearing skeleton

This pattern has a tiny irreducible kernel. Here it is in pseudocode:

```
  FixtureModelProvider(recordedResponses):
    index ← 0                          // the tape position
    requests ← []                      // capture what the agent asked

    complete(request):
      requests.push(request)           // ← part A: record the ask
      response ← recordedResponses[index]
      index ← index + 1                // ← part B: advance the tape
      if response is missing:
        throw "exhausted after N"      // ← part C: fail loud on overrun
      return response                  // ← part D: hand back the recording
```

**Part A — capture the request.** `requests.push(request)` keeps every `ModelRequest`
the agent made. This is what lets the test assert *how the agent called the model*,
not just what it returned. Drop it and you lose the ability to assert "the agent
advertised exactly one tool" — a real assertion the suite makes.

**Part B — advance the index.** The single piece of state. It's what makes turn N+1
return a *different* recording than turn N. Drop it and every `complete()` returns
turn 0 forever — an agent loop that should take 2 turns would loop on the same
response.

**Part C — fail loud on overrun.** `throw "exhausted after N"`. This is the part
people forget, and it's load-bearing. If the agent's behavior changes and it now
asks for a 3rd turn when you recorded 2, you want a *loud failure*, not a silent
hang or an `undefined` that limps along. The throw turns a behavior regression into
a red test. Drop it and a changed turn-count fails silently or returns `undefined`
downstream.

**Part D — return the recording.** The actual substitution. Same `ModelResponse`
shape the live provider returns, so the agent above is none the wiser.

**Skeleton vs hardening:** the four parts above are the skeleton. Optional hardening
the repo does *not* yet do: honoring `request.signal` to abort mid-replay (the
rubric judge's scripted provider does check `request.signal?.throwIfAborted()` —
`rubric-judge.test.ts:67` — but `FixtureModelProvider` does not). Adding abort
support would let you test cancellation deterministically.

### Move 3 — the principle

Determinism in a system with a non-deterministic dependency is not achieved by
making the dependency deterministic — it's achieved by **putting a seam in front of
it and substituting a recording in test.** The cleaner the seam, the cheaper the
test. AptKit's seam is one method, so the substitution is one constructor argument.

## Primary diagram

```
  Replay-as-test — full picture, live vs fixture at one seam

  ┌─ TEST ─────────────────────────────────────────────────────┐
  │  new Agent({ model: FixtureModelProvider(recorded), tools }) │
  │         │                                                    │
  │         ▼                                                    │
  │  agent.propose(anomaly, diagnosis)                           │
  │         │  runAgentLoop                                      │
  │         ▼                                                    │
  │   ┌──────────────┐  complete(req) ┌────────────────────┐    │
  │   │ agent loop   │ ─────────────► │ FixtureModelProvider│    │
  │   │ (real code)  │ ◄───────────── │ recorded[index++]   │    │
  │   └──────┬───────┘   ModelResponse└────────────────────┘    │
  │          │ parse + validate (real)                          │
  │          ▼                                                   │
  │   assert shape   assert model.requests[0].tools.length === 1 │
  │   assert events.map(e=>e.type) === [...]                     │
  └──────────────────────────────────────────────────────────────┘
   PROD swaps only the one box: FixtureModelProvider → OpenAIProvider
```

## Implementation in codebase

**Use cases in this repo:**
1. Agent unit tests — every agent test injects a recorded provider and runs the real
   loop (`recommendation-agent.test.ts:42`, `query-agent.test.ts:9`).
2. Fixture replay scripts — `replay:fixture` runs the agent against a fixture JSON
   for integration testing (`packages/agents/query/scripts/replay-fixture.ts`).
3. Studio preview — the UI runs the same fixture replay so a designer can see a real
   agent run with no API key.

**Code side by side — the kernel** (`packages/agents/query/src/fixture-provider.ts`):

```
  packages/agents/query/src/fixture-provider.ts  (lines 3–17)

  export class FixtureModelProvider implements ModelProvider {
    readonly id = 'fixture';              ← identifies the double in traces
    readonly defaultModel = 'fixture-model';
    readonly requests: ModelRequest[] = []; ← part A: capture the asks
    private index = 0;                      ← part B: tape position

    async complete(request: ModelRequest) {
      this.requests.push(request);          ← record what the agent asked
      const response = this.responses[this.index];
      this.index += 1;                      ← advance the tape
      if (!response)                        ← part C: overrun?
        throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
      return response;                      ← part D: hand back the recording
        │
        └─ same ModelResponse shape the live Anthropic/OpenAI provider returns,
           so runAgentLoop above cannot tell the difference (load-bearing)
    }
  }
```

**Code side by side — the assertion that uses `requests`**
(`packages/agents/query/test/query-agent.test.ts`):

```
  packages/agents/query/test/query-agent.test.ts  (lines 10, 24–32)

  const model = new ScriptedModelProvider(fixture.modelResponses as ModelResponse[]);
  ...
  assert.equal(model.requests[0]?.tools?.length, 1);          ← what the agent advertised
  assert.equal(model.requests[0]?.tools?.[0]?.name,
               'get_metric_timeseries');                       ← which tool, exactly
  assert.deepEqual(events.map((event) => event.type), [        ← the trace sequence
    'model_usage', 'tool_call_start', 'tool_call_end',
    'model_usage', 'step',
  ]);
      │
      └─ this asserts the AGENT'S BEHAVIOR (tool policy + loop order), not the
         model's words — exactly the deterministic half of an AI feature
```

Note the wrinkle the audit flags: this test uses an inline `ScriptedModelProvider`
(`query-agent.test.ts:72`) that is identical to the shipped `FixtureModelProvider`.
The query *fixture replay script* uses the real class
(`packages/agents/query/scripts/replay-fixture.ts:42`). Same kernel, two copies.

## Elaborate

This is the VCR/cassette pattern from the Ruby `vcr` gem and Python `vcrpy`,
generalized: record the responses of a slow/non-deterministic dependency once,
replay them in test. AptKit applies it to an LLM instead of an HTTP API. The
adaptation that matters for LLMs: the recording is a `ModelResponse[]` *array*
because an agent makes multiple turns (tool call → result → final answer), so the
tape must advance per turn — that's the index in part B. A single-turn API stub
wouldn't need it.

Where it connects: the recording is captured by the promote lifecycle
(`03-promote-to-fixture-baseline.md`) and asserted on by the structural assertions
(`02-structural-shape-assertions.md`). The seam itself is a `study-system-design`
concern (provider abstraction) — testability is the downstream benefit.

## Interview defense

**Q: How do you test an agent that calls an LLM without flaky tests or burning
tokens?**
> Put the model behind one interface — `ModelProvider.complete()` — and inject a
> fixture provider in test that replays a recorded `ModelResponse[]` by index. The
> agent runs its real loop, tools, and parser; only the model call is recorded.
> Deterministic, free, fast.

```
  agent ──complete()──► [ ModelProvider ]
                          live  → real model (flaky, costs tokens)
                          test  → recorded array[index++] (deterministic)
```
> Anchor: the determinism axis flips at exactly one seam, so the double goes there.

**Q: What's the part people get wrong?**
> The exhaustion throw. If you return `undefined` when the tape runs out, a
> behavior change that adds a model turn fails silently. Throwing
> `"exhausted after N"` turns a turn-count regression into a red test — that's the
> load-bearing part, not the happy-path return.

## Validate

1. **Reconstruct:** write the `FixtureModelProvider` kernel from memory — index,
   requests array, advance, exhaustion throw, return. Check against
   `packages/agents/query/src/fixture-provider.ts:3`.
2. **Explain:** why does `recommendation-agent.test.ts:111` assert on
   `model.requests[0].tools.length` instead of the model's output text?
3. **Apply:** the diagnostic agent now needs two model turns instead of one. What
   breaks in its fixture, and what error tells you? (Answer: the recorded array has
   one response; `complete()` throws "exhausted after 1" — see
   `packages/agents/diagnostic-investigation/src/fixture-provider.ts`.)
4. **Defend:** why is the inline `ScriptedModelProvider` duplication
   (`query-agent.test.ts:72`) low-priority debt rather than a bug?

## See also

- `02-structural-shape-assertions.md` — what you assert on the replayed output.
- `03-promote-to-fixture-baseline.md` — where the recordings come from.
- `05-playwright-smoke-gate.md` — replay driven through the real UI.
- `audit.md` lens 4 (determinism) and lens 2 (the duplication wrinkle).
