# Fan-out Backpressure

**Industry standard.** "Concurrency limiting," "fan-out backpressure," "semaphore over agents." Type label: serving optimization. **In this codebase: not yet exercised** — aptkit runs no concurrent agents and no fan-out, so it has no concurrency limiter. Single-agent runs issue one outbound call at a time.

## Zoom out, then zoom in

A single call has one outbound request to rate-limit. A fan-out topology (SECTION C's parallel pattern) fires many concurrent calls from one task — and a supervisor spawning workers can fan out faster than the provider's rate limit allows. aptkit doesn't fan out, so this is the control it'd need the moment it did.

```
  Zoom out — fan-out backpressure (not in aptkit)

  Supervisor decomposes → 12 worker calls at once
                       │
  ┌────────────────────▼─────────────────────────────────────┐
  │  Concurrency limiter (semaphore) — pop ≤ N, queue rest    │ ← would be here
  └────────────────────┬──────────────────────────────────────┘
                       ▼
  Provider — receives at most N at a time
```

## Structure pass

**Axis: how many concurrent outbound calls, and what bounds them?** A single agent: one at a time, naturally bounded. A fan-out: N at once, bounded only by a limiter you add. Trace the failure: without a limiter, a supervisor spawning 12 workers fires 12 concurrent calls and trips the provider's rate limit (429s). The seam: serial single-agent (self-limiting) vs concurrent fan-out (needs an explicit semaphore + upward backpressure).

## How it works

### Move 1 — the mental model

`Promise.all()` with a concurrency cap — the same thing you reach for with 200 independent requests when you don't want 200 open connections at once. The agent version adds backpressure *upward*: when the worker queue grows, the supervisor should stop decomposing rather than queue unbounded work.

```
  Fan-out backpressure = Promise.all with a cap + upward backpressure

  12 worker calls → ┌─ semaphore (N=4) ─┐ → provider gets ≤ 4 at a time
                    │  pop ≤ N, queue   │
                    └───────────────────┘
  queue too big? → supervisor STOPS decomposing (upward backpressure)
```

### Move 2 — what aptkit has, and the limiter it'd need

**aptkit is self-limiting today.** A single `runAgentLoop` issues one `model.complete` per turn, sequentially. There's no fan-out, so there's no concurrency to limit — the loop is naturally bounded to one outbound call at a time. The closest thing to flow control aptkit has is the *sequential fallback chain* (a provider that tries Anthropic, then OpenAI, then local) — but that's failover, not concurrency control.

**The limiter fan-out would need.** If aptkit fanned out the rag-query agent (SECTION C file 04) to answer "compare X, Y, Z" with three concurrent searches, the naive version is `Promise.all([answer(X), answer(Y), answer(Z)])`. At three workers that's fine; at twelve it trips the provider rate limit. The fix is a semaphore: pop up to N concurrent, queue the rest.

```
  Fan-out limiter for aptkit (would-be)

  supervisor splits → [w1, w2, ..., w12]
       │ instead of Promise.all (all 12 at once):
       ▼
  semaphore(N=4): run 4, queue 8, refill as each finishes
       │
       ▼ AND: if the queue exceeds a threshold,
  supervisor stops spawning more workers (upward backpressure)
```

**The tradeoff and the breakpoint.** A low concurrency cap protects the provider but serializes the fan-out — you lose the parallel-latency win that made fan-out worth it. The breakpoint is the provider's rate limit divided by per-call duration: cap concurrency just under that. And if the task needs more throughput than the limit allows, the answer is request a higher limit or batch — *not* a higher local cap that just trades queueing for 429s. aptkit's local Gemma has no rate limit at all (it's a local HTTP server), which is another reason fan-out backpressure hasn't been needed — the local model is the bottleneck, not a provider quota.

### Move 3 — the principle

Fan-out backpressure is `Promise.all` with a cap plus upward backpressure: a runaway supervisor that keeps spawning workers is the multi-agent version of an unbounded queue. aptkit doesn't need it yet because it runs one agent serially against a local model with no quota. The control becomes mandatory the moment it fans out against a rate-limited provider — and the cap should sit just under (rate limit ÷ per-call duration).

## Primary diagram

```
  Fan-out backpressure for aptkit (would-be) — full frame

  ┌─ Supervisor (decompose) ─────────────────────────────────┐
  │  split task → N worker calls                              │
  │  queue > threshold? → STOP decomposing (upward backpressure)│
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Concurrency limiter (semaphore, N=4) ────────────────────┐
  │  run ≤ N concurrent · queue the rest · refill on finish    │
  │  cap = provider rate limit ÷ per-call duration             │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Provider ─────────────────────────────────────────────────┐
  │  receives ≤ N at a time (no 429 storm)                     │
  │  (aptkit's local Gemma: no quota — limiter not yet needed)  │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

Fan-out backpressure is the agent-scale version of a classic concurrency problem: independent work that can swamp a downstream dependency if you fire it all at once. The two halves — a semaphore *down* (cap concurrent calls) and backpressure *up* (stop the supervisor decomposing) — together prevent both the 429 storm and the unbounded queue. aptkit's serial single-agent design sidesteps both, and its local model has no quota to trip, so the control is genuinely not yet needed. It's the first thing to add when fan-out meets a paid, rate-limited provider.

## Interview defense

**Q: How do you keep a fan-out from tripping the rate limit?**
A concurrency cap — a semaphore that runs at most N workers at once and queues the rest — plus upward backpressure, where the supervisor stops decomposing if the queue grows too big. It's `Promise.all` with a cap. aptkit doesn't fan out yet, so it has no limiter, and its local model has no quota to trip — but the moment I fan out against a paid provider, the cap goes in, set just under rate-limit ÷ per-call duration.

```
  semaphore down (cap concurrent) + backpressure up (stop decomposing)
```
*Anchor: a runaway supervisor spawning workers is the multi-agent unbounded queue.*

**Q: Why not just raise the local cap if you need more throughput?**
That trades queueing for 429s — it doesn't add capacity. If the task needs more than the limit allows, the answer is request a higher limit or batch, not a higher local cap.

## See also

- `03-multi-agent-orchestration/04-parallel-fan-out.md` — the topology this serves
- `03-per-tool-circuit-breaking.md` — the next serving control
- `03-multi-agent-orchestration/09-coordination-failure-modes.md` — the cascade/cost-blowup failures this bounds
- `study-ai-engineering/06-production-serving/` — single-call rate limiting (cross-ref)
