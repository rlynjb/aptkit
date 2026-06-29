# 02 — Metadata as a JSON bag, rebuilt on the way out

**Industry name(s):** hybrid relational/document model · schemaless
metadata column · "rebuild the wire shape on read." **Type:** Industry
standard (jsonb sidecar) applied to honor a typed contract.

## Zoom out, then zoom in

Every chunk's facts live in *two* places at once. Here's where, in the
storage layer.

```
  Zoom out — one chunk row, two homes for the same facts

  ┌─ buffr Postgres: agents.chunks (one row) ───────────────────────┐
  │                                                                 │
  │  TYPED COLUMNS              │   JSONB BAG                        │
  │  ┌──────────────────────┐  │   ┌────────────────────────────┐  │
  │  │ document_id  text    │  │   │ meta: {                    │  │
  │  │ chunk_index  int     │  │   │   docId, chunkIndex, text, │  │
  │  │ content      text    │  │   │   ...anything else         │  │
  │  │ embedding  vector    │  │   │ }                          │  │
  │  └──────────────────────┘  │   └────────────────────────────┘  │
  │   indexed, queryable       │    flexible, never indexed         │
  └─────────────────────────────────────────────────────────────────┘
            ▲ written from meta on upsert   ▲ stored verbatim
            └──── search() rebuilds meta FROM the typed columns ──────┘
```

Zoom in. The aptkit contract types `meta` as `Record<string, unknown>`
(`packages/retrieval/src/contracts.ts:10`) — an open bag. But three keys
inside that bag are load-bearing for citations: `docId`, `chunkIndex`,
`text`. buffr promotes those three to real typed columns *and* keeps the
whole bag in a jsonb column. On the way out, `search()` doesn't read the
stored bag — it *rebuilds* the bag from the typed columns. The question:
why store the same fact twice and then reconstruct it?

## The structure pass

Axis: **where does each fact get read from?** Hold that constant across
the write and the read.

```
  axis = "on read, where does meta.text come from?"

  ┌─ WRITE path (upsert) ─┐   seam    ┌─ READ path (search) ─────────┐
  │ meta.text ──► content │ ══╪═════► │ content ──► rebuilt meta.text │
  │ (typed column)        │  flips    │ (the stored meta is IGNORED)  │
  └───────────────────────┘           └──────────────────────────────┘
       facts flow OUT of the bag           facts flow back INTO a bag
       into typed columns                   built from the columns
```

- **Layers:** the contract's `meta` bag (top) vs the typed Postgres
  columns (bottom).
- **The axis (source of a fact on read):** on write, the three citation
  keys are *extracted* from `meta` into typed columns. On read, the bag
  the caller receives is *rebuilt* from those columns — not the stored
  jsonb.
- **The seam:** the typed columns are the durable source of truth for
  citation facts; the jsonb bag is a flexible passenger for everything
  else. The boundary is which fields the citation tool needs to query vs
  which it just needs to carry.

## How it works

#### Move 1 — the mental model

You know the loading/success/error shape of a `fetch()` — the same data
described two ways depending on who's consuming it. Same idea: the
*database* wants typed, indexable columns (so `where`/`order by` work);
the *aptkit contract* wants a generic `meta` object (so it stays
vendor-neutral). The hybrid model serves both by storing the
citation-critical fields as columns and round-tripping them back into the
bag shape the contract expects.

```
  the pattern — promote the hot keys, bag the rest, rebuild on read

   contract meta {docId, chunkIndex, text, ...}
            │  upsert: extract 3 hot keys → typed columns
            │          store the FULL bag in jsonb too
            ▼
   row: document_id | chunk_index | content | meta(jsonb)
            │  search: SELECT the typed columns
            │          rebuild meta = {...jsonb, docId, chunkIndex, text}
            ▼
   caller gets back the SAME meta shape it would from InMemoryVectorStore
```

#### Move 2 — the walkthrough

**Write: extract the hot keys into columns.** `PgVectorStore.upsert` pulls
`docId`, `chunkIndex`, `text` out of the incoming `meta` and binds them to
typed columns — *and* passes the whole `meta` object as the jsonb param —
`/Users/rein/Public/buffr/src/pg-vector-store.ts:43-56`:

```ts
const docId = typeof c.meta.docId === 'string' ? c.meta.docId : null;
const chunkIndex = typeof c.meta.chunkIndex === 'number' ? c.meta.chunkIndex : 0;
const content = typeof c.meta.text === 'string' ? c.meta.text : '';
await client.query(
  `insert into agents.chunks (id, document_id, app_id, chunk_index, content,
     embedding, embedding_model, meta)
   values ($1, $2, $3, $4, $5, $6::vector, $7, $8) ...`,
  [c.id, docId, this.appId, chunkIndex, content,
   toVectorLiteral(c.vector), this.embeddingModel, c.meta],   // ← $8 = full bag
);
```

Line by line: `c.meta.docId` → `document_id` (the soft link from `01`);
`c.meta.text` → `content` (the column the HNSW-ranked row returns);
`c.meta.chunkIndex` → `chunk_index`. The defensive `typeof` checks are
because the contract types `meta` as `unknown`-valued — the store can't
assume the keys are present or correctly typed, so it coerces and falls
back (`null`, `0`, `''`). Then `$8 = c.meta` stores the *entire* bag
unchanged, so any extra key a caller stashed survives the round trip.

