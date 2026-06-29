# 03 — Embedding dimension as a one-way door

**Industry name(s):** dimension integrity constraint · fail-loud
invariant · "one-way door" decision (Bezos's term for a hard-to-reverse
choice). **Type:** Industry-standard vector-store invariant, enforced
mostly in app code here.

## Zoom out, then zoom in

The dimension lives in three places, and they all have to agree or the
whole RAG pipeline silently returns garbage. Here's where each guard sits.

```
  Zoom out — the dimension, guarded at three altitudes

  ┌─ aptkit pipeline (wiring time) ─────────────────────────────────┐
  │  assertWiring: embedder.dimension === store.dimension           │ ★ guard 1
  └───────────────────────────┬──────────────────────────────────────┘
                              │ at every upsert/search
  ┌─ aptkit / buffr store (call time) ▼─────────────────────────────┐
  │  assertDim(vector): vector.length === store.dimension           │ ★ guard 2
  └───────────────────────────┬──────────────────────────────────────┘
                              │ on the column
  ┌─ buffr Postgres (storage) ▼─────────────────────────────────────┐
  │  embedding vector(768) not null   ← pgvector rejects wrong width │ ★ guard 3
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in. An embedding's dimension (768 for `nomic-embed-text`) is fixed
by the model that produced it. Cosine similarity between a 768-dim corpus
vector and a 512-dim query vector is *meaningless* — and worse, it can
still compute a number, so it fails *silently* by returning wrong rankings
rather than throwing. The invariant — "everything in one collection must
share a dimension, and a query must match it" — is a one-way door: change
the embedder and your entire indexed corpus is unsearchable until you
re-index. This file is about how that invariant is enforced and where the
enforcement actually lives.

## The structure pass

Axis: **failure — where does a dimension mismatch get caught, and how
loud is it?**

```
  axis = "a 512-dim vector meets a 768-dim store — what happens?"

  guard 1 (wiring) │ guard 2 (call) │ guard 3 (column) │ NO guard
  ════════════════ │ ══════════════ │ ════════════════ │ ════════════
  throws at        │ throws at      │ pgvector rejects │ cosineSimilarity
  startup, before  │ first up/search│ the insert       │ returns a NUMBER
  any data moves   │                │                  │ → silent garbage
       ▲                                                      ▲
   loudest, earliest                                    the failure mode
                                                        the guards prevent
```

- **Layers:** pipeline wiring → store call → DB column. The same invariant
  is checked at three nested altitudes.
- **The axis (failure containment):** each layer catches the mismatch
  earlier and louder than the one below. The *worst* outcome — the
  no-guard column at the bottom of the diagram — is the silent one:
  `cosineSimilarity` happily computes over mismatched-length arrays and
  returns a plausible-looking score.
- **The seam:** the boundary between "fails loud at wiring time" (app
  code) and "would fail silent at ranking time" (the math) is exactly why
  the guards exist. The DB's `vector(768)` is real but it's the *last*
  line; the load-bearing guard is `assertWiring`, before any data moves.

## How it works

#### Move 1 — the mental model

You know how a React `key` mismatch doesn't crash — it just renders the
wrong rows, silently? A dimension mismatch in a vector store is that, but
worse: the ranking is wrong and nothing tells you. So the fix is the same
instinct you'd reach for with a type error — catch it at the boundary, as
early as possible, and throw. The pattern is *assert the invariant at
wiring time, not at query time.*

```
  the pattern — assert before the data can move

  build a pipeline ──► assertWiring(embedder.dim === store.dim)
                            │ mismatch?  → THROW here, at startup
                            │ match?     → proceed
                            ▼
  index / query ──► assertDim(vector.length === store.dim)
                            │ mismatch?  → THROW at the call
                            ▼
  Postgres insert ──► vector(768) ──► DB rejects wrong width
