# A — Reasoning Patterns

How one model thinks through a task. This is the substrate every orchestration topology sits on — a supervisor and its workers are each running one of these.

Anchor: single-agent (primary) · workflow (secondary).

aptkit lives here. One loop, `runAgentLoop`, and the patterns below are the family it belongs to. ReAct is what aptkit runs; the rest are study material with `In this codebase` marked honestly.

## Files

1. [01-chains-vs-agents.md](01-chains-vs-agents.md) — the boundary. Is there a loop at all?
2. [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — **read this one carefully.** The kernel every other file refers back to.
3. [03-react.md](03-react.md) — the default pattern; aptkit's actual loop. Placement, not mechanics.
4. [04-plan-and-execute.md](04-plan-and-execute.md) — separate planning from doing. Not built in aptkit.
5. [05-reflexion-self-critique.md](05-reflexion-self-critique.md) — evaluate your own output and retry. `rubric-improvement` is the closest aptkit gets.
6. [06-tree-of-thoughts.md](06-tree-of-thoughts.md) — branch, score, pick. Rarely worth it; covered so you can say why you didn't use it.
7. [07-routing.md](07-routing.md) — pick the handler before the loop. aptkit's query agent classifies intent.
