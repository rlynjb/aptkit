# AI Engineering Study Guide — AptKit

This guide reads the AptKit monorepo as an AI-engineering codebase and teaches
the patterns it actually exercises, anchored to real `file:line` references.

AptKit is the **LLM-application-engineering shape**: a bounded agent loop,
structured-output generation with retry, a provider abstraction over multiple
LLM vendors (now including a **local Gemma** adapter with emulated tool-calling),
a token/cost ledger, a replay-driven eval layer, and — new this session — a
**from-scratch vector RAG stack**: an embedding provider (nomic, 768-dim), an
in-memory cosine vector store, the index/query pipeline, a `search_knowledge_base`
tool, a grounded RAG agent (`rag-query`), and a ranked-retrieval scorer
(precision@k / recall@k). The whole RAG path runs **zero-cloud** (local Gemma +
local nomic over Ollama). The eval layer remains the highest-signal section; the
RAG stack is the headline addition.

Scope partition worth fixing up front: aptkit ships the **library** — the
in-memory pipeline and the scorers. The durable persistence (`PgVectorStore` /
Supabase pgvector) and the live precision@k run over a real corpus live in the
separate **buffr** repo, which assembles these packages into a running service.
This guide cites aptkit's files only and marks the buffr seam where relevant.

## Reading order

Each concept file is self-contained and follows the
[format](../specs/README.md) template (Zoom out → Structure pass → How it works
→ Implementation → Elaborate → Project exercises → Interview defense → Validate
→ See also). Read in this order for a clean build-up, or jump straight to a
section.

```
00-overview.md                  ← read this first: the whole repo in one map

01-llm-foundations/             ← the model as a function; what AptKit wraps
                                   (+ 10: local Gemma vs cloud — open weights)
02-context-and-prompts/         ← context window, prompt packages, chaining
03-retrieval-and-rag/           ← ★ NOW EXERCISED — real vector RAG (local-first)
04-agents-and-tool-use/         ← the bounded agent loop (+ 07: emulated tools)
05-evals-and-observability/     ← THE STANDOUT — replay → eval → promote
                                   (+ 05: precision@k, the retrieval RULER)
06-production-serving/          ← fallback chain, context guard, retry
07-system-design-templates/     ← interview reframes (search, support chatbot)
08-machine-learning/            ← NOT YET EXERCISED — taught as new ground
09-ml-system-design-templates/  ← interview reframes (rec, anomaly, CV)

ai-features-in-this-codebase.md ← every AI feature in AptKit (now six), as a table
ml-features-in-this-codebase.md ← honest: AptKit ships no trained ML model
```

## What this repo exercises vs. what it doesn't

The guide is honest about scope. AptKit is a strong LLM-application toolkit, but
it deliberately does not ship some of the canonical AI-engineering machinery.
Each `not yet exercised` topic is taught as a foundation, with a Project
Exercises block naming the concrete build that would make it real here.

| Exercised in AptKit | Not yet exercised (taught as foundations) |
| --- | --- |
| Bounded agent loop (`run-agent-loop.ts`) | Durable persistence (`PgVectorStore`/Supabase — in **buffr**) |
| Structured output + retry (`structured-generation.ts`) | Token streaming from the provider |
| Provider abstraction + fallback chain + **local Gemma** | Semantic / prompt caching |
| **Vector RAG: embeddings (nomic 768) + in-memory store + pipeline** | Classical ML training / inference |
| **`search_knowledge_base` tool + `rag-query` grounded agent** | Reranking, query rewriting, HyDE |
| **Emulated tool-calling (Gemma prompt-for-JSON + parse-retry)** | Sparse / hybrid retrieval (BM25, RRF), GraphRAG |
| Token + cost ledger (`usage-ledger.ts`) | Rate limiting / circuit breaker |
| Replay → eval → promote-to-fixture | Stale-embedding tracking / incremental indexing |
| Rubric-as-LLM-judge, detection scoring, **precision@k / recall@k** | Live precision@k over a real corpus (in **buffr**) |

A precise distinction the guide holds throughout: **AptKit streams `CapabilityEvent`
trace records to the UI over NDJSON, but it does NOT stream LLM tokens.** Every
provider call is `await`ed whole. See `01-llm-foundations/05-streaming.md` for
why that distinction matters.

## Cross-links to sibling guides

- **Prompt engineering** (`.aipe/study-prompt-engineering/`) — the prompt
  packages, versioning, and eval-driven prompt iteration are its own discipline.
  When this guide hits a prompt seam it links there rather than duplicating it.
- **Agent architecture** (`.aipe/study-agent-architecture/`) — multi-agent
  orchestration, the monitor→diagnose→recommend pipeline, and agentic retrieval
  live there. This guide teaches the *single-agent loop mechanics*
  (`04-agents-and-tool-use/03-react-pattern.md`) and the *retrieval mechanics* the
  `rag-query` agent uses (`03-retrieval-and-rag/`); the orchestration *of* that
  agent's loop — its tool policy, forced-synthesis turn, budget — is
  agent-architecture territory.
- **buffr repo** (separate codebase) — the running service that binds these
  packages to durable storage (`PgVectorStore` / Supabase pgvector) and runs the
  live precision@k eval over a real corpus. aptkit is the library; buffr is the
  body. This guide marks the seam where a concept's persistence/live-run half
  lives in buffr.

## Provenance note

No `aieng-curriculum.md` exists in this repo, so Project Exercises cite
curriculum phase + concept ranges (e.g. *Phase 4 — C4.x*) by convention rather
than exact Build-item IDs. The exercises themselves always target AptKit's own
files.
