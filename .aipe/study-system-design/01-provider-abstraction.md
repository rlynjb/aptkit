# 01 — Provider abstraction (the model seam)

> **Subtitle:** Provider abstraction / Ports-and-adapters over an LLM —
> *Industry standard.* The contract is the port (`ModelProvider`), each
> vendor binding is an adapter, the agents are the client, the fallback chain
> is a composite adapter. Standard role-vocabulary (port / adapter / client /
> factory / dependency injection) is owned by `study-software-design` →
> PATTERN VOCABULARY; this file leads with those role-names and keeps the
> repo's local names in parens.

## Zoom out — where this sits

Every agent in aptkit needs a model. None of them imports an Anthropic or
OpenAI SDK. They all call one method on one contract, and *something else*
decides whether that call goes to a local Ollama process, to Claude, or down
a fallback chain.

```
  Zoom out — the model seam in the stack

  ┌─ Capability layer (agents) ─────────────────────────────┐
  │  recommendation · rag-query · query · …                 │  the client
  │            depends on ModelProvider, never a vendor SDK  │
  └───────────────────────────┬─────────────────────────────┘
                              │ model.complete(request)
  ┌─ Model port ──────────────▼─────────────────────────────┐
  │  ★ ModelProvider ★   the contract everything depends on  │ ← we are here
  │  packages/runtime/src/model-provider.ts:54               │
  └───────────────────────────┬─────────────────────────────┘
            ┌──────────┬───────┼─────────┬───────────┐
            ▼          ▼       ▼         ▼           ▼
        ┌───────┐ ┌───────┐ ┌──────┐ ┌────────┐ ┌────────┐
        │ gemma │ │ local │ │ fall │ │anthropic│ │ openai │   the adapters
        │(Ollama)│ │(guard)│ │ back │ │ (SDK)  │ │ (SDK)  │
        └───┬───┘ └───────┘ └──────┘ └────────┘ └────────┘
            │ HTTP :11434, no key/TLS
            ▼  Ollama (local) — the DEFAULT path makes no cloud call
```

The seam matters because the default is the *local* gemma adapter. Run aptkit
out of the box and no network leaves your machine. Swap one adapter and the
exact same agents talk to Claude — without touching a line of agent code.

## Structure pass — layers, axis, seam

Three layers stacked here: the **client** (agents), the **port**
(`ModelProvider`), the **adapters** (five bindings). Trace one axis —
**who owns the failure** — down the stack:

```
  axis traced: "where does a model failure originate and get contained?"

  ┌─ client (agent) ───────────────┐   sees only: a thrown error from complete()
  │  await model.complete(req)      │   → contained by runAgentLoop's recovery turn
  └──────────────┬──────────────────┘
       seam ═════╪═════  ← failure ORIGIN flips from "my code" to "an external system"
  ┌─ port ────────▼─────────────────┐   ModelProvider: promises a ModelResponse or throws
  └──────────────┬──────────────────┘
  ┌─ adapter ─────▼─────────────────┐   gemma: Ollama down → fetch throws
  │                                 │   fallback: catches, tries next, else ProviderFallbackError
  │                                 │   local: context overflow → throws BEFORE the call
  └─────────────────────────────────┘
```

The load-bearing seam is `complete()`. Above it, failure is something an agent
*reacts to*; below it, failure *originates* in an external system (a dead
Ollama, a 429 from a cloud API, an oversized context). Map that seam first;
the adapters hang off it.

## How it works

### Move 1 — the mental model

You already know this shape from frontend: a `DataSource` interface with a
`fetch()` method, where one implementation hits a REST API and another returns
fixtures in a test. Swap the implementation, the component never knows. Here
the interface is `ModelProvider` and the method is `complete()`.

```
  the port's shape — one method, vendor-agnostic in and out

  ModelRequest ──►  complete(request)  ──►  ModelResponse
  { system,            (the only             { content:[],
    messages[],         method on             usage?,
    tools?,             the port)             model? }
    maxTokens?,
    signal? }

  no Anthropic type. no OpenAI type. no Ollama type. just this.
```

