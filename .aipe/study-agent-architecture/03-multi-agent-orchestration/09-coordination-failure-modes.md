# Coordination Failure Modes

**Industry standard.** "Coordination failures," "multi-agent failure modes." Type label: failure taxonomy. **In this codebase: mostly not yet exercised** — these are the failures that don't exist in single-agent systems, so aptkit (single-agent) doesn't have most of them. But aptkit *does* have the single-agent ancestors of two (cost blowup, tool-call cascade), and its existing controls are the seeds of the multi-agent mitigations.

## Zoom out, then zoom in

The failures that appear *only* when agents coordinate. aptkit is single-agent, so it's immune to the topology-specific ones (infinite handoff, synthesis failure) — but the cost and tool-cascade failures have single-agent versions aptkit already controls, and those controls scale up to the multi-agent mitigations.

```
  Zoom out — which failures aptkit can even have

  ┌─ single-agent (aptkit) ─────────────────────────────────┐
  │  has: tool-call cascade, cost blowup (in-loop versions)  │ ← we are here
  │  immune: infinite handoff, context bloat across agents,  │
  │          synthesis failure (no topology to have them)    │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: which failures need >1 agent?** Trace each failure against "could this happen with one agent?" Infinite handoff and synthesis failure need a topology — aptkit can't have them. Cost blowup and tool-call cascade have single-agent roots — aptkit has them, and controls them. Context bloat across shared state needs multiple agents — aptkit's typed message passing pre-empts it. The seam: aptkit's per-loop controls (`maxToolCalls`, `maxTurns`, the usage ledger) are the single-agent versions of the multi-agent mitigations.

## How it works

### Move 1 — the mental model

Each coordination failure is "the single-agent loop's failure, multiplied by the number of agents." The mitigations are the same controls, scoped up from one loop to the whole topology.

```
  The five coordination failures and their mitigations

  ┌──────────────────────┬──────────────────────────┐
  │ Failure              │ Mitigation               │
  ├──────────────────────┼──────────────────────────┤
  │ Infinite handoff     │ Handoff counter; force   │
  │ (A→B→A→B…)            │ stop or escalate to human│
  ├──────────────────────┼──────────────────────────┤
  │ Tool-call cascade    │ Per-agent + global        │
  │ (storm of calls)     │ iteration caps; budget    │
  ├──────────────────────┼──────────────────────────┤
  │ Context bloat across │ Message passing / context │
  │ shared state         │ routing, not a blackboard │
  ├──────────────────────┼──────────────────────────┤
  │ Synthesis failure    │ Validate worker outputs   │
  │ (merge contradictions│ against a schema; surface │
  │ )                    │ conflicts, don't average  │
  ├──────────────────────┼──────────────────────────┤
  │ Cost blowup          │ Per-run token budget;     │
  │ (2-5x, silent)       │ cheap workers, expensive  │
  │                      │ supervisor only           │
  └──────────────────────┴──────────────────────────┘
```

### Move 2 — each failure, mapped to aptkit's existing controls

**Tool-call cascade → aptkit already controls the single-agent version.** One agent firing a storm of tool calls is bounded by `maxToolCalls` (rag-query: 4, recommendation: 4, rubric: 3) and `maxTurns`. In multi-agent, you add a *global* cap across all agents on top of the per-agent caps. aptkit has the per-agent half; the global half is the addition.

```typescript
// the per-agent cap aptkit already enforces (rag-query-agent.ts:76)
maxTurns: 6, maxToolCalls: 4,   // ← the single-agent version of the cascade control
```

**Cost blowup → aptkit has the ledger; multi-agent adds the per-run budget.** aptkit tracks usage in a `usage-ledger`, and its provider layer enables "cheap workers, expensive supervisor only." The single-agent version is the per-loop `maxTokens` (default 4096, `run-agent-loop.ts:88`). The multi-agent version is a per-*run* budget across all agents — a sum aptkit doesn't compute yet because there's one agent per run.

**Context bloat across shared state → aptkit pre-empts it with typed message passing.** This failure scales with the number of agents sharing a blackboard. aptkit uses typed message passing (file 08), so each agent's context is scoped to its inputs — the failure can't accumulate. aptkit already chose the mitigation, before having the failure.

**Synthesis failure → not exercised (no synthesis step).** A supervisor merging contradictory worker results, averaging instead of surfacing the conflict. aptkit has no supervisor, so no synthesis to fail. The mitigation (validate worker outputs against a schema before merging) maps onto aptkit's existing per-agent validators — `tryParseRecommendations`, `validateRubricImprovementResult`, the precision@k scorers — which already schema-validate each agent's output. A supervisor would reuse those validators at the merge point.

**Infinite handoff → impossible in aptkit (no handoff).** Covered in the swarm file. The mitigation (a handoff counter) is the multi-agent analog of `maxToolCalls`.

### Move 3 — the principle

The "2-5x overhead" of multi-agent becomes concrete in these five failures — they're the specific ways the overhead shows up. The reassuring part: every mitigation is a control aptkit already has in single-agent form (caps, ledger, validators, typed message passing). Going multi-agent isn't inventing new controls; it's scoping the existing ones up from one loop to a topology. aptkit's single-agent discipline is the foundation that makes a future multi-agent build safe.

## Primary diagram

```
  aptkit's single-agent controls → multi-agent mitigations

  SINGLE-AGENT (aptkit has)          MULTI-AGENT (scope up)
  ─────────────────────────          ──────────────────────
  maxToolCalls (per loop)      ──►    + global cascade cap
  maxTokens / usage-ledger     ──►    + per-RUN token budget
  typed message passing        ──►    (pre-empts context bloat)
  per-agent validators         ──►    schema-gate at merge (synthesis)
  maxTurns budget exit         ──►    handoff counter (anti-infinite-loop)
```

## Elaborate

These failure modes are why "don't go multi-agent prematurely" is scar tissue, not theory — each one is a real way a multi-agent system burns money or produces garbage silently. The encouraging frame for aptkit: it's not starting from zero. Its single-agent loops already enforce caps, track cost, validate outputs, and scope context. A multi-agent build inherits all of that and adds three things — a global cap, a per-run budget, and (if it has handoff) a handoff counter. The controls compose upward.

## Interview defense

**Q: What new failures would multi-agent introduce, and are you ready for them?**
Five: infinite handoff, tool-call cascade, context bloat across shared state, synthesis failure, and cost blowup. The reassuring part is I already control the single-agent versions — per-agent `maxToolCalls` and `maxTurns` bound the cascade, the usage ledger and `maxTokens` bound cost, typed message passing pre-empts context bloat, and per-agent validators are the schema gate a supervisor would reuse at merge. Going multi-agent scopes those up: a global cap, a per-run budget, a handoff counter.

```
  every mitigation = an existing single-agent control, scoped up
```
*Anchor: multi-agent doesn't need new controls, just the existing ones at topology scope.*

**Q: How would a supervisor avoid merging contradictory results?**
Validate worker outputs against a schema before synthesis and surface conflicts rather than averaging. My agents already schema-validate their own output (`tryParseRecommendations`, the rubric validator); a supervisor reuses those validators at the merge point.

## See also

- `01-when-not-to-go-multi-agent.md` — the "2-5x overhead" these failures make concrete
- `02-agent-loop-skeleton.md` — the per-loop caps that scale up
- `05-production-serving/03-per-tool-circuit-breaking.md` — the tool-cascade control in detail
- `04-agent-infrastructure/05-guardrails-and-control.md` — the control envelope these live in
