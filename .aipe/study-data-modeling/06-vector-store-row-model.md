# Vector-store row model — corpus as `(id, vector, meta)`

**Industry name(s):** vector store / embedding index row model; dense-retrieval corpus schema. **Type label:** Industry standard (the row shape `@aptkit/retrieval` uses is the same one pgvector, Pinecone, Qdrant, and Weaviate all expose).

This is the one file in this guide that describes an actual *store-shaped* data model — rows with a primary key, a payload, and a query that ranks them. Until `@aptkit/retrieval` landed, AptKit had only type-shaped and file-shaped data (see `01`–`05`). This package adds a genuine corpus: a set of rows you `upsert` and `search`. It is in-memory, not Postgres — but the *shape* is exactly the shape you'd port to pgvector unchanged, which is the whole point.

## Zoom out, then zoom in

Here's where the corpus sits in the retrieval pipeline. The data model is the box in the middle — everything above it produces rows, everything below it consumes ranked rows.

```
  Zoom out — where the corpus row model lives

  ┌─ Source layer ──────────────────────────────────────────────┐
  │  RetrievalDocument { id, text, meta? }   (pipeline.ts:5)     │
  └───────────────────────────┬──────────────────────────────────┘
                  chunk + embed │  chunkText → embedder.embed
  ┌─ STORE layer (the data model) ─────────▼─────────────────────┐
  │  VectorChunk { id, vector: number[], meta }   ← ★ THIS ★     │ ← we are here
  │  rows held in a Map<id, VectorChunk>  (in-memory-vector-store)│
  └───────────────────────────┬──────────────────────────────────┘
                  search(qvec,k)│  cosine rank → top-k
  ┌─ Read layer ───────────────▼─────────────────────────────────┐
  │  VectorHit { id, score, meta }  →  citation for the agent     │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: the model is two row types and a store contract. A **write row** (`VectorChunk`: id + vector + meta) and a **read row** (`VectorHit`: id + score + meta). The store is `Map<id, VectorChunk>` ranked by cosine similarity. The question this concept answers: *how do you model a searchable corpus so the in-memory version and the Postgres version are the same shape, and so a citation can always be reconstructed from a hit?*

The three modeling choices worth defending: the **row shape** `(id, vector, meta)`, the **deterministic chunk id** `"<docId>#<index>"`, and the **dimension-as-invariant** that fails loudly on mismatch. Take them in that order.

## The structure pass

Layers are already named in the zoom-out (Source → Store → Read). Trace one axis across them: **what enforces correctness at this boundary?** That's the axis that makes the seams pop, because the answer flips hard between the two boundaries.

```
  One axis — "what enforces correctness here?" — traced down

  ┌ Source → Store seam ────────────────────────────────────────┐
  │  enforced by: dimension check, AT WRITE TIME, throws         │ ← HARD
  │  assertDimension (in-memory-vector-store.ts:36-42)           │   (synchronous)
  └─────────────────────────────┬────────────────────────────────┘
                                │
  ┌ docId linkage (chunk → doc) ▼───────────────────────────────┐
  │  enforced by: NOTHING — meta.docId is a soft string label    │ ← NONE
  │  no FK, no referential integrity (pipeline.ts:44)            │   (convention only)
  └─────────────────────────────┬────────────────────────────────┘
                                │
  ┌ Store → Read seam ──────────▼───────────────────────────────┐
  │  enforced by: dimension check again on the query vector      │ ← HARD
  │  assertDimension (in-memory-vector-store.ts:26)              │   (synchronous)
  └───────────────────────────────────────────────────────────────┘
