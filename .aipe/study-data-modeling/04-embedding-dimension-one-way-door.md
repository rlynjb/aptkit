# 04 — Embedding dimension as a one-way-door constraint

**Industry name(s):** dimensionality invariant / typed vector column
(a.k.a. fixed-arity embedding constraint, "fail-fast at wiring"). **Type:**
Industry standard.

The one integrity constraint enforced everywhere — in the column type, in
the store at runtime, and at pipeline wiring time. A corpus embedded at one
dimension can never be searched by a query of another, so the system rejects
a mismatched vector *loudly* rather than corrupting ranking silently.

## Zoom out, then zoom in

The dimension check appears at three altitudes — the SQL column, the store's
runtime guard, and the pipeline's wiring assertion — and they all defend the
same fact.

```
  Zoom out — where the dimension constraint lives

  ┌─ aptkit wiring (packages/retrieval) ───────────────────────┐
  │  assertWiring: embedder.dimension === store.dimension       │
  │    (pipeline.ts:22-29)  — fails at construction, not query  │ ← we are here
  └───────────────────────────────┬─────────────────────────────┘
                                  │ store enforces too
  ┌─ store runtime guard ──────────▼────────────────────────────┐
  │  assertDim(v): v.length === this.dimension                  │
  │    InMemory (in-memory-vector-store.ts:35) · Pg (:32-36)    │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ DB enforces too
  ┌─ Postgres column type ─────────▼────────────────────────────┐
  │  embedding vector(768) not null   (001_agents_schema.sql:22)│
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: an embedding is a fixed-length array — `nomic-embed-text` produces
768 numbers, always. Cosine similarity between a 768-vector and a 384-vector
is meaningless (the loop reads off the end or compares the wrong axes). A
silent mismatch doesn't crash — it returns *plausible-looking but wrong*
rankings, the worst kind of bug. The question this answers: *how do you make
a dimension mismatch impossible to ignore?* You assert it at every layer
that touches a vector, and you call it a "one-way door" because once a corpus
is embedded at 768, re-dimensioning means re-embedding the entire corpus.

## Structure pass

```
  One axis — "is this vector the right length?" — checked at every layer

  ┌─ wiring (construction) ───────────┐
  │  assertWiring(embedder, store)    │   → CHECKED ONCE, at build. Fails the
  └───────────────────────────────────┘      whole pipeline before any data.
              │  (same invariant, lower)
              ▼
  ┌─ store (every upsert/search) ─────┐
  │  assertDim(vector)                │   → CHECKED PER CALL. Catches a stray
  └───────────────────────────────────┘      vector that slipped the wiring.
              │  (same invariant, lowest)
              ▼
  ┌─ column type (every insert) ──────┐
  │  vector(768) not null             │   → CHECKED BY POSTGRES. The last
  └───────────────────────────────────┘      line; rejects wrong arity on write.
```

- **Layers:** wiring → store guard → column type.
- **Axis = "is the vector the right length?"** Same question, three
  altitudes. The answer never changes — but *when* it's caught moves
  earlier as you go up: wiring catches it before any data flows, the store
  per call, the column on write.
- **The seam — there isn't one; that's the point.** Normally a constraint
  lives at one layer and the others trust it. Here the invariant is
  *self-similar*: the identical check appears at three layers because each
  defends a different failure path (misconfigured wiring / a rogue vector /
  a raw SQL insert). Defense in depth for one fact.

## How it works

#### Move 1 — the mental model

You know this from TypeScript: a function typed `(xs: [number, number,
number]) => ...` won't accept a 2-tuple — the arity is part of the type, and
the mismatch is caught at compile time, not at runtime with a wrong answer.
The embedding dimension is that tuple arity, except it has to be enforced at
*runtime* (the vector is a `number[]`, not a fixed tuple) and *in the
database* (the column type). So the codebase manually re-creates
compile-time arity checking at three runtime layers.

```
  The pattern — one fact, guarded fail-fast at every layer

  embedder.dimension = 768          store.dimension = 768
            └───────────┬───────────────┘
                        ▼  assertWiring at construction
                  match? ──no──► THROW (pipeline never builds)
                        │ yes
                        ▼
  every vector ─► assertDim(v): v.length === 768 ──no──► THROW
                        │ yes
                        ▼
  insert embedding ─► vector(768) ──wrong arity──► Postgres rejects
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — wiring asserts at construction, before any data.** The pipeline
refuses to exist if embedder and store disagree.

