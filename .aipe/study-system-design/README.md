# Study — System Design (aptkit)

The architecture actually present in this repo: where components live, how
data and work move, who owns each boundary, what happens when a boundary
fails, and what changes at 10x. Grounded in real files. `not yet exercised`
where the repo doesn't reach a topic — no invented infrastructure.

aptkit is a provider-neutral TypeScript monorepo published as one npm bundle
(`@rlynjb/aptkit-core@0.4.1`). Its architecture is two ports and a bounded
loop: `ModelProvider.complete()` (the model seam) and
`EmbeddingProvider`/`VectorStore` (the retrieval seam), with `runAgentLoop`
driving capabilities between them. The deployment "body" lives in a separate
repo (**buffr**), which fills the slots aptkit leaves open.

## Reading order

```
  00-overview.md   ← read this first: one diagram, the whole map
        │
        ▼
  audit.md         ← the 8-lens system-design audit (what's there, what isn't)
        │
        ▼
  01 … 07          ← the patterns this repo actually exercises
```

1. `00-overview.md` — one-page orientation. One full-system ASCII diagram
   plus a legend: what each component is, what it owns, what it talks to.
2. `audit.md` — Pass 1. The 8 system-design lenses walked against the live
   codebase, each grounded or marked `not yet exercised`.
3. Pattern files (Pass 2), in dependency order:
   - `01-provider-abstraction.md` — the model seam (`ModelProvider`); five adapters, one contract
   - `02-retrieval-as-a-tool.md` — RAG behind two ports, reached as `search_knowledge_base`
   - `03-bounded-agent-loop.md` — turn + tool-call budget + forced synthesis
   - `04-capability-event-trace.md` — the NDJSON observability seam (`CapabilityEvent`)
   - `05-library-vs-deployment-split.md` — aptkit (slots) vs buffr (fills them)
   - `06-single-bundle-publishing.md` — 16 packages → one tarball
   - `07-fixture-replay-evals.md` — live run → artifact → eval → promote → deterministic replay

## Cross-links to neighboring guides

System design owns architectural boundaries and tradeoffs. Mechanism-level
detail belongs to the foundation guides:

- **`study-software-design`** — the code-level altitude. The standard
  role-vocabulary for the seam patterns here (port / adapter / client /
  factory / dependency injection) is owned there under PATTERN VOCABULARY.
  This guide leads with those role-names and keeps the repo's local names in
  parens; it does not redefine the vocabulary.
- **`study-database-systems`** — the pgvector storage engine, HNSW index
  internals, cosine-distance operator (`<=>`) execution. buffr's
  `PgVectorStore` is the only durable store; engine internals live there.
- **`study-data-modeling`** — the shape of buffr's `agents` schema
  (documents/chunks/conversations/messages/profiles, `app_id`-keyed).
- **`study-distributed-systems`** — coordination under partial failure. The
  fallback chain and the single-process boundary are noted here; the
  correctness reasoning lives there.
- **`study-runtime-systems`** — the `runAgentLoop` execution model, the
  AbortSignal cancellation path, the event loop.
- **`study-ai-engineering`** / **`study-agent-architecture`** — agentic
  retrieval, the ReAct-shaped loop, multi-agent capability composition.
