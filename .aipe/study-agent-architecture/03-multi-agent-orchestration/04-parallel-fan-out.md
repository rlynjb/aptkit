# 04 — Parallel Fan-Out

> Run independent subtasks at the same time, then merge. The performance
> topology. The hard precondition: the subtasks must be *independent*. Not
> exercised in AptKit — and the three pipeline stages explicitly *can't* fan out
> because they're dependent. But multiple anomalies could.

## Zoom out

Fan-out is the multi-agent answer to "these N things don't depend on each other,
so why am I doing them one at a time?" You dispatch N agents concurrently, wait
for all of them, then merge their results into one answer. It's pure latency
arithmetic: N independent tasks that each take `t` finish in `t`, not `N·t`. The
catch is the word *independent* — fan-out is only correct when no subtask needs
another subtask's output.

```
  Fan-out as layers

  ┌─ Dispatch layer ──────────────────────────────────────────────────┐
  │  split task into N INDEPENDENT subtasks                            │
  └────────────┬──────────────┬──────────────┬────────────────────────┘
               │              │              │  (all at once)
               ▼              ▼              ▼
  ┌─ Parallel worker layer ───────────────────────────────────────────┐
  │  agent 1        agent 2        agent 3   (each its own loop)        │
  └────────────┬──────────────┬──────────────┬────────────────────────┘
               │ r1           │ r2           │ r3
               └──────────────┴──────────────┘
                              ▼
  ┌─ Merge layer ─────────────────────────────────────────────────────┐
  │  combine r1, r2, r3 → one result (concat / rank / dedupe / reduce) │
  └────────────────────────────────────────────────────────────────────┘
```

The dispatch and merge layers are the new code. The worker layer is, again, the
single-agent loop.

## Structure pass

The axis is **independence**. A subtask either needs a sibling's output (then
you can't fan out — that's a pipeline) or it doesn't (then you can). The seam is
the merge: how you fold N results into one.

```
  The independence test along its axis

  INDEPENDENT (fan out)               DEPENDENT (must be a pipeline)
  ──────────────────────►             ◄──────────────────────────────
  • investigate anomaly A             • investigate NEEDS the anomaly
    while investigating anomaly B       from scan  → can't run before scan
  • summarize doc 1, doc 2, doc 3     • propose NEEDS the diagnosis
    in parallel                         from investigate → can't run before it

  ──► Promise.all + merge             ──► A → B → C (file 03)
```

If you can't answer "does subtask 2 need subtask 1's output?" with a clean *no*,
you do not have a fan-out. You have a pipeline wearing a fan-out costume, and
running it concurrently will feed stage 2 a missing or stale input.

## How it works

### Move 1 — the mental model

The mental model is **`Promise.all` over independent requests, then a merge** —
the exact frontend pattern for loading several unrelated resources at once.

```
  The Promise.all mental model (the topology IS this picture)

  const [a, b, c] = await Promise.all([
    runAgent(subtask1),
    runAgent(subtask2),
    runAgent(subtask3),
  ]);
  return merge(a, b, c);

        ┌── runAgent(1) ──┐
  split ┼── runAgent(2) ──┼─► Promise.all ─► merge ─► result
        └── runAgent(3) ──┘
   all three in flight at once; merge waits for the slowest
```

For a frontend reader: this is loading a dashboard's widgets concurrently.
`Promise.all([fetchSales(), fetchTraffic(), fetchInventory()])` — three
independent fetches, fire together, render when all resolve. You'd never chain
them with `.then` because none needs another's data; chaining would just make
the dashboard load 3x slower. Fan-out is that instinct applied to agents.

### Move 2 — step by step

**Step 1 — split into independent subtasks (and prove independence).**

```
  split: task ──► [subtask1, subtask2, subtask3]  (no edges between them)
```

```
split(task):
  subtasks = decompose(task)
  assert no subtask depends on another's output   # the precondition
  return subtasks
```

**Step 2 — dispatch concurrently.**

```
  dispatch: each subtask ──► its own agent loop, all in flight
  ┌─────────┐  ┌─────────┐  ┌─────────┐
  │ agent 1 │  │ agent 2 │  │ agent 3 │   (concurrent)
  └─────────┘  └─────────┘  └─────────┘
```

```
results = await Promise.all(
  subtasks.map(st => reactLoop(st.prompt, st.policy, st.budget))
)
```

**Step 3 — merge.**

```
  merge: results[] ──► one result
  (rank | dedupe | concatenate | reduce-with-an-LLM)
```

```
merge(results):
  return combine(results)    # domain-specific: rank top-N, dedupe, or LLM-reduce
```

### Move 3 — the principle

Fan-out buys latency at the cost of *concurrent* resource spend — N agents
means N times the tool calls and tokens in the same window, which can blow a
rate limit or a budget if you don't cap concurrency (backpressure). And the
merge is where correctness lives: N good results merged badly is a bad answer.
The principle: fan out only over *proven-independent* subtasks, cap the
concurrency, and treat the merge as a first-class step with its own validation —
not an afterthought `[].concat`.

## Primary diagram

Fan-out with the two controls (independence precondition, concurrency cap)
marked.

