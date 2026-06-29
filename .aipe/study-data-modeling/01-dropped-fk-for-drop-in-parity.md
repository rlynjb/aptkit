# 01 — The FK that was deliberately removed

**Industry name(s):** denormalization for interface parity / soft
reference (a "logical foreign key" with no DB-enforced constraint).
**Type:** Project-specific decision over a standard relational pattern.

## Zoom out, then zoom in

Here's the whole storage layer, with the one relationship that *looks*
like it should be a foreign key marked. Watch the dashed line.

```
  Zoom out — where the soft link lives (buffr Storage layer)

  ┌─ aptkit (contract) ─────────────────────────────────────┐
  │  VectorStore.upsert(chunks)  — knows NOTHING about docs  │
  └───────────────────────────┬──────────────────────────────┘
                              │  PgVectorStore implements it
  ┌─ buffr Postgres (agents schema) ─▼──────────────────────┐
  │  agents.documents.id  ◄┄┄┄┄┄┄┄┄ chunks.document_id      │
  │                         ★ NO foreign key ★               │
  │  (a real FK exists elsewhere:                            │
  │   messages.conversation_id → conversations.id CASCADE)   │
  └──────────────────────────────────────────────────────────┘
```

Zoom in. In a textbook schema, `chunks.document_id` *is* a foreign key to
`documents.id` — that's the obvious relational model: a document has many
chunks. This repo had that FK, and then **deliberately dropped it**. The
question this file answers: why retract a constraint that models the data
correctly? Because the table isn't really "chunks of a document." It's an
*implementation of the `VectorStore` contract*, and that contract's
`upsert(chunks)` has no concept of a documents row.

## The structure pass

One axis exposes the whole decision: **trust — what does each writer
promise about the data?**

```
  axis = "what does the writer guarantee about document_id?"

  ┌─ writer A: indexDocumentRow ─┐  seam  ┌─ writer B: raw VectorStore ─┐
  │ writes documents row FIRST,  │ ══╪══► │ upsert(chunks) — no doc row │
  │ then chunks. document_id     │ flips  │ document_id may dangle or   │
  │ always points at a real row  │        │ be absent entirely          │
  └──────────────────────────────┘        └─────────────────────────────┘
        ▲                                          ▲
        └──── same column, two contracts ──────────┘
              a FK would let A but FORBID B
```

- **Layers:** the aptkit `VectorStore` contract (top) and buffr's
  Postgres tables (bottom).
- **The axis (trust):** does the writer guarantee `document_id` resolves
  to a real `documents` row? `indexDocumentRow` does. The bare
  `VectorStore.upsert` does not — it can't, the contract has no documents.
- **The seam that flips it:** the moment you commit to "this table must be
  a valid `VectorStore`," a hard FK becomes a *liability*, because it would
  reject any legitimate `upsert` that doesn't first create a document row.
  The FK serves writer A and breaks writer B. The contract wins.

## How it works

#### Move 1 — the mental model

You already know this shape from frontend work: a TypeScript `interface`
the caller relies on no matter who implements it. `VectorStore` is that
interface. The whole point of aptkit is that buffr's `PgVectorStore` is
*one* implementation and `InMemoryVectorStore` is another, and code above
them can't tell which it's holding. A hard FK is a promise the *Postgres
implementation* would make that the *in-memory implementation* and the
*contract itself* never made. Drop-in parity means the durable store can't
be pickier than the contract.

```
  the pattern — a soft link is a FK the contract can't honor

  CONTRACT says:        upsert(chunks: {id, vector, meta}[])
                              │  no document_id required,
                              │  no documents table implied
                              ▼
  HARD FK would add:    chunks.document_id MUST match documents.id
                              │  ← a promise the contract never made
                              ▼
  SOFT LINK keeps:      chunks.document_id is just text;
                        app code (writer A) maintains the relationship
                        when it cares; the DB enforces nothing
```

#### Move 2 — the walkthrough

**The DDL: a column, an idempotent drop, two indexes.** Read the chunks
table and the comment that carries the entire decision —
`/Users/rein/Public/buffr/sql/001_agents_schema.sql:14-30`:

```sql
create table if not exists agents.chunks (
  id text primary key,
  -- Soft link to documents.id (no FK): the VectorStore contract upserts
  -- chunks with no notion of a documents row, so a hard FK would break
  -- drop-in parity.
  document_id text,                      -- ← plain text, nullable, no references
  app_id text not null default 'laptop',
  chunk_index int not null,
  content text not null,
  embedding vector(768) not null,
  embedding_model text not null default 'nomic-embed-text:v1.5',
  meta jsonb not null default '{}'
);
-- Drop the FK on databases migrated before this change (idempotent).
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
```

Line by line: `document_id text` (not `text references agents.documents`)
is the whole pattern — it carries the relationship's *value* without the
DB's *enforcement*. The `alter table … drop constraint if exists` is the
migration half: on a fresh DB it's a no-op (the constraint was never
created); on a DB migrated *before* this change it actually retracts the
old FK. `if exists` is what makes the one statement safe to run in both
worlds — the idempotency that lets the whole file re-run.

**Who maintains the relationship, then?** Writer A — the document index
path — writes the parent row first, then the chunks
(`/Users/rein/Public/buffr/src/runtime.ts:11-17`):

