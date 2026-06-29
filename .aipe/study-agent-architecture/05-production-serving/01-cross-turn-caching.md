# Cross-Turn Caching

**Industry term:** cross-turn / cross-run caching (prefix cache, intra-run memoization, semantic cache). *Industry standard.*

## Zoom out, then zoom in

Single-call caching keys on one request. An agent runs many turns per task, and many tasks repeat sub-steps — so the caching unit shifts from "one request" to "the loop" and "across runs." aptkit does none of this yet.

```
  Zoom out — not built; the loop re-pays for repeated sub-steps

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  runAgentLoop: every turn = a fresh model.complete call      │ ← we are here
  │  no prefix cache, no intra-run memo, no cross-run cache       │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet exercised in aptkit.** Each turn re-sends the full system prompt and history to `model.complete`; nothing caches the stable prefix, memoizes a repeated tool call within a run, or reuses a semantically-similar sub-result across runs. This file teaches the three layers and names where each would plug in.

## How it works

**Use case it would fit:** the rag-query agent re-deriving the same retrieval within a run, or two runs retrieving the same "running goals" passages. Both pay full cost today.

### Move 1 — the two cache scopes

```
  Single-call cache:  request → hash → hit? return : call

  Cross-turn cache (the agent version):
  ┌───────────────────────────────────────────────┐
  │  Agent run (task A)                            │
  │   turn 1: retrieve "auth flow"  ──┐            │
  │   turn 3: retrieve "auth flow" ◄──┘ cached     │  intra-run
  │           (same sub-step, cache hit) in the run│
  └───────────────────────────────────────────────┘
  ┌───────────────────────────────────────────────┐
  │  Agent run (task B, later)                     │
  │   turn 1: retrieve "auth flow" ◄── semantic    │  cross-run
  │           cache across runs                    │
  └───────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Layer 1: prompt-prefix caching (provider-side).** The system prompt and tool definitions are stable across every turn — keep them at the front so the provider caches the prefix and only re-processes the growing tail. aptkit's loop *already keeps the system prompt stable* (`run-agent-loop.ts:103` sends the same `system` each turn except the forced-final turn), so the structure is prefix-cache-friendly — but aptkit doesn't *request* provider prefix caching (Anthropic's cache-control, etc.), and Gemma local has no such feature. The bridge: this is the same instinct as keeping the stable part of a request stable so an HTTP cache can reuse it. **Not yet exercised.**

**Layer 2: intra-run memoization.** Within one task the agent may re-derive the same sub-result — call `search_knowledge_base` with the same query twice. Cache it by tool call + args. aptkit doesn't; a repeated identical search re-runs the embed + cosine scan. Cheap-ish locally, but pure waste. **Not yet exercised.**

**Layer 3: cross-run semantic cache.** A later task's sub-step is semantically close to an earlier one — embed the sub-query, return the cached result if close enough. aptkit has the embedder to do this but no cache keyed on it. **Not yet exercised.**

**The tradeoff that's sharper for agents.** A stale cross-run cache hit poisons the *whole trajectory*, not one response — the agent reasons forward on a stale sub-result and every downstream turn inherits the error. So: gate the semantic cache on freshness (don't cache retrieval whose underlying data can change mid-task), and never cache a tool call with side effects. aptkit's tools are read-only, which makes them cache-safe in principle — the freshness of the indexed corpus is the only gate to worry about.

### Move 3 — the principle

Caching for agents has three layers — provider prefix cache (cheapest), intra-run memoization, cross-run semantic cache (most useful) — and the agent-specific danger is that a stale hit poisons the entire trajectory, not one answer. aptkit keeps its prompt prefix stable (cache-friendly) but requests no caching; reach for prefix caching first, and gate any semantic cache on data freshness.

## Primary diagram

```
  Three cache layers — none exercised in aptkit

  prefix cache (provider)   stable system prompt at front → reuse across turns
                            aptkit: prompt IS stable, but caching not requested ✗
  intra-run memo            same tool+args within a run → reuse
                            aptkit: repeated search re-runs ✗
  cross-run semantic        similar sub-query across runs → reuse (gate on freshness)
                            aptkit: embedder exists, no cache keyed on it ✗

  danger: a stale hit poisons the WHOLE trajectory, not one response
```

## Elaborate

Cross-turn caching is where agent serving diverges hardest from single-call serving: a single call caches one response, but an agent's repeated sub-steps and an agentic system's repeated tasks mean the savings (and the risks) compound. Prefix caching is the easy win most teams take first — the system prompt and tool schemas are large and stable, so caching them cuts per-turn cost substantially on long loops. The semantic cache is the powerful-but-dangerous one, because a stale hit doesn't just give one wrong answer, it sends the agent reasoning down a wrong path. aptkit's read-only tools and stable prompt make it well-positioned to adopt prefix and intra-run caching cheaply; it just hasn't.

## Interview defense

**Q: Does aptkit cache anything across an agent run?**

No — every turn re-sends the full prompt and re-runs any repeated tool call. The cheapest win available is prefix caching: aptkit already keeps the system prompt stable across turns, so it's cache-friendly, it just doesn't request provider-side caching. The one to be careful with is a cross-run semantic cache — a stale hit poisons the whole trajectory, not one response, so it'd need a freshness gate. aptkit's read-only tools make caching safe in principle.

```
  prefix (easy, stable prompt ready) → intra-run memo → semantic (gate on freshness)
  agent danger: stale hit poisons the trajectory, not one answer
```

*Anchor: prefix caching first; a semantic cache poisons the whole trajectory if it goes stale.*

## See also

- [../01-reasoning-patterns/02-agent-loop-skeleton.md](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the per-turn calls a prefix cache would cut.
- Single-call caching and cost mechanics: `.aipe/study-ai-engineering/06-production-serving/`.
