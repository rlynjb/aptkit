# Study — System Design (aptkit)

This is the per-repo system-design guide for **aptkit** — the provider-neutral
TypeScript agent toolkit published as one npm bundle (`@rlynjb/aptkit-core@0.4.1`)
and consumed by its deployment "body", **buffr** (`/Users/rein/Public/buffr`).

It is written in the audit-style two-pass shape:

- **Pass 1 — `audit.md`** walks the 8 system-design lenses across the live repo,
  every lens checked, `not yet exercised` named honestly.
- **Pass 2 — the numbered files** are the architectural patterns aptkit actually
  exercises. The file names are the lesson: read the list and you already know
  what this repo is.

## Reading order

```
  1. 00-overview.md   ← the whole system in one diagram + legend
  2. audit.md         ← the 8-lens sweep; jumps into the pattern files
  3. 01 → 07          ← the discovered patterns, load-bearing first
```

1. `00-overview.md` — one-page orientation. The full-system map across Studio →
   agents → runtime → providers → retrieval/memory, and the library/deployment
   seam to buffr. Skim only this and you have the map.
2. `audit.md` — Pass 1. Eight `##` sections, one per lens, each grounded in
   `file:line` or marked `not yet exercised`. Cross-links into the pattern files.
3. The pattern files (Pass 2), ranked by how load-bearing they are:
   - `01-provider-neutral-model-seam.md` — the `ModelProvider.complete()` contract
     that the entire toolkit is built around. The one seam that, removed, dissolves
     the project's reason to exist.
   - `02-retrieval-contracts-as-the-swap-point.md` — the `EmbeddingProvider` /
     `VectorStore` contracts; how `InMemoryVectorStore` and buffr's `PgVectorStore`
     are the same shape, and how memory rides the same boundary for free.
   - `03-library-vs-deployment-split.md` — aptkit (deployment-agnostic) vs buffr
     (the durable Postgres body). Where the seam is drawn and what crosses it.
   - `04-bounded-agent-loop.md` — `runAgentLoop`: the iteration budget, the forced
     synthesis turn, the per-tool failure containment.
   - `05-capability-event-trace.md` — the `CapabilityEvent` trace stream; one
     observability contract, three sinks (Studio NDJSON, buffr Postgres, in-memory).
   - `06-fixture-replay-evals.md` — live run → artifact → eval → promote → replay.
     The deterministic test backbone over a non-deterministic model.
   - `07-single-bundle-publishing.md` — 16 internal packages collapsed into one
     `bundledDependencies` tarball; the published API as a compatibility contract.

## Cross-links to neighboring guides

System-design owns architectural boundaries and tradeoffs only. Mechanism-level
teaching lives in the foundation guides:

- **`study-database-systems`** — pgvector storage, HNSW indexing, cosine distance
  operators, transaction mechanics inside buffr's `PgVectorStore`.
- **`study-data-modeling`** — the shape of the `agents` schema (chunks, documents,
  conversations, messages), the `app_id` partition key, the dropped FK that lets
  memory rows live without a parent document.
- **`study-distributed-systems`** — coordination correctness once buffr runs more
  than one process; what the current single-process design does *not* yet handle.
- **`study-runtime-systems`** — the single-process event-loop execution model the
  agent loop runs inside; cancellation via `AbortSignal`.
- **`study-ai-engineering`** / **`study-agent-architecture`** — RAG mechanics,
  agentic retrieval, the reasoning loop as an AI pattern (this guide treats the
  loop as an *architectural boundary*; those treat it as an AI pattern).
- **`study-software-design`** — module/interface quality of the same contracts
  (deep modules, information hiding) that this guide treats as system boundaries.
