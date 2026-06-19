# LLM caching (don't pay twice for the same answer)

**Industry names:** prompt caching, exact-match cache, semantic cache · *Industry standard*

## Zoom out, then zoom in

The cheapest LLM call is the one you don't make because you already have the answer.
Caching sits between your agent and the provider: a repeated request returns a stored
result instead of a fresh (paid, slow) model call. AptKit does *not* have a cache
layer today — so this file teaches the foundation and points at the exact seam where
each kind would attach.

```
  Zoom out — where a cache would sit (none today)

  ┌─ Agent / Runtime layer ───────────────────────────────────────┐
  │  runAgentLoop → model.complete()                               │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ ★ a cache wrapper would go HERE ★
  ┌─ Cache layer (NOT BUILT) ──────▼────────────────────────────────┐
  │  hit → return stored result   miss → call provider, store        │ ← we are here
  └───────────────────────────────┬────────────────────────────────┘
                                   │
  ┌─ Provider layer ───────────────▼────────────────────────────────┐
  │  anthropic (native prompt caching) / openai / local             │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a cache is a keyed store in front of an expensive operation — same key,
stored answer; new key, compute and store. For LLMs there are three flavors, by how
the key is formed: *exact-match* (hash the whole request), *prompt caching* (the
provider caches a reusable prefix), and *semantic* (match by embedding similarity).
The question this file answers: which would fit AptKit, and where? Answer: none is
built; an exact-match cache keyed on `hash(system + messages)` slots cleanly into the
runtime, and Anthropic's native prompt caching attaches at the provider adapter.

## Structure pass

**Layers.** The relevant seam is the *provider boundary* — where `model.complete` is
called. A cache wrapper implements the same `ModelProvider` interface and decorates
the real provider, so it's invisible to the agent.

**Axis — cost / does this call spend tokens?** Trace it: with no cache, *every*
`complete` spends tokens. With an exact-match cache, a repeated request spends *zero*
(served from the store). With provider prompt caching, the repeated *prefix* is
discounted. The cache is purely a cost (and latency) axis intervention — it changes
nothing about correctness when the key is exact.

**Seams.** One seam, the `ModelProvider.complete` decorator point — the same seam the
fallback chain and the context guard already use. That AptKit *already* wraps
providers there (fallback, guard) is why a cache would drop in without touching
agents.

## How it works

You already know a memoization decorator: wrap a pure function, key on its arguments,
return the stored result on a repeat. An LLM cache is that, with `complete(request)`
as the function and some hash of the request as the key. The only subtlety is how
"same request" is defined — exact bytes, a shared prefix, or semantic closeness.

### Move 1 — the mental model

```
  Cache = keyed store in front of an expensive call

  request ──► key = hash(request)
                  │
            ┌─ hit? ─┐
            │  yes   │ no
            ▼        ▼
       stored    model.complete()  (pay tokens + latency)
       result        │ store under key
            └────────┴──────► return
```

The lever in one line: turn a repeated paid call into a free lookup. The whole game
is choosing the key.

### Move 2 — the three cache flavors

**Exact-match cache.** Bridge from HTTP `ETag` / response caching — hash the full
request (system + messages, and the relevant params) and store the response under
that hash. Identical request → identical key → stored answer, zero tokens. Boundary
condition: it only hits on *byte-identical* requests, so it's powerful for replayed
or deterministic workloads and useless for ever-varying prompts. This is the cleanest
fit for AptKit's runtime — see the exercise.

```
  Pattern — exact-match key

  key = sha256( system + JSON.stringify(messages) + maxTokens )
  hit → return stored ModelResponse (0 tokens)
  miss → complete(), store, return
