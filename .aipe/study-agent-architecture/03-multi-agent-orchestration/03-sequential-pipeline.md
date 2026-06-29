# Sequential / Pipeline

**Industry standard.** "Sequential pipeline," "agent chain," "stage pipeline." Type label: orchestration topology. **In this codebase: not yet exercised in aptkit — but this is the topology the sibling blooming_insights ships.** aptkit packages the stages as independent single agents; blooming_insights chains them `monitor → investigate → recommend`.

## Zoom out, then zoom in

The output of one agent feeds the next. This is the multi-agent topology closest to home for the reader — blooming_insights, the project aptkit's analytics agents were extracted from, runs exactly this 3-stage pipeline. aptkit holds the stages apart so they're reusable; the app composes them in sequence.

```
  Zoom out — the pipeline lives in the consumer, stages live in aptkit

  ┌─ aptkit (stages, independent) ──────────────────────────┐
  │  anomaly-monitoring · diagnostic-investigation ·         │ ← single agents
  │  recommendation                                          │
  └───────────────────────────┬──────────────────────────────┘
                              │ consumed and CHAINED by
  ┌─ blooming_insights (the pipeline) ────────────────────────┐
  │  monitor → investigate → recommend                        │ ← we point here
  │  docs/blooming-insights-aptkit-core-migration-plan.md     │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: dependency direction.** In a pipeline, stage N+1 *depends on* stage N's output — strictly forward. Trace it across the blooming_insights stages: monitoring emits anomalies → diagnostic consumes an anomaly, emits a diagnosis → recommendation consumes the diagnosis, emits actions. Each arrow is a hard dependency, which is exactly why it's a pipeline (sequential) and not a fan-out (parallel). The seam between stages is a typed handoff: an `Anomaly` flows to diagnostic, a `Diagnosis` flows to recommendation.

## How it works

### Move 1 — the mental model

A `.then()` chain of single-purpose functions, except each function is an agent. You know how a data pipeline is `parse().then(validate).then(transform)` — each step takes the last step's output? Same shape, where each step is a full agent loop.

```
  Sequential pipeline — each agent feeds the next

  ┌──────────┐ anomaly  ┌───────────┐ diagnosis ┌──────────────┐
  │ monitor  │ ───────► │ diagnose  │ ────────► │ recommend    │
  │ (agent)  │          │ (agent)   │           │ (agent)      │
  └──────────┘          └───────────┘           └──────────────┘
```

### Move 2 — the typed handoffs that prove the dependency

aptkit's agents have output types that line up into a pipeline — the strongest evidence the stages were built to compose:

**Stage 1 → 2: an `Anomaly` flows.** The diagnostic agent takes an anomaly and produces a diagnosis. Its method signature is the handoff contract.

**Stage 2 → 3: a `Diagnosis` flows.** The recommendation agent's `propose(anomaly, diagnosis)` (`recommendation-agent.ts:64`) takes *both* the anomaly and the diagnosis as input — it literally cannot run without stage 2's output.

```typescript
// packages/agents/recommendation/src/recommendation-agent.ts:64
async propose(anomaly: Anomaly, diagnosis: Diagnosis, ...): Promise<Recommendation[]>
//                              ^^^^^^^^^^^^^^^^^^^ ← stage 2's output is stage 3's input
```

That `diagnosis` parameter is the pipeline dependency made concrete. Inside aptkit, you call these agents separately. In blooming_insights, the app wires them: run monitoring, take an anomaly, run diagnostic, take the diagnosis, run recommendation. The migration plan (`docs/blooming-insights-aptkit-core-migration-plan.md:33-34`) confirms the monitoring and diagnostic agents are the upstream stages feeding recommendation.

**Why aptkit keeps them apart.** If aptkit chained them internally, you couldn't run the recommendation agent on a diagnosis you produced some other way, and you couldn't run monitoring standalone. Keeping the stages independent is what makes each one reusable — the pipeline is the *application's* composition, not the toolkit's.

### Move 3 — the principle

A pipeline gets you isolated failures (you know which stage broke), the freedom to run a cheaper model on early stages, and typed handoffs that document the dependency. Its cost is latency — the sum of all stages, no parallelism — which is correct here because the stages are genuinely dependent (you can't diagnose before monitoring finds the anomaly). aptkit's contribution is the typed stages; the pipeline is the consumer's.

## Primary diagram

```
  blooming_insights pipeline over aptkit stages — full frame

  ┌─ blooming_insights (orchestration) ─────────────────────────┐
  │                                                             │
  │  AnomalyMonitoringAgent ──Anomaly──►                        │
  │       (aptkit)                                              │
  │  DiagnosticInvestigationAgent.diagnose(anomaly) ──Diagnosis─►│
  │       (aptkit)                                              │
  │  RecommendationAgent.propose(anomaly, diagnosis) ──►Recs    │
  │       (aptkit, recommendation-agent.ts:64)                  │
  │                                                             │
  │  latency = sum of stages (sequential, hard dependencies)    │
  └──────────────────────────────────────────────────────────────┘
```

## Elaborate

The sequential pipeline is the multi-agent topology that's barely "multi-agent" — it's a chain where the links are agents. It earns its place when the stages are real specialties with hard dependencies (monitoring, diagnosis, recommendation are distinct expertise and strictly ordered). The reader has shipped exactly this in blooming_insights. aptkit's design lesson is the inverse: by *not* baking the pipeline into the toolkit, the stages stay independently testable (each has its own fixtures and replay evals) and independently reusable.

## Interview defense

**Q: You said aptkit is single-agent — but you've shipped a pipeline?**
Right, and the distinction matters. aptkit *packages* the stages — monitoring, diagnostic, recommendation — as independent single agents, each with typed I/O. blooming_insights, the consuming app, *chains* them: monitor emits an anomaly, diagnostic consumes it and emits a diagnosis, recommendation consumes both. You can see the dependency in the signature — `propose(anomaly, diagnosis)` can't run without stage 2's output. Toolkit holds them apart for reuse; app composes them in sequence.

```
  monitor ──Anomaly──► diagnose ──Diagnosis──► recommend
  (stages: aptkit, independent)   (pipeline: blooming_insights)
```
*Anchor: the typed handoff (`Diagnosis` param) IS the pipeline dependency.*

**Q: Why sequential, not parallel?**
Hard dependencies. You can't diagnose before monitoring finds the anomaly, can't recommend before diagnosis. The stages aren't independent, so fan-out doesn't apply — latency is the sum, and that's correct.

## See also

- `01-when-not-to-go-multi-agent.md` — why the toolkit stays single-agent
- `04-parallel-fan-out.md` — the contrast: independent stages run concurrently
- `08-shared-state-and-message-passing.md` — the typed handoffs as message passing
- `agent-patterns-in-this-codebase.md` — the independent stages inventory
