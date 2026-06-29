# Study — Data Modeling (aptkit + buffr)

The question this guide answers: **does the data's shape match how it's
actually read and written — and can it stay correct?**

This repo has *two* data models, and the interesting part is the seam
between them. aptkit defines vendor-neutral, in-memory shapes
(`VectorChunk`, `VectorHit`, memory rows, the `CapabilityEvent` trace).
buffr is the deployment "body" that turns those shapes into a persistent
Postgres `agents` schema (`documents`, `chunks` with a pgvector column,
`conversations`, `messages`, `profiles`). The schema is shaped to be a
*drop-in implementation of aptkit's `VectorStore` contract* — and that
single design pressure explains almost every non-obvious choice in the
DDL (the dropped FK, the JSON `meta` bag, the rebuilt-on-read shape).

```
  the two-model seam — where this guide lives

  ┌─ aptkit (deployment-agnostic, in-memory) ───────────────┐
  │  VectorChunk {id, vector:number[], meta}                │
  │  VectorHit   {id, score, meta}                          │
  │  MemoryTurn / MemoryHit   (meta.kind='memory')          │
  │  CapabilityEvent  (discriminated union, NDJSON)         │
  └───────────────────────────┬─────────────────────────────┘
                              │  VectorStore contract
                              │  (upsert / search)
  ┌─ buffr (Supabase Postgres "body") ─▼────────────────────┐
  │  agents.documents · agents.chunks (vector(768)+HNSW)    │
  │  agents.conversations · agents.messages · agents.profiles│
  │  PgVectorStore implements VectorStore, rebuilds meta     │
  └──────────────────────────────────────────────────────────┘
```

## Two partition seams (what's NOT in this guide)

- **vs `study-system-design`** — *which* datastore and how it scales
  (Postgres choice, Supabase, sharding, replicas) is architecture → that
  guide. *How the table is shaped and indexed* is here.
- **vs `study-database-systems`** — the HNSW index *as a storage-engine
  mechanism* (graph layout, recall/latency knobs) is engine-internals →
  that guide. *Whether the index matches the query* is here.
- **vs `study-dsa-foundations`** — the in-memory cosine scan as an
  algorithm is DSA. The on-disk vector column + index is data modeling.
- Normalization is information-hiding for data (single source of truth).
  The CODE analog lives in `study-software-design`; not re-taught here.

## Reading order

```
  00-overview.md                          one-page orientation + schema map
  audit.md                                Pass 1 — the 7-lens audit, this repo

  Pass 2 — the patterns this repo actually exercises:
  01-dropped-fk-for-drop-in-parity.md     the FK that was deliberately removed
  02-metadata-as-json-bag.md              meta jsonb vs typed columns
  03-embedding-dimension-one-way-door.md  the dimension integrity constraint
  04-app-id-tenancy-without-rls.md        soft multi-tenancy, no RLS yet
  05-kind-tag-logical-partition.md        memory + docs in one collection
  06-trace-as-append-only-log.md          agents.messages as the trajectory
```

## Cross-links

- `study-system-design` — the provider/retrieval-neutral seams, the
  aptkit↔buffr split as architecture.
- `study-database-systems` — pgvector HNSW internals, transactions.
- `study-security` — `app_id` tenancy and the deferred RLS gap
  (04 here cross-links there; the security audit owns the trust call).
