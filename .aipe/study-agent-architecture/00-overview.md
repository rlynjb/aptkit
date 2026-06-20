# Agent Architecture in AptKit — Overview

One page to put the whole thing on the map before you open any concept file.

## The shape this repo matches: single-agent (with a latent sequential pipeline)

AptKit is a **single-agent codebase**. Six capabilities, each one ReAct-style
loop with tools, a tool policy, a prompt package, a loop budget, and a
validator. There is no autonomous planner choosing which agent runs, no
supervisor delegating to workers, no agent spawning sub-agents, and no
long-term memory store. (Trajectory persistence and a multi-device "body" are
deferred to a separate repo — not present here.) The sixth capability,
`rag-query`, is the same single-agent shape pointed at a *real vector store* and
driven by a local Gemma; it is the first agentic-RAG-over-similarity-index
capability in the repo. Where the spec's multi-agent topologies show up at
all, they show up as a *latent* pipeline: the three diagnostic agents are
wired by their **data contracts** (`Anomaly` → `Diagnosis` → `Recommendation`),
not by a live orchestrator. `investigate(anomaly)` consumes a scan output and
`propose(anomaly, diagnosis)` consumes an investigation output — but no code in
the repo currently runs all three end to end. That gap is the single most
important honest fact in this guide, and it gets its own deep treatment in
`03-multi-agent-orchestration/03-sequential-pipeline.md`.

```
  Where the agent loop sits in AptKit

  ┌─ App / Studio layer (apps/studio) ───────────────────────────┐
  │  React panels → POST /api/replay/* → agent.scan()/.answer()  │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  one call = one capability run
  ┌─ Agent layer (packages/agents/*) ─────────────────────────────┐
  │  MonitoringAgent · DiagnosticAgent · RecommendationAgent      │
  │  QueryAgent · RubricImprovementAgent                          │
  │  each = prompt package + tool policy + ★ runAgentLoop ★ + validator │ ← we are here
  └───────────────────────────────┬──────────────────────────────┘
                                  │  ToolExecutor seam · ModelProvider seam
  ┌─ Runtime + Tools layer (packages/runtime, packages/tools) ────┐
  │  runAgentLoop · CapabilityEvent trace · ToolRegistry/Policy   │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  ModelProvider.complete()
  ┌─ Provider layer (packages/providers/*) ───────────────────────┐
  │  anthropic · openai · fallback chain · local context guard    │
  └───────────────────────────────────────────────────────────────┘
```

## The one file that carries the weight

`packages/runtime/src/run-agent-loop.ts`. Every capability in the repo is a
thin wrapper that hands a prompt, a tool policy, a budget, and a validator to
`runAgentLoop`. Read that file once and you have read the agent kernel five
times over. Its load-bearing mechanics:

- **Bounded ReAct loop** — `for (let turn = 0; turn < maxTurns; ...)`, model
  proposes tool calls, the harness executes them, results feed back, repeat.
- **Two budgets, both required** — `maxTurns` (default 8) caps the loop;
  `maxToolCalls` caps tool spend independently. Either one trips the budget exit.
- **The forced synthesis turn** — on the last turn (or when the tool budget is
  spent), the loop drops the tool schemas and appends a `synthesisInstruction`,
  forcing the model to answer from what it already gathered instead of asking
  for more queries. This is the most important and most surprising mechanic in
  the file.
- **The `ToolExecutor` seam** — the model emits tool *intent*; the harness runs
  the tool. The model never touches a tool directly. That boundary is the
  entire control and safety story.
- **Fallback recovery** — if `parseResult` returns `null`, a one-shot
  `recoveryPrompt` turn re-asks for the structured shape using the evidence
  already gathered.

## The six capabilities

| Capability | Pattern | maxTurns / maxToolCalls | Output |
| --- | --- | --- | --- |
| `anomaly-monitoring-agent` | ReAct (scan) | 8 / 6 | `Anomaly[]`, severity-sorted, top 10 |
| `diagnostic-investigation-agent` | ReAct (hypothesis test) | 8 / 6 | `Diagnosis` + inferred confidence |
| `recommendation-agent` | ReAct (grounded propose) | 6 / 4 | `Recommendation[]`, ≤3 |
| `query-agent` | routed ReAct | 8 / 6 | plain-text answer |
| `rubric-improvement-agent` | self-critique loop | 6 / 3 | scored judgment + next action |
| `rag-query-agent` | agentic RAG over vector search (local Gemma, tool emulation) | 6 / 4 | cited prose answer, profile-shaped |

## Reading order

Sub-sections run `A → B → C → D → E → F`, then the codebase pattern file:

1. `01-reasoning-patterns/` — the loop kernel and the single-agent family (the core)
2. `02-agentic-retrieval/` — tool-calling-as-retrieval: analytics tools (files
   01–03) and real vector search via `rag-query` (file 04)
3. `03-multi-agent-orchestration/` — the latent pipeline, and everything not yet built
4. `04-agent-infrastructure/` — tool policy, coverage gate, structured-output contract, control envelope
5. `05-production-serving/` — what the budgets, fallback chain, and context guard buy under a loop
6. `06-orchestration-system-design-templates/` — the repo reframed as three interview prompts
7. `agent-patterns-in-this-codebase.md` — the patterns table, grounded in real files

Start with `01-reasoning-patterns/02-agent-loop-skeleton.md`. Everything else
hangs off it.
