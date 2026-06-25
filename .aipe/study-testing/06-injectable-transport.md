# Injectable transport (the HTTP seam inside a provider)

**Industry names:** transport injection · seam-below-the-adapter ·
constructor-injected HTTP client · the "test the decode, fake the wire" double.
**Type:** Industry standard (DI), applied at a project-specific seam.

## Zoom out, then zoom in

```
  Zoom out — two seams, one above the provider, one inside it

  ┌─ Agent layer ─────────────────────────────────────────────┐
  │  RagQueryAgent.answer() → runAgentLoop → model.complete()  │
  └─────────────────────────────┬─────────────────────────────┘
                                │ SEAM 1 (coarse): swap the whole
                                │ ModelProvider  → 01-replay-as-test.md
  ┌─ Provider seam ─────────────▼─────────────────────────────┐
  │  GemmaModelProvider.complete(req)                          │
  │    buildSystemText → chat(payload) → parseToolCall         │ ← real decode logic
  └─────────────────────────────┬─────────────────────────────┘
                                │ SEAM 2 (fine): swap the transport
                                │ ★ inject `chat` / `embed` ★   ← we are here
  ┌─ Wire ──────────────────────▼─────────────────────────────┐
  │  POST http://localhost:11434/api/chat   (Ollama)          │
  │  in tests: a recorded async fn, never a socket            │
  └────────────────────────────────────────────────────────────┘
```

The replay-as-test pattern (`01-replay-as-test.md`) swaps the *entire*
`ModelProvider` — clean, but it means the provider's own logic never runs in the
agent test. That's fine for an Anthropic adapter where the SDK does the work.
It's not fine for `GemmaModelProvider`, where **the provider IS the interesting
code**: Gemma2:9b has no native tool-calling, so the provider has to render tools
into a system string on the way out and decode a JSON-in-prose blob back into a
clean `tool_use` block on the way in (`gemma-provider.ts:133`, `:168`). Swap the
whole provider and you'd never test that decode. So the new packages cut a
*second, finer* seam one layer down: inject the HTTP call itself. The real decode
runs; only the socket is faked.

## The structure pass

**Layers.** Three, top to bottom: the agent (calls `complete`), the provider
(decodes/encodes), the transport (talks to Ollama over HTTP). Two seams sit
between them.

**Axis — trust the bytes, control the call.** Trace one question down the stack:
*where does a test get to substitute a fake?*

```
  One axis: "what does the test fake, and what runs for real?"

  ┌─ agent test (rag-query) ──────┐   fakes ModelProvider (seam 1)
  │  ScriptedProvider             │   → provider decode does NOT run
  └───────────────┬───────────────┘
  ┌─ provider test (gemma) ───────┐   fakes `chat` transport (seam 2)
  │  new GemmaProvider({ chat })  │   → provider decode DOES run, on
  └───────────────┬───────────────┘     recorded bytes
  ┌─ transport ───▼───────────────┐   the real fetch — exercised by
  │  defaultHttpTransport(host)   │   nothing in the suite (live only)
  └───────────────────────────────┘
```

The seam flips *what runs for real*. At seam 1 the provider is a stand-in and the
decode is skipped. At seam 2 the provider is real and only the wire is a
stand-in. That flip is the whole reason both seams exist: the Gemma decode is
load-bearing logic that needs its own coverage, so it gets a seam below itself.

**Seams.** Two load-bearing boundaries:
- `GemmaChatTransport` — `options.chat` on the constructor
  (`gemma-provider.ts:48`); defaults to `defaultHttpTransport` when omitted.
- `EmbedTransport` — `options.embed` on `OllamaEmbeddingProvider`
  (`ollama-embedding-provider.ts`, the `embed` option the test injects at
  `ollama-embedding-provider.test.ts:18`).

Both default to a real `fetch` and accept a recorded async function in tests.
Same shape, two providers.

## How it works

### Move 1 — the mental model

You know how you test a component that calls `fetch` by passing a fake `fetch` in
instead of stubbing the global? You get to run the component's real
request-building and response-parsing while the network never happens. Transport
injection is exactly that, pushed one layer down inside a `ModelProvider`: the
constructor takes the HTTP call as a parameter, defaults it to the real one, and
a test hands it a function that returns recorded bytes.

