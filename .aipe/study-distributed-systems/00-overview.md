# 00 — Overview: the one distributed edge

## The verdict first

AptKit is a **single-process library + local dev tool.** Run the agent loop and
everything — prompt assembly, tool dispatch, JSON parsing, the usage ledger,
the Studio replay UI — executes inside one Node runtime, on one machine, in one
address space. There is no second node to coordinate with.

There is **one** place where the system reaches across a boundary it doesn't
control: the call to a model provider's HTTP API. That single hop is the entire
distributed-systems surface of this repo, and it's a real one — an external
dependency that can be slow, down, rate-limited, or return malformed output
while your process keeps running.

```
  The whole system, one frame — find the boundary

  ┌─ Process boundary (one Node runtime, one machine) ───────────────────┐
  │                                                                       │
  │  ┌─ Service layer ────────────────────────────────────────────────┐  │
  │  │  runAgentLoop  ── bounded turns, AbortSignal, JSON re-prompt     │  │
  │  │       │                                                          │  │
  │  │       ▼                                                          │  │
  │  │  ModelProvider.complete()  ◄── the contract everything uses      │  │
  │  │       │                                                          │  │
  │  │   ┌───┴────────────┬─────────────────┬───────────────┐          │  │
  │  │   ▼                ▼                 ▼               ▼          │  │
  │  │  Anthropic     OpenAI           Fallback        ContextGuard    │  │
  │  │  adapter       adapter          (chain)         (pre-flight)    │  │
  │  └───┬───────────────┬──────────────────────────────────────────┘  │
  │      │               │                                              │
  └──────┼───────────────┼──────────────────────────────────────────────┘
         │ HTTPS         │ HTTPS         ★ THE ONLY DISTRIBUTED EDGE ★
         ▼               ▼
  ┌─ External provider APIs (not yours) ─────────────────────────────────┐
  │  api.anthropic.com          api.openai.com                            │
  │  partial failure lives here: timeout / 429 / 5xx / partial / garbage  │
  └───────────────────────────────────────────────────────────────────────┘
```

Everything to the left of the HTTPS arrows is one process. The discipline this
guide teaches applies to that one arrow.

## Ranked findings — what's actually here

The findings are ranked by how real they are in *this* repo, most-real first.

### 1. The fallback chain is the one true partial-failure pattern (★ real)

`packages/providers/fallback/src/fallback-provider.ts:47-89` — `FallbackModelProvider.complete()`
tries provider adapters **in sequence**; when one throws, it records the
attempt and moves to the next. When all fail, it throws `ProviderFallbackError`
(`:16-24`) carrying every attempt. This is exactly partial-failure handling
against an unreliable external dependency: one node (provider) being down
doesn't take the whole request down — you fail over. The `shouldFallback`
predicate (`:44`, `:73`) classifies errors (retryable vs not), and the
`AbortError` passthrough (`:65`, `:92-95`) makes cancellation win over
failover. **This is the file to read first.** → see `02` and `05`.

### 2. The context-window guard is fail-fast before a doomed remote call (★ real)

`packages/providers/local/src/context-window-guard.ts:57-71` — a pre-flight
check that estimates input tokens and throws `ContextWindowExceededError`
*before* dispatching to the wrapped provider if the request can't fit. This is
the distributed-systems instinct of "validate locally before paying for a
remote round-trip that will definitely fail." → see `02`.

### 3. Bounded turns + cancellation = the in-process safety rails (★ real, but in-process)

`packages/runtime/src/run-agent-loop.ts:98` — the loop is hard-capped at
`maxTurns` (default 8) and `maxToolCalls`. `:99`, `:209` — `signal.throwIfAborted()`
checks the `AbortSignal` before every model call and recovery turn. The
re-prompt on parse failure (`:192-199`) is the closest thing to an
"idempotent retry" the repo has — it re-runs the conclusion step from the same
recorded context. This is bounded work and cancellation (runtime-systems'
territory) doing double duty as a partial-failure guard. → see `02`, `03`.

