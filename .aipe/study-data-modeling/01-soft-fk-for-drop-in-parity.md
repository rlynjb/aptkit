# 01 — The soft foreign key for drop-in parity

**Industry name(s):** soft foreign key / application-enforced reference
(a.k.a. logical FK, denormalized parent reference). **Type:** Industry standard.

The headline data-modeling decision in the whole stack: a foreign key that
exists logically but was **deliberately dropped** at the database level, so
the persistent schema matches an interface that never promised the parent
row exists.

## Zoom out, then zoom in

Here's where this lives. The `VectorStore` contract is defined in aptkit; the
schema that has to satisfy it lives in buffr. The dropped FK is the joint
between them.

```
  Zoom out — where the soft FK lives

  ┌─ aptkit: the contract layer ────────────────────────────────┐
  │  VectorStore.upsert(chunks: VectorChunk[])                   │
  │    — takes chunks. NO document argument. NO parent promise.  │
  │      (packages/retrieval/src/contracts.ts:33-37)            │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ PgVectorStore implements it
  ┌─ buffr: the schema layer ──────▼────────────────────────────┐
  │  agents.chunks                                              │
  │    document_id text        ← ★ SOFT FK ★  (no constraint)   │
  │    embedding   vector(768)                                  │
  │  alter table ... drop constraint if exists                  │
  │     chunks_document_id_fkey   (sql/001_agents_schema.sql:27)│ ← we are here
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: a normalized schema would put `document_id text references
agents.documents(id)` on the `chunks` table — a hard foreign key, so the
database refuses to insert a chunk whose document doesn't exist. This schema
declares the column but **drops the constraint**. The question this answers:
*how do you persist chunks behind an interface whose `upsert` signature never
mentions a parent document?* You make the link a soft one — enforced by
convention, not by the database.

## Structure pass

Layers, one axis, the seam where it flips.

```
  One axis — "who guarantees the chunk→document link?" — traced across layers

  ┌─ contract (aptkit) ───────────────┐
  │  upsert(chunks)                   │   → NOBODY. The contract has no
  │  no document param                │      concept of a documents row.
  └───────────────────────────────────┘
              │  the seam ═══════════════════  ◄── the axis flips here
              ▼
  ┌─ schema (buffr) ──────────────────┐
  │  chunks.document_id  (soft)       │   → APP CODE, by convention only.
  │  documents.id        (PK)         │      A hard FK here would BREAK the
  └───────────────────────────────────┘      contract above.
```

- **Layers:** the contract (aptkit `VectorStore`) sits above the schema
  (buffr `agents.chunks`).
- **Axis = referential integrity ("who guarantees the link?").** At the
  contract layer, nobody — `upsert` doesn't know documents exist. At the
  schema layer, if you added a hard FK, *the database* would guarantee it.
- **The seam = the `VectorStore` boundary.** The axis flips here: above it
  the link is unknowable, below it the link could be enforced. A hard FK
  would push a guarantee *up* through a seam that can't carry it — the
  contract would start failing on valid `upsert` calls. So the FK is dropped
  and the link stays soft. That contradiction is the whole pattern.

## How it works

#### Move 1 — the mental model

You already know this shape from frontend code. A `<Comment>` component
takes a `comment` prop and renders it; it does **not** take the parent
`post` and verify the comment belongs to it — that's the parent's job, or
nobody's. The `VectorStore.upsert` is exactly that `<Comment>`: it takes
chunks and stores them. It never receives a document to check against. So
when you back it with SQL, you cannot make the database demand a parent —
the data simply doesn't arrive with one.

```
  The pattern — a link the writer never sees

  documents row (maybe)        chunks rows (always arrive alone)
  ┌──────────────┐             ┌──────────────────────────────┐
  │ id = "doc-7" │   logical   │ id="doc-7#0"  document_id=    │
  │              │ ◄┄┄┄┄┄┄┄┄┄┄ │   "doc-7"   (just a string)   │
  └──────────────┘  no FK,     │ id="doc-7#1"  document_id=    │
       ▲             no check  │   "doc-7"                     │
       │                       └──────────────────────────────┘
       └── may not exist at upsert time — the writer can't know
