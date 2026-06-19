# Provider abstraction — the central seam

**Industry names:** Adapter pattern / Strategy pattern / Hexagonal-architecture "port." **Type:** Industry standard.

## Zoom out, then zoom in

Here's the whole system, and the one box every model call has to pass through. Find the seam in the middle band — that's the entire point of this file.

```
  Zoom out — where the provider seam lives

  ┌─ Capability layer — packages/agents/* ──────────────────┐
  │  5 agents call runAgentLoop(...)                         │
  └───────────────────────────┬──────────────────────────────┘
                              │  model.complete(request)
  ┌─ Runtime core — packages/runtime ─────────▼──────────────┐
  │  runAgentLoop, structured-generation                     │
  │           │                                              │
  │           ▼                                              │
  │   ★ ModelProvider.complete(request) ★  ← THIS SEAM       │ ← we are here
  └───────────────────────────┬──────────────────────────────┘
                              │  (one interface, many impls)
  ┌─ Provider layer — packages/providers/* ────▼─────────────┐
  │  anthropic   openai   fallback   local-guard             │
  └───────────────────────────┬──────────────────────────────┘
                              │  HTTPS
  ┌─ External ────────────────▼──────────────────────────────┐
  │  Anthropic API   /   OpenAI API                          │
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. You already know this shape from the frontend: a `fetch()` wrapper that every component calls, so swapping `fetch` for `axios` touches one file instead of fifty. Same idea, raised to the level of a whole capability. The pattern is **dependency inversion through a narrow port**: the runtime defines *what a model provider must be able to do* (`complete(request) → response`), and the vendor SDKs are just implementations that satisfy that shape. Nothing upstream of the seam knows whether it's talking to Claude, GPT, a fallback chain, or a recorded fixture.

## Structure pass

**Layers:** capability (agents) → runtime (loop) → provider (adapters) → external (vendor APIs). Four bands.

**Axis to trace — dependency direction:** which way does the arrow point?

```
  "who depends on whom?" — traced across the seam

  ┌─ runtime ────────┐   seam    ┌─ providers ──────┐
  │ DEFINES the      │ ═══╪═════► │ IMPLEMENT the    │
  │ ModelProvider    │  (it flips)│ ModelProvider    │
  │ interface        │            │ (depend on it)   │
  └──────────────────┘            └──────────────────┘
         ▲                               ▲
         └── runtime depends on NOTHING ─┘
             providers depend on runtime
             → the dependency arrow points UP, into the core
```

That's the load-bearing move: the dependency arrow points *into* the foundation, not out of it. Runtime has zero internal dependencies; providers depend on runtime. So you can add a provider without touching runtime, and you can test runtime without any provider at all.

**The seam that matters:** `ModelProvider.complete()`. The axis (dependency direction) flips here — above it, code defines the contract; below it, code satisfies it. That flip is what makes the whole vendor layer swappable. Hand off to How it works.

## How it works

#### Move 1 — the mental model

The shape is a single narrow interface with a swarm of interchangeable implementations behind it. Think of how `Array.prototype.map` doesn't care what your callback does — it just calls it with a contract (`(item) => newItem`). The provider seam is that, for "talk to a model": the contract is `complete(request) → Promise<response>`, and anything satisfying it is a valid provider.

```
  The provider port — one shape, many plugs

         caller (runtime / loop)
                  │
                  │  complete(request)
                  ▼
        ┌───────────────────────┐
        │  ModelProvider (port)  │   id, defaultModel,
        │  complete(req) → resp  │   complete(request)
        └───────────┬───────────┘
                    │  satisfied by ↓
   ┌──────────┬─────┴─────┬──────────┬──────────────┐
   ▼          ▼           ▼          ▼              ▼
 anthropic  openai    fallback   context-guard   fixture
 (SDK)      (SDK)     (wraps N)  (wraps 1)       (replays)
