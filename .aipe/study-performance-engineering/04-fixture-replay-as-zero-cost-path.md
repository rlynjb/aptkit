# Fixture Replay as Zero-Cost Path

*Industry names: recorded responses, test double / stub provider,
deterministic replay, golden fixtures. Type: Industry standard (test
double) with a project-specific promotion workflow.*

## Zoom out, then zoom in

Live model calls are the slow, billed part of every run. For development
and eval, you don't need a live model — you need a *known answer that
arrives instantly and free*. This pattern swaps the real provider for a
scripted one that replays recorded responses, turning a multi-second,
metered run into a millisecond, $0 run.

```
  Zoom out — where the fixture provider sits

  ┌─ Agent layer ──────────────────────────────────────┐
  │  RecommendationAgent.propose(...) → runAgentLoop()  │
  └──────────────────────────┬──────────────────────────┘
                            │  calls model.complete()
  ┌─ Provider layer ────────▼───────────────────────────┐
  │  mode = 'fixture' ? ★ FixtureModelProvider ★        │ ← we are here
  │                    : Anthropic / OpenAI (live, $$$) │
  └──────────────────────────┬──────────────────────────┘
                            │  fixture path: no network, no bill
  ┌─ (skipped) Provider network ────────────────────────┐
  │  the round-trip that DOESN'T happen on a fixture run │
  └──────────────────────────────────────────────────────┘
```

Zoom in: `FixtureModelProvider` implements the same `ModelProvider`
interface as the real adapters, but `complete()` just returns the next
item from a pre-recorded array. Same interface, opposite cost. **Be
precise: this is a test double, not a runtime cache** — it's never
consulted to serve live traffic; it's swapped in *instead of* live mode.

## The structure pass

**Layers:** Studio/CLI (picks the mode) → provider seam (fixture or live)
→ network (present on live, absent on fixture).

**Axis — cost per run:** trace the dollar-and-latency cost across the
fixture-vs-live seam.

```
  One axis — "what does one run cost?" — across the fixture/live seam

  ┌─ fixture mode ──────────┐   seam    ┌─ live mode ─────────────┐
  │ $0.00, ~ms              │ ═══╪═════► │ $X, 100s of ms–seconds  │
  │ deterministic           │ (it flips) │ nondeterministic        │
  │ no network              │            │ network + billed tokens │
  └─────────────────────────┘            └─────────────────────────┘
        ▲                                          ▲
        └──── same ModelProvider interface ────────┘
              → the agent code is identical on both sides
```

**The seam that matters:** the `createModelProvider(fixture, mode)`
switch. The agent above it and the loop inside it are byte-for-byte
identical whether you're on fixture or live; only this one factory
decides whether a run touches the network. That's what makes the
zero-cost path a *swap*, not a rewrite — the whole agent runs unchanged.

## How it works

You know how you mock `fetch` in a test so the test runs without a real
server — fast, deterministic, offline? This is that, applied to the model
provider. The twist that makes it a *performance* lever and not just a
testing convenience: the recorded answers can be *promoted from real runs*,
so a fixture isn't a hand-written guess — it's a captured real response you
can replay forever at zero cost.

### Move 1 — the mental model: a scripted provider behind the interface

```
  The kernel — replay the next recorded response

  responses = [r0, r1, r2]   index = 0
       │
  complete(req) ──► return responses[index++]
       │                         │
       │              exhausted? → throw "fixture model exhausted"
       ▼
  same shape as a live ModelResponse → agent can't tell the difference
```

### Move 2 — the step-by-step walkthrough

**The scripted provider (the swap).** `FixtureModelProvider` holds a
`ModelResponse[]` and an index. Each `complete()` returns
`responses[index]` and bumps the index; when it runs out, it throws.
Bridge from what you know: it's a stub that returns canned values in call
order — like a test spy programmed with `.mockReturnValueOnce(...)` for
each call. Because it satisfies the same `ModelProvider` contract, the
agent loop drives it with the exact same code path as a live provider.
The load-bearing detail: it returns responses *in order*, matching the
loop's turn sequence — response 0 for turn 0, response 1 for turn 1. If
the agent makes more turns than there are recorded responses, it throws
rather than fabricating — a deliberate "your fixture is stale" signal.

