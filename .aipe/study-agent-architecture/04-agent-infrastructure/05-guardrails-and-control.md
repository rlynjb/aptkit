# Guardrails and Control

**Industry standard.** "Guardrails," "the control envelope," "agent safety controls." Type label: infrastructure. **In this codebase: partially — aptkit has a strong loop-control envelope (caps, budgets, least-privilege, read-only tools), but no input/output content guardrail and no human-in-the-loop pause.**

## Zoom out, then zoom in

The controls that bound an autonomous loop. Three points: an input guardrail (validate/sanitize), the loop controls (caps, budgets, human gates), and an output guardrail (schema, safety, no direct side effects). aptkit invests heavily in the *loop* controls and the *least-privilege* boundary; it's thinner on input/output content guardrails.

```
  Zoom out — aptkit's control envelope

  ┌─ Input guardrail ───────────────────────────────────────┐
  │  (validate / sanitize)  ← THIN in aptkit (no content     │
  │   sanitizer; relies on read-only tools)                  │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Agent loop (STRONG controls) ────────────────────────────┐
  │  iteration cap (maxTurns) · tool-call cap (maxToolCalls)  │ ← we are here
  │  token budget (maxTokens) · least-privilege tool policy    │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Output guardrail ────────────────────────────────────────┐
  │  schema validation (parseResult + validators)             │
  │  NO direct side effects (all tools are read-only)          │
  └─────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: where is the loop bounded, and where could it cause harm?** Trace aptkit's controls: the loop is bounded by three caps; harm is pre-empted by read-only tools + least-privilege policy (the agent has no write tool to misuse). The seam: aptkit controls the loop's *resource* envelope (caps) and *capability* envelope (read-only allowlist) tightly, but has no *content* envelope (input sanitization, output safety check) — because its agents can't take destructive actions, so a content guardrail is lower priority.

## How it works

### Move 1 — the mental model

The control envelope is a sandbox around the loop: bound the resources (caps), bound the capabilities (what tools exist), and gate the dangerous outputs. You've built this — a rate limiter + a permissions check + input validation around an endpoint. The agent version is the same three layers around the loop.

```
  The control envelope — three points

  input guardrail ─► [ agent loop: caps + budget + policy ] ─► output guardrail
   (validate)          (bound resources + capabilities)         (schema, no side fx)
