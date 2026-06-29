# Parallel / Fan-out-Fan-in

**Industry standard.** "Fan-out/fan-in," "parallel agents," "map-reduce over agents." Type label: orchestration topology. **In this codebase: not yet exercised.** aptkit runs no concurrent agents. Its agents are independent *capabilities* but they're never spawned in parallel against one task.

## Zoom out, then zoom in

Independent subtasks run simultaneously; a merger combines them. The win is latency — three agents in parallel cost the time of the slowest, not the sum. aptkit doesn't fan out today, but its independent capabilities are the natural fan-out workers if a task ever splits into parallel pieces.

```
  Zoom out — fan-out (the shape, not in aptkit)

           ┌──────── split ────────┐
           ▼          ▼            ▼
       agent 1     agent 2      agent 3      (concurrent)
           └──────────┼───────────┘
                      ▼
                 merge agent
```

## Structure pass

**Axis: dependency.** Fan-out requires *independent* subtasks — no subtask needs another's output. That's the exact opposite of the pipeline (previous file), where each stage depends on the last. The seam: the split point (one task → N independent subtasks) and the merge point (N results → one answer). If the subtasks aren't independent, it's a pipeline, not a fan-out.

## How it works

### Move 1 — the mental model

`Promise.all()` over independent requests, then a reduce. You've written this: fire N independent fetches concurrently, await them all, combine. Fan-out is that, where each request is an agent loop.

```
  Fan-out/fan-in = Promise.all() over agents, then merge

  task → split → [agent1, agent2, agent3]  (run concurrently)
                       │
              await all (cost = slowest)
                       │
                       ▼
                 merge → answer
```

### Move 2 — what it would take in aptkit

**The constraint check first.** Fan-out only applies if subtasks are genuinely independent. aptkit's analytics pipeline is *dependent* (monitor → diagnose → recommend), so it can't fan out. But a different task *could*: a research question that needs facts from three independent sources fans out — three retrieval agents, no inter-dependency.

**The aptkit-fit version.** The rag-query agent is the natural fan-out worker. To answer "compare X, Y, and Z" you could spawn three rag-query agents, each searching for one term, concurrently, then a merge agent synthesizes. Each worker is the existing single-agent loop; the only new code is the split, the `Promise.all`, and the merge.

```
  Fan-out refactor in aptkit (would-be)

  "compare X, Y, Z"
       │ split into independent sub-questions
       ▼
  Promise.all([
    ragQuery.answer("about X"),   ← existing agent, unchanged
    ragQuery.answer("about Y"),
    ragQuery.answer("about Z"),
  ])
       │ await all (latency = slowest, not sum)
       ▼
  merge agent synthesizes → cited comparison
```

**The backpressure caveat (forward-ref to SECTION E).** Naive `Promise.all` over 12 workers fires 12 concurrent model calls and can blow past the provider's rate limit. The production version caps concurrency with a semaphore — covered in `05-production-serving/02-fan-out-backpressure.md`. aptkit has no fan-out, so it has no concurrency limiter yet; it'd be needed the moment you fanned out.

### Move 3 — the principle

Fan-out trades coordination complexity for latency: parallel agents cost the slowest, not the sum. The hard constraint is genuine independence — the moment one subtask needs another's output, it collapses to a pipeline. aptkit's capabilities are independent enough to *be* fan-out workers, but its actual task (analytics) is dependent, so it's a pipeline shape, not a fan-out.

## Primary diagram

```
  Fan-out/fan-in over aptkit's rag-query (would-be)

  ┌─ Orchestrator ──────────────────────────────────────────┐
  │  split: "compare X,Y,Z" → 3 independent sub-questions    │
  └───────┬───────────────┬───────────────┬──────────────────┘
          ▼               ▼               ▼
    ragQuery(X)      ragQuery(Y)      ragQuery(Z)   (concurrent
    [existing agent]                                 + concurrency cap)
          └───────────────┼───────────────┘
                          ▼ await all (latency = slowest)
                 ┌─────────────────┐
                 │  merge agent     │ synthesize → cited comparison
                 └─────────────────┘
```

## Elaborate

Fan-out is the latency optimization of multi-agent: when subtasks are independent, run them at once. The classic use is the research assistant — one question, N sources, parallel retrieval, synthesize (SECTION F template 1). The trap teams hit is fanning out *dependent* work, which produces wrong results because a worker acts on missing upstream output. aptkit avoids the trap by not fanning out at all; its dependent analytics task is correctly a pipeline.

## Interview defense

**Q: Could aptkit fan out?**
For an independent task, yes — the rag-query agent is a ready fan-out worker. "Compare X, Y, Z" splits into three independent searches I'd run with `Promise.all`, then a merge agent synthesizes; latency becomes the slowest, not the sum. But my analytics task is *dependent* — monitor → diagnose → recommend — so it's correctly a pipeline, not a fan-out. Fan-out needs genuine independence or it produces wrong results.

```
  independent subtasks → fan-out (Promise.all + cap)
  dependent subtasks   → pipeline (sequential)
```
*Anchor: the dependency check decides fan-out vs pipeline. Mine's dependent.*

**Q: What breaks fan-out at scale?**
Unbounded concurrency. Naive `Promise.all` over 12 workers fires 12 model calls at once and trips the rate limit. The fix is a concurrency cap (semaphore) — which I'd need to add, since aptkit has no fan-out today.

## See also

- `03-sequential-pipeline.md` — the dependent contrast (aptkit's actual shape)
- `05-production-serving/02-fan-out-backpressure.md` — the concurrency cap fan-out needs
- `06-orchestration-system-design-templates/01-multi-agent-research-assistant.md` — fan-out as an interview answer
