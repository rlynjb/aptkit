# 02 — Processes, Threads, and Tasks

**Industry name:** concurrency model / unit-of-work · *Language-agnostic*

## Zoom out, then zoom in

Where does a "unit of work" live in AptKit? Not in a thread. Here's the band it occupies.

```
  Zoom out — the unit of concurrency, by layer

  ┌─ OS layer ──────────────────────────────────────────────┐
  │  processes: node (server), node (script), browser tab    │
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────┐
  │  ★ ONE thread per process — no worker_threads ★          │ ← we are here
  └──────────────────────────┬───────────────────────────────┘
  ┌─ Application layer ──────▼────────────────────────────────┐
  │  tasks = awaited Promises (model call, tool call, chunk)  │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: in a threaded runtime (Java, Go, a Rust tokio worker pool) the unit of concurrency is a thread or goroutine and you reason about which one holds what. In AptKit the unit is an **awaited Promise on a single thread**. The question "how many things run at once?" has a blunt answer: *one*. What varies is how many are *suspended at an await*, waiting to resume. That distinction — running vs suspended — replaces the entire threading mental model here.

## Structure pass

**Layers.** Process → thread → task, as in the zoom-out. The interesting layer is the middle one, because it's *empty* of the thing you'd expect (no second thread).

**Axis — "how many of these run simultaneously?"** Trace it down:

```
  One question down the layers: "how many run at the same instant?"

  ┌─ processes ─────────────┐   MANY (OS runs them truly in parallel)
  └────────────┬────────────┘
       ┌───────▼────────────┐   exactly ONE thread per process
       │  threads           │   (the answer collapses here)
       └───────┬────────────┘
           ┌───▼──────────────┐ exactly ONE task executing,
           │  tasks           │ N suspended at awaits
           └──────────────────┘
```

The answer flips hard at the thread layer: many processes truly parallel, but inside each, exactly one thread, so exactly one task's code running at any instant. Everything else is *suspended*, parked at an `await`, waiting for the loop to resume it.

**Seams.** The one seam that matters: the `await` point inside `runAgentLoop`'s tool loop. It looks like it could be a fan-out seam (multiple tools → parallel execution) but it isn't — it's a sequential `for...of`. That gap between "looks parallel" and "is serial" is the load-bearing observation of this file.

## How it works

### Move 1 — the mental model

You know how `Promise.all([a, b, c])` *starts* three fetches before any resolves, vs `for (const x of [a,b,c]) await x()` which finishes each before starting the next? AptKit is entirely the second shape. The strategy: **sequential awaited tasks, never concurrent ones.**

```
  The two shapes — AptKit uses only the right one

  Promise.all (NOT used):     for-await (used everywhere):
    a ──┐                       a ──► (done) ──► b ──► (done) ──► c
    b ──┤ all in flight           one finishes before the next starts
    c ──┘ at once                 total time = sum, not max
