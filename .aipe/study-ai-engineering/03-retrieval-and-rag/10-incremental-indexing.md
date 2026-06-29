# Incremental indexing — upsert-by-id

**Subtitle:** Incremental indexing · re-index one doc without rebuilding the corpus · *Industry standard*

## Zoom out, then zoom in

Incremental indexing is the difference between "edit one note and re-process
everything" and "edit one note, touch only its chunks." It lives at the store's
write path, and aptkit gets it almost for free: indexing is per-document and upsert
is keyed by chunk id, so re-indexing one doc leaves the rest of the corpus
untouched.

```
  Zoom out — the write path is per-document

  ┌─ indexDocument(doc) (pipeline.ts:32) ───────────────────────┐
  │  chunk ─► embed ─► ★ store.upsert(chunks) ★                  │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
               upsert by id    │
  ┌─ VectorStore ──────────────▼────────────────────────────────┐
  │  doc#0, doc#1 overwrite in place; other docs UNTOUCHED       │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You know the difference between `INSERT … ON CONFLICT DO UPDATE`
(upsert) and `TRUNCATE; INSERT` (full rebuild). The first changes one row's worth of
data; the second throws away everything and rewrites it. aptkit's index path is the
upsert kind, at *document* granularity: `indexDocument` re-chunks and re-upserts one
doc, and because chunk ids are stable, the new chunks land exactly on the old ones.
That's incremental indexing — no special machinery, just stable ids plus upsert.

## Structure pass

**Layers.** Granularity (per-document — `indexDocument`) → key (stable chunk id
`${docId}#${i}`) → mechanism (upsert: `Map.set` / `on conflict do update`).

**Axis — cost.** Trace the cost of editing one doc out of N. Full rebuild: re-embed
and re-upsert all N docs — O(corpus). Incremental: re-embed and re-upsert one doc's
chunks — O(one doc), the other N-1 docs never move. The axis "how much work per
edit?" flips from corpus-sized to doc-sized, and aptkit sits on the cheap side by
construction.

**Seam.** The chunk id `${docId}#${i}` (`pipeline.ts:42`) plus the by-id upsert
(`in-memory-vector-store.ts:21`, `pg-vector-store.ts:50`). The id is the join between
"a new index run" and "the existing chunk it replaces." That deterministic id is the
entire mechanism — lose it and incremental indexing breaks into duplicate or orphan
chunks.

## How it works

### Move 1 — the mental model

You know `Map.set(key, value)`: same key overwrites, new key inserts, and every
*other* entry is untouched. SQL's `INSERT … ON CONFLICT (id) DO UPDATE` is the same
contract for a table. Incremental indexing is just choosing a *stable* key so that
re-processing the same source maps onto the same entries. The corpus is a `Map<id,
chunk>`; re-indexing a doc is a handful of `set` calls on that doc's keys.

```
  Upsert by stable id — same key overwrites, rest untouched

  corpus: { "noteA#0": v, "noteA#1": v, "noteB#0": v }
  re-index noteA ─► set "noteA#0", set "noteA#1"   (noteB#0 never touched)
   stable id = same key each run = clean overwrite, not duplicate
```

### Move 2 — the mechanism, and the one gap

**Per-document granularity.** The unit of indexing is one document
(`pipeline.ts:32`): `indexDocument(doc, wiring)` chunks *that* doc, embeds *its*
chunks, and upserts *them*. There is no "re-index the corpus" call — re-indexing is
always one doc at a time, so it's incremental at doc granularity by default.

```
  indexDocument — the per-doc write unit (pipeline.ts:32)

  doc {id, text} ─► chunkText ─► embed(batch) ─► store.upsert(chunks)
   scope = ONE doc's chunks; the rest of the corpus is out of scope
```

**Stable ids make upsert land on the old chunks.** Each chunk's id is
`${doc.id}#${i}` (`pipeline.ts:42`), deterministic from the doc id and chunk index.
Re-index the same doc and chunk 0 gets id `doc#0` again — mapping onto the existing
`doc#0`. In-memory overwrites via `Map.set` (`in-memory-vector-store.ts:21`); buffr
overwrites via `on conflict (id) do update` (`/Users/rein/Public/buffr/src/pg-vector-store.ts:50`):

```ts
// in-memory (in-memory-vector-store.ts:18)
async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);     // same id ─► in-place overwrite
  }
}
```

```sql
-- buffr (pg-vector-store.ts:48) — same semantics in SQL
insert into agents.chunks (id, …, embedding, …)
values ($1, …, $6::vector, …)
on conflict (id) do update set
  embedding = excluded.embedding, content = excluded.content, …
```

That `on conflict (id) do update` *is* incremental indexing in one statement: only
the named doc's rows are written; the HNSW index updates just those vectors; every
other row is undisturbed.

```
  Re-index one doc — only its chunks move

  edit noteA ─► indexDocument(noteA)
       │ upsert noteA#0..2
       ▼
  agents.chunks:  noteA#0 ✎  noteA#1 ✎  noteA#2 ✎   noteB#* untouched   noteC#* untouched
```

**The one gap: orphan chunks when a doc shrinks.** The id is `docId#i` by chunk
*index*. If a doc had 5 chunks (`doc#0..4`) and an edit shrinks it to 3
(`doc#0..2`), re-indexing upserts `doc#0..2` but never touches `doc#3` and `doc#4` —
they linger as orphans, still matchable, still pointing at deleted text. Deleting
the now-absent high-index chunks is `not yet exercised`.

