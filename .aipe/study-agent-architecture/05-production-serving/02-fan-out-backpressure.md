# Fan-Out Backpressure

**Industry term:** fan-out backpressure (concurrency cap + upward backpressure). *Industry standard.*

## Zoom out, then zoom in

A single call has one outbound request to rate-limit. A fan-out topology fires many concurrent calls from one task, and a supervisor can fan out faster than the provider's rate limit allows. aptkit has no fan-out, so this is `not yet exercised` — but the primitive is one you ship daily.

```
  Zoom out — not built; aptkit runs tools sequentially within a turn

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  runAgentLoop: for (toolUse of toolUses) — SEQUENTIAL         │ ← we are here
  │  no concurrent fan-out, so no backpressure needed yet         │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet exercised in aptkit.** Tool calls within a turn run one at a time (`run-agent-loop.ts:139`), and there's no supervisor spawning concurrent workers. Backpressure becomes relevant only with the fan-out topology ([../03-multi-agent-orchestration/04-parallel-fan-out.md](../03-multi-agent-orchestration/04-parallel-fan-out.md)).

## How it works

**Use case it would fit:** a research-assistant supervisor decomposing into 12 worker retrievals at once — more than the provider's concurrent rate limit allows.

### Move 1 — the flow control

It's `Promise.all()` with a concurrency cap — the thing you reach for when you have 200 independent requests but don't want 200 open connections at once.

```
  Supervisor decomposes → 12 worker calls at once
                       │
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Concurrency limiter (semaphore)               │
  │   pop up to N concurrent (N = 4)               │
  │   queue the rest                               │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Provider — receives at most N at a time       │
  └───────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**aptkit's current shape sidesteps it.** Sequential tool execution within a turn means there's never a burst of concurrent provider calls from one agent. That's correct for a single debuggable agent — and it's why backpressure isn't wired. The problem only appears when you parallelize at the agent level.

**The agent-specific addition: backpressure *upward*.** A plain concurrency cap throttles the outbound calls. The agent version adds a second control: when the worker queue grows past a threshold, the *supervisor* should stop decomposing further rather than queue unbounded work. A runaway supervisor that keeps spawning workers is the multi-agent version of an unbounded queue — the cap throttles execution, but only upward backpressure stops the supervisor from generating infinite work.

**The tradeoff and the breakpoint.** A low concurrency cap protects the provider but serializes the fan-out — you lose the parallel-latency win that made fan-out worth it. The breakpoint is the provider's rate limit divided by per-call duration: cap concurrency just under that. And if the task needs more throughput than the limit allows, the answer is request a higher limit or batch — not a higher local cap that just trades queueing for 429s.

**What it would cost aptkit.** A semaphore around the worker `runAgentLoop` calls (the fan-out doesn't exist yet, so this is hypothetical), plus a supervisor-side check that halts decomposition when the queue is deep. **Not yet exercised.**

### Move 3 — the principle

Fan-out backpressure is `Promise.all` with a concurrency cap, plus upward backpressure that stops a runaway supervisor from generating unbounded work. The cap's breakpoint is the rate limit over per-call duration; pushing the local cap higher than that just trades queueing for 429s. aptkit's sequential execution avoids the problem entirely today — correct until it wants parallel workers.

## Primary diagram

```
  Fan-out backpressure — the two controls (not yet exercised)

  supervisor → N worker calls
        │ semaphore: at most N concurrent, queue the rest   (downward cap)
        │ if queue deep → supervisor STOPS decomposing       (upward backpressure)
        ▼
  provider receives ≤ N at a time

  aptkit today: tools run SEQUENTIALLY within a turn → no burst → no cap needed yet
  breakpoint: cap ≈ rate_limit / per_call_duration (higher = 429s, not throughput)
```

## Elaborate

Backpressure is the control that keeps a fan-out from becoming a self-inflicted DDoS on your own provider quota. The naive parallel agent — supervisor spawns a worker per sub-task, all at once — hits the rate limit and gets a wall of 429s, which is *slower* than a capped fan-out. The two-part fix (concurrency cap + upward backpressure) is standard async-systems hygiene applied to agents; the upward half is the agent-specific twist, because a supervisor can generate work faster than any cap can drain it. aptkit's sequential-within-a-turn execution means it has never needed this — and adopting fan-out without it would be the classic mistake.

## Interview defense

**Q: If a supervisor fanned out to many workers, how would you keep it from hitting the rate limit?**

Two controls. A concurrency cap — a semaphore that lets at most N worker calls run at once and queues the rest, sized just under the provider's rate limit divided by per-call duration. And upward backpressure — if the worker queue gets deep, the supervisor stops decomposing instead of queuing unbounded work. A higher local cap doesn't buy throughput past the rate limit; it just trades queueing for 429s.

```
  cap (semaphore): throttle concurrent calls
  upward backpressure: stop the supervisor generating infinite work
```

I'd note aptkit sidesteps this today by running tools sequentially within a turn — no burst, no cap needed yet.

*Anchor: the cap's breakpoint is rate_limit / per_call_duration; past that, request a higher limit, don't raise the local cap.*

## See also

- [../03-multi-agent-orchestration/04-parallel-fan-out.md](../03-multi-agent-orchestration/04-parallel-fan-out.md) — the topology this controls.
- [03-per-tool-circuit-breaking.md](03-per-tool-circuit-breaking.md) — the other compounding-failure control.
- Single-call rate-limiting and backpressure: `.aipe/study-ai-engineering/06-production-serving/`.
