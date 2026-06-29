# LLM caching

*LLM caching · prompt/semantic/exact-match (Industry standard)*

You've done this instinct before. buffr and contrl are local-first — they cache reads on the device because a round trip you don't take is the only round trip that never fails. The same reflex applies to model calls, except the round trip you're skipping costs money and 800ms instead of 8ms. Right now aptkit takes *every* round trip. There's no cache layer at all. This file is `not yet exercised` — so we're going to build the mental model, then point at the three exact seams where a cache would bolt on.

## Zoom out, then zoom in

A cache is a layer that sits *in front of* the model and answers some requests without asking the model. The three caching strategies aren't competitors — they're three layers at three distances from the model, each catching a different kind of repeat. ★ The further out the layer, the cheaper the hit and the rarer it fires.

```
LLM caching layers (request travels left → right toward the model)
┌──────────────────────────────────────────────────────────────────────┐
│  CALLER                                                                │
│    │                                                                   │
│    ▼                                                                   │
│  ┌──────────────────┐  hit → return stored response  ┌─────────────┐  │
│  │ Exact-match cache │ ─────────────────────────────▶ │  (skip all  │  │
│  │ key = hash(req)   │                                 │   below)   │  │
│  └────────┬─────────┘  miss ↓                          └─────────────┘ │
│           ▼                                                            │
│  ┌──────────────────┐  near-hit → return neighbor's   ┌─────────────┐  │
│  │ Semantic cache    │ ──── response (cosine ≥ τ) ───▶ │  (skip      │  │
│  │ key = embedding   │                                 │   model)    │  │
│  └────────┬─────────┘  miss ↓                          └─────────────┘ │
│           ▼                                                            │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ Prompt cache (provider-side, e.g. Anthropic cache_control)     │    │
│  │ caches the PREFIX (system + tools) inside the model call       │    │
│  └────────────────────────────┬───────────────────────────────────┘  │
│                                ▼                                       │
│                          ┌───────────┐                                 │
│                          │   MODEL   │  full inference                 │
│                          └───────────┘                                 │
└──────────────────────────────────────────────────────────────────────┘
```

Exact-match is the cheapest and the rarest — it only fires on byte-identical requests. Semantic catches paraphrases. Prompt cache doesn't skip the call at all; it makes the call cheaper by reusing the expensive prefix.

## Structure pass

One axis: **distance from the model**. Three layers, three seams.

- **Exact-match cache** — lives at the `ModelProvider` boundary, before any provider runs. Key is a hash of the whole request (`system` + `messages` + `tools` + `temperature`). Total skip on hit. Seam: a decorator provider wrapping any `ModelProvider`.
- **Semantic cache** — also at the boundary, after exact-match misses. Key is an *embedding* of the user prompt; a hit is a stored entry within cosine threshold τ. Seam: the embedding pipeline you already have for RAG (`03-retrieval-and-rag/`) plus a vector lookup.
- **Prompt cache** — *inside* the provider, provider-specific. For Anthropic it's `cache_control` markers on the system/tools blocks. Seam: `AnthropicModelProvider.complete` where it builds the `messages.create` params.

The seams don't touch each other. That's the point — each is a thin layer you can add, measure, and remove independently.

## How it works

**Move 1 — the mental model: a cache is a decorator that short-circuits.**

aptkit already has the exact shape you need. The context-window guard (`ContextWindowGuardedProvider`) is a `ModelProvider` that wraps another `ModelProvider`, does a cheap check first, and only calls through on success. A cache is the same decorator with the verdict inverted: check first, and on a *hit* return early instead of throwing.

```
Decorator-provider pattern (the shape aptkit already ships)
┌─────────────────────────────────────────────────────────┐
│ class XGuardedProvider implements ModelProvider {         │
│   constructor(private inner: ModelProvider) {}            │
│                                                           │
│   async complete(request) {                               │
│     ── cheap pre-check on request ──▶ decision            │
│        guard:  bad? THROW       ┐                         │
│        cache:  hit? RETURN early┘  ← only difference      │
│     ── otherwise ──▶ return this.inner.complete(request)  │
│   }                                                       │
│ }                                                         │
└───────────────────────────────────────────────────────────┘
```

**Move 2 — step by step through each layer.**