```

### Move 2 — the controls aptkit has, and the two it doesn't

**Loop controls — strong.** Every agent sets the three caps:

```typescript
// rag-query-agent.ts:76 / recommendation-agent.ts:86-87 / rubric-improvement-agent.ts:76-77
maxTurns: 6, maxToolCalls: 4,   // iteration + tool-call caps
maxTokens: 2400,                // token/cost ceiling (rubric agent)
```

`maxTurns` bounds total iterations; `maxToolCalls` bounds tool-call cost; `maxTokens` caps per-call output. The forced synthesis turn (`run-agent-loop.ts:104`) is the control that makes the budget exit *produce an answer* rather than just halt. Without these, an agent without caps loops silently and burns tokens — the most common production cost-blowup.

**Capability control — least-privilege, strong.** The tool policy is a control: an agent can only call tools in its allowlist, and *all aptkit agent tools are read-only* (recommendation's 13 tools are all `list_*`/`get_*`; rag-query's one tool is search). So even a fully hijacked agent can't write, delete, or take a destructive action — there's no such tool in scope.

```typescript
// recommendation-agent.ts:21-35 — every tool is read-only
allowedTools: ['list_scenarios', 'get_scenario', 'list_initiatives', ... 'get_anomaly_context']
//             ^^^^ all reads; no write/delete/send in any agent's policy
```

This is the heart of "never let agent output trigger side effects directly — go through your code." aptkit's version: the agent's *tools* are read-only, so its output can't trigger a side effect because no tool does one. Any write happens in the consuming app's code, after validating the agent's structured output.

**Output control — schema validation, present.** `parseResult` + the per-agent validators (`tryParseRecommendations`, `validateRubricImprovementResult`) ensure the agent's output matches a schema before anything trusts it. The recovery turn salvages a parse failure. So malformed output is caught at the boundary.

**The two gaps, named honestly:**
- **No input content guardrail.** No sanitizer scrubs prompt-injection attempts from user input. aptkit's mitigation is structural (read-only tools mean injection can't cause a destructive action), not a content filter. A consuming app that adds write tools would need a real input guardrail.
- **No human-in-the-loop pause.** The loop runs start-to-finish; there's no checkpoint to gate a high-stakes action for human approval. This is the capability graph orchestration (SECTION C file 07) would unlock — aptkit's implicit loop can't pause and resume.

### Move 3 — the principle

An agent without caps loops silently and burns tokens; an agent whose output triggers side effects directly is a prompt-injection liability. aptkit handles the first with the three loop caps and the second *structurally* — read-only tools mean there's no side effect to trigger, so the agent's output is always inert until the app's code acts on validated output. The gaps (input sanitizer, human gate) are lower priority precisely because the read-only boundary already neutralizes the highest-stakes risk.

## Primary diagram

```
  aptkit's control envelope — full frame

  user input ──► [ NO content sanitizer — relies on read-only tools ]
                              │
                              ▼
  ┌─ Agent loop (the controls aptkit has) ────────────────────┐
  │  maxTurns (iterations) · maxToolCalls (tool cost) ·         │
  │  maxTokens (output cap) · forced synthesis (budget→answer) │
  │  filterToolsForPolicy → READ-ONLY allowlist only           │
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  ┌─ Output ───────────────────────────────────────────────────┐
  │  parseResult + validators (schema) → recovery turn on fail  │
  │  output is INERT: no write tool exists, so no direct side fx │
  │  (NO human-in-the-loop pause — loop runs to completion)     │
  └─────────────────────────────────────────────────────────────┘
```

## Elaborate

The control envelope is what separates a demo agent from a shippable one — the demo runs once and looks great; the shipped one runs ten thousand times and must not loop forever, blow the budget, or take an unsafe action. aptkit's strongest control is the read-only-tools-plus-least-privilege boundary, which is the architecturally cleanest version of "go through your code for side effects": the agent simply has no destructive tool. That's a stronger guarantee than an output filter, because there's nothing to filter. The honest gaps — input sanitization and a human gate — are exactly the controls a consuming app must add when it grants the agent write tools.

## Interview defense

**Q: What stops your agent from looping forever or taking an unsafe action?**
Two things. For runaway loops: three caps — `maxTurns`, `maxToolCalls`, `maxTokens` — plus a forced synthesis turn so hitting the budget produces an answer instead of a hang. For unsafe actions: every agent's tool policy is a read-only allowlist. There's no write, delete, or send tool in any agent's scope, so the agent's output is inert — it can't trigger a side effect because no tool does one. Any write happens in the app's code after validating the structured output.

```
  caps (no runaway) + read-only tool policy (no side effects) + schema validation
```
*Anchor: "go through your code for side effects" — my version is the agent has no side-effecting tool at all.*

**Q: What about prompt injection?**
I have no content sanitizer — my mitigation is structural. Even a fully hijacked agent can only call read-only tools, so injection can't cause a destructive action. The day a consuming app grants write tools, it needs a real input guardrail and a human-in-the-loop gate — and my loop can't pause for a human yet, which is what graph orchestration would add.

## See also

- `02-agent-loop-skeleton.md` — the budget exit these caps enforce
- `03-tool-calling-and-mcp.md` — the least-privilege policy
- `03-multi-agent-orchestration/07-graph-orchestration.md` — the human-in-the-loop pause aptkit lacks
- `05-production-serving/03-per-tool-circuit-breaking.md` — bounding a flaky tool inside the loop
- `study-security/` — trust boundaries, LLM/agent security (cross-ref)
