# Stale embeddings — the freshness problem

**Subtitle:** Embedding freshness · keeping vectors in sync with their text · *Industry standard*

## Zoom out, then zoom in

A stale embedding is retrieval's quietest bug: the search succeeds, returns a
confident chunk, and the chunk is *wrong* — because the text changed but its vector
still points at the old meaning. It lives at the store layer, where vectors and
their source text are supposed to agree. aptkit has the *primitive* to fix it
(upsert-by-id) but not automatic staleness *tracking* — that's `not yet exercised`.

```
  Zoom out — staleness is a vector/text disagreement

  ┌─ source text (edited over time) ────────────────────────────┐
  │  "We use Drizzle ORM"  ──edit──►  "We use Prisma ORM"        │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                vector lags    │ if not re-embedded
  ┌─ VectorStore ──────────────▼────────────────────────────────┐
  │  chunk.vector still points at "Drizzle" — retrieval lies     │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You know a cache-invalidation bug: the database row changed but the
cached copy didn't, so reads return stale data with full confidence. A stale
embedding is *exactly* a cache-invalidation bug, where the "cache" is the vector and
the "source" is the text. Two ways it goes stale: the text was edited, or the
embedding *model* was upgraded. Both leave a vector that no longer represents its
chunk.

## Structure pass

**Layers.** Source text (`meta.text` / the `content` column) → embedding (the vector)
→ store. Freshness is the invariant "the vector represents the current text"; staleness
is its violation.

**Axis — lifecycle.** Trace a chunk's life. Indexed: text and vector agree. Edited:
text changes, vector doesn't — *stale*. Re-embedded: agreement restored. The axis "do
the vector and text still agree?" flips at the edit and flips back at the re-embed.
aptkit detects the flip manually (re-index the doc); automatic detection is the gap.

**Seam.** The freshness primitive is `upsert` keyed by chunk id — `Map.set`
in-memory (`in-memory-vector-store.ts:21`), `on conflict (id) do update`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts:50`). Re-indexing a doc overwrites
its chunks *cleanly* by id. The detection hook is buffr's `embedding_model` column
(`/Users/rein/Public/buffr/sql/001_agents_schema.sql:23`).

## How it works

### Move 1 — the mental model

You know the cache-invalidation rule: when the source changes, the cache must be
invalidated, or readers get stale data while believing it's current. An embedding is
a derived cache of a chunk's meaning. Edit the chunk and the embedding is a stale
cache entry — and unlike a normal cache it has no TTL and no version check, so it
silently serves the old meaning until something re-embeds it.

```
  Stale embedding = cache invalidation, with no TTL

  text  "Drizzle ORM"  ──edit──►  "Prisma ORM"
  vector  v(Drizzle)   ──────────  v(Drizzle)   ← never invalidated
                                       │
  query "what ORM?" ─► matches v(Drizzle) ─► answers "Drizzle"  ← WRONG, confidently
```

### Move 2 — the two staleness sources and the primitive that fixes them

**Source 1: edited text.** The dangerous case. Retrieval still *works* — it returns
a high-cosine chunk — but the chunk's vector encodes deleted text, so the model
grounds its answer in something the corpus no longer says. There's no error; the
answer is just wrong. The fix is to re-embed on edit.

```
  Edited-text staleness — succeeds AND lies

  edit chunk text ─► (no re-embed) ─► vector unchanged
  retrieval: high score ✓   grounding: stale text ✗   user: misled, no error
```

**Source 2: model upgrade.** Switch from `nomic:v1.5` to a newer model and every old
vector lives in a different embedding space (the one-way door,
`02-embedding-model-choice.md`). buffr records the model per chunk so this is
*detectable* — `embedding_model text not null default 'nomic-embed-text:v1.5'`
(`/Users/rein/Public/buffr/sql/001_agents_schema.sql:23`):

```sql
embedding_model text not null default 'nomic-embed-text:v1.5',
```

A query like `where embedding_model != $currentModel` finds every chunk that needs
re-embedding. That column *is* the staleness hook — it's not used for automatic
tracking yet, but it's the foothold.

```
  Model-upgrade staleness — detectable via embedding_model

  current model: nomic:v2          rows with embedding_model = 'nomic:v1.5'
       │                                 │ ← stale: wrong embedding space
       └─ where embedding_model != current ─► the re-embed worklist
```

**The primitive that makes re-embedding safe: upsert by id.** Both stores upsert
keyed by chunk id, so re-indexing a doc *overwrites* its chunks in place rather than
duplicating them. In-memory (`in-memory-vector-store.ts:18`):

```ts
async upsert(chunks: VectorChunk[]): Promise<void> {
  for (const chunk of chunks) {
    this.assertDimension(chunk.vector, `chunk "${chunk.id}"`);
    this.chunks.set(chunk.id, chunk);     // same id ─► overwrite, no dup
  }
}
```

buffr does the same in SQL (`/Users/rein/Public/buffr/src/pg-vector-store.ts:50`):
`insert … on conflict (id) do update set … embedding = excluded.embedding`. Because
chunk ids are stable (`${docId}#${i}`, `pipeline.ts:42`), re-indexing the doc maps
each new chunk onto its old id and the fresh vector lands on top of the stale one.

```
  Re-embed = re-index the doc — id-stable overwrite

  indexDocument(doc) again ─► chunk "doc#0" upserts onto existing "doc#0"
   in-memory: Map.set     pg: on conflict (id) do update     ← fresh vector wins
```

### Move 2.5 — current state vs future state

