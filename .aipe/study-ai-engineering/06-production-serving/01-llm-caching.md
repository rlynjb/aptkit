# LLM caching

**Subtitle:** Don't pay for the same tokens twice · the three cache layers · *Industry standard*

## Zoom out, then zoom in

Before mechanism: a cache is a box you slip *in front of* the model so a repeat
request never reaches it. Here's where that box would sit in aptkit — and the
honest truth is the production slot is empty.

```
  Zoom out — where a cache sits relative to the model

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  rag-query / query / recommendation agents                  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ complete(request)
  ┌─ Cache layer (the box) ───▼─────────────────────────────────┐
  │  ★ hit?  → return stored response (no model call)           │ ← empty in prod
  │  ★ miss? → call model, store, return                        │   (fixtures only)
  └───────────────────────────┬─────────────────────────────────┘
                              │ on miss
  ┌─ Provider / model ────────▼─────────────────────────────────┐
  │  Gemma (local) — free, so the cache earns nothing here      │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. aptkit runs Gemma locally, so a cache hit saves you *latency*, not
*money* — and aptkit hasn't built one. What it *did* build is the same shape for
a different reason: `FixtureModelProvider` replays recorded responses so tests
and Studio never touch the model. That's an exact-match cache wearing a test
hat. Learn the three production layers as the pattern; recognize aptkit's
fixture replay as the nearest thing it owns.

## Structure pass

**Layers.** Capability → cache → provider → model. The cache is a *decorator*
around the provider: same `complete()` interface, different behavior on a hit.

**Axis — cost.** Trace what each request *costs*. A cache miss costs a full model
call (tokens, latency, dollars on cloud). A cache hit costs a key lookup. The
whole point of the layer is to move requests from the miss column to the hit
column. On local Gemma the dollar column is always $0, so the only payoff is
latency — which is why aptkit skipped it.

**Seam.** The load-bearing boundary is `ModelProvider.complete()`
(`packages/runtime/src/model-provider.ts:54`). A cache is *any* object that
implements that interface and wraps another provider. The axis "did we call the
real model?" flips exactly here: above the seam nobody knows or cares; below it,
a hit short-circuits before the network.

## How it works

### Move 1 — the mental model

You know HTTP caching: a `Cache-Control` header lets the browser skip the server
when the response hasn't changed, keyed by URL. An LLM cache is that, but the key
is the *prompt* (or something close to it) and the freshness rule is *you decide*
— the model output for a fixed prompt doesn't expire on its own.

```
  The cache as a decorator over the provider

  request ──► ┌──────────────┐  key=hash(prompt)   ┌─────────────┐
              │   CACHE       │ ──── lookup ──────► │  store      │
              │  (ModelProv.) │ ◄─── hit/miss ───── │ key→resp    │
              └──────┬────────┘                     └─────────────┘
                     │ miss only
                     ▼
              ┌─────────────┐
              │  real model │   ← the only path that costs tokens
              └─────────────┘
   hit: nanoseconds, $0   ·   miss: full call, then store for next time
```

### Move 2 — the three layers, and aptkit's nearest thing

There isn't one LLM cache — there are three, layered by how *loosely* they match.

**Exact-match cache — same prompt, byte-for-byte.** Key = hash of the full
request. Trivial, zero false hits, useless the moment a word changes. This is
*exactly* what aptkit's fixture replay is. `FixtureModelProvider` holds an array
of recorded `ModelResponse` and hands them back in order, never calling the model
— `packages/agents/query/src/fixture-provider.ts:11`:

```ts
async complete(request: ModelRequest): Promise<ModelResponse> {
  this.requests.push(request);              // record what was asked (for assertions)
  const response = this.responses[this.index];  // the recorded answer
  this.index += 1;                          // advance — replay is positional
  if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
  return response;                          // never touches Ollama / the network
}
```

It's keyed by *position*, not prompt-hash, so it's a cache for a *known script*
(a test run), not arbitrary traffic. The recorded answers live as promoted
fixtures — e.g.
`packages/agents/query/fixtures/promoted/revenue-by-state-query-fixture-promoted-2026-06-18-19-29-11.json`
— recorded model responses keyed to a specific input. Same idea as an exact
cache: store the response, replay it, skip the model. Different goal:
determinism for tests, not dollars in production.

**Semantic cache — *similar* prompt.** Key = embedding of the prompt; a hit is
any stored prompt within a cosine-distance threshold. "What's our revenue?" and
"How much did we make?" hit the same entry.

```
  Semantic cache — embed the prompt, match by distance

  "how much did we make?" ─► embed ─► [0.21, -0.08, ...] ─┐
                                                          ▼
                                        nearest stored vector?
                                        ┌────────────────────────┐
                                        │ "what's our revenue?"  │ dist 0.04 ◄ HIT
                                        │ "list customers"       │ dist 0.71
                                        └────────────────────────┘
   threshold gate: dist < 0.1 → return stored answer; else miss
