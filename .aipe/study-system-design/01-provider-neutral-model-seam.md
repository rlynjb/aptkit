# 01 — Provider-neutral model seam

**Industry name(s):** adapter pattern / dependency inversion / port-and-adapter
(hexagonal) seam. **Type:** Industry standard.

## Zoom out, then zoom in

This is the seam the entire toolkit hangs from. Strip it out and aptkit stops being
"a provider-neutral agent toolkit" and becomes "an Ollama wrapper." Here's where it
sits.

```
  Zoom out — where the model seam lives

  ┌─ agents layer (packages/agents/*) ───────────────────────┐
  │  RagQueryAgent.answer()  →  runAgentLoop({ model, ... })  │
  └───────────────────────────────┬──────────────────────────┘
                                  │ depends ONLY on this type:
  ┌─ runtime layer ──────────────▼───────────────────────────┐
  │  ★ ModelProvider.complete(req) → Promise<ModelResponse> ★ │ ← we are here
  └───────────────────────────────┬──────────────────────────┘
                                  │ implemented by (swappable):
  ┌─ providers layer ────────────▼───────────────────────────┐
  │ gemma │ local-guard │ fallback │ anthropic │ openai       │
  └───────────────────────────────────────────────────────────┘
```

Every agent, the loop, the trace — none of them import a vendor SDK. They import
one TypeScript type, `ModelProvider`, and call its one method, `complete()`. The
question this answers: *how do you build agent logic once and run it against a
local Gemma, a cloud Claude, or a fake fixture, without the logic knowing which?*
Answer: you depend on a contract, not an implementation. Now the mechanism.

## Structure pass

**Layers:** agents (caller) → `ModelProvider` contract (the port) → provider
adapters (gemma / local / fallback / anthropic / openai).

**Axis traced — *control of the vendor call*:** who actually talks to a model API?

```
  One axis — "who makes the vendor API call?" — traced down

  ┌─ agent ──────────────────┐   never. only knows complete().
  └──────────┬────────────────┘
  ┌─ ModelProvider contract ─▼┐   never. it's a type, no body.
  └──────────┬────────────────┘
  ┌─ adapter ─▼───────────────┐   HERE. gemma → fetch(:11434),
  │ gemma / anthropic / ...    │   anthropic → @anthropic-ai/sdk.
  └────────────────────────────┘   the answer flips at this seam.
```

**Seam:** the boundary between the contract and the adapters. The axis flips there
— above it nothing knows a vendor exists; below it is the *only* place a vendor name
appears. That flip is what makes the seam load-bearing: it's where you intercept,
substitute, or fake the model.

## How it works

### Move 1 — the mental model

You already know this shape from frontend. You write a component against a `fetch()`
that returns `{ loading, data, error }`; you don't care if the bytes came from a
CDN, a mock server, or a service worker. The *shape of the response* is the
contract; the source is swappable. `ModelProvider` is exactly that, for an LLM call.

```
  The model seam — one contract, many bodies

        ┌──────────────────────────────────────┐
        │ ModelProvider                         │
        │   id: string                          │
        │   complete(req) → Promise<response>   │   ← the only thing
        └──────────────────────────────────────┘      callers know
            ▲          ▲          ▲          ▲
            │          │          │          │   each is a full body
        ┌───┴──┐  ┌────┴───┐  ┌───┴────┐ ┌───┴────┐
        │gemma │  │anthropic│ │fallback│ │fixture │
        │:11434│  │  SDK   │  │ chain  │ │(replay)│
        └──────┘  └────────┘  └────────┘ └────────┘
```

### Move 2 — the walkthrough

**The contract itself.** It's tiny — three members, one method. That smallness is
the design: a small port is easy to implement, so adapters are cheap.

```ts
// packages/runtime/src/model-provider.ts:54
export type ModelProvider = {
  id: string;               // who am I (used in trace + fallback records)
  defaultModel?: string;    // which model unless told otherwise
  complete(request: ModelRequest): Promise<ModelResponse>;  // the one verb
};
```

The request/response types (`model-provider.ts:39` and `:48`) are vendor-neutral on
purpose: `ModelRequest` carries `system`, `messages`, `tools`, `maxTokens`,
`signal`; `ModelResponse` carries `content` blocks, `usage`, `model`. No Anthropic
`messages.create` shape, no OpenAI `chat.completions` shape leaks through. **What
breaks if this is missing:** every agent would type-couple to a vendor SDK, and
swapping providers would mean rewriting agents.

**An adapter — gemma, the default.** The gemma adapter implements `complete()` over
local Ollama. The interesting part is that Gemma has *no native tool-calling*, so
the adapter emulates it: it renders the `tools` array into the system text and asks
for a JSON tool call back (`gemma-provider.ts:133`), then parses the model's reply
into a `tool_use` block (`gemma-provider.ts:168`).

```ts
// packages/providers/gemma/src/gemma-provider.ts:52 (abridged)
async complete(request: ModelRequest): Promise<ModelResponse> {
  const wantsTool = Boolean(request.tools?.length);
  const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;   // retry only when a tool is expected
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = (await this.chat({ model, messages, stream: false })).message?.content ?? '';
    if (wantsTool) {
      const call = parseToolCall(raw);                            // messy text → {name, input}
      if (call) return this.toResponse([{ type: 'tool_use', ... }], ...);
      if (looksLikeToolAttempt(raw)) continue;                    // botched JSON → nudge + retry
    }
    break;
  }
  return this.toResponse([{ type: 'text', text: raw }], ...);     // plain prose is a real answer
}
```

The key line is that the *caller never sees any of this*. The agent asked for a
`complete()` with tools; it got back a normalized `ModelResponse` with a `tool_use`
block — identical in shape to what the anthropic adapter returns from a native tool
API. The emulation tax is paid entirely below the seam.