That's the entire contract — `packages/runtime/src/model-provider.ts:54-58`:

```ts
export type ModelProvider = {
  id: string;                                      // which adapter answered (trace + fallback)
  defaultModel?: string;                           // adapter's default if request omits one
  complete(request: ModelRequest): Promise<ModelResponse>;  // the one verb
};
```

Three fields. `id` is what shows up in the trace and lets the fallback chain
name which provider it tried. `complete()` is the verb every agent calls. The
request and response types are deliberately vendor-shaped *nothing* — a
`content` array of text/tool-use blocks (`model-provider.ts:20-52`), which
each adapter translates to and from its vendor's wire format.

### Move 2 — the adapters, one at a time

**The cloud adapters — straight translation.** The anthropic adapter
(`packages/providers/anthropic/src/anthropic-provider.ts`) maps `ModelRequest`
→ `client.messages.create()` and flattens the SDK's content blocks back to
`ModelContentBlock[]`. Default model `claude-sonnet-4-6`. The openai adapter
does the same against `chat.completions.create()`, prepending `system` as a
message and setting `tool_choice: 'auto'`; default `gpt-4.1`. Each one's whole
job is to be a translation layer — vendor types live *inside* the adapter and
never leak past `complete()`.

```
  layers-and-hops — one adapter translating across the boundary

  ┌─ runtime ───────┐  hop 1: ModelRequest (neutral)   ┌─ anthropic adapter ─┐
  │  runAgentLoop   │ ───────────────────────────────► │ toAnthropicMessage  │
  │                 │  hop 4: ModelResponse (neutral) ◄─│ flatten content     │
  └─────────────────┘                                  └──────────┬──────────┘
                                            hop 2 │ messages.create()  ▲
                                                  ▼                    │ hop 3: SDK reply
                                          ┌─ Anthropic API (cloud) ────┘
                                          └────────────────────────────┘
```

**The gemma adapter — the interesting one.** Gemma (via Ollama) has *no native
tool-calling API*. The adapter fakes it
(`packages/providers/gemma/src/gemma-provider.ts`): it renders the tool
schemas into the system prompt and demands the model reply with a single JSON
object `{"tool": "...", "arguments": {...}}` (`buildSystemText`, lines
129-165), then parses that text back into a `tool_use` content block
(`parseToolCall`, lines 167-182). When the model botches the JSON, it appends a
retry nudge and tries again up to `maxToolCallAttempts` (default 2, lines
62-89). Transport is a bare `fetch` to `http://localhost:11434/api/chat` —
no auth header, no TLS (lines 201-215). Default model `gemma2:9b`.

This is the load-bearing adapter because it's the *default*. The whole "runs
offline, no key" property of aptkit rests on it — and the emulation fragility
is exactly why the retrieval tool grows a `minTopK` floor (see `02`).

**The local guard — a decorator adapter.** `ContextWindowGuardedProvider`
(`packages/providers/local/src/context-window-guard.ts`) wraps another
provider. It estimates input tokens (chars / 3) against `maxTokens -
outputReserve` (reserve default 768) and throws `ContextWindowExceededError`
*before* delegating — fail-fast instead of letting a local model silently
truncate. It's an adapter that adds a check, then forwards.

**The fallback chain — a composite adapter.** This is the part that makes the
seam pay off (`packages/providers/fallback/src/fallback-provider.ts:50-88`):

```ts
for (const provider of this.providers) {          // try in order
  try {
    const response = await provider.complete(request);
    return response;                              // first success wins
  } catch (error) {
    if (!this.shouldFallback(error, provider)) throw error;  // hook can stop early
    trace?.emit({ type: 'warning', /* tried provider.id, moving on */ });
    // else: loop to next provider
  }
}
throw new ProviderFallbackError(attempts);        // all failed → one error, all attempts named
```

It *is* a `ModelProvider` (same port) that holds a list of `ModelProvider`s.
The client can't tell a single adapter from a chain of five — that's the
recognition test passing. One try per provider, no backoff (named as
`not yet exercised` in the audit).

