# 02 — The provider decorator stack

**Industry names:** Decorator pattern (GoF) · wrapper · middleware ·
chain-of-responsibility (the fallback part).
**Type:** Industry standard.

---

## Zoom out, then zoom in

Two of AptKit's "providers" don't talk to any LLM. They wrap *other*
providers — adding behaviour while staying the same shape.

```
  Zoom out — where the wrappers sit

  ┌─ Foundation ───────────────────────────────────────────────┐
  │  runAgentLoop  →  calls complete() on "a ModelProvider"     │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ doesn't know it's wrapped
  ┌─ Provider adapters + wrappers ▼─────────────────────────────┐
  │                                                              │
  │   ★ ContextGuard ──wraps──► Fallback ──wraps──► [Anthropic, │
  │     (wrapper)               (wrapper)            OpenAI]     │
  │                                                              │
  │   every box implements the SAME ModelProvider interface     │
  └──────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is the **decorator**: a wrapper that implements the
same interface as the thing it wraps, adds behaviour on the way through, and
delegates the rest. Because `FallbackModelProvider` and
`ContextWindowGuardedProvider` both *are* `ModelProvider`s, the loop can't
tell it's holding a wrapper. You compose retry, fallback, and a token-budget
guard by nesting them — no new interface, no caller changes.

---

## Structure pass — layers · axis · seam

**Layers:** caller → outer wrapper (guard) → inner wrapper (fallback) → real
adapter (Anthropic/OpenAI).

**Axis — trace "who decides whether the call actually goes to a vendor?"**

```
  one question down the wrapper stack:
  "who decides if/where the real HTTP call happens?"

  ┌──────────────────────────────────┐
  │ ContextWindowGuardedProvider      │  → guard decides: estimate tokens,
  │                                   │    REFUSE if over budget (throws).
  └──────────────────────────────────┘
      ┌──────────────────────────────┐
      │ FallbackModelProvider         │  → fallback decides: try provider 1,
      │                               │    on error try provider 2, ...
      └──────────────────────────────┘
          ┌──────────────────────────┐
          │ AnthropicModelProvider    │  → the real call. no more deciding.
          └──────────────────────────┘

  control flips at each wrapper — and the interface never changes
```

**Seam:** every layer boundary is the *same* seam — the `complete()` method.
That's the whole trick. The decorator reuses the deep module's seam (`01`)
instead of inventing a new one. A wrapper is load-bearing precisely because
control (will the call happen? where?) flips across it while the contract
stays fixed.

---

## How it works

You know how Express middleware wraps a request handler — each layer can act,
then call `next()` to pass control inward, and the handler never knows how
many layers sit above it? A provider decorator is that, but the "handler" and
every "middleware" share one method signature.

### Move 1 — the shape

```
  the decorator shape — same neck, new behaviour, then delegate

  complete(req)
       │
       ▼
  ┌─ wrapper ─────────────────────────────┐
  │  do something with req  (estimate /    │
  │  pick provider / log)                  │
  │  ───────────────────────────────────   │
  │  return inner.complete(req)  ──────────┼──► delegates to wrapped provider
  └────────────────────────────────────────┘
       ▲
       └─ wrapper implements ModelProvider, so it slots in
          anywhere a provider is expected. nesting = composition.
```

### Move 2 — the two wrappers

**Wrapper A — the context guard refuses before it delegates.** This is a
decorator that can *short-circuit*. It estimates input tokens from the request
(`system + messages + tool schemas`, ~3 chars/token), compares against
`maxTokens - outputReserve`, and if the request won't fit, it **throws instead
of calling the inner provider**. The boundary condition that matters: it
throws a typed `ContextWindowExceededError`, not a generic one — so the layer
above (often the fallback chain) can recognise "this local model can't fit
this prompt" and move on rather than treating it as a hard failure.

```
  context guard — decorator that can refuse

  ┌─ ContextWindowGuardedProvider ────────────────────────┐
  │  estimate = tokens(system + messages + tools)         │
  │  if estimate > (maxTokens − outputReserve):           │
  │      emit warning trace                                │
  │      throw ContextWindowExceededError   ──────────────┼──► inner NEVER called
  │  else:                                                 │
  │      return inner.complete(request)     ──────────────┼──► delegate
  └────────────────────────────────────────────────────────┘
