# Per-Tool Circuit Breaking

**Industry standard.** "Circuit breaker," "per-tool breaker," "fail-fast with feedback." Type label: serving optimization. **In this codebase: not yet exercised — but the loop has the exact hook a breaker would plug into.** aptkit catches tool errors and feeds them back as observations (`run-agent-loop.ts:163-186`); no breaker tracks repeated failures or fails fast yet.

## Zoom out, then zoom in

Single-call retry handles one flaky request. An agent loop can call the *same flaky tool* on every turn — retrying a dead tool inside a loop multiplies the failure by the iteration count and burns the whole budget on a tool that isn't coming back. aptkit turns tool errors into observations (so the agent *can* route around) but has no breaker to fail fast on a repeatedly-dead tool.

```
  Zoom out — per-tool circuit breaking (the hook exists, breaker doesn't)

  Agent calls tool X
       │
  ┌────▼──────────────────────────────────────────────────────┐
  │  Circuit breaker (per tool) ── would track N fails → OPEN  │ ← would be here
  └────┬──────────────────────────────────────────────────────┘
       ▼ open? feed "tool X unavailable" back to the agent
  Agent routes around it (existing hook: errors → observations)
```

## Structure pass

**Axis: what happens when a tool keeps failing inside a loop?** Single-call: retry once, give up. Agent loop: the model can call the dead tool again next turn, and again — multiplying the failure by the iteration count. Trace it: a dead tool + a loop = the whole iteration budget spent retrying, producing nothing. The seam: aptkit already turns one tool error into an observation (the model *sees* the failure), but nothing stops the model from calling the same dead tool every turn.

## How it works

### Move 1 — the mental model

A circuit breaker scoped to one tool: closed (calls pass), open after N fails (fail fast, don't call), half-open after a cooldown (try one). The agent twist: feed the open state back to the model as an observation, so its reasoning routes around the dead tool instead of looping on it.

```
  Per-tool circuit breaker

  ┌───────────────────────────────────────────────┐
  │  closed:    calls pass through               │
  │  N fails →  OPEN: fail fast, don't call tool │
  │  after T:   half-open, try one               │
  └───────────────────────────────────────────────┘
       │ tool X open?
       ▼
  Agent observes "tool X unavailable" → routes around it
```

### Move 2 — aptkit's hook, and the breaker it's missing

**The hook aptkit already has.** When a tool throws, the loop catches it and turns it into a `tool_result` with `isError`, fed back into the messages:

```typescript
// packages/runtime/src/run-agent-loop.ts:163-186
} catch (error) {
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));  // ← error → observation
}
// ...
toolResults.push({ type: 'tool_result', toolUseId, content: resultContent,
                   ...(isError ? { isError: true } : {}) });
```

This is the crucial half: the error becomes an *observation* the model sees, not a crash. So the model *can* reason "that tool failed, let me try another." That's exactly the feedback channel a circuit breaker needs.

**The breaker that's missing.** Nothing tracks *repeated* failures of the same tool. If `search_knowledge_base` is down, the model gets an error observation on turn 1 — but a weak model might call it again on turn 2, and again, burning all four `maxToolCalls` on a dead tool. A per-tool breaker would: count fails per tool, open after N, and on a call to an open tool, *immediately* return "tool X unavailable" without invoking it — feeding that straight into the existing observation channel.

```
  Per-tool breaker for aptkit (would-be)

  registry.callTool(name, args)   ← the wrap point (tool-registry.ts:50)
       │
       ▼ breaker[name] open?
   yes → return { error: "tool unavailable, route around it" }  (no real call)
   no  → real call; on throw, breaker[name].fails++ ; open at N
       │
       ▼ (either way) error → observation → model routes around (existing hook)
```

**The shift from the single-call version.** A single-call breaker protects *your* service from hammering a broken dependency. The agent version does that *and* feeds the open-circuit state back to the agent as an observation, so the agent's reasoning routes around the dead tool. A breaker that just fails fast without telling the agent leaves the agent retrying the same dead path. aptkit has the telling-the-agent half (errors → observations); it's missing the failing-fast half (the breaker state).

**The tradeoff.** A per-tool breaker adds state the runtime carries across turns (which tools are open, cooldown timers). The failure it prevents is the expensive one: without it, one dead tool plus an agent loop equals the whole iteration budget spent on retries, producing nothing — the worst cost blowup. This is the control that turns SECTION C's "tool-call cascade" from a budget-ending event into a routed-around inconvenience. aptkit hasn't needed it because its one tool (`search_knowledge_base`) runs in-process against an in-memory store — it doesn't fail intermittently the way a network tool does.

### Move 3 — the principle

Inside a loop, retrying a dead tool multiplies the failure by the iteration count. The fix isn't just fail-fast — it's fail-fast *with feedback*, so the agent routes around the dead tool. aptkit has the feedback channel (errors become observations) but not the breaker state (no per-tool fail tracking). It's the right next control the moment a tool is a flaky network dependency rather than an in-process function.

## Primary diagram

```
  Per-tool circuit breaking for aptkit (would-be) — full frame

  ┌─ Agent loop ──────────────────────────────────────────────┐
  │  model emits tool_use(name, args)                          │
  └───────────────────────────┬──────────────────────────────┘
                              ▼ registry.callTool (the wrap point)
  ┌─ Breaker (per tool, WOULD ADD) ───────────────────────────┐
  │  closed → real call; throw? fails++; open at N             │
  │  open   → fail fast, return "unavailable" (no call)         │
  │  half-open after cooldown → try one                        │
  └───────────────────────────┬──────────────────────────────┘
                              ▼ error → tool_result(isError)   ← aptkit HAS this
  ┌─ Model observes failure → routes around the dead tool ─────┐
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The circuit breaker is a classic resilience pattern, and the agent twist is what makes it interesting: the breaker's job isn't only to protect the dependency, it's to *inform the agent's reasoning* so it stops looping on a dead path. aptkit's loop already does the informing — turning tool errors into observations is a deliberate design choice, not an accident, and it's the harder half to get right. Adding the breaker state (per-tool fail counts, cooldowns) at the `callTool` wrap point is a localized change. The reason it's deferred is honest: aptkit's tools are in-process, not flaky network calls, so there's no intermittent failure to break on yet.

## Interview defense

**Q: What stops your agent from burning its whole budget retrying a dead tool?**
Right now, the loop turns a tool error into an *observation* the model sees — so the model can reason "that failed, try another." That's the feedback half, and it's the harder half to get right. What I'm missing is the breaker state: nothing tracks repeated failures of the same tool, so a weak model could call a dead tool every turn and burn all four tool-calls. A per-tool breaker at the `callTool` wrap point would open after N fails and return "unavailable" instantly, feeding that into the existing observation channel.

```
  errors → observations (HAVE) + per-tool fail tracking → open (WOULD ADD)
```
*Anchor: agent breakers must fail fast WITH feedback — fail-fast alone leaves the agent retrying the dead path.*

**Q: Why haven't you built it?**
My one tool runs in-process against an in-memory store — it doesn't fail intermittently like a network call. The breaker becomes necessary the moment a tool is a flaky external dependency.

## See also

- `02-agent-loop-skeleton.md` — the error-to-observation hook (run-agent-loop.ts:163)
- `03-multi-agent-orchestration/09-coordination-failure-modes.md` — the tool-call cascade this bounds
- `04-agent-infrastructure/05-guardrails-and-control.md` — the control envelope
- `study-ai-engineering/06-production-serving/` — single-call retry and circuit breaker (cross-ref)