**Read: rebuild the bag from the columns.** `search()` selects the typed
columns and reconstructs the `meta` shape the in-memory store would have
returned — `/Users/rein/Public/buffr/src/pg-vector-store.ts:70-84`:

```ts
const { rows } = await this.pool.query(
  `select id, content, chunk_index, document_id, meta,
          1 - (embedding <=> $1::vector) as score
   from agents.chunks where app_id = $2
   order by embedding <=> $1::vector limit $3`, ...);
return rows.map((r) => ({
  id: r.id,
  score: Number(r.score),
  // rebuild so the search_knowledge_base tool's citations work unchanged:
  meta: { ...(r.meta ?? {}), docId: r.document_id, chunkIndex: r.chunk_index, text: r.content },
}));
```

The load-bearing line is the last one. It spreads the stored jsonb bag
*first* (`...r.meta`), then **overwrites** `docId`/`chunkIndex`/`text` with
the typed-column values. The typed columns win on conflict — they're the
source of truth for those three keys. Why rebuild instead of just
returning `r.meta`? Because the citation tool downstream
(`packages/retrieval/src/search-knowledge-base-tool.ts:108-117`) reads
`hit.meta.docId` and `hit.meta.text` to build the `[docId] snippet`
citation. If those came only from the stored bag, a chunk written before a
field existed, or via a path that didn't populate `meta.text`, would lose
its citation. Rebuilding from the column guarantees the field is there
whenever the column is. **That's what breaks if you skip the rebuild:
citations silently go blank for some rows.**

**Why both, not one?** Drop the typed columns → you can't `order by` on
the vector or filter by `app_id` efficiently, and citations depend on
parsing jsonb at query time. Drop the jsonb bag → the contract's open
`Record` is lossy; any caller key that isn't one of the three promoted
fields vanishes. Keeping both is the deliberate denormalization: a fact
stored twice, with the typed copy authoritative on read.

#### Move 3 — the principle

A jsonb (or document) column is the right tool for the *open* part of a
schema — fields you can't enumerate at design time because they belong to
a contract that's intentionally generic. Promote to typed columns exactly
the fields you must index, filter, or order by; bag the rest. The discipline
that keeps it honest is *deciding which copy is authoritative* and reading
from that one consistently — here, the typed columns win, and `search`
rebuilds the bag from them so the contract's consumers never know the
storage split happened.

## Primary diagram

```
  hybrid model — the full round trip

  ── aptkit contract ──────────────────────────────────────────────
  meta: Record<string, unknown> = { docId, chunkIndex, text, +anything }
           │ upsert                                    ▲ search returns
           ▼                                           │ rebuilt meta
  ── buffr Postgres: agents.chunks ────────────────────┴────────────
  ┌────────────────────────────────────────────────────────────────┐
  │ document_id  ◄─ meta.docId      chunk_index ◄─ meta.chunkIndex   │
  │ content      ◄─ meta.text       meta(jsonb) ◄─ FULL meta verbatim│
  │ embedding    ◄─ vector          app_id (tenant)                  │
  └────────────────────────────────────────────────────────────────┘
       authoritative on read ──────►  meta = {...jsonb,
       (typed columns win)                    docId:document_id,
                                              chunkIndex:chunk_index,
                                              text:content}
```

## Elaborate

This is the standard "relational core + jsonb sidecar" Postgres pattern,
with one twist worth naming: most hybrid schemas read the jsonb back
*as-is*. This one rebuilds it from columns, because the columns — not the
bag — are the durable truth for citation. The cost of the duplication is
write-time coupling (every new promoted field needs both a column and the
extraction line in `upsert`) and the risk of the two copies drifting if a
future writer updates the column without updating the bag. buffr avoids
the drift by never editing a chunk in place — chunks are written once by
the index path and only ever replaced wholesale via `on conflict … do
update set` with all columns from `excluded`
(`pg-vector-store.ts:50-54`). What to read next: `01` (the same contract
pressure that dropped the FK), and `study-database-systems` for how
Postgres stores and (doesn't) index a jsonb column.

## Interview defense

**Q: Why store `text` in both a `content` column and inside `meta`? Isn't
that the textbook duplication red flag?**

It's deliberate, contract-driven duplication, and the two copies aren't
co-equal. The typed `content` column is authoritative — it's what the
HNSW-ranked query returns and what citations are built from. The `meta`
jsonb exists because the aptkit `VectorStore` contract types metadata as
an open `Record`, so the store has to round-trip arbitrary caller keys.
On read, `search` rebuilds the `meta` bag *from* the typed columns, so the
column always wins and citations never go blank.

```
  write:  meta.text  ──►  content column  (+ full bag in jsonb)
  read:   content column  ──►  rebuilt meta.text   (jsonb spread under it)
          typed column wins on conflict → single source of truth
```

Anchor: *promote the keys you query to columns, bag the rest, and pick
which copy is authoritative on read.*

**Q: What stops the two copies from drifting?**

Chunks are never updated in place — the index path replaces the whole row
via `on conflict do update set` taking every column from `excluded`. There's
no code path that edits `content` without rewriting `meta`, so they can't
diverge.

Anchor: *write-once / replace-wholesale is what keeps a denormalized copy
honest.*

## See also

- `01-dropped-fk-for-drop-in-parity.md` — same contract pressure.
- `06-trace-as-append-only-log.md` — `messages` also uses jsonb sidecars
  (`tool_calls`, `tool_results`) for open-shaped payloads.
- `audit.md` §2 (normalization/duplication).
