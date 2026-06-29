# Injected transport — testing the provider's own logic

**Industry name:** dependency injection at the transport boundary (the HTTP
client as a constructor seam). Type label: Industry standard.

## Zoom out, then zoom in

`01` put a fake at the `ModelProvider` port so agents are testable. But a
provider has its *own* hard logic worth testing — and for Gemma that logic is
the most interesting in the repo. So the seam is drawn again, one level deeper.

```
  Zoom out — two seams, two altitudes

  ┌─ agent ──────────────────────────────────────────────────┐
  │  depends on ModelProvider.complete()                      │
  └──────────────────────────┬───────────────────────────────┘
                             │ ← seam 1 (file 01): fake the WHOLE provider
  ┌─ GemmaModelProvider ─────▼───────────────────────────────┐
  │  renders tools into a system prompt (Gemma has none) →    │
  │  calls transport → decodes messy blob → retries on junk   │
  └──────────────────────────┬───────────────────────────────┘
                             │ ← seam 2 (THIS file): inject the `chat` transport
  ┌─ Ollama HTTP :11434 ─────▼───────────────────────────────┐
  │  real model (only in prod; recorded reply in test)        │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** Gemma has no native tool-calling. So the provider has to *emulate*
it: describe the offered tools in a system instruction, then decode the tool
call back out of the prose-wrapped JSON the model returns. That emulation is
real, fallible logic — and to test it you need to feed the provider exact
model replies without a live Ollama. The seam is the `chat` transport, injected
in the constructor. The question: *how do you test a provider's decode-and-retry
logic deterministically?* Inject the transport, feed it the messy blob you
recorded, assert the clean decode.

## Structure pass

**Layers:** provider public surface (`complete`) → transport (`chat`) → Ollama.
**One axis — trust in the model's output format:** can the layer above trust
what it got?

```
  Axis: is the response in a trusted format?

  ┌─ complete() returns ─┐  seam  ┌─ chat returns ──────┐
  │ clean tool_use block │ ◄══╪══ │ messy prose+fenced  │
  │ (TRUSTED)            │ (flips)│  JSON blob (UNTRUSTED)│
  └──────────────────────┘        └──────────────────────┘
```

The trust axis flips at the `chat` seam: below it the reply is an untrusted
text blob (Gemma wrapped the tool call in prose); above it `complete()` promises
a clean `tool_use` block. The decode+retry logic *is* the thing that flips it —
so that logic is exactly what the tests target.

## How it works

### Move 1 — the mental model

You've parsed a flaky third-party response before: an endpoint that sometimes
returns JSON, sometimes JSON-in-a-string, sometimes garbage, and you wrote a
parser with a retry. To test that parser you don't hit the flaky endpoint — you
hand it the recorded bad payloads and assert it recovers. Same here: the "flaky
endpoint" is Gemma, the recorded payload is `recordedMessyToolCall`, the parser
is the provider's decode, the retry is `maxToolCallAttempts`.

```
  The pattern — feed recorded replies through the injected chat

  recorded reply (messy)              the decode ladder
  ─────────────────────               ─────────────────
  "Sure! ```json                      try decode → fail
   {tool, arguments} ```"      ──►     retry (re-ask) → succeed
                                       give up after N → return raw text
```

### Move 2 — the walkthrough

#### The seam: `chat` is a constructor parameter

The provider takes its transport in. In test, the transport is an async closure
returning a recorded reply — no HTTP:

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

`recordedMessyToolCall` (`:9`) is a real recorded Gemma2:9b reply — prose
wrapped around a fenced JSON tool call. That's the "messy blob" the decode must
crack. No Ollama runs; the closure *is* the recording.

#### Asserting the decode

```ts
// gemma-provider.test.ts:39
assert.equal(response.content.length, 1);
const block = response.content[0];
if (block.type !== 'tool_use') throw new Error(`expected tool_use, got ${block.type}`);
assert.equal(block.name, 'get_weather');
assert.deepEqual(block.input, { location: 'Paris', unit: 'celsius' });
assert.ok(block.id.length > 0);            // a tool_use block needs an id
```

The provider turned prose+fenced-JSON into a clean `tool_use` block with name,
parsed input, and a synthesized id. That id matters: Gemma didn't supply one
(it has no tool-calling), so the provider mints it — and `:138` asserts two
calls get *distinct* ids, because a downstream loop keys tool results by id.

#### The retry ladder — three branches, each tested

This is the load-bearing logic. The transport closure can return different
replies on successive calls, so the test scripts the *sequence* and asserts the
ladder:

```ts
// retries unparseable, then succeeds — gemma-provider.test.ts:81
const replies = ['Here you go: {oops not valid json', recordedMessyToolCall];
let calls = 0;
const provider = new GemmaModelProvider({
  chat: async () => ({ message: { role: 'assistant', content: replies[calls++] } }),
});
const response = await provider.complete(weatherRequest);
assert.equal(calls, 2, 'should have retried once');   // ← it re-asked
assert.ok(response.content[0]?.type === 'tool_use');   // ← then succeeded
```

Three branches, each its own test:
- **junk → retry → succeed** (`:81`): `calls === 2`, ends in `tool_use`.
- **junk forever → give up** (`:96`): with `maxToolCallAttempts: 2`, `calls === 2`
  then returns the raw text instead of looping forever.
- **plain prose → no retry** (`:112`): `calls === 1` — a non-tool answer must
  not waste a re-ask. This is the subtle one: the retry is only for *failed tool
  decodes*, not for every reply.

#### The other direction: tools rendered into a system prompt

The emulation has an outbound half too — turning offered tools into an
instruction Gemma can act on. The test captures the request the provider built:

```ts
// gemma-provider.test.ts:51
let captured;
const provider = new GemmaModelProvider({
  chat: async (payload) => { captured = payload; return { message: {...} }; },
});
await provider.complete(weatherRequest);
const system = captured.messages.find((m) => m.role === 'system');
assert.match(system.content, /get_weather/);             // tool name rendered
assert.match(system.content, /Get the current weather/);  // description rendered
assert.match(system.content, /json/i);                    // format instruction
```

Same record-the-request trick as `01`'s `requests[]`, applied to the transport
payload. The test asserts the provider *taught Gemma the tool exists* before
expecting it to call one.

### Move 3 — the principle

Draw the injection seam at the altitude where the logic you want to test lives.
`01` faked the whole provider because the *agent's* logic was under test. Here
the *provider's* decode/retry is under test, so the seam moves down to the
transport. The same recorded-response idea, re-applied at whichever boundary
isolates the thing you're asserting.

## Primary diagram

```
  Injected transport — full picture

  ┌─ test author writes a recorded reply ─┐
  │  recordedMessyToolCall / reply sequence│
  └──────────────────┬─────────────────────┘
                     │ as the chat closure
  ┌─ GemmaModelProvider.complete() ────────▼──────────────────┐
  │  1. render tools → system instruction  (assert: captured) │
  │  2. chat(payload)  ──────────────────► recorded reply     │
  │  3. decode blob → tool_use   ┌─ fail? ─► retry (re-ask)    │
  │                              └─ give up after N → raw text │
  │  4. return clean ModelResponse (assert: tool_use, ids)    │
  └────────────────────────────────────────────────────────────┘
       seam = chat (injected) · no Ollama :11434 in test
```

## Elaborate

This is the same dependency-injection-at-a-seam discipline as `01`, but it
answers a different objection: "fine, you faked the *model*, but who tests the
adapter that talks to the model?" The answer is: inject one layer deeper. The
Gemma adapter is where the gnarliest correctness lives in the provider layer —
emulating a capability the model lacks — and it's the best-tested provider
(9 cases) precisely because the transport is a constructor parameter.

Note what's *not* tested here and correctly belongs to evals: whether Gemma
actually *produces* good tool calls in the first place is a model-quality
question (study-ai-engineering). The provider tests pin the deterministic
contract — given this messy blob, produce this clean block — not the model's
propensity to emit good blobs.

## Interview defense

**Q: You faked the model for the agent tests — but how do you test the provider
that talks to the real model?**
Inject the transport. `GemmaModelProvider` takes a `chat` function in its
constructor; tests pass a closure returning recorded Ollama replies. The
provider's real decode-and-retry runs against recorded messy blobs, no `:11434`.

```
  provider ──chat(payload)──► [ closure returns recorded blob ]
           decode + retry runs for real; transport is faked
```

Anchor: *the injection seam moves to whatever altitude isolates the logic under
test — model for the agent, transport for the provider.*

**Q: What's the subtle branch in that retry logic people miss?**
Don't retry plain prose. The retry exists to recover a *failed tool decode* — if
Gemma just answered in words, re-asking is wasted latency and tokens. The test
(`gemma-provider.test.ts:112`) asserts `calls === 1` on a prose answer.

```
  reply type   → retry?
  tool decode failed → YES (re-ask, up to N)
  plain prose        → NO  (calls === 1)
```

Anchor: *the give-up cap and the don't-retry-prose branch are the two parts that
show you built the emulation, not just the happy decode.*

## See also

- `01-injected-model-port.md` — the same seam at the agent altitude.
- `04-deterministic-fake-embedder.md` — the same "inject a pure fake at the
  boundary" move applied to embeddings.
- `audit.md` lens 5 (error paths — the retry ladder) and lens 6 (AI features).
- study-ai-engineering — whether Gemma emits *good* tool calls (the eval half).