```

Two seams, two opposite answers — and that contrast is the lesson. The **dimension boundary** is the first synchronous, write-time `CHECK` constraint anywhere in AptKit: violate it and `upsert`/`search` *throw immediately*, before any bad row lands. Compare that to `packages/evals` (file `05`), which only fires when you run it. The **docId linkage** is the opposite extreme: a foreign key with zero enforcement — `meta.docId` is just a string nobody validates. A chunk can claim `docId: "guide"` for a document that was never indexed and nothing complains. The whole file hangs on this asymmetry: one invariant the store *guarantees*, one it merely *hopes for*.

## How it works

#### Move 1 — the mental model: a keyed row with a ranked read

You already know a SQL table: rows keyed by a primary key, queried by a predicate, returned in some order. A vector store is that, with one twist — the "query" isn't a `WHERE` predicate, it's a *distance computation*, and the "order" is by similarity score. The row is `(id, vector, meta)`; the query is "give me the `k` rows whose vector is closest to this one."

```
  The vector-store row model — write shape vs read shape

  WRITE row  (what you upsert)        READ row  (what search returns)
  ┌──────────────────────────┐        ┌──────────────────────────┐
  │ id     : "guide#0"        │        │ id    : "guide#0"         │
  │ vector : [0.01, …768…]    │ ─────► │ score : 0.83  ◄─ added    │
  │ meta   : { docId, text…}  │  rank  │ meta  : { docId, text…}   │
  └──────────────────────────┘        └──────────────────────────┘
        VectorChunk                          VectorHit
        (contracts.ts:8-12)                  (contracts.ts:15-19)

  the only difference: read drops `vector`, adds `score`.
  meta rides through unchanged → citation survives the round-trip.
```

The key insight: `VectorHit` is `VectorChunk` minus the raw vector, plus a score. The vector is write-only — you never read it back, you only rank against it. But `meta` rides through untouched, and that's deliberate: it's what lets the read layer rebuild a citation (`[docId] snippet…`) from a hit alone, with no second lookup into the source documents.

#### Move 2 — the three modeling choices, one at a time

**Part 1 — the row shape: `(id, vector, meta)` with meta as an open bag.**

You know how a Postgres row has typed columns but a `JSONB` column lets you stash arbitrary structure? `VectorChunk` is exactly that split: two typed columns (`id: string`, `vector: number[]`) and one open `meta: Record<string, unknown>`. The store treats `meta` as opaque — it never reads inside it, just carries it from write to read.

```
  Row shape — two typed columns + one open payload

  VectorChunk
  ┌──────────┬──────────────────┬────────────────────────────────┐
  │ id (PK)  │ vector (the      │ meta (JSONB-style open bag)    │
  │ string   │  index column)   │ { docId, chunkIndex, text, …}  │
  └──────────┴──────────────────┴────────────────────────────────┘
       │            │                        │
   keyed in     ranked by              carried opaque →
   the Map      cosine sim             rebuilds the citation
```

Why model it open instead of a fixed schema? Because the store must stay vendor- and corpus-neutral. The retrieval *pipeline* decides what goes in `meta` (it writes `docId`, `chunkIndex`, `text`); the *store* must not care. That's what keeps `InMemoryVectorStore` swappable for a `PgVectorStore` behind the same `VectorStore` contract (`contracts.ts:33-37`) — neither one knows what a `docId` is. Break this and you'd have to teach the store about documents, which couples the index to one corpus shape. Boundary condition: because `meta` is `unknown`-typed, every read of it needs a runtime type-guard — which is exactly what `toResult` does (`typeof hit.meta.docId === 'string' ? … : hit.id`). The openness costs you compile-time safety on `meta`, paid back as portability.

**Part 2 — the deterministic chunk id: `"<docId>#<index>"`.**

You know how a composite primary key `(order_id, line_no)` makes a row addressable and idempotent to re-insert? The chunk id is a *string-encoded* composite key. `indexDocument` builds it as `` `${doc.id}#${i}` `` (`pipeline.ts:44`) — the document id, a `#`, and the chunk's ordinal within that document.

```
  Deterministic id — composite key encoded as a string

  doc.id = "guide",  chunks = [c0, c1, c2]

  "guide#0"   "guide#1"   "guide#2"
      │            │            │
      └─ docId ──┐ └─ docId ──┐ └─ docId
                 #index        #index

  re-index the SAME doc → SAME ids → upsert REPLACES, never duplicates
  (in-memory-vector-store.ts:21 — Map.set on a colliding key overwrites)
```

