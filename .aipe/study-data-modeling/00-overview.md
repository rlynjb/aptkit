# Overview — AptKit's data model

## The verdict, first

AptKit is a TypeScript monorepo that packages reusable AI-agent capabilities. It has **no relational database, no ORM, no migration framework, no foreign keys.** If you open the repo looking for `migrations/0003_chunks.sql`, there is nothing there.

That is not a gap to apologize for — it's a deliberate consequence of what AptKit *is*. It's a library and a Studio preview tool. Its persistent data is mostly two things: recorded test fixtures and recorded run artifacts, both flat JSON files on disk. The "live" data (a workspace's events, a customer's properties) is *input* that flows through the types and is never owned by AptKit; the host app owns that.

The one exception — and it's a recent and important one — is `@aptkit/retrieval`. That package adds a genuine **store-shaped** model: a vector store that holds a corpus as `(id, vector, meta)` rows, with `upsert`/`search`, deterministic chunk ids, a soft document linkage, and a real write-time `CHECK` (the embedding dimension). It's in-memory (a `Map`), not Postgres, but the *shape* is the pgvector row shape unchanged. That's the first thing in the repo that looks like a database table, and it gets its own file: `06-vector-store-row-model.md`.

So the data model lives in four places, and you should be able to point at each:

```
  Where the schema lives — three layers, one question traced through

  question traced: "what enforces the shape here?"

  ┌─ TYPE layer  (packages/context, packages/runtime) ─────────────┐
  │  WorkspaceDescriptor, CapabilityEvent, ModelRequest/Response   │
  │  enforced by:  the TypeScript compiler, at build time          │ ← compiler
  └───────────────────────────┬────────────────────────────────────┘
                  serialize    │  JSON.stringify
  ┌─ FILE layer  (artifacts/replays, packages/agents/*/fixtures) ──▼┐
  │  replay artifacts (schemaVersion: 1), recorded fixtures        │
  │  enforced by:  nothing at write time — JSON has no schema      │ ← NOTHING
  └───────────────────────────┬────────────────────────────────────┘
                  read back    │  JSON.parse → validate
  ┌─ INTEGRITY layer  (packages/evals) ────────────────────────────▼┐
  │  assertReplayArtifactShape, evaluateStructuralDiff             │
  │  enforced by:  hand-written runtime assertions, at read time   │ ← evals
  └──────────────────────────────────────────────────────────────────┘

  ┌─ STORE layer  (packages/retrieval) ─────────────────────────────┐
  │  VectorChunk{id,vector,meta} rows in a Map; cosine-ranked search│
  │  enforced by:  the dimension check, AT WRITE TIME, throws      │ ← retrieval
  └──────────────────────────────────────────────────────────────────┘
```

The seam that matters most: **the type layer enforces shape at write time, but once a value is serialized to JSON on disk, the compiler can no longer help you.** A hand-edited fixture, a stale artifact, a `schemaVersion` bump — none of those are caught by `tsc`. That gap is exactly what `packages/evals` exists to close. The integrity layer is AptKit's substitute for the `CHECK` / `NOT NULL` / type constraints a database would enforce for free.

The exception worth noting up front: `packages/retrieval`'s store layer is the *one* place AptKit enforces an invariant the way a database does — synchronously, at write time, with a throw. The embedding dimension must match or `upsert`/`search` reject the vector outright (`in-memory-vector-store.ts:36-42`). Every other invariant in the repo is enforced after the fact by evals; this one can't be, because a wrong-dimension vector silently corrupts ranking. See `06-vector-store-row-model.md`.

## The domain entity model (drawn from the real types)

The closest thing AptKit has to a relational schema is `WorkspaceDescriptor` in `packages/context/src/workspace-descriptor.ts`. It's a denormalized *read-model*: one object that carries a project, its events, its customer properties, its catalogs, and pre-computed totals — everything an agent needs to reason about a workspace, in one shape, no joins.

```
  WorkspaceDescriptor — the entity model (one denormalized read-model)

  ┌─────────────────────────────────────────────┐
  │ WorkspaceDescriptor                          │
  │  projectId        : string   (the "PK")      │
  │  projectName      : string                   │
  │  totalCustomers   : number   ┐ pre-aggregated │
  │  totalEvents      : number   ┘ totals         │
  │  oldestTimestamp  : number | null            │
  │  customerProperties: string[]                │
  └───┬─────────────────┬──────────────────┬─────┘
      │ 1..*            │ 1..*             │ 0..1
      ▼                 ▼                  ▼
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │ Event        │  │ Catalog      │  │ DataHorizon  │
  │  name        │  │  id?         │  │  from        │
  │  properties[]│  │  name        │  │  to          │
  │  eventCount  │  └──────────────┘  │  durationDays│
  └──────────────┘                    └──────────────┘
   embedded array     embedded array    embedded object
   (NOT a join)       (NOT a join)      (optional)
```

In a relational world this would be five tables (`projects`, `events`, `catalogs`, `customer_properties`, joined on `projectId`). Here it's one object with embedded arrays — the document-shaped, denormalized form. That's the *right* call for AptKit: the descriptor is read whole, summarized into a prompt by `schemaSummary()`, and never partially updated. There's nothing to normalize because there are no independent writes to any sub-part. See `01-type-as-schema.md` for the full walk.

## The event-log schema

The second model is the trace: `CapabilityEvent` in `packages/runtime/src/events.ts`, a six-variant discriminated union (`step` / `tool_call_start` / `tool_call_end` / `model_usage` / `warning` / `error`). This is an append-only event log — the same shape a database audit table or an event-sourcing stream would have, expressed as a TypeScript tagged union and persisted as NDJSON / a JSON array. See `02-tagged-union-event-log.md`.

## The versioned artifact

The third model is the replay artifact (`artifacts/replays/*.json`). Every artifact carries `schemaVersion: 1`. That single integer is the *entire* migration story of the repo — the one place AptKit acknowledges that a persisted shape can change and old files might need handling. See `03-versioned-artifact-schema.md`.

## The corpus (the one store-shaped model)

The fourth model is the vector corpus in `packages/retrieval`. This one is different from the other three: it's not a type that serializes to a file, it's a *store* — rows you `upsert` and `search`. A `VectorChunk` is `(id, vector: number[], meta)`; a search returns `VectorHit` rows `(id, score, meta)`. Three modeling choices carry it:

- **Deterministic composite id** — `"<docId>#<index>"` (`pipeline.ts:44`), so re-indexing a document overwrites its chunks instead of duplicating them.
- **Soft docId linkage** — `meta.docId` is a foreign key's *shape* with none of its enforcement; there's no `documents` table at all, just chunks carrying a label.
- **Dimension-as-invariant** — the embedding dimension (768, nomic) is a one-way door, checked at write time with a throw.

This is the closest thing in the repo to a database table, and the shape is deliberately the pgvector row shape so the in-memory store ports to Postgres unchanged. Full walk in `06-vector-store-row-model.md`. (A *persistent* documents/chunks corpus with real FKs lives in a separate repo, buffr — not AptKit. AptKit models only the in-memory shape.)

## How to use this guide

Read `audit.md` next. It's blunt: five of the seven classic data-modeling lenses come back `not yet exercised` because there's no database to exercise them on. The value is in the *mapping* — each relational concept (migration, integrity constraint, normalization, index) gets matched to its nearest AptKit analog, so when you do reach for Postgres you'll know exactly which in-repo idea graduates into which database feature.