```

**Wrapper B — the fallback chain tries providers in order.** This decorator
wraps *many* providers (it's also chain-of-responsibility). It loops: try
provider[0], on error record the attempt and try provider[1], and so on. The
load-bearing parts, named by what breaks without them:

- **The abort check** (`isAbortError`) — without it, a user cancellation gets
  treated as a provider failure and the chain pointlessly tries the next
  provider on an already-aborted request.
- **The `shouldFallback` predicate** — without it, a *fatal* error (bad API
  key) triggers a doomed retry against every provider instead of failing fast.
- **The aggregated `ProviderFallbackError`** — without it, the caller sees
  only the last provider's error and loses the chain's history.

```
  fallback chain — try in order, aggregate failures

  complete(req)
     │
     ├─ try providers[0].complete(req) ── success? ──► return (record selected)
     │        │ error
     │        ▼
     │   abort?  ──yes──► rethrow (not a fallback)
     │   shouldFallback(err)?  ──no──► rethrow (fatal, fail fast)
     │   record attempt, emit warning
     │
     ├─ try providers[1].complete(req) ── success? ──► return
     │        │ error → record
     ▼
  all failed ──► throw ProviderFallbackError(attempts[])   ← one error, full history
```

### Move 2.5 — how they compose

Because both are `ModelProvider`s, you nest them: `new
ContextWindowGuardedProvider(new FallbackModelProvider({ providers: [local,
anthropic] }))`. The guard refuses oversized prompts to the *local* path; the
fallback catches that refusal and routes to Anthropic. The caller wires one
provider and gets "use the cheap local model when the prompt fits, else fall
back to the API" — with zero conditional logic at the call site.

### Move 3 — the principle

**A decorator buys you composition without interface growth: you add
behaviour by nesting, not by adding parameters.** The alternative — a
`complete()` with `enableFallback`, `fallbackProviders`, `maxContextTokens`,
`outputReserve` flags — would push every wrapper's complexity *up* into the
interface, making the deep module shallow (`01`). Keeping each behaviour in
its own same-shaped wrapper is how you pull that complexity back down.

---

## Primary diagram

```
  the full stack — one interface, three behaviours, nested

  caller wires:  new ContextGuard( new Fallback([local, anthropic]) )

  ┌─ ContextGuard (ModelProvider) ─────────────────────────────────┐
  │  estimate tokens → over budget? throw : delegate ▼              │
  │  ┌─ Fallback (ModelProvider) ───────────────────────────────┐  │
  │  │  for each provider: try → on error → next ▼               │  │
  │  │  ┌─ local (ModelProvider) ┐   ┌─ AnthropicProvider ───┐   │  │
  │  │  │ guarded by budget      │   │ real HTTP to vendor   │   │  │
  │  │  └────────────────────────┘   └───────────────────────┘   │  │
  │  └──────────────────────────────────────────────────────────┘  │
  └──────────────────────────────────────────────────────────────────┘
       caller sees one ModelProvider; the stack is invisible to it
```

---

## Implementation in codebase

**Use cases.** Production wiring composes a cheap/local provider with an API
provider so a run uses the local model when the prompt fits and falls back to
Anthropic/OpenAI otherwise — without the agent loop knowing any of it. The
fallback's `attempts[]` and the guard's warning traces also show up in Studio
so you can see *why* a provider was skipped.

**The fallback wrapper —
`packages/providers/fallback/src/fallback-provider.ts:27-90`:**

```
  export class FallbackModelProvider implements ModelProvider {  ← IS a provider
    readonly id = 'fallback';
    constructor(options) {
      if (options.providers.length === 0) throw ...             ← can't wrap nothing
      this.defaultModel = options.providers[0]?.defaultModel;   ← impersonate first
    }
    async complete(request) {
      for (let i = 0; i < this.providers.length; i += 1) {
        request.signal?.throwIfAborted();                        ← honour cancellation
        try {
          const response = await provider.complete(request);     ← delegate inward
          this.lastSelectedProvider = { providerId, model };     ← remember the winner
          return { ...response, model: response.model ?? ... };
        } catch (error) {
          if (isAbortError(error) || request.signal?.aborted) throw error;  ← not a fallback
          attempts.push({ providerId, model, error });           ← record for the error
          if (!this.shouldFallback(error, provider)) throw error; ← fatal → fail fast
          // else loop to next provider
        }
      }
      throw new ProviderFallbackError(attempts);                 ← aggregate all failures
    }
  }