**Part A — Exact-match (the decorator you'd write).** This is a gap file, so here's current-state-vs-future-state. Today the context guard wraps a provider and either throws or calls through — there's no early-return path:

```
Move 2.5 — exact-match cache vs the guard it mirrors
CURRENT (context-window-guard.ts:57-70)        FUTURE (cache decorator)
┌────────────────────────────────────┐         ┌────────────────────────────────────┐
│ async complete(request) {           │         │ async complete(request) {           │
│   const est = estimate(request)     │         │   const key = hash(request)         │
│   if (!est.ok) throw Exceeded(...)  │ ──────▶ │   const hit = this.store.get(key)   │
│   return this.provider.complete(req)│         │   if (hit) return hit  ← EARLY OUT  │
│ }                                   │         │   const res = await inner.complete()│
│                                     │         │   this.store.set(key, res)          │
│ // only throw-or-passthrough        │         │   return res                        │
└────────────────────────────────────┘         └────────────────────────────────────┘
```

The real guard, for shape reference — note the pre-check then conditional passthrough at `context-window-guard.ts:57-70`:

```ts
// packages/providers/local/src/context-window-guard.ts:57-70
async complete(request: ModelRequest): Promise<ModelResponse> {
  request.signal?.throwIfAborted();
  const estimate = estimateContextWindow(request, this.options); // ← cheap pre-check
  if (!estimate.ok) {
    // ... emit warning ...
    throw new ContextWindowExceededError(estimate);              // ← guard's verdict
  }
  return this.provider.complete(request);                        // ← passthrough on pass
}
```

Your cache swaps `estimate` for `hash(request)`, swaps the throw for a `return hit`, and adds a `store.set` after the passthrough. The key must include everything that changes the answer: `system`, `messages`, `tools`, `temperature`. Skip `signal` — it's not part of the answer.

**Part B — Semantic cache (reuse the embedding pipeline).** Exact-match misses on "What's our refund policy?" vs "How do refunds work?" — different bytes, same intent. Semantic cache embeds the prompt and looks for a stored neighbor within cosine threshold τ.

```
Semantic lookup (reuses the RAG embedding pipeline)
  prompt ──embed──▶ [0.12, -0.03, ...] ──cosine vs stored keys──▶ max sim
                                                                    │
                              sim ≥ τ (e.g. 0.95) ── HIT ──▶ return neighbor's response
                              sim <  τ ─────────── MISS ─▶ call model, store (embed, response)
```

You already have the embedding half of this in `03-retrieval-and-rag/`. The danger is τ too low: you return a stored answer for a *different enough* question and serve a confident wrong answer. Set τ high (≥0.97) and only cache stable, factual prompts — never anything personalized.

**Part C — Prompt cache (provider-side, the prefix).** This one doesn't skip the call. It tells the provider "the prefix of this request is reused across calls — cache its KV state." For Anthropic that's `cache_control` on the system block and tool definitions. aptkit's anthropic provider builds the request but sets *no* cache markers today:

```ts
// packages/providers/anthropic/src/anthropic-provider.ts:29-39  (current — no cache_control)
const response = await this.client.messages.create({
  model: this.defaultModel,
  max_tokens: request.maxTokens ?? 4096,
  ...(request.system ? { system: request.system } : {}),   // ← prefix, NOT cached
  messages: request.messages.map(toAnthropicMessage),
  ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
  ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
});
```

The future move: mark the system block (and the tool array) with `cache_control: { type: 'ephemeral' }`. Anthropic then bills the cached prefix at a fraction of input price on the next call within the cache window. This is the *only* one of the three that's provider-specific — and the only one you can't build as a generic decorator. (Read the `claude-api` skill before touching `cache_control`; the marker placement and pricing have rules.)

**Move 3 — the principle.** Cache the layer whose repeats you actually see. Exact-match for byte-identical retries (cheap, safe, rare). Semantic for paraphrase clusters (medium, risky, set τ high). Prompt cache for a fat reused prefix (no skip, just cheaper). Don't build all three on day one — build the one your traffic justifies, and measure the hit rate before you trust it.

## Primary diagram

```
The three caches, what they key on, and what they save
┌────────────────┬────────────────────┬──────────────┬───────────────────────┐
│ Layer          │ Key                │ On hit        │ Risk                  │
├────────────────┼────────────────────┼──────────────┼───────────────────────┤
│ Exact-match    │ hash(full request) │ skip model    │ stale entry           │
│ Semantic       │ embedding(prompt)  │ skip model    │ wrong answer if τ low │
│ Prompt (Anthr.)│ provider prefix    │ cheaper call  │ provider-specific     │
└────────────────┴────────────────────┴──────────────┴───────────────────────┘
       ↑ decorator at ModelProvider boundary        ↑ inside the provider
```

## Elaborate

- **Invalidation is the whole game.** A cache is a promise that the answer hasn't changed. For exact-match keyed on the full request, that promise holds *only if the model and its weights are fixed*. Bump the model version → the key must include the model id, or you serve last month's model's answer. aptkit's request hash should fold in `provider.id` + `defaultModel`.
- **Local-first dulls the incentive, doesn't kill it.** With Gemma on Ollama the per-call dollar cost is $0, so exact-match's *savings* are latency-only. But latency still matters for a snappy local agent, and the moment a cloud provider enters the fallback chain, caching pays in dollars again. Build the seam local-first; it earns out when you go cloud.
- **Don't cache the agent loop, cache the leaf calls.** Caching a whole multi-turn agent run is fragile — one different tool result poisons the rest. Cache the individual `complete()` calls (the leaves), where the request is self-contained.

## Project exercises

Phase 5 is where production serving lands. These are Case B (`not yet exercised`) — you're building the seam from scratch.

### Exact-match cache decorator

- **Exercise ID:** `EX-SERVE-01a` — exact-match-cache-decorator
- **What to build:** A `CachedModelProvider` decorator that wraps any `ModelProvider`, keys on a stable hash of `{system, messages, tools, temperature, provider.id, defaultModel}`, returns the stored `ModelResponse` on a hit, and stores on a miss. Mirror the `ContextWindowGuardedProvider` shape.
- **Why it earns its place:** It's the smallest real serving primitive aptkit is missing, and it proves you understand cache-key invalidation (folding the model id into the key).
- **Files to touch:** new `packages/providers/local/src/cache-provider.ts` (mirror `context-window-guard.ts`), export from `packages/providers/local/src/index.ts`.
- **Done when:** two identical requests produce one inner `complete()` call (assert via a spy provider), and changing `temperature` produces a miss.
- **Estimated effort:** `1–4hr`

### Semantic cache lookup

- **Exercise ID:** `EX-SERVE-01b` — semantic-cache-threshold
- **What to build:** Extend the decorator with a semantic tier: embed the user prompt, cosine-compare against stored keys, return a neighbor's response when similarity ≥ τ (default 0.97). Reuse the existing embedding pipeline.
- **Why it earns its place:** It forces the τ-tradeoff conversation — too low serves wrong answers — which is the interview-grade insight.
- **Files to touch:** `packages/providers/local/src/cache-provider.ts`, wire to the embedding code in the RAG packages.
- **Done when:** a paraphrase of a cached prompt hits at τ=0.97, and an unrelated prompt misses; τ is configurable.
- **Estimated effort:** `1–2 days`

### Anthropic prompt cache

- **Exercise ID:** `EX-SERVE-01c` — anthropic-cache-control
- **What to build:** Add `cache_control: { type: 'ephemeral' }` to the system block and tool array in the anthropic provider when a long stable prefix is present. Read `claude-api` first.
- **Why it earns its place:** It's the one provider-specific cache, and it shows you read provider docs rather than guessing.
- **Files to touch:** `packages/providers/anthropic/src/anthropic-provider.ts:29-39`.
- **Done when:** the request to `messages.create` carries `cache_control` on the system block, gated behind a prefix-length check, with a unit test asserting the param shape.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: When does an exact-match cache actively hurt you?**

```
correct answer changes  ──but key didn't──▶  served stale, confidently
   (model upgrade,           ↑
    data behind prompt)   key must fold in model id + data version
```

Anchor: a cache is a promise the answer is fixed; key on everything that can move the answer, or the cache lies.

**Q: Exact-match misses on paraphrases. Why not always use semantic?**

```
"refund policy?" vs "how do refunds work?"  ── semantic: HIT (good)
"refund policy?" vs "refund policy for EU?" ── semantic: HIT (WRONG)
                                                  τ too low → confident wrong answer
```

Anchor: semantic trades a higher hit rate for the risk of answering a *different* question; you pay for it with a high threshold and a narrow scope.

**Q: aptkit is local-first — Gemma costs $0. Why cache at all?**

```
$0 per call  ──but──▶  latency ≠ $0, and cloud fallback ≠ $0
              build the seam now → it earns out the day a cloud provider enters the chain
```

Anchor: local-first makes the *dollar* incentive vanish but not the *latency* one — and the seam is the cheap part to build early.

## See also

- [`02-llm-cost-optimization.md`](./02-llm-cost-optimization.md) — caching's sibling; the cost ledger that would measure cache savings.
- [`05-retry-circuit-breaker.md`](./05-retry-circuit-breaker.md) — the other `ModelProvider` decorator family.
- [`../03-retrieval-and-rag/01-embeddings.md`](../03-retrieval-and-rag/01-embeddings.md) — the embedding pipeline the semantic cache reuses.
