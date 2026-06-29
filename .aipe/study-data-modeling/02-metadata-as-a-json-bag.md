# 02 — Metadata as a JSON bag, rebuilt on read

**Industry name(s):** schemaless metadata column / JSON document column
(a.k.a. the "bag of attributes" / hybrid relational-document model).
**Type:** Industry standard.

The in-memory shape carries an open `meta: Record<string, unknown>`. The SQL
schema honors that by storing `meta jsonb` — but *promotes* the hot fields
(`docId`, `chunkIndex`, `text`) into real columns, then **rebuilds the
in-memory bag on read** so the citation contract never notices the
difference.

## Zoom out, then zoom in

The `meta` bag travels from the contract down into Postgres and back up,
changing shape at the storage boundary and being reassembled on the way out.

```
  Zoom out — where the meta bag lives

  ┌─ aptkit contract ──────────────────────────────────────────┐
  │  VectorChunk.meta : Record<string, unknown>   ← open bag    │
  │  VectorHit.meta   : Record<string, unknown>                 │
  │    consumers read meta.docId / meta.text for citations      │
  │    (contracts.ts:8-19, search-knowledge-base-tool.ts:108)  │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ store boundary
  ┌─ buffr storage ────────────────▼────────────────────────────┐
  │  agents.chunks                                              │
  │    document_id, chunk_index, content   ← promoted columns   │ ← we are here
  │    meta jsonb                          ← the leftover bag    │
  │  search() REBUILDS meta = {docId, chunkIndex, text, ...}    │
  │    (pg-vector-store.ts:79-84)                              │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the in-memory model can't know what keys a caller will stash in
`meta` — it's `Record<string, unknown>`, deliberately open. A pure
relational schema would demand a fixed column per key, which the open type
forbids. So buffr does the hybrid move: the *known, indexed, queried* fields
become columns; everything else lives in a `jsonb` bag; and on read the
columns are folded back into the bag so the in-memory consumer sees the same
shape it wrote. The question it answers: *how do you store an open-ended
metadata object in a relational table without freezing its keys — and still
make citations work?*

## Structure pass

```
  One axis — "what shape is the metadata?" — traced across layers

  ┌─ contract (aptkit) ───────────────┐
  │  meta = open Record               │   → ONE open bag, any keys.
  └───────────────────────────────────┘
              │  the seam ═══════════════  ◄── shape flips here
              ▼
  ┌─ storage (buffr) ─────────────────┐
  │  columns + meta jsonb (split)     │   → SPLIT: hot fields are columns,
  └───────────────────────────────────┘      rest is a bag.
              │  search() reassembles
              ▼
  ┌─ read result ─────────────────────┐
  │  meta = open Record (rebuilt)     │   → ONE open bag again. Round-trip.
  └───────────────────────────────────┘
