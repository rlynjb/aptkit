# Study — AI Engineering (aptkit)

A per-concept study guide for the AI engineering patterns in **aptkit** (and its
companion runtime **buffr**). aptkit is an LLM application engineering codebase:
a provider-neutral agent core, a from-scratch RAG pipeline, episodic memory over
the same contracts, and an eval/replay backbone.

Written in the teacher voice (`teacher.md`), calibrated to a visual-first reader
pivoting from frontend into AI engineering (`me.md`), structured per `format.md`.

## Reading order

```
  01 LLM foundations        ── move fast; you have the shapes from AdvntrCue
        │
  02 Context and prompts    ── the window as a budget; chaining
        │
  03 Retrieval and RAG      ◄── HEART of this repo (contracts, the filter bug)
        │
  04 Agents and tool use    ◄── HEART (emulated tools, bounded loop, memory)
        │
  05 Evals and observability ◄─ what most candidates can't defend; the backbone
        │
  06 Production serving      ── caching, cost, injection, retry/breaker
        │
  07 System design templates ── interview reframes (search ranking, support bot)
        │
  08 Machine learning        ── STUDY-ONLY: aptkit has no training pipeline
        │
  09 ML system design templates ── interview reframes; honest "no" / "partially"
```

## Index

### 01-llm-foundations/
`what-an-llm-is` · `tokenization` · `sampling-parameters` ·
`structured-outputs` · `streaming` · `token-economics` ·
`heuristic-before-llm` · `provider-abstraction` · `user-override-locks`

### 02-context-and-prompts/
`context-window` · `lost-in-the-middle` · `prompt-chaining`

### 03-retrieval-and-rag/
`embeddings` · `embedding-model-choice` · `chunking-strategies` ·
`vector-databases` · `dense-vs-sparse` · `hybrid-retrieval-rrf` ·
`reranking` · `query-rewriting-hyde` · `stale-embeddings` ·
`incremental-indexing` · `rag` · `graphrag`

### 04-agents-and-tool-use/
`agents-vs-chains` · `tool-calling` · `react-pattern` ·
`tool-routing` · `agent-memory` · `error-recovery`

### 05-evals-and-observability/
`eval-set-types` · `eval-methods` · `llm-as-judge-bias` · `llm-observability`

### 06-production-serving/
`llm-caching` · `llm-cost-optimization` · `prompt-injection` ·
`rate-limiting-backpressure` · `retry-circuit-breaker`

### 07-system-design-templates/
`search-ranking` · `tech-support-chatbot`

### 08-machine-learning/
`supervised-pipeline` · `feature-engineering` · `train-val-test` ·
`model-selection` · `class-imbalance` · `domain-gap` · `transfer-learning` ·
`confusion-matrices` · `calibration` · `recommender-systems` · `cold-start` ·
`on-device-inference` · `quantization` · `training-run-logging` ·
`drift-detection` · `retraining-pipelines`

### 09-ml-system-design-templates/
`recommender-system` · `anomaly-detection` · `object-detection-cv`

### Root
`00-overview.md` — the whole AI system in one picture
`ai-features-in-this-codebase.md` — how aptkit actually uses LLMs
`ml-features-in-this-codebase.md` — the honest ML inventory (it's empty)

## A note on the curriculum

No `aieng-curriculum.md` or `curriculum.md` exists in this repo's `.aipe/project/`.
Project-exercise blocks therefore cite no `[Bx.y]` IDs — they name concrete,
buildable next steps against aptkit's and buffr's real files instead. When a
curriculum is added later, the exercise blocks can be re-keyed to its Build items.

## Cross-links to sibling guides

- **study-prompt-engineering** — prompt anatomy, few-shot, CoT, prompt-as-code
  (the discipline that lives next to this one; aptkit's prompt packages anchor it).
- **study-agent-architecture** — reasoning patterns and multi-agent orchestration
  (the agent loop and the 6 capabilities here are its raw material).
- **study-dsa-foundations** — cosine similarity, top-k ranking, the heap behind
  a real ANN index.
- **study-database-systems** — pgvector storage layout, HNSW, the `<=>` operator.
- **study-testing** — the eval harness as the correctness backbone; replay golden
  masters.
