# Multi-agent pipeline — monitor → diagnose → recommend

**Industry names:** Agent pipeline / staged orchestration / typed handoff (vs. a single mega-agent). **Type:** Industry standard (the typed output→input chaining is project-specific).

## Zoom out, then zoom in

This is a flow *across* three agents in the capability band. Don't look for it inside one agent — look at the seams *between* them, where one agent's output becomes the next agent's input.

```
  Zoom out — where the pipeline lives

  ┌─ Orchestration — apps/studio (vite.config.ts, agent-runners.ts) ────┐
  │  fixed-order wiring: scan → investigate → propose                   │ ← we are here
  └───────────────────────────┬──────────────────────────────────────────┘
                              │  output of stage N = input of stage N+1
  ┌─ Capability layer — packages/agents/* ────▼──────────────────────────┐
  │  anomaly-monitoring ──► diagnostic-investigation ──► recommendation   │
  │  scan() → Anomaly[]      investigate(a) → Diagnosis  propose(a,d) →    │
  │                                                       Recommendation[] │
  └───────────────────────────┬──────────────────────────────────────────┘
                              │  each stage = one bounded agent loop (02-)
  ┌─ Runtime core ────────────▼──────────────────────────────────────────┐
  │  runAgentLoop x3, sequential                                          │
  └──────────────────────────────────────────────────────────────────────┘
```

Now zoom in. You know this shape from a data pipeline or a `.then().then().then()` chain: each stage transforms its input and passes a typed result downstream. The pattern is **staged orchestration** — instead of one giant agent that monitors, diagnoses, and recommends all at once, three *narrow* agents each do one job, and code wires them in a fixed order. The handoff is **typed**: `scan()` returns `Anomaly[]`, `investigate(anomaly)` takes one of those and returns `Diagnosis`, and `propose(anomaly, diagnosis)` takes *both* and returns `Recommendation[]`. The convergence at the end — recommendation needing the original anomaly *and* the diagnosis — is the part worth studying.

## Structure pass

**Layers:** orchestration (fixed order, code-owned) → the three agents (each an LLM loop) → the runtime loop. One axis pulls it apart.

**Axis — who decides control flow?** (the same axis from `00-overview.md`, now across the pipeline)

```
  "who decides what happens next?" — traced across the pipeline

  ┌─ pipeline (Studio wiring) ─┐  → CODE decides the ORDER
  │ scan → investigate →propose│    (fixed: monitor always first)
  └──────────────┬─────────────┘
        ┌─────────▼──────────────┐ → LLM decides WITHIN a stage
        │ one agent's runAgentLoop│   (which tools, what to conclude)
        └─────────┬──────────────┘
              ┌────▼────────────┐ → CODE decides the bound
              │ maxTurns budget │   (02-bounded-agent-loop)
              └─────────────────┘
```

The control answer flips: code owns the *order between* stages, the LLM owns the *reasoning within* a stage, code owns the *budget* under that. The verdict, stated plainly: **it's a hybrid — a fixed pipeline on the outside, an autonomous loop on the inside.** The seam that matters is the boundary *between* stages — that's where a typed value crosses from one agent to the next, and where the whole thing is wired in Studio rather than in a package (the architectural smell; audit red-flag 1). Hand off to How it works.

## How it works

#### Move 1 — the mental model

The shape is a typed transformation chain with a convergence at the end. Think of a function composition where each function's return type must match the next's parameter type — except the last function needs *two* of the earlier values, not just the immediately prior one.

```
  The pipeline — typed handoff with a convergence

   scan()
     │  Anomaly[]
     ▼  (pick one anomaly)
   investigate(anomaly: Anomaly)
     │  Diagnosis
     ▼
   propose(anomaly: Anomaly, diagnosis: Diagnosis)   ◄── needs BOTH
     │  Recommendation[]
     ▼
   (≤3 grounded recommendations)

   anomaly ────────────────────────────────┐
                                            │ (carried forward, not just diagnosis)
   diagnosis ──────────────────────────────┤
                                            ▼
                                      propose(anomaly, diagnosis)
```

The convergence is the non-obvious part: recommendation doesn't just take the *latest* output (the diagnosis), it takes the *original* anomaly too. The diagnosis explains *why*; the anomaly says *what and how bad*. You need both to propose a grounded fix.

#### Move 2 — the step-by-step walkthrough

