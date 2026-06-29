# Prompt chaining

> Multi-step decomposition (Industry standard)

One giant prompt that "analyze the data, find problems, diagnose them, and recommend fixes" is the junior move. It overflows the context, blurs responsibility, and when it goes wrong you can't tell *which* part failed. Prompt chaining splits the work into stages where each stage has one job and feeds the next. aptkit's analytics pipeline is exactly this: anomaly-monitoring (scan) → diagnostic-investigation (investigate one anomaly) → recommendation (propose ≤3 actions). Three separate capabilities, three separate prompts, output of one becoming input to the next. What aptkit *doesn't* have yet is a single orchestrator that runs the chain end-to-end — each link exists, but the wiring is the gap.

## Zoom out, then zoom in

The pipeline is a directed chain. Raw data enters the first capability; each capability narrows the problem and hands a typed result to the next. The data shape shrinks and sharpens at every hop — from "all metrics" to "the anomalies" to "one diagnosis" to "a few actions."

```
The analytics chain — one job per link (LAYERS)

  metrics / signals
        │
        ▼  ┌─────────────────────────────────────────────┐
           │ ANOMALY-MONITORING   "scan: what's wrong?"    │  capability 1
           │ runAgentLoop → Anomaly[]                      │  monitoring-agent.ts
           └─────────────────────────────────────────────┘
        │  Anomaly[]
        ▼  ┌─────────────────────────────────────────────┐
           │ DIAGNOSTIC-INVESTIGATION "why this one?"      │  capability 2
           │ runAgentLoop → Diagnosis                      │  diagnostic-agent.ts
           └─────────────────────────────────────────────┘
        │  Diagnosis
        ▼  ┌─────────────────────────────────────────────┐
           │ RECOMMENDATION   "what to do (≤3)?"           │  capability 3
           │ runAgentLoop → Recommendation[]               │  recommendation-agent.ts
           └─────────────────────────────────────────────┘
        │  Recommendation[]
        ▼
  ★ each link = its own capabilityId, its own prompt, its own typed output
```

Each box is a complete, independently-runnable capability. The arrows are typed handoffs. The chain is the composition — currently assembled by callers, not by a single orchestrator.

## Structure pass

One axis: **the responsibility boundary — what each link is allowed to decide**.

- **anomaly-monitoring** — decides *what's anomalous*. Returns `Anomaly[]`. `packages/agents/anomaly-monitoring/src/monitoring-agent.ts`, its own `ANOMALY_MONITORING_CAPABILITY_ID` (13), one `runAgentLoop` (66).
- **diagnostic-investigation** — decides *why one anomaly happened*. Takes an anomaly, returns a `Diagnosis`. `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts`, its own `DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID` (12), one `runAgentLoop` (64).
- **recommendation** — decides *what to do about it*, capped at three. Takes a diagnosis, returns `Recommendation[]`. `packages/agents/recommendation/src/recommendation-agent.ts`, its own `RECOMMENDATION_CAPABILITY_ID` (20), one `runAgentLoop` (77).

The seam is the typed output of each loop. `runAgentLoop<Anomaly[]>` → `runAgentLoop<Diagnosis>` → `runAgentLoop<IdlessRecommendation[]>`. The contract between links is a TypeScript type, not a shared mutable blob — so a link can be tested, replayed, or swapped in isolation.

## How it works

**Move 1 — the mental model.** Think of an assembly line, not a single craftsman. Each station does one operation on the part and passes it down. If a recommendation is bad, you don't re-examine the whole factory — you look at the recommendation station, because its input (the diagnosis) is right there, typed and inspectable.

```
The chain as separate capabilities (PATTERN)

  runAgentLoop<Anomaly[]>      runAgentLoop<Diagnosis>     runAgentLoop<Rec[]>
  capabilityId: monitoring  →  capabilityId: diagnostic →  capabilityId: recommend
  prompt: "scan"               prompt: "investigate"       prompt: "propose ≤3"
        │                            │                           │
        └── Anomaly[] ───────────────┘── Diagnosis ──────────────┘── Recommendation[]
  each link: own prompt package, own trace, own typed result
```

**Move 2 — walk the links.**

**Link 1 — scan returns a typed list of anomalies.** Its only job is detection; it doesn't diagnose or fix.

```
monitoring-agent.ts (13, 66)                 one job: detect
  capabilityId: ANOMALY_MONITORING_...  ────  its own capability identity (13)
  const { parsed } =
    await runAgentLoop<Anomaly[]>({       ──  own loop, own prompt (66)
      capabilityId: ANOMALY_MONITORING_..., });
  → Anomaly[]                             ──  typed handoff to link 2
```

`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:66` runs a dedicated loop that returns `Anomaly[]`. That list is the entire contract it exposes downstream.

**Link 2 — investigate one anomaly, return a diagnosis.** It receives an anomaly and goes deep on causation — a narrower, more expensive job than scanning.

```
diagnostic-agent.ts (12, 64)                 one job: explain why
  capabilityId: DIAGNOSTIC_INVESTIGATION_...─ separate identity (12)
  const { toolCalls, parsed } =
    await runAgentLoop<Diagnosis>({        ── own loop (64)
      capabilityId: DIAGNOSTIC_..., });
  → Diagnosis                              ── typed handoff to link 3
```

`packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:64`. It takes the output of link 1's choice (an anomaly) and produces a `Diagnosis`. Because it's a separate capability, its trace and errors are isolated — a failure here doesn't muddy the scan's record.

**Link 3 — recommend at most three actions.** It turns a diagnosis into bounded, actionable output.

