# Provider abstraction — one contract, many vendors

**Industry names:** adapter pattern, provider abstraction, ports-and-adapters / hexagonal · *Industry standard*

## Zoom out, then zoom in

Vendor SDKs disagree about everything — Anthropic calls it `input_tokens`, OpenAI
calls it `prompt_tokens`; Anthropic returns content blocks, OpenAI returns a
message with `tool_calls`. If your agent loop knew any of that, swapping vendors
would mean a rewrite. AptKit makes the whole core depend on *one* contract, and
each vendor gets an adapter that translates. Here's the shape.

```
  Zoom out — one contract, three+ implementations

  ┌─ Core: runtime + agents (vendor-FREE) ──────────────────────────┐
  │  runAgentLoop · generateStructured · usage-ledger · QueryAgent   │
  │  import only ModelProvider ─┐                                     │
  └─────────────────────────────┼───────────────────────────────────┘
                                │  depends on the contract, nothing else
  ┌─ Contract ──────────────────▼───────────────────────────────────┐
  │  ★ ModelProvider { id, defaultModel?, complete() } ★ ←THIS CONCEPT│
  └─────────────────────────────┬───────────────────────────────────┘
                  implemented by │
  ┌─ Adapters (each owns ONE vendor's quirks) ─▼───────────────────────┐
  │  AnthropicModelProvider  OpenAIModelProvider  FixtureModelProvider │
  │  ★ GemmaModelProvider (local, Ollama — emulated tool-calling)      │
  │  ContextWindowGuardedProvider (decorator over any of the above)    │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: this is the adapter pattern (ports-and-adapters / hexagonal
architecture). The *port* is `ModelProvider` — the contract the core codes
against. Each *adapter* is a class that `implements ModelProvider` by translating
the neutral request into a vendor SDK call and the vendor response back into the
neutral shape. The whole core depends only on `complete()`; nothing in it imports
`@anthropic-ai/sdk` or `openai`. That's the flagship foundation — get this seam
right and everything downstream is vendor-portable and testable.

## Structure pass

**Layers.** Three: the *core* (codes against `ModelProvider`), the *contract*
(`ModelProvider` — the port), the *adapters* (vendor-specific implementations).

**Axis — dependency: which way does the arrow point, and where does it stop?**
Trace it. Core → contract: depends on the interface. Contract → vendor: *nothing*
— the contract knows no vendor. Adapter → vendor: the adapter, and only the
adapter, imports the SDK. So the vendor dependency is quarantined to the adapter
file; the arrow from the core stops dead at the contract and never reaches a
vendor. Invert that and you've got the value of the whole pattern: vendors depend
on the contract's shape, not the other way around.

**Seam.** The seam is `implements ModelProvider`. On the core's side: a neutral
`complete(request): Promise<ModelResponse>`. On the adapter's side: an HTTP call
to a specific vendor with that vendor's field names, message shapes, and tool
formats. Everything vendor-specific lives *behind* this seam — which is exactly
why `FixtureModelProvider` can stand in for a real vendor with zero changes to the
core.

## How it works

You've coded against an interface and swapped implementations — a `Logger`
interface with `ConsoleLogger` and `FileLogger`, a `Repository` with a real DB and
an in-memory test double. Provider abstraction is that pattern aimed at LLM
vendors: one interface, a real adapter per vendor, a fake for tests.

### Move 1 — the mental model

One port, many adapters. The core plugs into the port; each adapter plugs the same
port into a different vendor. The core can't tell them apart.

```
  Ports and adapters — the shape

                 ┌──────────────── CORE ────────────────┐
                 │  runAgentLoop / generateStructured     │
                 │       │ uses                           │
                 │       ▼                                │
                 │   ModelProvider  (the PORT)            │
                 └───────┬───────────────┬────────────┬───┘
            implements   │   implements  │ implements │  implements
                 ┌───────▼──┐   ┌────────▼───┐   ┌────▼──────┐
                 │ Anthropic │   │  OpenAI    │   │ Fixture   │
                 │  adapter  │   │  adapter   │   │ (tests)   │
                 └─────┬─────┘   └─────┬──────┘   └───────────┘
                       ▼               ▼
                 Anthropic SDK    OpenAI SDK   ← vendor quirks live HERE only
