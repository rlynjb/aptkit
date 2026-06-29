# Dense vs sparse retrieval

**Subtitle:** Retrieval modes · semantic vectors vs lexical term-matching · *Industry standard*

## Zoom out, then zoom in

There are two ways to find "the relevant chunks," and they fail in opposite places.
aptkit ships exactly one of them. Knowing which, and what the missing one would
catch, is the difference between "I use vector search" and "I chose dense over
sparse on purpose."

```
  Zoom out — two retrieval modes, aptkit ships one

  ┌─ Retrieval modes ───────────────────────────────────────────┐
  │  ★ DENSE: cosine over nomic embeddings ★   ← aptkit does this │ ← we are here
  │    SPARSE: BM25 / inverted index           ← not yet exercised│
  └───────────────────────────┬─────────────────────────────────┘
                              │ aptkit's path:
  ┌─ in-memory-vector-store.ts ▼────────────────────────────────┐
  │  cosineSimilarity(query_vec, chunk_vec), sort desc, top-k    │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You have written both kinds of search without naming them. A
`.filter(row => row.text.includes(term))` is sparse retrieval — exact lexical
match. A "find me things *like* this" recommendation is dense — semantic
similarity. Dense search reads *meaning*; sparse search reads *the exact words*.
aptkit is dense-only: cosine over nomic vectors, no BM25, no inverted index, no
keyword path. That is the right default and also a real gap.

## Structure pass

**Layers.** Mode (dense / sparse) → mechanism (cosine over vectors / term-frequency
over an inverted index) → aptkit's reality (only the dense mechanism exists,
`in-memory-vector-store.ts:25`).

**Axis — failure.** Trace *how each mode is wrong*. Dense fails on exact tokens it
never learned — a CVE id, an error code, a rare code symbol embed to nothing
meaningful, so cosine ranks them by surrounding fluff. Sparse fails on paraphrase —
"reset password" never matches "recover login" because no term overlaps. The axis
"what does this miss?" flips between them: dense misses exact rare terms, sparse
misses synonyms.

**Seam.** There is no seam in aptkit — there is only the dense path. The *would-be*
seam is the search tool (`search-knowledge-base-tool.ts`): a sparse path would have
to merge into it alongside the existing `pipeline.query`. Today nothing does;
sparse retrieval is `not yet exercised`.

## How it works

### Move 1 — the mental model

You know two array operations. `arr.filter(x => x.includes("CVE-2024-1234"))` —
that is sparse: it matches the literal token, finds nothing if the token isn't
present, and doesn't care about meaning. A nearest-neighbor lookup — "things close
to this point" — is dense: it finds semantic neighbors and doesn't care about exact
words. Real retrieval needs both because users do both: they paraphrase *and* they
paste exact identifiers.

```
  Two matchers, opposite blind spots

  query: "fix CVE-2024-1234 auth bypass"
  ┌─ DENSE (cosine) ──────────────┐   ┌─ SPARSE (BM25) ───────────────┐
  │ matches "authentication       │   │ matches the EXACT token        │
  │ vulnerability" by meaning     │   │ "CVE-2024-1234" verbatim       │
  │ MISSES the rare id (no signal)│   │ MISSES paraphrase "auth bypass"│
  └────────────────────────────────┘   └────────────────────────────────┘
```

### Move 2 — what aptkit does, and where sparse would slot

**Dense, the only path that exists.** aptkit's retrieval is cosine over nomic
vectors, end to end (`in-memory-vector-store.ts:25`):

```ts
async search(vector: number[], k: number): Promise<VectorHit[]> {
  this.assertDimension(vector, 'query vector');
  const hits: VectorHit[] = [];
  for (const chunk of this.chunks.values()) {
    hits.push({ id: chunk.id, score: cosineSimilarity(vector, chunk.vector), meta: chunk.meta });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, Math.max(0, k));
}
```

There is no term index anywhere in the repo — no BM25, no `tf-idf`, no inverted
list. Every query is a vector, every match is an angle.

```
  aptkit's only retrieval mode — DENSE

  query ─► embed (768) ─► cosineSimilarity over every chunk ─► sort ─► top-k
   no keyword path · no inverted index · paraphrase-friendly, token-blind
```

**Where sparse would win, and where it would slot.** Sparse retrieval (BM25 over an
inverted index) earns its place on *exact, rare tokens* — CVE ids, error codes,
exact function/symbol names, version strings — where the dense vector carries almost
no signal. The natural insertion point is the search tool: run a BM25 index in
parallel with `pipeline.query`, then merge (the hybrid story,
`06-hybrid-retrieval-rrf.md`).

```
  Where a sparse path WOULD slot (not yet exercised — PSEUDOCODE)

  search_knowledge_base(query):
      dense  = pipeline.query(query, k)          # exists today
      sparse = bm25Index.search(query, k)        # NOT built
      return fuse(dense, sparse)                 # NOT built (see RRF)
   the seam is search-knowledge-base-tool.ts — today only the dense line runs