```

**Provider prompt caching.** Bridge from a CDN caching a shared asset — the provider
caches a *reusable prefix* of the prompt (e.g. a long static system prompt) and
charges a discount when subsequent requests reuse it. You opt in by marking the
cacheable prefix in the provider request. Boundary condition: it's provider-specific
and prefix-based — it discounts the *shared* part, not the whole call, so it pays off
most when a big static system prompt is reused across many calls. In AptKit this
would attach in the Anthropic adapter, where the vendor request is built.

```
  Pattern — provider prefix cache (e.g. Anthropic)

  [ big static system prompt ][ varying user turn ]
   ◄──── cached prefix ─────► ◄── billed fresh ──►
   reused across calls → prefix discounted by the provider
```

**Semantic cache.** Bridge from nearest-neighbor lookup — key by the *embedding* of
the request and return a stored answer when a prior request is similar enough.
Boundary condition: it can return a *wrong* answer for a query that's close-but-not-
equal, so it needs a similarity threshold and is risky for anything where small
wording changes should change the answer. Most complex, least safe — last resort.

### Move 3 — the principle

Cache at the provider seam, and choose the key to match how repetition actually
shows up in your workload. Exact-match is safe and trivial — reach for it first when
requests genuinely repeat (replays, deterministic pipelines). Provider prompt caching
is free money when a large static prefix is reused. Semantic caching trades
correctness risk for hit rate and is the last tool you reach for. AptKit has none of
these yet; the right first move is exact-match in the runtime, because the decorator
seam already exists.

## Primary diagram

The full (proposed) picture: a cache decorator at the provider seam AptKit already
uses for other wrappers.

```
  LLM caching — where it attaches (not yet built)

  AGENT / RUNTIME: runAgentLoop → model.complete(request)
        │
  ┌─ CACHE DECORATOR (ModelProvider) — Case B ──────────────────────┐
  │  key = hash(system + messages + params)                         │
  │  hit  → return stored ModelResponse   (0 tokens, ~0 latency)     │
  │  miss → delegate ▼ , then store                                  │
  └────────────────────────────┬─────────────────────────────────────┘
                               ▼
  ┌─ REAL PROVIDER ─────────────────────────────────────────────────┐
  │  anthropic adapter ── (native prompt caching attaches HERE)      │
  │  openai / local                                                  │
  └──────────────────────────────────────────────────────────────────┘

  same decorator seam already used by FallbackModelProvider + ContextWindowGuardedProvider
```

## Implementation in codebase

**Use cases (none today).** There is no cache layer in AptKit. Every agent run calls
the provider fresh. The point worth internalizing: the *seam* a cache needs already
exists and is already used twice. `FallbackModelProvider` and
`ContextWindowGuardedProvider` both implement `ModelProvider` and decorate another
provider — a cache would be a third decorator of the same shape.

**The decorator seam a cache would use** — the `ModelProvider` interface,
`packages/runtime/src/model-provider.ts:54-58`:

```
  model-provider.ts  (lines 54-58)

  export type ModelProvider = {
    id: string;
    defaultModel?: string;
    complete(request: ModelRequest): Promise<ModelResponse>;   ← the one method to wrap
  };
       │
       └─ a cache is a class implementing this interface that wraps another
          provider — exactly how ContextWindowGuardedProvider
          (context-window-guard.ts:38) and FallbackModelProvider
          (fallback-provider.ts:27) already work. The pattern is proven; the
          cache just isn't written.