```

aptkit has the *parts* — it already embeds text for RAG
(`packages/agents/rag-query`) — but wires zero of it into a response cache.
`not yet exercised`.

**Prompt cache — reuse the *prefix*.** Cloud-provider feature: the model caches
the KV-state of a long, stable prefix (a big system prompt, a fixed document) so
re-sending it is cheap. You don't build it; you opt into it on the API call.
Gemma-local has no such lever, so this is the one aptkit would reach for *if it
went cloud through Anthropic* — Anthropic prompt caching is the exact mechanism.
`not yet exercised` in aptkit today.

### Move 3 — the principle

A cache is a decorator over the model interface, and you pick the layer by how
much *false-hit risk* you can tolerate against how much you save. aptkit owns the
strictest layer (exact-match, as fixture replay) because its goal is
determinism, where a false hit is a corrupt test. It skipped the rest because
local Gemma makes the dollar savings zero. When the model goes cloud, the
decorator slots in at `complete()` without a single agent changing.

## Primary diagram

```
  The three cache layers, by match looseness — and what aptkit owns

  loosest │  PROMPT CACHE      reuse prefix KV-state   │ cloud feature, opt-in
          │  (Anthropic etc.)                          │ ← would use if cloud
          │                                            │
          │  SEMANTIC CACHE    embed + distance match  │ parts exist (RAG),
          │  ("same meaning")                          │   not wired → GAP
          │                                            │
  tightest│  EXACT CACHE       hash(prompt) == hash     │ FixtureModelProvider
          │  ("same bytes")                            │   = this shape, for TESTS
          └────────────────────────────────────────────┘
   aptkit production response cache: NONE — local Gemma is free, latency only
```

## Elaborate

The reason aptkit can skip caching without guilt is the same reason it's
local-first: when the model is free and on `localhost`, the economics that
justify a cache evaporate. A cache trades memory + staleness risk for saved
tokens; if tokens cost nothing, you've only bought staleness risk. The moment a
cloud provider enters the fallback chain (`packages/providers/fallback`), that
math flips and a cache earns its keep — and it slots in as one more
`ModelProvider` decorator. Read `02-llm-cost-optimization.md` next; the usage
ledger is the instrument that would tell you whether a cache is paying off.

## Project exercises

### Build an exact-match cache decorator over ModelProvider
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a `CachingModelProvider implements ModelProvider` that wraps
  another provider, keys a `Map` on `JSON.stringify(request)` (minus `signal`),
  returns the stored `ModelResponse` on a hit, and calls the inner provider +
  stores on a miss.
- **Why it earns its place:** proves you see a cache as a decorator over the
  `complete()` seam, not a feature bolted into an agent — the senior framing.
- **Files to touch:** new `packages/providers/cache/src/caching-provider.ts`,
  reusing `ModelProvider`/`ModelRequest`/`ModelResponse` from
  `packages/runtime/src/model-provider.ts`.
- **Done when:** a test issues the same request twice through the decorator and
  asserts the inner provider's `complete` ran exactly once.
- **Estimated effort:** `1–4hr`

### (Case B) Sketch a semantic cache using the existing embedder
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a design note + skeleton that embeds the incoming prompt,
  nearest-neighbor matches against stored prompt vectors, and returns the stored
  answer when cosine distance is under a threshold; reuse the embedding path from
  `packages/agents/rag-query`.
- **Why it earns its place:** semantic caching is the layer interviewers probe;
  building the skeleton forces the threshold/false-hit tradeoff conversation.
- **Files to touch:** new `packages/providers/cache/src/semantic-cache.ts`
  (skeleton), reference `packages/agents/rag-query/src/rag-query-agent.ts`.
- **Done when:** a written note states the threshold, the false-hit failure mode,
  and why a wrong hit is worse here than in an exact cache.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "aptkit has no LLM cache — is that a gap?"**
It's a deliberate non-build. The default model is local Gemma, so a cache hit
saves latency but $0 — the economics that justify a cache aren't there. The slot
exists: a cache is a `ModelProvider` decorator at the `complete()` seam, and it
drops in the day a paid cloud provider joins the fallback chain.

```
  local Gemma:  cache saves [latency] but $0  → skip, honestly
  cloud model:  cache saves [latency + $$$]   → decorator at complete()
```
Anchor: *no tokens cost, no cache earned — the seam is ready when that flips.*

**Q: "What's the nearest thing aptkit has to a cache?"**
`FixtureModelProvider`. It replays recorded `ModelResponse`s so tests never call
the model — an exact-match cache keyed by position instead of prompt-hash. The
promoted fixtures are recorded answers stored to skip the model. Same shape,
different goal: determinism, not dollars.

```
  fixture replay:  recorded resp ─► return, skip model   (keyed by position)
  exact cache:     hash(prompt) ──► return, skip model   (keyed by prompt)
   same shape · fixtures optimize tests, a cache optimizes prod
```
Anchor: *`fixture-provider.ts:11` — replay is an exact cache wearing a test hat.*

## See also

- `02-llm-cost-optimization.md` — the ledger that tells you if a cache pays off
- `05-retry-circuit-breaker.md` — the other decorators over `complete()`
- `01-llm-foundations/01-what-an-llm-is.md` — the `complete()` seam a cache wraps
