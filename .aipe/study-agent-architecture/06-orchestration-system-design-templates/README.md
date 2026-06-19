# 06 — Orchestration System-Design Templates

> Three interview-ready system-design answers. These are not concept notes —
> they are *templates* you fill in under pressure when an interviewer says
> "design me an agent that does X." Each one is a complete answer shape you can
> recite, then ground in AptKit when asked "have you built this?"

## What's different here

The rest of this study guide uses an 11-block per-concept template (one concept,
dissected). These three files use a **nine-bullet system-design shape** instead:

- **The prompt** — the interview question, verbatim.
- **Standard architecture** — the generic answer, with a box-drawing diagram.
- **Data model** — the state that flows through the system.
- **Key components** — each with the decision it owns.
- **Scale concerns** — what breaks as load/complexity grows.
- **Eval framing** — how you'd know it works.
- **Common failure modes** — what goes wrong in production.
- **Applies to this codebase** — yes / partially / no, about AptKit *only*.
- **How to make it apply** — the concrete refactor in AptKit's real files.

The first seven bullets are **generic** — the standard answer regardless of
codebase. The last two are **grounded** — answered about AptKit specifically,
with real file paths. That generic-but-grounded split is the point: you can give
the textbook answer *and* immediately say what your repo does and doesn't do.

## The three templates

| File | Prompt (one-liner) | Applies to AptKit |
| --- | --- | --- |
| [01 — Multi-Agent Research Assistant](./01-multi-agent-research-assistant.md) | Answer a complex question by gathering from many sources and synthesizing | **Partially** — single-agent retrieval, no supervisor/parallel/citations |
| [02 — Agentic Support-Task System](./02-agentic-support-task-system.md) | Resolve user requests by taking real actions, escalate when stuck | **Partially** — intent-routed ReAct, but read-only, no escalation |
| [03 — Agentic Coding / Build System](./03-agentic-coding-build-system.md) | Complete a coding task across a repo — read, plan, edit, verify | **No** — no coding agent; verifier-critic + eval backbone are the seeds |

## How to use these

Read the prompt, recite the standard architecture from memory, draw the diagram.
Then deliver the verdict (`partially` / `partially` / `no`) and the one-paragraph
refactor. The verdict is the credibility move: it shows you can tell what your
system *is* from what it *isn't*, and name the exact delta.

## Cross-links

- [03 — Sequential Pipeline](../03-multi-agent-orchestration/03-sequential-pipeline.md) — the latent `Anomaly→Diagnosis→Recommendation` chain underpins template 01.
- [01 — When NOT to Go Multi-Agent](../03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md) — why AptKit stayed single-agent.
- [04 — Plan and Execute](../01-reasoning-patterns/04-plan-and-execute.md) — the missing reasoning shape behind template 03.
- [05 — Reflexion / Self-Critique](../01-reasoning-patterns/05-reflexion-self-critique.md) — the verifier-critic shape AptKit *does* have (rubric-improvement).
- [05 — Guardrails and Control](../04-agent-infrastructure/05-guardrails-and-control.md) — the control envelope that backs all three.
- [Agent Patterns in This Codebase](../agent-patterns-in-this-codebase.md) — the catalog these templates draw from.
