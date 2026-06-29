# Study — Data Modeling (aptkit + buffr)

The question this guide answers: **does the data's shape match how it's
actually read and written — and can it stay correct as it evolves?**

This repo has *two* data models, and the interesting tension is the seam
between them.

```
  Two data models, one contract between them

  ┌─ aptkit (this repo) ───────────────────────────────────┐
  │  IN-MEMORY / STREAM shapes — no SQL here                │
  │   VectorChunk {id, vector:number[], meta}               │
  │   VectorHit   {id, score, meta}                         │
  │   MemoryTurn / MemoryHit  (kind='memory' rows)          │
  │   CapabilityEvent  (discriminated-union trace)          │
  │                                                         │
  │   the VectorStore contract  ◄── the seam ──┐            │
  └────────────────────────────────────────────┼───────────┘
                                                │ implements
  ┌─ buffr (companion repo) ────────────────────▼───────────┐
  │  PERSISTENT RELATIONAL model — the `agents` schema       │
  │   documents · chunks (pgvector) · conversations          │
  │   · messages · profiles      app_id-keyed                │
  └──────────────────────────────────────────────────────────┘
```

aptkit never touches SQL. It defines vendor-neutral *shapes* (the
`VectorStore` contract, the `CapabilityEvent` union) and an in-memory
adapter (`InMemoryVectorStore`). buffr supplies the durable side: a
Postgres `agents` schema and a `PgVectorStore` that implements the same
contract. **The whole data-modeling story is what that contract forces the
schema to look like** — and where the schema deviates from clean
normalization to keep the contract honest.

## The two partition seams (what is NOT here)

```
  study-data-modeling   the SHAPE of the data: schema, normalization,    ← here
                        indexes vs queries, integrity, migrations.
  study-system-design   WHICH datastore + the PgVectorStore adapter
                        boundary as architecture.  → cross-link, not here.
  study-database-systems  pgvector/HNSW internals, MVCC, the storage
                        engine beneath the schema.  → cross-link.
  study-security        app_id tenancy as a trust boundary, no RLS.
                        → the security consequence lives there.
```

Against **system-design**: "buffr supplies a `PgVectorStore` behind a
swappable contract" is architecture → there. "the `chunks` table dropped a
foreign key and stores facts in a JSON bag" is data-model shape → here.

Against **database-systems**: "HNSW is an approximate-nearest-neighbour
index with `m`/`ef_construction` knobs" is engine internals → there. "we
put an HNSW index on `embedding` because every query is a cosine
nearest-neighbour scan" is index-vs-query-shape → here.

## Reading order

```
  00-overview.md   the whole model in one diagram + the through-line
  audit.md         Pass 1 — all 7 data-modeling lenses walked against
                   both repos, `not yet exercised` named honestly

  01-soft-fk-for-drop-in-parity.md      ← the dropped FK (the headline)
  02-metadata-as-a-json-bag.md          ← meta jsonb + rebuild-on-read
  03-kind-tag-shared-collection.md      ← memory + docs in one collection
  04-embedding-dimension-one-way-door.md ← dimension as a hard constraint
  05-app-id-tenancy-without-rls.md      ← the discriminator column
  06-trace-as-message-rows.md           ← the persisted trajectory
```

Start with `00-overview.md`, then `audit.md`. The numbered files are the
patterns this repo actually exercises — read them worst-tension-first
(01 → 02 → 03).

## Cross-links

- **study-system-design** — the `VectorStore`/`PgVectorStore` adapter seam
  as architecture; provider-neutral core.
- **study-database-systems** — pgvector, HNSW, cosine distance operator,
  MVCC under the `on conflict do update` upsert.
- **study-security** — `app_id` tenancy with no row-level security; the
  `meta jsonb` bag as an unvalidated-input surface.
- **study-software-design** — normalization is information-hiding for data;
  the dropped FK is a deliberate duplication/coupling call.
