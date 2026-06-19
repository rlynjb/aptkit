# 02 — Fan-out backpressure

## Subtitle

Capping how much work a loop runs in parallel, and pushing back upward when the queue grows — and why AptKit, being single-agent and sequential, never fans out at all.

---

## Zoom out

You know this one from the frontend: `Promise.all` over 500 items opens 500 sockets and the tab falls over, so you cap concurrency — run N at a time, queue the rest. The single-call version (rate limits, request-level concurrency caps) is in `.aipe/study-ai-engineering/06-production-serving/`. This file is about what that becomes when the *agent loop* is the thing producing parallel work.

The loop fans out in two ways. A single model turn can return *multiple* tool_use blocks — "call search AND fetch AND lookup" — so even one turn can want concurrency. And in a *multi-agent* system, an orchestrator spawns N sub-agents at once. Both are fan-out. Both need a ceiling, or you overload the tools, the provider, or yourself.

```
Fan-out, two sources
┌───────────────────────────────────────────────────────────────┐
│  INTRA-TURN          one model turn → [tool A][tool B][tool C]  │
│  fan-out             could run A,B,C concurrently               │
│                                                                 │
│  MULTI-AGENT         orchestrator → [agent 1][agent 2]...[N]    │
│  fan-out             spawns N workers concurrently              │
└───────────────────────────────────────────────────────────────┘
              both want a CONCURRENCY CAP + BACKPRESSURE
```

AptKit does **neither**. It is single-agent, so there is no multi-agent fan-out. And even intra-turn, when a model turn returns multiple tool_use blocks, they execute one after another in a plain `for` loop — no concurrency, so no need for a cap. This file teaches the pattern in full, then marks the boundary precisely.

---

## Structure pass

The pattern has two halves: the **semaphore** (cap how many run at once) and the **backpressure signal** (when the queue backs up, push the pressure *upward* so the producer slows down). The seam between them is the queue.

```
The two halves and the seam
producer ──enqueue──▶  [ work queue ]  ──dequeue──▶  worker pool
   ▲                        │                          (size N = cap)
   │                        │ queue depth grows?
   └──── BACKPRESSURE ◀──────┘  signal: "slow down / block enqueue"
        (the seam: queue depth is the signal)
```

The semaphore alone protects the workers. Backpressure alone is the *feedback* that protects the producer from outrunning the workers. You need both: a cap with no backpressure just relocates the unbounded growth into the queue itself.

---

## How it works

**Move 1 — mental model.** A semaphore is N permits. Take a permit to start work, return it when done. If no permit is free, you *wait* — and that waiting, propagated upward, *is* backpressure.

```
PATTERN: permits gate the workers, waiting becomes the signal
        permits: ● ● ●   (cap N = 3)
   task ─▶ take ● ─▶ run ─▶ return ●
   task ─▶ take ● ─▶ run ─▶ return ●
   task ─▶ take ● ─▶ run ─▶ return ●
   task ─▶ (no permit) ─▶ WAIT  ◀── this wait is backpressure
```

The wait is not a bug; it's the mechanism. The producer that's `await`ing a permit is, by definition, not producing more — pressure has flowed upstream.

**Move 2 — step by step.**

*Half 1: the concurrency cap (semaphore).* Wrap each unit of work in acquire/release around the permit count.

```
Capped fan-out
N tasks → [acquire permit] → run (≤ cap in flight) → [release permit]
                 │
                 └─ if cap reached, acquire BLOCKS here
```

```
sem = Semaphore(cap = 3)
async function run_capped(tasks):
  await Promise.all(tasks.map(async t => {
     await sem.acquire()          # blocks when 3 are in flight
     try   { await do_work(t) }
     finally { sem.release() }
  }))
```

*Half 2: backpressure upward.* When the queue depth crosses a threshold, signal the producer to stop enqueuing — don't let the queue absorb the overload.

```
Backpressure on queue depth
producer ──▶ if queue.depth > highWater: AWAIT drain
                            │
             workers drain ─┘ ──▶ resume producer below lowWater
```

```
async function enqueue(item):
  if queue.depth >= highWater:
     await queue.drainedBelow(lowWater)   # producer blocks here
  queue.push(item)
```

**Move 3 — principle.** Bound the *in-flight* work, and make the bound *push back*, not buffer. A cap without backpressure converts unbounded concurrency into an unbounded queue — same failure, slower. The right design makes the producer feel the slowdown via `await`, so the whole pipeline self-throttles to the speed of the slowest stage. The unit you cap should be the unit that costs a scarce resource — a connection, a token bucket, a downstream rate limit.

---

## Primary diagram

What AptKit actually does with multiple tool calls: a sequential walk, no cap, no concurrency.

```
AptKit: intra-turn tool calls run SEQUENTIALLY
model turn returns: [tool A][tool B][tool C]
       │
       ▼  run-agent-loop.ts:139  for (const toolUse of toolUses)
   ┌─────────┐   ┌─────────┐   ┌─────────┐
   │ await A │ → │ await B │ → │ await C │     one at a time
   └─────────┘   └─────────┘   └─────────┘
       │
       ▼  NOT Promise.all → no concurrency → no semaphore needed
   total tool spend across the run bounded ONLY by maxToolCalls
```

There is no fan-out to back-pressure. The only ceiling is a *count* of tool calls per run, applied in the turn loop, not a concurrency limit.

---

## Implementation in codebase

**Use cases.** None. AptKit is single-agent and runs tools sequentially.

