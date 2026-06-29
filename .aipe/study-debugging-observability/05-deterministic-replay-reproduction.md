# Deterministic replay as reproduction

*Industry names: record/replay · golden-fixture reproduction · deterministic test double. Type: project-specific (FixtureModelProvider over recorded ModelResponse[]).*

## Zoom out — where this lives

Step one of debugging anything is *reproduce it*. For an LLM agent that's hard — the model is non-deterministic, it needs a network, and a flaky run won't repeat. aptkit's answer: record a real run's model responses, then replay them through a fake provider that always returns the same thing in the same order. The bug becomes a unit test.

```
  Zoom out — where reproduction sits in the seam

  ┌─ Service: agent loop (runtime) ─────────────────────────────────┐
  │  runAgentLoop depends on ModelProvider.complete()  — a contract │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  the swappable seam
       ┌──────────────────────┼───────────────────────────┐
       ▼                      ▼                            ▼
  ┌─ live ───────┐   ┌─ ★ FixtureModelProvider ★ ┐   ┌─ guarded ──┐
  │ GemmaProvider│   │ replays recorded          │   │ context    │
  │ HTTP :11434  │   │ ModelResponse[]           │   │ window     │
  │ stochastic   │   │ deterministic, no network │   │ guard      │
  └──────────────┘   └───────────────────────────┘   └────────────┘
                       fixture-provider.ts (per agent)  ← we are here
```

## Zoom in — what it is

`FixtureModelProvider` (`packages/agents/recommendation/src/fixture-provider.ts:3-18`, and a copy per agent) implements the same `ModelProvider` contract as the real Gemma/OpenAI/Anthropic adapters, but instead of calling a model it hands back a pre-recorded `ModelResponse[]`, one per turn, in order. Swap it in where the real provider goes and the agent loop runs identically — same tool calls, same trace — with zero network and perfect determinism. The question it answers: *can I make this bug happen again, on demand, offline?*

## How it works

### Move 1 — the mental model

You've done this in frontend tests: instead of letting a component call the real API, you hand it a mock `fetch` that returns a fixed JSON blob. The component can't tell the difference — it calls `fetch`, gets a response, renders. `FixtureModelProvider` is that mock, but for the model: the loop calls `complete()`, gets a canned `ModelResponse`, and proceeds. Because the contract is the same, the loop is none the wiser.

```
  The pattern — a queue of canned responses behind the contract

  responses = [ R0, R1, R2 ]      (recorded from a real run)
   index 0 ──► complete() #1 returns R0   ┐
   index 1 ──► complete() #2 returns R1   ├─ in order, deterministic
   index 2 ──► complete() #3 returns R2   │
   index 3 ──► complete() #4 → throws     ┘  "fixture exhausted"
```

### Move 2 — the load-bearing skeleton

The kernel is tiny. The whole provider is the queue plus the exhaustion guard.

**Part 1 — implement the contract, return canned responses in order.** `fixture-provider.ts:3-18`:

```ts
export class FixtureModelProvider implements ModelProvider {
  readonly id = 'fixture';
  readonly requests: ModelRequest[] = [];   // also records what it was ASKED — useful for assertions
  private index = 0;
  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    this.index += 1;
    if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
    return response;
  }
}
```

What breaks if you remove the ordered `index`: the agent loop is a *multi-turn* conversation. Turn 1 might be "call search_knowledge_base," turn 2 "here's the answer." If responses came back unordered or repeated, you'd replay the wrong turn and the loop would diverge from the recorded run. The monotonic `index` is what makes the replay match the original trajectory turn-for-turn.

**Part 2 — the exhaustion guard.** When the loop asks for more turns than were recorded, the provider throws "fixture exhausted." What breaks without it: a silent `undefined` flows into the loop and you get a confusing crash deep inside response parsing instead of a clear "your fixture is one turn short." The guard turns a subtle replay drift into a loud, located error.

**Part 3 — the seam it plugs into.** This only works because the loop depends on `ModelProvider.complete()`, never a vendor SDK (`run-agent-loop.ts:103`). The fixture provider is a drop-in *because the contract was the boundary*. Same reason buffr can swap in `PgVectorStore` for the in-memory store — the seam is the whole game.

### Reproducing the war-story bug, concretely

The retrieval bug from `03`/`04` is reproduced offline in `packages/retrieval/test/search-knowledge-base-tool.test.ts:105-117` — but note the layering, because it's instructive. That test doesn't even need a fake *model*; it reproduces the bug one layer lower, at the tool, with a **fake embedder** instead:

```ts
// search-knowledge-base-tool.test.ts:14-30 — a deterministic embedder: hashes words into a fixed vector
function makeFakeEmbedder(dimension: number): EmbeddingProvider { /* word-hash → vector */ }

// :105-117 — the reproduction: seed a corpus, fire the hallucinated filter, assert non-empty
test('ignores filter keys absent from chunk metadata (...)', async () => {
  const { result } = await registry.callTool(SEARCH_KNOWLEDGE_BASE_TOOL_NAME, {
    query: 'how often does the moon orbit earth',
    filter: { textContains: 'moon' },     // the exact hallucinated key from the incident
  });
  assert.ok(payload.results.length > 0);
});
```

