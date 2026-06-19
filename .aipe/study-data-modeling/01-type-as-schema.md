# type-as-schema

**Industry name(s):** schema-as-types / compile-time schema / denormalized read-model. **Type label:** Language-agnostic pattern (the read-model idea), with a TypeScript-specific enforcement mechanism.

## Zoom out, then zoom in

You're used to a DB table being the source of truth for a shape — columns, types, a primary key. AptKit has no table. The source of truth for "what is a workspace" is a TypeScript type, and the compiler is the thing that rejects a malformed one.

```
  Zoom out — where the type schema sits

  ┌─ Host app (not AptKit) ─────────────────────────────┐
  │  builds a WorkspaceDescriptor from its own data     │
  └───────────────────────────┬─────────────────────────┘
                              │  passes the object in
  ┌─ TYPE layer (packages/context) ────────────────────▼┐
  │  ★ WorkspaceDescriptor ★   ← the schema lives here   │ ← we are here
  │  schemaSummary(workspace)  ← renders it into a prompt│
  └───────────────────────────┬─────────────────────────┘
                              │  string
  ┌─ Provider layer (packages/runtime) ────────────────▼┐
  │  ModelRequest { system, messages, tools }            │
  │  ModelResponse { content, usage, model }   ← wire    │
  └───────────────────────────────────────────────────────┘
```

Zoom in: the pattern is a **denormalized read-model expressed as a type**. One object holds everything a consumer needs, no joins, and the type *is* the schema. The question it answers: how do you model a domain entity with real structure (a project that has events, catalogs, customer properties, totals) when you have no database to declare tables in?

## Structure pass

**Layers.** Two: the *entity types* (`WorkspaceDescriptor` and its embedded `WorkspaceEventDescriptor`, `WorkspaceCatalogDescriptor`, `DataHorizon`) and the *wire types* (`ModelRequest`/`ModelResponse`/`ModelMessage`/`ModelContentBlock`). The first models AptKit's domain; the second models what crosses the provider boundary.

**Axis — trace "who enforces this shape?" across the layers:**

```
  axis: "what enforces this shape?"

  ┌─ in-memory object ─┐  seam   ┌─ JSON on disk / wire ─┐
  │  TypeScript        │ ══╪════► │  no enforcement       │
  │  compiler enforces │ (flips)  │  (JSON accepts all)   │
  └────────────────────┘         └───────────────────────┘
         ▲                                ▲
         └──── same value, two answers ───┘
```

**Seam.** The load-bearing boundary is `JSON.stringify` / `JSON.parse`. On the in-memory side, the compiler guarantees the shape — you cannot construct a `WorkspaceDescriptor` missing `projectId`. The instant it serializes to disk or crosses the wire as JSON, that guarantee is gone. Everything downstream (`packages/evals`, see `05-structural-diff-integrity.md`) exists to re-establish at read time what the compiler gave you at write time.

## How it works

### Move 1 — the mental model

Think of the relational read-model you'd build for a dashboard: rather than join five tables on every page load, you precompute one wide row (or a materialized view) that has everything the page needs. `WorkspaceDescriptor` is that, as a type.

```
  The pattern — one denormalized read-model, no joins

         ┌──────────────────────────────────┐
         │  WorkspaceDescriptor              │
         │   projectId  (identity)           │
         │   totals     (pre-aggregated)     │
         │   events[]      ┐                 │
         │   catalogs[]    ├ embedded, not   │
         │   dataHorizon   ┘ foreign-keyed   │
         └──────────────────────────────────┘
            read whole · summarized · never partially updated
```

The defining property: nothing reads *part* of it. There is no "give me just the events for project X" query. It's always consumed whole — which is exactly why embedding beats normalizing here.

### Move 2 — the walkthrough

**The identity field.** `projectId: string` is the primary key analog — it identifies the workspace. Bridge from what you know: it's the `key` prop on a React list item, the thing that says "this row is this entity." Nothing enforces uniqueness (no DB), but it's the field that names the entity. What breaks without it: artifacts and fixtures couldn't be tied back to a workspace.

**The embedded collections.** `events: WorkspaceEventDescriptor[]`, `catalogs: WorkspaceCatalogDescriptor[]`. In a relational schema these are child tables with a `project_id` foreign key. Here they're arrays *inside* the parent object.

```
  Relational (normalized)          AptKit (denormalized / embedded)
  ───────────────────────          ────────────────────────────────
  projects ──┐                     WorkspaceDescriptor {
             │ FK                    events: [ {...}, {...} ],
  events ────┘                       catalogs: [ {...} ]
  catalogs ──┘ FK                  }
  (join to assemble)               (already assembled — read whole)
```

