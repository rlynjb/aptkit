# When NOT to Go Multi-Agent

**Industry term:** the multi-agent escalation gate (single-agent baseline first). *Industry standard.*

## Zoom out, then zoom in

This file comes first by design. The single most important multi-agent decision is whether to be multi-agent at all. aptkit's answer is "not yet," and that's the correct call — this file is why.

```
  Zoom out — aptkit sits on the single-agent side of the gate

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  6 INDEPENDENT single-agent capabilities                     │ ← we are here
  │  no supervisor, no handoff, no shared blackboard             │
  │             ┌──── THE GATE ────┐                             │
  │             │ cross only on a  │  ← aptkit has not crossed    │
  │             │ named, decomposable failure                    │
  └─────────────┴──────────────────┴─────────────────────────────┘
```

Zoom in: each aptkit agent is one `runAgentLoop` with its own prompt, tools, and budget. Nothing coordinates them. A host app may call them in sequence (monitor → diagnose → recommend), but no aptkit code makes one agent invoke another. The escalation gate below is the framework for deciding whether that *should* change — and the honest read is it shouldn't, yet.

## The structure pass

**Layers.** A single-agent baseline (bottom) and a multi-agent topology (top), with the gate between them.

**Axis: cost — what does crossing the gate cost?** Roughly 2-5x coordination overhead and a much larger debugging surface (you now debug the conversation *between* agents).

**The seam.** The gate itself. Crossing it is justified only when single-agent has a *named, decomposable* failure — not when multi-agent sounds advanced.

## How it works

**Use case in aptkit:** the recommendation lineage. The blooming-insights app ran monitor → investigate → recommend as a coordinated pipeline. aptkit extracted each as a standalone single-agent capability. The gate question: should aptkit re-introduce orchestration, or leave coordination to the host?

### Move 1 — the mental model

It's the same instinct as "don't reach for microservices before the monolith hits its ceiling." Build the single thing, measure it, and split only when you can name the specific pain a split fixes.

```
  ┌───────────────────────────────────────────────┐
  │ 1. Build a single-agent (ReAct) baseline       │
  │ 2. Measure: success rate, tool-call accuracy,  │
  │    latency, cost                               │
  │ 3. Identify the SPECIFIC failure single-agent  │
  │    cannot fix                                   │
  │ 4. Is that failure genuinely decomposable      │
  │    into independent specialties?               │
  │       │                                         │
  │       ├─ no  → stay single-agent, fix the       │
  │       │        prompt / tools / retrieval        │
  │       └─ yes → escalate to the SPECIFIC          │
  │                topology that addresses it        │
  └───────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**aptkit built the baseline and stopped — correctly.** Each capability is a ReAct loop with a least-privilege tool allowlist and an output validator. There's no measured failure that a single agent can't address. The recommendation agent gathers evidence across 13 tools and proposes; it doesn't need a separate "analyst agent" and "writer agent" — the path is short and the specialties don't cleanly split.

**The cost of crossing, made concrete.** Today, debugging a bad recommendation means reading one trace: one agent's tool calls and final output (`CapabilityEvent` stream). Cross the gate and you debug the *conversation* — agent A's output became agent B's input, B misread it, C synthesized garbage. That's 2-5x the work and a new class of bugs (the coordination failures in [09-coordination-failure-modes.md](09-coordination-failure-modes.md)) that don't exist in a single loop.

**Why aptkit's separation is NOT multi-agent.** The three analytics agents *look* like a pipeline, but the pipeline lives in the host app, not in aptkit. aptkit ships them as independent capabilities precisely so a host can compose them however it wants — sequence them, run one alone, or orchestrate them. The orchestration is deliberately *out of scope* for the core. That's a design decision, not a missing feature: keeping coordination in the deployment layer (buffr, blooming-insights) keeps the core deployment-agnostic.

**The reader has crossed this gate before.** In blooming-insights, monitor → investigate → recommend ran as a coordinated pipeline with typed handoffs. That was justified: the stages are genuinely separate specialties with typed contracts between them. aptkit's choice to *extract the agents but leave the orchestration in the app* is the senior move — the topology belongs where deployment concerns live, not in a reusable core.

### Move 3 — the principle

Multi-agent adds roughly 2-5x coordination overhead and a much larger debugging surface; the quality gain is often modest unless the problem genuinely splits into specialties. Build single-agent, measure, and cross the gate only on a named decomposable failure. aptkit's answer — "the capabilities are extracted as single agents; orchestration belongs to the host" — earns the senior-grade interview line: "I considered multi-agent and kept it out of the core, because coordination is a deployment concern, not a reusable one."

## Primary diagram

```
  The gate — aptkit's position

  single-agent baseline (aptkit: 6 capabilities, measured, working)
        │
        ▼
  ┌──────────────────────────────────────────────┐
  │ named failure single-agent can't fix?          │  aptkit: NO
  │ genuinely decomposable into specialties?        │  aptkit: orchestration
  └──────────────────────────────────────────────┘  belongs to the HOST
        │ no (aptkit)                  │ yes
        ▼                              ▼
  stay single-agent            escalate to the SPECIFIC topology
  (fix prompt/tools/retrieval) (supervisor / pipeline / fan-out / ...)
```

## Elaborate

The "don't go multi-agent prematurely" rule is production scar tissue — it comes from teams that shipped multi-agent systems and paid the coordination tax for a modest quality gain. The honest breakpoint: multi-agent earns its overhead when the work splits into specialties with clean contracts between them (blooming-insights' typed handoffs qualify) and doesn't when you're just chopping one agent's job into pieces that still share all the context. aptkit's design — single-agent capabilities, orchestration left to the host — is the right factoring for a *reusable core*: it doesn't decide the topology, it ships the pieces a topology would compose.

## Interview defense

**Q: Why is aptkit single-agent when the source app was a pipeline?**

Because orchestration is a deployment concern, not a reusable-core one. aptkit extracted the three analytics agents as independent capabilities so a host app can compose them — sequence, run one, or orchestrate. blooming-insights ran them as a coordinated pipeline; that topology lives in the app, where deployment concerns belong.

```
  blooming-insights:  monitor → investigate → recommend  (orchestrated IN the app)
  aptkit:             3 independent capabilities          (host composes them)
```

*Anchor: the core ships the pieces; the host owns the topology. Crossing the gate is a deployment decision.*

**Q: When would you add orchestration to aptkit itself?**

Only on a named, decomposable failure that a single agent can't fix and that every host would face — otherwise it belongs in the host. I'd measure the single-agent baselines first; if a capability genuinely needed two specialists with a clean contract between them, that's the gate. Nothing in the six capabilities is there yet.

*Anchor: 2-5x coordination overhead is real; cross the gate on evidence, not aesthetics.*

## See also

- [02-supervisor-worker.md](02-supervisor-worker.md) — the first topology to reach for once the gate is crossed.
- [09-coordination-failure-modes.md](09-coordination-failure-modes.md) — the new bug classes crossing the gate introduces.
- [../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md](../06-orchestration-system-design-templates/01-multi-agent-research-assistant.md) — the refactor toward a topology.
