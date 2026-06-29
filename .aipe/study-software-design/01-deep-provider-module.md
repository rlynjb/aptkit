# 01 — Deep Provider Module

**Subtitle:** Deep module behind a narrow interface · the adapter pattern
applied to LLM providers — *Industry standard* (the "port and adapter" / "deep
module" shape).

---

## Zoom out, then zoom in

Here's the whole runtime, with the one box this file is about marked. Every
agent in the repo, every structured-generation call, every eval that judges with
an LLM — they all reach the model through exactly one method on one type. That
type is the marked box.

```
  Zoom out — where the provider contract sits

  ┌─ Agent layer ──────────────────────────────────────────────┐
  │  RagQueryAgent · recommendation · diagnostic · query        │
  └───────────────────────────┬─────────────────────────────────┘
                              │ runAgentLoop / generateStructured
  ┌─ Runtime ─────────────────▼─────────────────────────────────┐
  │  needs ONE thing from a model: complete(request) → response  │
  └───────────────────────────┬─────────────────────────────────┘
                              │  ★ ModelProvider.complete() ★   ← we are here
  ┌─ Provider layer ──────────▼─────────────────────────────────┐
  │  Gemma   Anthropic   OpenAI   Fallback   ContextGuard        │
  │  (each a different deep body behind the SAME 3-line type)    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the concept is a **deep module** — Ousterhout's term for a module whose
*interface* is far smaller than its *implementation*. `ModelProvider` is the
narrowest useful interface for "talk to a language model," and behind it sits
everything that's actually hard about talking to five different models. The
question it answers: how do you let the rest of the codebase depend on "a model"
without depending on *which* model, or on any of the per-vendor mess?

---

## Structure pass

Three layers, one axis, the seam where it flips.

- **Layers:** caller (agent/runtime) → the `ModelProvider` contract → the
  concrete adapter body.
- **Axis — "who knows about the vendor?":** trace it down.
  - caller layer → **knows nothing.** It holds a `ModelProvider`; it could be
    any of five.
  - contract layer → **knows nothing.** Three fields: `id`, `defaultModel?`,
    `complete()`. No vendor word anywhere (`model-provider.ts:54-58`).
  - adapter body → **knows everything.** "gemma2:9b", Ollama's `/api/chat`,
    Anthropic's SDK, the retry nudge.
- **Seam:** the `complete()` boundary. Vendor knowledge flips from *zero* above
  it to *total* below it. That's a load-bearing seam — the entire swappability
  of the repo lives there.

The mechanics hang on that seam. Let's walk it.

---

## How it works

### Move 1 — the mental model

You already know this shape from the frontend: a `fetch()` returns a `Response`
no matter whether the server is Express, a CDN, or a mock in a test. The caller
codes against the `Response` shape, not the server. `ModelProvider` is that, for
LLMs — one response shape, any backend.

```
  Pattern — one narrow port, swappable deep bodies

           caller depends on the SHAPE, never the body
                          │
            ┌─────────────▼──────────────┐
            │  ModelProvider              │   ← the port (3 fields)
            │   id                        │
            │   defaultModel?             │
            │   complete(req) → res       │
            └──┬────────┬────────┬────────┘
               │        │        │   any body that satisfies the port plugs in
        ┌──────▼─┐ ┌────▼───┐ ┌──▼──────────┐
        │ Gemma  │ │Anthropic│ │ Fallback    │
        │(emul.) │ │ (SDK)   │ │ (wraps N)   │
        └────────┘ └─────────┘ └─────────────┘
```

The strategy in one sentence: **define the model as a 3-field type, and make
every backend's complexity the implementer's problem, never the caller's.**

### Move 2 — the step-by-step walkthrough

**The interface, in full.** This is the entire contract — read it once and
you've read the deepest seam in the repo.

```ts
// packages/runtime/src/model-provider.ts:54
export type ModelProvider = {
  id: string;                 // which adapter ("gemma", "anthropic", ...)
  defaultModel?: string;      // optional: the model name to report in traces
  complete(request: ModelRequest): Promise<ModelResponse>;  // ← the one verb
};
```

Three fields. Two are metadata for tracing; **one is the whole job.** Everything
a caller can ask a model to do — chat, use tools, stream, abort — is folded into
the `ModelRequest`/`ModelResponse` shapes (`model-provider.ts:39-52`), not into
extra methods. That's the deliberate narrowing: no `chat()`, `useTools()`,
`stream()` sprawl. One verb, rich arguments.

**Why `complete()` and not five methods.** Here's the move people miss. The
request carries `tools?`, `signal?`, `temperature?` as *optional fields*
(`model-provider.ts:39-46`). A provider that can't do tools (Gemma natively
can't) still satisfies the same signature — it just handles `tools` differently
inside its body. If the interface had a separate `completeWithTools()` method,
Gemma would have to either lie about supporting it or callers would have to
branch on provider type. Folding capability into optional request fields keeps
the interface one method wide while letting bodies differ wildly.

```
  Layers-and-hops — the same call, three different bodies

  ┌─ Runtime ───────────┐  complete({messages, tools})   ┌─ Gemma body ──────┐
  │ runAgentLoop        │ ──────────────────────────────►│ render tools into  │
  │                     │                                 │ system prose, parse│
  │                     │ ◄────── ModelResponse ──────────│ JSON back to       │
  │                     │   {content:[tool_use|text]}     │ tool_use block     │
  └─────────────────────┘                                 └────────────────────┘
        same hop ▲                                         ┌─ Anthropic body ──┐
        same shape│              complete(...)             │ pass tools to SDK  │
        any body  └────────────────────────────────────► │ native tool_use    │
                                                           └────────────────────┘
```

**Self-similarity: providers that wrap providers.** The strongest proof the
interface is right — `FallbackModelProvider` *is itself* a `ModelProvider`
(`packages/providers/fallback/src/fallback-provider.ts:27`). Its body is a loop
over other `ModelProvider`s, calling each one's `complete()` until one succeeds.
The context-window guard is the same: a `ModelProvider` whose body checks token
budget and then delegates to an inner `ModelProvider`. Because the interface is
narrow enough to implement *and* consume, you can stack them:

```
  guard( fallback( [gemma, anthropic] ) )   — all three are one ModelProvider
```

A caller holding the outer guard can't tell it's three layers deep. That nesting
is only possible because `complete()` is the only thing each layer needs from
the next. Widen the interface and the nesting breaks.

### Move 3 — the principle

A module is deep when its interface is small relative to what it does, and the
payoff compounds: a narrow interface is one a *second* implementation (or a
wrapper) can satisfy cheaply. aptkit got five providers, a fallback chain, and a
context guard out of a 3-field type. The interface size — not the body size — is
what bought that.

---

## Primary diagram

```
  The deep provider module, full picture

  ┌─ callers (vendor-blind) ─────────────────────────────────────────┐
  │ runAgentLoop · generateStructured · RubricJudge · agents          │
  └────────────────────────────┬──────────────────────────────────────┘
                               │ holds a ModelProvider; calls complete()
  ════════════════════════════▼══════════════════════════ THE SEAM ════
       ModelProvider = { id, defaultModel?, complete(req)→res }
       (model-provider.ts:54 — 3 fields, no vendor word)
  ═════════════════════════════════════════════════════════════════════
                               │ satisfied by
   ┌──────────┬──────────┬─────▼──────┬───────────────┬────────────────┐
   │ Gemma    │ Anthropic│ OpenAI     │ Fallback      │ ContextGuard   │
   │ emulates │ SDK pass-│ SDK pass-  │ wraps N       │ wraps 1 +      │
   │ tools    │ through  │ through    │ providers     │ token check    │
   │ (deep)   │          │            │ (is-a         │ (is-a          │
   │          │          │            │  provider)    │  provider)     │
   └──────────┴──────────┴────────────┴───────────────┴────────────────┘
```

---

## Elaborate

This is the hexagonal-architecture "port" idea, narrowed to one method. The
reason it shows up everywhere in good LLM code is that vendor APIs churn — model
names, request shapes, tool formats all drift — and the only defense is a seam
they can't cross. aptkit's `context.md` even lists `ModelProvider` as a
"must-not-change contract": the cost of that stability is that adding a *new*
capability (say, native streaming) means widening the request shape carefully so
all five bodies still satisfy it. That's the tax you pay for the swappability;
it's the right tax.

The one thing the interface lacks: a doc comment. The most load-bearing type in
the repo has no contract documentation saying what an implementation must
guarantee (what does `usage` mean when `estimated`? must `complete` be safe to
call concurrently?). That's the cheapest high-value fix on this file — see
`audit.md` lens 7.

Adjacent: `03-contract-as-the-product.md` is the same move applied to retrieval
(`VectorStore`/`EmbeddingProvider`); `02-emulation-hidden-behind-complete.md`
zooms all the way into the deepest of these bodies.

---

## Interview defense

**Q: Why is a 3-field type the *deepest* module in the codebase? Isn't deep
about having a lot of code?**

Deep is about the *ratio*, not the body size. The interface is three fields; the
body behind it (across five adapters plus the emulation) is hundreds of lines a
caller never touches. The deepest module is the one that hides the most behind
the least — and `ModelProvider` hides "every difference between five LLM
backends" behind `complete()`.

```
  depth = behaviour hidden ÷ interface surface
        = (5 adapters + emulation + retry) ÷ (3 fields)
        = high
```

**Q: Why fold tools/streaming into an optional request field instead of separate
methods?**

So a provider that can't do a thing still satisfies the same signature. Gemma
has no native tool-calling; if the interface had `completeWithTools()`, Gemma
would have to fake-implement it or callers would branch on provider type — both
leak the vendor across the seam. Optional fields keep the interface one verb
wide and let bodies diverge.

*Anchor:* "Fallback and the context guard are themselves `ModelProvider`s —
`guard(fallback([gemma, anthropic]))` is one provider three layers deep, and
that only composes because the interface is one method."

---

## See also

- `02-emulation-hidden-behind-complete.md` — the deepest body behind this seam.
- `03-contract-as-the-product.md` — the same shape for retrieval.
- `06-capability-as-composition.md` — the callers that depend on this seam.
- `audit.md` — lens 2 (deep-vs-shallow), lens 4 (layering / self-similarity).
- `../study-system-design/` — the same contract at service altitude.
