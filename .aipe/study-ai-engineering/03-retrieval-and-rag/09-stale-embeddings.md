# Stale embeddings
> The freshness problem · Industry standard

Here's a bug that doesn't crash anything and silently rots your retrieval: someone edits a document, the *text* updates, but the *vector* doesn't. Now your store ranks chunks by what they used to say. The citation shows the new text; the ranking was computed from the old. Retrieval drifts from reality and nothing throws — there's no dimension mismatch, no error, just slowly-wrong results. aptkit doesn't track staleness at all, and buffr has the *slot* for it (an `embedding_model` column) but no freshness flag. This is `not yet exercised`, and the fix is a re-embed-on-edit trigger plus a staleness column.

## Zoom out, then zoom in

Staleness is a property of the stored vector relative to the text it was computed from — it lives in the store's durable state.

```
where staleness hides
┌──────────────────────────────────────────────────────────┐
│  source doc (edited)        text = "ten business days"      │
└───────────────┬────────────────────────────────────────────┘
                │ re-index?  ← if this DOESN'T run on edit...
                ▼
┌──────────────────────────────────────────────────────────┐
│  ★ stored chunk ★   text="ten business days" (updated)      │  ← drift lives here
│                     embedding = vector of "five days" (OLD) │
│  buffr: embedding_model col exists; embedding_stale_at: ✗   │
└──────────────────────────────────────────────────────────┘
```

The danger is that text and vector live in the *same row* but update on *different triggers*. If the edit path writes new `content` but skips re-embedding, the row is internally inconsistent — and nothing in the schema or the contracts catches it. There's no `assertDimension`-style guard for "this vector matches this text," because that's not a thing you can check cheaply. Staleness is the failure mode that has no loud version.

## Structure pass

Pick the **trust** axis: can you trust that a stored vector reflects its current text?

```
trust of vector-vs-text across the edit lifecycle
  index time          edit time              query time
  ┌──────────┐        ┌──────────────┐       ┌──────────────┐
  │ text v1   │        │ text → v2     │       │ search uses   │
  │ vec(v1)   │        │ vec STILL v1  │       │ vec(v1) vs q  │
  │ CONSISTENT│        │ INCONSISTENT  │       │ ranks by v1   │
  └──────────┘        └──────┬───────┘       └──────────────┘
                              ▼
                  ★ seam: edit updates text but not vector ★
                     trust silently breaks here
```

The seam is the edit path. At index time, text and vector agree — they were computed together. The moment an edit updates text without re-embedding, trust breaks, and it stays broken until something re-indexes. Without a staleness marker, you can't even *tell* which rows are inconsistent. The fix isn't to prevent edits; it's to *record* when a vector is suspect so a background job can re-embed it.

## How it works

**Move 1 — the mental model: vector is a cache of text.** Treat the embedding as a derived cache, and staleness is plain cache invalidation:

```
embedding as a cache (the right mental model)
   text  ──embed()──►  vector        (vector is DERIVED from text)
    │                                  cache key = (text, model)
    ▼ edit text
   text'  ──??──►  vector (unchanged)  ← STALE: cache key changed, value didn't
   fix: on text change OR model change → invalidate → re-embed
```

