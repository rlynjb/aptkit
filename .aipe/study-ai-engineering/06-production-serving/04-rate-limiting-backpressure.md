# Rate limiting and backpressure (don't outrun the provider)

**Industry names:** rate limiting, request throttling, backpressure, concurrency limiting · *Industry standard*

## Zoom out, then zoom in

Every LLM provider enforces rate limits — requests per minute, tokens per minute,
concurrent requests. Exceed them and you get 429s, dropped work, or a throttled
account. Rate limiting and backpressure are how a *client* stays under those ceilings:
cap your own concurrency, queue the overflow, and slow down when the provider pushes
back. AptKit does not do this today — it bounds work *per run*, not *across runs* — so
this file teaches the foundation and marks the gap.

```
  Zoom out — where a limiter would sit (none today)

  ┌─ Caller layer (many concurrent runs) ─────────────────────────┐
  │  run A   run B   run C   …   (no cross-run coordination)        │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ ★ a concurrency limiter would go HERE ★
  ┌─ Limiter / queue layer (NOT BUILT) ──▼──────────────────────────┐
  │  cap in-flight calls · queue overflow · backpressure on full     │ ← we are here
  └───────────────────────────────┬────────────────────────────────┘
                                   │ model.complete()
  ┌─ Provider layer ───────────────▼────────────────────────────────┐
  │  enforces RPM / TPM / concurrency limits → 429 on excess         │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a rate limiter caps the *rate or concurrency* of outbound requests;
backpressure is what the system does when it's already at the cap — *refuse or
queue* new work rather than pile on. The question this file answers: what bounds
AptKit's request rate today? Answer: only `maxToolCalls`, which caps fan-out *within
a single run*. Nothing coordinates *across* concurrent runs — ten simultaneous scans
fire ten independent loops at the provider with no shared ceiling. A
concurrency-limited provider wrapper is the missing piece.

## Structure pass

**Layers.** The relevant seam is again the *provider boundary* — a limiter wraps
`model.complete` and gates how many calls are in flight. Above it, callers; below it,
the rate-limited provider.

**Axis — guarantees / how many requests can be in flight at once?** Trace it. Within
one run, `maxToolCalls` caps total tool calls (and thus loosely bounds model turns) —
a *per-run* guarantee. Across runs: *no* guarantee — each run is independent, so N
concurrent runs produce up to N× the load with nothing summing it. The provider's
limit is global; AptKit's only bound is local.

```
  One question — "how many requests can hit the provider at once?"

  ┌─ within one run ──┐  → bounded by maxToolCalls (per-run fan-out)
  ┌─ across runs ─────┐  → UNBOUNDED — no shared concurrency limit (the gap)
  ┌─ provider ────────┐  → hard global RPM/TPM/concurrency → 429 on excess
```

**Seams.** The seam a limiter needs is the `ModelProvider.complete` decorator point —
the same one the fallback chain and context guard use. A limiter there could gate
*all* runs through one shared semaphore. The seam exists; the limiter doesn't.

## How it works

You already know a connection pool or a semaphore: a fixed number of permits, acquire
before work, release after, and callers block (or get rejected) when permits run out.
A concurrency limiter for LLM calls is exactly that, wrapped around
`model.complete`. Backpressure is the policy for "permits exhausted": queue, reject,
or block.

### Move 1 — the mental model

```
  Rate limiting + backpressure — a semaphore at the provider seam

  incoming complete() calls
        │
  acquire permit ──┐  permits available?
                   │  yes → proceed → call provider → release
                   │  no  → BACKPRESSURE:
                   │         queue (wait) │ reject (429-fast) │ shed
                   ▼
  in-flight count never exceeds the cap → provider never overrun
```

The idea in one line: bound your own concurrency *below* the provider's limit, and
decide deliberately what happens to the overflow.

### Move 2 — the moving parts

**The concurrency cap.** Bridge from a worker pool of size N — only N model calls run
at once; the N+1th waits for one to finish. Boundary condition: set the cap at or
below the provider's concurrency limit and you never get throttled by over-parallelism;
set it too low and you waste throughput.

```
  Pattern — bounded in-flight calls

  inFlight = 0; LIMIT = N
  on complete():
    while inFlight >= LIMIT: wait        ← the cap
    inFlight++; try provider.complete() finally inFlight--
```

**Backpressure policy.** Bridge from a bounded queue with an overflow strategy — when
the cap is hit, you choose: *queue* (callers wait, throughput smooths, latency
grows), *reject* (fail fast with a "busy" error, protect latency), or *shed* (drop
low-priority work). Boundary condition: an *unbounded* queue is the trap — it hides
overload until memory blows; a real backpressure design bounds the queue too.

```
  Comparison — backpressure policies when the cap is hit

  QUEUE (wait)            REJECT (fail fast)         SHED (drop)
  ───────────────────     ───────────────────────    ────────────────
  smooths bursts          protects p99 latency        protects critical work
  latency grows           caller must retry           low-priority dropped
  bound the queue!        clear signal to backoff     needs a priority signal
