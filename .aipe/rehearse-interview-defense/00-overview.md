# Interview Defense — AptKit

This book is for the moment an interviewer leans back and says "so, tell me about something you built." You have aptkit. The problem isn't that you don't understand it — you do, you wrote it. The problem is translating that understanding into speech, under pressure, in ninety seconds, without rambling, and then holding ground when the follow-ups come.

That's a separate skill from building. This book trains it.

## The project at a glance — the diagram every chapter hangs off

This is the master picture. Every chapter zooms into one band of it. When you re-anchor, come back here.

```
  APTKIT — a deployment-agnostic agent toolkit (npm: @rlynjb/aptkit-core@0.4.1)
  buffr — the durable runtime that consumes it (Supabase-backed laptop body)

  ┌─ STUDIO ────────────────────────────────────────────────────────┐
  │  React 18 + Vite · hash-routed · replays traces · in-browser RAG │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │
  ┌─ AGENTS (6 capabilities) ─────▼──────────────────────────────────┐
  │  recommendation · anomaly-monitoring · diagnostic-investigation  │
  │  query · rubric-improvement · rag-query (capstone)               │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │ runAgentLoop (bounded, traced)
  ┌─ RUNTIME ─────────────────────▼──────────────────────────────────┐
  │  agent loop · CapabilityEvent trace · forced synthesis turn      │
  │  PORT: ModelProvider.complete()      ◄── the first seam          │
  └──────────┬──────────────────────────────────┬─────────────────────┘
             │                                  │
  ┌─ PROVIDERS ▼──────────────┐   ┌─ RETRIEVAL ▼──────────────────────┐
  │  gemma (local default,    │   │  PORTS: EmbeddingProvider +       │
  │   EMULATED tool-calling)  │   │   VectorStore  ◄── the second seam│
  │  local guard · fallback   │   │  InMemoryVectorStore (cosine)     │
  │  anthropic · openai       │   │  nomic-embed-text, 768-dim        │
  │  (cloud, unbundled)       │   │  search_knowledge_base tool       │
  └───────────────────────────┘   └───────────────┬───────────────────┘
                                                  │ same contracts
                              ┌────────────────────▼──────────────────┐
                              │  buffr: PgVectorStore implements       │
                              │  VectorStore over Supabase pgvector    │
                              │  + HNSW; agents schema; app_id tenancy │
                              └────────────────────────────────────────┘

  The whole defense rests on two seams: the model port and the retrieval ports.
  Everything else is an adapter plugged into one of them.
```

The one sentence to carry out of this diagram: **aptkit is a library defined by two contracts — the model port and the retrieval ports — and buffr is one deployment that fills the slots.** If you can say that and then walk either seam, you can defend the project.

## How to use this book

```
  FIRST READ        chapters in order, one per sitting. The chapters
                    build — the pitch (01) sets up the architecture (02),
                    which sets up the choices (03), and so on.

  REVIEW            skim the chapter-opening diagrams + the pull quotes
                    + the side-by-side tables. That's ~70% of the book.

  NIGHT BEFORE      read only the one-page summary at the end of each
                    chapter. Eight pages, ~20 minutes, the whole defense.
```

## The chapters

```
  00  overview            this file — the map + the master diagram
  01  the pitch           the first 60 seconds: 10s / 30s / 90s
  02  the architecture    walk me through the system (whiteboard in 90s)
  03  the choices         why local Gemma, why RAG-from-scratch, why one
                          bundle, why in-memory-first — every load-bearing call
  04  the scale story     what breaks first at 10x users / 100x data / 10x latency
  05  the failure story   LLM outage, DB read-only, hallucinated tool args,
                          partial writes — what the system does in each
  06  the hard parts      the silent-empty-results bug · the proudest seam ·
                          the weakest spot
  07  the counterfactuals what you'd reconsider: 4 decisions, honestly ranked
  08  the AI question     "did you use AI to build this?" — own it in three modes
```

## What each chapter defends, in one line

- **01 — the pitch.** Compression. Most candidates ramble; you won't. aptkit is a library that extracts the reusable parts of an agent system behind two contracts.
- **02 — the architecture.** The whiteboard. Studio → agents → runtime (the model port) → providers + retrieval (the vector ports) → buffr fills the durable slot.
- **03 — the choices.** Four load-bearing decisions, each with the alternative, the criterion, and the cost you're paying.
- **04 — the scale story.** The in-memory cosine scan is the first thing that breaks; buffr's HNSW is the answer; you know where the next bottleneck is.
- **05 — the failure story.** Bounded loop, fallback chain, dimension-mismatch-fails-loud, hallucination-tolerant filter, begin/commit/rollback.
- **06 — the hard parts.** The agent said "not available" on a good corpus — you read buffr's persisted trajectory backward and found a hallucinated filter zeroing results.
- **07 — the counterfactuals.** What you'd flip and what you wouldn't, and why "wouldn't" is the senior answer too.
- **08 — the AI question.** Deliberate / evaluated-and-accepted / defaulted-to. Own all three.

## Connecting to the rest of the study system

This is the **project-level** defense — the wide opener. The **concept-level** defenses live in the Interview-defense block inside each pattern file under `.aipe/study-system-design/` and `.aipe/study-ai-engineering/`. The concept files prepare the deep dive (one decision in full). This book prepares the wide opener (the whole project). Pair them: read this for the shape, read those for the moment an interviewer drills one pattern.

```
  ▸ aptkit is a library defined by two contracts.
    buffr is one deployment that fills the slots.
    Defend that sentence and you can defend the project.
```
