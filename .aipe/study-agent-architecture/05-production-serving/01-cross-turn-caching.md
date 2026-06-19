# 01 — Cross-turn caching

## Subtitle

Reusing work *across the turns of one run* and *across runs* — and why AptKit caches none of it in production, but has a cache-of-record hiding in its test harness.

---

## Zoom out

You already cache single calls. In the browser you keep the stable part of a request stable so the HTTP cache can reuse the response — same URL, same headers, cache hit, no network. The single-call version of LLM caching (prompt caching, response caching, semantic cache) lives in `.aipe/study-ai-engineering/06-production-serving/`. Go there for the per-call mechanics. This file is about what happens when the call is wrapped in a *loop*.

Here is what the loop adds. The agent calls the model eight times in one run, and across many runs over days. The same expensive text — the system prompt, the tool schemas, a sub-result the model already derived — keeps getting re-sent or re-derived. Caching across the loop means *not paying twice for the same stable input*.

```
Three layers where a loop can reuse work
┌──────────────────────────────────────────────────────────────┐
│  PREFIX        the system prompt + tool schemas are identical  │
│  (per turn)    every turn → cache the prefix, pay once         │
│                          │                                     │
│                          ▼ widen the window                    │
│  INTRA-RUN     the model derived sub-result X on turn 2 →      │
│  (per run)     don't recompute it on turn 5                    │
│                          │                                     │
│                          ▼ widen the window                    │
│  CROSS-RUN     run yesterday answered the same question →      │
│  (per system)  replay the recorded answer, skip the model      │
└──────────────────────────────────────────────────────────────┘
```

Each layer is a wider time window over which "I already have this" holds. AptKit implements *none* of the three for production serving. But the widest layer — cross-run — has a near-exact analog in the test harness, and that analog is worth studying.

---

## Structure pass

The pattern has three layers (above). The seam in each is the same: *what stays stable, and who notices it's stable.*

```
The seam: stable input → reuse boundary
┌─────────────┬─────────────────────────┬──────────────────────┐
│ layer       │ what's stable            │ reuse boundary        │
├─────────────┼─────────────────────────┼──────────────────────┤
│ prefix      │ system + tool schemas    │ provider prompt cache │
│ intra-run   │ a derived sub-result     │ in-context messages[] │
│ cross-run   │ the whole question→answer│ a record store / cache│
└─────────────┴─────────────────────────┴──────────────────────┘
```

In AptKit: the prefix *is* stable but is rebuilt and re-sent each turn (opportunity not taken). The intra-run sub-result lives in `messages[]` so the model can *see* it again, but it is never deduped or cached — it just rides along in context. The cross-run store exists only as test fixtures.

---

## How it works

**Move 1 — mental model.** A cache is a bet that a *stable key* maps to a *reusable value*. The loop gives you three candidate keys at three widths. Pick the width where the input is reliably identical and the value is reliably still correct.

```
PATTERN: key stability vs value freshness
                 narrow key                 wide key
                 (prefix)                    (cross-run question)
   stable?  ███████████████ very           ████░░░░░░░ depends
   fresh?   ███████████████ always         ░░░░░░████░ can go STALE
                 │                                │
                 ▼                                ▼
          cheap, safe, big win            cheap, but stale poisons
                                          the whole trajectory
```