```
  The pattern — constructor takes the call, defaults to real

  new Provider({ chat })          new Provider()  (prod)
        │                                │
        ▼                                ▼
   chat = injected fn              chat = defaultHttpTransport(host)
        │                                │
        ▼                                ▼
   returns recorded blob           POST /api/chat over the wire
        │                                │
        └──────────┬─────────────────────┘
                   ▼
        complete() runs the SAME decode either way
        (buildSystemText → chat → parseToolCall)
```

The decode path above the `chat` call is identical in test and prod. That's the
property that makes the test meaningful: you're asserting on the code that ships,
not on a parallel test-only copy.

### Move 2 — the walkthrough

**The constructor default is the whole trick.** Bridge: it's the same move as a
default parameter on a React hook — `useThing(opts = {})`. `GemmaModelProvider`'s
constructor does `this.chat = options.chat ?? defaultHttpTransport(...)`
(`gemma-provider.ts:48`). Pass nothing and you get the real Ollama HTTP call;
pass `{ chat }` and you get your function. No global to stub, no network mock
library, no env flag. Break this — make the transport a hard-coded `fetch` inside
`complete` — and the only way to test the decode is to stand up a live Ollama,
which is exactly the flakiness the suite avoids.

```
  Layers-and-hops — the gemma decode test, what's faked vs real

  ┌─ test ────────────────────────────────────────────────────┐
  │  recordedMessyToolCall = "```json\n{tool,arguments}\n```"  │
  │  new GemmaModelProvider({ chat: async () => ({message}) }) │
  └───────────────┬────────────────────────────────────────────┘
                  │ hop 1: complete(weatherRequest)
  ┌─ provider (REAL) ─▼────────────────────────────────────────┐
  │  buildSystemText  → renders get_weather into system text   │
  │  chat(payload)    → returns the recorded blob (FAKE wire)  │
  │  parseToolCall    → parseAgentJson decodes blob → {name,…} │
  └───────────────┬────────────────────────────────────────────┘
                  │ hop 2: ModelResponse { content:[tool_use] }
  ┌─ test assert ─▼────────────────────────────────────────────┐
  │  block.type === 'tool_use'; name === 'get_weather';         │
  │  input deepEqual {location:'Paris',unit:'celsius'}; id set  │
  └────────────────────────────────────────────────────────────┘
```

**What the seam buys you, case by case.** Because the real `complete` runs, the
provider test (`gemma-provider.test.ts`) covers logic an agent-level fixture test
never could:

- *the messy-blob decode* — feed prose-wrapped fenced JSON, assert one clean
  `tool_use` block out (`gemma-provider.test.ts:29`). This is the package's
  reason to exist; it's tested directly because the decode runs for real.
- *the outbound render* — capture the payload the transport received, assert the
  offered tool got rendered into a `system` message
  (`gemma-provider.test.ts:51`). The injected `chat` doubles as a spy.
- *retry on bad JSON, then success* — script the transport to return garbage then
  a valid blob; assert it retried exactly once and recovered
  (`gemma-provider.test.ts:81`). Counting `calls` is only possible because the
  test owns the function.
- *give-up after `maxToolCallAttempts`* — bound the retry, assert it stops and
  returns raw text (`:96`).
- *don't retry on plain prose* — a real answer must not be mistaken for a botched
  tool call (`:112`); guards the `looksLikeToolAttempt` heuristic.
- *abort before the first call* — pre-aborted signal rejects (`:126`).
- *unique tool_use id across turns* — two calls, two ids
  (`:138`); guards `nextToolUseId`'s counter against a duplicate-id bug that
  would confuse a multi-turn loop.

**The embedding provider cuts the same seam.** `OllamaEmbeddingProvider` takes an
`embed` transport (`ollama-embedding-provider.test.ts:14`). The test asserts the
real provider's contract — `id === 'nomic-embed-text'`, `dimension === 768`,
one vector per input text, and abort-signal forwarding
(`ollama-embedding-provider.test.ts:30`) — all without a running Ollama. Same
default-to-real, inject-in-test shape.

**Where the seam stops.** The one thing transport injection does *not* test is
`defaultHttpTransport` itself (`gemma-provider.ts:201`) — the real `fetch`, the
URL assembly, the non-2xx error throw. Nothing in the suite exercises it; it only
runs live. That's the deliberate edge of the seam: you've made everything *above*
the wire testable by declaring the wire out of scope for unit tests. The
buffr-side pg integration tests (DATABASE_URL-gated, separate repo) are the
analogous "real wire" tier for the vector store.

