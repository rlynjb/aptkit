# Study — Data Modeling · AptKit

The question this guide answers: **does the data's shape match how it's actually read and written — and can it stay correct over time?**

Before anything else, the honest verdict: **AptKit has no SQL/relational database.** No ORM, no migrations, no foreign keys, no SQL DDL. So if you came here for "show me the schema and the migration files," there are none, and you should not pretend otherwise in an interview.

But "no relational database" is not "no data model." AptKit has a data model that is *type-shaped*, *file/stream-shaped*, and — since `@aptkit/retrieval` landed — *store-shaped*. The `@aptkit/retrieval` package adds the repo's first genuine corpus: a vector store that models a corpus as `(id, vector, meta)` rows you `upsert` and `search` (in-memory now, the same shape as pgvector). That's covered in `06-vector-store-row-model.md`. Four things carry the modeling weight:

```
  AptKit's data model — where the schema actually lives

  ┌─ TYPE schema (compile-time) ───────────────────────────────┐
  │  WorkspaceDescriptor   — the domain entity model           │
  │  CapabilityEvent       — the event-log (tagged union)      │
  │  ModelRequest/Response — the provider wire schema          │
  │      packages/context, packages/runtime                    │
  └────────────────────────┬───────────────────────────────────┘
                           │ serialized to disk as JSON
  ┌─ FILE schema (on disk) ▼────────────────────────────────────┐
  │  artifacts/replays/*.json     — versioned read-models       │
  │  packages/agents/*/fixtures/  — recorded inputs + baselines │
  │      schemaVersion: 1  ← the migration story lives here     │
  └────────────────────────┬───────────────────────────────────┘
                           │ validated against
  ┌─ INTEGRITY layer ──────▼────────────────────────────────────┐
  │  packages/evals/{assertions,structural-diff}.ts             │
  │      shape assertions = the constraint layer the DB would   │
  │      normally enforce (NOT NULL, type, required path)       │
  └──────────────────────────────────────────────────────────────┘

  ┌─ STORE schema (in-memory rows) ─────────────────────────────┐
  │  VectorChunk { id, vector, meta } / VectorHit { id,score,…} │
  │      packages/retrieval — the repo's first row-shaped model │
  │      dimension = the first WRITE-time CHECK constraint      │
  └──────────────────────────────────────────────────────────────┘
```

The TypeScript compiler is the schema enforcer at write time; `packages/evals` is the constraint enforcer at read time; `schemaVersion: 1` is the only versioning primitive in the whole repo. The one exception to "no write-time enforcement" is `@aptkit/retrieval`'s dimension check — the first invariant in the repo that fires synchronously, on write, with a throw (see `06`).

## The two partition seams

This guide is data **shape**. Two neighbors own the things it does not:

- **vs `study-system-design`** — "should AptKit use Postgres? shard by tenant? add a replica? move the vector store to pgvector + an ANN index?" is *architecture* and lives there. "This artifact is shaped wrong / this read-model duplicates a fact / this corpus row should be `(id, vector, meta)`" is *shape* and lives here. AptKit's storage choices (flat JSON files on disk; an in-memory `Map` for the corpus) are system-design calls; the *shape* of what goes in them is this guide.
- **vs `study-software-design`** — normalization is information-hiding for data: one fact, one home, no duplication. That principle is taught in `study-software-design`'s information-hiding concept; this guide *applies* it to the data (and finds a real duplication, see `02-tagged-union-event-log.md` and the audit) rather than re-teaching the principle.

## Reading order

1. **`00-overview.md`** — the whole data model in one diagram; the entity model drawn from the real types; the honest "no DB" framing.
2. **`audit.md`** — the seven data-modeling lenses walked against AptKit. Most come back `not yet exercised` (you have no DB). This file is where the honesty lives, and where each relational concept is mapped to its nearest in-repo analog.
3. **The discovered pattern files** — the modeling that AptKit *does* exercise, each load-bearing:

| File | Pattern | What it is |
| --- | --- | --- |
| `01-type-as-schema.md` | type-as-schema | TypeScript types as the domain schema (`WorkspaceDescriptor`, the wire types) — the relational-table analog |
| `02-tagged-union-event-log.md` | tagged-union event log | `CapabilityEvent` discriminated union — an append-only event-log schema |
| `03-versioned-artifact-schema.md` | versioned artifact schema | `schemaVersion: 1` on replay artifacts — the migration story, made explicit |
| `04-fixture-promotion-lifecycle.md` | fixture promotion lifecycle | live run → artifact → promoted fixture — a data-lifecycle / versioning pattern |
| `05-structural-diff-integrity.md` | structural-diff integrity | `assertions.ts` + `structural-diff.ts` — the integrity-constraint layer over the artifacts |
| `06-vector-store-row-model.md` | vector-store row model | `@aptkit/retrieval`'s `VectorChunk`/`VectorHit` — the repo's first store-shaped model: `(id, vector, meta)` rows, deterministic ids, soft docId linkage, dimension-as-invariant |

Each pattern file uses the full concept template: zoom out → structure pass → how it works → implementation in the real code → interview defense → validate.
