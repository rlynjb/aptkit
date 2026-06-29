# Sequential / Pipeline

**Industry term:** sequential agent pipeline (output of one agent feeds the next). *Industry standard.*

## Zoom out, then zoom in

Output of one agent feeds the next, in a fixed order. This is the topology the reader actually shipped in blooming-insights — monitor → investigate → recommend with typed handoffs — and the lineage aptkit's three analytics agents were extracted from.

```
  Zoom out — the pipeline lives in the host, not in aptkit

  ┌─ Host app (blooming-insights / buffr) ──────────────────────┐
  │  monitor agent → investigate agent → recommend agent         │  PIPELINE
  └───────┬───────────────┬───────────────┬──────────────────────┘
          ▼               ▼               ▼
  ┌─ aptkit capabilities (independent) ─────────────────────────┐
  │  anomaly-monitoring · diagnostic-investigation · recommendation│ ← we are here
  │  (each a standalone runAgentLoop; no inter-agent code)         │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit ships the three stages as *independent* capabilities. The pipeline that connects them — anomaly out of stage 1 feeds stage 2, diagnosis out of stage 2 feeds stage 3 — lives in the host. **Not implemented as aptkit orchestration**; it's the shape the host composes from aptkit's pieces.

## How it works

**Use case (the reader's lived one):** blooming-insights. Stage 1 finds anomalies, stage 2 diagnoses one, stage 3 recommends actions. The handoffs are typed — `Anomaly` → `Diagnosis` → `Recommendation[]` — which aptkit preserved in its agent signatures.

### Move 1 — the topology

It's a `.then()` chain of single-purpose functions, except each function is an agent. You've built this exact shape; the only twist is each stage is a model loop, not a pure function.

```
  ┌─────────┐   anomaly  ┌─────────┐  diagnosis  ┌─────────┐
  │ Agent A │ ─────────► │ Agent B │ ──────────► │ Agent C │
  │(monitor)│            │(diagnose)│            │(recommend)│
  └─────────┘            └─────────┘             └─────────┘
```

### Move 2 — the walkthrough

**aptkit preserves the typed handoff in the signatures, not in orchestration code.** The recommendation agent takes exactly what stage 2 produces:

```ts
// recommendation-agent.ts:64 — the typed handoff, made explicit in the signature
async propose(
  anomaly: Anomaly,        // ← from stage 1 (monitoring)
  diagnosis: Diagnosis,    // ← from stage 2 (diagnostic-investigation)
  runOptions: RecommendationRunOptions = {},
): Promise<Recommendation[]>
```

The host calls `monitor()`, takes an `Anomaly`, calls `investigate(anomaly)`, takes a `Diagnosis`, calls `propose(anomaly, diagnosis)`. aptkit defines the *contracts* (`Anomaly`, `Diagnosis`, `Recommendation`); the host wires the *order*. That's the pipeline split: typed contracts in the core, sequencing in the host.

**The benefit, same as single-purpose chains.** Isolated failures — you know which stage broke. You can run a cheaper model on early stages (monitoring is a scan; recommendation is reasoning). And each stage is independently testable, which is exactly what aptkit's per-agent fixtures do.

**The cost, same as single-purpose chains.** Latency is the sum of all stages — no parallelism. If stage 2 stalls, stage 3 waits. And the handoff is only as good as the contract: if `Diagnosis` is malformed, stage 3 acts on garbage. aptkit guards that with per-agent validators (`validate.ts`).

**Why it's NOT aptkit orchestration.** No aptkit code calls one agent from another. The typed signatures *enable* a pipeline; they don't *form* one. Calling this "aptkit's pipeline" would be wrong — it's the host's pipeline over aptkit's pieces.

### Move 3 — the principle

A pipeline is a `.then()` chain of agents: isolated, debuggable, cheap-model-friendly on early stages, but latency-additive and only as safe as the typed contract between stages. aptkit's contribution is the *typed handoff contracts*; the sequencing belongs to whoever deploys.

## Primary diagram

```
  The pipeline — contracts in aptkit, order in the host

  HOST:  monitor() ──Anomaly──► investigate(a) ──Diagnosis──► propose(a, d)
                                                              └─► Recommendation[]
  APTKIT: defines Anomaly / Diagnosis / Recommendation (typed contracts)
          + per-stage validators (validate.ts) guarding each handoff
          (no inter-agent call lives here)
```

## Elaborate

The sequential pipeline is the simplest multi-agent topology and the one most "multi-agent" systems actually are. Its discipline — typed contracts between stages — is what makes it debuggable; a pipeline with untyped string handoffs is a debugging nightmare. blooming-insights got this right with typed handoffs, and aptkit inherited the discipline by making each stage's input/output an explicit type. The latency cost (sequential, no parallelism) is the price of the dependency: stage 3 *needs* stage 2's output, so it can't run earlier — which is exactly the distinction from fan-out ([04-parallel-fan-out.md](04-parallel-fan-out.md)).

## Interview defense

**Q: Is the monitor → diagnose → recommend flow a pipeline aptkit implements?**

No — aptkit ships the three stages as independent capabilities with typed handoff contracts (`Anomaly` → `Diagnosis` → `Recommendation[]`). The host wires the sequence. blooming-insights ran it as a real pipeline; aptkit extracted the stages and kept the typing so a host can rebuild the pipeline cleanly.

```
  aptkit:  typed contracts + per-stage validators  (the safe handoff)
  host:    the .then() order over those stages       (the pipeline)
```

*Anchor: typed contracts between stages are what make a pipeline debuggable; aptkit owns the contracts, the host owns the order.*

## See also

- [04-parallel-fan-out.md](04-parallel-fan-out.md) — the parallel cousin, for independent stages.
- [08-shared-state-and-message-passing.md](08-shared-state-and-message-passing.md) — the typed handoff is message-passing.
- [../06-orchestration-system-design-templates/02-agentic-support-system.md](../06-orchestration-system-design-templates/02-agentic-support-system.md) — a pipeline reframed as an interview answer.
