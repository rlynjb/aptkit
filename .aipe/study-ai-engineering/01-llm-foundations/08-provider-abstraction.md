# Provider abstraction — the load-bearing seam

**Subtitle:** ModelProvider · one interface, many vendors · *Industry standard*

## Zoom out, then zoom in

This is the seam the whole repo balances on. Before any vendor detail, see that
every agent talks to a single interface and never names a vendor.

```
  Zoom out — the one seam every agent depends on

  ┌─ Capabilities ──────────────────────────────────────────────┐
  │  query / rag-query / recommendation / evals — vendor-blind  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ complete(request): Promise<response>
  ┌─ The seam ────────────────▼─────────────────────────────────┐
  │  ★ ModelProvider ★  one interface — id, defaultModel,        │ ← we are here
  │  complete()                                                 │
  └──────┬──────────┬──────────┬──────────┬──────────┬──────────┘
         │          │          │          │          │
     ┌───▼──┐   ┌───▼──┐   ┌───▼───┐  ┌───▼────┐ ┌───▼─────────┐
     │Gemma │   │Claude│   │OpenAI │  │Fallback│ │ContextGuard │
     │(local)│  │      │   │       │  │(wraps) │ │(wraps)      │
     └──────┘   └──────┘   └───────┘  └────────┘ └─────────────┘
```

There is no `getModel()` switch statement. Instead, every provider is a *class
that implements the same interface*, so swapping vendors is swapping which
instance you construct — agents above the seam never change. This is the single
most important design decision in aptkit: the model is replaceable because the
interface is tiny and nobody above it knows the vendor. The proof it's truly a
seam and not just a type lives in a *different* repo — buffr swaps the storage
side through the exact same trick.

## Structure pass

**Layers.** Capability → `ModelProvider` interface → a concrete provider class
(Gemma/Claude/OpenAI) → optionally wrapped by `FallbackModelProvider` or
`ContextWindowGuardedProvider` → vendor SDK/HTTP.

**Axis — vendor knowledge.** Trace "who knows it's Claude?" The capability:
nothing. The interface: nothing — just `id` and `complete`. The concrete class:
everything (SDK, model name, auth). The flip is total and clean.

**Seam.** `ModelProvider` (`packages/runtime/src/model-provider.ts:54`). Above it,
typed request/response and zero vendor strings. Below it, `@anthropic-ai/sdk`,
Ollama HTTP, OpenAI client. Wrappers (fallback, context guard) sit *on the seam*:
they implement `ModelProvider` and also consume one, so they compose without
anyone noticing.

## How it works

### Move 1 — the mental model

You know how a React component takes a `fetcher` prop and doesn't care if it's
`fetch`, Axios, or a mock? `ModelProvider` is that prop for the model. Agents
receive *a* provider and call `complete()`; whether that's local Gemma or remote
Claude is decided once, at construction, by whoever wires the app.

```
  Dependency injection, applied to the model

  agent(provider) {                  provider can be ANY of:
    provider.complete(req)   ◄────────  Gemma | Claude | OpenAI | Fallback | Guard
  }                                    agent code is identical for all of them
```

### Move 2 — the moving parts

**The interface — one method.** Every provider satisfies the same three members.
From `packages/runtime/src/model-provider.ts:54`:

```ts
export type ModelProvider = {
  id: string;                                              // ← 'gemma' | 'anthropic' | 'openai' | 'fallback'
  defaultModel?: string;
  complete(request: ModelRequest): Promise<ModelResponse>; // ← the entire contract
};
```

```
  The whole seam

  id           ─► used by the cost ledger to pick pricing
  defaultModel ─► the model name a vendor uses by default
  complete()   ─► everything an agent ever calls
```

**Each vendor is a class implementing it.** Same shape, different guts. The
defaults tell the story — local-first by default, cloud when wired:

