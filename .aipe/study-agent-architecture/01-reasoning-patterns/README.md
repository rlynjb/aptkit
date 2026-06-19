# 01 — Reasoning Patterns

The reasoning-pattern family is the "what shape does this agent's control flow
take" question. Before you can reason about retrieval, orchestration, or
serving, you have to know how *one* loop decides when to call a tool, when to
stop, and what it returns. This sub-section isolates that loop and then places
each named pattern (ReAct, plan-and-execute, reflexion, tree-of-thoughts,
routing) relative to it.

**Anchor: single-agent is primary.** AptKit is one kernel
(`packages/runtime/src/run-agent-loop.ts`) wrapped by five capabilities. Every
one of them is a bounded ReAct loop. There is no autonomous planner, no
supervisor, no tree search. So two of the seven patterns below
(plan-and-execute, tree-of-thoughts) are written as "not yet implemented" — you
get the pattern, an honest reason AptKit skips it, and a pointer to the
SECTION F templates where you would build it. That honesty is the point: a
staff engineer who can say "we don't do tree-of-thoughts because it's rarely
worth it here" is more useful than one who name-drops it.

## Reading order

The skeleton file is load-bearing. Read it second and slowly; everything else
references it.

```
  Reading order for 01-reasoning-patterns

  01-chains-vs-agents.md          ← the boundary: when does .then() stop and a loop start
        │
        ▼
  02-agent-loop-skeleton.md  ★    ← THE kernel. Isolate runAgentLoop, name each part
        │                            by what breaks if you remove it. Read slowly.
        ▼
  03-react.md                     ← place ReAct in the family; all 5 agents are this
        │
        ├──▶ 04-plan-and-execute.md      ← NOT implemented; when AptKit would reach for it
        │
        ├──▶ 05-reflexion-self-critique.md ← the rubric agent IS this shape (model judges)
        │
        ├──▶ 06-tree-of-thoughts.md      ← NOT implemented; rarely worth it; correctly skipped
        │
        ▼
  07-routing.md                   ← the query intent router (picks a string, not an agent)
```

## Files

- **[01-chains-vs-agents.md](01-chains-vs-agents.md)** — the boundary. A chain
  has a fixed step count you write in advance; an agent lets the model decide
  the step count at runtime. AptKit chose agents because the number of queries
  needed to diagnose an anomaly depends on what the model finds.
- **[02-agent-loop-skeleton.md](02-agent-loop-skeleton.md)** — the load-bearing
  treatment of `runAgentLoop`. Four parts: state (`messages`), step
  (`model.complete`), execute (`tools.callTool`), termination (two exits). The
  forced synthesis turn is the surprising load-bearing part.
- **[03-react.md](03-react.md)** — ReAct's placement. Default to it, measure,
  escalate only on a specific failure. All five agents are ReAct.
- **[04-plan-and-execute.md](04-plan-and-execute.md)** — not implemented. The
  pattern and the conditions under which AptKit would add a plan phase.
- **[05-reflexion-self-critique.md](05-reflexion-self-critique.md)** — the
  rubric-improvement agent is this shape: the model judges a subject rather
  than producing one. Names the hard limit (self-critique shares blind spots).
- **[06-tree-of-thoughts.md](06-tree-of-thoughts.md)** — not implemented, and
  correctly so. Blunt about why it's rarely worth the cost.
- **[07-routing.md](07-routing.md)** — the query intent router. Heuristic
  `parseIntent` + LLM `classifyIntent`. Honest that it picks an intent *string*
  that biases a prompt, not which agent runs.

## See also

- `../00-overview.md` — the whole system in one diagram
- `../agent-patterns-in-this-codebase.md` — the patterns table with file:line
- `../03-multi-agent-orchestration/03-sequential-pipeline.md` — where the
  latent monitor→diagnose→recommend pipeline lives
- `../04-agent-infrastructure/` — tool policy, structured output, control
- `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` —
  ReAct's Thought-Action-Observation mechanics (cross-ref, not re-taught here)
- `.aipe/study-prompt-engineering/` — synthesis and recovery prompt wording