The narrower the key, the safer the cache. Prefix caching is nearly free of staleness risk (the prompt didn't change). Cross-run caching is where you can poison a run by replaying an answer that is no longer true.

**Move 2 — step by step.**

*Layer 1: prefix cache.* The stable prefix is the same bytes every turn. Mark it cacheable; the provider charges full price the first turn and a fraction thereafter.

```
Prefix cache across turns of ONE run
turn 1:  [SYSTEM+TOOLS] [msgs] → model      ← full price on prefix
turn 2:  [SYSTEM+TOOLS] [msgs] → model      ← prefix = cache hit
turn 3:  [SYSTEM+TOOLS] [msgs] → model      ← prefix = cache hit
          └─ identical ─┘
```

```
build request:
  prefix = system + toolSchemas         # identical every turn
  mark prefix as cache-eligible
  send(prefix + growing messages[])
  # provider returns cache-read tokens cheaper than fresh
```

*Layer 2: intra-run memo.* If the model already computed something on an earlier turn, don't make it (or a tool) compute it again.

```
Intra-run reuse
turn 2: derive subResult X ──┐
                             ▼ stored in messages[] (in context)
turn 5: needs X ── reads it from context, OR re-derives (no memo)
```

```
on each turn:
  if needed_value in run_memo:        # AptKit has NO such memo
     reuse run_memo[needed_value]
  else:
     v = compute(); run_memo[key] = v
```

*Layer 3: cross-run cache-of-record.* Record a full run's model responses keyed by the run; on a matching future run, replay the records instead of calling the model.

```
Cross-run record / replay
record:  run → [model resp 1, resp 2, ...] → store as artifact
replay:  same run key → return stored resp[i] by index, model NEVER called
```

```
class RecordedProvider:
  responses[]            # captured from a prior real run
  i = 0
  complete(req):
    return responses[i++]   # deterministic, no network, no model
```

**Move 3 — principle.** Cache at the *widest window where the value is still guaranteed correct*. Stable input is necessary but not sufficient — the cached value must also still be *true*. A stale cross-run answer doesn't just return a wrong byte; it feeds turn N of a loop and every downstream turn reasons from a lie. And: never cache a side-effecting operation, because a cache hit silently skips the effect. The corollary is the lever — if your operations are *read-only*, the side-effect risk vanishes and the only remaining risk is staleness.

---

## Primary diagram

The full picture: three layers, what AptKit does at each, and where the one real analog lives.

```
Cross-turn caching in AptKit
┌─────────────────────────────────────────────────────────────────┐
│ PREFIX (per turn)                                                 │
│   system prompt rebuilt via renderPromptTemplate EACH turn,       │
│   re-sent as system arg → NO prefix cache. Opportunity skipped.   │
│                                                                   │
│ INTRA-RUN (per run)                                               │
│   messages[] accumulates every turn (run-agent-loop.ts:94).       │
│   A re-derived sub-result is IN CONTEXT but NOT memoized/deduped. │
│   Tool results truncated to 16_000 chars (run-agent-loop.ts:52).  │
│                                                                   │
│ CROSS-RUN (per system)                                            │
│   NO production cache. BUT: replay artifacts + FixtureModelProvider│
│   = cache-of-record FOR TESTS. Recorded run replayed without the  │
│   model. Closest analog — a test mechanism, not a serving cache.  │
└─────────────────────────────────────────────────────────────────┘
```

The only layer with a real implementation is the test analog at the bottom — and it is a test mechanism, not production serving.

---

## Implementation in codebase

**Use cases.** None in production. The relevant code is the loop's context accumulation, the truncation guard, and the replay/fixture harness.

**Intra-run context accumulation.** The run starts one `messages[]` array and pushes to it every turn — assistant content, then tool results — so anything derived earlier stays visible:

```ts
// run-agent-loop.ts:94 — one array, lives for the whole run
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
```
```ts
// run-agent-loop.ts:124 — each turn's output appended (stays in context)
messages.push({ role: 'assistant', content: response.content });
// run-agent-loop.ts:189 — tool results appended, visible to later turns
messages.push({ role: 'user', content: toolResults });
```

This is *reuse-by-context*, not caching: a sub-result derived on turn 2 is re-readable on turn 5 because it's in the array, but nothing dedupes or memoizes it — the model may simply re-derive it, paying again.

**Truncation, not caching.** Tool results are capped so context doesn't explode:

```ts
// run-agent-loop.ts:52
const MAX_TOOL_RESULT_CHARS = 16_000;
// run-agent-loop.ts:54-57 — slice + "[truncated]" marker
```

This bounds context *growth*; it does not reuse anything. Note it because people confuse "context hygiene" with "caching" — this is the former.

**Prefix opportunity, not taken.** Each agent rebuilds its system prompt every run via `renderPromptTemplate` (e.g. `diagnostic-agent.ts`, `monitoring-agent.ts`, `query-agent.ts`, `recommendation-agent.ts`) and passes it to `model.complete({ system, ... })` at `run-agent-loop.ts:103-104`. The prefix is stable but never marked cacheable — a prefix-cache win left on the table.

**Cross-run analog: the replay harness.** This is the closest thing to a cross-run cache, and it's honest record/replay for tests:

```ts
// packages/agents/diagnostic-investigation/src/fixture-provider.ts:11-17
async complete(request: ModelRequest): Promise<ModelResponse> {
  this.requests.push(request);
  const response = this.responses[this.index];
  this.index += 1;                       // serve recorded response by index
  if (!response) throw new Error(`fixture model exhausted ...`);
  return response;                       // model NEVER called
}
```

The recorded responses come from prior real runs, stored as artifacts under `artifacts/replays/*.json`. A `FixtureModelProvider` exists per agent (diagnostic, monitoring, query, recommendation, rubric). **Frame:** deterministic replay = a *cache-of-record for tests* — same shape as a cross-run cache (key → stored response, skip the model), but its purpose is reproducible eval, not production serving.

**Not yet exercised:** AptKit implements no prefix cache, no intra-run memo, and no production cross-run cache. *See SECTION F (`../06-orchestration-system-design-templates/`) for where a cross-run cache would land in a system that re-answers the same questions at scale.*

---

## Elaborate

Two things make caching unusually *safe* to add to AptKit later, and one thing makes it unusually *dangerous*.

Safe: AptKit's tools are **read-only**. The classic caching footgun — a cache hit that skips a write — cannot happen here. So if AptKit ever added a cross-run cache, the only risk left is staleness, not lost side effects. That's a much smaller risk surface than most apps face.

Dangerous: the loop *compounds* staleness. In a single fetch, a stale response is one wrong screen. In a loop, a stale cross-run answer feeds turn N, the model reasons from it, and every subsequent turn inherits the error. The blast radius is the whole trajectory, not one response. This is why cross-run caching of an *agent* needs a freshness key (data version, time bucket) far tighter than you'd use for a static asset.

And the prefix layer is the free lunch nobody ate: the system prompt is identical across all turns of a run and largely identical across runs of the same agent. Marking it cacheable is low-risk (no staleness — the prompt is code) and high-savings (it's the biggest stable chunk of every request).

---

## Interview defense

**Q: "You replay fixtures in tests — isn't that just a cache? Why not use it in production?"**

```
record/replay (tests)        vs        production cache
┌──────────────────────┐               ┌──────────────────────┐
│ key = the run, by    │               │ key = question +      │
│ index                │               │ data freshness        │
│ value = frozen on    │               │ value = must stay TRUE│
│ purpose (eval)       │               │ as data changes       │
│ staleness = the point│               │ staleness = the enemy │
└──────────────────────┘               └──────────────────────┘
```

They share the *mechanism* (skip the model, return a stored response) but invert the *intent*. Replay *wants* frozen answers — that's what makes the eval deterministic. A production cache must invalidate on data change or it poisons the loop. Anchor: `fixture-provider.ts:11-17` serves by index with no freshness check — correct for tests, wrong for serving.

**Q: "Where's the cheapest caching win you're not taking?"** Prefix caching the stable system prompt re-sent every turn — anchor `run-agent-loop.ts:103-104`, rebuilt per agent via `renderPromptTemplate`.

---

## Validate

- **L1 (recognize):** Name the three caching layers and their time windows. → "Zoom out" diagram.
- **L2 (trace):** Show where a turn-2 sub-result physically lives on turn 5 and why it's not a cache. → `run-agent-loop.ts:94`, `:124`, `:189`.
- **L3 (judge):** Explain why read-only tools make caching safer and why the loop makes staleness worse. → "Elaborate."
- **L4 (extend):** Distinguish the fixture replay from a production cache by key and intent. → `fixture-provider.ts:11-17`, `artifacts/replays/*.json`.

---

## See also

- `.aipe/study-ai-engineering/06-production-serving/` — single-call prompt/response/semantic caching. Read for the per-call mechanics.
- `02-fan-out-backpressure.md` — the next loop pressure.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the `messages[]` accumulation this file refers to.
- `../06-orchestration-system-design-templates/` — SECTION F, where a cross-run cache would land.
- `../agent-patterns-in-this-codebase.md`