```

**Rate vs concurrency.** Bridge from "requests per second" vs "requests in flight" —
providers cap both RPM/TPM (a rate over time) and concurrent requests (a count at an
instant). A concurrency limiter handles the latter; a token-bucket handles the former.
Boundary condition: you often need both — a token bucket for RPM/TPM and a semaphore
for concurrency.

### Move 2.5 — what AptKit has vs needs

```
  Comparison — present vs absent

  PRESENT                              ABSENT
  ──────────────────────────────       ──────────────────────────────────
  maxToolCalls: per-RUN fan-out cap    cross-run concurrency limit
  (recommendation 4, query 6)          request queue / token bucket
  signal-based cancellation            backpressure policy (queue/reject/shed)
  (abort a single run)                 provider-aware throttle (read 429 headers)
```

`maxToolCalls` is a real bound, but it's the *wrong axis* for rate limiting: it caps
how many tools *one run* uses, not how many runs hit the provider together. Launch
fifty scans and you get fifty loops racing at the provider with no shared ceiling —
the provider's 429s become your only (reactive, painful) rate limiter.

### Move 3 — the principle

Bound your outbound concurrency *below* the provider's limit, and make overflow an
explicit decision — queue (bounded), reject, or shed — never an accident. The failure
mode that bites in production is uncoordinated parallelism: many independent runs each
behaving politely but summing to a thundering herd. The fix lives at the shared
provider seam, where one limiter can see all calls. AptKit bounds per-run work well
and hasn't yet needed cross-run coordination; that coordination is the foundation to
add before scaling concurrency.

## Primary diagram

The full (proposed) picture: a shared limiter at the provider seam, with the per-run
cap that exists today shown for contrast.

```
  Rate limiting + backpressure — where it attaches (not yet built)

  CALLERS: run A · run B · run C …  (each bounded internally by maxToolCalls)
        │  but NOTHING coordinates them across runs  ◄── THE GAP
        ▼
  ┌─ CONCURRENCY LIMITER (ModelProvider wrapper) — Case B ──────────┐
  │  semaphore(LIMIT) — acquire before complete(), release after     │
  │  overflow → backpressure: bounded queue | reject | shed          │
  └────────────────────────────┬─────────────────────────────────────┘
                               ▼ in-flight ≤ LIMIT
  ┌─ PROVIDER ──────────────────────────────────────────────────────┐
  │  RPM / TPM / concurrency limits → 429 only if you exceed them    │
  └──────────────────────────────────────────────────────────────────┘

  same wrapper seam as FallbackModelProvider + ContextWindowGuardedProvider
```

## Implementation in codebase

**Use cases (per-run only).** Today the only request-bounding in AptKit is per run.
The recommendation agent caps total tool calls at 4, the query agent at 6 — so a
*single* run can't fan out unboundedly. But there is no limiter coordinating multiple
concurrent runs, and no queue or backpressure anywhere.

**The per-run cap (the wrong-axis bound)**, `packages/runtime/src/run-agent-loop.ts:101-102`:

```
  run-agent-loop.ts  (lines 101-102)

  const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
  const forceFinal  = turn === maxTurns - 1 || budgetSpent;
       │
       └─ this bounds fan-out WITHIN one run (e.g. recommendation-agent.ts:87
          sets maxToolCalls: 4). It says nothing about how many RUNS call the
          provider at once — so it is NOT a rate limiter. Fifty concurrent
          scans = fifty independent loops with no shared ceiling.