This buys idempotent re-indexing: run `indexDocument` on the same document twice and you get the same three ids, so the second `upsert` overwrites the first instead of doubling the corpus. The store proves this — the test `upsert replaces an existing id rather than duplicating it` (`in-memory-vector-store.test.ts:37-44`) is the contract. Without deterministic ids (say you used a UUID per chunk), re-indexing an edited document would leave the stale chunks orphaned in the store forever, and your search would return both the old and new text. The `#index` suffix is the load-bearing part: drop it and every chunk of a doc collides on `docId`, so only the last chunk survives. Boundary condition: the id is only stable if `chunkText` is deterministic — which is exactly why the chunker is fixed-size-by-character and not token- or model-dependent (`chunker.ts:1-12`). The two choices are coupled: deterministic chunking is what makes the composite id stable.

**Part 3 — the soft docId linkage: a foreign key with no enforcement.**

Here's the choice an interviewer will push on. In a relational model, `chunks.doc_id` would be a foreign key to `documents.id` — the database refuses a chunk whose document doesn't exist, and a cascade delete removes a document's chunks with it. AptKit has the *linkage* (`meta.docId`, written at `pipeline.ts:44`, read at `search-knowledge-base-tool.ts:109`) but **none of the enforcement**.

```
  docId linkage — the shape of an FK, none of the guarantees

  ┌─ documents (implicit — never stored!) ─┐
  │  there is NO documents table           │
  └────────────────────────────────────────┘
              ▲  meta.docId points "up" at…
              │  …nothing. it's a dangling label.
  ┌─ chunks (the only real rows) ──────────┐
  │  "guide#0" → meta.docId = "guide"      │
  │  "ghost#0" → meta.docId = "ghost" ✗    │ ← no doc named "ghost" need exist
  └────────────────────────────────────────┘

  no referential integrity · no cascade delete · no orphan check
```

What this means concretely: there is no `documents` table at all — the source `RetrievalDocument` is consumed by `indexDocument` and thrown away; only chunks persist. So `meta.docId` is a label *describing* a document that the store never knew about. Nothing stops two different source docs from sharing a `docId`, and nothing cleans up a document's chunks when it's "deleted" (there's no delete — you'd re-index or drop the whole store). This is the right call for an in-memory from-scratch pipeline: referential integrity needs a second table and a constraint engine, and an in-memory `Map` has neither. But name it honestly in an interview — it's a soft link, and the day this graduates to pgvector, `chunks.doc_id REFERENCES documents(id) ON DELETE CASCADE` is the first constraint you'd add.

**Part 4 — dimension as the one hard invariant.**

Every other invariant in AptKit is enforced after the fact by evals. This one fires *at write time, synchronously, with a throw*. The store carries its own `dimension` (`in-memory-vector-store.ts:11`) and rejects any vector whose length doesn't match — on `upsert` and on `search` (`assertDimension`, lines 36-42).

```
  Dimension check — the synchronous CHECK constraint

  upsert(chunk)           search(qvec)
      │                       │
      ▼                       ▼
  len(vector) == dimension?   len(qvec) == dimension?
      │ no                        │ no
      ▼                           ▼
   THROW "dimension mismatch"  THROW "dimension mismatch"
      │ yes                       │ yes
      ▼                           ▼
   Map.set(id, chunk)         rank all rows by cosine, slice k
```

Why is this load-bearing enough to throw rather than warn? Because a dimension mismatch is the silent-corruption case. Cosine similarity over two vectors of different lengths either crashes on an index out of bounds or — worse — computes a garbage score over the overlapping prefix and *ranks on nonsense*. A wrong score doesn't look wrong; it just returns the wrong chunk with a plausible number. So the store makes it impossible: a mismatched vector never enters the corpus, and a mismatched query never runs. This is the "one-way door" the contracts comment names (`contracts.ts:28-32`): a corpus embedded at 768 dimensions (nomic, `ollama-embedding-provider.ts:40`) can *only* be searched by a 768-dim query forever. Re-dimensioning means re-indexing the whole corpus from source. The pipeline guards the same door one level up — `assertWiring` throws if the embedder's dimension and the store's disagree, at wiring time (`pipeline.ts:22-29`), so you can't even construct a misconfigured pipeline.

#### Move 3 — the principle

