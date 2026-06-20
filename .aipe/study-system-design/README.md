# System Design — AptKit

A per-repo system-design study guide for the AptKit monorepo: where components live, how data and work move, where boundaries fail, and what changes at scale. Audit-style two-pass output — one audit walking eight lenses, plus nine discovered-pattern files named after the architecture this repo actually exercises.

AptKit is a TypeScript ESM npm-workspace monorepo of 15 internal packages of reusable AI-agent capabilities (published as `@rlynjb/aptkit-core` 0.4.x). No SQL database, no horizontal scale, no queues — the "data" is file-, stream-, and (now) in-memory-vector-shaped (trace events, replay artifacts, fixtures, an embedded corpus). The default model is *local*: Gemma + nomic embeddings over Ollama. Read that honestly: the interesting architecture here is the **provider-neutral seam**, the **bounded agent loop**, the **capability-as-policy** model, the **replay→eval→fixture** testing backbone, the **single-tarball publish boundary**, and the newest addition — a **from-scratch retrieval (RAG) pipeline** that adds two more provider-neutral seams. The horizontal-scale lenses still come back `not yet exercised`; the one real internal bottleneck is the in-memory vector store's linear scan.

## Reading order

Start at the top, then read pattern files in the order that builds on what came before.

```
  1. 00-overview.md   ← the whole system in one diagram. Skim only this and you have the map.
  2. audit.md         ← Pass 1: eight lenses walked against real file:line evidence.

  Pass 2 — discovered patterns (read in this order):
  3. 01-provider-abstraction.md      the central seam: everything talks to ModelProvider.complete()
  4. 02-bounded-agent-loop.md        the kernel that turns "call an LLM" into a terminating capability
  5. 03-fallback-chain.md            cross-provider recovery + the context-window guard
  6. 04-capability-as-tool-policy.md per-agent read-only allowlists (least privilege)
  7. 05-multi-agent-pipeline.md      monitor → diagnose → recommend composition
  8. 06-replay-eval-pipeline.md      live run → artifact → eval → promote-to-fixture → deterministic replay
  9. 07-ndjson-stream-handoff.md     runtime emits trace events; Studio streams them to a React UI
 10. 08-monorepo-bundle-boundary.md  15 internal packages → one published tarball, no app logic leaks
 11. 09-retrieval-pipeline-seam.md   from-scratch RAG: two swappable adapters (embed + vector store) behind a tool
```

If you only have ten minutes: read `00-overview.md` and `02-bounded-agent-loop.md`. The bounded loop is the load-bearing mechanism of the whole repo. If you have a few more, `09-retrieval-pipeline-seam.md` shows how the same seam pattern lets a whole RAG capability drop in with no new control flow.

## Cross-links to neighboring guides

System-design owns architectural boundaries and tradeoffs. Mechanism-level teaching lives in the foundation guides. Where a seam touches another discipline, this guide points there:

- **`.aipe/study-data-modeling/`** — the *shape* of the persistent data (CapabilityEvent union, replay-artifact keys, fixture structure, WorkspaceDescriptor). This guide cites those shapes; that guide normalizes them.
- **`.aipe/study-dsa-foundations/`** — the reusable data-structure/algorithm vocabulary. The Map-backed registry, the Set-backed allowlist, the linear fallback scan live here as *architecture*; their algorithmic cost lives there.
- **study-software-design** (`.aipe/study-software-design/` when generated) — APOSD primitives: deep modules, information hiding, layering. The `ModelProvider` contract as a deep module belongs there too.
- **`.aipe/study-agent-architecture/`** — reasoning patterns inside the loop (ReAct, synthesis turns, agentic retrieval), and multi-agent orchestration as an *agent* concern rather than a *system* concern. The rag-query agent's "always search first, then synthesize with citations" reasoning belongs there; the *seam* it plugs into belongs here (`09-retrieval-pipeline-seam.md`).
- **`.aipe/study-ai-engineering/`** — the eval methodology (structural-diff, detection-scorer, rubric-judge) as an AI-quality discipline, plus RAG *quality* (chunking strategy, embedding choice, retrieval relevance). This guide treats the eval pipeline as observability infrastructure and the retrieval pipeline as an architectural seam; that guide treats both as model quality.
- **study-distributed-systems** (when generated) — `not yet exercised` here. No coordination crosses a process boundary except the synchronous HTTP call to a provider SDK.

## What this guide does not cover

- Database engine internals — there is no database.
- Network/transport mechanics (TLS, connection pooling, DNS) — owned by study-networking; the only wire hop is the provider SDK's HTTPS call.
- Horizontal scale, load balancing, multi-region, queues — `not yet exercised`. The audit names this honestly rather than inventing it.
