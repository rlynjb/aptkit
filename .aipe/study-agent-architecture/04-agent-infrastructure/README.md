# 04 — Agent Infrastructure

The question this sub-section answers: *once you have an agent loop, what
surrounds it so the thing is safe, observable, evaluable, and fed the right
context.* You already know the loop (`01-reasoning-patterns/`) and the
topologies (`03-multi-agent-orchestration/`). This is the **plumbing layer** —
the un-glamorous code that decides whether your agent is a demo or a product.

## Anchor: single-agent AND multi-agent both

Everything here applies whether you run one loop or five. The same context
discipline, the same tool registry, the same memory tier, the same eval
backbone, the same control envelope wrap *each* `runAgentLoop` call. AptKit is
single-agent today, but the infrastructure is topology-neutral — when the latent
`monitor → diagnose → recommend` pipeline goes live (see
`../03-multi-agent-orchestration/03-sequential-pipeline.md`), every concept in
this folder still holds, just instantiated three times.

## The map: five concentric shells around the loop

Think of the agent loop as the core, and these five concepts as shells you can
peel off independently. Each shell answers a different production question.

```
  Agent infrastructure: five shells around runAgentLoop

  ┌─ 05 GUARDRAILS & CONTROL ── "can it run away or do damage?" ──────────┐
  │  maxTurns · maxToolCalls · forced synthesis · validate · AbortSignal  │
  │  ┌─ 04 EVALUATION ── "is the output correct, run after run?" ───────┐ │
  │  │  CapabilityEvent trace → replay artifact → eval → promoted fixture│ │
  │  │  ┌─ 03 TOOL CALLING ── "what can the model reach for?" ────────┐ │ │
  │  │  │  ToolRegistry + ToolPolicy + filterToolsForPolicy           │ │ │
  │  │  │  ┌─ 02 MEMORY ── "what does it remember?" ────────────────┐ │ │ │
  │  │  │  │  working tier ONLY = messages[] (dies on return)       │ │ │ │
  │  │  │  │  ┌─ 01 CONTEXT ENGINEERING ── "what fills the window?"┐ │ │ │ │
  │  │  │  │  │  prompt template + schemaSummary + 16k truncation  │ │ │ │ │
  │  │  │  │  │  ┌─ runAgentLoop (the kernel from sub-section 01) ┐│ │ │ │ │
  │  │  │  │  │  └────────────────────────────────────────────────┘│ │ │ │ │
  │  │  │  │  └─────────────────────────────────────────────────────┘ │ │ │ │
  │  │  │  └───────────────────────────────────────────────────────────┘ │ │ │
  │  │  └─────────────────────────────────────────────────────────────────┘ │ │
  │  └───────────────────────────────────────────────────────────────────────┘ │
  └─────────────────────────────────────────────────────────────────────────────┘
   read inside-out: each shell depends on the one it wraps, not the other way
```

Read inside-out. Context (01) decides what goes into the window. Memory (02) is
*which* context survives across turns. Tool calling (03) is how the model
fetches more context mid-run. Evaluation (04) checks the output the loop
produced. Guardrails (05) bound the whole thing so it can't run away or do harm.

## Reading order

```
  01-context-engineering.md   ★ what fills the window — the superset
        │   (prompt + workspace schema + tool-result truncation)
        ▼
  02-agent-memory-tiers.md    working / episodic / long-term
        │   (AptKit has ONLY working = messages[]; honest about the rest)
        ▼
  03-tool-calling-and-mcp.md  the registry + the policy seam
        │   (direct tool defs, NOT MCP; the registry IS the gateway)
        ▼
  04-agent-evaluation.md      trajectory + shape eval via the trace
        │   (replay artifact → eval → promoted fixture → deterministic replay)
        ▼
  05-guardrails-and-control.md the control envelope
            (budgets + forced synthesis + validate + abort + READ-ONLY grant)
```

## Files

- **[01-context-engineering.md](01-context-engineering.md)** — the discipline of
  curating what fills the context window. AptKit's three levers: a per-agent
  prompt template, a deterministic `schemaSummary(workspace)`, and a 16k-char
  tool-result truncation. The superset that prompt, RAG, memory, and tool
  outputs are all subsets of.
- **[02-agent-memory-tiers.md](02-agent-memory-tiers.md)** — working / episodic /
  long-term. The six agents here **run the working tier only** (`messages[]`, gone
  on return), but the repo now **ships an episodic-memory engine** —
  `@aptkit/memory` (`remember`/`recall` as RAG over past exchanges) + a
  `search_memory` tool — that no agent in this repo wires; the conversational loop
  that does, with a durable `PgVectorStore`, lives in buffr. The load-bearing
  distinction is engine-shipped vs loop-wired.
- **[03-tool-calling-and-mcp.md](03-tool-calling-and-mcp.md)** — `ToolRegistry` +
  `ToolPolicy` + `filterToolsForPolicy` + the `ToolExecutor` seam. Direct
  provider-neutral tool schemas, **not MCP**. The registry IS the gateway-style
  abstraction; MCP is the standardization AptKit hasn't adopted.
- **[04-agent-evaluation.md](04-agent-evaluation.md)** — the replay-artifact
  backbone. Live run → replay artifact JSON → eval → promote to fixture →
  deterministic replay. The `CapabilityEvent` trace is what makes
  trajectory/tool-call eval possible. Shape/structural validators + rubric-judge.
- **[05-guardrails-and-control.md](05-guardrails-and-control.md)** — the control
  envelope: `maxTurns` + `maxToolCalls` + forced synthesis + parse/validate/
  recovery + `AbortSignal` + the **READ-ONLY tool grant**. Honest about no
  human-in-the-loop and no input-sanitization layer.

## See also

- `../00-overview.md` — the whole system in one diagram
- `../agent-patterns-in-this-codebase.md` — the patterns table with file:line
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the kernel these shells
  wrap
- `../03-multi-agent-orchestration/09-coordination-failure-modes.md` — the
  failure table these controls bound
- `../06-orchestration-system-design-templates/` — SECTION F: where the
  not-yet-exercised patterns become concrete designs
- `.aipe/study-ai-engineering/` — context-window mechanics, memory split,
  LLM-as-judge bias (the foundations, not re-taught here)
