# Guardrails and Control

**Industry term:** guardrails / the control envelope around an autonomous loop. *Industry standard.*

## Zoom out, then zoom in

The controls that bound an autonomous loop. aptkit has the core envelope: iteration caps, a forced synthesis turn, a least-privilege tool allowlist, and output validators. The human-in-the-loop gate is `not yet exercised`.

```
  Zoom out — the control envelope wraps the loop

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  ToolPolicy allowlist (input-side trust boundary)            │ ← we are here
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ Runtime layer ─────────────────▼───────────────────────────┐
  │  agent loop: maxTurns · maxToolCalls · forced synthesis turn │
  └───────────────────────────────┬──────────────────────────────┘
  ┌─ Capability layer ──────────────▼───────────────────────────┐
  │  output validator (validate.ts) before trusting is_final     │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit bounds the loop on three sides. On the way in, `filterToolsForPolicy` scopes which tools the agent can even see. Inside, `maxTurns`/`maxToolCalls` plus the forced synthesis turn cap the spend. On the way out, per-agent validators check the output before it's trusted. The missing side is a human-in-the-loop pause.

## The structure pass

**Layers.** Input guardrail (what the agent can reach) → loop guardrail (how long it can run) → output guardrail (what's trusted out).

**Axis: trust — at each control point, what's prevented?** Input: the agent can't reach a tool outside its role. Loop: it can't run forever. Output: malformed/unsafe output isn't trusted.

**The seam.** Each guardrail is a seam between "the model freewheeling" and "your code constraining it." The most important: the model's output never triggers a side effect directly — it goes through your code.

## How it works

**Use case in aptkit:** every agent runs inside this envelope. The clearest is the least-privilege allowlist — the rag-query agent can call exactly one tool, no matter what it tries.

### Move 1 — the control points

```
  ┌───────────────────────────────────────────────┐
  │  Input guardrail   (ToolPolicy allowlist)      │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Agent loop                                    │
  │   • iteration cap (maxTurns)                   │
  │   • tool-call budget (maxToolCalls)            │
  │   • forced synthesis turn (no tools at budget) │
  │   • human-in-the-loop pause (NOT YET)          │
  └────────────────────┬──────────────────────────┘
                       ▼
  ┌───────────────────────────────────────────────┐
  │  Output guardrail  (validate.ts schema check;  │
  │  output never triggers a side effect directly) │
  └───────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**Input: least-privilege tool allowlist.** Each agent declares exactly which tools it may call; `filterToolsForPolicy` hands the loop only those:

```ts
// tool-policy.ts:11 — the model only ever SEES the allowed tools
export function filterToolsForPolicy(allTools, policy): ModelTool[] {
  const allowed = new Set(policy.allowedTools);
  return allTools.filter((tool) => allowed.has(tool.name)).map(...);
}
// rag-query-agent.ts:15 — this agent's allowlist is exactly one tool
allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],
```

The agent can't call a tool it wasn't granted, because it never sees it in the schema list. That's the trust boundary — not "we asked the model nicely," but "the tool isn't in the menu." The recommendation agent's allowlist is 13 read-only tools; none mutate anything. Least-privilege by construction.

**Loop: caps plus the forced synthesis turn.** Covered in [../01-reasoning-patterns/02-agent-loop-skeleton.md](../01-reasoning-patterns/02-agent-loop-skeleton.md) — `maxToolCalls` caps the spend, and at the budget the loop withholds tools and demands an answer (`run-agent-loop.ts:101`). An agent without caps loops silently and burns tokens; this is the control that prevents it.

**Output: validate before trusting.** Per-agent validators (`validate.ts`) check the output shape before it's returned; the parse-recovery turn retries on failure. And critically — the agent's output is *data the host acts on*, not a side effect the agent triggers. aptkit's agents return validated values (`Recommendation[]`, a string answer); they don't directly write to a database or call an external API as a side effect of generation. That's the prompt-injection defense: an agent whose output triggers side effects directly is a liability; one whose output is validated data your code then acts on is bounded.

**The missing side: human-in-the-loop.** There's no pause-for-approval gate in `runAgentLoop`. A high-stakes action (the recommendation agent suggesting a real campaign change) is returned as data for a human to approve in the host — but the *loop itself* can't pause mid-run and resume after sign-off. That requires the checkpointed state of graph orchestration ([../03-multi-agent-orchestration/07-graph-orchestration.md](../03-multi-agent-orchestration/07-graph-orchestration.md)). `not yet exercised` as an in-loop gate; handled today by returning data to the host.

### Move 3 — the principle

An agent without caps loops silently and burns tokens; an agent whose output triggers side effects directly is a prompt-injection liability. The control envelope bounds both — least-privilege on the way in (the tool isn't in the menu), caps inside (it can't run forever), validated data on the way out (your code acts, not the model). aptkit has all three; the human-in-the-loop pause is the one piece that needs checkpointed state it doesn't have yet.

## Primary diagram

```
  aptkit's control envelope around runAgentLoop

  INPUT     filterToolsForPolicy → agent sees ONLY its allowlist
            (rag-query: 1 tool · recommendation: 13 read-only)   ✓

  LOOP      maxTurns + maxToolCalls + forced synthesis turn        ✓
            human-in-the-loop pause                               ✗ not yet exercised

  OUTPUT    validate.ts (schema) + recovery turn                  ✓
            output = DATA the host acts on, NOT a direct side effect ✓
            (the prompt-injection boundary)
```

## Elaborate

Guardrails are what separate a demo from a shipped agent. The two failures they prevent are the silent token burn (no cap) and the unsafe side effect (output wired straight to an action). aptkit's design closes both structurally: least-privilege allowlists mean an injected prompt can't make the agent call a tool it wasn't granted, and returning validated data instead of triggering side effects means a manipulated output is just bad data your code can reject, not an executed action. The human-in-the-loop gate — pause, get approval, resume — is the one control that needs more than a loop; it needs the checkpointed state graphs provide, which is why it's the honest gap.

## Interview defense

**Q: What stops an aptkit agent from doing something unsafe?**

Three controls. The tool allowlist — the agent only sees the tools its `ToolPolicy` grants, so an injected prompt can't make it call something it wasn't given. The loop caps — `maxToolCalls` plus a forced synthesis turn, so it can't burn tokens in a silent loop. And the output is validated *data the host acts on*, not a side effect the agent triggers — so a manipulated output is rejectable bad data, not an executed action.

```
  input:  tool not in menu  → can't call it      (least-privilege)
  loop:   cap + forced synthesis → can't run forever
  output: validated data, host acts → no direct side effect (injection boundary)
```

I'd flag the gap: there's no in-loop human-approval pause yet — high-stakes outputs are returned for the host to approve, but the loop can't checkpoint and resume. That needs graph-style state.

*Anchor: the strongest guardrail isn't a prompt plea — it's that the tool isn't in the menu and the output is data, not an action.*

## See also

- [../01-reasoning-patterns/02-agent-loop-skeleton.md](../01-reasoning-patterns/02-agent-loop-skeleton.md) — the caps as part of the loop skeleton.
- [03-tool-calling-and-mcp.md](03-tool-calling-and-mcp.md) — the allowlist as a trust boundary.
- [../03-multi-agent-orchestration/07-graph-orchestration.md](../03-multi-agent-orchestration/07-graph-orchestration.md) — the checkpointing a human gate needs.
- Prompt-injection and per-call error recovery: `.aipe/study-ai-engineering/`.