#### Move 2 variant — the load-bearing skeleton

Strip the port to its kernel and ask what breaks if each part goes:

- **The method (`complete`)** — drop it and there's no seam; agents import
  SDKs directly and the provider-neutral promise is gone.
- **The neutral request/response types** — drop them (let Anthropic's types
  through) and every agent now depends on Anthropic; swapping vendors becomes
  a rewrite. The neutrality is what makes the swap free.
- **`id`** — drop it and the fallback chain can't report *which* provider it
  tried, and the trace can't attribute a `model_usage` event. Observability
  and failover both lose their label.

Hardening layered on top, not part of the kernel: the context guard, the
retry nudge in gemma, the `shouldFallback` hook.

### Move 3 — the principle

Depend on a contract, not a vendor (dependency inversion; the role-vocabulary
is in `study-software-design`). The payoff isn't abstraction for its own sake —
it's that *the default can be local and free*, the production binding can be
cloud, and a fallback chain can sit between them, all behind one method the
agents never have to know about.

## Primary diagram

```
  the model seam, end to end

  ┌─ agents (client) ──────────────────────────────────────────────────┐
  │  await model.complete({ system, messages, tools, maxTokens, signal })│
  └───────────────────────────────┬──────────────────────────────────────┘
                                   │  ModelProvider port (model-provider.ts:54)
   ┌───────────────┬───────────────┼──────────────┬──────────────┬─────────┐
   ▼               ▼               ▼              ▼              ▼
 ┌──────────┐  ┌─────────┐  ┌────────────┐  ┌──────────┐  ┌──────────┐
 │ fallback │─►│ gemma   │  │ local guard│  │ anthropic│  │ openai   │
 │ (chain)  │  │ gemma2  │  │ wraps any  │  │ sonnet-4 │  │ gpt-4.1  │
 │ try→try  │  │ :9b     │  │ provider   │  │          │  │          │
 └──────────┘  └────┬────┘  └────────────┘  └────┬─────┘  └────┬─────┘
                    │ fetch :11434 (no key/TLS)   │ SDK         │ SDK
                    ▼                             ▼             ▼
              Ollama (local, DEFAULT)        Anthropic       OpenAI  (cloud)
```

## Elaborate

Ports-and-adapters (hexagonal architecture) is the parent pattern; "dependency
inversion" is the principle (depend on the abstraction, not the concrete). The
twist aptkit adds is making the *default* adapter the local one, inverting the
usual "cloud-first, local for tests" assumption — here it's local-first, cloud
as an opt-in. The fallback chain is the Composite pattern wearing the same
interface as its leaves, which is why it slots in transparently. Read `03` next
for how the loop drives `complete()`, and `study-distributed-systems` for the
failover-correctness questions the chain raises (idempotency, partial success).

## Interview defense

**Q: Why not just import the Anthropic SDK in the agents?**
Because then every agent depends on a vendor, and the local-first default
becomes impossible. The whole point is one contract (`ModelProvider.complete`)
that the agents depend on, with five adapters behind it — the default being
local gemma so the out-of-box path makes no cloud call.

```
  agents ──depend on──► ModelProvider (port) ◄──implement── 5 adapters
                                              the swap is free
```
*Anchor:* "Provider-neutral: the agents call `complete()`, never a vendor SDK."

**Q: What's the one part people forget when they build this?**
The `id` field on the port. It looks decorative until the fallback chain needs
to report which provider it tried and the trace needs to attribute token
usage. Drop it and both observability and failover lose their label.

```
  fallback tries gemma(id) → anthropic(id) → all fail → ProviderFallbackError[attempts by id]
```
*Anchor:* "`id` is what makes failover and the usage trace legible."

## See also

- `00-overview.md` — the model port on the full map
- `03-bounded-agent-loop.md` — the client that calls `complete()`
- `04-capability-event-trace.md` — where `id` and `model_usage` surface
- `study-software-design` → PATTERN VOCABULARY — port / adapter / client / factory
- `study-distributed-systems` — failover correctness of the chain
