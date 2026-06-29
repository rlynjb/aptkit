# Per-Tool Circuit Breaking

**Industry term:** per-tool circuit breaker (fail fast on a dead tool, feed state back to the agent). *Industry standard.*

## Zoom out, then zoom in

Single-call retry handles one flaky request. An agent loop can call the *same flaky tool on every turn* — retrying a dead tool inside a loop multiplies the failure by the iteration count and burns the whole budget. aptkit handles tool errors per-call but has no per-tool breaker.

```
  Zoom out — not built; aptkit catches a tool error but doesn't break the circuit

  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  try { callTool } catch → return error as observation        │ ← we are here
  │  no breaker: a dead tool can be retried every turn            │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: **Not yet exercised in aptkit.** `runAgentLoop` catches a tool error and feeds it back to the model as an observation (`run-agent-loop.ts:163`), which is good — the agent *sees* the failure. But there's no circuit breaker tracking that tool X has failed N times and short-circuiting future calls. The loop's `maxToolCalls` is the only thing bounding repeated calls to a dead tool.

## How it works

**Use case it would fit:** a future aptkit tool that hits an external service (buffr's pgvector over the network, or a web-search tool) which goes down mid-run. Today the agent could spend its whole budget retrying it.

### Move 1 — the breaker, scoped to a tool

```
  Agent calls tool X
       │
       ▼
  ┌───────────────────────────────────────────────┐
  │  Circuit breaker (per tool)                    │
  │   closed:    calls pass through                │
  │   N fails →  OPEN: fail fast, don't call tool  │
  │   after T:   half-open, try one                │
  └───────────────────────────────────────────────┘
       │ tool X open?
       ▼
  Agent observes "tool X unavailable" and routes
  around it (different tool / degrade / escalate)
```

### Move 2 — the walkthrough

**What aptkit has: per-call error-as-observation.** When a tool throws, the loop catches it and feeds the error back so the model can react:

```ts
// run-agent-loop.ts:163 — tool error becomes an observation the agent sees
} catch (error) {
  isError = true;
  toolCall.error = error instanceof Error ? error.message : String(error);
  resultContent = truncate(JSON.stringify({ error: toolCall.error }));
}
// ...pushed back as a tool_result with isError: true (:181)
```

This is the right *information flow* — the agent isn't blind to the failure. But there's no *state*: the loop doesn't remember tool X failed last turn, so if the model retries X, the loop dutifully calls it again. The only backstop is `maxToolCalls`, which would let the agent burn its entire budget on a dead tool.

**What a per-tool breaker would add.** State across turns: after N failures of tool X, OPEN the circuit and fail fast (don't even call it), then half-open after a cooldown. Crucially — feed the open state back to the agent as an observation, so the agent's reasoning can route around the dead tool instead of looping on it. A breaker that just fails fast *without telling the agent* leaves the agent retrying the same dead path. That feedback loop is the agent-specific twist.

**The shift from single-call breaking.** In single-call serving, the breaker protects *your* service from hammering a broken dependency. Here it does that *and* informs the agent, so the agent routes around the dead tool. That dual role — protect the dependency, inform the reasoning — is what makes it a per-tool, agent-aware breaker rather than a generic one.

**The tradeoff and what it prevents.** A per-tool breaker adds state the runtime carries across turns (which tools are open, cooldown timers). What it prevents is the expensive failure: without it, one dead tool plus an agent loop equals the entire iteration budget spent on retries — the worst cost blowup because it produces nothing. This is the control that turns the "tool-call cascade" failure mode ([../03-multi-agent-orchestration/09-coordination-failure-modes.md](../03-multi-agent-orchestration/09-coordination-failure-modes.md)) from a budget-ending event into a routed-around inconvenience. **Not yet exercised** in aptkit.

### Move 3 — the principle

A per-tool circuit breaker fails fast on a dead tool *and* feeds the open state back to the agent so it routes around it — protecting the dependency and informing the reasoning at once. aptkit feeds tool errors back per-call (good) but carries no cross-turn breaker state (the gap), so a dead tool is bounded only by `maxToolCalls`. The breaker is what turns "budget spent on retries" into "agent picks a different path."

## Primary diagram

```
  Per-tool circuit breaking — aptkit's gap

  aptkit now:  callTool throws → error fed back as observation ✓
               but NO cross-turn state → model can retry the dead tool
               only backstop: maxToolCalls (whole budget on a dead tool)

  with a breaker:  N fails → OPEN → fail fast + tell the agent
                   → agent routes around (different tool / degrade / escalate)
                   half-open after cooldown
  prevents: the tool-call cascade from eating the entire budget for nothing
  (Not yet exercised)
```

## Elaborate

The per-tool circuit breaker is the agent-loop version of a pattern every distributed system has: stop hammering a dead dependency. The agent-specific upgrade is the feedback — a generic breaker just fails fast, but an agent needs to *know* the tool is open so its reasoning routes around it, otherwise it keeps choosing the dead path and the breaker just turns slow failures into fast ones without changing the outcome. aptkit's error-as-observation flow is half the pattern (the agent sees failures); the missing half is the stateful breaker that remembers and short-circuits. Without it, the worst case — a dead tool draining the whole budget to produce nothing — is the most expensive failure mode an agent has.

## Interview defense

**Q: A tool the agent depends on goes down mid-run. What happens, and what should happen?**

Today aptkit catches the error and feeds it back as an observation, so the agent sees the failure — but there's no cross-turn breaker, so if the model retries the tool, the loop calls it again, bounded only by `maxToolCalls`. Worst case: the whole budget spent retrying a dead tool, producing nothing. What should happen: a per-tool breaker that opens after N failures, fails fast, *and tells the agent* so it routes around the dead tool.

```
  now:    error → observation (agent sees it) but retries it (no breaker state)
  fix:    N fails → OPEN + inform agent → agent routes around (degrade/escalate)
```

*Anchor: a breaker that fails fast without informing the agent just makes the agent retry the same dead path faster — the feedback is the point.*

## See also

- [../01-reasoning-patterns/02-agent-loop-skeleton.md](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the error-as-observation flow aptkit already has.
- [../03-multi-agent-orchestration/09-coordination-failure-modes.md](../03-multi-agent-orchestration/09-coordination-failure-modes.md) — the tool-call cascade this bounds.
- Single-call retry / circuit-breaker mechanics: `.aipe/study-ai-engineering/06-production-serving/`.