### Move 3 — the principle

Push the seam to where the interesting code is. The coarse seam (swap the whole
provider) is right when the provider is a thin SDK wrapper; the fine seam (inject
the transport) is right when the provider *is* the logic. Gemma's tool-call
emulation is the logic, so the seam drops one layer to keep that logic under
test. The general rule: inject the dependency at the lowest layer where the code
above it is still worth asserting on — and default it to the real thing so prod
wiring is the zero-argument path.

## Primary diagram

The full picture: two seams, what each one fakes, what runs for real below it.

```
  Two injection seams in the RAG packages

  ┌─ AGENT TEST (rag-query-agent.test.ts) ────────────────────┐
  │  fake: ScriptedProvider (a whole ModelProvider)           │
  │  real: runAgentLoop · ToolRegistry · search tool · evals  │
  │  seam 1 ───────────────────────────────────────────────┐  │
  └──────────────────────────────────────────────────────┐ │  │
                                                          │ │
  ┌─ PROVIDER TEST (gemma-provider.test.ts) ──────────────▼─▼──┐
  │  fake: chat transport (a single async fn / recorded blob) │
  │  real: buildSystemText · parseToolCall · retry · id alloc │
  │  seam 2 ───────────────────────────────────────────────┐  │
  └──────────────────────────────────────────────────────┐ │  │
                                                          │ │
  ┌─ WIRE (defaultHttpTransport) ─────────────────────────▼─▼──┐
  │  real fetch → POST /api/chat → Ollama  (LIVE ONLY,        │
  │  not exercised by any unit test)                          │
  └────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Two providers in the new personal-agent packages talk to a local
Ollama over HTTP, and both have to stay testable without a running Ollama:
`GemmaModelProvider` (tool-call emulation) and `OllamaEmbeddingProvider`
(`nomic-embed-text`). Each declares its HTTP call as a constructor option that
defaults to a real `fetch`-based transport. The de-risk for the riskiest of the
two — can Gemma even be coaxed into emitting a parseable tool call? — was proven
first in a throwaway spike (`scripts/gemma-toolcall-spike.mjs`) that hits a live
Ollama N times and runs `parseAgentJson` on each reply, *before* the package and
its fixture tests were scaffolded.

```
  packages/providers/gemma/src/gemma-provider.ts  (lines 46–49)

  constructor(options: GemmaModelProviderOptions = {}) {
    this.defaultModel = options.model ?? 'gemma2:9b';
    this.chat = options.chat                       ← inject point
      ?? defaultHttpTransport(options.host ?? 'http://localhost:11434');
    this.maxToolCallAttempts = Math.max(1, options.maxToolCallAttempts ?? 2);
  }                │
                  └─ `?? defaultHttpTransport(...)` is the load-bearing line:
                     omit `chat` and you get the real wire (prod); pass it and
                     you get recorded bytes (test). Remove the `??` default and
                     every construction site would have to supply a transport;
                     hard-code `fetch` instead and the decode becomes untestable
                     without a live Ollama.
```

```
  packages/providers/gemma/test/gemma-provider.test.ts  (lines 30–48)

  const provider = new GemmaModelProvider({
    chat: async () => ({                          ← the fake wire: returns a
      model: 'gemma2:9b',                            recorded Gemma reply, no
      message: { role: 'assistant',                  socket, fully deterministic
        content: recordedMessyToolCall },
    }),
  });
  const response = await provider.complete(weatherRequest);  ← REAL decode runs
  if (block.type !== 'tool_use') throw ...         ← asserts the blob became a
  assert.equal(block.name, 'get_weather');           clean tool_use block —
  assert.deepEqual(block.input,                       the thing the package exists
    { location: 'Paris', unit: 'celsius' });          to do
```

```
  packages/retrieval/test/ollama-embedding-provider.test.ts  (lines 13–28)

  const embed: EmbedTransport = async (payload) => {
    seen.push({ model: payload.model, texts: payload.texts });  ← spy on the call
    return payload.texts.map((_, i) => [i, i+1, i+2]);          ← recorded vectors
  };
  const provider = new OllamaEmbeddingProvider({ embed });
  const vectors = await provider.embed(['alpha', 'beta']);
  assert.equal(seen[0]?.model, 'nomic-embed-text');  ← real provider built the
  assert.deepEqual(vectors[1], [1, 2, 3]);             payload; test asserts shape
       │
       └─ the injected fn is both the fake wire AND the spy — one parameter does
          the work a network-mock library would otherwise do