```ts
class GemmaModelProvider    implements ModelProvider { id='gemma';     defaultModel='gemma2:9b'        } // gemma-provider.ts:39
class AnthropicModelProvider implements ModelProvider { id='anthropic'; defaultModel='claude-sonnet-4-6'} // anthropic-provider.ts:18
class OpenAIModelProvider   implements ModelProvider { id='openai';    defaultModel='gpt-4.1'          }
```

```
  Same interface, different vendor below the line

  GemmaModelProvider     ─► POST localhost:11434/api/chat   (no key, no TLS)
  AnthropicModelProvider ─► @anthropic-ai/sdk messages.create (ANTHROPIC_API_KEY)
  OpenAIModelProvider    ─► OpenAI client
       ▲ all three return the SAME ModelResponse shape ▲
```

The default model is **local Gemma** — no API key, no TLS, talking to Ollama on
localhost. Claude and OpenAI are opt-in by constructing their provider instead.

**Wrappers that are themselves providers.** The real power: `FallbackModelProvider`
*implements* `ModelProvider` and *holds* a list of them, trying each in order. From
`packages/providers/fallback/src/fallback-provider.ts:47`:

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  for (let index = 0; index < this.providers.length; index += 1) {
    const provider = this.providers[index];
    try {
      const response = await provider.complete(request);     // ← try this vendor
      this.lastSelectedProvider = { providerId: provider.id, model: response.model ?? provider.defaultModel };
      return { ...response, model: response.model ?? provider.defaultModel };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) throw error;
      attempts.push({ providerId: provider.id, model: provider.defaultModel, error: String(error) });
      // emit a warning, then fall through to the next provider
    }
  }
  throw new ProviderFallbackError(attempts);                 // ← all failed, with the full attempt log
}
```

```
  FallbackModelProvider — a provider made of providers

  complete(req)
     │
     ▼
  [ Gemma ] ──fail──► [ Claude ] ──fail──► [ OpenAI ] ──fail──► ProviderFallbackError(attempts)
     │ ok                │ ok                 │ ok
     ▼                   ▼                    ▼
   return            return               return   (records lastSelectedProvider)
```

`ContextWindowGuardedProvider` is the same composition idea: it wraps a provider,
estimates tokens, and throws `ContextWindowExceededError` before calling down if
the request won't fit (`context-window-guard.ts:38`). Because both wrappers *are*
providers, you can stack them — guard around a fallback chain around three
vendors — and agents see one `complete()`.

**The proof the seam is real: buffr.** A type is only a real seam if something
external can fill it without touching the core. aptkit defines a sibling seam,
`VectorStore`, and buffr — a separate repo — implements it for Postgres/pgvector,
importing the contract from the published package. From
`/Users/rein/Public/buffr/src/pg-vector-store.ts:19`:

```ts
import type { VectorStore } from '@rlynjb/aptkit-core';        // ← contract from aptkit
export class PgVectorStore implements VectorStore {            // ← buffr fills it, aptkit unchanged
  readonly dimension: number;
  async upsert(chunks: Chunk[]): Promise<void> { /* INSERT … agents.chunks (embedding vector) */ }
}
```

```
  The seam, proven from outside

  aptkit defines:  ModelProvider   +   VectorStore     (just interfaces)
                        │                   │
   aptkit fills:   Gemma/Claude/…      (in-memory store)
   buffr fills:        —               PgVectorStore (Postgres + pgvector)
        ▲ buffr swaps the STORE, not the model — same seam discipline ▲
