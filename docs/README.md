# AptKit Docs

Documentation index for AptKit — the provider-neutral toolkit for building LLM agents,
published as [`@rlynjb/aptkit-core`](https://www.npmjs.com/package/@rlynjb/aptkit-core).

## For developers using the package

- **[core-api.md](core-api.md)** — **API reference** for `@rlynjb/aptkit-core`. Install/import,
  a runnable local-RAG quick start, the four swap-seam contracts (`ModelProvider`,
  `VectorStore`, `EmbeddingProvider`, `ToolRegistry`), and source-grounded signatures for the
  runtime, providers (local-first Gemma/Ollama), retrieval/RAG, tools, prompts/context, evals,
  and the six prebuilt agents.

## For evaluating output quality

- **[studio-evaluation.md](studio-evaluation.md)** — using **AptKit Studio** to evaluate agent
  output quality: the replay-centric loop (live run → artifact → eval → promote → deterministic
  replay), reading a run's output/trace/eval, the eval methods (structural-diff,
  detection-scorer, rubric-judge / LLM-as-judge, precision@k / recall@k), fixture-vs-live drift,
  and promoting a good run to a correctness baseline.
- **[studio.md](studio.md)** — general Studio UI tour (panels, replay shell, the static demo).

## Background & operations

- [capability-inventory.md](capability-inventory.md) — the catalog of capabilities/agents.
- [npm-publishing.md](npm-publishing.md) — publishing notes (see also the repo-root `RELEASE.md`
  for the current `@rlynjb/aptkit-core` release flow).
- [model-tool-architecture-notes.md](model-tool-architecture-notes.md) — provider/tool architecture.
- [personal-agent-packages.md](personal-agent-packages.md) — the RAG/Gemma packages design
  (the buffr companion runtime builds on these).

## Where things live

```
  @rlynjb/aptkit-core (npm)  ──► the published, deployment-agnostic library
  apps/studio                ──► local preview + quality-evaluation UI
  buffr (companion repo)     ──► a Supabase-backed runtime that consumes the package
```
