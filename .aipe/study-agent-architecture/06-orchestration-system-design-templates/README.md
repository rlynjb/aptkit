# F — Orchestration System Design Templates

The studied codebase reframed as the answer to "design an agentic X system." Same code, interview framing. All three templates appear regardless of current applicability; the "Applies to this codebase" bullet is honest, and "How to make it apply" names the concrete refactor.

These use the nine-bullet system-design template shape (the prompt, standard architecture, data model, key components, scale concerns, eval framing, common failure modes, applies-to-this-codebase, how-to-make-it-apply) — NOT the per-concept template.

## Files

1. [01-multi-agent-research-assistant.md](01-multi-agent-research-assistant.md) — supervisor + parallel workers + synthesis. Applies: **partially** (aptkit has the per-worker RAG, not the supervisor).
2. [02-agentic-support-system.md](02-agentic-support-system.md) — router + single agent + guardrails + escalation. Applies: **yes** (closest to aptkit's actual shape).
3. [03-agentic-coding-system.md](03-agentic-coding-system.md) — plan-execute + verifier + scoped writes. Applies: **no** (aptkit's agents are read-only analytics/retrieval).
