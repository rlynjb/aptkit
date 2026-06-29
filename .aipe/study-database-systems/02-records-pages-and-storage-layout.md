# Records, Pages, and Storage Layout

**Industry name:** physical storage layout / heap tuples / TOAST · *Industry standard*

## Zoom out — where the bytes live

A row isn't a row to the engine — it's bytes packed into a fixed-size page
on disk. Before any index or query, that's the substrate. Here's where the
`chunks` row sits in the stack:

```
  Zoom out — from a chunk object to bytes on disk

  ┌─ Contract layer (aptkit) ─────────────────────────────────┐
  │  VectorChunk { id, vector: number[768], meta }            │
  └───────────────────────────┬───────────────────────────────┘
                              │ PgVectorStore serializes
  ┌─ Logical row (Postgres) ──▼───────────────────────────────┐
  │  ★ agents.chunks row ★                                    │ ← we are here
  │  id · document_id · app_id · chunk_index · content ·      │
  │  embedding vector(768) · embedding_model · meta jsonb     │
  └───────────────────────────┬───────────────────────────────┘
                              │ stored as a heap tuple
  ┌─ Physical layout (engine) ▼───────────────────────────────┐
  │  8KB heap page  →  tuple  →  big columns TOASTed out-of-row│
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — what this file covers

The question: **what does one `chunks` row physically cost to store, and
where does the 768-float embedding actually go?** That `vector(768)` column
is the interesting part — it's far bigger than a normal scalar, and Postgres
has a specific answer for big columns.

## Structure pass

**Layers.** The logical row (what SQL sees) sits on top of the heap tuple
(what the engine stores), which sits on the 8KB page (what the disk holds).

**Axis — trace "how big, and stored where?" across the columns.**

```
  One question across the columns: "size, and inline or out-of-row?"

  id text          → small, inline
  app_id text      → small, inline
  chunk_index int  → 4 bytes, inline
  content text     → ~512 chars, inline-ish (may TOAST if large)
  embedding        → 768 × 4 bytes ≈ 3KB ← the heavy one
    vector(768)       big enough to get TOASTed out of the main page
  meta jsonb       → small, inline

  the embedding column is where the axis-answer flips: everything
  else is inline; the vector is large enough to leave the row
```

**Seam.** The seam is the **inline / out-of-row boundary** (Postgres's TOAST
threshold, ~2KB). The `vector(768)` column at ~3KB crosses it: the row's
main heap tuple holds a pointer, the actual 3KB of floats lives in a TOAST
side-table. That's the joint where "one row" stops being one contiguous
chunk of bytes. *Inference* — buffr never inspects physical layout; this is
standard Postgres behavior for a column of this size.

## How it works

### Move 1 — the mental model

You know how a JS object with a big nested array doesn't store the array
*inside* the object header — it stores a pointer to a separately-allocated
buffer? A Postgres row with a 3KB embedding does the same thing. The row's
main tuple is small and lives on the page with its neighbors; the fat vector
gets pushed to a side-table and referenced by pointer.

```
  Heap page layout — the chunks row (inferred, standard Postgres)

  ┌─ 8KB heap page ──────────────────────────────────────┐
  │ page header                                          │
  │ ┌─ tuple (chunk A) ─────────────────────────────────┐│
  │ │ xmin/xmax (MVCC) · id · app_id · chunk_index ·    ││
  │ │ content · embedding→[TOAST ptr] · meta            ││
  │ └────────────────────────────────────────────────────┘│
  │ ┌─ tuple (chunk B) ───────────────────┐               │
  │ │ ...                  embedding→[ptr] │               │
  │ └──────────────────────────────────────┘               │
  └───────────────────────────────────────────────────────┘
              │ TOAST pointer dereferences to
              ▼
  ┌─ TOAST side-table ───────────────────────────────────┐
  │ chunk A's 768 floats (~3KB, possibly compressed)     │
  │ chunk B's 768 floats                                 │
  └───────────────────────────────────────────────────────┘
