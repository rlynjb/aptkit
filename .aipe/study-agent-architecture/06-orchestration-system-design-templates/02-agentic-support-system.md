# Agentic Support / Task System

A system-design interview template. Nine bullets; the generic architecture is the model answer's shape, the last two bullets are about aptkit.

- **The prompt:** "Design an agent that resolves user requests by taking real actions across tools, and escalates when it can't."

- **Standard architecture:** intent router → single agent with tools (ReAct) → guardrails (input sanitize, action gating, output schema) → human escalation on low confidence or gated actions.

```
  Single agent + control envelope

  request → router → ┌─ agent loop (ReAct) ──────────────┐
                     │  caps · tool policy · output schema│
                     └──────────────┬─────────────────────┘
                       low conf / gated action?
                              ▼
                       human escalation
```

- **Data model:** conversation/run history with tool calls and confidence per turn, escalation log, tool registry, action audit trail.

- **Key components:** routing, the agent loop, guardrails, escalation gate, audit logging. Decision: which actions require human approval (irreversible / high-stakes) vs auto-execute.

- **Scale concerns:** tool-call cascade under load, cost per resolved request, escalation queue as the human bottleneck.

- **Eval framing:** resolution rate without escalation, tool-call accuracy, adversarial set (prompt injection, out-of-scope), action-safety (no unauthorized side effects).

- **Common failure modes:** prompt injection in user input, agent taking an unsafe action directly, infinite loop on an unsolvable request, hallucinated tool results.

- **Applies to this codebase: partially.** aptkit has most of the *single-agent-with-tools* spine and the strongest part of the control envelope. The router exists (`classifyIntent`, `query/src/intent.ts`). The agent loop exists (`runAgentLoop`). The guardrails are strong on two axes: least-privilege tool policy (`filterToolsForPolicy`) and the loop caps (`maxTurns`/`maxToolCalls`/`maxTokens`), plus output schema validation (`tryParseRecommendations` et al.). The audit trail exists as the `CapabilityEvent` trace + replay artifacts. What's missing: aptkit's agents are **read-only** — they take *no real actions*, so the "resolve by taking actions" and "escalate when it can't" halves don't exist. There's no escalation gate and no human-in-the-loop pause (the loop runs to completion). So aptkit is a strong *advisory* agent (it proposes recommendations, answers questions), not an *action-taking* support agent.

- **How to make it apply:** The gap is action-taking and escalation, and aptkit's read-only design makes the refactor a deliberate, gated one. (1) Add write tools to a capability's policy — but gate them: irreversible/high-stakes actions route to a human approval step, auto-execute only the reversible ones. This needs the human-in-the-loop pause aptkit lacks, which means adopting graph orchestration (`03-multi-agent-orchestration/07-graph-orchestration.md`) so the loop can checkpoint before a gated action and resume after approval. (2) Add a real input guardrail — aptkit relies on read-only tools for injection safety (`04-agent-infrastructure/05-guardrails-and-control.md`); the moment write tools exist, injection becomes a real threat needing a content sanitizer. (3) Add an escalation gate on low confidence — the agents already emit confidence (the diagnostic agent infers it), so the threshold check is small. The control envelope aptkit has (caps, least-privilege, output schema) carries straight over; the new work is the action layer and the human gate.

## See also

- `01-reasoning-patterns/07-routing.md` — the router (have)
- `04-agent-infrastructure/05-guardrails-and-control.md` — the control envelope (mostly have)
- `03-multi-agent-orchestration/07-graph-orchestration.md` — the human gate (missing)