```

The strategy: store the parent id as a **plain string with no constraint**,
and let any join be a best-effort lookup. The link is real data; it's just
not a database-enforced promise.

#### Move 2 — the step-by-step walkthrough

**Step 1 — the contract that forces it.** `VectorStore.upsert` takes only
chunks. This is the load-bearing fact; everything else follows.

```ts
// packages/retrieval/src/contracts.ts:33-37
export type VectorStore = {
  dimension: number;
  upsert(chunks: VectorChunk[]): Promise<void>;   // ← chunks only.
  search(vector: number[], k: number): Promise<VectorHit[]>;  // no documents.
};
```

There is no `upsertDocument`, no `documentId` parameter on `upsert`. A
chunk's only knowledge of its document is whatever is in its own `meta`
(`meta.docId`). The contract is document-agnostic by construction.

**Step 2 — the schema declares the column but drops the constraint.** buffr
has to satisfy that contract over Postgres. It keeps `document_id` as data
but removes the FK.

```sql
-- buffr/sql/001_agents_schema.sql:14-27
create table if not exists agents.chunks (
  id text primary key,
  -- Soft link to documents.id (no FK): the VectorStore contract upserts chunks
  -- with no notion of a documents row, so a hard FK would break drop-in parity.
  document_id text,                      -- ← plain text, no `references`
  ...
  embedding vector(768) not null,
  ...
);
-- Drop the FK on databases migrated before this change (idempotent).
alter table agents.chunks drop constraint if exists chunks_document_id_fkey;
```

The comment *is* the design rationale, left in the schema on purpose. The
`drop constraint if exists` is the migration step for any database that was
created back when the FK existed — idempotent, so re-running the script is
safe.

**Step 3 — the write path proves the parent is optional.**
`PgVectorStore.upsert` pulls `document_id` out of the chunk's `meta` bag,
defaulting to `null` when absent.

```ts
// buffr/src/pg-vector-store.ts:43-56
for (const c of chunks) {
  const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;  // ← may be null
  ...
  await client.query(
    `insert into agents.chunks (id, document_id, app_id, ...) values ($1,$2,$3,...)
     on conflict (id) do update set document_id = excluded.document_id, ...`,
    [c.id, docId, this.appId, ...],
  );
}
```

A chunk can be written with `document_id = null` and the insert succeeds. If
there *were* a hard FK, a null would be allowed but a *non-existent* docId
would throw — and that's precisely the case that breaks: memory rows
(`03-kind-tag-shared-collection.md`) are chunks with no document at all.
This is why `session.ts:50-52` notes "memory chunks live with no documents
row, which the dropped FK allows."

```
  Layers-and-hops — a memory write would violate a hard FK

  ┌─ aptkit memory ─┐  upsert chunk: id="memory:c1:0", meta.docId=undefined
  │ remember(turn)  │ ─────────────────────────────────────────────►┐
  └─────────────────┘                                                │
                          ┌─ buffr PgVectorStore ─────────────────┐  │
                          │ docId = null  (no meta.docId)         │◄─┘
                          └───────────────┬───────────────────────┘
                                          │ insert document_id = null
                          ┌─ Postgres ────▼───────────────────────┐
                          │ WITH hard FK: ok (null allowed)        │
                          │ but a doc chunk with a stale docId →   │
                          │ FK VIOLATION, upsert throws.           │
                          │ WITHOUT FK (this schema): always ok.   │
                          └────────────────────────────────────────┘
