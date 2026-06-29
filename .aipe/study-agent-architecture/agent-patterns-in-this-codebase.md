# Agent Patterns in This Codebase

How aptkit actually uses agent patterns — the loops that exist, the topology (none), what each capability does and which pattern it instantiates. Grounded in real files.

## The shape: single-agent-per-capability

aptkit is single-agent. There is one reasoning loop — the agent loop / ReAct loop (`runAgentLoop`, `packages/runtime/src/run-agent-loop.ts`) — and six capabilities, each one instance of it: prompt package + tool policy (least-privilege allowlist via `filterToolsForPolicy`) + loop config + output validator. No supervisor, no agent-to-agent handoff, no shared blackboard. Where the analytics agents are sequenced (monitor → diagnose → recommend), the sequencing lives in the *host*, not in aptkit.

## Agent patterns table

| Capability | Pattern / shape | Why this pattern | Loop config |
| --- | --- | --- | --- |
| `rag-query` | single-agent · agentic RAG (ReAct) | model decides when to retrieve; one tool | maxTurns 6, maxToolCalls 4 |
| `recommendation` | single-agent · ReAct over read-only tools | gather evidence across 13 tools, then propose | maxTurns 6, maxToolCalls 4 |
| `anomaly-monitoring` | single-agent · scan/detect (near single-turn) | scan metrics against 10 anomaly categories | (loop, short) |
| `diagnostic-investigation` | single-agent · ReAct (hypothesis-test) | one anomaly → tested diagnosis with confidence | (loop) |
| `query` | single-agent · routing + ReAct | classify intent, then answer over ~49 read-only tools | (loop) + cheap classify |
| `rubric-improvement` | single-agent · agentic improvement loop | score a subject, find weakest dimension, next action | maxTurns 6, maxToolCalls 3 |

All six share: `runAgentLoop`, a `*_CAPABILITY_ID`, a read-only `ToolPolicy` allowlist, and an output validator. The `rag-query` agent is the 6th instance of the capability shape and the clearest agentic-retrieval example.

## The one loop, drawn

```
  runAgentLoop — the single loop all six capabilities run
  (packages/runtime/src/run-agent-loop.ts)

  prompt ─► messages[] (state) ─► [for turn < maxTurns]
              step: model.complete (tools withheld at budget)
              → tool_use? → tools.callTool → accumulate → loop
              → no tool_use? → finalText → break (success exit)
              → budget hit → forced synthesis turn (budget exit)
            ─► parseResult → recovery turn on parse failure
```

## Control envelope (every capability)

- **Input:** `filterToolsForPolicy` (`packages/tools/src/tool-policy.ts`) — the agent sees only its allowlisted tools. rag-query: 1 tool. recommendation: 13 read-only. query: ~49 read-only.
- **Loop:** `maxTurns` + `maxToolCalls` + the forced synthesis turn (`run-agent-loop.ts:101`).
- **Output:** per-agent `validate.ts` + the parse-recovery turn (`run-agent-loop.ts:204`); output is validated *data the host acts on*, never a direct side effect.

## Eval (the backbone)

Replay-centric: live run → replay artifact (output + `CapabilityEvent` trace + `modelTurns`) → eval (`structural-diff` / `detection-scorer` / `rubric-judge` / `precision-at-k`) → promote to fixture → deterministic replay via `FixtureModelProvider`. The promoted fixture is a frozen golden *trajectory*. Gap: `rubric-improvement` has no `replay:promoted` script wired into the root pipeline; cross-run trajectory-efficiency dashboards are `not yet exercised`.

## Retrieval and memory

- **Agentic retrieval (live):** `search_knowledge_base` (`packages/retrieval/src/search-knowledge-base-tool.ts`) — retrieval as a tool, with a `minTopK` floor and a hallucination-tolerant `matchesFilter` hardening a weak local model (Gemma).
- **Memory (built, not wired):** `@aptkit/memory` reuses the `EmbeddingProvider`/`VectorStore` contracts — `remember` = RAG index path, `recall` = RAG query path, partitioned by a `kind: 'memory'` tag. **No aptkit agent wires it;** buffr's session runtime is the intended consumer. `not yet exercised` in any aptkit agent.

## What this codebase does NOT do (named honestly)

- **No multi-agent orchestration** — no supervisor, no fan-out, no handoff, no shared state between agents. Analytics agents are independent capabilities; the host sequences them.
- **No plan-and-execute, reflexion, or tree-of-thoughts** — every loop is bounded ReAct. `rubric-improvement` is a single-pass external-subject critique, not self-reflexion.
- **No cross-turn caching, fan-out backpressure, or per-tool circuit breaking** — the loop catches tool errors as observations but carries no breaker state; tool-result truncation (16k chars, `run-agent-loop.ts:52`) is the one real serving control.
- **No human-in-the-loop pause** — high-stakes outputs are returned as data for the host to approve; the loop can't checkpoint and resume.

The system design templates in [06-orchestration-system-design-templates/](06-orchestration-system-design-templates/) name the refactor each of these would require. The closest match to aptkit's current shape is the **agentic support/task system** ([06-orchestration-system-design-templates/02-agentic-support-system.md](06-orchestration-system-design-templates/02-agentic-support-system.md)).