**The decorator adapters.** Two adapters don't talk to a model at all — they wrap
another `ModelProvider`:

- **`ContextWindowGuardedProvider`** (`context-window-guard.ts:38`) wraps an inner
  provider, estimates input tokens, and throws *before* delegating if the prompt
  won't fit. It still `implements ModelProvider`, so it slots in anywhere.
- **`FallbackModelProvider`** (`fallback-provider.ts:27`) holds a list of providers
  and tries them in order. Also `implements ModelProvider`.

Because both *are* `ModelProvider`s, you compose them: buffr wires
`new ContextWindowGuardedProvider(new GemmaModelProvider(...), { maxTokens: 8192 })`
(`session.ts:46`) — a guard wrapping gemma, and the agent above can't tell it's not
talking to a bare provider.

```
  Composition — adapters wrapping adapters, same contract throughout

  agent → ModelProvider ─┐
                         ▼
            ContextWindowGuardedProvider   (implements ModelProvider)
                         │ delegates if it fits
                         ▼
            FallbackModelProvider          (implements ModelProvider)
                         │ try in order
              ┌──────────┼──────────┐
              ▼          ▼          ▼
            gemma     anthropic    openai
```

**What breaks if removed:** drop the guard and an oversized prompt fails deep inside
Ollama with a worse error and no fallback. Drop fallback and one provider outage
takes the whole run down. Neither is the *skeleton* — the skeleton is the contract;
these are hardening layered on top, and they're hardening precisely *because* they
satisfy the same contract.

### Move 3 — the principle

Depend on the narrowest contract that does the job, and put every vendor name on the
far side of it. The payoff isn't abstraction for its own sake — it's that *every*
useful operation (fake it for tests, guard it, chain it, swap local→cloud) becomes a
new implementation of one type instead of a rewrite. The seam is where all your
leverage lives.

## Primary diagram

The whole seam, recapped — caller, contract, and the five bodies behind it.

```
  Provider-neutral model seam — the full picture

  ┌─ agents (packages/agents/*) ────────────────────────────────────┐
  │  6 agents, each: runAgentLoop({ model: ModelProvider, ... })     │
  └────────────────────────────────┬─────────────────────────────────┘
                                   │ calls .complete(req) only
  ┌─ runtime contract ────────────▼──────────────────────────────────┐
  │  ModelProvider { id, defaultModel?, complete(req)→Promise<resp> } │
  │  ModelRequest/ModelResponse — vendor-neutral block shapes         │
  └──────────┬──────────┬──────────┬──────────┬──────────┬────────────┘
             ▼          ▼          ▼          ▼          ▼
        ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────┐
        │ gemma  │ │ local  │ │fallback│ │anthropic│ │ openai  │
        │ Ollama │ │ guard  │ │ chain  │ │  SDK   │ │  SDK    │
        │ :11434 │ │(wraps) │ │(wraps) │ │(cloud) │ │(cloud)  │
        └────────┘ └────────┘ └────────┘ └────────┘ └─────────┘
   default path: guard → gemma → Ollama, no key, no TLS, no cloud
```

## Elaborate

This is the textbook *ports and adapters* (hexagonal architecture) move, and it's
the dependency-inversion principle made concrete: high-level policy (the agent loop)
depends on an abstraction (`ModelProvider`), and low-level detail (the SDKs) depend
on that same abstraction. The reason it's the *most* load-bearing pattern in aptkit
is the project's stated reason to exist — "without app-specific product logic
leaking into the core." The model seam is the structural enforcement of that goal:
the core *cannot* leak a vendor because it never names one.

Compare it to a frontend repository pattern, which you've shipped — `fetch`-behind-
an-interface so a component can be tested against a mock. Same shape, one method.
Read next: `03-library-vs-deployment-split.md` (the seam that makes the *whole
library* swappable), and `02-retrieval-contracts-as-the-swap-point.md` (the same
move applied to storage).

## Interview defense

**Q: Why not just take an `Anthropic` client as a constructor arg?**
Because then every agent type-couples to one SDK, and "run it locally with zero
cloud" becomes impossible without a rewrite. The contract costs one tiny type and
buys you local default, cloud opt-in, fakes for tests, and composable wrappers
(guard, fallback). Anchor: *one method, `complete()`, and five bodies behind it.*

```
  agent → [ContractWall] → gemma | anthropic | fixture
          the wall is the entire value
```

**Q: What's the load-bearing part people forget?**
That the *decorator* adapters (`ContextWindowGuardedProvider`, `FallbackModelProvider`)
are `ModelProvider`s themselves — that's what makes them composable. People model
"the adapter pattern" as a flat fan-out and miss that wrapping is the same seam used
recursively. Anchor: *guard wraps fallback wraps gemma, and the agent can't tell.*

```
  guard( fallback( gemma ) ) — all three are ModelProvider
```

**Q: Where does the abstraction leak?**
The tool-call *emulation*. The gemma adapter fakes tool-calling in the system
prompt (`gemma-provider.ts:133`), so a weak local model can botch the JSON. The
seam holds (callers still get a normalized `tool_use` block) but the *reliability*
behind it differs by adapter — a real tradeoff, mitigated by retry + `minTopK`, not
hidden. Anchor: *the contract is uniform; the reliability behind it isn't.*

## See also

- `04-bounded-agent-loop.md` — the loop that calls `complete()` in a budget.
- `02-retrieval-contracts-as-the-swap-point.md` — the same move, for storage.
- `03-library-vs-deployment-split.md` — the library-scale version of this seam.
- **`study-software-design`** — `ModelProvider` as a deep module.
- **`study-ai-engineering`** / **`study-agent-architecture`** — the model call as an
  AI primitive rather than an architectural boundary.
