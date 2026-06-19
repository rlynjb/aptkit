# 02 — Agentic Retrieval

> Retrieval in AptKit is **tool-calling over workspace analytics APIs**, driven
> by a loop the agent controls. There are **no embeddings, no vector DB, no ANN,
> no chunking** in this codebase. When this sub-section says "retrieval," it
> means: the model calls a read-only analytics tool (`execute_analytics_eql`,
> `get_metric_timeseries`, `get_segments`, `get_event_segmentation`,
> `get_anomaly_context`, …), looks at what came back, and decides what to call
> next — until it has enough to answer. That decide-and-query-again behavior is
> exactly what "agentic retrieval" names. The *source* is just structured
> analytics endpoints instead of a similarity index.

## Why this is its own sub-section

You already know RAG mechanics from AdvntrCue: embed the query, ANN-search
pgvector, stuff the top-k chunks into a GPT-4 prompt, answer once. That is
**retrieval as a function call** — one hop, fixed, before generation.

Agentic retrieval is retrieval **as a loop the model steers**. The model issues
a query, *reads the result*, and the result changes the next query. AptKit's
monitoring and diagnostic agents do this over analytics tools. The whole thing
runs inside one function — `runAgentLoop` at
`packages/runtime/src/run-agent-loop.ts:76` — and every "retrieval" decision in
this sub-section is a tool call inside that loop's `for` body.

```
  RAG-as-function (AdvntrCue)        vs      Agentic retrieval (AptKit)

  query                                       query
    │                                           │
    ▼                                           ▼
  embed → ANN top-k → prompt → answer    ┌──► call analytics tool
    │                                    │      │
    └─ one hop, then stop                │      ▼
                                         │    read result
                                         │      │
                                         │      ▼
                                         └─── enough? ──no──┐
                                                │ yes        │
                                                ▼            │
                                             synthesize  ◄───┘ query again
```

The right column is the loop you are about to study, three times, over real
files.

## Anchor: single-agent

Everything here is **one agent** running its own retrieval loop. No second agent
fetches for it, no router service sits in front. The "router" in AptKit is the
*model itself* choosing which tool to call next, inside the loop. Keep that
single-agent frame: it is why AptKit's retrieval routing (file 03) is *implicit*
rather than a standalone component.

## Reading order

```
  01-agentic-rag.md ──────► the loop: query tool → evaluate → query again → synthesize
        │                   monitoring + diagnostic agents ARE this
        ▼
  02-self-corrective-rag.md ─► the relevance-grader pattern
        │                   NOT a separate component here; diagnostic
        │                   hypothesis-testing is the closest honest analog
        ▼
  03-retrieval-routing.md ─► route the query to the right source
                            here: model picks the right TOOL among ~35,
                            one source type, no multi-source router
```

1. **`01-agentic-rag.md`** — the core. The driven loop, anchored to the
   monitoring scan and the diagnostic investigation. Read this first; 02 and 03
   are variations on it.
2. **`02-self-corrective-rag.md`** — the relevance-grading idea (CRAG/Self-RAG).
   Honest treatment: AptKit has no standalone grader. The diagnostic agent's
   `supported`/`reasoning` per-hypothesis evaluation is the nearest analog.
3. **`03-retrieval-routing.md`** — picking the source. AptKit routes *within one
   source type* by tool selection; the coverage gate pre-filters which retrieval
   tasks are even runnable before any tokens are spent.

## What lives elsewhere

- **All vector-retrieval mechanics** — embeddings, chunking, vector DBs, hybrid
  search, GraphRAG, reranking: `.aipe/study-ai-engineering/03-retrieval-and-rag/`.
  This sub-section cross-references that material; it does not re-teach it.
- **The ReAct pattern** the loop implements:
  `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`.
- **The loop kernel itself**: `../01-reasoning-patterns/02-agent-loop-skeleton.md`.
- **Routing as a reasoning pattern**: `../01-reasoning-patterns/07-routing.md`.
- **Tool-calling and MCP plumbing**: `../04-agent-infrastructure/03-tool-calling-and-mcp.md`.
- **The patterns table**: `../agent-patterns-in-this-codebase.md`.