**Stage 1 — monitor scans, returns a list.** `anomaly-monitoring.scan()` takes no input, runs its bounded loop against the workspace metrics, and returns `Anomaly[]` (each with metric, scope, change, severity, evidence). The bridge: it's a `GET /anomalies` that returns a sorted collection. The boundary condition: it returns `[]` rather than failing when nothing's wrong — an empty list is a valid, meaningful result, and the pipeline must handle "no anomalies" without crashing.

```
  stage 1 output
  scan() → [ { metric: 'revenue', scope: ['SP'], severity: 'high', ... }, ... ]
```

**Stage 2 — diagnose takes one anomaly, returns a verdict.** The orchestrator picks an anomaly and calls `investigate(anomaly)`, which runs *its* bounded loop (with a *wider* tool grant — 11 tools vs monitoring's 4, because diagnosis needs to inspect campaigns, experiments, segments) and returns a `Diagnosis`: a conclusion, the hypotheses it considered (each marked supported/not), evidence, and a confidence. The bridge: it's a worker that takes one job off the queue and produces a structured result. The boundary condition: the `Anomaly` type must be *shared* between the two agent packages — diagnostic-investigation imports the same `Anomaly` shape monitoring produces. If those drift, the handoff breaks at the type seam.

```
  Layers-and-hops — anomaly crossing the stage-1→stage-2 seam

  ┌─ monitoring agent ──┐ hop 1: scan() returns Anomaly[]
  │ scan()              │ ──────────────────────────────────────►┐
  └─────────────────────┘                                        │
  ┌─ orchestrator ──────┐ hop 2: pick anomaly[i]                 ▼
  │ (Studio wiring)     │ ──► investigate(anomaly) ─► ┌─ diagnostic agent ─┐
  └─────────────────────┘                            │ runs its own loop  │
                          hop 4: Diagnosis ◄───────── │ returns Diagnosis  │
                                                       └────────────────────┘
```

**Stage 3 — recommend takes both, returns actions.** `recommendation.propose(anomaly, diagnosis)` runs the tightest loop (`maxTurns: 6, maxToolCalls: 4`) and returns ≤3 grounded `Recommendation[]`. The bridge: it's the final reducer that takes accumulated state and produces output. The boundary condition — *this is the convergence* — it takes **two** inputs, not one. The orchestrator must hold onto the original anomaly through stage 2 and pass it alongside the diagnosis. A naive linear pipe (each stage gets only the prior output) would lose the anomaly and recommendation would be flying half-blind.

```
  stage 3 input — the convergence
  propose(
    anomaly,    ← from stage 1 (what/how-bad), carried THROUGH stage 2
    diagnosis,  ← from stage 2 (why)
  ) → Recommendation[]
```

**Each stage is independently testable.** Because the handoffs are typed values (not shared mutable state), you can test diagnosis in isolation by feeding it a fixture `Anomaly`, and test recommendation by feeding it a fixture `{ anomaly, diagnosis }` pair (`packages/agents/recommendation/fixtures/sp-revenue-drop.json` has exactly that shape). The bridge: it's the testability dividend of pure functions — typed in, typed out, no hidden coupling.

#### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** Three narrow agents, each `input → output` typed; a fixed-order orchestrator; and a *shared type vocabulary* (`Anomaly`, `Diagnosis`) so stage N+1 can consume stage N's output. The convergence (recommendation takes anomaly *and* diagnosis) is part of the kernel, not optional.

2. **Name each part by what breaks if removed.**
   - Remove the **stage separation** (collapse to one mega-agent) → one loop with all ~28 tools doing everything; harder to bound, harder to test, harder to reason about which step failed. You lose the ability to test "diagnosis given a known anomaly" in isolation.
   - Remove the **shared type vocabulary** → the handoff is `any`-shaped; a change in monitoring's output silently breaks diagnosis at runtime instead of at compile time.
   - Remove the **carried-forward anomaly** (pipe only the latest output) → recommendation gets the diagnosis but not the original signal; recommendations lose their grounding in *what* and *how bad*.
   - Remove the **fixed order** → there's no orchestrator; a caller has to know diagnosis depends on monitoring, which re-couples them.

3. **Skeleton vs hardening.** Skeleton: the three typed stages, the shared types, the convergence, the order. Hardening: the per-stage tool grants (each stage gets only what it needs — `04-`), the trace events flowing out of each loop, the fixtures for isolated testing. The pipeline *runs* with just the skeleton; the hardening makes it bounded, observable, and testable.

The interview payoff: name the **convergence** — recommendation takes both the anomaly and the diagnosis. The naive answer is "it's a linear pipe, each stage feeds the next." The detail that shows you've designed a real pipeline is recognizing that the final stage needs an *earlier* value carried forward, not just the immediately preceding one. That's the difference between a chain and a fan-in.

#### Move 2.5 — current state vs where it should live

The pipeline *works*, but it's wired in the wrong place. Worth seeing the gap explicitly:

```
  Phase A (now)                          Phase B (if it's a real capability)
  ─────────────                          ──────────────────────────────────
  orchestration in apps/studio           orchestration in a package
  (vite.config.ts, agent-runners.ts)     (e.g. packages/agents/pipeline)
                                          with its own capabilityId + contract
  a host app importing core gets 5       a host app gets a pipeline() it can call
  agents but must RE-WIRE the order       directly; order is shipped, not demoed
       │                                       │
       └─ the pipeline is DEMONSTRATED,        └─ the pipeline is SHIPPED
          not exported
```

The migration cost is low: lift the `scan → investigate → propose` wiring out of Studio into a package, give it a `capabilityId`, and re-export it from core. What *doesn't* change: the three agents, their types, their loops. That's the payoff of typed handoffs — the orchestration is thin and movable. (audit red-flag 1.)

#### Move 3 — the principle

Many narrow agents beat one wide agent. Splitting monitor/diagnose/recommend into separate bounded loops with typed handoffs buys you isolated testing, independent tool grants (least privilege per stage), bounded cost per stage, and clear failure attribution — at the cost of an orchestrator that owns the order. A single mega-agent is simpler to wire and harder to trust; the staged pipeline is the production-grade shape.

## Primary diagram

The full recap — three stages, the typed handoffs, the convergence, the orchestration seam.

```
  Multi-agent pipeline — full picture

  ┌─ orchestration (currently apps/studio) — owns the ORDER ──────────────┐
  │                                                                       │
  │  scan() ──Anomaly[]──► pick one ──► investigate(anomaly) ──Diagnosis──┐│
  │   │                                                                   ││
  │   │  anomaly carried forward ──────────────────────────────────────┐ ││
  │   ▼                                                                 ▼ ▼│
  │  [stage 1: monitor]   [stage 2: diagnose]   propose(anomaly, diagnosis)│
  │   4 tools, read-only   11 tools, read-only   13 tools → Recommendation[]│
  │   maxTurns 8           maxTurns 8            maxTurns 6                 │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 │  each stage = one bounded agent loop (02-)
  ┌─ runtime ────────────────────▼─────────────────────────────────────────┐
  │  runAgentLoop, sequential, emits CapabilityEvent[] per stage            │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Studio's demo runs the full chain: scan the workspace, pick an anomaly, diagnose it, propose fixes — each step streaming its trace to the UI. The recommendation fixture (`sp-revenue-drop.json`) bakes in a known `{ anomaly, diagnosis }` pair so the recommendation stage can be replayed and evaluated in isolation, without re-running the upstream stages. That's the testability dividend in action.

**The convergence — recommendation takes both** — `packages/agents/recommendation/src/recommendation-agent.ts` (lines 65–93):

```
  async propose(anomaly: Anomaly, diagnosis: Diagnosis, runOptions) {  ← lines 65-66
       │
       └─ TWO inputs. anomaly (from stage 1) + diagnosis (from stage 2). This is
          the fan-in. A linear pipe would pass only the diagnosis and lose the
          original signal.

    const { parsed } = await runAgentLoop<IdlessRecommendation[]>({   ← line 77
      capabilityId: RECOMMENDATION_CAPABILITY_ID,
      ...
      maxTurns: 6, maxToolCalls: 4,                                   ← lines 86-87
      synthesisInstruction: buildSynthesisInstruction(...),          ← line 88
    });
  }
```

**The upstream stages' signatures** — the typed handoff:

```
  packages/agents/anomaly-monitoring/src/monitoring-agent.ts
    scan(): Promise<Anomaly[]>                    ← stage 1 output (line ~57, 66)

  packages/agents/diagnostic-investigation/src/diagnostic-agent.ts
    investigate(anomaly: Anomaly): Promise<Diagnosis>   ← stage 2 (line ~55, 64)
       │
       └─ investigate's INPUT type (Anomaly) is the SAME shape scan() OUTPUTS.
          Both agent packages share the Anomaly type — that shared vocabulary is
          what makes the handoff compile-time safe. Drift them and stage 2 breaks.
```

**The wiring (the smell)** — `apps/studio/vite.config.ts` and `apps/studio/src/agent-runners.ts`:

```
  // vite.config.ts (~line 558, 596, 639) and agent-runners.ts (~lines 34, 65, 97)
  const anomalies = await monitoringAgent.scan();            ← stage 1
  const diagnosis  = await diagnosticAgent.investigate(fixture.anomaly);  ← stage 2
  const recs       = await recommendationAgent.propose(fixture.anomaly,
                                                       fixture.diagnosis); ← stage 3
       │
       └─ This orchestration lives in the Studio DEV APP, not in a package. A host
          app importing @rlynjb/aptkit-core gets the 5 agents but NOT this wiring —
          it has to rebuild the order itself. If the pipeline is a product
          capability, it belongs in packages/ with a contract. (audit red-flag 1.)
```

## Elaborate

This is the multi-agent orchestration pattern: decompose a complex task into specialized agents and coordinate them, versus a single agent with a huge tool surface. The tradeoff is well-known — specialization buys testability, least privilege, and bounded cost per stage; orchestration adds a coordination layer you have to own. AptKit picks specialization, which is the right call for a capabilities library (each agent is independently useful and shippable).

The *agent-reasoning* view — how each agent reasons internally, when multi-agent beats single-agent for a given task, orchestration topologies (pipeline vs supervisor vs swarm) — belongs to study-agent-architecture when generated; that guide owns "multi-agent orchestration" as an agent-design concern. This guide owns it as a *system* concern: typed handoffs, the convergence fan-in, and the fact that the orchestration currently lives in the wrong layer.

Next: `06-replay-eval-pipeline.md` shows how each stage gets tested in isolation via fixtures — the dividend the typed handoff buys.

## Interview defense

**Q: Why three agents instead of one agent that does everything?**

Specialization. Three narrow agents each get their own bounded loop, their own least-privilege tool grant, and can be tested in isolation with fixtures. A single mega-agent with all the tools is simpler to wire but harder to bound, harder to test, and gives you no clean failure attribution. The cost is an orchestrator that owns the order.

```
  mega-agent:   one loop, all tools, do everything      (simple, untestable)
  pipeline:     scan → investigate → propose, typed     (testable, bounded per stage)
```

Anchor: three agents in `packages/agents/*`, wired in `apps/studio/src/agent-runners.ts`.

**Q: What's non-obvious about the data flow?**

It's not a straight pipe — it's a fan-in. The final stage, `propose`, takes *both* the original anomaly and the diagnosis, not just the latest output. The diagnosis says why; the anomaly says what and how bad. The orchestrator has to carry the anomaly forward through the diagnosis stage.

```
  anomaly ──────────┐ (carried through stage 2)
  diagnosis ────────┤
                    ▼  propose(anomaly, diagnosis)   ← fan-in, not linear pipe
```

Anchor: `recommendation-agent.ts:65-66` — the two-parameter signature.

## Validate

1. **Reconstruct.** From memory, write the three stage signatures and mark which inputs each takes. Identify the convergence. Check against `monitoring-agent.ts`, `diagnostic-agent.ts:55`, `recommendation-agent.ts:65-66`.
2. **Explain.** Why must `Anomaly` be a shared type between the monitoring and diagnostic packages? What breaks if they each define their own?
3. **Apply.** You want to test the recommendation stage without running monitoring or diagnosis. What do you feed it, and where does that fixture live? (Hint: `recommendation/fixtures/sp-revenue-drop.json`.)
4. **Defend.** The orchestration lives in `apps/studio` (audit red-flag 1). Argue what a host app loses today, and what the minimal fix is.

## See also

- `02-bounded-agent-loop.md` — each stage is one of these loops.
- `04-capability-as-tool-policy.md` — why each stage gets a different tool grant.
- `06-replay-eval-pipeline.md` — testing each stage in isolation via fixtures.
- `audit.md` lens 2 (the pipeline flow), red-flag 1 (orchestration in the wrong layer).
- study-agent-architecture (when generated) — multi-agent orchestration as agent design.