```

### Move 2 — the moving parts

**The MVCC header on every tuple.** Each heap tuple carries hidden
`xmin`/`xmax` system columns — the transaction IDs that created and deleted
it. You never see them in `001_agents_schema.sql`, but they're physically
there on every row, and they're what makes MVCC work (→ `06`). The
consequence: a "deleted" or "updated" row isn't gone — it's a dead tuple
marked by `xmax`, reclaimed later by vacuum.

**The vector column's serialization.** aptkit hands the store a
`number[768]`. buffr serializes it to pgvector's text literal `[0.1,0.2,...]`
before the `INSERT`:

```ts
// buffr/src/pg-vector-store.ts:14-17
function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;          // JS array → "[0.1,0.2,...]"
}
//  then bound as $6::vector in the INSERT (line 49) — Postgres parses
//  the literal into pgvector's packed float4[768] on-disk form (~3KB)
```

That `::vector` cast is the line where a JS array becomes a fixed-width
binary vector the HNSW index can operate on. Get the dimension wrong and the
cast still succeeds but the index is corrupt — which is exactly why both the
store and the pipeline assert the dimension *before* the write
(`pg-vector-store.ts:32-36`, `pipeline.ts` `assertWiring`). Fail loud at
wiring time, never silently store an unsearchable vector.

**Locality — what's stored next to what.** Chunks of the same document share
an `id` prefix (`<docId>#<index>`, set in aptkit's `pipeline.ts`
`indexDocument`) but Postgres stores them in **insertion order on the heap**,
not clustered by document. There's no `CLUSTER` and no clustered index. The
consequence: reading all chunks of one document is not a sequential scan of
adjacent pages — it's scattered. buffr never reads "all chunks of a
document," though; it only ever does ANN search, so this costs nothing here.
*Observed*: no `CLUSTER` statement anywhere in `sql/`.

**The `app_id` column on every row.** Every table carries
`app_id text not null default 'laptop'` (`001_agents_schema.sql:6,17`). It's
a tenant key — physically just another small inline column, logically the
partition that every `search` filters on (`where app_id = $2`,
`pg-vector-store.ts:74`). Storage cost is trivial; its query role is in `04`.

### Move 3 — the principle

The cost model of a row is "small columns inline, big columns out-of-row,
plus an invisible MVCC header on every tuple." The moment a table has a
column measured in kilobytes — an embedding, a large JSON blob, a document
body — you've left the world where "a row is one page read" and entered the
world where one logical row can mean a heap fetch *plus* a TOAST fetch. For a
vector table, that's the norm, not the exception.

## Primary diagram

```
  Storage layout recap — agents.chunks

  logical row (SQL)            physical (engine)
  ─────────────────            ─────────────────
  id           ─────────────►  ┌─ heap tuple (small, on 8KB page) ─┐
  app_id       ─────────────►  │ xmin/xmax · id · app_id ·          │
  chunk_index  ─────────────►  │ chunk_index · content · meta ·     │
  content      ─────────────►  │ embedding → [TOAST pointer] ───────┼─┐
  meta jsonb   ─────────────►  └────────────────────────────────────┘ │
  embedding                                                            │
   vector(768) ──── ~3KB, exceeds TOAST threshold ────────────────────┘
                                          ▼
                              ┌─ TOAST side-table ─┐
                              │ 768 float4 values  │
                              └────────────────────┘
```

## Elaborate

TOAST (The Oversized-Attribute Storage Technique) is Postgres's answer to a
fixed 8KB page size: a row can't exceed a page, so any oversized attribute
gets compressed and/or moved to a side-table transparently. pgvector's
`vector` type is a variable-length type that rides this machinery. You don't
configure it and buffr doesn't — it's automatic. The reason it's worth
knowing: it explains why a vector table's working set on disk is bigger than
`rows × dimension × 4 bytes` suggests, and why the HNSW index (`03`), which
holds vectors in its own structure, is what actually makes search fast rather
than the heap layout.

## Interview defense

**Q: Your chunks table has a `vector(768)` column. What happens to it physically?**
At ~3KB it exceeds Postgres's TOAST threshold, so the main heap tuple stores
a pointer and the actual floats live in a TOAST side-table. The small columns
(`id`, `app_id`, `chunk_index`) stay inline.

```
  heap tuple [small cols + ptr] ──► TOAST [768 floats]
```

**Q: Are a document's chunks stored together on disk?**
No. They share an id prefix but land on the heap in insertion order — no
`CLUSTER`, no clustered index. It doesn't cost buffr anything because it
never reads chunks by document; it only does ANN search.

**Anchor:** "Small columns inline, the 3KB embedding TOASTed out, an MVCC
header on every tuple you never wrote."

## See also

- `03-btree-hash-and-secondary-indexes.md` — the HNSW index over that embedding column.
- `06-locks-mvcc-and-concurrency-control.md` — the xmin/xmax header in action.
- study-data-modeling — the schema design behind these columns.
