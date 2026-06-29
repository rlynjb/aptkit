# Incremental indexing
> Delta upsert vs full rebuild · Industry standard

Your corpus isn't frozen — docs get added, edited, deleted. You've got two ways to keep the index current: rebuild the whole thing from scratch (simple, correct, expensive) or update only what changed (cheap, fast, needs a stable identity for "what changed"). aptkit already has the primitive for the cheap path baked into its chunk id scheme: `${doc.id}#${i}` plus an upsert means re-indexing a doc *overwrites* its chunks instead of duplicating them. So delta-updating one doc is already free. What's missing is the layer that *decides* which docs changed so you don't re-index the unchanged ones. This is partially exercised — the primitive exists, the change-detection layer doesn't.

## Zoom out, then zoom in

Incremental indexing is a property of the *write* path — it lives in how `indexDocument` and `upsert` assign identity.

```
the two write strategies over the same store
┌──────────────────────────────────────────────────────────┐
│  corpus changes (add / edit / delete docs)                  │
└───────────────┬────────────────────────────────────────────┘
        ┌────────┴────────┐
        ▼                  ▼
┌────────────────┐  ┌──────────────────────────────────┐
│ FULL REBUILD    │  │ ★ INCREMENTAL (delta upsert) ★     │
│ re-index every  │  │ re-index only changed docs;        │
│ doc             │  │ id `${doc.id}#${i}` overwrites      │
│ simple, costly  │  │ in place — primitive EXISTS ✓      │
└────────────────┘  │ change-detection layer: ✗ MISSING  │
                     └──────────────────────────────────┘
```

The store doesn't care which strategy you use — `upsert` is the same call either way. The difference is *what you feed it*: every doc (rebuild) or just the changed ones (incremental). aptkit's id scheme already makes a single-doc re-index correct and non-duplicating; the gap is the bookkeeping that knows a doc changed at all.

## Structure pass

Pick the **cost** axis: what does keeping the index fresh cost under each strategy?

```
cost of one corpus update
  FULL REBUILD                       INCREMENTAL
  ┌──────────────────────┐          ┌──────────────────────────┐
  │ embed ALL N docs       │          │ embed only CHANGED docs   │
  │ cost ∝ corpus size     │          │ cost ∝ change size        │
  │ 1 doc edit → re-embed  │          │ 1 doc edit → re-embed 1   │
  │   the whole corpus     │          │   doc's chunks            │
  └──────────────────────┘          └──────────────────────────┘
        ▲ seam: change-detection is what flips you from O(corpus) to O(delta) ▲
```

The seam is change detection. Without it, you either rebuild everything (O(corpus) per update — fine for 50 docs, painful for 50k) or you manually track what changed (error-prone). With it, an update costs only the embed of what actually changed. aptkit sits *one step* before that seam: the overwrite primitive is there, so a single-doc re-index is already a clean delta — you just have to know *which* doc to re-index.

## How it works

**Move 1 — upsert-by-stable-id is the whole trick.** Incremental indexing reduces to "assign a deterministic id, then overwrite":

```
why ${doc.id}#${i} makes delta-update free
   first index of doc "guide" (3 chunks):
      guide#0, guide#1, guide#2   ──upsert──► 3 rows
   edit doc, re-index "guide" (still 3 chunks):
      guide#0, guide#1, guide#2   ──upsert──► OVERWRITES the same 3 rows
                  ▲ same ids → same rows → no duplicates, no stale leftovers
```

```ts
// packages/retrieval/src/pipeline.ts:41-46
const chunks = texts.map((text, i) => ({
  id: `${doc.id}#${i}`,          // ← deterministic: same doc + same chunk index = same id
  vector: vectors[i]!,
  meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
}));
await wiring.store.upsert(chunks); // upsert = insert-or-overwrite by id
```

The id is `docId#chunkIndex`, not a random UUID or a content hash. That determinism is what makes re-indexing idempotent: index "guide" twice and you get three rows, not six. The store's `upsert` does the rest.

**The store's upsert semantics.** In-memory it's a `Map.set` (last write wins by key); in buffr it's `ON CONFLICT DO UPDATE`:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:18-23
async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);   // ← Map.set: same id overwrites
  }
}
```

```sql
-- buffr/src/pg-vector-store.ts:48-54  (same semantics, durable)
insert into agents.chunks (id, document_id, app_id, chunk_index, content, embedding, embedding_model, meta)
values ($1, $2, $3, $4, $5, $6::vector, $7, $8)
on conflict (id) do update set                 -- ← same id → overwrite the row
  document_id = excluded.document_id, ...,
  embedding = excluded.embedding, ..., meta = excluded.meta
```

Both stores honor the same contract: upsert by id is insert-or-overwrite. So the incremental primitive works identically whether you're on the prototype store or Postgres — that's the drop-in property (file 04) paying off again.

**The one sharp edge — shrinking docs.** Overwrite is clean only when chunk *count* stays the same or grows. If an edit makes a doc shorter (5 chunks → 3), the overwrite updates `#0..#2` but leaves `#3, #4` as orphans:

```
the orphan-chunk gotcha
   doc "guide" v1: guide#0..#4  (5 chunks stored)
   doc "guide" v2 (shorter): re-index → upsert guide#0..#2
      guide#0,1,2 → OVERWRITTEN ✓
      guide#3,4   → NOT touched → STALE ORPHANS still in the store ✗
   fix: delete all `${doc.id}#*` before re-indexing, or upsert-then-delete-extra