```
  Call-order replay — matches the loop's turns

  loop turn 0 → complete() → responses[0]  (e.g. tool-call request)
  loop turn 1 → complete() → responses[1]  (e.g. final JSON answer)
  loop turn 2 → complete() → responses[2]? → none → THROW (fixture exhausted)
```

**The mode switch (the seam).** A factory picks the provider from a mode
string: `'fixture'` returns the scripted provider; `'anthropic'` /
`'openai'` return live providers (wrapped in the fallback chain). This is
the single place cost is decided. Drop the switch and you'd need separate
code paths for test vs live — the whole point is that there's one path and
one swap.

```
  createModelProvider(fixture, mode)

  mode == 'fixture'  → new FixtureModelProvider(fixture.modelResponses)   ← $0
  mode == 'anthropic'→ fallback(Anthropic, [OpenAI])                      ← $$$
  mode == 'openai'   → fallback(OpenAI, [Anthropic])                      ← $$$
```

**The promotion step (what makes fixtures trustworthy).** A live run
produces a replay artifact; `promoteCapabilityReplayArtifact` reads it,
captures the *final answer* as a single recorded response, and writes a
promoted fixture with a `promotion` provenance block. Bridge: it's like
recording a real API response into a VCR cassette so the test replays the
real thing. The honest caveat is written into the promotion note itself:
the promoted fixture captures the *final answer deterministically; it does
not reconstruct the live provider tool loop.* So a promoted fixture is a
one-response replay of the conclusion, not a faithful turn-by-turn replay —
that's fine for asserting the answer's shape, but it means the modelTurns
on a promoted run won't match the original live run.

```
  Promotion — capture a real answer into a zero-cost fixture

  live run → replay artifact (recommendations/anomalies/answer + usage)
       │ promoteCapabilityReplayArtifact
       ▼
  promoted fixture: {
     modelResponses: [ { content: [final answer as text/json], usage, model } ],
     promotion: { sourceArtifact, sourceProvider, promotedAt, note: "final answer only" }
  }
       │
       ▼ replayed forever at $0 — a correctness baseline
```

### Move 3 — the principle

**The cheapest call is the one you don't make.** For development and CI,
a recorded response behind the real interface gives you the system's
behavior at zero cost and zero latency — and promotion makes those
recordings real, not guessed. The general lesson: design the expensive
dependency behind an interface from day one, so swapping in a free,
deterministic stand-in is a one-line factory change rather than a refactor.
And keep the words straight: this is a *test double* (swapped in instead of
live), not a *cache* (consulted to serve live traffic) — conflating them
hides the fact that the repo has no real runtime caching.

## Primary diagram

The full fixture-vs-live picture, with cost marked and the promotion loop.

```
  Fixture replay as zero-cost path — full recap

  ┌─ Studio / CLI ─────────────────────────────────────────────┐
  │ pick mode: 'fixture' (dev/eval) | 'anthropic'|'openai' (live)│
  └───────────────────────────────┬────────────────────────────┘
                                  ▼ createModelProvider(fixture, mode)
  ┌─ Provider seam ───────────────┴────────────────────────────┐
  │ FIXTURE                         │ LIVE                       │
  │ FixtureModelProvider            │ Anthropic / OpenAI         │
  │ responses[index++]              │ fallback chain             │
  │ $0.00 · ~ms · deterministic     │ $X · seconds · metered     │
  └─────────────┬───────────────────┴──────────┬─────────────────┘
                │ (no network)                  │ network + tokens
                │                               ▼
                │                        replay artifact
                │   promoteCapabilityReplayArtifact (final answer only)
                └◄──────────────────────────────┘
                   promoted fixture → zero-cost correctness baseline
```

## Implementation in codebase

**Use cases.** Every eval and Studio preview runs in `fixture` mode by
default (`parseMode` falls back to `'fixture'`,
`apps/studio/vite.config.ts:857-860`). The promoted-fixture summary
endpoints replay each promoted fixture in fixture mode to re-check it
costs nothing to run the full eval suite (`vite.config.ts:1000-1001` and
siblings). The three recommendation fixtures, plus monitoring, diagnostic,
query, and rubric fixtures, are all driven this way.

**Code — the scripted provider,
`packages/agents/recommendation/src/fixture-provider.ts:3-18`:**

