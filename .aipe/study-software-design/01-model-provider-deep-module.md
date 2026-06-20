# 01 — ModelProvider: the deep module

**Industry names:** Adapter / Port (hexagonal architecture) · narrow interface
over a large implementation · "deep module" (APOSD).
**Type:** Language-agnostic design pattern.

---

## Zoom out, then zoom in

Every package in AptKit that talks to an LLM goes through one type. Not an
Anthropic SDK call, not an OpenAI client — one three-field interface.

```
  Zoom out — where ModelProvider sits

  ┌─ Capabilities ─────────────────────────────────────────────┐
  │  QueryAgent · DiagnosticAgent · RecommendationAgent · ...   │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ calls
  ┌─ Foundation (runtime) ────────▼─────────────────────────────┐
  │  runAgentLoop · generateStructured                          │
  │            └──── both depend only on ───────┐               │
  └─────────────────────────────────────────────┼───────────────┘
                                                │ ModelProvider.complete()
  ┌─ Provider adapters ──────────────────────────▼───────────────┐
  │  ★ ModelProvider ★  ◄── one interface, marked here           │
  │  Anthropic   OpenAI   Fallback(wrapper)   ContextGuard(wrap) │
  └──────────────────────────────┬───────────────────────────────┘
                                 │ HTTP (vendor-specific, hidden below here)
  ┌─ Network / Provider ─────────▼─────────────────────────────────┐
  │  api.anthropic.com   api.openai.com                           │
  └────────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is the **deep module**: maximise the behaviour behind
the interface, minimise the interface itself. `ModelProvider` is three
members. Everything a vendor SDK needs — auth, message shape translation,
content-block flattening, token accounting — lives *below* the line and never
crosses it. The question it answers: *how does the entire codebase stay
provider-neutral?* Answer: nothing above this line is allowed to know which
vendor it's talking to.

---

## Structure pass — layers · axis · seam

**Layers:** caller (agent/loop) → interface (`ModelProvider`) → adapter
(`AnthropicModelProvider`) → vendor SDK → HTTP.

**Axis — trace "what does this layer know about the vendor?"**

```
  one question down the stack: "does this layer know it's Anthropic?"

  ┌──────────────────────────────────────┐
  │ runAgentLoop                          │  → NO. sees ModelProvider.
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ ModelProvider (the interface)     │  → NO. id is an opaque string.
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ AnthropicModelProvider        │  → YES. imports @anthropic-ai/sdk.
          └──────────────────────────────┘
              ┌──────────────────────────┐
              │ Anthropic SDK / HTTP      │  → YES, totally.
              └──────────────────────────┘

  the answer flips at the AnthropicModelProvider line — that's the seam
```

**Seam:** the `complete()` boundary. Above it, vendor-agnostic; below it,
vendor-specific. The axis (vendor knowledge) flips exactly there, which is
what makes it a load-bearing seam and not a cosmetic one. Every test mock,
the fallback chain, and the context guard plug in at this seam.

---

## How it works

You know how a React component takes `props` and you don't care whether the
data came from `fetch`, `localStorage`, or a mock in a test? The component
depends on the *prop shape*, not the source. `ModelProvider` is that idea for
LLM calls: the loop depends on the *method shape* (`complete(request) →
response`), not on which vendor answers.

### Move 1 — the shape

A deep module is a wide box with a narrow neck. The neck is what callers see;
the box is what's hidden.

```
  the deep-module shape

         ┌─────────────────┐
  caller │ id  defaultModel │   ← narrow interface: 3 members
  ───────│ complete(req)    │      (the only thing above the line sees)
         └────────┬─────────┘
  ══════════════ seam ══════════════
         ┌────────▼──────────────────────────────────┐
         │  message-shape translation                │
         │  content-block flattening (text/tool_use) │   ← wide body:
         │  tool schema mapping                       │     everything
         │  usage extraction                          │     hidden
         │  auth / API key / client construction      │
         └────────────────────────────────────────────┘

  depth = body size ÷ interface size.  Big here. That's the goal.
```

### Move 2 — the parts

**The request type is the contract — and it's deliberately small.**
`ModelRequest` carries `system?`, `messages`, `tools?`, `maxTokens?`,
`temperature?`, `signal?`. That's the *entire* vocabulary a caller has. No
"anthropicVersion", no "openaiOrganization". The boundary condition: anything
a single vendor needs that isn't in this list has to be absorbed by the
adapter or it would leak. So far it always has.

```
  what crosses the seam — and what does not

  ┌─ caller ─────────────┐   ModelRequest (neutral)   ┌─ adapter ──────────┐
  │ messages, tools,     │ ─────────────────────────► │ maps to vendor     │
  │ system, maxTokens    │                            │ shape, adds apiKey │
  │                      │ ◄───────────────────────── │ flattens response  │
  └──────────────────────┘   ModelResponse (neutral)  └────────────────────┘
       knows: nothing vendor-specific      knows: everything vendor-specific
