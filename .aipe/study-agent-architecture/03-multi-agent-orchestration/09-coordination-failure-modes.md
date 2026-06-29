# Coordination Failure Modes

**Industry term:** multi-agent coordination failure modes. *Industry standard.*

## Zoom out, then zoom in

The failures that don't exist in single-agent systems. aptkit, being single-agent, doesn't face most of them — but it already has the *controls* that would bound them, because the single-agent loop needs the same caps for different reasons.

```
  Zoom out — aptkit has the controls, not the failures

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  single-agent: faces cost/cascade caps, NOT inter-agent      │ ← we are here
  │  failures (no handoff → no infinite handoff, etc.)           │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Most of these are not yet exercised in aptkit** — they require multiple coordinating agents. But aptkit's per-loop caps (`maxTurns`, `maxToolCalls`, the forced synthesis turn) are exactly the controls a multi-agent system would need at the *per-agent* and *global* level. This file maps each failure to its mitigation and to what aptkit already has.

## How it works

**Use case:** the file where "2-5x coordination overhead" becomes concrete — these are the specific ways the overhead shows up and the specific controls that bound it.

### Move 1 — the failure-mitigation map

```
  ┌──────────────────────┬──────────────────────────┐
  │ Failure              │ Mitigation               │
  ├──────────────────────┼──────────────────────────┤
  │ Infinite handoff     │ Handoff counter; force    │
  │ (A→B→A→B…)            │ stop or escalate to human │
  ├──────────────────────┼──────────────────────────┤
  │ Tool-call cascade    │ Per-agent and global      │
  │ (one agent triggers  │ iteration caps; budget    │
  │ a storm of calls)    │ ceiling that halts the run│
  ├──────────────────────┼──────────────────────────┤
  │ Context bloat as      │ Message passing / context │
  │ agents accumulate     │ routing instead of a       │
  │ shared state         │ shared blackboard          │
  ├──────────────────────┼──────────────────────────┤
  │ Synthesis failure    │ Validate worker outputs    │
  │ (supervisor merges    │ against a schema before    │
  │ contradictory results│ synthesis; surface         │
  │ )                    │ conflicts, don't average   │
  ├──────────────────────┼──────────────────────────┤
  │ Cost blowup          │ Per-run token budget;      │
  │ (2-5x overhead       │ cheap models for workers,  │
  │ compounds silently)  │ expensive only for the     │
  │                      │ supervisor                 │
  └──────────────────────┴──────────────────────────┘
```

### Move 2 — the walkthrough, mapped to aptkit

**Infinite handoff** — not possible in aptkit (no handoff). A swarm adoption would need a handoff counter on day one ([06-swarm-handoff.md](06-swarm-handoff.md)).

**Tool-call cascade** — aptkit already bounds this *within* one agent. `maxToolCalls` caps the calls, and the forced synthesis turn withholds tools at the budget:

```ts
// run-agent-loop.ts:101 — the per-agent cap that would also serve as the global cap
const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
const forceFinal = turn === maxTurns - 1 || budgetSpent;  // halts the cascade
```

A multi-agent system would add a *global* budget across all agents on top of this per-agent one — but the per-agent control is the same code.

**Context bloat** — aptkit avoids it by construction (typed message-passing, no blackboard; [08-shared-state-and-message-passing.md](08-shared-state-and-message-passing.md)). The lost-in-the-middle problem scales with agent count under a blackboard; aptkit's scoped contracts don't.

**Synthesis failure** — aptkit's per-agent validators (`validate.ts`, `tryParseRecommendations`) are exactly the "validate before trusting" control, applied to a single agent's output. A supervisor would validate *each worker's* output against a schema before merging, and surface conflicts rather than averaging them. aptkit has the per-output validator; it lacks the merge step (no supervisor).

**Cost blowup** — aptkit's provider abstraction is the lever. The "cheap models for workers, expensive only for the supervisor" pattern maps directly onto aptkit's swappable `ModelProvider`: a supervisor could run a cloud model and workers run local Gemma. The per-run token budget would extend `maxTokens`/`maxToolCalls` to a run-wide ceiling. **Not yet exercised** as a multi-agent budget.

### Move 3 — the principle

The "2-5x overhead" of multi-agent shows up as five concrete failures, each with a specific bounding control. aptkit already runs the per-agent versions of those controls (iteration caps, output validators, scoped context) for single-agent reasons; a multi-agent system would lift them to the global level and add the inter-agent ones (handoff counter, conflict-surfacing synthesis). The controls aren't new — their *scope* is.

## Primary diagram

```
  Coordination failures vs aptkit's existing per-agent controls

  failure (multi-agent)        aptkit today (single-agent)
  ──────────────────────       ───────────────────────────
  infinite handoff       →     N/A (no handoff)
  tool-call cascade      →     maxToolCalls + forced synthesis turn ✓
  context bloat          →     typed message-passing, no blackboard ✓
  synthesis failure      →     per-agent validate.ts (no merge step yet)
  cost blowup            →     swappable ModelProvider (cheap workers possible)
                               run-wide budget: not yet exercised
```

## Elaborate

These failure modes are where multi-agent's coordination tax is actually paid — not in the happy path, but in the storm of tool calls, the bloated context, the contradictory merge, the silent cost compounding. The reason "build single-agent first" is a rule is that each of these is a debugging surface that doesn't exist below one agent. aptkit's quiet advantage if it ever scales up: it built the per-agent controls (caps, validators, scoped context) as table stakes for a single loop, so the multi-agent versions are a scope change, not a new design.

## Interview defense

**Q: What new failures appear when you go multi-agent, and is aptkit ready for them?**

Five: infinite handoff, tool-call cascade, context bloat, synthesis failure, cost blowup. aptkit already runs the per-agent controls for three of them — iteration caps bound cascades, typed message-passing avoids bloat, per-agent validators guard output. What it lacks is the global scope (run-wide budget) and the inter-agent ones (handoff counter, conflict-surfacing merge).

```
  controls exist per-agent (caps, validators, scoped context)
  → multi-agent lifts them to global + adds handoff counter / merge validation
```

*Anchor: the controls aren't new in multi-agent — their scope is. aptkit built the per-agent versions as table stakes.*

## See also

- [01-when-not-to-go-multi-agent.md](01-when-not-to-go-multi-agent.md) — where the "2-5x overhead" claim originates.
- [../05-production-serving/03-per-tool-circuit-breaking.md](../05-production-serving/03-per-tool-circuit-breaking.md) — the cascade control at the tool level.
- [../04-agent-infrastructure/05-guardrails-and-control.md](../04-agent-infrastructure/05-guardrails-and-control.md) — the control envelope these caps belong to.