```

The core sees one type. Switching from Anthropic to OpenAI is constructing a
different adapter and passing it in — no change to the loop, the structured
generator, or the ledger.

### Move 2 — the step-by-step walkthrough

#### The adapter is a class that implements the port

Each adapter is `class XModelProvider implements ModelProvider`. It declares an
`id` (used for trace attribution and pricing), a `defaultModel` (the vendor's
default if the caller didn't pick one), and the one method `complete`.

```
  Adapter skeleton (pseudocode)

  class AnthropicModelProvider implements ModelProvider {
    id = 'anthropic'
    defaultModel = options.model ?? 'claude-sonnet-4-6'   // ← default model
    complete(request) {
      vendorReq  = translateRequestIn(request)   // neutral → Anthropic shape
      vendorResp = await sdk.messages.create(vendorReq)
      return translateResponseOut(vendorResp)     // Anthropic shape → neutral
    }
  }
```

The boundary condition: the adapter's *only* job is translation in both
directions. Any logic that isn't "make this vendor look like the contract" belongs
in the core, not the adapter. Keep adapters thin or the abstraction leaks.

#### Translate the request: neutral → vendor

The neutral `ModelRequest` gets mapped to the vendor's call shape. The vendors
disagree on structure — Anthropic takes `system` as a top-level field and messages
as content blocks; OpenAI folds `system` into the messages array as a `system`-role
message. The adapter absorbs that difference.

```
  Request translation — two vendors, one neutral input (layers-and-hops)

  ┌─ neutral ModelRequest ─┐
  │ { system, messages,    │
  │   tools, maxTokens,    │
  │   temperature }        │
  └───────┬────────────┬───┘
          │            │
    ┌─────▼─────┐  ┌───▼──────────────────────────┐
    │ Anthropic │  │ OpenAI                       │
    │ system →  │  │ system → messages[0] (role:  │
    │   top-lvl │  │   'system')                  │
    │ tools →   │  │ tools → {type:'function',…}  │
    │   input_  │  │ maxTokens → max_completion_  │
    │   schema  │  │   tokens                     │
    └───────────┘  └──────────────────────────────┘
```

This is where vendor knowledge is *supposed* to live. The neutral request stays
clean; each adapter knows exactly one vendor's wire format.

#### Translate the response: vendor → neutral

The reverse trip is the load-bearing one, because the core branches on
`response.content`. Anthropic returns content blocks (`text`, `tool_use`); OpenAI
returns a single message with optional `tool_calls`. Both must come out as the same
neutral `ModelContentBlock[]` so the agent loop's "is there a tool_use block?"
check works identically.

```
  Response translation — converge to neutral content blocks

  Anthropic resp.content:  [{type:'text'}, {type:'tool_use', id, name, input}]
        └─ flatMap → neutral [{type:'text',text}, {type:'tool_use',id,name,input}]

  OpenAI resp.choices[0].message: { content: "...", tool_calls: [{id,function}] }
        └─ push text block, then push one tool_use per tool_call
                                          → neutral [{type:'text'}, {type:'tool_use'}…]

  usage: input_tokens/output_tokens  (anthropic)  ─┐
         prompt_tokens/completion_tokens (openai) ─┴─► neutral { inputTokens, outputTokens }
```

The two vendors' wildly different response shapes converge to one neutral shape.
Without this convergence, the agent loop would need an `if vendor === 'openai'`
somewhere — and that's exactly the leak the pattern exists to prevent.

#### The fixture: the same port, no network

`FixtureModelProvider` implements the identical contract by returning canned
`ModelResponse`s from a list. The core can't tell it from a real vendor — which is
the entire point: tests run the real agent loop against scripted responses, no API
key, no network, deterministic.

```
  FixtureModelProvider — the test adapter (pseudocode)

  class FixtureModelProvider implements ModelProvider {
    id = 'fixture'
    complete(request) {
      this.requests.push(request)          // record what was asked (assert later)
      return this.responses[this.index++]  // hand back the next scripted response
      // exhausted? throw — tells you the loop made more calls than scripted
    }
  }