```

**Cancellation exists; throttling doesn't** — the loop honors an `AbortSignal`
(`run-agent-loop.ts:99`, `signal?.throwIfAborted()`), so a single run can be cancelled.
That's flow *control*, not flow *limiting* — it stops one run, it doesn't cap how many
run together.

**The seam a limiter would use** — `ModelProvider.complete`
(`packages/runtime/src/model-provider.ts:54-58`): a `ConcurrencyLimitedProvider` would
implement `ModelProvider`, hold a shared semaphore, acquire a permit before delegating
`complete`, and apply a backpressure policy when permits are exhausted — wrapping the
real provider exactly like the fallback chain and context guard already do.

## Elaborate

Backpressure is a foundational distributed-systems idea: a fast producer must not
overwhelm a slower consumer, so the consumer signals "slow down" and the producer
obeys. For LLM clients the "consumer" is the provider with its rate limits, and the
"signal" is either your own concurrency cap (proactive) or the provider's 429s
(reactive — the bad kind, because by then you're already over). The mature design is
proactive: cap concurrency below the limit, bound the queue, and additionally read the
provider's rate-limit headers to throttle dynamically.

AptKit hasn't needed this because its runs are interactive and low-concurrency. The
honest gap: `maxToolCalls` is often *mistaken* for rate limiting in a code read, but
it bounds the wrong axis (per-run fan-out, not cross-run concurrency). The first real
move is a shared concurrency limiter at the provider seam — the seam already exists,
proven by two other wrappers.

Adjacent concepts: the retry/backoff that pairs with a limiter on 429s
(`05-retry-circuit-breaker.md`), the provider-decorator seam (`01-llm-caching.md`),
and the cost angle of doing less work (`02-llm-cost-optimization.md`).

## Project exercises

*Provenance: Phase 6 — Production serving (C6.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. Case B — no limiter exists; this introduces one.*

### Exercise — concurrency-limited provider wrapper (Case B)

- **Exercise ID:** `[B6.6]` Phase 6, rate-limiting/backpressure concept
- **What to build:** A `ConcurrencyLimitedProvider` implementing `ModelProvider` that
  holds a semaphore of size N: acquire before delegating `complete`, release after,
  and apply a configurable backpressure policy when full (bounded-queue-with-wait
  default; reject-fast option). Emit a trace event when a call queues.
- **Why it earns its place:** This is the missing cross-run bound — the difference
  between "polite per run" and "polite as a system." It wraps the same provider seam
  the fallback chain uses, so it composes cleanly, and it directly addresses the
  thundering-herd failure that 429s otherwise punish.
- **Files to touch:** a new `packages/providers/limiter/src/*`,
  `packages/runtime/src/model-provider.ts` (consume the interface), matching tests.
- **Done when:** With N=2, three concurrent `complete` calls never exceed two in
  flight (the third waits or is rejected per policy); a test proves the in-flight cap
  holds and the queued call eventually runs.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: A hundred agent runs fire at once. What stops you from getting rate-limited?**
"Today, nothing cross-run — and I'd be honest about it. I'd draw the gap:"

```
  run1 … run100  → each capped by maxToolCalls (per-run only)
        │ no shared ceiling
        ▼ 100 independent loops hit the provider → 429s
  fix: a semaphore at the provider seam → in-flight ≤ N
```

"`maxToolCalls` (`run-agent-loop.ts:101`) bounds fan-out *within* a run, not
concurrency *across* runs — it's the wrong axis for rate limiting. With no shared
limiter, a hundred runs race the provider and the 429s become my reactive rate
limiter. The fix is a `ConcurrencyLimitedProvider` at the `model.complete` seam —
a semaphore capping in-flight calls below the provider limit, with a bounded queue for
overflow."
*Anchor: per-run caps aren't rate limiting; coordinate at the shared provider seam.*

**Q: Queue, reject, or shed when you hit the cap?**
"Depends on the SLA. Queue (bounded!) smooths bursts at the cost of latency; reject
fast protects p99 and tells the caller to back off; shed drops low-priority work to
protect the critical path. The trap is an *unbounded* queue — it hides overload until
memory blows. I'd bound the queue and pick the policy per workload."
*Anchor: backpressure is an explicit overflow decision, and the queue must be bounded.*

## Validate

- **Reconstruct:** From memory, write the semaphore-wrapped `complete`: acquire,
  delegate, release, with an overflow policy. Check the seam against
  `model-provider.ts:54-58`.
- **Explain:** Why is `maxToolCalls` (`run-agent-loop.ts:101`) not a rate limiter?
  (It bounds tool fan-out within a single run; it doesn't coordinate or cap how many
  runs call the provider concurrently — the wrong axis.)
- **Apply:** You set a concurrency limiter to N=5 but the provider allows 10
  concurrent. What's the effect, and is it wrong? (You never exceed 5 in flight, so
  you're never throttled — but you under-use available throughput; raise the cap
  toward the limit if throughput matters.)
- **Defend:** Why add the limiter at the `ModelProvider` seam rather than inside each
  agent? (One shared limiter at the seam sees *all* runs and can enforce a global
  cap; per-agent limits can't coordinate across concurrent runs — same reason the
  fallback chain and context guard live at that seam.)

## See also

- [05-retry-circuit-breaker.md](05-retry-circuit-breaker.md) — backoff/retry that pairs with a limiter on 429s
- [01-llm-caching.md](01-llm-caching.md) — the same provider-decorator seam
- [02-llm-cost-optimization.md](02-llm-cost-optimization.md) — doing less work as the other load-reducer
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the per-run maxToolCalls bound
