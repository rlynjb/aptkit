# 02 · Records, Pages, and Storage Layout

**Industry name(s):** row/heap storage, tuple layout, page locality. **Type:** Industry standard.

## Zoom out, then zoom in

You know a DB table as rows and columns — a primary key, some fields, maybe a JSON blob. That mental model is exactly right; this file zooms into what one of those rows *physically is* once it hits disk, and why the shape of a row decides what a query costs.

```
  Zoom out — where a record lives in the stack

  ┌─ Pipeline (aptkit) ────────────────────────────────────┐
  │  indexDocument: chunk text → embed → build VectorChunk  │
  └────────────────────────────┬────────────────────────────┘
                               │  upsert(chunks)
  ┌─ Store layer ──────────────▼────────────────────────────┐
  │  InMemoryVectorStore: VectorChunk as a JS object in a Map│
  │  PgVectorStore:        ★ a ROW in agents.chunks ★        │ ← we are here
  └────────────────────────────┬────────────────────────────┘
                               │
  ┌─ Disk (Supabase Postgres) ─▼────────────────────────────┐
  │  heap pages (8 KB) · the vector(768) column · TOAST      │
  └──────────────────────────────────────────────────────────┘
```

Zoom in: the concept is **the record** — the unit a store writes and reads — and its **locality**, meaning what data sits next to what on disk. In aptkit a record is a `VectorChunk` object; in buffr it's a tuple in a heap page. The interesting tension: a 768-float embedding is a *big* field, and where Postgres puts it changes the cost of a scan.

## The structure pass

**Layers.** A record exists at three altitudes: the logical record (the `VectorChunk` type both stores agree on), the in-memory representation (a JS object), and the on-disk tuple (Postgres heap page). Same record, three physical forms.

**Axis — trace "how much does it cost to read one record fully?" across the two stores:**

```
  One question across the two stores: "cost to read one full record?"

  ┌─ InMemoryVectorStore ───────────────┐
  │  VectorChunk is one JS object        │ → pointer deref, O(1), but ALL in RAM
  └──────────────────────────────────────┘
  ┌─ PgVectorStore / Postgres ──────────┐
  │  tuple in a heap page (~8 KB)        │ → fetch page from disk/cache;
  │  768-float embedding ≈ 3 KB inline   │   big embedding bloats the page
  └──────────────────────────────────────┘

  the cost flips at the disk boundary — RAM has no page cost; Postgres pays per page
```

**Seam.** The boundary is the `upsert` call: above it, the pipeline hands over a uniform `VectorChunk`; below it, each store decides physical layout independently. The `meta` field is the seam's pressure point — it's `Record<string, unknown>` in memory and `jsonb` on disk, and the embedding is a typed array in memory and a `vector(768)` column on disk.

## How it works

### Move 1 — the mental model

Think of a record like a single rendered list item with a fixed set of fields — except some fields are tiny (an id string) and one field is huge (768 floats ≈ 3 KB). The shape of the record is fixed by the pipeline; the *storage* decision is where that huge field goes.

```
  The record shape — fixed by the pipeline, stored two ways

   VectorChunk (logical)          agents.chunks row (physical)
   ┌──────────────────┐           ┌────────────────────────────┐
   │ id      "doc#3"   │           │ id text PK    "doc#3"      │
   │ vector  [768 nums]│  ───────► │ embedding vector(768) ~3KB │ ◄ the heavy field
   │ meta    {docId..} │           │ meta jsonb    {...}        │
   └──────────────────┘           │ + document_id, app_id,     │
                                   │   chunk_index, content,    │
                                   │   embedding_model          │
                                   └────────────────────────────┘
```

The kernel: **the id is the locality key.** It's `<docId>#<chunkIndex>` in both stores — that's what makes upsert idempotent and what determines which records cluster together.

### Move 2 — the walkthrough

**The id format is the locality decision.** The pipeline builds chunk ids as `<docId>#<index>`:

```ts
// packages/retrieval/src/pipeline.ts (indexDocument)
const chunks = texts.map((text, i) => ({
  id: `${doc.id}#${i}`,                          // "guide.md#0", "guide.md#1", ...
  vector: vectors[i]!,
  meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },  // text carried IN the row
}));
```

Two things matter. First, `id` is a text primary key — in Postgres that's a b-tree on a string, so upsert-by-id is a b-tree lookup (see 03). Second, **the chunk text is duplicated into `meta.text`** so a search hit can cite the passage without a second lookup. That's a deliberate denormalization: the record carries its own citation payload, trading storage for one fewer read.

**In memory: the record is just the object.** No serialization, no page:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:19-22
for (const chunk of chunks) {
  this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
  this.chunks.set(chunk.id, chunk);              // the VectorChunk object IS the stored record
}
```

The 768-float vector lives as a JS `number[]` — 768 × 8 bytes ≈ 6 KB per record in V8's heap, all resident. There is no page, no eviction, no cold read. The cost model is "is the process alive and does it have RAM." That's why this store is fine for tests and a few hundred docs and falls over for a real corpus — it's all in memory, always.

**On disk: the tuple, the page, and the heavy embedding.** buffr maps the same record onto a row, splitting `meta` into typed columns plus the jsonb:

```ts
// buffr/src/pg-vector-store.ts:43-56
const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;
const chunkIndex = typeof c.meta.chunkIndex === 'number' ? c.meta.chunkIndex : 0;
const content = typeof c.meta.text === 'string' ? c.meta.text : '';
await client.query(
  `insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
   values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
   on conflict (id) do update set ...`,         // upsert = insert-or-overwrite by PK
  [c.id, docId, this.appId, chunkIndex, content, toVectorLiteral(c.vector), this.embeddingModel, c.meta],
);
```

