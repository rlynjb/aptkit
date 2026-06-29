# Shared State and Message Passing

**Industry standard.** "Shared state / blackboard," "message passing," "context routing." Type label: coordination mechanism. **In this codebase: message-passing-shaped, not yet a multi-agent system.** aptkit's pipeline stages pass *typed messages* (`Anomaly`, `Diagnosis`) between agents via function arguments — that's message passing in the small. There's no shared blackboard, because there's no concurrent topology to share one.

## Zoom out, then zoom in

How agents communicate. Two models: shared state (a blackboard every agent reads and writes) or message passing (each agent sees only what's passed to it). aptkit's stage handoffs are message passing — explicit, typed, scoped — which is the production-favored model.

```
  Zoom out — aptkit passes typed messages, holds no blackboard

  Shared state (blackboard):       Message passing (aptkit's stages):
  ┌──────────────────────┐         diagnostic ──Diagnosis──► recommendation
  │   shared context     │         (each agent gets ONLY its typed input)
  │  (all agents R/W)    │
  └──────────────────────┘         ← APTKIT IS HERE (in the small)
   ▲      ▲       ▲
   A      B       C
```

## Structure pass

**Axis: what does each agent see?** Shared state: everything (every agent reads the whole blackboard). Message passing: only what's passed. Trace it through aptkit's stages: the recommendation agent sees a `Diagnosis` and an `Anomaly` — not the monitoring agent's full scan, not raw metrics it doesn't need. The seam is the typed handoff (`propose(anomaly, diagnosis)`), which scopes each agent's context to exactly its inputs. That scoping is message passing's whole advantage.

## How it works

### Move 1 — the mental model

Shared state is a global variable every function reads and writes; message passing is function arguments. You know the difference — a global the whole app mutates vs passing exactly the props a component needs. Message passing is props; shared state is a global store every agent can touch.

```
  Two communication models

  Shared state (blackboard):       Message passing:
  all agents R/W one context       agent A ──msg──► agent B
  → simple, but everyone sees      agent B ──msg──► agent C
    everything (context bloat)     → scoped, but you decide what to pass
```

### Move 2 — aptkit's typed message passing, and the tradeoff it sidesteps

**aptkit passes typed messages between stages.** The recommendation agent receives exactly its inputs:

```typescript
// packages/agents/recommendation/src/recommendation-agent.ts:64
async propose(anomaly: Anomaly, diagnosis: Diagnosis, ...): Promise<Recommendation[]>
//            ^^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^ ← the messages; nothing more
```

It does *not* get a shared blackboard with the monitoring agent's full output, the raw metrics, or every other agent's state. It gets a typed `Anomaly` and a typed `Diagnosis`. That's message passing with a compile-time contract — the type *is* the message schema.

**The tradeoff message passing wins here.** Shared state is simple to reason about but every agent sees everything — and that causes context bloat: the lost-in-the-middle problem scales with the number of agents, because each agent's context window fills with other agents' output it doesn't need. Message passing scopes each agent's context to what it needs (cheaper, less noise) but requires *deciding what to pass* — and a bug there means an agent acts on missing information. aptkit dodges the bug risk by making the messages *typed*: you can't forget to pass the `diagnosis`, because `propose` won't compile without it.

**The production answer is multi-agent context routing**, and it's a direct application of SECTION D's context engineering: pass role-specific context to each agent. aptkit's typed signatures are context routing in miniature — each agent's input type defines its context scope. If aptkit built a supervisor-worker topology, the supervisor would route each worker's slice of context, and the existing typed I/O is the contract for that routing.

**What aptkit lacks: a shared store for a concurrent topology.** Message passing works for a sequential pipeline (one message at a time, in order). A fan-out topology where workers need a *shared findings store* keyed by sub-question (SECTION F template 1) would need something blackboard-shaped — and aptkit's vector store could serve that (the memory engine already writes to a shared store, partitioned by a `kind` tag). But no agent does this yet.

### Move 3 — the principle

Shared state is simple but bloats context as agents multiply; message passing scopes context but needs you to decide what to pass. The production answer is context routing — role-specific context per agent — and typed messages are the cheap, safe version because the type system catches a forgotten message. aptkit's typed stage handoffs are message passing done right; it just hasn't needed a shared store yet.

## Primary diagram

```
  aptkit's typed message passing — full frame

  ┌─ monitoring agent ──► Anomaly ──────────────────────────┐
  │                                                          │
  │  ┌─ diagnostic agent.diagnose(anomaly) ──► Diagnosis ──┐ │
  │  │                                                     │ │
  │  │  ┌─ recommendation.propose(anomaly, diagnosis) ──┐ │ │
  │  │  │  sees ONLY its typed inputs (scoped context)  │ │ │
  │  │  └────────────────────────────────────────────────┘ │ │
  │  └──────────────────────────────────────────────────────┘ │
  └────────────────────────────────────────────────────────────┘
  type = message schema; can't forget to pass (won't compile)
  NO shared blackboard (no concurrent topology needs one yet)
```

## Elaborate

The shared-state-vs-message-passing choice is the multi-agent version of an old systems question (shared memory vs message-passing concurrency). The field's lesson for agents is sharp: shared blackboards bloat context and trigger lost-in-the-middle as agents multiply, so production multi-agent systems route scoped context per agent. aptkit's typed I/O is a head start — the messages are already defined and type-checked. The only missing piece for a concurrent topology is a shared findings store, and the vector store (with its `kind`-tag partitioning, see the memory engine) is the natural substrate.

## Interview defense

**Q: How do your agents share data?**
Typed message passing, not a shared blackboard. The recommendation agent's signature is `propose(anomaly, diagnosis)` — it receives exactly its inputs as typed messages and sees nothing else. That scopes each agent's context to what it needs and dodges the bug message passing usually risks (forgetting to pass something) because the type won't compile without it. No shared store, because I have no concurrent topology that needs one.

```
  type = message schema → scoped context + can't-forget-to-pass
```
*Anchor: typed message passing is context routing done cheaply and safely.*

**Q: When would you need a shared store?**
A fan-out where workers contribute to a shared findings store keyed by sub-question. My vector store could serve that — the memory engine already writes a shared store partitioned by a `kind` tag — but no agent does it yet.

## See also

- `03-sequential-pipeline.md` — the typed handoffs as pipeline dependencies
- `04-agent-infrastructure/01-context-engineering.md` — context routing as a discipline
- `04-agent-infrastructure/02-agent-memory-tiers.md` — the shared `kind`-partitioned store
- `study-ai-engineering/` — lost-in-the-middle mechanics (cross-ref)