```

### Move 2 — walking the model

**A process owns a heap and a loop.** Each `node` invocation is isolated: separate V8 heap, separate event loop, separate `process.env`. Two scripts can't see each other's variables. The dev server is one long-lived process; each `scripts/*.mjs` is a fresh one that exits.

**A process has exactly one JS thread.** This is verified, not assumed: there is no `worker_threads`, no `new Worker`, no `child_process` fan-out, no `cluster` anywhere in the source. All "concurrency" is cooperative interleaving on one thread.

```
  Inside one process — one thread, tasks interleave at awaits

  time ──────────────────────────────────────────────►
  thread:  [taskA runs][  await — loop idle/other  ][taskA resumes]
                            ▲
                            └─ here, and ONLY here, another suspended
                               task could run; never mid-synchronous-block
```

**A task is one awaited Promise continuation.** When `runAgentLoop` hits `await model.complete()`, the function suspends, the loop is free, and it resumes when the network reply lands. The tool loop then suspends again at each `await tools.callTool(...)`.

**The tool loop is sequential — this is the load-bearing detail.** When a model turn returns three `tool_use` blocks, you might expect them to run at once. They don't. The loop walks them in a `for...of` and awaits each before starting the next. Three independent 200ms tools take 600ms, not 200ms.

```
  Tool execution within one turn — serial, not fanned out

  toolUses = [getMetric, getSegments, listVouchers]
       │
       for (const toolUse of toolUses):
         await callTool(getMetric)     ── 200ms ──► result
         await callTool(getSegments)   ── 200ms ──► result   (starts AFTER above)
         await callTool(listVouchers)  ── 200ms ──► result   (starts AFTER above)
       │
       └─ total ≈ 600ms. Promise.all would be ≈ 200ms — but these results
          all feed the SAME next message, so order doesn't matter and the
          code chose simplicity over the parallel win
```

**Why-it-breaks-if-removed framing:** the sequential `for...of` is what guarantees `toolCalls` is appended in a deterministic order and that trace events emit in causal sequence. Swap in `Promise.all` and you'd gain latency but lose ordered traces and would need to handle partial failure across the batch. For dependent agent reasoning the sequential choice is defensible; for a turn with provably independent tools it's latency left on the table.

### Move 2.5 — current state vs future state

```
  Phase A (now): sequential tools          Phase B (if needed): bounded fan-out
  ────────────────────────────────         ──────────────────────────────────
  for (const t of toolUses)                 await Promise.all(
    await callTool(t)                         toolUses.map(t => callTool(t)))
  • deterministic order                     • latency = max, not sum
  • simple cancellation (one await)         • need per-tool error isolation
  • trace events in causal order            • need a concurrency cap (p-limit)
                                            • trace ordering becomes nondeterministic
```

What *doesn't* have to change to get there: the `AbortSignal` already threads into each `callTool` (`run-agent-loop.ts:159`), so cancellation survives a fan-out. The cost is error handling and trace determinism, not plumbing.

### Move 3 — the principle

In single-threaded JS, "concurrency" is the count of suspended-at-await tasks, and "parallelism" (simultaneous execution) requires a second process or thread you don't have. The skill is knowing which of your awaits *could* overlap (independent I/O) and choosing whether the latency win is worth the loss of ordering and the added error-handling. AptKit consistently chooses sequential — correct for dependent steps, conservative for independent ones.

## Primary diagram

```
  Process / thread / task — the full picture

  ┌─ OS: many processes, truly parallel ─────────────────────────┐
  │                                                              │
  │  ┌─ node (dev server) ──────┐   ┌─ node (script) ──────────┐ │
  │  │ ONE thread, ONE loop     │   │ ONE thread, ONE loop     │ │
  │  │                          │   │                          │ │
  │  │ tasks (1 running, N      │   │ for-await over fixtures, │ │
  │  │ suspended at awaits):    │   │ strictly sequential      │ │
  │  │  • model.complete  ◄─I/O │   │  await runFixtureReplay  │ │
  │  │  • callTool (serial)     │   │  await runFixtureReplay  │ │
  │  │  • res.write             │   │  → process.exitCode      │ │
  │  └──────────────────────────┘   └──────────────────────────┘ │
  └───────────────────────────────────────────────────────────────┘
       NO worker_threads · NO SharedArrayBuffer · NO cluster
```

## Implementation in codebase

**Use cases.** This model is reached for every time the agent loop runs a turn (sequential tools), every time a script batch-replays fixtures (sequential loop), and every time you ask "can I speed this up by parallelizing?" (you can, with the Phase B trade).

**Code side by side.**

The sequential tool loop — the heart of the claim:

```
  packages/runtime/src/run-agent-loop.ts (lines 139–189)

  for (const toolUse of toolUses) {                  ← one tool at a time
    trace?.emit({ type: 'tool_call_start', ... });   ← emits BEFORE awaiting
    try {
      const { result, durationMs } =
        await tools.callTool(toolUse.name, toolUse.input, { signal }); ← suspends here
      toolCall.result = result;
    } catch (error) { ... }                           ← per-tool error, loop continues
    toolCalls.push(toolCall);                         ← ordered append
    trace?.emit({ type: 'tool_call_end', ... });
  }
       │
       └─ no Promise.all: the next iteration's await does not begin until this
          one settles. Order of toolCalls and trace events is deterministic.
```

Sequential batch in a script process:

```
  scripts/replay-promoted-fixtures.mjs (lines 28–40)

  for (const fixturePath of fixturePaths) {
    const result = await runFixtureReplay(fixturePath); ← awaited, one fixture at a time
    results.push({ ... });
  }
       │
       └─ a 50-fixture suite runs them in series; total time = sum of all replays
```

## Elaborate

The "no threads" choice isn't a gap — it's Node's whole proposition. Threads earn their keep for CPU-bound work (image resize, ML inference, parsing huge files). AptKit's work is I/O-bound: it spends nearly all wall-clock time *waiting* on the provider API, where the CPU is idle anyway and a thread would just sleep. The one place in Rein's portfolio where threading genuinely earns its place is `contrl` — an on-device ML pipeline with a hard frame-rate budget, using Worklets-core to keep pose inference off the JS thread. That's the right tool *there* because the work is CPU-bound and latency-critical. AptKit's agent loop is the opposite workload, so it's correctly single-threaded. `not yet exercised` here: `worker_threads`, `cluster`, process pools, `child_process` fan-out — none present, and none warranted by this workload.

## Interview defense

**Q: "Three tools in one turn — parallel or serial here? Why?"**

```
  toolUses → [A][B][C]
  for(...) await callTool   →   A done, then B, then C   (serial, sum of latencies)
  alternative: Promise.all  →   A‖B‖C                      (max latency, but...)
                                 ...nondeterministic traces + batch error handling
```

Answer: "Serial — a `for...of` with an `await` inside. It's the conservative call: deterministic trace ordering and trivial cancellation, at the cost of latency when the tools are independent. The fan-out version needs a concurrency cap and per-tool error isolation, which the codebase didn't take on." Anchor: `run-agent-loop.ts:139–189`. The part people forget: the trace events `emit` in causal order *because* it's serial — parallelize and you lose that for free.

**Q: "Is there any true parallelism in this repo?"** Only at the OS process level (two scripts, or a script + the dev server, run on different cores). Inside any one process: one thread, never. No `worker_threads`/`Worker`/`SharedArrayBuffer`.

## Validate

1. **Reconstruct:** Write the sequential tool loop in pseudocode and mark where it suspends.
2. **Explain:** Why does serial tool execution give deterministic trace ordering? (Each `emit` runs to completion before the next `await` resumes — `run-agent-loop.ts:147,171`.)
3. **Apply:** You profile a turn at 600ms with three independent 200ms tools. What's the change and its cost? (Phase B fan-out → ~200ms, costs trace determinism + batch error handling.)
4. **Defend:** Argue why threads would not help the agent loop, and name the workload shape that *would* need them.

## See also

- `03-event-loop-and-async-io.md` — what the loop does while a task is suspended.
- `04-shared-state-races-and-synchronization.md` — why one thread means no locks.
- `07-backpressure-bounded-work-and-cancellation.md` — the bounds on this sequential work.
- `.aipe/study-performance-engineering/` *(when generated)* — the latency case for/against fan-out.