```

`indexDocument` upserts but never deletes, so a shrinking doc leaves orphan chunks that still match queries. Real incremental indexing needs a "delete chunks for this doc beyond the new count" step — a gap in the current primitive worth knowing.

**Move 2 — the missing change-detection layer.** `not yet exercised`. The decision layer above `indexDocument`:

```
change-detection layer (pseudocode — DOES NOT EXIST)
function reindexCorpus(docs, store):
    for doc in docs:
        h = hash(doc.text)
        if store.lastHash(doc.id) == h:    # unchanged → skip entirely (no embed)
            continue
        indexDocument(doc, wiring)          # changed → delta-update its chunks
        store.recordHash(doc.id, h)
    for docId in store.knownDocs() - {docs.id}:  # doc removed from source
        store.deleteDoc(docId)              # delete its chunks
```

This is what turns "re-index everything" into "re-index the delta." It needs a stored hash per doc (connects to file 09's content-addressing) and a delete path for removed docs.

**Move 3 — the principle.** Incremental indexing is identity discipline: give every chunk a deterministic, doc-scoped id and let upsert overwrite. aptkit already does that, so single-doc updates are free and idempotent. The full rebuild is always available as the correct, expensive fallback — and you keep it for cases where you can't trust your change detection. What completes the picture is the layer that detects changes (a per-doc hash) plus deletes for shrunk/removed docs, so the index tracks the source without ever touching what didn't change.

## Primary diagram

```
incremental vs full, over the same upsert
   source docs ──► change detection (MISSING) ──┐
                       │ changed                  │ unchanged → SKIP
                       ▼                           ▼
                  indexDocument(doc)            (no embed, no write)
                       │ chunk ids `${doc.id}#${i}`
                       ▼
                  store.upsert ── same id → OVERWRITE ──► in-place delta
                       │
                       ⚠ shrunk doc → orphan chunks #3,#4 (need delete)
   ───────────────────────────────────────────────────────────────────
   FULL REBUILD = run indexDocument over EVERY doc (correct, O(corpus))
```

The overwrite primitive exists; change detection (skip unchanged) and delete (orphans/removed docs) are the gaps that complete the incremental path.

## Elaborate

This is the same delta-vs-full tension as database materialized views (incremental refresh vs full refresh) and build systems (incremental compile vs clean build) — same tradeoff, same answer: incremental when you can trust your change detection, full rebuild as the trustworthy fallback. Adjacent: **content-addressed chunk ids** (key by hash so unchanged chunks are no-ops — file 09's `EX-RAG-09b`), **soft deletes / tombstones** (mark removed instead of deleting, for audit), and **CDC** (change-data-capture — derive the delta from the source's write log instead of diffing). buffr's `agents.documents` table (`sql/001_agents_schema.sql:4-12`) is the natural home for a per-doc content hash. Read next: `09-stale-embeddings.md` (the content-hash that powers change detection) and `03-chunking-strategies.md` (where the `#i` ids are minted).

## Project exercises

### Add a change-detection layer (only re-index changed docs)

- **Exercise ID:** `EX-RAG-10a`
- **What to build:** A `reindexCorpus(docs)` that stores a per-doc content hash, skips docs whose hash is unchanged, delta-updates changed docs via `indexDocument`, and deletes chunks for docs removed from the source.
- **Why it earns its place:** It completes the incremental path — turning aptkit's existing overwrite primitive into a real O(delta) re-index, and fixing the orphan-chunk and removed-doc gaps. Phase 2A: the next step on a primitive that already half-exists.
- **Files to touch:** new `packages/retrieval/src/reindex.ts`; uses `indexDocument` (`packages/retrieval/src/pipeline.ts:32-47`); needs a hash store (per-doc) — `agents.documents` (`buffr/sql/001_agents_schema.sql:4-12`) for the buffr path.
- **Done when:** re-running over a corpus with one edited doc, one removed doc, and N unchanged docs issues embeds only for the edited doc, deletes the removed doc's chunks, and leaves no orphans — proven by counting embed calls and asserting store contents.
- **Estimated effort:** `1–2 days`

### Fix the shrinking-doc orphan bug

- **Exercise ID:** `EX-RAG-10b`
- **What to build:** Make `indexDocument` (or the store) delete chunks for a doc beyond the new chunk count before/after upsert, so a doc that shrinks from 5 to 3 chunks ends with exactly 3.
- **Why it earns its place:** It's a real correctness bug in the existing primitive — shrunk docs leave stale orphans that still match queries. Small, sharp, high-value.
- **Files to touch:** `packages/retrieval/src/pipeline.ts:32-47`; add a `deleteByDocPrefix` to the `VectorStore` contract (`packages/retrieval/src/contracts.ts:33-37`) and both stores.
- **Done when:** re-indexing a doc from 5 chunks to 3 leaves exactly 3 chunks in the store, with a test asserting `#3`/`#4` are gone.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How does aptkit avoid duplicating chunks when you re-index a doc?**

```
chunk id = `${doc.id}#${i}`  (deterministic, not random)
   re-index "guide" → same ids guide#0,#1,#2 → upsert OVERWRITES same rows
   random/UUID ids would → new rows every time → duplicates
```

Anchor: deterministic doc-scoped ids make re-indexing idempotent — upsert overwrites by id, so the same doc never duplicates its chunks.

**Q: A doc was edited to be shorter and old content keeps showing up in results. Why?**

```
v1: guide#0..#4 (5 chunks)   →   v2 upserts guide#0..#2 (3 chunks)
   #0,1,2 overwritten ✓   |   #3,#4 untouched → ORPHANS still match queries
```

Anchor: upsert overwrites but never deletes — a shrinking doc leaves orphan chunks; incremental indexing needs an explicit delete-beyond-new-count step.

## See also

- [09-stale-embeddings.md](09-stale-embeddings.md) — content hashing for change detection
- [03-chunking-strategies.md](03-chunking-strategies.md) — where `${doc.id}#${i}` is minted
- [04-vector-databases.md](04-vector-databases.md) — upsert/on-conflict in both stores
