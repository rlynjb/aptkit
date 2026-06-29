# Template — Agentic Coding / Build System

Nine-bullet system-design template. The studied codebase is aptkit; the last two bullets are answered about aptkit.

- **The prompt:** "Design an agent that completes a coding task across a repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then execute per file) + verifier-critic (run tests / review the diff, loop on failure) + guardrails (scope the writable files, cap iterations).

```
  task ─► retrieve relevant files ─► PLAN (the changes)
                                        │
                                        ▼
                                 execute per file (edits)
                                        │
                                        ▼
                                 verify (tests / review diff)
                                   │ fail → re-plan trigger
                                   └─ pass → done
  guardrails: writable-file scope · iteration cap
```

- **Data model:** repo context (file tree, relevant files retrieved), the plan, the diff, test results, an iteration counter.

- **Key components:** retrieval over the codebase (which files matter), planning, execution (edits), verification (tests/review), the re-plan trigger on verification failure. Decision: plan-and-execute vs pure ReAct for the edit loop.

- **Scale concerns:** large repos blow the context budget (retrieval routing over the codebase), long tasks blow the iteration cap, cost per task.

- **Eval framing:** task success (tests pass), trajectory efficiency (edits and re-plans to completion), regression rate (did it break something else).

- **Common failure modes:** editing files outside scope, plan assumptions breaking mid-execution (re-plan), verifier sharing the producer's blind spots, context loss across long tasks.

- **Applies to this codebase:** **No.** aptkit's agents are read-only analytics and retrieval — none plans, edits, or verifies code. There is no writable-file scope (nothing writes anything), no plan object (aptkit uses ReAct, not plan-and-execute — [../01-reasoning-patterns/04-plan-and-execute.md](../01-reasoning-patterns/04-plan-and-execute.md)), and no verifier-critic loop (quality is held by structural validators, not a critic agent — [../03-multi-agent-orchestration/05-debate-verifier-critic.md](../03-multi-agent-orchestration/05-debate-verifier-critic.md)). The one adjacent fragment: aptkit *has retrieval over a corpus* (`search_knowledge_base`), which is the "which files matter" component pointed at documents rather than source — but that's a stretch, not a match.

- **How to make it apply:** This is the largest refactor of the three, because it needs three things aptkit deliberately lacks. (1) A **write tool** with a scoped allowlist — a `ToolHandler` that edits files, behind a `ToolPolicy` restricting *which* paths are writable (the least-privilege model extends naturally, but aptkit currently grants only read tools). (2) **Plan-and-execute** — a planning call before the loop and a plan object threaded through state, plus a re-plan trigger; aptkit's loop is pure ReAct. (3) A **verifier** — run tests or review the diff, ideally with a *different model family* critic to avoid shared blind spots (the `ModelProvider` swap makes this possible). aptkit's read-only, validator-gated design is the opposite of what this template needs; it would be a new system, not a reframing. Honestly: aptkit is not a coding agent and shouldn't be reframed as one — this template's value here is naming exactly what would have to change.