```

**The response type is normalised on the way back up.** Every adapter returns
`ModelResponse = { content: ModelContentBlock[], usage?, model? }`. The
Anthropic adapter `flatMap`s the SDK's content blocks into AptKit's
`text`/`tool_use` union and drops anything else. The caller gets the same
shape regardless of vendor — that normalisation is the work the deep module
does so the loop doesn't have to.

**`id` is the only vendor signal that crosses — and it's an opaque string.**
The loop emits `provider: model.id` into traces. It never *branches* on it.
The one place anything branches on `id` is `usage-ledger.ts` pricing, and
that's a leak the audit calls out (Lens 5) — the rest of the system treats
`id` as a label, not a type discriminator.

### Move 3 — the principle

**A module is deep when its interface is much simpler than its
implementation, and that gap is where the abstraction earns its keep.** The
test isn't "is the interface small" — it's "how much does a small interface
let callers *not know*." Here, three fields let the entire codebase not know
which LLM vendor exists. Strip the interface out — let agents call
`new Anthropic().messages.create()` directly — and you lose the fallback
chain, the context guard, every test mock, and the monorepo's whole
provider-neutral premise. That's the load-bearing test passing.

---

## Primary diagram

```
  ModelProvider — the full picture

  ┌─ Foundation (provider-neutral) ────────────────────────────────┐
  │  runAgentLoop  generateStructured  ── depend on ──► interface   │
  └────────────────────────────────────────────────┬───────────────┘
                                                   │ complete(ModelRequest)
                       ┌───────────────────────────┼───────────────┐
                       ▼                           ▼               ▼
              ┌─ Anthropic ──┐           ┌─ OpenAI ──┐    ┌─ Fixture ───┐
              │ SDK + maps   │           │ SDK + maps │    │ replays JSON│
              └──────┬───────┘           └─────┬──────┘    └─────────────┘
                     │ HTTP                    │ HTTP        (deterministic,
                     ▼                         ▼              for tests)
              api.anthropic.com         api.openai.com

  wrappers (also implement ModelProvider): Fallback, ContextGuard  → 02
```

---

## Implementation in codebase

**Use cases in this repo.** Every agent run, every structured generation, and
every Studio replay reaches for this interface. `runAgentLoop`
(`packages/runtime/src/run-agent-loop.ts:103`) calls `model.complete(...)`
without importing any vendor SDK. Tests swap a `FixtureModelProvider` (replays
recorded `ModelResponse[]`) at the same seam — that's how the whole replay-
centric eval backbone works without burning live API tokens.

**The interface — `packages/runtime/src/model-provider.ts:54-58`:**

```
  export type ModelProvider = {
    id: string;                    ← opaque label for traces/pricing, not a type switch
    defaultModel?: string;         ← what model the adapter uses if request doesn't say
    complete(request: ModelRequest): Promise<ModelResponse>;
  };                               └─ the ONE method. all behaviour hides behind it.
```

Three members. The `runtime` package has zero vendor dependencies — confirm
it yourself: nothing under `packages/runtime/src/` imports `@anthropic-ai/sdk`
or `openai`. The dependency arrow points *up* into runtime, never out to a
vendor.

**The adapter that hides the body —
`packages/providers/anthropic/src/anthropic-provider.ts:28-61`:**

```
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.messages.create({   ← vendor call hidden here
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,               ← neutral → vendor field name
      ...(request.system ? { system: request.system } : {}),
      messages: request.messages.map(toAnthropicMessage),  ← shape translation (line 64)
      ...(request.tools?.length ? { tools: ... } : {}),
    }, request.signal ? { signal } : undefined);

    return {
      content: response.content.flatMap((block) => {        ← normalise BACK to neutral
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_use') return [{ type: 'tool_use', ... }];
        return [];                                          ← drop blocks AptKit doesn't model
      }),
      usage: { inputTokens: response.usage.input_tokens, ... },  ← snake_case → camelCase
      model: response.model,
    };
  }
        │
        └─ everything Anthropic-specific (snake_case fields, content-block
           variants, the SDK client itself) lives in this file and nowhere
           else. Swap to OpenAI: only packages/providers/openai changes.
