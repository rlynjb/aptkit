# Shared State and Message Passing

**Industry term:** shared state (blackboard) vs message passing (agent communication models). *Industry standard.*

## Zoom out, then zoom in

How agents communicate. Two models: a shared blackboard all agents read and write, or scoped messages passed between them. aptkit has no inter-agent communication — but its one cross-agent connection (the typed handoff) is firmly message-passing, and that's the model it would extend.

```
  Zoom out — aptkit's only cross-agent link is a typed message

  ┌─ Host app ──────────────────────────────────────────────────┐
  │  Anomaly ─msg─► Diagnosis ─msg─► Recommendation[]            │  message-passing
  └───────┬───────────────┬───────────────┬──────────────────────┘
  ┌─ aptkit ──────────────────────────────────────────────────────┐
  │  no shared blackboard; each agent gets only its typed inputs   │ ← we are here
  └────────────────────────────────────────────────────────────────┘
```

Zoom in: **Not implemented as multi-agent communication in aptkit** (there's no second agent to talk to). But the design instinct is clear: each agent receives exactly its typed inputs (`Anomaly`, `Diagnosis`) and nothing else. No agent reads a global blackboard. That's message-passing by construction.

## How it works

**Use case it would fit:** any multi-agent topology aptkit adopted — the supervisor passing role-specific context to each worker rather than handing every worker the whole conversation.

### Move 1 — the two models

```
  Shared state (blackboard):       Message passing:
  ┌──────────────────────┐         agent A ──msg──► agent B
  │   shared context      │        agent B ──msg──► agent C
  │  (all agents read      │       (each agent sees only
  │   and write here)      │        what's passed to it)
  └──────────────────────┘
   ▲      ▲       ▲
   A      B       C
```

### Move 2 — the walkthrough

**aptkit's handoff is scoped message-passing.** The recommendation agent gets `(anomaly, diagnosis)` — exactly what it needs, nothing more:

```ts
// recommendation-agent.ts:64 — scoped message, not a shared blackboard
async propose(anomaly: Anomaly, diagnosis: Diagnosis, ...): Promise<Recommendation[]>
```

It does not get the monitoring agent's full reasoning trace, its other anomalies, or a global state object. Each agent's context is scoped to its typed inputs. That's the message-passing model: cheaper, less noise, but you must decide what to pass.

**The tradeoff that matters.** A shared blackboard is simple to reason about — everyone sees everything — but every agent sees everything, so context bloats and the lost-in-the-middle problem scales with the number of agents. Message passing scopes each agent's context to what it needs (cheaper, less noise) but requires deciding what to pass, and a bug there means an agent acts on missing information. aptkit's typed contracts make "what to pass" explicit and checkable — the `Diagnosis` type *is* the message contract.

**Multi-agent context routing is the production answer.** Passing role-specific context to each agent — the supervisor sends the retrieval worker the query, the synthesis worker the findings, not everything to everyone — is a direct application of SECTION D's context engineering ([../04-agent-infrastructure/01-context-engineering.md](../04-agent-infrastructure/01-context-engineering.md)). aptkit's `injectProfile` and per-agent prompt packages are the single-agent version of the same instinct: curate what fills *this* agent's window.

**What it would cost aptkit.** Nothing new structurally for message-passing — the typed contracts already scope it. A blackboard would be the *new* thing (a shared store all agents read/write), and aptkit's design actively avoids it. **Not yet exercised** as multi-agent communication.

### Move 3 — the principle

Shared state is simple but bloats every agent's context; message passing is cheaper but you must decide what to pass. The typed contract *is* the message — and making it explicit (as aptkit's `Anomaly`/`Diagnosis`/`Recommendation` types do) is what keeps message-passing safe. Context routing — role-specific context per agent — is the production answer and a direct application of context engineering.

## Primary diagram

```
  aptkit's communication model — scoped message-passing

  monitor ──Anomaly──► diagnose ──Diagnosis──► recommend
            (typed)              (typed)
  each agent's context = its typed inputs ONLY (no shared blackboard)
  the TYPE is the message contract; validate.ts checks it

  (a blackboard — all agents read/write one store — is deliberately avoided)
```

## Elaborate

The shared-state-vs-message-passing choice is the same one distributed systems made decades ago (shared memory vs message passing between processes), and the tradeoffs rhyme: shared state is easy until contention and bloat bite; message passing is disciplined but demands you define the protocol. For agents, the bloat cost is sharper because context is expensive and lost-in-the-middle degrades quality as the window fills. aptkit's typed-contract message-passing is the disciplined choice, and it composes cleanly into a multi-agent system: the supervisor would route role-specific messages, never a global blackboard.

## Interview defense

**Q: How would agents share information if aptkit went multi-agent?**

Message passing with typed contracts — the model it already uses for the host pipeline. Each agent gets exactly its typed inputs (`Anomaly`, `Diagnosis`), not a shared blackboard. That keeps each agent's context small and avoids the lost-in-the-middle bloat a blackboard causes when every agent sees everything. The type *is* the message contract, and `validate.ts` checks it.

```
  blackboard:  all see all  → simple but bloats context with N agents
  message-passing: scoped typed inputs → cheaper, must define the contract
  aptkit: typed contracts already do message-passing
```

*Anchor: the typed contract is the message; making it explicit is what keeps message-passing safe.*

## See also

- [03-sequential-pipeline.md](03-sequential-pipeline.md) — the typed handoffs that are message-passing.
- [../04-agent-infrastructure/01-context-engineering.md](../04-agent-infrastructure/01-context-engineering.md) — context routing, the production answer.
- [09-coordination-failure-modes.md](09-coordination-failure-modes.md) — context bloat as a failure mode.