```

- **Layers:** contract → storage → read result.
- **Axis = the shape of metadata.** Open bag at the contract; split into
  columns-plus-bag in storage; reassembled into an open bag on read.
- **The seam = the `search`/`upsert` boundary in `PgVectorStore`.** The
  shape flips here on the way down (bag → columns + bag) and flips back on
  the way up (columns + bag → bag). The reassembly is what keeps the seam
  invisible to callers — the citation code never learns its data is half in
  columns.

## How it works

#### Move 1 — the mental model

You know this from any API that stores a flexible `settings` or `metadata`
JSON column next to first-class columns — a `users` table with `id`, `email`
as columns and a `preferences jsonb` for the open-ended stuff. You query and
index on `email`; you stash whatever else in `preferences`. This schema does
the same, with one twist: it copies the *important* keys out of the bag into
columns (because you can't index inside `jsonb` as cheaply), then glues them
back together on read so the consumer's mental model stays "it's all one
object."

```
  The pattern — promote hot keys, bag the rest, reassemble on read

  write:  meta {docId, chunkIndex, text, source?}     (open bag in)
              │  split
              ▼
          ┌─ columns ─────────────┐   ┌─ jsonb ──────────────┐
          │ document_id           │   │ meta = {source?, ...}│
          │ chunk_index           │   │  (whatever's left)   │
          │ content               │   └──────────────────────┘
          └───────────────────────┘
              │  read: 1 - (embedding <=> q) as score, select columns + meta
              ▼
          meta {...jsonbBag, docId, chunkIndex, text}  (open bag out)
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — the open type at the contract.** `meta` is deliberately
unconstrained.

```ts
// packages/retrieval/src/contracts.ts:8-12
export type VectorChunk = {
  id: string;
  vector: number[];
  meta: Record<string, unknown>;   // ← any keys, any values. The DB can't pin this.
};
```

The index path sets three known keys plus whatever the caller passed:

```ts
// packages/retrieval/src/pipeline.ts:41-46
const chunks = texts.map((text, i) => ({
  id: `${doc.id}#${i}`,
  vector: vectors[i]!,
  meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },  // ← merge open + known
}));
```

So `meta` always *has* `docId`/`chunkIndex`/`text`, but may also carry
arbitrary caller keys. That "always-three-plus-maybe-more" is exactly what
the storage split exploits.

**Step 2 — the write splits the bag into columns + jsonb.** `PgVectorStore`
reads the three hot keys out of `meta` and writes them as columns, then
stores the *whole* `meta` object into the `jsonb` column too.

```ts
// buffr/src/pg-vector-store.ts:44-55
const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;
const chunkIndex = typeof c.meta.chunkIndex === 'number' ? c.meta.chunkIndex : 0;
const content = typeof c.meta.text === 'string' ? c.meta.text : '';
await client.query(
  `insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
   values ($1, $2, $3, $4, $5, $6::vector, $7, $8) on conflict (id) do update set ...`,
  [c.id, docId, this.appId, chunkIndex, content, toVectorLiteral(c.vector), this.embeddingModel, c.meta],
);                                                                              // ← $8 = whole meta
```

Here's the duplication the audit names: `docId` exists *both* as the
`document_id` column *and* inside the `meta` jsonb (because `c.meta` includes
it). The same fact in two places. It's deliberate — the column is for joins
and indexing, the bag is for round-trip fidelity — but it means a future bug
could update one and not the other.

**Step 3 — the read reassembles the bag from the columns.** This is the
load-bearing move. `search` does *not* return the stored `meta` as-is; it
overlays the columns back on top so the in-memory shape is canonical.

```ts
// buffr/src/pg-vector-store.ts:79-84
// Rebuild the in-memory meta shape so the search_knowledge_base tool's citations work.
return rows.map((r) => ({
  id: r.id,
  score: Number(r.score),
  meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
}));                          // ← columns WIN over whatever was in the jsonb bag
```

The spread order matters: `...(r.meta ?? {})` first, then the column values
last — so the **columns are authoritative** on read. Even if the `jsonb`
bag's `docId` drifted from the `document_id` column, the read returns the
column. That's the schema choosing the column as the source of truth at read
time, which makes the duplication safe in practice.

```
  Layers-and-hops — the citation contract survives the split

  ┌─ agent / tool ─┐  reads hit.meta.docId, hit.meta.text for the citation
  │ toResult(hit)  │ ◄──────────────────────────────────────────────┐
  └────────────────┘  (search-knowledge-base-tool.ts:108-117)        │
                          ┌─ PgVectorStore.search ─────────────────┐ │
                          │ select content, chunk_index,           │ │
                          │   document_id, meta, 1-(emb<=>q) score │ │
                          │ → meta = {...meta, docId, chunkIndex,  │─┘
                          │            text}  (columns overlaid)   │
                          └───────────────┬────────────────────────┘
                          ┌─ Postgres ────▼────────────────────────┐
                          │ chunks: columns + meta jsonb           │
                          └────────────────────────────────────────┘
