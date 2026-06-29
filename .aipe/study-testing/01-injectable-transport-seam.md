# Injectable-transport seam

**Subtitle:** Dependency injection at the I/O boundary / constructor-injected
transport / "humble object" seam — *Project-specific* application of an
*Industry-standard* pattern.

## Zoom out, then zoom in

Every test in aptkit that touches a model, an embedder, or a network call is
fast and offline. That isn't luck — it's one design decision repeated at every
expensive boundary. Here's where the seam lives in the stack.

```
  Zoom out — where the injectable transport sits

  ┌─ Agent layer ────────────────────────────────────────────────┐
  │  RagQueryAgent / RecommendationAgent / ...                    │
  │  takes { model, tools, trace } — all injected                │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  calls provider.complete()
  ┌─ Provider layer ──────────────▼───────────────────────────────┐
  │  GemmaModelProvider   ★ takes `chat` ★   ← THE SEAM            │ ← here
  │  OllamaEmbeddingProvider  ★ takes `embed` ★                   │
  │  FallbackModelProvider    ★ takes `providers[]` ★             │
  └───────────────────────────────┬───────────────────────────────┘
                                  │  the injected fn does the I/O
  ┌─ Transport layer ─────────────▼───────────────────────────────┐
  │  PRODUCTION: fetch → Ollama :11434 / Anthropic / OpenAI       │
  │  TEST:       async () => recordedResponse   (no network)      │
  └────────────────────────────────────────────────────────────────┘
```

The pattern: the class doesn't *create* its I/O, it *receives* it. The
expensive, non-deterministic thing (the HTTP call) is a function passed in at
construction. Production passes the real `fetch`-backed function; a test passes
`async () => ({ message: {...} })`. Same class, same code path, swapped bytes.

## Structure pass

Three layers, one axis, one seam that matters.

**Layers:** agent (decides *when* to call the model) → provider (translates the
neutral `ModelRequest` into a wire call) → transport (does the actual I/O).

**Axis — trust / nondeterminism:** "can this layer's output change between two
identical runs?"

```
  One axis traced down the stack: "is this deterministic?"

  ┌─ agent ─────────────────┐   deterministic (pure control flow given
  │  loop, dispatch, parse  │   the provider's replies)
  └───────────┬─────────────┘
              │  seam ═══════════ ◄── nondeterminism is injected HERE
  ┌─ provider ▼─────────────┐   deterministic wrapper...
  │  request shaping         │   ...around a transport it does not own
  └───────────┬─────────────┘
              │
  ┌─ transport ▼────────────┐   NONDETERMINISTIC in prod (network, LLM)
  │  the injected fn         │   DETERMINISTIC in test (returns a constant)
  └──────────────────────────┘
```

**The seam:** the constructor argument. Above it, everything is deterministic
control flow worth unit-testing. Below it lives all the nondeterminism. Because
the seam is a function parameter, a test substitutes the entire bottom layer
with a constant — and gets to assert the deterministic layers in full.

## How it works

### Move 1 — the mental model

You already know this shape from frontend: a component that takes `onSubmit`
as a prop instead of calling `fetch` itself is trivially testable — you pass a
spy, render, click, assert the spy was called. The component never knew whether
it was talking to a real API or your test. aptkit does the same thing one layer
down: the *provider* takes its network call as a parameter.

```
  The seam — "humble object": all logic above, all I/O below

         ┌──────────────────────────────┐
         │  provider.complete(request)   │   ← logic you want to test:
         │   1. shape the request        │     shaping, decoding, retry
         │   2. call  this.chat(payload) │ ──┐
         │   3. decode the reply          │   │  the ONE line that does I/O
         │   4. retry if unparseable      │   │  is the injected fn
         └──────────────────────────────┘   │
                                             ▼
                    prod:  fetch(:11434)   |   test:  () => recordedReply
```

The strategy in one sentence: **push all the I/O into a single injected
function so everything around it becomes a pure unit test.**

### Move 2 — the walkthrough

**The constructor takes the transport.** `GemmaModelProvider` doesn't import an
Ollama client. It accepts `chat` — the function that does the HTTP POST. In
the test, `chat` is a closure that returns a recorded Gemma reply:

```ts
// packages/providers/gemma/test/gemma-provider.test.ts:30
const provider = new GemmaModelProvider({
  chat: async () => ({
    model: 'gemma2:9b',
    message: { role: 'assistant', content: recordedMessyToolCall },
  }),
});
const response = await provider.complete(weatherRequest);
```

`recordedMessyToolCall` (line 9) is a real captured Gemma2:9b reply — prose
wrapped around a fenced JSON tool call, because Gemma has no native
tool-calling. No `:11434` is touched. The test then asserts the provider
decoded that messy blob into a clean `tool_use` block with
`input: { location: 'Paris', unit: 'celsius' }` (line 46). **What's tested is
the decode logic; what's faked is the byte source.**

**The transport can be a spy, to assert what the provider sent.** Flip the
closure to *capture* its argument and you test the request-shaping side:

```ts
// packages/providers/gemma/test/gemma-provider.test.ts:53
let captured;
const provider = new GemmaModelProvider({
  chat: async (payload) => { captured = payload; return { message: {...} }; },
});
await provider.complete(weatherRequest);
const system = captured.messages.find((m) => m.role === 'system');
assert.match(system.content, /get_weather/);   // tools rendered into system
```

This is the prompt-assembly assertion from audit lens 6 — possible *only*
because the transport is injectable. You can read exactly what bytes the
provider would have put on the wire.