```
  Orphan chunks on shrink (not yet exercised)

  before: doc#0 doc#1 doc#2 doc#3 doc#4
  edit shrinks doc to 3 chunks ─► re-index upserts doc#0 doc#1 doc#2
  after:  doc#0 doc#1 doc#2 [doc#3 doc#4]  ← ORPHANS: stale, never overwritten
   fix: delete chunks where docId = $d and chunkIndex >= newCount  (not built)
```

### Move 2.5 — current state vs future state

```
  Phase A (aptkit, now)             Phase B (full incremental — not yet exercised)
  ┌────────────────────────┐        ┌──────────────────────────────────┐
  │ per-doc upsert by id    │        │ upsert + delete orphan chunks      │
  │ growing/same-size docs ✓│  add   │ where docId=$d and chunkIndex>=N   │
  │ shrinking docs ─► orphans│ delete │ shrink leaves no stale chunks      │
  │ no full rebuild needed   │ step   │ true per-doc consistency           │
  └────────────────────────┘        └──────────────────────────────────┘
   incremental WRITE exists; incremental DELETE (on shrink) does not
```

### Move 3 — the principle

Choose a deterministic key derived from the source, and incremental indexing falls
out of plain upsert — no separate rebuild path, no diffing engine. The cost of an
edit drops from corpus-sized to doc-sized for free. The catch is the *delete* side:
a key by position (`#index`) only overwrites positions that still exist, so shrinking
a source orphans its tail. Pair the upsert with a "delete chunks beyond the new
count" step and the per-document write becomes a true per-document *replace*.

## Primary diagram

```
  Incremental indexing in aptkit terms

  edit one doc
     │ indexDocument(doc) — per-doc scope (pipeline.ts:32)
     ▼
  re-chunk ─► re-embed ─► upsert chunks  id = `${docId}#${i}` (pipeline.ts:42)
     │
     ├─ in-memory: Map.set by id (in-memory-vector-store.ts:21)
     └─ pg: on conflict (id) do update (pg-vector-store.ts:50)
     ▼
  doc#0..k overwritten   |   all OTHER docs untouched   |   O(one doc), not O(corpus)
     └─ shrink case: doc#k+1.. become ORPHANS (delete step not yet exercised)
```

## Elaborate

The elegance is that aptkit never *built* incremental indexing — it got it as a side
effect of two ordinary choices: index per document, and key chunks by a stable
`docId#index`. That's the lesson — incremental behavior is usually a consequence of
good keys, not a dedicated subsystem. The honest gap is symmetry: upsert handles
"chunk still exists" perfectly and "chunk no longer exists" not at all, so a
shrinking doc leaks orphans that behave exactly like stale embeddings
(`09-stale-embeddings.md`) — confident matches on deleted text. Closing it is a
small delete-by-prefix. Read `09-stale-embeddings.md` for why orphans are dangerous
and `04-vector-databases.md` for the upsert implementations on both stores.

## Project exercises

### Delete orphan chunks when a re-indexed document shrinks
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** after upserting a doc's chunks, delete any existing chunks for
  that `docId` whose `chunkIndex >= newChunkCount` — in-memory by scanning the Map,
  in pg by a `delete … where document_id = $d and chunk_index >= $n`.
- **Why it earns its place:** turns per-doc upsert into per-doc *replace* and kills
  the orphan-chunk staleness leak; it proves you saw the asymmetry between insert and
  delete in an upsert-only design.
- **Files to touch:** `packages/retrieval/src/pipeline.ts` (pass the new count),
  `packages/retrieval/src/in-memory-vector-store.ts` (add a prune),
  `/Users/rein/Public/buffr/src/pg-vector-store.ts` (delete-by-prefix), a new test in
  `packages/retrieval/test/`.
- **Done when:** a test indexes a 5-chunk doc, re-indexes a 3-chunk version, and
  asserts chunks `doc#3`/`doc#4` are gone.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "How do you re-index without rebuilding the whole corpus?"**
Per-document upsert keyed by a stable chunk id. `indexDocument` (`pipeline.ts:32`)
scopes work to one doc; each chunk's id is `${docId}#${i}` (`pipeline.ts:42`), so
re-indexing maps new chunks onto their old ids and overwrites in place — `Map.set`
in-memory (`in-memory-vector-store.ts:21`), `on conflict (id) do update` in pg
(`pg-vector-store.ts:50`). Editing one doc is O(one doc); every other doc is
untouched. No rebuild path exists because none is needed.

```
  stable id + upsert ─► re-index one doc ─► its chunks overwrite, corpus untouched
```
Anchor: *incremental indexing is a stable key plus upsert — not a separate subsystem.*

**Q: "What breaks when an indexed document gets shorter?"**
Orphan chunks. Ids are by chunk index, so a doc that shrinks from 5 chunks to 3
re-upserts `doc#0..2` but leaves `doc#3` and `doc#4` behind — stale chunks pointing
at deleted text that still match queries. Upsert handles "still exists" but not "no
longer exists." The fix is a delete step: remove chunks for the doc with
`chunkIndex >= newCount`. It's `not yet exercised`.

```
  shrink 5→3 ─► upsert doc#0..2 ─► doc#3,doc#4 orphaned (stale, still matchable)
```
Anchor: *upsert-by-index replaces what exists; shrinking a doc needs an explicit delete.*

## See also

- `09-stale-embeddings.md` — orphans are a staleness leak; the freshness primitive
- `04-vector-databases.md` — the upsert implementations on both stores
- `11-rag.md` — `indexDocument` and the `${docId}#${i}` id scheme
- `03-chunking-strategies.md` — why chunk count changes when a doc is edited
- `04-agents-and-tool-use/05-agent-memory.md` — memory reuses the same upsert path