Watch the layout decision. The in-memory `meta` blob is *destructured* into real columns — `document_id`, `chunk_index`, `content` — and the leftover `meta` goes into `jsonb`. The vector is serialized to pgvector's text literal `[0.1,0.2,...]` (`toVectorLiteral`, `buffr/src/pg-vector-store.ts:15-17`) then cast `::vector`.

Now the physical reality: Postgres stores tuples in **8 KB heap pages**. A `vector(768)` is roughly 768 × 4 bytes + header ≈ 3.1 KB. So each `agents.chunks` row carries a ~3 KB embedding plus the `content` text plus jsonb. Two consequences:

- **Wide rows mean fewer tuples per page.** A page that would hold dozens of skinny rows holds only a couple of chunk rows once the embedding is inline. A sequential scan reads more pages for the same row count.
- **TOAST is in play.** Postgres moves oversized field values to a side table (TOAST) when a row exceeds ~2 KB. Whether the `vector(768)` and `content` get TOASTed depends on size; an HNSW index scan reads the embedding repeatedly, so TOAST de-toasting cost is real. This is **`not yet exercised`** — no one has run `EXPLAIN (ANALYZE, BUFFERS)` to see page/TOAST behavior. The mechanism is there; the measurement isn't.

**Layers-and-hops — building a row from a chunk in buffr:**

```
  Layers-and-hops — one VectorChunk becoming one heap tuple

  ┌─ pipeline (aptkit) ─┐ hop 1: VectorChunk {id,vector,meta}  ┌─ PgVectorStore ─┐
  │ indexDocument       │ ───────────────────────────────────►│ destructure meta │
  └─────────────────────┘                                     └────────┬─────────┘
                                       hop 2: INSERT ... $6::vector     │
                                                                        ▼
                                                          ┌─ Postgres heap ──────┐
                                                          │ tuple in 8KB page    │
                                                          │ embedding ~3KB inline│
                                                          │ overflow → TOAST     │
                                                          └──────────────────────┘
```

### Move 3 — the principle

Where the heaviest field of a record physically lives decides the cost of every scan over it. The pipeline made one record shape; the in-memory store pays for it in RAM, Postgres pays for it in page count and TOAST. The general lesson: a record isn't free-form — its width and its big columns are a storage-cost decision, and you can't reason about query speed without knowing the page layout.

## Primary diagram

```
  Full storage layout — one chunk, two physical forms

  VectorChunk (pipeline, logical)
        id = "guide.md#3"  ·  vector[768]  ·  meta{docId,chunkIndex,text}
                 │                                   │
       ┌─────────┘ upsert                            └────────┐
       ▼ (aptkit)                                             ▼ (buffr)
  ┌─ InMemoryVectorStore ──────┐         ┌─ Postgres: agents.chunks ──────────────┐
  │ Map["guide.md#3"] = object │         │ heap page (8 KB)                        │
  │ vector: number[768] in RAM │         │  ┌ tuple ─────────────────────────────┐│
  │ ~6 KB V8 heap, resident    │         │  │ id PK · document_id · app_id        ││
  │ NO page, NO disk           │         │  │ chunk_index · content               ││
  └────────────────────────────┘         │  │ embedding vector(768) ~3 KB  ──► TOAST?
                                          │  │ embedding_model · meta jsonb        ││
                                          │  └─────────────────────────────────────┘│
                                          └─────────────────────────────────────────┘
```

## Elaborate

Heap storage and 8 KB pages are Postgres fundamentals; the pgvector twist is that an embedding is an unusually wide fixed-size field, so vector tables are "fat-row" tables by nature. The denormalization of `content`/`meta.text` into the row is a RAG idiom — you want the passage text co-located with its vector so a hit can be cited in one read (`toResult` in `search-knowledge-base-tool.ts:108-118` reads `meta.text` directly). buffr's record also adds an `embedding_model` column (`'nomic-embed-text:v1.5'`), recording *which* embedder produced the vector — schema-level provenance so a future re-embed can be detected. Read next: 03 for the index over this `embedding` column, 04 for the scan that reads these pages.

## Interview defense

**Q: A `vector(768)` row is fat. Why does that matter for reads?**

```
  skinny rows                    fat rows (embedding inline)
  ┌──────────────┐               ┌──────────────┐
  │ r r r r r r  │ many/page     │ R    R       │ few/page → more pages/scan
  └──────────────┘               └──────────────┘   + TOAST de-toast cost
```

Answer: "Each chunk row carries a ~3 KB embedding inline, so far fewer tuples fit in an 8 KB page. A sequential or index scan touches more pages for the same number of rows, and the embedding may spill to TOAST, adding a de-toast read. We haven't measured it — no `EXPLAIN (ANALYZE, BUFFERS)` exists — but the page-width cost is structural to vector tables." Anchor: *fat rows, fewer per page, that's the whole cost.*

**Q: Why is the chunk text stored twice — once as `content`, once in `meta.text`?**

Answer: "Denormalization for citations. The search tool needs the passage text to build a citation in the same read as the score (`search-knowledge-base-tool.ts:111-115`). Storing it on the chunk row avoids a join back to `documents`. We trade storage for one fewer read on the hot retrieval path." Anchor: *co-locate the citation payload with the vector.*

## See also

- `01-database-systems-map.md` — the contract that fixes the record shape.
- `03-btree-hash-and-secondary-indexes.md` — the index over the `embedding` column.
- `04-query-planning-and-execution.md` — the scan that reads these pages.
- study-data-modeling — normalization and the `meta` jsonb as a modeling choice.