The denormalization is correct because the access pattern is "read whole." You never update one event in isolation, so there's no write that could leave the embedded copy inconsistent. The cost a normalized schema pays (joins on every read) buys nothing here; the cost denormalization pays (update anomalies) never materializes because there are no partial updates.

**The pre-aggregated totals.** `totalCustomers: number`, `totalEvents: number`. These are *derived* facts — in principle `totalEvents` is the sum of every event's `eventCount`. Storing them is denormalization of an aggregate, the same move as a cached count column on a table. What breaks if they drift: a prompt would describe the workspace inaccurately. Nothing recomputes or reconciles them — the host app is trusted to set them correctly. This is the one place the model trusts its input rather than deriving from it.

**The optional horizon.** `dataHorizon?: DataHorizon` is the only optional top-level field — a 0..1 relationship. Its presence changes how `schemaSummary` renders (it appends a "ALL queries MUST land inside this window" rule). Optionality in the type *is* the cardinality declaration: `?` means "this relationship may not exist," the same as a nullable FK.

**The wire types as a separate schema.** `ModelRequest` and `ModelResponse` (`model-provider.ts:39-52`) are a second, smaller schema — the contract for what crosses the provider boundary. `ModelContentBlock` is itself a discriminated union (`text` | `tool_use`). This is a schema *for messages in flight*, not for stored entities, which is why it's modeled separately from the workspace.

### Move 3 — the principle

Without a database, a type is the most honest place to put a schema: it's checked on every build, it's the single definition every consumer imports, and the shape is visible in one file. The catch — and the whole reason `packages/evals` exists — is that a type only protects values the compiler can see. The moment data is JSON on disk, the type is just documentation. **A type-as-schema is a write-time guarantee; it needs a read-time partner to survive serialization.**

## Primary diagram

The full entity model, with cardinalities and the enforcement seam marked.

```
  WorkspaceDescriptor — entity model + enforcement boundary

  COMPILE-TIME (TypeScript enforces) │ RUNTIME (JSON, no enforcement)
  ───────────────────────────────────┼──────────────────────────────
  ┌─────────────────────────────────┐│
  │ WorkspaceDescriptor             ││  JSON.stringify
  │  projectId : string  ← identity ││ ─────────────────►  *.json
  │  projectName : string           ││   (compiler can no
  │  totalCustomers : number ┐ aggr ││    longer help here)
  │  totalEvents : number    ┘      ││
  │  oldestTimestamp : number|null  ││  re-validated by
  │  customerProperties : string[]  ││  packages/evals at
  │  events : Event[]        1..*   ││  read time
  │  catalogs : Catalog[]    1..*   ││  (see 05-...)
  │  dataHorizon? : DataHorizon 0..1││
  └─────────────────────────────────┘│
```

## Implementation in codebase

**Use cases in AptKit.** A `WorkspaceDescriptor` is built by the host app (or by a fixture), handed to an agent, and rendered into the system prompt by `schemaSummary()`. Every agent — query, recommendation, monitoring, diagnostic — takes a workspace and summarizes it so the model knows what data exists. It's the single input shape that describes "the customer's analytics workspace."

**The schema, line by line** — `packages/context/src/workspace-descriptor.ts:1-28`:

```
  WorkspaceEventDescriptor (lines 1-5)
    name: string;            ← the event's identity within the project
    properties: string[];    ← embedded, not a child "event_properties" table
    eventCount: number;      ← per-event aggregate

  WorkspaceDescriptor (lines 18-28)
    projectId: string;             ← PK analog
    events: WorkspaceEventDescriptor[];   ← 1..* embedded (no FK, no join)
    customerProperties: string[];  ← flat string list, not a table
    catalogs: WorkspaceCatalogDescriptor[];  ← 1..* embedded
    totalCustomers: number;        ← pre-aggregated (denormalized count)
    totalEvents: number;           ← pre-aggregated
    oldestTimestamp: number | null;← nullable — explicit "may be unknown"
    dataHorizon?: DataHorizon;     ← optional ⇒ 0..1 cardinality
         │
         └─ the `?` is the cardinality declaration; remove it and
            every consumer must now handle a horizon that's always
            present, which the data can't guarantee
```

**The read path** — `packages/context/src/workspace-summary.ts:11-52`. `schemaSummary` consumes the *whole* descriptor and flattens it to a string for the prompt:

