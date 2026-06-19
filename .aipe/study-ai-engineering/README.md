# AI Engineering Study Guide — AptKit

This guide reads the AptKit monorepo as an AI-engineering codebase and teaches
the patterns it actually exercises, anchored to real `file:line` references.

AptKit is the **LLM-application-engineering shape**: a bounded agent loop,
structured-output generation with retry, a provider abstraction over multiple
LLM vendors, a token/cost ledger, and — the standout — a replay-driven eval
layer (detection scoring, rubric-as-LLM-judge, structural diff, artifact
assertions). That eval layer is the highest-signal AI-engineering content in
the repo; start there if you only read one section.

## Reading order

Each concept file is self-contained and follows the
[format](../specs/README.md) template (Zoom out → Structure pass → How it works
→ Implementation → Elaborate → Project exercises → Interview defense → Validate
→ See also). Read in this order for a clean build-up, or jump straight to a
section.

```
00-overview.md                  ← read this first: the whole repo in one map

01-llm-foundations/             ← the model as a function; what AptKit wraps
02-context-and-prompts/         ← context window, prompt packages, chaining
03-retrieval-and-rag/           ← NOT YET EXERCISED — taught as foundations
04-agents-and-tool-use/         ← the bounded agent loop (the core primitive)
05-evals-and-observability/     ← THE STANDOUT — replay → eval → promote
06-production-serving/          ← fallback chain, context guard, retry
07-system-design-templates/     ← interview reframes (search, support chatbot)
08-machine-learning/            ← NOT YET EXERCISED — taught as new ground
09-ml-system-design-templates/  ← interview reframes (rec, anomaly, CV)

ai-features-in-this-codebase.md ← every AI feature in AptKit, as a table
ml-features-in-this-codebase.md ← honest: AptKit ships no trained ML model
```

## What this repo exercises vs. what it doesn't

The guide is honest about scope. AptKit is a strong LLM-application toolkit, but
it deliberately does not ship some of the canonical AI-engineering machinery.
Each `not yet exercised` topic is taught as a foundation, with a Project
Exercises block naming the concrete build that would make it real here.

| Exercised in AptKit | Not yet exercised (taught as foundations) |
| --- | --- |
| Bounded agent loop (`run-agent-loop.ts`) | RAG / vector store / embeddings |
| Structured output + retry (`structured-generation.ts`) | Token streaming from the provider |
| Provider abstraction + fallback chain | Semantic / prompt caching |
| Token + cost ledger (`usage-ledger.ts`) | Classical ML training / inference |
| Heuristic-before-LLM intent routing | Reranking, query rewriting, HyDE |
| Replay → eval → promote-to-fixture | Rate limiting / circuit breaker |
| Rubric-as-LLM-judge, detection scoring | GraphRAG, hybrid retrieval (RRF) |

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
  (`04-agents-and-tool-use/03-react-pattern.md`); the orchestration *on top* of
  that loop is agent-architecture territory.

## Provenance note

No `aieng-curriculum.md` exists in this repo, so Project Exercises cite
curriculum phase + concept ranges (e.g. *Phase 4 — C4.x*) by convention rather
than exact Build-item IDs. The exercises themselves always target AptKit's own
files.
