# Injected model port — the fixture seam

**Industry name:** dependency injection at a port boundary; the test double is
a *fake* (here `FixtureModelProvider`). Type label: Industry standard.

## Zoom out, then zoom in

This is the move the whole suite stands on. Every other testing pattern in
aptkit is a variation of it.

```
  Zoom out — where the seam lives

  ┌─ Capability layer (agents) ──────────────────────────────┐
  │  RecommendationAgent · QueryAgent · RagQueryAgent · ...   │
  │  prompt package → runAgentLoop → tool dispatch → parse    │
  └────────────────────────────┬─────────────────────────────┘
                               │  ★ ModelProvider.complete() ★  ← THE SEAM
  ┌─ Provider layer (adapters) ▼─────────────────────────────┐
  │  test:  FixtureModelProvider (replays recorded responses)│
  │  prod:  Gemma / Anthropic / OpenAI / Fallback            │
  └────────────────────────────┬─────────────────────────────┘
                               │  HTTP (only in prod)
  ┌─ Provider (real model) ────▼─────────────────────────────┐
  │  Ollama :11434 · api.anthropic.com · api.openai.com      │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The agent depends on an interface — the port (`ModelProvider`) —
not on `@anthropic-ai/sdk`. So in a test you hand the agent a fake adapter that
returns scripted `ModelResponse[]` and the agent never knows the difference.
The question this answers: *how do you assert `equals` against a model that
answers differently every time?* You don't test the model. You inject a
recording of it, and test everything the agent does with that recording.

## Structure pass

**Layers:** capability (agent) → port (`ModelProvider`) → adapter (provider) →
real model. **One axis — control over the model's output:** who decides what
the model returns?

```
  Axis: who controls the model's response?

  ┌─ agent layer ─┐   seam    ┌─ provider layer ─┐
  │ asks: complete│ ═════╪═══► │ DECIDES the reply│
  └───────────────┘ (it flips)└──────────────────┘
         in prod:                the real model decides (random)
         in test:                the TEST decides (FixtureModelProvider)
```

The axis flips at the `ModelProvider` seam: above it, control is the same in
test and prod (the agent just asks). Below it, control moves — in prod the
model decides, in test *the test author* decides. That flip is the entire
testability story. The seam is load-bearing; study it before either side.

## How it works

### Move 1 — the mental model

You already know this shape from frontend: you don't test a component by
hitting the real API — you pass it a `fetch` stub (or MSW handler) that returns
a fixed payload, then assert the component renders it right. Same idea, one
layer deeper. The "API" here is the model; the "stub" is a provider that
implements the same `ModelProvider` interface and returns canned
`ModelResponse[]`.

```
  The pattern — script the responses, drive the assembly

  responses = [ resp0, resp1, ... ]   // recorded, in order
       │
       ▼  each complete() call shifts one off the list
  ┌─────────────────────────────────────────────┐
  │ FixtureModelProvider.complete(request):      │
  │   record request                             │
  │   return responses[index++]                  │
  │   (throw if exhausted)                        │
  └─────────────────────────────────────────────┘
       │
       ▼  agent runs its real loop against these
  assert: exact output · exact trace · exact tool offered
```

### Move 2 — the walkthrough

#### The fake is 18 lines, and that's the point

The whole test double:

```ts
// packages/agents/recommendation/src/fixture-provider.ts:3
export class FixtureModelProvider implements ModelProvider {
  readonly id = 'fixture';
  readonly defaultModel = 'fixture-model';
  readonly requests: ModelRequest[] = [];   // captures inputs for assertions
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);             // ← record what the agent asked
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
    return response;                          // ← replay, in order
  }
}
```

Two responsibilities. **Replay** — `responses[index++]` hands back the next
recorded reply, in order, so a multi-turn loop (tool call, then synthesis) gets
the right reply per turn. **Record** — `this.requests.push(request)` captures
every request the agent built, so the test can assert *what the agent sent the
model*, not just what it did with the reply. The exhaustion throw turns "the
agent looped more than expected" into a loud failure instead of a silent
`undefined`. Nothing else. No network, no framework.

#### Driving a multi-turn agent with two scripted turns

The recommendation agent runs a model→tool→model loop. The test scripts both
turns: turn 1 a `tool_use`, turn 2 the final JSON. Watch it drive the *real*
loop:

```ts
// packages/agents/recommendation/test/recommendation-agent.test.ts:42
const model = new ScriptedModelProvider([
  { content: [{ type: 'tool_use', id: 'tool-1', name: 'list_scenarios',
               input: { project_id: 'demo-project' } }], ... },   // turn 1
  { content: [{ type: 'text', text: '```json\n' + JSON.stringify([ ... ]) + '\n```' }], ... }, // turn 2
]);
const agent = new RecommendationAgent({ model, tools, workspace,
  trace: { emit: (e) => events.push(e) },
  idGenerator: () => 'rec-1' });              // ← randomness injected out