```
  Phase A (aptkit, now)             Phase B (tracked freshness — not yet exercised)
  ┌────────────────────────┐        ┌──────────────────────────────────┐
  │ re-index doc MANUALLY   │        │ embedding_stale_at column,         │
  │ upsert-by-id overwrites │  add   │ re-embed on edit automatically     │
  │ embedding_model recorded│ track- │ where embedding_model != current   │
  │ no auto staleness check │ ing    │  ─► scheduled re-embed worklist    │
  └────────────────────────┘        └──────────────────────────────────┘
   the OVERWRITE primitive exists; the DETECTION/scheduling does not
```

### Move 3 — the principle

Treat an embedding as a derived cache of its text, and apply cache-invalidation
discipline: when the source changes, the vector must be regenerated. Build the safe
overwrite first — id-stable upsert means re-embedding never duplicates or corrupts —
then add detection: a timestamp for edits, the `embedding_model` column for model
drift. aptkit has the hard part (the clean overwrite); the gap is the bookkeeping
that knows *when* to fire it.

## Primary diagram

```
  Freshness lifecycle

  index ─► text & vector AGREE
    │
    ├─ text edited ────────────► STALE (succeeds + lies)
    │      detect: edit timestamp / embedding_stale_at  (not yet exercised)
    │
    ├─ model upgraded ─────────► STALE (wrong space)
    │      detect: where embedding_model != current  (column exists, sql:23)
    │
    └─ re-index doc ───────────► FRESH
           upsert by id overwrites cleanly (in-memory:18, pg on conflict:50)
```

## Elaborate

The reason stale embeddings are more dangerous than a missing chunk is that they
*pass* retrieval — high cosine score, plausible citation — while grounding the model
in deleted facts. A miss is honest ("I couldn't find that"); a stale hit is a
confident lie. aptkit's design makes the *cure* trivial (re-index the doc, ids stay
stable, vectors overwrite) and leaves only the *diagnosis* unbuilt. buffr's
`embedding_model` column (`/Users/rein/Public/buffr/sql/001_agents_schema.sql:23`) is
the deliberate seed for model-drift detection; an `embedding_stale_at` timestamp
would close the edit case. Read `02-embedding-model-choice.md` for the one-way door
that makes model upgrades a staleness event and `10-incremental-indexing.md` for the
upsert-by-id mechanics and the orphan-chunk shrink case.

## Project exercises

### Track edit-staleness and re-embed on change
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** record a content hash (or `embedding_stale_at`) per document; on
  re-index, re-embed only chunks whose source text changed, relying on id-stable
  upsert to overwrite them.
- **Why it earns its place:** staleness is the subtlest RAG correctness bug; wiring
  detection onto the existing overwrite primitive shows you close the
  cache-invalidation loop, not just describe it.
- **Files to touch:** `packages/retrieval/src/pipeline.ts` (hash compare in
  `indexDocument`), `/Users/rein/Public/buffr/sql/001_agents_schema.sql` (add the
  column), a new test in `packages/retrieval/test/`.
- **Done when:** a test shows re-indexing an unchanged doc skips re-embedding and an
  edited chunk gets a fresh vector under the same id.
- **Estimated effort:** `1–2 days`

### Detect model-drift via the embedding_model column
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a query/script over `agents.chunks` that lists chunks whose
  `embedding_model` differs from the current provider's id, producing a re-embed
  worklist.
- **Why it earns its place:** turns the dormant `embedding_model` column into a
  working staleness detector, proving you understood why it was added.
- **Files to touch:** `/Users/rein/Public/buffr/src/pg-vector-store.ts` (add a
  `staleChunkIds(currentModel)` method), a new test against the schema.
- **Done when:** the method returns ids of chunks embedded by any model other than
  the current one.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "How do you keep embeddings in sync with changing documents?"**
Treat the vector as a cache of the text and re-embed on change. The safe primitive is
id-stable upsert: chunk ids are `${docId}#${i}` (`pipeline.ts:42`), so re-indexing a
doc overwrites its chunks in place — `Map.set` in-memory
(`in-memory-vector-store.ts:18`), `on conflict (id) do update` in pg
(`pg-vector-store.ts:50`) — no duplicates. The detection side (re-embed *when* the
text or model changes) is the gap; buffr's `embedding_model` column is the hook for
model drift.

```
  edit ─► re-embed ─► upsert by id ─► fresh vector overwrites stale, no dup
```
Anchor: *an embedding is a cache of its text — when the text changes, invalidate it.*

**Q: "Why is a stale embedding worse than a missing one?"**
Because it passes retrieval. A stale chunk still scores high and returns a clean
citation, so the model grounds its answer in text the corpus no longer contains — a
confident wrong answer with no error. A miss is honest; the agent can say "I couldn't
find that." A stale hit lies. That's why freshness is a correctness invariant, not a
performance nicety.

```
  miss  ─► "couldn't find it"   (honest)
  stale ─► high score + old text ─► confident wrong answer  (silent)
```
Anchor: *a stale hit is a confident lie; a miss is an honest no.*

## See also

- `02-embedding-model-choice.md` — the one-way door that makes model upgrades stale
- `10-incremental-indexing.md` — upsert-by-id mechanics and the orphan-chunk case
- `04-vector-databases.md` — the `embedding_model` column on the chunks table
- `11-rag.md` — stable chunk ids (`${docId}#${i}`) that make overwrite clean
- `05-evals-and-observability/01-eval-set-types.md` — catching staleness with evals
