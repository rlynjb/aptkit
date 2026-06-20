# Agent Patterns in This Codebase

What AptKit actually does, grounded in real files. No aspiration, no
hand-waving — the patterns that are in the code, and the ones that are not.

## The verdict first

AptKit is a **single-agent codebase**: six ReAct loops that share one kernel.
The kernel is `runAgentLoop` in `packages/runtime/src/run-agent-loop.ts:76`.
Every capability is a thin class that assembles a prompt, a tool policy, a loop
budget, and a validator, then calls that one function. There is no orchestrator,
no planner, no supervisor. The multi-agent pipeline you might expect from the
three diagnostic agents is **latent** — wired by data types, not by running code.
The sixth capability, `rag-query`, is the same single-agent shape pointed at a
real vector store (see `02-agentic-retrieval/04-agentic-rag-over-vector-search.md`).

## The patterns table

| Feature | File | Pattern / shape | Why this pattern |
| --- | --- | --- | --- |
| Bounded agent loop | `packages/runtime/src/run-agent-loop.ts:76` | ReAct kernel (single-agent) | step count depends on what the model finds; needs a loop, not a chain |
| Anomaly scan | `packages/agents/anomaly-monitoring/src/monitoring-agent.ts:57` | ReAct, 8 turns / 6 tool calls | dynamic: which metrics to query depends on what the prior query returned |
| Diagnostic investigation | `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:55` | ReAct (hypothesis test), 8 / 6 | explore-then-conclude; path can't be predicted up front |
| Recommendation | `packages/agents/recommendation/src/recommendation-agent.ts:64` | ReAct (grounded), 6 / 4 | check existing features before proposing; tighter budget |
| Query answering | `packages/agents/query/src/query-agent.ts:75` | routed ReAct, 8 / 6 | intent router picks a *string*, then one loop over ~35 read-only tools |
| Intent routing | `packages/agents/query/src/intent.ts:12` | heuristic + LLM router | one cheap classify call picks `monitoring`/`diagnostic`/`recommendation` |
| Rubric improvement | `packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:57` | self-critique loop, 6 / 3 | scores a subject against a rubric; the model judges, not produces |
| RAG query | `packages/agents/rag-query/src/rag-query-agent.ts:62` | agentic RAG over vector search, 6 / 4 | model decides when to `search_knowledge_base`; grounds + cites; driven by a *local Gemma* with tool-call emulation |
| Tool gating | `packages/tools/src/tool-policy.ts:11` | per-capability least-privilege allowlist | each agent sees only its role's tools |
| Coverage gate | `packages/tools/src/coverage-gate.ts:73` | pre-model runnability filter | drop tasks that can't run before spending tokens |
| Structured output | `packages/runtime/src/run-agent-loop.ts:192` + each `validate.ts` | parse → validate → one-shot recovery | typed result contract per capability |
| Provider resilience | `packages/providers/fallback/src/fallback-provider.ts:47` | sequential fallback chain | try providers in order; a 5xx on one falls through to the next |
| Context guard | `packages/providers/local/src/context-window-guard.ts:57` | pre-flight token estimate | skip a local provider whose window the request would blow |
| Trace | `packages/runtime/src/events.ts:1` | `CapabilityEvent` union (step / tool_call_start / tool_call_end / model_usage / warning / error) | the agent's observable reasoning trace, streamed as NDJSON |

## The agent loop, drawn

Every capability above is this same shape with a different prompt, policy, and
budget. This is the structure the repo bets on.

```
  runAgentLoop — the shape shared by all five agents
  (packages/runtime/src/run-agent-loop.ts:76)

  ┌─ Agent class (packages/agents/*/src) ────────────────────────┐
  │  assemble: system prompt + tool policy + budget + validator  │
  └───────────────────────────────┬──────────────────────────────┘
                                  │  one call
                                  ▼
  ┌─ runAgentLoop (runtime) ──────────────────────────────────────┐
  │  for turn in 0..maxTurns:                                     │
  │    forceFinal = last turn OR toolCalls >= maxToolCalls        │
  │    response = model.complete(tools = forceFinal ? none : all) │
  │    emit trace: model_usage, step                              │
  │    if no tool_use blocks → finalText, break  ── success exit  │
  │    for each tool_use:                                         │
  │      emit tool_call_start                                     │
  │      tools.callTool(name, args)  ── the ToolExecutor seam     │
  │      emit tool_call_end                                       │
  │    push tool_result back into messages → loop                │
  │  ── budget exit: forced synthesis turn (no tools)            │
  │  parsed = parseResult(finalText)                             │
  │  if parsed === null → recoveryPrompt() one-shot turn         │
  └───────────────────────────────────────────────────────────────┘
```