Model the row so the cheap version and the expensive version are the *same shape*. `VectorChunk` is `(id, vector, meta)` precisely because that's a pgvector row, a Pinecone vector, a Qdrant point. The in-memory `Map` is a stand-in you can rip out without touching the pipeline, the tool, or the row shape. And enforce the invariant that *can't* be checked later (dimension) at write time with a throw, while accepting the invariant you *can* live without (referential integrity) as a soft convention. Knowing which invariants must be hard and which can be soft is the whole data-modeling judgment call.

## Primary diagram

The full corpus model, from source document to cited hit, every layer and enforcement point labelled.

```
  The vector-store row model — full pipeline, integrity points marked

  ┌─ Source ────────────────────────────────────────────────────────────┐
  │  RetrievalDocument { id:"guide", text:"…", meta? }                    │
  └───────────────────────────────┬──────────────────────────────────────┘
            chunkText (det.)       │   embedder.embed (768-dim, nomic)
                                   ▼
  ┌─ Write rows: VectorChunk[] ───────────────────────────────────────────┐
  │  id:"guide#0"  vector:[…768…]  meta:{docId:"guide", chunkIndex:0, text}│
  │  id:"guide#1"  vector:[…768…]  meta:{docId:"guide", chunkIndex:1, text}│
  │       ▲ composite key            ▲ soft FK (no enforcement)            │
  └───────────────────────────────┬──────────────────────────────────────┘
        upsert → assertDimension ✓ │  ◄═══ HARD CHECK (throws on mismatch)
                                   ▼
  ┌─ STORE: Map<id, VectorChunk> + dimension ─────────────────────────────┐
  │  Map.set(id, chunk)  → re-index same id REPLACES (idempotent)          │
  └───────────────────────────────┬──────────────────────────────────────┘
        search(qvec,k) → assertDim │  ◄═══ HARD CHECK on query vector
                                   ▼  cosineSimilarity → sort desc → slice k
  ┌─ Read rows: VectorHit[] ──────────────────────────────────────────────┐
  │  { id:"guide#0", score:0.83, meta:{docId, text} }                     │
  └───────────────────────────────┬──────────────────────────────────────┘
        toResult: type-guard meta  │  citation = "[guide] snippet…"
                                   ▼
  ┌─ Agent (search_knowledge_base tool) ──────────────────────────────────┐
  │  grounded answer with [docId] citations                               │
  └───────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** This row model is reached for in exactly one place today: the `search_knowledge_base` tool (`packages/retrieval/src/search-knowledge-base-tool.ts`), which an agent calls to ground an answer in indexed documents. The flow: a host indexes documents (`createRetrievalPipeline(...).index(doc)`), the agent calls the tool with a query, the tool runs the query path (`pipeline.query`), and turns each `VectorHit` into a cited result. The in-memory store is the "zero cloud" adapter — you build and test the whole RAG loop with no Ollama and no Postgres (the tests use a fake embedder, `pipeline.test.ts:18-34`).

**The row contracts — `packages/retrieval/src/contracts.ts:7-19`.**

```
  contracts.ts  (lines 7-19)

  export type VectorChunk = {           ← the WRITE row
    id: string;                         ← composite key "<docId>#<index>"
    vector: number[];                   ← the index column (write-only)
    meta: Record<string, unknown>;      ← open bag — store never reads inside
  };
  export type VectorHit = {             ← the READ row
    id: string;                         ← same key, links hit back to chunk
    score: number;                      ← cosine sim, added by search
    meta: Record<string, unknown>;      ← rides through → rebuilds citation
  };
       │
       └─ VectorHit = VectorChunk − vector + score. The vector is never
          read back; meta is what survives the round-trip and carries the
          citation. Drop meta from the hit and search_knowledge_base could
          not cite a source without a second lookup.
```

**The composite key + soft FK, written at index time — `packages/retrieval/src/pipeline.ts:41-46`.**

```
  pipeline.ts  (lines 41-46, inside indexDocument)

  const chunks = texts.map((text, i) => ({
    id: `${doc.id}#${i}`,                    ← deterministic composite key
    vector: vectors[i]!,                     ← the embedding for this chunk
    meta: { ...(doc.meta ?? {}),             ← caller's meta, spread first
            docId: doc.id,                   ← soft FK (no documents table)
            chunkIndex: i,                   ← ordinal within the doc
            text },                          ← reconstructed for citation
  }));
       │
       └─ docId + chunkIndex + text are injected HERE, by the pipeline, not
          the store. The store stays corpus-neutral. `text` is copied into
          meta so a hit can be cited without re-reading the source doc —
          a deliberate denormalization (see audit Lens 2).
