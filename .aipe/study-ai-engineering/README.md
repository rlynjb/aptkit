# study-ai-engineering — aptkit

AI engineering + ML study guide for the **aptkit** monorepo
(`@rlynjb/aptkit-core`) and its companion runtime **buffr** (`PgVectorStore`).
Generated per the `study-ai-engineering` spec; voice per `teacher.md`;
calibrated per `me.md`.

Start with [`00-overview.md`](00-overview.md) — the whole system in one
diagram and the three-shapes placement (aptkit is LLM application
engineering, loopd-shaped).

## Directory map

```
study-ai-engineering/
  00-overview.md                      ← the map, read first
  README.md                           ← you are here
  01-llm-foundations/                 ← what the model is, how aptkit talks to it
  02-context-and-prompts/             ← context window, lost-in-the-middle, chaining
  03-retrieval-and-rag/               ← the from-scratch RAG pipeline + the bug
  04-agents-and-tool-use/             ← the bounded loop, emulated tool calling, memory
  05-evals-and-observability/         ← precision@k, rubric-judge, replay
  06-production-serving/              ← caching, cost, injection, backpressure (mostly gaps)
  07-system-design-templates/         ← interview reframes (search, support chatbot)
  08-machine-learning/                ← classical ML as new ground (one bridge)
  09-ml-system-design-templates/      ← recommender, anomaly, CV reframes
  ai-features-in-this-codebase.md     ← the AI features aptkit actually ships
  ml-features-in-this-codebase.md     ← the honest ML answer
```

## Reading order

Foundations → context → retrieval → agents → evals → serving → templates → ML.
The phases mirror building a real LLM system. Each sub-section has its own
`README.md` with its file list and any local reading order.

## What's strongest in this codebase (read these first)

1. **`03-retrieval-and-rag/`** — the from-scratch RAG pipeline behind
   swappable contracts, and the signature hallucinated-filter bug + fix
   (`06-hybrid-retrieval-rrf.md` is a gap, but `11-rag.md` and the
   search-tool walkthrough in `04` are the crown jewels).
2. **`04-agents-and-tool-use/02-tool-calling.md`** — emulated tool calling
   on Gemma (a model with no native tool API). This is rare and defensible.
3. **`05-evals-and-observability/`** — precision@k, anti-circular
   LLM-as-judge (Claude judges Gemma), replay/fixture golden master. The
   eval discipline is the standout interview signal.

## Honest gaps (`not yet exercised`)

Token-by-token LLM streaming, reranking/cross-encoder, hybrid/sparse
(BM25) retrieval, query rewriting/HyDE, GraphRAG, stale-embedding tracking
in aptkit (buffr has the schema slot), semantic/prompt caching, provider
rate limiting / circuit breaker / backoff, and the entire classical-ML
training track (no trained model anywhere — one bridge: precision@k).
Each affected file marks this honestly and turns it into a buildable
exercise.
