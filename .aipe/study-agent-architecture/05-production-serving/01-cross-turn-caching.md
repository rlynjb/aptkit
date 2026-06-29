# Cross-Turn Caching

**Industry standard.** "Prefix caching," "cross-turn cache," "semantic cache." Type label: serving optimization. **In this codebase: not yet exercised** — aptkit has no cross-turn or cross-run cache. Its system prompt is stable per agent (prefix-cache-ready), but no caching layer is wired, and the local Gemma default makes per-token cost effectively zero, so the pressure is mild.

## Zoom out, then zoom in

Single-call caching keys on one request. An agent runs many turns per task, and many tasks repeat sub-steps — so caching for agents has two new scopes: within a run (the agent re-derives the same sub-result) and across runs (a later task's sub-step matches an earlier one). aptkit caches neither yet.

```
  Zoom out — three cache layers (none wired in aptkit)

  ┌─ prefix cache (provider-side) ──────────────────────────┐
  │  stable system prompt + tool defs at the front          │ ← aptkit is READY
  │  (aptkit's system prompt is stable per agent)            │   (not exploited)
  └──────────────────────────────────────────────────────────┘
  ┌─ intra-run memoization ─────────────────────────────────┐
  │  same sub-step within one task → cache by tool+args      │ ← not exercised
  └──────────────────────────────────────────────────────────┘
  ┌─ cross-run semantic cache ──────────────────────────────┐
  │  later task's sub-query ≈ earlier one → embed + reuse    │ ← not exercised
  └──────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: cache scope and staleness risk.** A single-call cache keys one request. An agent cache spans turns and runs — and the staleness risk is sharper, because a stale hit poisons the *whole trajectory*, not one response. Trace it: the agent reasons forward on a stale sub-result, and every downstream turn inherits the error. The seam: single-call caching (one request, one staleness window) vs cross-turn caching (one hit corrupts a multi-turn chain).

## How it works

### Move 1 — the mental model

Three layers, cheapest to most useful. You know how an HTTP cache reuses a response keyed on the request, and how keeping a request's stable part stable lets a CDN cache it? Prefix caching is that for the token prefix; intra-run and cross-run caches are that for the agent's sub-steps.

```
  Cross-turn caching — three layers

  Single-call cache:  request → hash → hit? return : call

  Agent caches:
    prefix:    stable system prompt at front → provider caches the prefix
    intra-run: turn 3 repeats turn 1's tool call → cache by (tool, args)
    cross-run: task B's sub-query ≈ task A's → embed, reuse if close
```

### Move 2 — what aptkit has, and the three caches it could add

**Prefix-cache-ready, not exploited.** aptkit assembles the system prompt *once* in the agent constructor (`rag-query-agent.ts:52-58`) — it's stable across every turn of a run, and the tool definitions are stable too. That's exactly the shape provider prefix-caching rewards: keep the stable system prompt and tool definitions at the front so the prefix is cached across every turn. aptkit doesn't *exploit* this (no provider prefix-cache header is set), but the prompt is structured for it.

**Intra-run memoization — the would-be add.** Within one rag-query run, if the model searches "auth flow" on turn 1 and again on turn 3 (a real weak-model behavior), the second search re-embeds and re-scans the store. Memoizing by `(tool, args)` for the duration of the run would skip the second call. The hook exists — every tool call goes through `registry.callTool(name, args)` (`tool-registry.ts:50`), a clean place to wrap a per-run memo.

**Cross-run semantic cache — the would-be add.** A later question semantically close to an earlier one could reuse the earlier retrieval. aptkit already has the embedder — `OllamaEmbeddingProvider` — so it could embed the sub-query and return a cached result if close enough. Same infra as RAG.

**The staleness tradeoff, sharper for agents.** A stale cross-run cache hit poisons the *whole trajectory*: the agent reasons forward on a stale sub-result and every downstream turn inherits the error. So the rules are strict — gate the semantic cache on freshness (don't cache retrieval results whose underlying data can change mid-task), and never cache a tool call with side effects. aptkit's tools are read-only (no side-effect caching risk) but its corpus could change (so a semantic cache would need freshness gating). The reason aptkit hasn't built this: the local Gemma default makes per-call cost near-zero, so the cache wouldn't pay for its staleness risk yet.

### Move 3 — the principle

Prefix caching is the same instinct as keeping a request's stable part stable so an HTTP cache can reuse it — here it's the token prefix the provider caches. The agent-specific danger is that a stale hit corrupts a whole trajectory, not one response, so freshness gating matters more than for single calls. aptkit is prefix-cache-ready by construction (stable system prompt) but defers the actual caches because its local-model cost profile makes them not yet worth the staleness risk.

## Primary diagram

```
  Cross-turn caching for aptkit (would-be) — full frame

  ┌─ Run (task A) ──────────────────────────────────────────┐
  │  [stable system prompt + tool defs] ◄── PREFIX-cacheable │ (ready)
  │  turn 1: search "auth flow"  ──┐                         │
  │  turn 3: search "auth flow" ◄──┘ INTRA-RUN memo hit      │ (would add)
  └──────────────────────────────────────────────────────────┘
  ┌─ Run (task B, later) ─────────────────────────────────────┐
  │  turn 1: search ≈ task A's ◄── CROSS-RUN semantic hit     │ (would add,
  │          (embed sub-query, reuse if close + fresh)        │  freshness-gated)
  └─────────────────────────────────────────────────────────────┘
  staleness: a bad hit poisons the WHOLE trajectory, not one turn
```

## Elaborate

Caching for agents is where single-call intuitions break: the unit isn't a request, it's a multi-turn trajectory, and a cache hit's blast radius is the whole chain. Prefix caching is the free win (most providers cache a stable prefix automatically), which is why structuring the prompt with the stable part first matters. Intra-run and cross-run caches are real savings on a paid model but carry trajectory-poisoning risk. aptkit's local-first default inverts the usual calculus — with near-zero per-token cost, the caches don't pay for their risk, so deferring them is correct. The moment aptkit runs against a paid provider at volume, prefix caching is the first thing to turn on.

## Interview defense

**Q: How do you cache for an agent?**
Three layers, and I'll be honest that aptkit exploits none yet but is built for the first. Prefix caching — my system prompt and tool defs are assembled once and stable across every turn, which is exactly what provider prefix-caching rewards. Then intra-run memoization (cache a repeated tool call by args within a run) and a cross-run semantic cache (embed a sub-query, reuse a close earlier result). I haven't wired the last two because my local-model cost is near-zero, so they wouldn't pay for their staleness risk.

```
  prefix (ready) · intra-run memo (would add) · cross-run semantic (would add)
```
*Anchor: a stale agent-cache hit poisons the whole trajectory, not one response — freshness gating matters more here.*

**Q: What's the danger that's worse than for single calls?**
Blast radius. A stale hit isn't one bad response — the agent reasons forward on it and every downstream turn inherits the error. So I'd gate any semantic cache on freshness and never cache a side-effecting tool call.

## See also

- `02-agentic-retrieval/01-agentic-rag.md` — the loop these caches would serve
- `02-fan-out-backpressure.md` — the next serving concern
- `04-agent-infrastructure/01-context-engineering.md` — the stable prompt assembly
- `study-ai-engineering/06-production-serving/` — single-call caching mechanics (cross-ref)