```ts
await pool.query(
  `insert into agents.documents (id, app_id, source_type, source_path, content)
   values ($1, $2, 'markdown', $3, $4)
   on conflict (id) do update set content = excluded.content, ...`,
  [doc.id, appId, doc.sourcePath ?? null, doc.text],
);
await pipeline.index({ id: doc.id, text: doc.text });   // ← chunks get document_id
```

So when buffr indexes a *document*, the link is honest. The
`pipeline.index` call (aptkit) sets `meta.docId = doc.id`
(`packages/retrieval/src/pipeline.ts:41-45`), and `PgVectorStore.upsert`
copies that into the typed `document_id` column
(`/Users/rein/Public/buffr/src/pg-vector-store.ts:44`). The relationship is
maintained in app code, exactly where the contract left room for it.

**Where the dangling link is a feature, not a bug.** Memory rows
(`05-kind-tag-logical-partition.md`) are `upsert`ed straight through the
`VectorStore` contract with no documents row — id `memory:<convId>:<n>`,
`meta` with no `docId`. With a hard FK, `PgVectorStore.upsert` would set
`document_id = null` (`pg-vector-store.ts:44`, `docId` absent → `null`),
which is fine for a nullable FK — but the moment *anything* set a
non-resolving `document_id`, a hard FK would reject the insert. The soft
link means the store accepts whatever the contract hands it. **That's the
load-bearing part: the store never rejects a valid `VectorStore` write.**

#### Move 3 — the principle

A foreign key is a promise *the database* makes on behalf of *every*
writer. If one legitimate writer can't keep that promise, the constraint
stops modeling the data and starts fighting it. When a table is the
concrete side of an abstract contract, the table can be no stricter than
the contract — denormalize (drop the FK, keep the value) and move the
relationship into the app code that actually has the context to maintain
it. The cost is real (the DB won't catch an orphaned chunk); it was paid
deliberately to keep `PgVectorStore` a true drop-in.

## Primary diagram

```
  the whole decision, one frame

  ┌─ CONTRACT (aptkit) ─────────────────────────────────────────────┐
  │  VectorStore.upsert(chunks)   — no documents notion              │
  └───────────────────────────┬──────────────────────────────────────┘
                              │ implemented by
  ┌─ STORAGE (buffr Postgres) ▼──────────────────────────────────────┐
  │                                                                   │
  │  agents.documents              agents.chunks                      │
  │  ┌──────────────┐              ┌──────────────────────────┐       │
  │  │ id (PK)      │◄┄┄ soft ┄┄┄┄ │ document_id  text (nullbl)│       │
  │  │ content      │   link,      │ id (PK), embedding, meta… │       │
  │  └──────────────┘   no FK      └──────────────────────────┘       │
  │        ▲                              ▲                            │
  │   writer A (indexDocumentRow):   writer B (raw upsert / memory):   │
  │   doc row THEN chunks            chunks only, document_id may be    │
  │   → link resolves                null/dangling → still accepted     │
  │                                                                   │
  │  shipped via: alter … drop constraint if exists  (idempotent)     │
  └───────────────────────────────────────────────────────────────────┘
```

## Elaborate

The "logical foreign key" (a reference value with no DB constraint) is a
known pattern in systems that span service or contract boundaries —
microservices avoid cross-service FKs for the same reason: the constraint
would couple two things that must evolve independently. Here the two
"services" are the same process, but the boundary is the
contract/implementation seam. The honest cost: nothing stops a delete of a
`documents` row from orphaning its chunks (no `on delete cascade`, because
there's no FK to hang it on). buffr doesn't currently delete documents, so
the cost is unpaid — but it's the first thing to revisit if it ever does.
Contrast with `messages.conversation_id`, which *is* a real FK with
`on delete cascade` (schema line 42): that relationship lives entirely
inside buffr's own tables, never crosses the aptkit contract, so the FK
costs nothing and the cascade is pure win.

## Interview defense

**Q: Your chunks table has a `document_id` that points at `documents.id`
but no foreign key. Isn't that a bug?**

It's deliberate, and it's the most important call in the schema. The
chunks table isn't modeling "chunks of a document" — it's the durable
*implementation of a `VectorStore` contract*, and that contract's
`upsert(chunks)` has no notion of a documents row. A hard FK would reject
any legitimate write that doesn't first create a parent document — like
conversation-memory rows, which go straight through `upsert`. So I dropped
the FK to a soft link: the column carries the value, app code maintains
the relationship when it has the context to.

```
  contract upsert(chunks)  ──►  table must accept any valid write
  hard FK  ──►  rejects writes with no parent doc  ──►  breaks parity
  soft link ──►  accepts everything, app maintains the link
```

Anchor: *the table can be no stricter than the contract it implements.*

**Q: How did you ship the removal safely?**

`alter table … drop constraint if exists chunks_document_id_fkey` — `if
exists` makes it a no-op on fresh databases and a real retraction on ones
migrated before the change, so the whole migration file stays
re-runnable. Retracting a constraint is non-destructive to data; the only
thing lost is enforcement, which app code now owns.

Anchor: *idempotent `drop … if exists` lets one migration file serve both
fresh and already-migrated databases.*

## See also

- `02-metadata-as-json-bag.md` — the same contract pressure that dropped
  the FK also produced the meta-rebuild-on-read.
- `05-kind-tag-logical-partition.md` — the memory rows that exercise the
  dangling-`document_id` path.
- `audit.md` §2 (normalization), §5 (migrations).
- `study-system-design` — the aptkit↔buffr contract seam as architecture.