```

**The honest gap.** A user pasting an exact code symbol or an error string into the
rag-query agent today gets *dense-only* results — the agent finds semantically
nearby chunks but can miss the chunk containing the literal token. That is the
concrete cost of dense-only, and the reason hybrid is the documented next step.

### Move 2.5 — current state vs future state

```
  Phase A (aptkit, now)             Phase B (hybrid — not yet exercised)
  ┌────────────────────────┐        ┌──────────────────────────────────┐
  │ DENSE only             │        │ DENSE + SPARSE                    │
  │ cosine over nomic       │  add   │ cosine + BM25, fused (RRF)        │
  │ great on paraphrase     │ sparse │ also nails CVE ids, code symbols  │
  │ weak on exact rare terms│        │ covers both blind spots           │
  └────────────────────────┘        └──────────────────────────────────┘
   the dense path is real; the sparse path is documented, not coded
```

### Move 3 — the principle

Dense and sparse are complementary failure modes, not competitors: one reads
meaning, the other reads exact terms, and each is blind where the other sees. Ship
dense first because semantic recall is the higher-value default for a prose corpus,
but *name the gap* — exact rare tokens — so you know precisely when sparse stops
being optional. aptkit earns dense-only because its corpus is prose, not a symbol
table; the day it indexes code or CVEs, sparse moves from `not yet exercised` to
required.

## Primary diagram

```
  Dense vs sparse — coverage map

                  reads MEANING            reads EXACT TERMS
  paraphrase   ┌──────────────┐         ┌──────────────────┐
  "recover     │ DENSE  ✓      │         │ SPARSE  ✗ (no     │
   login"      │ (aptkit)      │         │  term overlap)    │
               └──────────────┘         └──────────────────┘
  exact id     ┌──────────────┐         ┌──────────────────┐
  "CVE-2024-   │ DENSE  ✗ (no  │         │ SPARSE  ✓         │
   1234"       │  signal)      │         │ (not yet built)   │
               └──────────────┘         └──────────────────┘
   aptkit fills only the left column — hybrid would fill both
```

## Elaborate

The "always use hybrid" advice is overfit to large public benchmarks. At aptkit's
scale, over a prose knowledge base, dense alone clears the bar and adds zero
infrastructure — no inverted index to build, no second ranking to tune. The
engineering judgment is knowing the *trigger* for sparse: when the corpus starts
carrying exact tokens a 768-dim embedding can't represent (identifiers, error codes,
code). At that point sparse stops being a nice-to-have and becomes the only thing
that finds the literal match. Read `06-hybrid-retrieval-rrf.md` for how the two
rankings combine and `07-reranking.md` for the orthogonal "rank the candidates
better" axis.

## Project exercises

### Add a BM25 sparse index alongside the dense store
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** an in-memory inverted index (term → chunk ids with tf-idf/BM25
  scoring) populated during `indexDocument`, plus a `sparseSearch(query, k)` that
  returns ranked ids — no fusion yet, just the second path existing.
- **Why it earns its place:** building the sparse path turns "I know dense vs sparse"
  into "I implemented both," and sets up the hybrid exercise; it proves you can find
  the literal-token chunk dense search misses.
- **Files to touch:** a new `packages/retrieval/src/bm25-index.ts`,
  `packages/retrieval/src/pipeline.ts` (populate it on index), a new test in
  `packages/retrieval/test/`.
- **Done when:** a test query containing an exact rare token (e.g. a CVE id present
  in one chunk only) returns that chunk top-ranked from the sparse path while dense
  ranks it low.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "Is your retrieval dense or sparse, and why?"**
Dense only — cosine over nomic embeddings (`in-memory-vector-store.ts:25`), no BM25,
no inverted index. The corpus is prose, where semantic recall (paraphrase matching)
is the high-value default and dense adds zero infrastructure. The deliberate cost:
exact rare tokens — CVE ids, error codes, code symbols — embed to weak signal, so
dense can miss the chunk holding the literal match. That's the trigger to add sparse.

```
  dense: paraphrase ✓ / exact rare token ✗   ─► aptkit ships this
  sparse: exact rare token ✓ / paraphrase ✗  ─► add when corpus carries identifiers
```
Anchor: *dense reads meaning, sparse reads exact terms — I ship dense and name the gap.*

**Q: "When would dense-only fail and sparse save you?"**
When a user searches for a token the embedding can't represent: a version string, an
error code, an exact function name. Dense scores those chunks by their surrounding
prose, not the token, so the literal match can fall out of the top-k. Sparse matches
the token verbatim and surfaces it. That's why a code or security corpus forces
hybrid.

```
  query "TypeError at handleSubmit" ─► dense ranks by fluff ─► misses the exact line
                                       sparse matches "handleSubmit" ─► finds it
```
Anchor: *exact rare tokens are dense's blind spot and sparse's home turf.*

## See also

- `06-hybrid-retrieval-rrf.md` — fusing dense + sparse rankings (RRF)
- `01-embeddings.md` — why dense vectors miss rare exact tokens
- `04-vector-databases.md` — the dense store aptkit actually ships
- `07-reranking.md` — improving rank quality, orthogonal to dense/sparse
- `05-evals-and-observability/01-eval-set-types.md` — measuring recall per mode
