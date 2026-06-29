# 01 — Reasoning Patterns

**Anchor: single-agent (primary) · workflow (secondary)**

How one model thinks through a task. This is what aptkit actually exercises — every one of the six agents is a single reasoning loop. The orchestration topologies in SECTION C sit on top of these patterns; a supervisor-worker system would be a supervisor and workers each running one of these.

Read in order — they build on each other:

1. `01-chains-vs-agents.md` — the boundary: written control flow vs autonomous loop. aptkit is on the agent side.
2. `02-agent-loop-skeleton.md` — **the kernel all six agents share** (`runAgentLoop`). Read this one carefully; the rest refer back to it.
3. `03-react.md` — the default pattern. Where aptkit sits and why it hasn't escalated past it.
4. `04-plan-and-execute.md` — not yet exercised; what it would take.
5. `05-reflexion-self-critique.md` — rubric-improvement is the closest instance.
6. `06-tree-of-thoughts.md` — not yet exercised; cover it to say why you didn't use it.
7. `07-routing.md` — the query agent's intent classifier; the bridge to SECTION C.
