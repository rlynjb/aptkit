# Agent Patterns in This Codebase

What aptkit actually runs — the inventory, not the theory. aptkit is **single-agent-per-capability**: one shared loop, six agents, retrieval as a tool. No multi-agent orchestration.

## The patterns table

```
  ┌──────────────────────┬────────────────────┬─────────────────────────────┐
  │ Feature              │ Pattern / shape    │ Why this pattern            │
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ rag-query agent      │ single-agent /     │ retrieval path can't be     │
  │                      │ agentic RAG (ReAct)│ predicted; model owns WHEN  │
  │                      │                    │ to search                   │
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ recommendation agent │ single-agent /     │ build evidence across 13    │
  │                      │ ReAct (13 tools)   │ read-only tools, then propose│
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ anomaly-monitoring   │ single-agent /     │ scan metrics vs 10 anomaly  │
  │                      │ ReAct (1-pass-ish) │ categories                  │
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ diagnostic-investig. │ single-agent /     │ hypothesis-test one anomaly │
  │                      │ ReAct              │ → confidence-scored Diagnosis│
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ query agent          │ chain (router) +   │ classify intent (chain),    │
  │                      │ single-agent       │ then run the agent          │
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ rubric-improvement   │ single-agent /     │ agentic improvement loop:   │
  │                      │ judge loop         │ score subject → next action │
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ search_knowledge_base│ agentic retrieval  │ retrieval exposed as a TOOL,│
  │                      │ (tool, not splice) │ not a prompt-splice         │
  ├──────────────────────┼────────────────────┼─────────────────────────────┤
  │ @aptkit/memory       │ agentic recall     │ recall = RAG; NOT WIRED into│
  │                      │ (built, not wired) │ any aptkit agent yet        │
  └──────────────────────┴────────────────────┴─────────────────────────────┘
```

## The shared structure

Every agent is the same loop (`runAgentLoop`, `packages/runtime/src/run-agent-loop.ts:76`) with a different prompt, policy, budget, and validator. The capability shape (from the project context):

```
  Capability = prompt package + tool policy + loop config + output validator

  ┌─ agent ──────────────────────────────────────────────────┐
  │  system prompt (template + injectProfile/schemaSummary)   │
  │  filterToolsForPolicy(allTools, policy)  ← least-privilege │
  │  runAgentLoop(maxTurns, maxToolCalls, synthesisInstr)      │
  │  parseResult + validator (+ recovery turn on parse fail)   │
  └────────────────────────────────────────────────────────────┘
```

## Per-agent control envelope

```
  ┌──────────────────────┬──────────┬────────────┬──────────────────┐
  │ Agent                │ maxTurns │ maxToolCall│ output validator │
  ├──────────────────────┼──────────┼────────────┼──────────────────┤
  │ rag-query            │ 6        │ 4          │ (text, fallback) │
  │ recommendation       │ 6        │ 4          │ tryParseRecommen.│
  │ rubric-improvement   │ 6        │ 3          │ validateRubric.. │
  │ runtime default      │ 8        │ (unset)    │ parseResult opt. │
  └──────────────────────┴──────────┴────────────┴──────────────────┘
  + every agent: read-only tool policy · forced synthesis turn ·
    maxTokens cap · CapabilityEvent trace
```

All tools across all agents are **read-only** (`list_*`/`get_*`/search) — the structural guardrail. No agent has a write/delete/send tool, so agent output is inert until the consuming app acts on validated output.

## The topology: there isn't one (in aptkit)

aptkit runs **no multi-agent orchestration**. The six agents are independent capabilities; they don't call each other, share state, or hand off. The shapes aptkit does *not* exercise:

- **Multi-agent orchestration** — no supervisor, no fan-out, no swarm, no graph. The sibling **blooming_insights** app sequences monitoring → diagnostic → recommendation into a 3-stage pipeline (`docs/blooming-insights-aptkit-core-migration-plan.md`); aptkit packages those as independent stages with typed handoffs (`propose(anomaly, diagnosis)`). The *app* composes; the *toolkit* stays single-agent. (See `03-multi-agent-orchestration/03-sequential-pipeline.md`.)
- **Plan-and-execute** — agents are ReAct; no plan phase. (`01-reasoning-patterns/04`.)
- **Reflexion over own answer** — rubric-improvement judges an external subject; the recovery turn salvages parse failures. Neither critiques the agent's own answer. (`01-reasoning-patterns/05`.)
- **Tree of thoughts** — no branching; correctly skipped. (`01-reasoning-patterns/06`.)
- **Agent memory** — `@aptkit/memory` is built and reuses the retrieval contracts, but no agent wires it. buffr's session runtime is the intended consumer. (`04-agent-infrastructure/02`.)
- **Cross-turn cache / fan-out limiter / per-tool breaker** — not built; the loop has the error→observation hook a breaker would use. (`05-production-serving/`.)
- **Human-in-the-loop pause** — the loop runs start-to-finish; no checkpoint/resume. (`03-multi-agent-orchestration/07`.)

## What's genuinely strong here

Three things worth defending in an interview:

1. **Retrieval-as-a-tool** (agentic RAG done right): `search_knowledge_base` is a `ModelTool` the model calls when it judges it needs grounding; the model owns *when*, the loop owns the *budget* (`maxToolCalls: 4`). Hardened for a weak local model with a `minTopK` floor and a fail-open `matchesFilter`. (`02-agentic-retrieval/`.)
2. **The forced synthesis turn**: on the budget exit, the loop strips the tool schemas and forces an answer — turning "out of budget" into a final answer instead of a hang. The most load-bearing mechanic in the repo. (`01-reasoning-patterns/02`.)
3. **Tool-call emulation under a tool-less model**: the Gemma provider fakes the entire tool-call protocol (render tools→system text, parse JSON→`tool_use`, retry on botched JSON) so a model with no native tools speaks the same contract as Anthropic — and `runAgentLoop` never knows. (`04-agent-infrastructure/03`.)

## See also

- `00-overview.md` — the orientation
- `01-reasoning-patterns/02-agent-loop-skeleton.md` — the shared kernel
- `02-agentic-retrieval/01-agentic-rag.md` — the standout pattern
- `03-multi-agent-orchestration/01-when-not-to-go-multi-agent.md` — why aptkit stays single-agent