```
  workspace-summary.ts (lines 26-32) — events rendered, not queried
    workspace.events
      .slice(0, maxEvents)          ← cap, since this goes into a prompt
      .map((event) => `  - ${event.name} (${event.eventCount}): ${props}`)
         │
         └─ proof the access pattern is "read whole": it iterates the
            embedded array directly. No join, no lookup, no query — the
            data is already assembled, which is the whole point of the
            denormalized shape
```

**A real instance** — `packages/agents/query/fixtures/revenue-by-state-query.json:6-21`. The `workspace` block is a literal `WorkspaceDescriptor`: four embedded events, two customer properties, empty catalogs, `totalEvents: 285000`, a `dataHorizon`. This is the type, serialized — and now it's just JSON the compiler can't check, which is why the eval layer re-asserts it.

## Elaborate

The denormalized read-model is an old idea from data warehousing (the "wide table" / star-schema fact row) and from document databases (MongoDB's "embed what you read together"). The rule of thumb is the same everywhere: **embed when you read together and update as a unit; normalize when sub-parts are written independently.** AptKit's workspace is read together and never sub-updated, so embedding is unambiguously right.

Where this connects: the *cost* of denormalization (a fact stored twice can drift) shows up for real in `02-tagged-union-event-log.md`, where the recommendation text is duplicated between the structured array and the trace string. The *principle* behind "don't store a fact twice" is information-hiding for data — taught in `study-software-design`. Read next: `05-structural-diff-integrity.md`, which is how AptKit re-checks this shape after it loses the compiler.

## Interview defense

**Q: AptKit has no database. So how is the data modeled?**
"Type-shaped. The schema is `WorkspaceDescriptor` in `packages/context` — a TypeScript type, enforced by the compiler at build time. It's a denormalized read-model: one object with embedded `events[]`, `catalogs[]`, and pre-aggregated totals, no joins. The compiler is the write-time enforcer; `packages/evals` re-checks the shape at read time once it's JSON on disk."

```
  WorkspaceDescriptor
    projectId ─┐
    events[]   ├ all embedded, read whole, never sub-updated
    catalogs[] ┘
  → denormalized because access pattern is "read whole"
```

Anchor: *the type is the schema; the compiler is the constraint engine.*

**Q: Why embed events instead of normalizing them into a separate table?**
"Because the access pattern is read-whole. `schemaSummary` consumes the entire descriptor to build a prompt — `workspace-summary.ts:26`. Nothing ever reads one event in isolation, and nothing updates one event independently. Normalization buys consistency under independent writes; there are no independent writes here, so it would only cost me joins for nothing. Embed when you read together — and I do."

Anchor: *normalize for independent writes; embed for whole reads — and AptKit only ever does whole reads.*

**Q: The most load-bearing part people forget?**
"The serialization seam. The type protects me only while the value is in memory. The day it's `JSON.parse`d from a file, `tsc` is out of the picture and the object could be any shape. That's not a footnote — it's the reason `packages/evals` exists. A type-as-schema with no runtime validation partner is a guarantee that evaporates at the disk boundary."

## Validate

1. **Reconstruct.** From memory, write the `WorkspaceDescriptor` type with correct cardinalities (which field is `?`, which is `| null`, which are arrays). Check against `packages/context/src/workspace-descriptor.ts:18-28`.
2. **Explain.** Why is `dataHorizon` optional but `oldestTimestamp` is `number | null`? (Hint: optional = the field may be absent; nullable = the field is always present but its value may be unknown. Trace how `schemaSummary` treats each at `workspace-summary.ts:22-24` vs `:58`.)
3. **Apply.** A host app needs to add "the workspace's currency." Where does it go, and what's the cardinality? (One value per workspace ⇒ a top-level field, not an embedded array; required or optional decides the `?`.)
4. **Defend.** Someone proposes normalizing `events` into its own type keyed by `projectId` "for cleanliness." Argue against it using the access pattern — cite `workspace-summary.ts:26-32` as evidence the data is only ever read whole.

## See also

- `00-overview.md` — the entity diagram and the three-layer model.
- `02-tagged-union-event-log.md` — the *other* schema (the event log), and where denormalization actually bites.
- `05-structural-diff-integrity.md` — the read-time partner that re-checks this shape after serialization.
- `audit.md` — Lens 1 (shape), Lens 2 (normalization), Lens 6 (access patterns).
- `study-software-design` → information-hiding — the normalization principle this applies.