Two things invalidate the cache: the *text* changed (edit) or the *model* changed (file 02's one-way door). buffr already records the second — every chunk carries the model that produced it.

**What buffr has — the model slot, no staleness flag.** The schema stamps the model but has no freshness column:

```sql
-- buffr/sql/001_agents_schema.sql:22-25
embedding vector(768) not null,
embedding_model text not null default 'nomic-embed-text:v1.5',  -- ← model provenance (the slot)
meta jsonb not null default '{}'
-- MISSING: no embedding_stale_at, no content_hash, no embedded_at
```

```
what buffr can vs can't answer today
   "which chunks were embedded with the OLD model?"  → YES (filter embedding_model) ✓
   "which chunks' text changed since they were embedded?" → NO (no signal) ✗
```

So buffr can detect *model* staleness (re-embed everything not on the current model — that's the file-02 migration) but cannot detect *content* staleness. The edit path could write new `content` via `upsert` and leave a stale vector, and the schema would happily store the inconsistency.

**Move 2 — the fix: a staleness marker + re-embed.** `not yet exercised`. Add a column and a trigger:

```sql
-- proposed schema addition (DOES NOT EXIST yet)
alter table agents.chunks add column content_hash text;          -- hash of the text at embed time
alter table agents.chunks add column embedding_stale_at timestamptz;  -- set when text changes
```

```
re-embed-on-edit flow (pseudocode)
on document edit:
    for each chunk of the doc:
        if hash(chunk.newText) != chunk.content_hash:    # text actually changed
            mark embedding_stale_at = now()              # flag it, don't block the edit
    # background worker (or synchronous if small):
    for chunk where embedding_stale_at is not null:
        vec = embed(chunk.content)                       # recompute the cache
        upsert(chunk with new vec, content_hash = hash(content), embedding_stale_at = null)
```

The key design choice: *flag, don't block*. The edit completes immediately (write text, mark stale); re-embedding happens async. That keeps writes fast and makes staleness *visible and queryable* — `where embedding_stale_at is not null` is your re-embed work queue. aptkit's `${doc.id}#${i}` id scheme (file 10) means the re-embed `upsert` overwrites the same rows in place.

**Move 3 — the principle.** An embedding is a cache of (text, model), and like every cache it goes stale when its inputs change. The two invalidation triggers are content edits and model swaps. The failure is silent — no exception, just drift — so the only defense is to *record* staleness (a flag, a content hash, an embedded-at timestamp) and re-embed on a cadence. Don't try to prevent stale vectors; make them visible and have a job that reconciles them.

## Primary diagram

```
the staleness lifecycle and the fix
   index:  text v1 ──embed──► vec(v1), content_hash = h(v1)   [CONSISTENT]
                                         │
   edit:   text → v2 ─────────────────► content_hash != h(v2)
                                         │ trigger
                                         ▼
                              embedding_stale_at = now()        [FLAGGED]
                                         │ background worker
                                         ▼ re-embed
                              vec(v2), content_hash = h(v2), stale_at = null  [CONSISTENT]
   ─────────────────────────────────────────────────────────────────────
   aptkit today: no tracking   |   buffr today: model slot only, no stale flag
```

Flag on edit, re-embed async, clear the flag — the stale-marker column is what turns silent drift into a visible work queue.

## Elaborate

This is classic cache invalidation wearing a RAG hat — Phil Karlton's "two hard things" joke applies directly. Adjacent patterns: **content-addressed embeddings** (key the vector by a hash of its text + model, so re-indexing unchanged text is a no-op cache hit — the cheap way to avoid re-embedding everything), **embedding versioning** (the `embedding_model` column generalized to a full version so you can run two model versions side by side during migration), and **TTL-based re-embed** (re-embed everything older than N days regardless, for corpora where source-of-truth changes outside your edit path). The model-staleness half connects straight to file 02's one-way door. Read next: `02-embedding-model-choice.md` (model-side staleness) and `10-incremental-indexing.md` (the upsert-by-id that makes re-embed cheap).

## Project exercises

### Add embedding_stale_at to buffr's schema + re-embed-on-edit

- **Exercise ID:** `EX-RAG-09a`
- **What to build:** Add `content_hash` and `embedding_stale_at` columns to `agents.chunks`, flag chunks stale when their text changes, and a re-embed worker that processes `where embedding_stale_at is not null` and clears the flag.
- **Why it earns its place:** It turns buffr's silent content-drift into a visible, queryable work queue — the difference between "retrieval slowly rots and nobody knows" and "there's a stale-chunk count on a dashboard." Case B. Phase 2B.
- **Files to touch:** `buffr/sql/001_agents_schema.sql:14-30` (columns + maybe an index on `embedding_stale_at`); `buffr/src/pg-vector-store.ts:38-65` (`upsert` writes `content_hash`, clears `stale_at`); new re-embed worker under `buffr/src/`.
- **Done when:** editing a chunk's text flags it stale, the worker re-embeds and clears the flag, and a query before the worker runs is provably ranking on the old vector (the bug) vs after (the fix).
- **Estimated effort:** `1–2 days`

### Content-addressed skip-re-embed on unchanged text

- **Exercise ID:** `EX-RAG-09b`
- **What to build:** In `indexDocument`/`upsert`, compute `content_hash` per chunk and skip the embed call when the stored hash matches — re-indexing unchanged text becomes a no-op.
- **Why it earns its place:** Re-indexing a 1000-chunk doc to fix one paragraph shouldn't re-embed 999 unchanged chunks. Content-addressing makes incremental indexing (file 10) actually cheap.
- **Files to touch:** `packages/retrieval/src/pipeline.ts:32-47` (`indexDocument`); `buffr/src/pg-vector-store.ts:38-65` (compare hash before embed).
- **Done when:** re-indexing a doc with one changed chunk issues exactly one embed call, proven by counting calls on an injected transport.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: A user edited a doc and search results got subtly worse but nothing errored. What happened?**

```
edit path wrote new TEXT but not a new VECTOR
   row: content = "v2", embedding = vec("v1")   ← internally inconsistent
   ranking computed from v1, citation shows v2 → silent drift, no exception
```

Anchor: the vector is a cache of the text; an edit that updates text without re-embedding leaves a stale vector, and there's no loud failure — only drift. You need a staleness marker to even detect it.

**Q: buffr stores `embedding_model` per chunk. Does that solve staleness?**

```
embedding_model → detects MODEL staleness (re-embed off-version chunks) ✓
   detects CONTENT staleness (text changed since embed)?  ✗ no signal
```

Anchor: the model column catches the one-way-door migration but not content edits — you need a `content_hash` or `embedding_stale_at` for the edit case, which buffr lacks.

## See also

- [02-embedding-model-choice.md](02-embedding-model-choice.md) — model-side staleness, the one-way door
- [10-incremental-indexing.md](10-incremental-indexing.md) — upsert-by-id makes re-embed in place
- [04-vector-databases.md](04-vector-databases.md) — where the stale state lives