```

#### The decorator: a provider that wraps a provider

`ContextWindowGuardedProvider` also `implements ModelProvider`, but instead of
talking to a vendor it *wraps another provider*, checks the estimated token budget
first (`02-tokenization.md`), then delegates to the inner `complete()`. Because it
satisfies the same port, it composes — you can wrap any adapter. This is the same
seam doing double duty: adapter *and* decorator are both "things that implement the
port."

### Move 3 — the principle

Depend on a contract, isolate the vendor. The narrower the port and the thinner the
adapters, the more of your system is vendor-free, testable, and composable. The
test for whether the abstraction is working is mechanical: can the core run against
a fixture with zero changes? If yes, the vendor quirks are properly quarantined
behind the seam. AptKit passes that test — the agent loop, the structured
generator, and the cost ledger have never heard of Anthropic or OpenAI; they've
only ever called `complete()`.

## Primary diagram

The full picture — core, port, every adapter, and where vendor knowledge stops.

```
  Provider abstraction — the complete map

  ┌─ Core (packages/runtime, packages/agents) — VENDOR-FREE ─────────┐
  │  runAgentLoop · generateStructured · usage-ledger · QueryAgent   │
  │  import { ModelProvider } only                                   │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  complete(request): Promise<ModelResponse>
  ┌─ Port: ModelProvider ──────────▼──────────────────────────────────┐
  │  { id, defaultModel?, complete() }   — the contract               │
  └──┬─────────────────┬────────────────┬───────────────┬─────────────┘
     │ implements      │ implements     │ implements    │ implements
  ┌──▼──────────┐  ┌───▼─────────┐  ┌───▼────────┐  ┌───▼──────────────┐
  │ Anthropic   │  │ OpenAI      │  │ Fixture    │  │ ContextWindow    │
  │ id=anthropic│  │ id=openai   │  │ id=fixture │  │ GuardedProvider  │
  │ default=    │  │ default=    │  │ canned     │  │ (decorator —     │
  │ sonnet-4-6  │  │ gpt-4.1     │  │ responses  │  │  wraps a provider)│
  └──────┬──────┘  └──────┬──────┘  └────────────┘  └────────┬─────────┘
   ┌─────▼─────┐    ┌─────▼─────┐                      delegates to inner
   │Anthropic  │    │ OpenAI    │                      provider.complete()
   │  SDK      │    │  SDK      │   ← VENDOR KNOWLEDGE STOPS HERE
   └───────────┘    └───────────┘
```

## Implementation in codebase

**Use cases.** Every model call in the repo goes through some `ModelProvider`.
Production runs construct an `AnthropicModelProvider` (default
`claude-sonnet-4-6`) or `OpenAIModelProvider` (default `gpt-4.1`). Tests construct
a `FixtureModelProvider` with scripted responses and run the *real* agent loop
against it. Local on-device runs wrap a provider in `ContextWindowGuardedProvider`.
The agent code never changes across these — only which provider is injected.

**The Anthropic adapter — request out**,
`packages/providers/anthropic/src/anthropic-provider.ts:28-39`:

```
  packages/providers/anthropic/src/anthropic-provider.ts  (lines 28-39)

  const response = await this.client.messages.create({
    model: this.defaultModel,
    max_tokens: request.maxTokens ?? 4096,                  ← Anthropic field name
    ...(request.system ? { system: request.system } : {}),  ← system is TOP-LEVEL
    messages: request.messages.map(toAnthropicMessage),     ← neutral → blocks
    ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  }, request.signal ? { signal: request.signal } : undefined);
       │
       └─ Every line is a translation: neutral request → Anthropic's exact
          call shape. This is the ONLY file that imports @anthropic-ai/sdk.