```
recommendation-agent.ts (20, 77)             one job: propose ≤3
  capabilityId: RECOMMENDATION_...      ────  separate identity (20)
  const { parsed } =
    await runAgentLoop<IdlessRecommendation[]>({ ─ own loop (77)
      capabilityId: RECOMMENDATION_..., });
  → Recommendation[]                     ──  the chain's final output
```

`packages/agents/recommendation/src/recommendation-agent.ts:77`. The ≤3 cap is a deliberate scope limit — bounded output is easier to act on and to evaluate.

**The gap — there's no single orchestrator.** Each link runs as its own capability; nothing in the repo calls all three in sequence end-to-end as one entry point. Callers (and Studio) compose them. Wiring an explicit orchestrator is the Case A exercise.

**Move 3 — the principle.** Decompose so each step has one job, one prompt, one typed output. The payoff is three-fold: **focused context** (each prompt only carries what its job needs, so no single call bloats the window — ties straight back to [01-context-window.md](01-context-window.md)), **isolated errors** (a bad diagnosis is debuggable at its own `capabilityId`, with its own trace), and **per-step model choice** (the cheap scan could run on a smaller/cheaper model while the expensive diagnosis runs on a stronger one — the chain doesn't force one model for everything).

## Primary diagram

```
The chain: built links, missing wiring

  anomaly-monitoring   ████  Anomaly[]      monitoring-agent.ts:66
        ↓ typed handoff
  diagnostic-invest.   ████  Diagnosis      diagnostic-agent.ts:64
        ↓ typed handoff
  recommendation       ████  Recommendation[] recommendation-agent.ts:77
  ──────────────────────────────────────────────────────────────
  end-to-end ORCHESTRATOR  ░░░░  not yet wired  ← Case A exercise
```

## Elaborate

Why three capabilities beat one mega-prompt, concretely: each link's prompt package only describes *its* job, so the scan prompt never carries diagnosis instructions and the recommendation prompt never re-explains anomaly categories. That keeps every individual request small (the context-window win) and keeps each prompt easy to iterate without regressing the others. It also means you can replay or eval any single link in isolation — the promoted-fixture loop in [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md) freezes each capability independently.

The per-step model-choice angle is the strongest interview point. Scanning many metrics for anomalies is a high-volume, lower-judgment task — a smaller model is fine. Diagnosing root cause is low-volume, high-judgment — worth a stronger model. A monolithic prompt forces you to pay for the strongest model on the *whole* job; the chain lets you spend where judgment is actually needed. The honest caveat: aptkit *enables* per-step model choice (each `runAgentLoop` takes its own `ModelProvider`) but the repo doesn't yet ship a config that runs different models per link — and there's no single orchestrator running the chain end to end.

## Project exercises

### Wire the three capabilities into an explicit end-to-end orchestrator

- **Exercise ID:** `EX-CTX-03a`
- **What to build:** An orchestrator function that runs anomaly-monitoring → (pick an anomaly) → diagnostic-investigation → recommendation as one call, threading each link's typed output into the next and emitting a combined trace. This realizes the Phase 1 (context) prompt-chaining pipeline as a single entry point instead of caller-assembled steps.
- **Why it earns its place:** Every link exists but the chain itself is implicit. An explicit orchestrator makes the decomposition real, gives the whole pipeline one replayable artifact, and is the natural place to later assign a cheaper model to the scan step.
- **Files to touch:** new orchestrator module composing `packages/agents/anomaly-monitoring/src/monitoring-agent.ts` (66), `.../diagnostic-investigation/src/diagnostic-agent.ts` (64), `.../recommendation/src/recommendation-agent.ts` (77).
- **Done when:** one call takes raw signals to a `Recommendation[]`, the intermediate `Anomaly[]` and `Diagnosis` are inspectable, and a failure in any link is attributable to its `capabilityId`.
- **Estimated effort:** `1–2 days`

### Run the scan link on a cheaper model

- **Exercise ID:** `EX-CTX-03b`
- **What to build:** In the orchestrator from `EX-CTX-03a`, inject a smaller/cheaper `ModelProvider` into anomaly-monitoring while keeping a stronger model for diagnosis, and record the per-link token cost.
- **Why it earns its place:** It turns the conceptual "cheaper model early" benefit into a measured one — proving the chain's cost advantage over a monolith.
- **Files to touch:** the orchestrator from `EX-CTX-03a`; the `ModelProvider` passed to `monitoring-agent.ts:66`.
- **Done when:** the scan step demonstrably uses a different provider than diagnosis, and per-link token totals are reported.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why three capabilities instead of one prompt?**

```
  one job per link → focused context, isolated errors, per-step model choice
  monolith → bloated window, can't tell which part failed, one model for all
```

Anchor: three distinct `capabilityId`s and `runAgentLoop` calls — `monitoring-agent.ts:66`, `diagnostic-agent.ts:64`, `recommendation-agent.ts:77`.

**Q: What's the contract between links?**

```
  runAgentLoop<Anomaly[]> → runAgentLoop<Diagnosis> → runAgentLoop<Recommendation[]>
  typed output, not a shared mutable blob
```

Anchor: each loop returns a typed `parsed` result that becomes the next link's input.

**Q: What's missing?**

Anchor: no single end-to-end orchestrator — links are caller-assembled; and per-step model differentiation is enabled (each loop takes its own `ModelProvider`) but not yet shipped. Honest gaps.

## See also

- [01-context-window.md](01-context-window.md) — chaining keeps each link's request inside the window.
- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — focused per-step context avoids the dead zone too.
- [../05-evals-and-observability/01-eval-set-types.md](../05-evals-and-observability/01-eval-set-types.md) — each link is frozen independently as a fixture.