```

The `implements ModelProvider` on line 27 is the entire pattern in one phrase:
the wrapper is type-compatible with what it wraps, so it nests anywhere a
provider is expected.

**The context guard —
`packages/providers/local/src/context-window-guard.ts:38-71`:**

```
  export class ContextWindowGuardedProvider implements ModelProvider {
    constructor(provider, options) {
      this.id = provider.id;                  ← impersonate the wrapped provider's identity
      this.defaultModel = provider.defaultModel;   (pass-through by design — see audit Lens 4)
    }
    async complete(request) {
      const estimate = estimateContextWindow(request, this.options);
      if (!estimate.ok) {
        this.options.trace?.emit({ type: 'warning', ... });      ← observable refusal
        throw new ContextWindowExceededError(estimate);          ← typed: caller can react
      }
      return this.provider.complete(request);                    ← else delegate
    }
  }
```

The estimator `estimateModelRequestTokens` (`context-window-guard.ts:91`) sums
system + messages + tool schemas and divides by `charsPerToken`. That whole
estimation is hidden behind the same `complete()` signature — the guard adds a
decision without widening the interface.

---

## Elaborate

This is the GoF **Decorator** (same-interface wrapper that adds behaviour)
fused with **Chain of Responsibility** (the fallback's try-each-in-order
loop). Both depend on the deep module from `01`: the decorator pattern is only
clean because `ModelProvider` is a stable, narrow interface. Try this with a
wide interface and every wrapper would have to forward dozens of fields — the
forwarding noise would bury the one behaviour each wrapper actually adds.

Where it comes from: middleware stacks (Express, Redux, gRPC interceptors) are
the same idea — uniform-shape layers that act-then-delegate. AptKit applies it
at the provider boundary so retry/fallback/budget become composable units
instead of flags on one mega-function.

The honest tradeoff: a deep nested stack is harder to debug than a flat
function, because a thrown error has passed through several `complete()`
frames. AptKit mitigates this with the typed errors (`ProviderFallbackError`
carries `attempts[]`, `ContextWindowExceededError` carries the `estimate`) so
the stack trace isn't the only evidence — the error object explains what each
layer decided.

---

## Interview defense

**Q: "Why wrappers instead of one provider with config flags?"**

Because flags push every wrapper's complexity up into the shared interface and
make the deep module shallow. Three behaviours — refuse-if-too-big,
try-in-order, the real call — as three same-shaped wrappers means I compose
them by nesting and the agent loop's call site never changes. As flags, the
loop and the interface would both grow every time I add a behaviour.

```
  flags (shallow)                wrappers (this design)
  complete(req, {                ContextGuard( Fallback([ a, b ]) )
    fallback, providers,           each behaviour = one nestable unit
    maxCtx, reserve })             interface stays 3 members
```

**Anchor:** "Both wrappers `implement ModelProvider`, so composition is
nesting, not configuration."

**Q: "What's the load-bearing part people forget in a fallback chain?"** The
abort check. Without distinguishing a user cancellation from a provider error,
the chain dutifully retries every provider against a request the user already
killed. `fallback-provider.ts:65` is the line that prevents it.

---

## Validate

1. **Reconstruct:** sketch the fallback `complete()` loop — try, catch, abort
   check, `shouldFallback` check, record, aggregate. Check against
   `fallback-provider.ts:47`.
2. **Explain:** why does `ContextWindowGuardedProvider` copy `id` and
   `defaultModel` from the wrapped provider instead of inventing its own?
   (Identity impersonation — the stack above must not see the wrapper.)
3. **Apply:** wire a stack that uses a local model when the prompt fits and
   Anthropic otherwise. Which constructors nest, in what order?
4. **Defend:** the guard throws on oversized prompts. Argue throwing vs.
   returning a `{ ok: false }` result — and reconcile it with the fact that
   `ndjson-stream` and `json-output` (`audit.md` Lens 6) chose *not* to throw.
   (Hint: the guard's throw is *caught by the fallback wrapper* as a signal;
   the parsers return because their callers want to inspect the failure.)

---

## See also

- `01-model-provider-deep-module.md` — the interface these wrappers reuse.
- `audit.md` Lens 4 (pass-through-by-design), Lens 6 (`ProviderFallbackError`
  aggregation, the abort-error sprawl).
- `.aipe/study-system-design/` — the fallback chain as a failure-handling
  architecture decision.