```

**The Anthropic adapter — response in**,
`packages/providers/anthropic/src/anthropic-provider.ts:41-60`: `flatMap`s
Anthropic content blocks into neutral `ModelContentBlock`s (text and tool_use),
and maps `usage.input_tokens` / `output_tokens` to neutral `inputTokens` /
`outputTokens` with `estimated: false`.

**The OpenAI adapter — the divergence it absorbs**,
`packages/providers/openai/src/openai-provider.ts:33-48`:

```
  packages/providers/openai/src/openai-provider.ts  (lines 34-48)

  const messages = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),  ← system
    ...request.messages.flatMap(toOpenAIMessage),            ← folded INTO messages
  ];
  const response = await this.client.chat.completions.create({
    model: this.defaultModel,
    messages,
    ...(request.tools?.length ? { tools: …, tool_choice: 'auto' } : {}),
    ...(request.maxTokens !== undefined ? { max_completion_tokens: request.maxTokens } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  }, …);
       │
       └─ Same neutral input, different shape out: OpenAI puts system in the
          messages array and calls the cap max_completion_tokens. The adapter
          eats the difference so the core never sees it.
```

**The fixture**, `packages/agents/recommendation/src/fixture-provider.ts:3-18`:

```
  packages/agents/recommendation/src/fixture-provider.ts  (lines 3-18)

  export class FixtureModelProvider implements ModelProvider {
    readonly id = 'fixture';
    readonly requests: ModelRequest[] = [];     ← records calls for assertions
    complete(request) {
      this.requests.push(request);
      const response = this.responses[this.index++];
      if (!response) throw new Error(`fixture model exhausted …`);  ← over-call guard
      return response;
    }
  }
       │
       └─ Same port, no network. The agent loop runs unchanged against this —
          which is the proof the vendor quirks are properly behind the seam.
```

**The decorator**,
`packages/providers/local/src/context-window-guard.ts:38-70`:
`ContextWindowGuardedProvider implements ModelProvider`, holds an inner `provider`,
checks the token estimate in `complete()`, and on success calls
`this.provider.complete(request)` — composing over any adapter because it speaks
the same port.

**The hard adapter — Gemma**,
`packages/providers/gemma/src/gemma-provider.ts:39-92`: `GemmaModelProvider
implements ModelProvider` over local Ollama (`gemma2:9b`). It's the one adapter
where translation is *not* trivial: Gemma has no native tools API, so
`complete()` renders the tool definitions into the system prompt text
(`buildSystemText`), demands a JSON tool call back, parses it into a neutral
`tool_use` block (`parseToolCall`), and retries with a corrective nudge if the
JSON is malformed. Same port, but the adapter does real work to fake a feature
the vendor lacks — the deep dive is
[../04-agents-and-tool-use/07-emulated-tool-calling.md](../04-agents-and-tool-use/07-emulated-tool-calling.md).
That this fits behind the *same* `complete()` the cloud adapters satisfy is the
strongest proof the port is well-chosen.

## Elaborate

This is hexagonal architecture (ports and adapters): the application core defines a
port (`ModelProvider`) and depends only on it; infrastructure (vendor SDKs) plugs
in via adapters that implement the port. The dependency inversion is the whole
point — the core doesn't depend on the vendor; the vendor's adapter depends on the
core's contract. That's why you can add a third vendor by writing one adapter file
and changing nothing else, and why the eval suite runs the real agent logic against
fixtures.

Two AptKit choices are worth defending. First, the port is *narrow* (`08`'s sibling
file `01-what-an-llm-is.md` makes this point): a small contract means thin adapters
and easy fixtures. Second, the same port serves three roles — real adapter,
test double, and decorator — which is the sign of a well-chosen seam: a guard that
wraps a provider and a fixture that fakes one are both just "implements
`ModelProvider`." The decorator role connects to production serving: the fallback
chain and context guard (`../06-production-serving/`) are built entirely out of
providers-wrapping-providers.

Adjacent: the contract itself (`01-what-an-llm-is.md`); the token estimate the
decorator uses (`02-tokenization.md`); the fallback chain that composes providers
(`../06-production-serving/`); the cost ledger that reads each provider's `id` for
pricing (`06-token-economics.md`).

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case A — the abstraction exists and now spans four
adapters (Anthropic, OpenAI, Fixture, Gemma); this extends it.*

### Exercise — compose Gemma under the fallback chain

- **Exercise ID:** `[C1.9]` Phase 1, provider abstraction
- **What to build:** Wire the existing `GemmaModelProvider` as the *primary* in a
  `FallbackModelProvider` (`packages/providers/fallback`) with a cloud adapter as
  the backup, wrapped in `ContextWindowGuardedProvider`. The result: a local-first
  provider that only reaches the cloud when Gemma fails or its context overflows —
  built entirely out of providers-wrapping-providers, no new agent code.
- **Why it earns its place:** It proves the same port serves *four* roles at once
  (real adapter, test double, decorator, chain element) and that a weak local
  model can be made production-safe purely by composition behind `complete()`.
- **Files to touch:** a small composition module + a unit test that injects a
  failing Gemma transport and asserts the fallback fires; reuse
  `packages/providers/{gemma,fallback,local}`.
- **Done when:** A test proves the composed provider returns Gemma's answer on the
  happy path and the cloud answer when Gemma's transport throws — with zero
  changes to `packages/runtime` or any agent.
- **Estimated effort:** `4hr–1d`

## Interview defense

**Q: How would you swap LLM vendors without rewriting your agent?**
"Code the core against a contract, isolate the vendor in an adapter. I'd draw the
port:"

```
  core ─► ModelProvider (port) ◄─implements─ Anthropic / OpenAI / Fixture
                                              └ vendor SDK lives only here
```

"`ModelProvider` is `{ id, defaultModel?, complete() }`. The agent loop, structured
gen, and ledger import only that — nothing in `packages/runtime` imports a vendor
SDK. Each adapter translates the neutral request to the vendor's shape and the
response back. Swapping vendors is constructing a different adapter and injecting
it; `anthropic-provider.ts:18` and `openai-provider.ts:23` are the two adapters."
*Anchor: the vendor dependency stops at the adapter — the core never sees it.*

**Q: How do you know the abstraction actually holds?**
"The `FixtureModelProvider` test. It implements the same port with canned
responses, and the *real* agent loop runs against it unchanged — no API key, no
network. If the core had any vendor-specific code, the fixture couldn't stand in.
That it can, `fixture-provider.ts:3`, is the proof the quirks are behind the seam.
Bonus: the context-window guard is a *decorator* over the same port — adapter and
decorator are both just 'implements `ModelProvider`.'"
*Anchor: if a fake can replace the real thing with zero core changes, the seam is real.*

## Validate

- **Reconstruct:** Write the adapter skeleton — `id`, `defaultModel`, and the
  translate-in / call / translate-out shape of `complete`. Check
  `packages/providers/anthropic/src/anthropic-provider.ts:18-61`.
- **Explain:** Why must both adapters converge their responses to the same
  `ModelContentBlock[]` shape? (The agent loop branches on "is there a `tool_use`
  block?"; if shapes diverged, the loop would need vendor-specific code —
  `anthropic-provider.ts:42-53` vs `openai-provider.ts:50-65`.)
- **Apply:** You switch the default provider from Anthropic to OpenAI. What in
  `packages/runtime` changes? (Nothing — the runtime imports only `ModelProvider`;
  you inject a different adapter. `model-provider.ts:54-58`.)
- **Defend:** Why is `ContextWindowGuardedProvider` an `implements ModelProvider`
  rather than a function the runtime calls? (So it composes — it wraps any adapter
  and the core treats it identically to a real provider; decorator over the same
  port. `context-window-guard.ts:38`.)

## See also

- [01-what-an-llm-is.md](01-what-an-llm-is.md) — the contract this pattern implements
- [02-tokenization.md](02-tokenization.md) — the estimate the guarding decorator uses
- [06-token-economics.md](06-token-economics.md) — why provider `id` rides on every usage event
- [10-local-vs-cloud-models.md](10-local-vs-cloud-models.md) — Gemma local vs the cloud adapters, and when to pick which
- [../04-agents-and-tool-use/07-emulated-tool-calling.md](../04-agents-and-tool-use/07-emulated-tool-calling.md) — how the Gemma adapter fakes a tools API
- [../06-production-serving/](../06-production-serving/) — the fallback chain built from composed providers