const recommendations = await agent.propose(anomaly, diagnosis);

assert.equal(recommendations[0]?.id, 'rec-1');             // exact id
assert.equal(model.requests[0]?.tools?.length, 1);          // ← only allowed tool offered
assert.deepEqual(events.map((e) => e.type), [               // ← exact trace
  'model_usage', 'tool_call_start', 'tool_call_end', 'model_usage', 'step',
]);
```

Three assertions, three different things the agent did — and all are exact
because the model is scripted and the id is injected (`idGenerator: () => 'rec-1'`,
`:103`). The most interesting one is `model.requests[0].tools.length === 1`
(`:111`): the agent was given two tools but the least-privilege policy filtered
`unsafe_write_campaign` out, so the model was only *offered* the safe one. The
recorded-request capture is what lets the test see that.

#### Move 2 variant — the load-bearing skeleton

Strip the fake to its kernel: **an ordered list of recorded responses + an
index that advances per call + an exhaustion guard.** Name each by what breaks
without it:

- **Drop the ordered list** → you can't drive a multi-turn loop; turn 2 can't
  differ from turn 1.
- **Drop the index advance** → every `complete()` returns the same reply; the
  tool-call turn and the synthesis turn collide.
- **Drop the exhaustion throw** → an agent that loops one turn too many gets
  `undefined` and fails with a confusing downstream error instead of "fixture
  exhausted after N." The guard turns a loop bug into a legible failure.

Optional hardening (not in the kernel): the `requests` capture array. The fake
*replays* without it; it exists so tests can assert on inputs. Worth it, but
not load-bearing for replay itself.

### Move 3 — the principle

Test the deterministic assembly, not the non-deterministic part. The model is
the one thing you can't assert `equals` against — so push it behind a port and
inject a recording. Everything above the port (prompt assembly, loop control,
tool dispatch, parsing, validation, trace emission) is deterministic and gets
tested exactly. This is dependency inversion (study-software-design) read as a
*testing* enabler: the inversion you drew for swap/fallback is the same one
that buys fixture-ability for free.

## Primary diagram

```
  The injected model port — full picture

  TEST                                    PRODUCTION
  ────                                    ──────────
  responses[] (recorded)                  real model behind HTTP
        │                                       │
        ▼                                       ▼
  ┌─ FixtureModelProvider ─┐          ┌─ GemmaModelProvider ─┐
  │ implements ModelProvider│         │ implements ModelProvider│
  └───────────┬─────────────┘         └───────────┬───────────┘
              │  same .complete() port             │
              └──────────────┬─────────────────────┘
                             ▼
              ┌─ agent assembly (UNCHANGED) ─┐
              │ prompt → runAgentLoop →      │
              │ tool dispatch → parse →      │
              │ validate → emit trace        │
              └──────────────┬───────────────┘
                             ▼
        assert: exact output · exact trace · exact tool offered
```

## Elaborate

This is the classic "test double at a seam" from xUnit literature, specialized
for LLMs. The reason it's a *fake* (a working implementation with shortcut
behavior) rather than a *mock* (an object with expectation assertions baked in)
matters: the fake lets the agent run its real logic and the test asserts
afterward, which keeps the assertions in the test where you can read them. A
mock framework would scatter expectations into setup. aptkit needs no mock
framework precisely because the seam is a constructor parameter.

The same fake powers two things beyond unit tests: the `replay:fixture` scripts
(live-recorded responses replayed deterministically) and the promoted-fixture
golden masters (`03-promoted-fixture-golden-master.md`). One seam, three uses.

## Interview defense

**Q: How do you unit-test an agent when the model is non-deterministic?**
You don't test the model. You depend on a port (`ModelProvider`) instead of the
vendor SDK, and inject a fake that replays recorded `ModelResponse[]`. The
agent runs its real loop; you assert the deterministic parts — output, trace,
which tools were offered.

```
  agent ──complete()──► [ fake replays recorded responses ]
        assert exact output + exact trace, model never random
```

Anchor: *the model is the one thing I can't assert equals against — so I push
it behind a port and test everything above it.*

**Q: What's the one part of that fake people forget?**
The exhaustion guard. Without it, an agent that loops one turn too many gets
`undefined` and fails downstream with a confusing error. The guard
(`throw 'fixture exhausted after N'`) turns a loop-budget bug into a legible
failure pointing at the real cause.

```
  responses[index++] → if undefined: THROW "exhausted after N"
                       (not silent undefined → confusing downstream crash)
```

Anchor: *naming the exhaustion throw is how you signal you've debugged a real
over-looping agent, not just read about fakes.*

## See also

- `02-injected-transport.md` — the same seam one layer deeper, inside a provider.
- `03-promoted-fixture-golden-master.md` — the recorded-response idea promoted
  to a regression baseline.
- `audit.md` lens 3 (tests-as-design-pressure) and lens 6 (testing-ai-features).
- study-software-design — dependency inversion as a *design* property; this file
  reads it as a *testing* property.