```

## Elaborate

This is plain constructor dependency injection — the oldest testability move
there is — but the *placement* is the lesson. The replay-as-test pattern
(`01-replay-as-test.md`) injects at the `ModelProvider` boundary; this one injects
one layer lower, at the HTTP boundary. The choice between them is a coverage
question: inject where the code above the seam is worth asserting on. For a thin
SDK adapter, that's the provider boundary (nothing below it is yours). For
Gemma's emulation layer, the worthwhile code lives *inside* the provider, so the
seam drops to the wire.

The same idea reappears across the repo at different depths: the agent loop
injects the provider (`01-replay-as-test.md`); the structured-generation helper
injects the provider; these new providers inject the transport; and
`@aptkit/memory` injects the *vector store* — `createConversationMemory({ embedder,
store })` takes the store as a constructor option (`conversation-memory.ts:60`), so
the remember→recall logic is tested against an `InMemoryVectorStore` + a fake
embedder and swaps to a `PgVectorStore` in production with zero code change
(`conversation-memory.test.ts:27`). That's the same seam at the *storage* boundary
instead of the *wire* boundary — different collaborator, identical move. Each is
"swap the collaborator at a constructor boundary, default it to the real thing."
Name it once, recognise it everywhere. Next read: `01-replay-as-test.md` for the
coarse seam this one sits beneath, and `study-software-design`'s dependency-
injection treatment for why the default-to-real constructor is a deep-module
property.

## Interview defense

**Q: You already have `FixtureModelProvider` to swap the whole model. Why add a
second seam below it?** Because the two seams test different code. Swapping the
whole `ModelProvider` skips the provider's own logic — fine for an Anthropic
adapter, useless for Gemma, where the tool-call decode IS the package. So I inject
one layer lower: fake the HTTP transport, run the real `complete`, assert the
messy blob becomes a clean `tool_use`. The load-bearing part people miss: the
transport defaults to the real `fetch`, so production is the zero-argument path
and only tests pass a fake.

```
  swap provider → decode skipped │ swap transport → decode runs
  ───────────────────────────────┼──────────────────────────────
  good for thin SDK adapters     │ good when the provider IS logic
```

**Q: What's NOT covered by this seam?** `defaultHttpTransport` itself — the real
`fetch`, URL assembly, the non-2xx throw. No unit test runs it; it's live-only by
design. I'd cover it with a contract test against a stub HTTP server or accept it
as the integration tier (the buffr pg tests are the analogous gated real-wire
tier). Naming the uncovered edge is the point — the seam makes everything above
the wire testable by declaring the wire out of unit scope.

## Validate

1. **Reconstruct.** From memory, write the constructor line that makes
   `GemmaModelProvider` testable without a live Ollama. (Answer:
   `this.chat = options.chat ?? defaultHttpTransport(...)`,
   `gemma-provider.ts:48`.)
2. **Explain.** Why does the messy-blob decode test
   (`gemma-provider.test.ts:29`) assert on code that the rag-query *agent* test
   (`rag-query-agent.test.ts`) never exercises? (Because the agent test swaps the
   whole provider with `ScriptedProvider` — seam 1 — so the Gemma decode at seam 2
   never runs.)
3. **Apply.** You add streaming to `OllamaEmbeddingProvider`. Which test changes,
   and which seam do you exercise to test it without a network?
   (Inject a streaming `embed` transport at `ollama-embedding-provider.test.ts:14`;
   the wire stays faked.)
4. **Defend.** Someone argues the inline `chat` fake should be a shared
   `FakeTransport` util. When is the duplication worth removing vs leaving? (Remove
   it once a third provider needs the same transport shape and a semantics change —
   e.g. abort mid-call — would otherwise land in three places; until then the
   inline fake keeps the test readable in one screen.)

## See also

- `01-replay-as-test.md` — the coarse seam (swap the whole `ModelProvider`) this
  pattern sits one layer beneath.
- `02-structural-shape-assertions.md` — how the decoded `tool_use` / retrieval
  output is asserted without pinning exact strings.
- `audit.md` lenses 4 (determinism) and 6 (testing-ai-features) — where this seam
  is scored against the suite.
- `study-system-design` — the `ModelProvider` / transport boundary as an
  architecture seam.
- `study-software-design` — constructor injection + default-to-real as a
  deep-module property.