```

The point: in aptkit the swap point *for the model* is the `ModelProvider` type.
buffr doesn't swap the model — it proves the pattern by swapping the *store* the
same way, filling `VectorStore` from a different repo with zero changes to aptkit.

### Move 3 — the principle

Define the smallest interface that captures the dependency, make every
implementation a class that satisfies it, and let composition (wrappers that are
also implementations) add fallback, guarding, and policy without leaking upward.
A seam is proven when an outside party can fill it untouched — `ModelProvider` for
the model, `VectorStore` for storage, buffr for the receipts.

## Primary diagram

```
  Provider abstraction, fully stacked

  agent
    │ complete(req)
    ▼
  ┌ ContextWindowGuardedProvider ─────────────────────────────┐
  │  estimate tokens; fits? else ContextWindowExceededError    │
  │   │ complete(req)                                          │
  │   ▼                                                        │
  │ ┌ FallbackModelProvider ─────────────────────────────────┐│
  │ │  try in order, record attempts, ProviderFallbackError  ││
  │ │   ├─► GemmaModelProvider     (gemma2:9b, localhost)     ││
  │ │   ├─► AnthropicModelProvider (claude-sonnet-4-6)        ││
  │ │   └─► OpenAIModelProvider    (gpt-4.1)                  ││
  │ └────────────────────────────────────────────────────────┘│
  └────────────────────────────────────────────────────────────┘
   every layer IS a ModelProvider — the agent only ever sees complete()
```

## Elaborate

The anti-pattern this kills is embedding a vendor SDK in business logic, where a
model swap becomes a rewrite. By forcing everything through `complete()`, aptkit
makes the swap a one-line construction change and makes fallback/guarding
composable. This is the same Ports-and-Adapters / dependency-inversion idea you'd
apply to a database or a payment gateway — the model is just another external
dependency behind a port. Read `01-what-an-llm-is.md` for the request/response
contract, and `06-token-economics.md` for how `provider.id` drives pricing.

## Project exercises

### Build a recording provider that wraps any ModelProvider
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a `RecordingModelProvider` implementing `ModelProvider` that
  wraps another, writes each request/response to disk as a fixture, and delegates
  `complete()` — usable for capturing replay traces from a live Gemma run.
- **Why it earns its place:** proves you understand wrappers-as-providers (the
  fallback/guard pattern) and produces the fixtures the test suite runs on.
- **Files to touch:** new `packages/providers/recording/src/recording-provider.ts`,
  matching `test/`.
- **Done when:** wrapping Gemma and calling `complete()` writes a fixture and
  returns the unchanged response.
- **Estimated effort:** `1–4hr`

### Add a shouldFallback policy that only retries on transient errors
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** pass a `shouldFallback` to `FallbackModelProvider` that
  returns false for auth/4xx errors (don't waste the next provider on a config bug)
  and true for timeouts/5xx, with tests for both branches.
- **Why it earns its place:** naive "fall back on any error" masks misconfiguration;
  classifying errors is the production-grade version of the pattern.
- **Files to touch:** `packages/providers/fallback/src/fallback-provider.ts`
  (already supports the hook), `packages/providers/fallback/test/`.
- **Done when:** an auth error throws immediately; a timeout advances to the next
  provider.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "How do you swap Gemma for Claude in aptkit?"**
Construct `AnthropicModelProvider` instead of `GemmaModelProvider` and hand it to
the agent. Nothing above the `ModelProvider` seam changes — agents only call
`complete()`. There's no `getModel()` switch; the vendor lives entirely in the
class you instantiate.

```
  agent(provider)  ── provider := new GemmaModelProvider()    (default, local)
                   └─ provider := new AnthropicModelProvider() (one line, opt-in)
       agent code: unchanged
```
Anchor: *the swap point is which class you construct, not any agent code.*

**Q: "How do you know `ModelProvider` is a real abstraction and not a leaky type?"**
Because the same discipline holds for a sibling seam, `VectorStore`, and an
*external* repo (buffr) fills it with Postgres/pgvector by importing the contract —
zero changes to aptkit. A seam an outsider can implement untouched is a real seam.

```
  aptkit: interface only ──► buffr: PgVectorStore implements VectorStore
       no aptkit edits = the seam holds
```
Anchor: *a seam is proven when an outside repo fills it untouched.*

## See also

- `01-what-an-llm-is.md` — the `complete()` request/response contract in detail
- `06-token-economics.md` — how `provider.id` selects (or fails) pricing
- `05-streaming.md` — where a future streaming method plugs into this seam