The two load-bearing parts most people forget are both here: the **budget exit**
(`forceFinal = turn === maxTurns - 1 || budgetSpent`, line 102) and the
**forced synthesis turn** (`tools: forceFinal ? undefined : toolSchemas`,
line 105, plus `buildSynthesisInstruction`, line 72). Without the budget exit a
model can cycle tool calls until it burns the token budget. Without the forced
synthesis turn it can end a run by asking for more queries it'll never get.

## The latent pipeline

The three diagnostic agents *could* form a sequential pipeline:

```
  The pipeline that exists in the TYPES, not in running code

  ┌──────────────┐  Anomaly   ┌──────────────┐  Diagnosis  ┌──────────────┐
  │ MonitoringAgt│ ─────────► │ DiagnosticAgt│ ──────────► │ Recommend.Agt│
  │ .scan()      │            │ .investigate │             │ .propose(    │
  │ → Anomaly[]  │            │  (anomaly)   │             │  anomaly,    │
  └──────────────┘            │ → Diagnosis  │             │  diagnosis)  │
                              └──────────────┘             └──────────────┘
       each runs in isolation today; no caller chains all three end to end
```

`investigate(anomaly: Anomaly)` (diagnostic-agent.ts:55) and
`propose(anomaly: Anomaly, diagnosis: Diagnosis)` (recommendation-agent.ts:64)
take the previous stage's output type as input. But the only places that touch
more than one agent — `apps/studio/src/agent-runners.ts` and
`apps/studio/vite.config.ts` — run each agent against its *own fixture*
independently, not as a chain. **The pipeline is a data contract, not an
orchestrator.** Wiring it live is the refactor named in
`03-multi-agent-orchestration/03-sequential-pipeline.md` and in the SECTION F
templates.

## What this codebase does NOT do (and why that's fine)

- **No LLM planner choosing agents.** The query intent router
  (`packages/agents/query/src/intent.ts:12`) classifies a query into one of
  three intent *strings* and biases one prompt — it does not dispatch to a
  different agent. There is no router that picks `MonitoringAgent` vs
  `RecommendationAgent` at runtime.
- **No supervisor-worker, fan-out, debate, swarm, or graph.** Five independent
  loops, period. Single-agent hasn't hit a quality ceiling that would justify
  the 2-5x coordination tax of going multi-agent.
- **No persistent memory.** State lives in the `messages` array for the
  duration of one `runAgentLoop` call and is gone when the run returns. No
  episodic or long-term tier.
- **Vector retrieval now exists — in one capability.** Five agents do
  "retrieval" as tool-calling over workspace analytics APIs
  (`execute_analytics_eql`, `get_metric_timeseries`, etc.) with no embeddings.
  The sixth, `rag-query`, does real vector RAG: `@aptkit/retrieval` chunks and
  embeds a corpus with `nomic-embed-text`, an in-memory cosine store does ANN,
  and the `search_knowledge_base` tool grounds + cites. Driven by a local Gemma
  via tool-call emulation — see
  `02-agentic-retrieval/04-agentic-rag-over-vector-search.md`. The store/embedder
  *mechanics* are ai-engineering's partition, not this guide's.
- **No cross-turn cache, fan-out backpressure, or per-tool circuit breaker.**
  The budgets and the fallback chain are the only serving controls.

Every one of these is a deliberate "not yet" for a single-agent system that
works. The system design templates in `06-orchestration-system-design-templates/`
name the concrete refactor each would require.

## See also

- `00-overview.md` — the whole system in one diagram
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel, taught
- `02-agentic-retrieval/04-agentic-rag-over-vector-search.md` — the sixth
  capability: agentic RAG over real vector search, local Gemma, tool emulation
- `03-multi-agent-orchestration/03-sequential-pipeline.md` — the latent pipeline, deep
- `04-agent-infrastructure/03-tool-calling-and-mcp.md` — the tool policy + coverage gate
