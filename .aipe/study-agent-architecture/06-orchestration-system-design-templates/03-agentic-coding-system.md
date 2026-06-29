# Agentic Coding / Build System

A system-design interview template. Nine bullets; the generic architecture is the model answer's shape, the last two bullets are about aptkit.

- **The prompt:** "Design an agent that completes a coding task across a repo — read, plan, edit, verify."

- **Standard architecture:** plan-and-execute (plan the changes, then execute per file) + verifier-critic (run tests / review the diff, loop on failure) + guardrails (scope the writable files, cap iterations).

```
  plan → execute → verify loop

  task → ┌─ plan (which files, what edits) ─┐
         └──────────────┬───────────────────┘
                        ▼
         ┌─ execute (edit per file) ─┐
         └──────────────┬─────────────┘
                        ▼
         ┌─ verify (tests / review) ─┐ ── fail → re-plan (capped)
         └──────────────┬─────────────┘
                        ▼ pass
                      done
```

- **Data model:** repo context (file tree, relevant files retrieved), the plan, the diff, test results, an iteration counter.

- **Key components:** retrieval over the codebase (which files matter), planning, execution (edits), verification (tests/review), the re-plan trigger on verification failure. Decision: plan-and-execute vs pure ReAct for the edit loop.

- **Scale concerns:** large repos blow the context budget (retrieval routing over the codebase), long tasks blow the iteration cap, cost per task.

- **Eval framing:** task success (tests pass), trajectory efficiency (edits and re-plans to completion), regression rate (did it break something else).

- **Common failure modes:** editing files outside scope, plan assumptions breaking mid-execution (re-plan), verifier sharing the producer's blind spots, context loss across long tasks.

- **Applies to this codebase: no.** aptkit is not a coding agent and has none of the load-bearing pieces. There's no plan-and-execute (its agents are ReAct, `01-reasoning-patterns/04-plan-and-execute.md`), no verifier-critic loop (its critic is offline, `03-multi-agent-orchestration/05-debate-verifier-critic.md`), no code editing (all tools are read-only), and no codebase retrieval (its RAG is over a document corpus, not a file tree). aptkit *builds* agents; it isn't an agent that builds code. This is the template aptkit is furthest from.

- **How to make it apply:** This is a near-total new build, but several aptkit primitives transfer. (1) **Plan-and-execute** — the refactor sketched in `01-reasoning-patterns/04-plan-and-execute.md`: split into a plan loop (expensive model) and an execute loop (cheap model), which aptkit's swappable `ModelProvider` makes a config change. (2) **Codebase retrieval** — index the file tree with the existing retrieval pipeline (`createRetrievalPipeline`), so "which files matter" becomes a `search_knowledge_base` call over code chunks. (3) **Verifier-critic** — promote the offline `rubric-judge`/test-result scoring into a live verify step, with a re-plan trigger on failure; run the critic on a different model family (the cross-family critic from the debate file). (4) **Scope guardrail** — the least-privilege tool policy (`filterToolsForPolicy`) becomes a *writable-files* allowlist instead of a tool allowlist, plus the existing iteration caps. The agent-loop kernel, the retrieval pipeline, the eval scorers, and the provider layer all transfer; the new work is write tools, codebase indexing, and the plan/verify loop structure. Honestly: this is a different product, and aptkit's contribution would be the reusable substrate, not the coding agent itself.

## See also

- `01-reasoning-patterns/04-plan-and-execute.md` — the planning refactor
- `03-multi-agent-orchestration/05-debate-verifier-critic.md` — the verify loop
- `02-agentic-retrieval/03-retrieval-routing.md` — codebase retrieval routing
- `04-agent-infrastructure/05-guardrails-and-control.md` — the scope guardrail
