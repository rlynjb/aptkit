# 03 — Per-tool circuit breaking

## Subtitle

Failing fast on a tool that's reliably broken — and feeding that "open" state back to the agent so it routes around — versus AptKit, which feeds tool *errors* back but keeps no breaker state.

---

## Zoom out

You know circuit breaking from the frontend: a dependency is down, so instead of hanging every request on the same dead endpoint, you trip a breaker — fail fast — and stop calling it until it recovers. The single-call version (retry policy, breaker thresholds, half-open probing) is in `.aipe/study-ai-engineering/06-production-serving/`. This file is about what the breaker becomes when the caller is a *loop* that can re-call the same dead tool every turn.

Here's the loop's twist. In a single request, a dead dependency wastes one request. In an agent loop, the model can decide to call the same dead tool on turn 1, turn 2, turn 3 — burning the entire tool budget on a corpse. The breaker has to live *across turns*, and — crucially — its open state has to become an *observation the agent can see*, so the model stops choosing that tool and reasons around it.

```
Single-call breaker  vs  in-loop per-tool breaker
┌─────────────────────────┬─────────────────────────────────────┐
│ one request, one breaker │ a TOOL has a breaker, across turns   │
│ trip → fail this request │ trip → tell the AGENT "tool X open"  │
│ caller is code           │ caller is a model that PICKS tools   │
│                          │ → open-state must reach its reasoning│
└─────────────────────────┴─────────────────────────────────────┘
```

AptKit does **not** implement a per-tool breaker. What it does — and this is the important nuance — is *catch each tool error and feed it back to the model as an observation*. So the model can see "tool X failed" and route around it in its reasoning. But there is no breaker *state*: nothing remembers that tool X failed three turns running, so the model can call it again every turn until the budget runs out.

---

## Structure pass

A breaker is a small state machine with a threshold, wrapped around one dependency. The per-tool version means *one machine per tool*, and the loop version means *the open state is an output the agent reads*.

```
Per-tool breaker: state machine + feedback seam
            failures ≥ threshold
   CLOSED ───────────────────────▶ OPEN ──(cooldown)──▶ HALF-OPEN
     ▲  │ call tool, count fails    │ fail fast,           │ one probe
     │  └──── success resets ───────┘ skip the call        │
     └──────────────── probe succeeds ─────────────────────┘
                              │
                              ▼ THE SEAM (loop-specific):
                  open-state → fed to AGENT as observation
                  so the model stops choosing this tool
```

The state machine is the textbook part. The seam — open-state becoming an observation the model reads — is the loop-specific part, and it's the part AptKit half-has (it feeds errors, not breaker state).

---

## How it works

**Move 1 — mental model.** A breaker is a counter with three states guarding one dependency. The loop adds a rule: the state must be *visible to the decision-maker*. In code, the decision-maker is your routing logic. In an agent, the decision-maker is the *model* — so "open" has to land in the context the model reasons over.

```
PATTERN: state guards the call, state informs the chooser
   [breaker:OPEN] ──▶ skip call, return "unavailable" fast
         │
         └──▶ ALSO: surface "tool X unavailable" to the chooser
              code chooser → branch on it
              model chooser → it appears as an OBSERVATION in context
```

**Move 2 — step by step.**

*Step 1: count failures per tool, trip on threshold.*

```
Trip the breaker
call tool X → error → fails[X]++
fails[X] ≥ threshold → state[X] = OPEN, opened_at[X] = now
```

```
on_tool_result(tool, ok):
  if ok: fails[tool] = 0; state[tool] = CLOSED
  else:  fails[tool]++
         if fails[tool] >= THRESHOLD: state[tool] = OPEN
```

*Step 2: fail fast while open, skip the real call.*

```
Guard the call
agent wants tool X →
  if state[X] == OPEN and now - opened_at[X] < cooldown:
      return {unavailable: true}  ← no real call, instant
```

*Step 3 (the loop-specific part): feed open-state back as an observation.*

```
Open-state → observation
breaker OPEN ──▶ inject into tool_result:
   { isError: true, content: "tool X is unavailable (circuit open)" }
                              │
                              ▼ model reads it next turn → picks tool Y
```

```
if state[tool] == OPEN:
  push tool_result(isError=true,
                   content="tool '"+tool+"' unavailable, route around it")
  # model sees this, stops selecting tool, reasons differently
```