```

**Where the key material lives** — the request the cache would hash is the
`ModelRequest` (`model-provider.ts:39-46`): `system`, `messages`, `tools`,
`maxTokens`. An exact-match key is `hash(system + messages [+ params])`. Anthropic's
native prefix caching would attach one layer deeper, in `toAnthropicMessage`/the
request build inside `packages/providers/anthropic/src/anthropic-provider.ts`, where
the vendor payload is assembled and a cache-control marker could be added to the
static prefix.

## Elaborate

Caching is the oldest performance trick there is, and for LLMs it's a first-class
cost lever because each cache hit saves a real metered call. Exact-match is the safe
default; the interesting recent development is *provider-native prompt caching*
(Anthropic, OpenAI), which caches a reusable prompt prefix server-side and discounts
it — ideal when a long static system prompt is reused across many calls, which is
exactly the shape of an agent with a fixed role prompt. Semantic caching is the
high-risk/high-reward extreme: great hit rates, but a similarity threshold that's
too loose returns confidently wrong answers, so it's reserved for tolerant workloads.

AptKit hasn't needed a cache because its runs are varied investigations, not repeated
identical queries. The honest position: caching is an unbuilt, well-understood lever
whose attachment point already exists. The first move (exact-match in the runtime) is
cheap precisely because the decorator seam is established.

Adjacent concepts: the broader cost discipline this serves (`02-llm-cost-optimization.md`),
the provider-decorator seam shared with failover (`05-retry-circuit-breaker.md`), and
the token economics each hit saves (`../01-llm-foundations/06-token-economics.md`).

## Project exercises

*Provenance: Phase 6 — Production serving (C6.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case B — caching is not built; this introduces it.*

### Exercise — exact-match response cache in the runtime (Case B)

- **Exercise ID:** `[B6.5]` Phase 6, llm-caching concept
- **What to build:** A `CachingModelProvider` implementing `ModelProvider` that keys
  on `hash(system + JSON.stringify(messages) + maxTokens)`, returns the stored
  `ModelResponse` on a hit (with a trace event noting the hit), and delegates +
  stores on a miss. Pluggable store (in-memory default).
- **Why it earns its place:** It's the safe, foundational cache, and it drops into the
  exact decorator seam the fallback chain and context guard already use — so it
  demonstrates you can extend the provider stack without touching agents. Immediately
  useful for deterministic replays.
- **Files to touch:** a new `packages/providers/cache/src/*`,
  `packages/runtime/src/model-provider.ts` (consume the interface), matching tests.
- **Done when:** Two identical requests cause exactly one underlying `complete` call;
  a differing request causes a second; a test proves both and that the cached response
  is returned verbatim.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How would you add caching to this system?**
"Exact-match first, at the provider seam I already decorate. I'd draw it:"

```
  request → hash(system+messages) → hit? stored : complete()+store
  (a ModelProvider wrapper — same shape as the fallback chain)
```

"A `CachingModelProvider` implements `ModelProvider` (`model-provider.ts:54`) and
wraps the real one — exactly how `ContextWindowGuardedProvider` and
`FallbackModelProvider` already work. Key on `hash(system + messages + maxTokens)`;
hit returns the stored response for zero tokens. For a big static system prompt I'd
also turn on Anthropic's native prefix caching in the adapter. Semantic caching only
if the workload tolerates close-but-not-equal matches — it can return wrong answers."
*Anchor: exact-match is safe and trivial; semantic is the risky last resort.*

## Validate

- **Reconstruct:** From memory, write the cache decorator: hash the request, hit
  returns stored, miss delegates and stores. Check the seam against
  `model-provider.ts:54-58`.
- **Explain:** Why does an exact-match cache need no correctness reasoning but a
  semantic cache does? (Exact-match only hits on byte-identical requests, so the
  stored answer is *the* answer; semantic matches similar-but-different requests and
  can return an answer that's wrong for the actual query.)
- **Apply:** Where would Anthropic's native prompt caching attach in AptKit, and what
  would it discount? (In the Anthropic adapter where the vendor request is built —
  `anthropic-provider.ts` — discounting the reused static system-prompt prefix, not
  the whole call.)
- **Defend:** Why is exact-match the right *first* cache for AptKit rather than
  semantic? (Safety and fit: the decorator seam exists, it's risk-free, and AptKit's
  deterministic replays produce byte-identical requests that hit cleanly; semantic
  adds correctness risk for no current need.)

## See also

- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — caching as one cost lever among several
- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — the provider-decorator seam a cache shares
- [../04-agents-and-tool-use/02-tool-calling.md](../04-agents-and-tool-use/02-tool-calling.md) — the adapter seam where prompt caching attaches
- [../01-llm-foundations/06-token-economics.md](../01-llm-foundations/06-token-economics.md) — the tokens each cache hit saves