```ts
// packages/retrieval/src/pipeline.ts:22-29
function assertWiring(wiring: RetrievalWiring): void {
  if (wiring.embedder.dimension !== wiring.store.dimension) {
    throw new Error(
      `dimension mismatch: embedder "${wiring.embedder.id}" is ${wiring.embedder.dimension}-dim ` +
        `but store is ${wiring.store.dimension}-dim — re-index the corpus with a matching provider`,
    );
  }
}
```

This runs in `createRetrievalPipeline` (`pipeline.ts:73-74`) *and* at the
top of every `indexDocument`/`queryKnowledgeBase` call (`:36, :55`). The
error message names the fix — "re-index the corpus with a matching
provider" — because that *is* the only remedy: it's a one-way door.

**Step 2 — the memory engine asserts the same thing.** Memory has its own
copy of the check, because it wires an embedder to a store independently of
the retrieval pipeline.

```ts
// packages/memory/src/conversation-memory.ts:62-66
if (embedder.dimension !== store.dimension) {
  throw new Error(
    `embedder dimension ${embedder.dimension} != store dimension ${store.dimension}`,
  );
}
```

Same invariant, second consumer. That both consumers independently assert it
tells you the dimension is a property of the *contract*, not of any one
pipeline.

**Step 3 — the store guards every vector at runtime.** Both adapters check
arity on `upsert` and `search`.

```ts
// buffr/src/pg-vector-store.ts:32-39
private assertDim(v: number[]): void {
  if (v.length !== this.dimension) {
    throw new Error(`dimension mismatch: got ${v.length}, store is ${this.dimension}`);
  }
}
async upsert(chunks: Chunk[]): Promise<void> {
  for (const c of chunks) this.assertDim(c.vector);   // ← every chunk, before the txn opens
  ...
}
```

```ts
// packages/retrieval/src/in-memory-vector-store.ts:34-41
private assertDimension(vector: number[], label: string): void {
  if (vector.length !== this.dimension) {
    throw new Error(`dimension mismatch: ${label} has length ${vector.length}, store expects ${this.dimension}`);
  }
}
```

The in-memory comment names the stakes precisely: *"a silent mismatch
corrupts ranking"* (`in-memory-vector-store.ts:33`). Cosine over
mismatched-length arrays doesn't throw on its own — it reads garbage and
returns a number. The assert is what turns silent corruption into a loud
crash.

**Step 4 — the column type is the last line.** Even a raw SQL insert
bypassing all the JS guards hits `vector(768)`.

```sql
-- buffr/sql/001_agents_schema.sql:22
embedding vector(768) not null,
```

pgvector rejects an insert whose array length ≠ 768. So the constraint
survives even if someone writes SQL by hand — the database is the floor.

```
  Layers-and-hops — a 384-dim vector dies at the first gate

  ┌─ caller ───────┐  pipeline.query(q)   (embedder swapped to a 384-dim model)
  │ query/index    │ ──────────────────────────────────────────────┐
  └────────────────┘                                                │
                       ┌─ assertWiring ────────────────────────────┐│
                       │ 384 !== 768 → THROW at construction        │◄┘
                       │ (never reaches the store or the DB)        │
                       └────────────────────────────────────────────┘
                       — if it somehow slipped through —
                       ┌─ store.assertDim ─► THROW per vector       │
                       ┌─ Postgres vector(768) ─► reject on insert  │
```

#### Move 2 variant — the load-bearing skeleton

Kernel of "dimensionality invariant": **a single declared `dimension` on
both embedder and store + an equality check before any vector is stored or
searched.**

- **Drop the check** and a mismatched embedder silently corrupts every
  ranking — the system "works" but returns nonsense, undetectably.
- **Drop the `not null`** on the column and a chunk with no embedding becomes
  unsearchable dead weight in the index.