**Move 3 — principle.** Fail fast on a known-bad dependency, and *make the failure legible to whoever chooses the next action*. A breaker that trips silently still lets the chooser keep selecting the dead path. When the chooser is a model, "legible" means the open state must arrive as an observation in its context — the same channel through which it learns everything else. And bound the damage: without a breaker, one dead dependency plus a loop equals the whole budget spent on retries. The breaker converts "retry forever" into "try once, then route around."

---

## Primary diagram

What AptKit does on a tool failure: catch it, serialize it, feed it back — but keep no memory of it.

```
AptKit: error-feedback without breaker STATE
agent turn → callTool(X)
      │  run-agent-loop.ts:158 try {
      ▼
   FAILS ── run-agent-loop.ts:163 catch (error)
      │     toolCall.error = message          (:166)
      ▼
   tool_result { isError: true, content: {error} }   (:181-186)
      │
      ▼  fed back as observation → model CAN route around it
      │
      └─ BUT no fails[X] counter, no OPEN state.
         Next turn the model may call X again. And again.
         Bounded ONLY by maxToolCalls (3-6).
```

The feedback channel exists and works. The *memory* — the breaker state that would stop the re-calls — does not.

---

## Implementation in codebase

**Use cases.** No per-tool breaker. Three relevant pieces: tool-error feedback (the half that exists), the diagnostic confidence demotion (a downstream reaction to errors), and the *provider*-level resilience (fallback chain + context guard) that is the real resilience AptKit ships.

**Tool errors caught and fed back — the half that exists.** Each tool call is wrapped, and a failure becomes an `isError` observation the model sees next turn:

```ts
// run-agent-loop.ts:158-168 — catch per call, serialize the error
try {
  const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
  ...
} catch (error) {
  isError = true;
  const message = error instanceof Error ? error.message : String(error);
  toolCall.error = message;
  resultContent = truncate(JSON.stringify({ error: message }));
}
```
```ts
// run-agent-loop.ts:181-186 — the error becomes a tool_result the model reads
toolResults.push({
  type: 'tool_result',
  toolUseId: toolUse.id,
  content: resultContent,
  ...(isError ? { isError: true } : {}),
});
```

This is the breaker's *feedback seam* without the breaker's *state*. The model can route around a failed tool in its reasoning — but nothing prevents it from re-selecting the same dead tool every turn until `maxToolCalls` is hit.

**Downstream reaction: confidence demotion.** The diagnostic agent notices *that* a tool errored and lowers its own confidence — a reaction to errors, not a breaker:

```ts
// diagnostic-agent.ts:84-85 — any tool error → demote high to medium
const hadErrors = toolCalls.some((call) => call.error);
return { ...diagnosis, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence };
// diagnosisConfidence at diagnostic-agent.ts:89
```