```

The tool that builds citations (`toResult`, line 108) reads
`hit.meta.docId` and `hit.meta.text` — it has no idea those came from
columns, not the bag. That's the payoff: `InMemoryVectorStore` (which stores
the bag verbatim, `in-memory-vector-store.ts:30`) and `PgVectorStore` (which
reassembles it) produce *identical* `meta` shapes, so the citation code is
written once and works against both.

#### Move 2 variant — the load-bearing skeleton

Kernel of "JSON bag with promoted columns": **an open `jsonb` column +
copies of the hot keys as real columns + a read that overlays the columns
back onto the bag.**

- **Drop the `jsonb` column** and you lose any caller-supplied key that
  isn't one of the three promoted ones — `{...(doc.meta ?? {})}` extras
  vanish.
- **Drop the promoted columns** and you can't index or join on `docId` /
  filter cheaply by them — every metadata query becomes a `jsonb`-operator
  scan.
- **Drop the read-time overlay** and the bag could return a stale `docId`,
  silently breaking a citation. The overlay is what makes the duplication
  safe.

Optional hardening (not present): a generated column or a CHECK that keeps
`meta->>'docId'` in sync with `document_id`; a GIN index on `meta` for
metadata queries. `not yet exercised`.

#### Move 3 — the principle

A relational schema and an open document shape aren't enemies — `jsonb` is
the seam where they meet. Promote the keys you query or index into columns;
leave the open tail in the bag; and on read, decide which side is
authoritative (here: columns win) and reassemble a single canonical shape.
The consumer above the storage layer should never be able to tell where the
seam was.

## Primary diagram

```
  Metadata round-trip — open bag → split storage → open bag

  WRITE                                          READ
  meta {docId,chunkIndex,text, +extras}          meta {…jsonb, docId, chunkIndex, text}
        │                                                ▲ columns overlaid (authoritative)
        ▼  split                                         │
  ┌─ agents.chunks ─────────────────────────────────────┴───┐
  │  document_id   ┐                                          │
  │  chunk_index   ├─ promoted columns (indexed, joinable)    │
  │  content       ┘                                          │
  │  meta  jsonb   ── the open tail (caller extras + copies)  │
  └──────────────────────────────────────────────────────────┘
  duplication: docId lives in BOTH document_id AND meta jsonb
  safe because: read overlays the column LAST → column wins
```

## Elaborate

The hybrid relational-document model is the default for "mostly structured,
partly open" data — Postgres `jsonb`, MySQL JSON columns, and document
stores with secondary indexes all land here. The standard guidance: promote
to a column anything you `WHERE`, `ORDER BY`, `JOIN`, or index on; bag the
rest. This schema follows it — `document_id`, `chunk_index`, `content`,
`app_id` are columns (queried/joined/indexed); arbitrary caller meta stays
in `jsonb`.

The one wrinkle worth flagging: storing `docId` in *both* places is
redundant, and a stricter design would store it only as the column and never
in the bag. The repo accepts the redundancy to keep `c.meta` (the exact
in-memory object) stored verbatim, which simplifies the in-memory adapter's
"store the bag as-is" path. Read next: `01-soft-fk-for-drop-in-parity.md`
(`document_id` is also the soft link), and study-database-systems for how
`jsonb` and GIN indexes actually work on disk.

## Interview defense

**Q: You store `docId` as a column *and* inside the `meta` jsonb. Isn't
that the same fact in two places — exactly what normalization forbids?**

> Verdict: yes, it's duplicated, and it's a deliberate, bounded redundancy.
> The column exists so I can index and join on it; the jsonb copy exists
> because the in-memory `VectorChunk.meta` is an open `Record` and I store it
> verbatim for round-trip fidelity. The redundancy is made safe at read
> time: `search` overlays the columns *last* over the bag, so the column is
> authoritative — a drifted jsonb copy can never reach a caller. If I wanted
> zero redundancy I'd strip `docId` from the bag before insert, at the cost
> of a slightly more complex write path.

```
  meta {docId, …}  ──split──►  document_id COLUMN  +  meta jsonb {docId,…}
                    ──read──►  {...jsonb, docId: COLUMN}   ← column wins
```

Anchor: *promote what you query, bag the rest, and pick a winner on read.*

**Q: Why a jsonb bag at all — why not a fixed column per metadata field?**

> Because the contract's `meta` is `Record<string, unknown>` — callers can
> attach any keys. A fixed-column schema would freeze those keys and force a
> migration every time a caller adds one. `jsonb` keeps the open tail open
> while still letting me promote the three keys I actually index on.

Anchor: *the open type at the contract is what forces a jsonb tail — you
can't pin a column list the interface refuses to fix.*

## See also

- `01-soft-fk-for-drop-in-parity.md` — `document_id` is both this promoted
  column and the soft link.
- `03-kind-tag-shared-collection.md` — `meta.kind` is another bag key, used
  to partition rows.
- `audit.md` lenses 2, 3 — normalization/duplication and the index on the
  promoted columns.
- **study-database-systems** — `jsonb` storage and GIN indexes.