```

#### Move 2 — the walkthrough

**Guard 1 — wiring time, the loudest.** `assertWiring` runs the instant a
pipeline is built and on every index/query call —
`/Users/rein/Public/aptkit/packages/retrieval/src/pipeline.ts:22-29`:

```ts
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(
      `dimension mismatch: embedder "${wiring.embedder.id}" is ${wiring.embedder.dimension}-dim ` +
        `but store is ${wiring.store.dimension}-dim — re-index the corpus with a matching provider`,
    );
  }
}
```

`createRetrievalPipeline` calls this *before returning the pipeline*
(`pipeline.ts:73-75`), so a misconfigured wiring can't even be
constructed, let alone index a single vector. The error message names the
fix ("re-index the corpus with a matching provider") — because that *is*
the only recovery from a one-way door: you don't convert vectors, you
re-embed. **What breaks if you drop this guard: the pipeline indexes a
corpus at one dimension, someone later wires a different embedder, and
every search returns wrong-but-plausible results with no error.**

**Guard 2 — call time, per vector.** Both stores re-check at the point of
use, because the contract lets a caller bypass the pipeline and hit
`upsert`/`search` directly (memory does exactly this). The in-memory store
— `packages/retrieval/src/in-memory-vector-store.ts:36-42`:

```ts
private assertDimension(vector: number[], label: string): void {
  if (vector.length !== this.dimension) {
    throw new Error(
      `dimension mismatch: ${label} has length ${vector.length}, store expects ${this.dimension}`,
    );
  }
}
```

And the durable store mirrors it exactly —
`/Users/rein/Public/buffr/src/pg-vector-store.ts:32-36` (`assertDim`),
called on every chunk in `upsert` and on the query vector in `search`. The
memory engine even checks at construction —
`packages/memory/src/conversation-memory.ts:62-66` throws if
`embedder.dimension !== store.dimension`. Same invariant, four call sites,
because there are four ways to reach a vector store.

**Guard 3 — the column, the only DB-level guard.** `embedding vector(768)
not null` (`/Users/rein/Public/buffr/sql/001_agents_schema.sql:23`) is the
one place the *database* enforces the dimension — pgvector rejects an
insert whose vector isn't exactly 768 wide. Note it's a hardcoded literal,
not a parameter: the schema is pinned to nomic's 768. Change embedders and
this column has to change too (and the HNSW index rebuilt). That's the
one-way door made physical in the DDL.

**The silent-failure floor the guards prevent.** Strip every guard and you
land on `cosineSimilarity`
(`packages/retrieval/src/in-memory-vector-store.ts:46-57`): it loops
`for (let i = 0; i < a.length; …)` over `a` and indexes `b[i]` — mismatched
lengths don't throw, they just read past the shorter array as `undefined`
(coerced via `!`), producing a number that *looks* like a score. That's
the failure the three guards exist to make impossible.

#### Move 3 — the principle

Some invariants can't be repaired after the fact — a corpus embedded at
the wrong dimension isn't *converted*, it's *re-embedded* from scratch.
For one-way doors like that, the enforcement belongs as early and as loud
as you can put it: at wiring/construction time, before any data commits,
with an error message that names the only real recovery. The DB column
(`vector(768)`) is a backstop, but the load-bearing guard is in app code
*above* the storage layer — because by the time a bad vector reaches the
column, the misconfiguration that produced it has already been live.

## Primary diagram

```
  the dimension invariant, all guards in one frame

  ── aptkit ───────────────────────────────────────────────────────
  createRetrievalPipeline / createConversationMemory
        │  assertWiring / ctor check:  embedder.dim === store.dim
        │  ✗ → throw at STARTUP  ("re-index with a matching provider")
        ▼
  upsert(chunks) / search(vector)
        │  assertDim(v): v.length === store.dim   (4 call sites)
        │  ✗ → throw at the CALL
        ▼
  ── buffr Postgres ────────────────────────────────────────────────
  insert … embedding vector(768) not null
        │  ✗ wrong width → pgvector REJECTS insert
        ▼
  (if all guards removed) cosineSimilarity over mismatched arrays
        → returns a plausible NUMBER → SILENT wrong ranking  ◄ prevented
```

## Elaborate

"One-way door" is Amazon's framing for decisions that are expensive or
impossible to reverse — the embedder choice is one, because it fixes the
dimension of every vector you'll ever store in that collection. The
industry pattern (Pinecone, Weaviate, Qdrant, pgvector) is identical:
dimension is a per-collection/per-column property set at creation and
immutable after. What's specific here is the *layering* of the guard — the
same check at wiring, call, construction, and column. The honest gap: the
DB only guards *width* (768), not *which model* produced the vector. The
`embedding_model` column (`schema:23`, default `nomic-embed-text:v1.5`)
records provenance but nothing enforces that two rows with the same width
came from the same model — two 768-dim models would pass every guard and
still rank incorrectly against each other. That's a real `not yet
exercised` integrity gap: provenance is recorded, not enforced. Read next:
`study-ai-engineering` for embeddings/ANN, `study-database-systems` for
the HNSW index pgvector builds on this column.

## Interview defense

**Q: Where do you enforce that a query vector matches the corpus
dimension, and why so many places?**

Four app-code call sites plus the column. The loudest is `assertWiring`,
which runs when the pipeline is constructed — a mismatched embedder/store
can't even build a pipeline. Then `assertDim` re-checks every vector on
upsert and search, because callers can hit the store contract directly
(memory does). The DB's `vector(768)` is the last backstop. Many layers
because a dimension mismatch fails *silently* otherwise — cosine
similarity over mismatched-length arrays still returns a number.

```
  wiring  → throw at startup (loudest, earliest)
  call    → throw per vector
  column  → pgvector rejects insert
  ──────────────────────────────────────────────
  no guard → cosineSimilarity returns garbage score (the silent failure)
```

Anchor: *a dimension mismatch is the one that fails silent — so you catch
it at wiring time, before any data moves.*

**Q: What's the recovery if you change embedders?**

There isn't a cheap one — it's a one-way door. You re-embed the entire
corpus and rebuild the HNSW index; you can't convert existing vectors.
That's why the error message literally says "re-index the corpus with a
matching provider," and why the `vector(768)` column is a hardcoded
literal pinned to nomic.

Anchor: *you don't convert embeddings across dimensions, you re-index —
so the constraint is a one-way door.*

## See also

- `02-metadata-as-json-bag.md` — the other invariants the store enforces.
- `05-kind-tag-logical-partition.md` — sharing one dimension-pinned
  collection across memory and documents.
- `audit.md` §4 (transactions/integrity), §1 (the shapes).
- `study-database-systems` — HNSW on the `embedding` column.