```

Notice the last three plugs: `fallback` and `context-guard` are providers that *wrap other providers*, and `fixture` is a provider that wraps *nothing* (it replays recorded responses). Because they all satisfy the same port, they compose like Lego. That composability is the payoff.

#### Move 2 — the step-by-step walkthrough

**The request envelope — a vendor-neutral message shape.** Before you can have one interface, you need one *request type* that isn't shaped like any single vendor's API. The runtime defines `ModelRequest` with `system`, `messages`, `tools`, `maxTokens`, `temperature`, `signal`. Messages use a neutral `ModelMessage` shape with text / tool_use / tool_result blocks. The bridge from what you know: it's like defining your own DTO instead of passing a vendor's raw payload around — so the rest of your code never speaks Anthropic-ese or OpenAI-ese.

```
  Layers-and-hops — a request crossing the seam

  ┌─ runtime ──────────┐  hop 1: ModelRequest      ┌─ anthropic adapter ─┐
  │ builds neutral     │ ─────────────────────────►│ toAnthropicMessage  │
  │ ModelRequest       │  (vendor-neutral shape)   │ toAnthropicTool     │
  └────────────────────┘                           └─────────┬───────────┘
                                                      hop 2 │ messages.create(...)
                                                            ▼
                                                   ┌─ Anthropic SDK / API ┐
  ┌─ runtime ──────────┐  hop 4: ModelResponse     │  (vendor payload)    │
  │ reads neutral      │ ◄─────────────────────────└─────────┬───────────┘
  │ ModelResponse      │  hop 3: flatten content blocks      │
  └────────────────────┘                                     ▼
```

The adapter does translation on both edges: neutral request → vendor payload on the way in, vendor response → neutral `ModelResponse` on the way out. The runtime never sees the vendor shape.

**The interface — three members, no more.** `ModelProvider` is `{ id, defaultModel?, complete(request) }`. That's it. The narrowness is the point: a small interface is easy to implement (a new provider is one file) and easy to fake (the fixture provider is ~15 lines). The boundary condition that bites if you ignore it: if you widen this interface to leak a vendor concept (say, Anthropic's `stop_reason`), every implementation must now provide it, and the seam stops being vendor-neutral.

**The adapter implements `complete`.** Each provider's `complete` does: map neutral request → vendor SDK call → map vendor response → neutral `ModelResponse`. The anthropic adapter and openai adapter differ only in *how* they translate (Anthropic puts `system` at the top level; OpenAI prepends it as a system message). Nothing upstream sees that difference.

#### Move 2 variant — the load-bearing skeleton

The kernel of this pattern is tiny:

1. **Isolate the kernel.** A neutral request type + a one-method interface `complete(request) → response` + at least one adapter that translates both edges. That's the whole pattern.

2. **Name each part by what breaks if removed.**
   - Remove the **neutral request type** → every caller speaks a specific vendor's dialect, and swapping vendors means rewriting callers. The abstraction is gone.
   - Remove the **one-method interface** → there's no contract to implement, so "swap the provider" means "rewrite the call site." No seam.
   - Remove the **both-edge translation** in the adapter → vendor shapes leak upstream; the runtime starts handling `tool_use` differently per vendor.

3. **Skeleton vs hardening.** Skeleton: the request type, the interface, the translation. Hardening: the fallback chain, the context guard, the usage ledger, abort-signal forwarding. All of those are *additional providers or decorators* — they hang off the seam without changing it.

The interview payoff: the part people forget is the **neutral request type**. They'll say "we have a provider interface" but pass the vendor's raw message format through it — which means the interface is cosmetic and a real swap still breaks every caller. The neutral DTO is what makes the seam load-bearing.

#### Move 3 — the principle

Depend on a contract you own, not on a vendor you don't. When the dependency arrow points *into* a narrow interface you defined, the implementations below it become swappable, composable, and fakeable — and the cost of a vendor change collapses from "rewrite the app" to "write one file."

## Primary diagram

The full recap — the seam, the adapters, the composing wrappers, and the one wire hop.

```
  Provider abstraction — full picture

  ┌─ Capability layer ───────────────────────────────────────┐
  │  agent.method() → runAgentLoop → model.complete(request)  │
  └──────────────────────────────┬────────────────────────────┘
                                 │  ModelRequest (neutral)
  ┌─ Runtime contract ───────────▼────────────────────────────┐
  │  ModelProvider { id, defaultModel?, complete(request) }    │
  └──────────────────────────────┬────────────────────────────┘
            ┌────────────────┬────┴────────┬──────────────────┐
            ▼                ▼             ▼                  ▼
     ┌────────────┐  ┌────────────┐  ┌──────────┐    ┌──────────────┐
     │ anthropic  │  │  openai    │  │ fallback │    │ context-guard│
     │ adapter    │  │  adapter   │  │ (wraps N)│    │ (wraps 1)    │
     └─────┬──────┘  └─────┬──────┘  └────┬─────┘    └──────┬───────┘
           │ HTTPS         │ HTTPS        │ delegates       │ delegates
           ▼               ▼              ▼                 ▼
     ┌───────────┐   ┌───────────┐   (to providers)   (to one provider)
     │ Anthropic │   │  OpenAI   │
     │  API      │   │   API     │
     └───────────┘   └───────────┘