This is the reproduction discipline at two altitudes:

```
  Layers-and-hops — reproduce at the lowest layer that still shows the bug

  ┌─ full agent run ──────────────────────────────────────────────┐
  │  FixtureModelProvider replays Gemma's turns (incl. the         │
  │  hallucinated filter) → loop → tool → empty results            │  ← highest fidelity
  └───────────────────────────┬────────────────────────────────────┘
                              │  but the bug lives in the TOOL, so drop down:
  ┌─ tool-level repro ────────▼────────────────────────────────────┐
  │  fake embedder + InMemoryVectorStore + the hallucinated filter  │  ← what the test does:
  │  → assert results non-empty                                     │    fastest, no model
  └───────────────────────────────────────────────────────────────────┘
```

The lesson: reproduce at the lowest layer that still exhibits the bug. The bug was in `matchesFilter`, so the test fakes the embedder and skips the model entirely — faster, and it isolates the fault.

### The record → replay → promote loop (the wider system)

Fixtures aren't hand-written. They're recorded from real runs and promoted. The scripts in `scripts/` (`promote-replay-to-fixture.mjs`, `replay-promoted-fixtures.mjs`) capture a live run's `ModelResponse[]` into `fixtures/promoted/*.json`, timestamped as correctness baselines (per `context.md`: "Promoted fixtures are correctness baselines — editing them changes test meaning"). Studio's "Run Fixture" mode (`AgentReplayShell.tsx:118-120`) replays them in-browser. So a real bug, once captured, becomes a permanent, offline, deterministic reproduction.

> Partition note: the *eval* semantics that grade these replays (structural-diff, detection-scorer, precision@k) belong to `study-testing` and `study-ai-engineering`. This file owns only the *reproduction* mechanism — making the bug happen again deterministically.

### Move 3 — the principle

**Reproduction is a property of your seams, not your cleverness.** You can deterministically replay an agent run only because the one source of non-determinism — the model — sits behind a swappable contract. The fixture provider is fifteen lines; the design work was putting `ModelProvider.complete()` at the boundary in the first place. The general move: isolate every non-deterministic dependency (clock, network, model, RNG) behind an interface, and reproduction becomes "hand it a canned implementation."

## Primary diagram

```
  Record → replay → reproduce

  live run                  recorded artifact            deterministic replay
  ┌─ GemmaProvider ─┐  ───► ┌─ fixtures/*.json ─┐  ───►  ┌─ FixtureModelProvider ─┐
  │ HTTP, stochastic│       │ ModelResponse[]   │        │ queue + index + guard  │
  └─────────────────┘       │ (promoted baseline)│        └───────────┬────────────┘
                            └───────────────────┘                    │ same contract
                                                       ┌─ runAgentLoop (unchanged) ─┐
                                                       │ same tool calls, same trace│
                                                       │ → bug reproduced, offline  │
                                                       └─────────────────────────────┘
  bug-specific shortcut: reproduce at the TOOL layer with a fake embedder
  (search-knowledge-base-tool.test.ts:14-30, 105-117) — no model needed
```

## Elaborate

Record/replay is an old testing technique (VCR cassettes in Ruby, nock in Node, Playwright's request mocking) lifted up to the model layer. What's specific to an agent is that a "request" is a *multi-turn loop*, so the fixture is an ordered *array* of responses, and the replay must be turn-faithful — hence the monotonic index and the exhaustion guard. The connection back to observability: the trace (`01`) is what you record *from*. A run produces a trace; the trace's model turns become the fixture; the fixture reproduces the run. Observability and reproduction are two ends of the same recorded artifact.

The honest edge: a fixture freezes one path. If the model would now behave differently (a new Ollama version, a prompt change), the fixture replays the *old* behavior. That's a feature for regression (you want the baseline frozen) and a trap for "is the live model still doing this?" — which is exactly why both `fixture` and live modes exist side by side in Studio.

## Interview defense

**Q: How do you reproduce a non-deterministic agent bug?**

I record the real run's model responses and replay them through `FixtureModelProvider`, which implements the same `ModelProvider.complete()` contract but returns canned responses in order. The loop runs identically with no network — deterministic. For a bug that lives below the model, like the retrieval filter bug, I reproduce even lower: a fake hash-based embedder plus the in-memory store, no model at all.

```
  non-determinism (model) behind a contract → swap in a canned impl → repeatable
```

One-line anchor: *reproduction falls out of your seams — isolate the model behind `complete()` and the fake provider is fifteen lines.*

**Q: What's the part people forget in a replay double?**

The exhaustion guard. The loop is multi-turn; if it asks for one more turn than you recorded, you want a loud "fixture exhausted after N responses," not an `undefined` crashing deep in parsing. And the responses must be ordered by a monotonic index — a multi-turn replay that returns turns out of order silently diverges from the run you're trying to reproduce.

## See also

- `01-capability-event-trace.md` — the trace you record *from*.
- `03-persisted-trajectory-backward-read.md` — the bug this reproduces.
- `04-silent-empty-result-blind-spot.md` — the condition the reproduction test locks down.
- Cross-guide: `study-testing` owns the eval/promotion semantics; `study-system-design` owns the provider seam this exploits.