**The same shape at every boundary.** The embedder takes `embed`
(`ollama-embedding-provider.test.ts:18` — the injected transport returns
`texts.map((_, i) => [i, i+1, i+2])`, asserting one vector per input). The
fallback provider takes an array of `providers` and the test passes
hand-rolled failing/succeeding ones (`fallback-provider.test.ts:67`). The
agents take `{ model, tools, trace }`. There is no `new OllamaClient()`
anywhere in a constructor — the dependency always arrives from outside.

```
  Layers-and-hops — production vs test, same code path

  ┌─ Test ───────────┐  hop 1: complete(request)   ┌─ Provider ──────┐
  │  unit test        │ ──────────────────────────► │  shape → call → │
  │                   │  hop 4: ModelResponse ◄───── │  decode → retry │
  └───────────────────┘                             └────────┬────────┘
                                              hop 2 │ chat(payload)
                                                    ▼
                              ┌─ Transport (injected) ─────────────┐
   PROD:  fetch → :11434      │  TEST: async () => recordedReply    │
   ◄──────────────────────────┤  hop 3: returns a constant, no net  │
                              └─────────────────────────────────────┘
```

### Move 2 variant — the kernel

Strip this to its irreducible core and it's three parts:

1. **The contract** — `ModelProvider` / `EmbeddingProvider`. The neutral shape
   both real and fake implement. *Remove it and* the fake and the real diverge;
   a passing test stops meaning the real thing works.

2. **The injection point** — the constructor parameter (`chat`, `embed`,
   `providers`). *Remove it* (hard-code `new OllamaClient()` inside) *and* the
   only way to test is to stand up a real Ollama — network, flake, slow.

3. **The pure logic above the seam** — request shaping, decoding, retry. This
   is what the test actually asserts. *Remove the seam below it* and you can't
   reach this logic without the network.

Optional hardening, not kernel: abort-signal forwarding, retry counts,
fallback predicates. Those are tested too, but they're layered on the kernel,
not the kernel itself.

### Move 3 — the principle

The principle generalizes far past LLMs: **own your logic, inject your I/O.**
Anything nondeterministic or expensive — a clock, a random source, a network
call, a DB handle — should arrive as a parameter, so the deterministic logic
wrapping it becomes a pure unit test. aptkit applies it so consistently that
"how do you test the Gemma provider without Ollama running?" has a one-word
answer: you don't run Ollama. The seam was there from the first line.

## Primary diagram

```
  Injectable-transport seam — the full picture

  ┌─ Agent ──────────────────────────────────────────────────────┐
  │  takes { model, tools, trace } — all injected                │
  └──────────────────────────────┬────────────────────────────────┘
                                 │ provider.complete(request)
  ┌─ Provider (the humble object) ▼────────────────────────────────┐
  │  TESTABLE LOGIC:  shape request → decode reply → retry          │
  │  ONE I/O LINE:    result = this.chat(payload)  ◄── the seam     │
  └──────────────────────────────┬────────────────────────────────┘
            ┌────────────────────┴────────────────────┐
            ▼                                          ▼
  ┌─ PROD transport ──────┐                 ┌─ TEST transport ──────┐
  │  fetch → Ollama/cloud │                 │  () => recordedReply  │
  │  nondeterministic      │                 │  deterministic const  │
  └────────────────────────┘                 └───────────────────────┘
```

## Elaborate

This is the "Humble Object" pattern (Meszaros, *xUnit Test Patterns*) — push
logic out of the hard-to-test object into a testable one, leaving the I/O
object humble. Same idea as Hexagonal / Ports-and-Adapters: the contract is the
port, the real Ollama call and the fake closure are two adapters. aptkit's
context.md names this as the "provider-neutral core" architecture seam — the
testing payoff (everything fakeable) and the architecture payoff (swap
Anthropic for Gemma) are *the same seam* viewed from two angles. The
architecture story is study-system-design / study-software-design; the testing
story is here.

## Interview defense

**Q: How do you test the Gemma provider without Ollama running?**

> You don't run Ollama. The provider takes its HTTP call as a constructor
> argument — `chat` — so in the test I pass a closure that returns a recorded
> Gemma reply. The provider's decode-and-retry logic runs for real against
> recorded bytes. The thing I'm testing (does it turn a messy fenced-JSON blob
> into a clean tool_use block?) is deterministic; the only nondeterministic
> part — the network — is the one thing I swapped.

```
  provider.complete → [shape | decode | retry]  ← tested
                            └ chat(payload) ─────── swapped for a constant
```

Anchor: *own your logic, inject your I/O — the seam was there from line one.*

**Q: Isn't a fake closure just a mock that tests the mock?**

> No — the fake implements the same `ModelProvider` / transport contract
> production uses, and the test exercises the real provider logic and the real
> agent loop on top of it. I'm not stubbing internal calls; I'm substituting
> the byte source at a public boundary. The mock-tests-the-mock smell is when
> the assertion is "the mock was called" with no real logic in between. Here
> the assertion is "the decoded output equals this exact tool_use block."

Anchor: *contract fake at a public seam, not an internal stub.*

## See also

- `02-fixture-replay-golden-master.md` — the same seam used to replay whole
  recorded trajectories, not just single replies.
- `04-deterministic-eval-scorers.md` — what runs *above* the seam once the
  bytes are deterministic.
- `audit.md` lens 2 (no over-mocking) and lens 3 (tests as design pressure).
- study-software-design — the deep-module / inverted-dependency design this
  testability is downstream of.