```

## Implementation in codebase

**Use cases.** Every agent run reaches this seam. The recommendation agent doesn't know it's calling Claude — it calls `runAgentLoop({ model, ... })` and the loop calls `model.complete()`. Swapping to OpenAI is constructing a different provider at the call site. Running a test is constructing a `FixtureModelProvider`. Adding cross-provider resilience is wrapping the providers in a `FallbackModelProvider`. All four are the *same seam*, used four ways.

**The contract** — `packages/runtime/src/model-provider.ts` (lines 39–58):

```
  ModelRequest (lines 39-46)            the vendor-neutral envelope
  export type ModelRequest = {
    system?: string;          ← system prompt, top-level (not vendor-shaped)
    messages: ModelMessage[]; ← neutral message blocks (text/tool_use/tool_result)
    tools?: ModelTool[];      ← neutral tool schemas
    maxTokens?: number;
    temperature?: number;
    signal?: AbortSignal;     ← cancellation forwarded to every adapter
  };

  ModelProvider (lines 54-58)           the one-method port
  export type ModelProvider = {
    id: string;               ← which provider (shows up in trace events)
    defaultModel?: string;
    complete(request: ModelRequest): Promise<ModelResponse>;
  };
       │
       └─ THREE members. The narrowness is load-bearing: a new provider is
          one file; the fixture fake is ~15 lines. Widen this and every
          implementation must follow — the seam stops being neutral.
```

**The anthropic adapter** — `packages/providers/anthropic/src/anthropic-provider.ts` (lines 24–60):

```
  this.defaultModel = options.model ?? 'claude-sonnet-4-6';   ← line 24, default

  complete(request) {                                          ← lines 28-61
    const response = await this.client.messages.create({       ← lines 29-39
      model: this.defaultModel,
      max_tokens: request.maxTokens ?? 4096,
      ...(request.system ? { system: request.system } : {}),   ← Anthropic puts
      messages: request.messages.map(toAnthropicMessage),         system top-level
      ...(request.tools?.length
        ? { tools: request.tools.map(toAnthropicTool) } : {}),
    }, request.signal ? { signal: request.signal } : undefined);
    // ...flatten response.content → neutral ModelResponse       ← lines 41-60
  }
       │
       └─ toAnthropicMessage / toAnthropicTool (lines 64-95) do the inbound
          translation; the response-flattening does the outbound. BOTH edges
          translate — that's what keeps vendor shapes out of the runtime.
```

**The openai adapter — same port, different translation** — `packages/providers/openai/src/openai-provider.ts` (lines 29, 33–48):

```
  this.defaultModel = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1';  ← line 29

  const messages = [                                            ← lines 34-37
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
    ...request.messages.flatMap(toOpenAIMessage),               ← OpenAI prepends
  ];                                                               system as a message
  const response = await this.client.chat.completions.create({  ← lines 39-48
    model: this.defaultModel, messages,
    ...(request.tools?.length
      ? { tools: request.tools.map(toOpenAITool), tool_choice: 'auto' } : {}),
  });
       │
       └─ Same ModelRequest in, same ModelResponse out (lines 50-77) — but
          system goes top-level in Anthropic and inline-as-a-message in OpenAI.
          That difference lives ONLY in the adapter. The runtime never sees it.