```

**The hard dimension invariant — `packages/retrieval/src/in-memory-vector-store.ts:36-42`.**

```
  in-memory-vector-store.ts  (lines 36-42)

  private assertDimension(vector: number[], label: string): void {
    if (vector.length !== this.dimension) {        ← the CHECK constraint
      throw new Error(                             ← fail LOUDLY, write-time
        `dimension mismatch: ${label} has length ` +
        `${vector.length}, store expects ${this.dimension}`,
      );
    }
  }
       │
       └─ called on every upsert (line 21) AND every search (line 26). This
          is the only synchronous, write-time invariant in the whole repo.
          Remove it and a 64-dim query against a 768-dim corpus computes a
          garbage cosine score over the first 64 components and ranks on it —
          wrong chunk, plausible number, silent corruption.
```

**The citation rebuild from a hit — `packages/retrieval/src/search-knowledge-base-tool.ts:108-118`.**

```
  search-knowledge-base-tool.ts  (lines 108-118, toResult)

  const docId = typeof hit.meta.docId === 'string' ? hit.meta.docId : hit.id;
  const text  = typeof hit.meta.text  === 'string' ? hit.meta.text  : '';
       │
       └─ meta is Record<string, unknown>, so every field needs a runtime
          type-guard — the price of the open-bag row shape. Falls back to
          hit.id when docId is absent, so a chunk indexed without the
          pipeline (no docId in meta) still produces a citation.

  citation: snippet ? `[${docId}] ${snippet}` : `[${docId}]`
       │
       └─ the citation is built ENTIRELY from the hit's meta — no lookup into
          a source-document store, because there isn't one. This is why text
          had to be denormalized into meta at index time.
```

## Elaborate

The `(id, vector, metadata)` triple is the lingua franca of dense retrieval. pgvector stores it as a table with a `vector` column and a `JSONB` metadata column; Pinecone calls it a "vector" with an id and a metadata object; Qdrant calls it a "point" with a payload. AptKit's `VectorChunk` is deliberately that same triple so the in-memory store is a faithful stand-in — the lesson is that the *row shape* is portable even when the *engine* (brute-force cosine over a `Map`) is a toy.

The toy part is honest and worth naming: `InMemoryVectorStore.search` is an O(n) linear scan — it computes cosine similarity against *every* chunk and sorts (`in-memory-vector-store.ts:25-33`). There's no ANN index (no HNSW, no IVF), so it doesn't scale past a few thousand chunks. That's the seam to `study-system-design`: *when* to move to pgvector/an ANN index is an architecture call; the row shape you carry across that move is this data-modeling file. The good news is the shape doesn't change — that's what the contract bought you.

Two adjacent concepts to read next: file `02` (the tagged-union event log) for the other "self-describing rows on a wire" pattern, and file `05` (structural-diff integrity) for the *contrast* — evals enforce invariants asynchronously when run; the dimension check enforces its one invariant synchronously at write time. That contrast is the most useful thing this file adds to the guide.

One note on scope: a **persistent** corpus — documents/chunks tables in Postgres, keyed by app, with real FKs and cascade deletes — exists in a *separate* repo (buffr), not AptKit. AptKit models only the in-memory chunk/vector shape. Don't conflate them in an interview: here, the corpus is an in-memory `Map` with a soft docId label and no `documents` table.

## Interview defense

**Q: Walk me through your vector store's data model.** Three rows and a contract. The write row is `VectorChunk` — `(id, vector, meta)`: a string id, the embedding, and an open metadata bag. The read row is `VectorHit` — the same id, a cosine score, and the meta carried through; it's the write row minus the raw vector plus a score. The store is a `Map<id, VectorChunk>` behind a `VectorStore` contract with `upsert` and `search`. The shape is deliberately the pgvector/Pinecone triple so the in-memory version ports to Postgres unchanged.

```
  VectorChunk (write)  ──upsert──►  Map<id,chunk>  ──search──►  VectorHit (read)
   id · vector · meta                ranked cosine               id · score · meta