**Sequential tool execution — the key fact.** A single model turn *can* return multiple `tool_use` blocks, and AptKit walks them in a plain `for` loop, awaiting each:

```ts
// run-agent-loop.ts:131 — collect every tool_use the turn returned
const toolUses = toolUsesFromContent(response.content);
...
// run-agent-loop.ts:139 — SEQUENTIAL for-loop, NOT Promise.all
for (const toolUse of toolUses) {
  ...
  // run-agent-loop.ts:159 — awaited one at a time
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  ...
}
```

Because each `await` completes before the next iteration starts, **at most one tool runs at a time** — even within a single turn. There is no concurrency, so there is no semaphore and no backpressure to build.

**The only budget: `maxToolCalls`.** Total tool spend per run is capped by a count, checked at the top of each turn:

```ts
// run-agent-loop.ts:101 — budget check (a COUNT, not a concurrency cap)
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;
```

The values, per agent: `6` for monitoring (`monitoring-agent.ts:77`), diagnostic (`diagnostic-agent.ts:74`), and query (`query-agent.ts:95`); `4` for recommendation (`recommendation-agent.ts:87`); `3` for rubric (`rubric-improvement-agent.ts:76`). This is a *global spend ceiling* — it caps how many tools run total across the whole run, not how many run at once. It is a crude budget, not concurrency control.

**Provider fallback is sequential too.** The other place AptKit could parallelize — trying providers — also runs in order, one at a time:

```ts
// packages/providers/fallback/src/fallback-provider.ts:50 — sequential, not raced
for (let index = 0; index < this.providers.length; index += 1) {
  ...
  const response = await provider.complete(request);  // try, then fall through
}
```

So the whole system has no parallel dispatch anywhere — tools sequential, providers sequential.

**Not yet exercised:** AptKit never fans out, so it has no semaphore and no backpressure. *See SECTION F (`../06-orchestration-system-design-templates/`) and the multi-agent research-assistant template for where a concurrency cap and upward backpressure first become mandatory.*

---

## Elaborate

The reason this pattern is *absent* rather than *missing* is architectural: AptKit is one agent doing one investigation. Fan-out backpressure is a property of systems that spawn many concurrent workers — an orchestrator over sub-agents, or a turn that genuinely races independent tool calls. AptKit has neither shape.

There is a real, if minor, latency cost to the sequential choice: if a turn returns three independent read-only tool calls, AptKit pays the sum of their latencies, not the max. `Promise.all` would cut that to the slowest single call. The reason not to is honesty about scope — with `maxToolCalls` at 3-6, the absolute number of calls is tiny, the tools are fast read-only reads, and concurrency would buy little while adding a semaphore, an error-aggregation story, and a cancellation story. The tradeoff is defensible *given the budget*.

Where it stops being defensible is the moment fan-out appears. The instant an orchestrator spawns N sub-agents — each itself a multi-turn loop with its own tool budget — unbounded concurrency multiplies provider load by N and the absence of backpressure lets a slow sub-agent's work pile up. That is exactly the boundary SECTION F's research-assistant template crosses, and exactly where you would introduce the semaphore taught above.

---

## Interview defense

**Q: "A model turn can ask for three tools at once. Do you run them in parallel?"**

```
What AptKit does with [tool A][tool B][tool C]
   for (const t of toolUses) { await callTool(t) }   ← sequential
        │
        ├─ pro: trivial errors, trivial cancellation, no semaphore
        └─ con: latency = sum(A,B,C), not max(A,B,C)
   bound on TOTAL calls = maxToolCalls (count, not concurrency)
```

Answer: "No — sequential `for`-loop at `run-agent-loop.ts:139`. With a 3-6 call budget on fast read-only tools, concurrency buys little and costs a semaphore + aggregation + cancellation story. The day we fan out to sub-agents, that math flips and a concurrency cap with upward backpressure becomes mandatory." Anchor: `run-agent-loop.ts:139`, budget at `:101`.

**Q: "What's the difference between your `maxToolCalls` and a concurrency cap?"** `maxToolCalls` bounds *total* calls across the run (a budget); a concurrency cap bounds *simultaneous* calls (a rate). AptKit has the former (`:101`), not the latter.

---

## Validate

- **L1 (recognize):** Name the two halves of the pattern and the seam between them. → "Structure pass" diagram.
- **L2 (trace):** Show that multiple tool_use blocks in one turn run one-at-a-time. → `run-agent-loop.ts:131`, `:139`, `:159`.
- **L3 (judge):** Explain why `maxToolCalls` is a budget and not concurrency control. → `run-agent-loop.ts:101`; per-agent values `diagnostic-agent.ts:74` etc.
- **L4 (extend):** Say where a semaphore + backpressure first becomes mandatory and why. → `../06-orchestration-system-design-templates/`, `../03-multi-agent-orchestration/04-parallel-fan-out.md`.

---

## See also

- `.aipe/study-ai-engineering/06-production-serving/` — request-level rate limits and concurrency. Read for per-call mechanics.
- `01-cross-turn-caching.md` — the prior loop pressure.
- `03-per-tool-circuit-breaking.md` — the next loop pressure.
- `../03-multi-agent-orchestration/04-parallel-fan-out.md` — where fan-out appears.
- `../03-multi-agent-orchestration/09-coordination-failure-modes.md` — what goes wrong without backpressure.
- `../06-orchestration-system-design-templates/` — SECTION F multi-agent research assistant.
- `../agent-patterns-in-this-codebase.md`