```

The two adapters prove the seam works: identical input contract, identical output contract, completely different vendor shapes in between.

## Elaborate

This is the Ports-and-Adapters (hexagonal) pattern, and the "port" here is `ModelProvider`. It's the same instinct behind a database repository interface or a frontend HTTP-client wrapper: name the capability you depend on, define it as a narrow interface, and push the vendor specifics to the edge.

What makes it especially load-bearing in an AI codebase: model vendors change *fast* — new models, deprecated models, pricing shifts, outages. A repo that calls `anthropic.messages.create()` directly from its business logic is welded to one vendor. AptKit's whole `providers/` directory exists to keep that weld out of the core (`context.md`: "everything depends on the `ModelProvider.complete()` contract, never a vendor SDK directly").

Where to go next: `03-fallback-chain.md` shows two providers that *wrap other providers* through this same seam — the clearest proof that the port composes. `06-replay-eval-pipeline.md` shows the fixture provider, a port implementation that talks to no vendor at all. For the deep-module / information-hiding view of why a narrow interface is the right call, see study-software-design when generated.

## Interview defense

**Q: Why not just call the Anthropic SDK directly from the agents?**

Because the dependency arrow would point *out* of your core into a vendor you don't control. Define a narrow port (`complete(request) → response`) the core owns, make the vendor SDK an adapter behind it, and a vendor swap becomes one new file instead of a rewrite.

```
  direct call:   agent ──► @anthropic-ai/sdk     (welded to vendor)
  ported:        agent ──► ModelProvider ◄── anthropic adapter ── SDK
                            (core owns the contract; vendor is swappable)
```

Anchor: `packages/runtime/src/model-provider.ts:54-58` is the port; `packages/providers/anthropic/src/anthropic-provider.ts:28-61` is one adapter.

**Q: What's the part people get wrong when they build this?**

The neutral request type. Teams define a provider interface but pass the vendor's raw message format through it, so the interface is decorative — a real swap still breaks every caller. The load-bearing part is `ModelRequest`/`ModelMessage` being vendor-neutral (`model-provider.ts:22-46`), so the runtime never speaks any vendor's dialect.

```
  cosmetic seam:   interface complete(vendorPayload)   ← vendor leaks through
  real seam:       interface complete(NeutralRequest)  ← translation at the edge
```

Anchor: `toAnthropicMessage` vs `toOpenAIMessage` translate the *same* neutral shape into two different vendor shapes — that proves the neutrality is real.

## Validate

1. **Reconstruct.** From memory, write the three members of `ModelProvider` and the six fields of `ModelRequest`. Check against `packages/runtime/src/model-provider.ts:39-58`.
2. **Explain.** Why does `runtime` have zero internal dependencies while `providers` depends on `runtime`? What would break if you reversed that arrow? (Hint: `package.json:14` build order.)
3. **Apply.** You need to add a Gemini provider. Which files do you touch, and which do you *not* touch? (You touch: a new `packages/providers/gemini/`. You don't touch: any agent, the loop, or `model-provider.ts`.)
4. **Defend.** A teammate wants to add `stopReason` to `ModelResponse` because Anthropic returns it. Argue for or against, in terms of what it does to the seam's neutrality and every existing adapter.

## See also

- `00-overview.md` — where the seam sits in the full system.
- `03-fallback-chain.md` — providers that wrap other providers through this same port.
- `02-bounded-agent-loop.md` — the loop that calls `complete()` in a bounded cycle.
- `06-replay-eval-pipeline.md` — the fixture provider, a port impl with no vendor behind it.
- `audit.md` lens 1 — the seam in the boundary inventory.