```
  Parallel fan-out with its two controls

           ┌─ independence precondition ★1 ─┐
  task ──► │ subtasks have NO edges between │
           └────────────────┬────────────────┘
                            ▼
        ┌──── concurrency cap ★2 (don't dispatch all 1000 at once) ────┐
        │   ┌─────────┐  ┌─────────┐  ┌─────────┐                       │
        │   │ agent 1 │  │ agent 2 │  │ agent 3 │   ... bounded pool     │
        │   └────┬────┘  └────┬────┘  └────┬────┘                       │
        └────────┼────────────┼────────────┼─────────────────────────────┘
                 │ r1         │ r2         │ r3
                 └────────────┴────────────┘
                              ▼
                   merge → validate → result
  ★1 wrong precondition → stale/missing inputs (it's really a pipeline)
  ★2 no cap → rate-limit / budget blowout (file 09: cost blowup)
```

## Implementation in this codebase

**Not yet exercised.** AptKit runs no agents concurrently — every replay is one
agent against one fixture, sequentially (`apps/studio/src/agent-runners.ts`).

Two important groundings on *where it would and wouldn't apply*:

1. **The three pipeline stages CANNOT fan out — they're dependent.**
   `investigate(anomaly: Anomaly)`
   (`packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:55`) needs
   the `Anomaly` that `scan()`
   (`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:57`) produces,
   and `propose(anomaly, diagnosis)`
   (`packages/agents/recommendation/src/recommendation-agent.ts:64`) needs the
   `Diagnosis` that `investigate` produces. The edges in this chain are real, so
   running them concurrently is a category error — it's a sequential pipeline
   (file 03), not a fan-out.

2. **Multiple anomalies COULD fan out.** `scan()` returns `Anomaly[]` (up to 10,
   `monitoring-agent.ts:86-88`). Each anomaly is independent of the others, so
   `investigate` could run over all of them concurrently:
   `Promise.all(anomalies.map(a => investigate(a)))`. *That's* a legitimate
   fan-out — the parallelism is across the *array*, not across the *stages*. The
   merge would be "collect all diagnoses," and you'd cap concurrency so 10
   anomalies don't fire 10 simultaneous tool storms.

The honest one-liner: fan-out isn't built, and it deliberately does not apply to
the pipeline stages (dependent); the one place it *would* fit — parallel
investigation of multiple anomalies — is a future enhancement, sketched in the
SECTION F templates (`../06-orchestration-system-design-templates/`).

## Elaborate

The most common fan-out mistake is fanning out the wrong axis. People look at
`scan → investigate → propose` and think "three stages, parallelize them!" — but
those stages are *dependent*, so concurrency breaks them. The independent axis
is the *data*: many anomalies, each investigated alone. Same agents, different
axis. Internalize the question "what is actually independent here?" — it's
almost never the pipeline stages and almost always the items flowing through
them.

The concurrency cap matters more than it looks. Fan-out over 10 anomalies with
no cap means 10 diagnostic loops, each up to 6 tool calls, firing at once — 60
concurrent analytics queries. That's a self-inflicted rate-limit incident. A
bounded worker pool (e.g. 3 at a time) keeps latency wins without the blowout;
this is the fan-out backpressure that `../05-production-serving/` would own.

## Interview defense

**Q: "Can you speed up the diagnostic pipeline by running the three agents in
parallel?"**

"No — those three are *dependent*, so they're a sequential pipeline, not a
fan-out. `investigate` needs `scan`'s anomaly, `propose` needs `investigate`'s
diagnosis. Parallelizing them would feed stage two a missing input. The right
axis to parallelize is the *data*: `scan` returns up to ten anomalies, and they're
independent of each other, so I'd fan out `investigate` across the array with
`Promise.all` — capped to a small concurrency so I don't fire ten tool storms at
once — then merge the diagnoses. Same agents, parallel over items, not over
stages."

```
  The one-line defense
  stages are dependent (pipeline) ; the anomaly ARRAY is independent (fan-out)
```

Anchor: `monitoring-agent.ts:57` (`Anomaly[]` — the independent axis),
`diagnostic-agent.ts:55` + `recommendation-agent.ts:64` (the dependent edges
that forbid stage-level fan-out).

## Validate your understanding

1. **Spot the independent axis.** Read `monitoring-agent.ts:86-88` — `scan()`
   returns an array of up to 10 anomalies. Confirm the *array elements* are
   independent (one anomaly's investigation needs nothing from another's).

2. **Spot the dependent edges.** Read `diagnostic-agent.ts:55` and
   `recommendation-agent.ts:64`. Confirm each consumes the prior stage's output,
   so the *stages* are not independent.

3. **Predict the bug.** What happens if you `Promise.all([scan, investigate,
   propose])`? (`investigate` and `propose` run with no input from the stages
   they depend on — stale/empty handoff. Wrong precondition, ★1.)

4. **Predict the blowout.** Fan out `investigate` over 10 anomalies with no
   concurrency cap and a 6-tool-call budget each. How many concurrent tool calls
   peak? (Up to 60 — the case for ★2, the concurrency cap.)

## See also

- `03-sequential-pipeline.md` — the dependent cousin; the three stages live here
- `02-supervisor-worker.md` — a supervisor often fans out to workers then merges
- `09-coordination-failure-modes.md` — cost blowup (the uncapped-concurrency
  failure) and its bound
- `../05-production-serving/` — fan-out backpressure (the concurrency cap as a
  serving control), noted as not-yet-built
- `../06-orchestration-system-design-templates/` — SECTION F: the build template
