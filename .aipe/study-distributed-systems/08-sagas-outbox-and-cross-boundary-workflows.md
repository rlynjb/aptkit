# 08 — Sagas, outbox, cross-boundary workflows

**Industry name(s):** distributed transactions / two-phase commit (2PC) / sagas
/ compensating transactions / transactional outbox / event sourcing /
reconciliation. **Type:** Industry standard.
**Status in AptKit:** `not yet exercised` for sagas/2PC/outbox; the
`CapabilityEvent` trace + deterministic replay are an **event-sourcing /
recovery analog**.

## Zoom out, then zoom in

A saga coordinates a multi-step workflow that spans systems that *can't* share a
transaction — when step 3 fails, you can't `ROLLBACK`, so you run *compensating*
steps to undo 1 and 2. AptKit has no such workflow: there's one external call per
turn, no second system to commit to, nothing to compensate. But it *does* have
the building block sagas are built on — an append-only event log (the trace) and
the ability to replay it deterministically. That's the event-sourcing substrate,
used here for testing rather than for recovery or compensation.

```
  Zoom out — where cross-boundary workflows would live

  ┌─ Service layer ──────────────────────────────────────────────┐
  │  CapabilityEvent trace ── append-only log (event-sourcing analog)│ ← real analog
  │  replay-runner + FixtureModelProvider ── deterministic re-run    │ ← recovery analog
  └─────────────────────────────┬────────────────────────────────┘
                               │ complete() — ONE external call/turn
  ┌─ Provider boundary ─────────▼────────────────────────────────┐
  │  no second system to commit to → no saga, no 2PC, no outbox    │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: **2PC** tries for atomicity across systems (prepare → commit) but blocks
forever if the coordinator dies — so distributed systems mostly avoid it.
**Sagas** replace atomicity with *compensation*: do step, record it; on failure,
run the inverse of each completed step. **Transactional outbox** solves the
"write to DB *and* publish a message atomically" problem by writing the message
into the same DB transaction, then relaying it. **Event sourcing** stores state
as an append-only log of events and rebuilds state by replaying them. AptKit
touches only the last one, and only for tests.

## Structure pass — layers, axis, seam

Trace the **state axis** — "how is state recorded, and can it be reconstructed?":

```
  "how is state recorded and reconstructed?" — down the layers

  ┌────────────────────────────────────────────┐
  │ CapabilityEvent trace                       │ → APPEND-ONLY log of what happened.
  │                                             │   never mutated, only emitted.
  └────────────────────┬───────────────────────┘
      ┌────────────────▼─────────────────────────┐
      │ replay artifacts (artifacts/replays/*.json)│ → the log persisted; the
      │                                            │   recorded ModelResponse[] is the
      │                                            │   "event store" to replay from
      └────────────────┬───────────────────────────┘
          ┌────────────▼─────────────────────────┐
          │ FixtureModelProvider replay           │ → re-execute from the log →
          │                                       │   deterministic reconstruction
          └───────────────────────────────────────┘
```

The seam is the boundary between *recording* (emit events) and *replaying*
(re-execute from the record). The state axis flips across it: on the recording
side, state is mutable and live; on the replay side, it's a frozen log you
deterministically re-derive output from. That flip is the event-sourcing pattern,
even though AptKit uses it to make non-deterministic agents testable rather than
to recover production state.

## How it works

### Move 1 — the mental model: undo by doing the opposite

You know transactions from a DB: `BEGIN ... COMMIT`, and on error `ROLLBACK`
erases everything. A saga is what you do when the steps span systems that have no
shared `ROLLBACK` — you record each completed step and, on failure, run its
*compensating* action (the manual undo).

```
  Saga — compensation instead of rollback (general)

  step 1: reserve inventory   ──ok──►  step 2: charge card  ──ok──► step 3: ship
       │                                    │                            │ FAIL
       │  on step-3 failure, run compensations IN REVERSE:               │
       └─ unreserve inventory ◄── refund card ◄─────────────────────────┘

  no global ROLLBACK exists across 3 systems → you UNDO each completed step.
```

The load-bearing part people forget: **every forward step needs a defined
compensating step** — and compensation can itself fail, so it must be idempotent
and retryable (back to `03`). A saga with a missing or non-idempotent compensation
is a saga that strands state.

### Move 2 — the event-sourcing analog, and the absences

**The analog: trace as event log + replay as reconstruction.** AptKit records
what happened as a stream of `CapabilityEvent`s (append-only, never mutated),
persists the model responses into an artifact, and can re-execute the whole
capability deterministically by feeding those recorded responses back through a
`FixtureModelProvider`. Same log → same output. That's the event-sourcing
recovery shape: don't store the *result*, store the *events*, and rebuild by
replaying.

```
  Event sourcing analog — record events, rebuild by replay

  LIVE RUN:    loop ──emits──► [step, tool_call, model_usage, ...]  ──persist──┐
                                                                                │
  ARTIFACT:    { provider, trace[], modelTurns[], output } ◄────────────────────┘
                                  │ the recorded ModelResponse[] = the event store
  REPLAY:      FixtureModelProvider returns recorded responses in order
                                  │ deterministic re-execution
                                  ▼
               same output, every time — reconstruction from the log
```

Why this is genuinely the pattern and not a stretch: the artifact is the *source
of truth*, the output is *derived* from replaying it, and replay is
deterministic. Swap "tests" for "production recovery" and you have event sourcing
verbatim. AptKit uses it to pin non-deterministic agents to a correctness
baseline (promoted fixtures), which is arguably a *better* use than recovery.

**The absences (`not yet exercised`), each with its trigger:**

- **Sagas / compensating transactions:** none. *Trigger: a multi-step workflow
  with side effects across systems where a late step can fail (e.g. tool 1 posts
  to system A, tool 2 to system B, and B fails).*
- **2PC / distributed transactions:** none. *Trigger: a write that must commit
  atomically across two stores — almost always the wrong choice; prefer a saga.*
- **Transactional outbox:** none. *Trigger: needing to write to a DB and publish
  an event atomically.*
- **Reconciliation:** none. *Trigger: two systems holding related state that can
  drift, needing a periodic job to detect and repair divergence.*

### Move 3 — the principle

**When you can't have a transaction across a boundary, you record what you did so
you can undo it or rebuild it.** Sagas (compensation) and event sourcing
(replay-to-rebuild) are two faces of that idea — both replace atomic guarantees
with a durable log of steps. AptKit only has the log-and-replay face, and only
for testing — but recognizing that the trace *is* an event store, and replay *is*
reconstruction, is what lets you say "I'd add compensation on top of this the day
a tool gets a side effect."

## Primary diagram

```
  Cross-boundary workflow landscape — AptKit's position

  EVENT LOG + REPLAY (AptKit) ──── SAGA ──── 2PC ──── OUTBOX/RECONCILIATION
   trace (append-only)             compensation       atomic write+publish
   FixtureModelProvider replay     on failure
      ▲                                ▲                      ▲
      │                                │                      │
   here: record events,         not yet exercised      not yet exercised
   rebuild by deterministic     (trigger: multi-step    (trigger: write to 2
   replay (used for TESTS)       side-effecting          stores that must agree)
                                 workflow)
```

## Implementation in codebase

**Use cases.** The trace is emitted on every agent run. Artifacts are written
after live runs and consumed by the eval pipeline and Studio replay. Promoted
fixtures (recorded `ModelResponse[]`) are the correctness baselines re-run
deterministically.

**The append-only event log.**

```
  packages/runtime/src/events.ts  (lines 1-28)

  type CapabilityEvent = step | tool_call_start | tool_call_end
                       | model_usage | warning | error;   ← the recorded vocabulary
  type CapabilityTraceSink = { emit(event): void };        ← append-only: emit, never edit
       │
       └─ each event carries capabilityId + ISO timestamp. it's never mutated after
          emission — that immutability is what makes it an event LOG, not a state blob.
```

**Deterministic replay — reconstruction from the log.**

```
  packages/agents/recommendation/src/fixture-provider.ts  (lines 11-17)

  async complete(request) {
    this.requests.push(request);
    const response = this.responses[this.index];  ← next recorded event (ModelResponse)
    this.index += 1;
    if (!response) throw new Error('fixture model exhausted ...');  ← log fully consumed
    return response;                              ← replay in recorded order → deterministic
  }
```

**The replay driver — re-evaluate from persisted artifacts.**

```
  packages/evals/src/replay-runner.ts  (lines 30-94)

  listReplayArtifacts(dir)          ← reads the event stores in deterministic order (sort)
    → for each: readFile → JSON.parse → evaluateReplayArtifact(...)
       └─ re-derives the eval verdict from the recorded log, not a live run.
          re-running the same artifacts yields the same report — reconstruction.
```

**`not yet exercised`:** no compensating-action code, no `BEGIN/COMMIT` across
systems, no outbox table, no reconciliation job. The trace records but never
*compensates* — because there are no external side effects to undo (tools are
read-only, per the project context's least-privilege policy).

## Elaborate

Sagas come from a 1987 Garcia-Molina & Salem paper on long-lived transactions;
they're now the default pattern for microservice workflows precisely because 2PC
blocks on coordinator failure and doesn't scale. The transactional outbox is the
standard fix for the "dual-write problem" (write DB + publish message without a
distributed transaction). Event sourcing — store events, derive state by replay —
underpins systems like Kafka-as-source-of-truth and CQRS architectures; AptKit's
replay-from-recorded-responses is a small, honest instance of exactly that idea,
turned toward deterministic testing. The reason AptKit needs no sagas is the same
reason it needs no idempotency keys (`03`): its one external operation has no
durable side effect to undo. Add a side-effecting tool and the whole saga
apparatus becomes relevant overnight.

## Interview defense

**Q: "You've got a multi-step agent. How do you handle a failure halfway
through?"**

"Today there's nothing to compensate — the steps are read-only model and tool
calls with no external side effects, so a mid-run failure just means we re-run.
The trace is an append-only event log and replay is deterministic, so I already
have the event-sourcing substrate. The day a tool gets a side effect, I'd layer a
saga on top: each forward step gets a compensating action, run in reverse on
failure."

```
  read-only steps  → failure = re-run (no compensation needed)   ← AptKit today
  side-effecting   → saga: record each step, compensate in reverse on failure
```

Anchor: "The trace at `events.ts:1-28` is the log; `FixtureModelProvider` at
`fixture-provider.ts:11-17` replays it deterministically. That's event sourcing —
I'd build compensation on the same recorded steps."

**Q: "Why not 2PC for cross-system writes?"**

"2PC blocks forever if the coordinator dies mid-commit, and it doesn't scale.
Sagas trade atomicity for compensation and stay available. Both are `not yet
exercised` here because there's no second system to write to."

## Validate

1. **Reconstruct:** Explain a saga's compensation flow and why every forward step
   needs a defined, idempotent compensating step.
2. **Explain:** In what concrete sense is AptKit's trace + replay an
   event-sourcing instance? Cite the log (`events.ts:1-28`) and the replay
   (`fixture-provider.ts:11-17`).
3. **Apply:** A new tool POSTs an order to an external system. Sketch the saga:
   the forward step, its compensation, and where the trace records it.
4. **Defend:** Argue that no sagas is correct today, naming *why* there's nothing
   to compensate (hint: the tool policy in the project context).

## See also

- `03-idempotency-deduplication-and-delivery-semantics.md` — replay determinism
  and why compensations must be idempotent.
- `06-queues-streams-ordering-and-backpressure.md` — the event log as a stream.
- `study-system-design` — replay-centric evaluation as an architectural backbone.