- **Make it checkable later instead of at wiring** and you discover the
  mismatch only after embedding the whole corpus — the most expensive time
  to find it.

The three-layer repetition is *not* redundant hardening you could remove —
each layer catches a different entry path (construction / API call / raw
SQL). The skeleton is the invariant; the three placements are coverage.

#### Move 3 — the principle

Some constraints are cheap to violate and cheap to fix; this one is cheap to
violate and *catastrophic* to fix (re-embed everything). For those, you
don't trust a single guard — you assert the invariant at every layer that
could introduce the violation, and you fail at the *earliest* possible
moment (wiring, not query). "Fail loud, fail early" is worth most exactly
when the failure is otherwise silent and the recovery is a full rebuild.

## Primary diagram

```
  The dimension one-way door — three guards, one invariant

  embedder.dimension ─┐                        ┌─ store.dimension
   (768, nomic)        │   assertWiring (build) │   (768)
                       └────────► match? ◄──────┘
                                   │ no → THROW "re-index the corpus"
                                   │ yes
            ┌──────────────────────┼──────────────────────┐
            ▼                      ▼                       ▼
   index path / query     store.assertDim(v)     Postgres vector(768)
   embed → upsert/search   v.length === 768       rejects wrong arity
            │  every vector checked before it is stored or compared
            ▼
   one-way door: changing 768 ⇒ re-embed the ENTIRE corpus
```

## Elaborate

Every vector database enforces a fixed dimension per index/collection —
pgvector's `vector(n)`, Pinecone's index dimension, Qdrant's collection
config. The dimension is set by the embedding model (768 for nomic,
1536/3072 for OpenAI's models, etc.), and you cannot mix models in one index
because their vector spaces are unrelated. The "one-way door" framing is the
honest operational truth: a dimension change is a corpus re-embed, often the
single most expensive maintenance operation in a RAG system.

What's notable in this repo is enforcing the invariant in *application code*
at wiring time, above the database — so a developer who swaps
`OllamaEmbeddingProvider` for a hypothetical 1536-dim OpenAI provider gets a
crash at `createRetrievalPipeline`, with a message telling them to
re-index, instead of a confusing wrong-results bug hours later. Read next:
`02-metadata-as-a-json-bag.md` (the other column on `chunks`), and
study-database-systems for how pgvector and HNSW actually store and search
fixed-arity vectors.

## Interview defense

**Q: You check the embedding dimension in three places — the column type,
the store, and the pipeline wiring. Isn't that redundant?**

> No — each catches a different entry path. `assertWiring` fails at
> construction, before any data flows, when someone swaps in a mismatched
> embedder. `store.assertDim` catches a stray vector that reached the store
> some other way, per call. The `vector(768)` column catches a raw SQL
> insert that bypassed the JS entirely. They defend one invariant against
> three failure modes. I lead with the wiring check because it fails
> earliest and cheapest — before I've embedded a single document.

```
  swap embedder (384) → assertWiring THROWS at build  ← caught here, cheapest
  stray vector        → store.assertDim THROWS per call
  raw SQL insert      → vector(768) rejects           ← last line, the DB floor
```

Anchor: *the dimension is a one-way door — fail at wiring, because the only
fix is re-embedding the whole corpus.*

**Q: Why is it a "one-way door"? What's the cost of getting it wrong?**

> Because a corpus embedded at 768 dimensions is only searchable by 768-dim
> queries — the vector space is defined by the model. Changing the model
> changes the space, so every existing chunk's embedding is now garbage. The
> only remedy is re-embedding the entire corpus, which is why the error
> message literally says "re-index the corpus with a matching provider." A
> silent mismatch is worse than a crash: cosine over mismatched arrays
> returns a plausible number, so ranking is quietly wrong.

Anchor: *a silent dimension mismatch corrupts ranking without crashing —
that's why every layer asserts loudly.*

## See also

- `02-metadata-as-a-json-bag.md` — the other columns alongside `embedding`.
- `03-kind-tag-shared-collection.md` — memory and documents share one
  dimension, asserted by the memory engine too.
- `audit.md` lens 4 — the dimension as the strongest enforced invariant.
- **study-database-systems** — pgvector storage, HNSW, cosine distance.