```

Anchor: *"It's the `(id, vector, metadata)` triple — same row shape pgvector uses, in-memory for now."*

**Q: You wrote `meta.docId` but there's no foreign key. Isn't that a bug?** No — it's a deliberate soft link. There's no `documents` table at all; the source document is consumed at index time and only chunks persist, so `docId` is a label describing a document the store never owned. An in-memory `Map` has no constraint engine to enforce referential integrity. I get the linkage (group a doc's chunks, build a citation) without the cost (a second table, a constraint engine). The day it moves to pgvector, `chunks.doc_id REFERENCES documents(id) ON DELETE CASCADE` is the first constraint I'd add.

```
  meta.docId ──► (no documents table)   shape of an FK, none of the guarantees
  chunks are the only real rows · no cascade · no orphan check
```

Anchor: *"It's a foreign key's shape with none of its enforcement — correct for in-memory, the first thing to harden in Postgres."*

**Q: Why does the store throw on a dimension mismatch instead of handling it?** Because a dimension mismatch is the silent-corruption case. Cosine over mismatched lengths either crashes or — worse — scores on the overlapping prefix and ranks on garbage: wrong chunk, plausible number, no error. So the store makes it impossible: rejected at `upsert` *and* at `search`, write-time, with a throw. It's the only synchronous write-time invariant in the repo. The dimension is a one-way door — a 768-dim corpus can only ever be searched by a 768-dim query; re-dimensioning means re-indexing from source.

```
  upsert / search → len == dimension?  no → THROW   yes → proceed
  768-dim corpus  ←only→  768-dim query   (one-way door)
```

Anchor: *"Dimension is the one invariant you can't recover from after the fact, so it's the one I enforce at write time with a throw."*

## Validate

**Reconstruct.** From memory, write the two row types. `VectorChunk = { id: string; vector: number[]; meta: Record<string, unknown> }`; `VectorHit = { id: string; score: number; meta: Record<string, unknown> }`. State the relationship in one line: hit = chunk minus vector plus score, meta unchanged. (`contracts.ts:7-19`.)

**Explain.** Why is `meta` typed `Record<string, unknown>` rather than a fixed shape, and what does that cost the read side? (Store stays corpus-neutral and swappable; cost is a runtime type-guard on every meta read — `search-knowledge-base-tool.ts:109-110`.)

**Apply to a scenario.** A document `"guide"` is indexed, then edited and re-indexed. How many chunks for `"guide"` end up in the store, and why? (Same count or fewer if it shrank — the deterministic ids `"guide#0"`, `"guide#1"`, … collide and `Map.set` overwrites; `in-memory-vector-store.ts:21`, proven by the replace test at `in-memory-vector-store.test.ts:37-44`. Caveat: if the edited doc has *fewer* chunks, the trailing old ids are orphaned — a real edge the soft model doesn't clean up.)

**Defend the decision.** An interviewer says "you should have used a UUID per chunk so ids never collide." Defend the composite `"<docId>#<index>"` choice instead. (Deterministic ids make re-indexing idempotent — the second upsert replaces rather than duplicates. UUIDs would leave stale chunks orphaned on every edit, and search would return both old and new text. The collision is the *feature*. `pipeline.ts:44`.)

## See also

- `01-type-as-schema.md` — the type-as-schema pattern; `VectorChunk`/`VectorHit` are the store-shaped members of that family.
- `02-tagged-union-event-log.md` — the other "self-describing rows on a wire" model; the `capabilityId`-repeated-per-event denormalization is the same shape as `docId`-per-chunk here.
- `05-structural-diff-integrity.md` — the contrast partner: evals enforce invariants asynchronously when run; the dimension check enforces its one invariant synchronously at write time.
- `audit.md` — Lens 2 (the `text`-into-meta denormalization), Lens 3 (the similarity-search query path), Lens 4 (the dimension `CHECK`), Lens 6 (in-memory store as a storage choice).
- `study-system-design` — *when* to graduate the in-memory store to pgvector + an ANN index (architecture); the row shape that survives the move is this file.