```

#### Move 2 variant — the load-bearing skeleton

The kernel of "soft FK": **a reference column with no constraint + the
guarantee relocated to a layer above the database.**

- **Drop the reference column** and you lose the ability to join chunks back
  to documents at all — citations couldn't name a source document.
- **Drop the no-constraint property** (i.e. add the hard FK back) and you
  break the contract: any `upsert` of an orphan chunk (every memory row)
  now throws. The system loses drop-in parity.
- **Relocate the guarantee upward, or nowhere.** Here it's *nowhere
  enforced* — the app trusts that `meta.docId` is either a real document or
  deliberately absent. That's the accepted cost.

Optional hardening (not present): a periodic integrity sweep that flags
chunks whose `document_id` points at a missing `documents.id`; a
`deferrable initially deferred` FK that only checks at commit. Neither
exists — `not yet exercised`.

#### Move 3 — the principle

A foreign key is a *promise the database makes on behalf of the layer
above*. If the layer above (the contract) can't make that promise — because
its interface doesn't carry the parent — then a hard FK is lying about a
guarantee the system can't keep. Drop the constraint, keep the column, and
move the (weaker) guarantee to where the knowledge actually lives. The cost
is honest: you trade DB-enforced integrity for interface parity, and you say
so in a comment.

## Primary diagram

The full picture: contract, schema, and the two write paths that prove the
parent is optional.

```
  The soft FK, end to end

  ┌─ aptkit contract ──────────────────────────────────────────────┐
  │  VectorStore.upsert(chunks)        — no document param          │
  └──────────────┬───────────────────────────────┬─────────────────┘
                 │ doc chunk (meta.docId="doc-7") │ memory chunk (no docId)
                 ▼                                ▼
  ┌─ buffr PgVectorStore.upsert ───────────────────────────────────┐
  │  docId = meta.docId ?? null     →   insert into agents.chunks   │
  └──────────────┬─────────────────────────────────────────────────┘
                 ▼
  ┌─ Postgres agents schema ───────────────────────────────────────┐
  │  documents(id PK) ◄┄┄┄ soft link ┄┄┄ chunks(document_id, NO FK) │
  │  chunks(id PK, embedding vector(768), app_id, meta jsonb)       │
  │  ── a chunk with document_id pointing nowhere is still valid ── │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

Soft foreign keys are common wherever a write path can't see the parent:
event-sourced systems (events reference an aggregate id with no FK),
sharded databases (the parent may live on another shard, so a cross-shard
FK is impossible), and exactly this case — a storage adapter behind a
narrow interface. The trade is always the same: you give up
`ON DELETE CASCADE`-style automatic integrity and take on the job of not
writing orphans, or tolerating them.

Here the tolerance is deliberate and even *useful*: orphan chunks (memory
rows with no document) are a feature, not a bug. The dropped FK is what lets
`@aptkit/memory` reuse the same `chunks` table — see
`03-kind-tag-shared-collection.md`. Read next: `02-metadata-as-a-json-bag.md`
(where `meta.docId` actually comes from), and study-software-design
(normalization as information-hiding — the FK is a coupling decision).

## Interview defense

**Q: Why did you drop the foreign key on `chunks.document_id`? Isn't that
just sloppy?**

> Verdict first: it's a deliberate soft FK to preserve drop-in parity with
> the `VectorStore` contract. That contract's `upsert(chunks)` takes chunks
> and nothing else — it has no notion of a documents row. A hard FK would
> mean the database rejects any chunk without a valid parent, but my memory
> engine writes chunks that *intentionally* have no document
> (`meta.kind='memory'`). A hard FK would break those writes. So I keep
> `document_id` as a plain column for joins and citations, drop the
> constraint, and accept that nothing stops a stale link. The cost is
> documented in the schema comment.

```
  contract.upsert(chunks)  ──►  no parent promised
        │ hard FK would force one
        ▼
  memory chunk (no doc) ──► FK VIOLATION ──► drop-in parity broken
```

Anchor: *the FK is a promise the database makes for the layer above; if the
contract can't make that promise, the FK is lying.*

**Q: What would change your mind — when would you add it back?**

> If documents and chunks were always written together through a path that
> guarantees the parent first, and memory moved to its own table. Then a
> `deferrable initially deferred` FK would catch real orphans at commit
> without breaking batched writes. Right now neither precondition holds, so
> the soft link is correct.

Anchor: *a soft FK is right exactly when the writer can't see the parent;
fix the writer's visibility before you re-add the constraint.*

## See also

- `00-overview.md` — the soft link drawn in the full model.
- `02-metadata-as-a-json-bag.md` — where `meta.docId` is set on the write
  path and rebuilt on read.
- `03-kind-tag-shared-collection.md` — the orphan memory chunks the dropped
  FK enables.
- `audit.md` lenses 2, 4, 5 — normalization, integrity, the migration step.
- **study-software-design** — normalization as information-hiding; coupling.
