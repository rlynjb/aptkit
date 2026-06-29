# Template — Agentic Support / Task System

Nine-bullet system-design template. The studied codebase is aptkit; the last two bullets are answered about aptkit.

- **The prompt:** "Design an agent that resolves user requests by taking real actions across tools, and escalates when it can't."

- **Standard architecture:** intent router → single agent with tools (ReAct) → guardrails (input sanitize, action gating, output schema) → human escalation on low confidence or gated actions.

```
  request ─► intent router (classify)
                 │
                 ▼
          single agent (ReAct loop)
            • tool allowlist (least-privilege)
            • iteration cap + forced synthesis
                 │
                 ▼
          output validator (schema)
                 │ low confidence / gated action?
                 ▼
          human escalation (return data, don't act directly)
```

- **Data model:** conversation/run history with tool calls and confidence per turn, escalation log, tool registry, action audit trail.

- **Key components:** routing, the agent loop, guardrails, escalation gate, audit logging. Decision: which actions require human approval (irreversible / high-stakes) vs auto-execute.

- **Scale concerns:** tool-call cascade under load, cost per resolved request, escalation queue as the human bottleneck.

- **Eval framing:** resolution rate without escalation, tool-call accuracy, adversarial set (prompt injection, out-of-scope), action-safety (no unauthorized side effects).

- **Common failure modes:** prompt injection in user input, agent taking an unsafe action directly, infinite loop on an unsolvable request, hallucinated tool results.

- **Applies to this codebase:** **Yes — this is aptkit's actual shape.** The query agent has the *router* (`classifyIntent`, `packages/agents/query/src/intent.ts` — [../01-reasoning-patterns/07-routing.md](../01-reasoning-patterns/07-routing.md)). Every agent is a *single ReAct agent with a least-privilege tool allowlist* (`filterToolsForPolicy`, `tool-policy.ts`). The *guardrail envelope* is live: iteration caps, the forced synthesis turn, and output validators ([../04-agent-infrastructure/05-guardrails-and-control.md](../04-agent-infrastructure/05-guardrails-and-control.md)). The *action-safety* property holds by construction — aptkit's agents return validated *data* the host acts on (`Recommendation[]`, an answer string), never triggering side effects directly. The recommendation agent's 13 tools are all read-only. What's partial: there's no in-loop *human escalation gate* (high-stakes outputs are returned for the host to approve, but the loop can't pause and resume), and no confidence-per-turn or audit-trail data model in aptkit (those would live in buffr).

- **How to make it apply (fully):** Add a confidence signal to the agent's output and an escalation gate that routes low-confidence runs to a human — implementable as an output-validator branch today, or as a true pause/resume once graph-style checkpointing exists ([../03-multi-agent-orchestration/07-graph-orchestration.md](../03-multi-agent-orchestration/07-graph-orchestration.md)). Wire the conversation/audit data model in the host (buffr's `agents` schema is the place — it already persists conversations/messages). The agent loop, routing, guardrails, and read-only action-safety are already aptkit's shipped reality; the gaps are the escalation gate and the persistence, both deployment-layer concerns.