### 4. The usage ledger is accounting across many provider calls (~ weak analog)

`packages/runtime/src/usage-ledger.ts:25-42` — `summarizeUsage()` folds every
`model_usage` event in a trace into one row (total input/output tokens, turn
count). It's the nearest thing to "tracking work across nodes," except the
"nodes" are sequential calls to the same external API from one process. → see `03`.

### 5. Replay is deterministic re-execution from a recorded log (~ recovery/idempotency analog)

`packages/evals/src/replay-runner.ts` + `FixtureModelProvider`
(`packages/agents/recommendation/src/fixture-provider.ts:11-17`) — replay swaps
the live provider for one that returns recorded `ModelResponse[]` in order. Same
input log → same output, deterministically. That's the *shape* of recovery from
a write-ahead log or event replay, used here for testing, not failure recovery.
The `CapabilityEvent` trace (`packages/runtime/src/events.ts:1-24`) is an
event-sourcing analog — an append-only log of what happened. → see `03`, `08`.

## `not yet exercised` — the honest list

These are real distributed-systems concepts AptKit has **no instance of.** The
guide teaches each as a foundation and names the trigger that would make it
real. Most of the topic surface lands here:

| Concept | Status | Trigger that would make it real |
| --- | --- | --- |
| Consensus / quorum | not yet exercised | A second replica of any state that must agree |
| Replication | not yet exercised | Any state stored in >1 place that must converge |
| Partitioning / sharding | not yet exercised | A dataset too big for one node |
| Leader election | not yet exercised | >1 process that must pick one coordinator |
| Message queues / streams | not yet exercised | Async hand-off between producer and consumer |
| Backpressure | not yet exercised | A queue that can fill faster than it drains |
| Poison messages / DLQ | not yet exercised | A durable queue with retry semantics |
| Logical clocks / ordering | not yet exercised | Concurrent writers needing a happens-before order |
| Distributed transactions / 2PC | not yet exercised | A write spanning two systems that must both commit |
| Sagas / compensation | not yet exercised | A multi-step external workflow needing rollback |
| Transactional outbox | not yet exercised | A DB write + a message publish that must be atomic |
| Read-your-writes / session consistency | not yet exercised | A replicated read path with a write path |
| Split-brain | not yet exercised | >1 node that could each think it's the leader |

The single-process design is *why* none of these exist — and that's the right
call for a library. You don't add Raft to a `.map()`. The trigger column is the
load-bearing part: it tells you exactly when each concept stops being academic.

## The fallacies of distributed computing — which ones bite here

The eight fallacies (Deutsch/Gosling) are the assumptions that quietly break
distributed code. AptKit only has one network hop, so only the fallacies about
*that hop* apply:

```
  The 8 fallacies — does AptKit's one hop violate it?

  1. The network is reliable      ── YES, bites: provider calls fail → fallback
  2. Latency is zero              ── YES, bites: every complete() is a round-trip
  3. Bandwidth is infinite        ── partial: large prompts → context guard
  4. The network is secure        ── networking/security guide owns this (TLS, keys)
  5. Topology doesn't change      ── n/a: one fixed endpoint per provider
  6. There is one administrator   ── YES, bites: the provider's admin, not you
  7. Transport cost is zero       ── YES, bites: usage ledger tracks $ per call
  8. The network is homogeneous   ── partial: two providers, two API shapes
```

Fallacies 1, 2, 6, 7 are the ones AptKit actually has to handle. The fallback
chain answers #1, bounded turns + the ledger answer #2 and #7, and #6 is *the
whole reason* the fallback chain exists — the provider's rate limits and outages
are decided by someone who isn't you.

## How to use this guide

Read `01` for the map. Read `02` and `03` slowly — they're the files grounded in
real code. Skim `04`–`08` to know the foundations and recognize the triggers.
Finish on `09` for the ranked risk audit. The goal is that you can walk into an
interview, draw the one-hop diagram above, and say with a straight face: "this
system is single-process by design; here's the one distributed edge and exactly
how it handles partial failure — and here's what I'd add the day it grows a
second node."