```
export class FixtureModelProvider implements ModelProvider {   ← same contract as live
  readonly id = 'fixture';
  readonly defaultModel = 'fixture-model';
  readonly requests: ModelRequest[] = [];                      ← records what it was asked
  private index = 0;

  constructor(private readonly responses: ModelResponse[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const response = this.responses[this.index];
    this.index += 1;                                           ← advance in call order
    if (!response) throw new Error(                            ← stale fixture → loud fail
      `fixture model exhausted after ${this.index - 1} responses`);
    return response;                                           ← no network, no bill
  }
}
```

**Code — the mode seam, `apps/studio/vite.config.ts:751-761`:**

```
function createModelProvider(fixture, mode, trace): ModelProvider {
  if (mode === 'fixture') return new FixtureModelProvider(fixture.modelResponses);  ← $0 path
  if (mode === 'anthropic')
    return providerWithConfiguredFallback(requireAnthropicProvider(), [configuredOpenAIProvider()], ...);
  return providerWithConfiguredFallback(requireOpenAIProvider(), [configuredAnthropicProvider()], ...);
       │
       └─ the ONLY place a run's cost is decided; agent + loop are identical above this line
}
```

**Code — the promotion note that keeps it honest,
`apps/studio/vite.config.ts:1347-1353`:**

```
promotion: {
  sourceArtifact: relativeFromWorkspace(artifactPath),
  sourceProvider: artifact.provider,
  promotedAt: new Date().toISOString(),
  note: `This fixture captures the final ${adapter.label} replay answer `
      + `deterministically; it does not reconstruct the live provider tool loop.`,
       │
       └─ states the limitation in the data: promoted = final answer, not the full loop
}
```

## Elaborate

This is the recorded-response test double, standard in any system with an
expensive external dependency — the same shape as VCR cassettes for HTTP
or golden files for serializers. What's worth noticing here is the
*economic* framing: the repo treats the fixture path not just as a test
convenience but as the default development cost posture — you only spend
real tokens when you explicitly choose a live mode. The thing it is *not*
is a runtime cache: a cache serves live traffic on a hit; a fixture is a
script for a known scenario. The repo has no runtime model-response cache
at all (see **audit.md** lens 6, red flag #1) — naming fixtures as a
"cache" would hide that real gap. This pairs with the cost ledger
(**02-token-cost-ledger.md**), which still computes usage on a fixture run
from the recorded `usage` fields, and the turn budget
(**01-turn-and-tool-budget.md**), which runs the same loop over the
scripted provider. For the eval/replay backbone, see **study-testing** and
**study-debugging-observability**.

## Interview defense

**Q: How do you develop and test an agent without burning API budget on
every run?**

Swap the live provider for a `FixtureModelProvider` that replays recorded
`ModelResponse`s in call order behind the same interface. The agent code
is identical; only a one-line factory decides fixture vs live. Dev and CI
run fixture mode by default — $0, deterministic, offline.

```
  mode == 'fixture' ? FixtureModelProvider(responses) : liveProvider
  → same loop, $0 vs $X
```

Anchor: `fixture-provider.ts:11-17`, `vite.config.ts:751-761`.

**Q: Isn't that just a cache?**

No — and the distinction matters. A cache is keyed on the request and
serves *live* traffic on a hit; a fixture is a hardcoded script swapped in
*instead of* live mode. This repo has no runtime response cache at all —
calling fixtures a cache would hide that gap. Fixtures are test doubles;
the missing cache is the biggest unclaimed cost lever.

Anchor: `audit.md` red flag #1.

## Validate

1. **Reconstruct:** write `FixtureModelProvider.complete` from memory —
   index, return-next, throw-on-exhaust. Check `fixture-provider.ts:11-17`.
2. **Explain:** why does it throw when exhausted instead of returning a
   default? (A run that makes more turns than recorded is a stale fixture;
   silent default would mask the drift.)
3. **Apply:** a fixture has 2 recorded responses but the agent's loop runs
   3 turns. What happens, and what does it tell you? (Throws "fixture model
   exhausted after 2"; the fixture no longer matches the agent's behavior.)
4. **Defend:** is it correct to describe the fixture path as the repo's
   "caching strategy"? (No — it's a test double; the repo has no runtime
   cache. Conflating them hides red flag #1.)

## See also

- **02-token-cost-ledger.md** — usage still computed on fixture runs.
- **01-turn-and-tool-budget.md** — the same loop over a scripted provider.
- **audit.md** — lens 6 (caching/batching) and red flag #1 (no real cache).
- **study-testing** / **study-debugging-observability** — the replay backbone.