This is honest-output hygiene (don't claim high confidence on a partially-failed investigation), not flow control over the tool.

**The resilience that DOES exist: provider fallback chain.** At the *provider* seam, AptKit tries providers in order and records each failed attempt, emitting a warning trace:

```ts
// fallback-provider.ts:50 — try providers in order
for (let index = 0; index < this.providers.length; index += 1) {
  ...
  try { return await provider.complete(request); }
  catch (error) {
    ...
    if (!this.shouldFallback(error, provider)) throw error;   // :73 predicate
    // :78 emit warning trace, then continue to next provider
  }
}
// :88 all failed → ProviderFallbackError(attempts)
```

The `shouldFallback` predicate (`:44`) and the recorded `FallbackAttempt[]` make this a real provider-level resilience pattern — but it is fallback (try the next one), not a breaker with open/half-open state, and it is per *provider*, not per *tool*.

**Pre-flight fail-fast: the context-window guard.** This one genuinely fails fast at a seam — it estimates tokens before calling and throws to skip a provider whose window the request would blow:

```ts
// context-window-guard.ts:57-68 — pre-flight estimate, throw to skip provider
const estimate = estimateContextWindow(request, this.options);
if (!estimate.ok) {
  this.options.trace?.emit({ type: 'warning', ... });   // :61
  throw new ContextWindowExceededError(estimate);        // :67 fail fast
}
return this.provider.complete(request);
```

Combined with the fallback chain, a too-big request fails fast on a small-window local provider and falls through to a larger one — fail-fast-then-route, at the *provider* seam. This is the closest AptKit comes to the breaker's spirit, just not per-tool.

**Not yet exercised:** there is no per-tool breaker state in AptKit — only error feedback (no memory) at the tool seam, and fallback + context-guard at the provider seam. *See SECTION F (`../06-orchestration-system-design-templates/`) for where a per-tool breaker would slot into a system with flaky external tools.*

---

## Elaborate

The gap is precise and worth stating cleanly: AptKit already owns the *hard* half of an in-loop breaker — the feedback channel that makes a failure legible to the model (`run-agent-loop.ts:181-186`). What it lacks is the *easy* half — a per-tool counter and an `OPEN` state that would stop the re-calls. Adding the breaker would be a small wrapper around `callTool` that maintains `fails[tool]` and, when open, short-circuits with an `isError` result reusing the exact feedback path that already exists.

Why it hasn't mattered yet: AptKit's tools are read-only and few, the budget is tiny (3-6 calls), and a failing tool's blast radius is capped by `maxToolCalls`. The worst case today is "the run wastes its remaining 3-5 calls on a dead tool and produces a lower-confidence answer" — wasteful, not dangerous. The diagnostic agent even degrades gracefully by demoting confidence (`diagnostic-agent.ts:84-85`).

Where it would matter: an external tool that's *flaky* rather than dead — succeeds sometimes, times out often. With no breaker, the model keeps trying it because each individual failure looks recoverable, and the loop bleeds its budget on a coin-flip dependency. That's the textbook case for a breaker: trip after K failures, route around, probe once after cooldown. And the resilience AptKit *does* have — provider fallback + context guard — is the proof the team understands fail-fast-and-route at one seam; the per-tool seam is simply the seam they haven't needed yet.

---

## Interview defense

**Q: "If a tool keeps failing, what stops your agent from calling it forever?"**

```
AptKit's actual guards on a failing tool
   error caught + fed back (run-agent-loop.ts:181-186)
        └─ model CAN route around it... but isn't forced to
   no per-tool breaker → no OPEN state → re-call allowed
        └─ hard stop = maxToolCalls (3-6)   ← the only real bound
   (provider seam HAS resilience: fallback chain + context guard)
```

Honest answer: "Two things, and a gap. We catch the error and feed it back as an observation so the model *can* avoid the tool — `run-agent-loop.ts:163-186`. And the run is hard-bounded by `maxToolCalls`, so a dead tool wastes at most 3-5 calls, not the process. The gap is a per-*tool* breaker — we keep no failure-count state, so a flaky tool can be re-selected each turn. We *do* have breaker-spirited resilience at the provider seam: a fallback chain (`fallback-provider.ts:50`) and a pre-flight context guard that fails fast (`context-window-guard.ts:67`). Adding a per-tool breaker would reuse the existing feedback path — it's a small, deliberate gap given read-only tools and a 6-call budget."

---

## Validate

- **L1 (recognize):** Name the breaker's three states and the loop-specific seam. → "Structure pass" diagram.
- **L2 (trace):** Show where a tool error is caught and how it reaches the model. → `run-agent-loop.ts:158-168`, `:181-186`.
- **L3 (judge):** Explain why AptKit has the feedback half but not the state half, and why that's bounded-safe. → "Elaborate"; bound at `run-agent-loop.ts:101`.
- **L4 (extend):** Distinguish provider fallback from a per-tool breaker, and place each at its seam. → `fallback-provider.ts:50`, `context-window-guard.ts:57-68`; per-tool gap → `../06-orchestration-system-design-templates/`.

---

## See also

- `.aipe/study-ai-engineering/06-production-serving/` — single-call retry & circuit-breaker mechanics. Read for per-call thresholds and half-open probing.
- `02-fan-out-backpressure.md` — the prior loop pressure.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop that re-calls tools.
- `../04-agent-infrastructure/05-guardrails-and-control.md` — budgets and control surfaces.
- `../03-multi-agent-orchestration/09-coordination-failure-modes.md` — failure modes a breaker contains.
- `../06-orchestration-system-design-templates/` — SECTION F, where a per-tool breaker slots in.
- `../agent-patterns-in-this-codebase.md`
