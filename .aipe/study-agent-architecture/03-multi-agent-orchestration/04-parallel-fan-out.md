# Parallel / Fan-Out-Fan-In

**Industry term:** parallel fan-out / fan-in (scatter-gather over agents). *Industry standard.*

## Zoom out, then zoom in

Independent subtasks run simultaneously; a merger combines them. aptkit does not do this — no agent spawns concurrent worker agents. But you know the primitive cold: it's `Promise.all()` over independent requests, then a reduce.

```
  Zoom out — not built; the primitive is one you ship daily

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  no agent fans out concurrent workers                        │ ← we are here
  │  (within one agent, tool calls run sequentially per turn)    │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet implemented in aptkit.** `runAgentLoop` executes tool calls sequentially within a turn (`for (const toolUse of toolUses)`, `run-agent-loop.ts:139`). There's no concurrent fan-out of *agents*. The fan-out shape would sit above the loop, where a supervisor splits work.

## How it works

**Use case it would fit:** the research assistant — three workers each retrieve from a different source at the same time, then a merge agent synthesizes. The wins is latency: three concurrent agents cost the time of the slowest, not the sum.

### Move 1 — the topology

It's `Promise.all([a(), b(), c()])` over independent agent runs, then a merge. The shape is identical to fetching three independent endpoints concurrently and combining the responses.

```
           ┌──────── split ────────┐
           ▼          ▼            ▼
      ┌────────┐ ┌────────┐  ┌────────┐
      │agent 1 │ │agent 2 │  │agent 3 │   (concurrent)
      └────┬───┘ └────┬───┘  └────┬───┘
           └──────────┼───────────┘
                      ▼
              ┌──────────────┐
              │ merge agent  │  synthesizes
              └──────────────┘
```

### Move 2 — the walkthrough

**The constraint that makes it possible: genuine independence.** Each subtask must not need another's output. If they're dependent, it's a pipeline ([03-sequential-pipeline.md](03-sequential-pipeline.md)), not a fan-out. The monitor → diagnose → recommend flow is a *pipeline* precisely because each stage needs the prior one's output — it can't fan out.

**Where aptkit's sequential tool loop differs.** Inside one turn, if the model emits three `tool_use` blocks, aptkit runs them one at a time:

```ts
// run-agent-loop.ts:139 — tool calls within a turn run sequentially
for (const toolUse of toolUses) {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  // ...
}
```

That's a deliberate, debuggable choice for a single agent. A fan-out topology would parallelize at the *agent* level (above the loop), not the tool level — and would need a concurrency cap so a supervisor can't spawn 12 workers and hit the provider's rate limit (see [../05-production-serving/02-fan-out-backpressure.md](../05-production-serving/02-fan-out-backpressure.md)).

**What it would cost aptkit.** A scatter step (`Promise.all` over worker `runAgentLoop` calls with a semaphore cap), a merge agent, and the independence guarantee enforced by how the supervisor decomposes. **Not yet implemented.**

### Move 3 — the principle

Fan-out buys latency — N concurrent agents cost the slowest, not the sum — but only when the subtasks are genuinely independent. The moment one needs another's output, it's a pipeline. That independence test is the whole design decision.

## Primary diagram

```
  Fan-out/fan-in as aptkit would build it

  supervisor decomposes into INDEPENDENT subtasks
        │ Promise.all (with a concurrency cap — backpressure)
        ▼
  ┌────────┐ ┌────────┐ ┌────────┐
  │ worker │ │ worker │ │ worker │  each a runAgentLoop, concurrent
  └────┬───┘ └────┬───┘ └────┬───┘
       └──────────┼──────────┘
                  ▼
            merge agent → synthesized answer
  latency = slowest worker (not the sum)
  (Not yet implemented; today aptkit runs tools sequentially within a turn)
```

## Elaborate

Fan-out/fan-in is the latency play of multi-agent design — it's how a research assistant queries five sources without paying five sequential round-trips. The catch teams hit is the rate limit: a supervisor that fans out faster than the provider allows trades sequential latency for a storm of 429s. That's why fan-out and backpressure are inseparable in production (the concurrency-cap pattern in SECTION E). aptkit runs tools sequentially today, which sidesteps the problem entirely — correct for a single debuggable agent, insufficient the moment you want parallel workers.

## Interview defense

**Q: Could the analytics agents run in parallel?**

No — they're a pipeline, not a fan-out, because each needs the prior stage's output (diagnosis needs the anomaly, recommendation needs the diagnosis). Fan-out requires genuine independence. A research-assistant shape *would* fan out — independent per-source retrievals concurrently, then merge — and that would need a concurrency cap to stay under the provider's rate limit.

```
  dependent stages  → pipeline (sequential, latency adds)
  independent tasks → fan-out (Promise.all + cap, latency = slowest)
```

*Anchor: the independence test decides pipeline vs fan-out; fan-out without a concurrency cap trades latency for 429s.*

## See also

- [03-sequential-pipeline.md](03-sequential-pipeline.md) — the dependent-stage cousin.
- [../05-production-serving/02-fan-out-backpressure.md](../05-production-serving/02-fan-out-backpressure.md) — the concurrency cap fan-out needs.
- [02-supervisor-worker.md](02-supervisor-worker.md) — the supervisor that does the decomposing.