```

The `toAnthropicMessage` helper (`anthropic-provider.ts:64-87`) is the
translation layer — neutral `ModelMessage` in, `Anthropic.Messages.MessageParam`
out. That mapping is exactly the complexity the deep interface hides.

---

## Elaborate

This is the **Adapter** pattern (GoF) under one name and the **Port** in
hexagonal/ports-and-adapters architecture under another. APOSD's contribution
is the *depth metric*: not just "use an interface" but "make the interface as
much narrower than the implementation as you can." A shallow adapter that
exposes every vendor knob would be an interface as complex as the SDK it
wraps — no win. The win is that `ModelRequest` has six optional fields while
the Anthropic SDK has dozens; the adapter eats the difference.

The reason it matters *here* specifically: AptKit's entire pitch is "reusable
agent parts that ship without app logic." That promise is impossible if the
agent loop imports a vendor SDK — the bundle would drag a specific vendor with
it. The deep `ModelProvider` interface is what lets `@rlynjb/aptkit-core` stay
vendor-neutral while the host app picks the provider. → `05`.

Adjacent: the wrappers in `02` are *also* `ModelProvider` implementations —
that's the decorator pattern stacking on top of this adapter pattern, both
keyed to the same three-member interface. And `06` shows the move *reused
wholesale*: the `EmbeddingProvider`/`VectorStore` contracts in
`@aptkit/retrieval` are the same deep-module shape applied to two new seams.
The most interesting stress-test of this interface is `GemmaModelProvider`
(`@aptkit/provider-gemma`): Gemma over Ollama has *no native tools array*, so
the adapter emulates tool calls entirely below the seam — proof the interface
holds even when an adapter's body has to fake a capability the vendor lacks.
→ `06`.

---

## Interview defense

**Q: "Is this just an interface, or is it actually a deep module? What's the
difference?"**

It's deep, and the difference is the ratio. An interface alone proves nothing
— you can have a wide, shallow interface that exposes every implementation
detail. Depth is interface-simplicity ÷ implementation-size. Here three
members hide message-shape translation, content-block flattening, tool schema
mapping, usage extraction, and auth — across two real vendors plus fixtures
and two wrappers. The interface didn't grow when we added OpenAI or the
fallback chain. That stability under added implementation is the proof it's
deep.

```
  shallow interface          vs        deep interface (this one)
  ┌──────────────────┐                 ┌──────────────┐
  │ 20 vendor fields │                 │ 3 members    │
  │ exposed upward   │                 └──────┬───────┘
  └──────────────────┘                 ┌──────▼───────────────┐
   caller must know vendor             │ huge hidden body     │
                                       └──────────────────────┘
                                        caller knows nothing
```

**Anchor:** "Three fields hide every vendor SDK, and the interface didn't
change when we added the second vendor — that's the depth test passing."

**Q: "Where would this break?"** When a vendor needs something not expressible
in `ModelRequest` — say, OpenAI's structured-output `response_format`. Today
the adapter absorbs it or it leaks. The honest answer: the design holds as
long as the *neutral* request stays a superset of what every adapter can fake.
The day one vendor needs a field no other can emulate, you either widen the
interface (making it shallower) or push the behaviour entirely inside the
adapter. Naming that tension is the senior signal.

---

## Validate

1. **Reconstruct:** write the `ModelProvider` type from memory. Three members.
   Check against `model-provider.ts:54`.
2. **Explain:** why does `packages/runtime` have no vendor dependency, and
   what would break if you imported `@anthropic-ai/sdk` into
   `run-agent-loop.ts`?
3. **Apply:** you need to add a new provider. Which files change? (Answer: a new
   `packages/providers/<vendor>` only; `run-agent-loop.ts:103` does not. This
   already happened for real — `@aptkit/provider-gemma` was added with zero
   runtime changes, even though it emulates tool calls Gemma can't do natively.
   → `06`.)
4. **Defend:** a teammate wants to add `topP` to every agent. Do you put it on
   `ModelRequest` or inside one adapter? Argue both, then pick — widening the
   neutral request makes it shallower but serves all vendors; per-adapter
   keeps depth but fragments the knob.

---

## See also

- `02-provider-decorator-stack.md` — the wrappers that also implement this
  interface.
- `06-retrieval-contracts-as-deep-seams.md` — the same deep-module move reused
  twice for retrieval, and Gemma as the adapter that stresses this interface.
- `05-bundle-as-public-surface.md` — why provider-neutrality is the whole
  point of the bundle.
- `audit.md` Lens 2 (deepest module) and Lens 3 (the one place `id` leaks).
- `.aipe/study-system-design/` — the provider boundary as an architecture
  seam (higher altitude).
