# Dense vs sparse retrieval
> Embeddings vs BM25 · Industry standard

Dense retrieval (what aptkit does) matches on *meaning* — "renew passport" finds "passport renewal portal" even with zero shared words. Sparse retrieval (BM25, what aptkit doesn't do yet) matches on *exact terms* — and it crushes dense the moment your query is a rare token: a CVE id, an error code, a function name, a SKU. These aren't competitors so much as two different failure modes pointed in opposite directions, and the strong systems run both. aptkit is **dense-only** today; sparse is `not yet exercised`, and adding it is the exercise.

## Zoom out, then zoom in

aptkit's retrieval has exactly one matching strategy — cosine over dense vectors. The sparse lane is a hole.

```
aptkit retrieval lanes
┌──────────────────────────────────────────────────────────┐
│  search_knowledge_base → pipeline.query → store.search      │
└───────────────┬────────────────────────────────────────────┘
                ▼
   ┌────────────────────────┐   ┌────────────────────────┐
   │ ★ DENSE (cosine) ★      │   │ SPARSE (BM25)           │
   │ EmbeddingProvider +     │   │  ✗ not yet exercised    │
   │ VectorStore             │   │  (no inverted index,    │
   │ matches MEANING         │   │   no term scorer)       │
   └────────────────────────┘   └────────────────────────┘
        the only lane                  the missing lane
```

aptkit committed fully to the dense lane — `cosineSimilarity` in `in-memory-vector-store.ts:46-57` is the entire matching logic. There's no inverted index, no term-frequency table, no BM25 scorer anywhere in `packages/retrieval/`. That's a deliberate scope choice for a from-scratch pipeline, but it means a query that's mostly an exact identifier is at the mercy of whether the embedding model happened to place that token usefully — which, for rare tokens, it usually didn't.

## Structure pass

Pick the **failure** axis: how does each lane fail, and on what kind of query?

```
where each lane fails
  query: "fix CVE-2021-44228 in our logger"
  ┌────────────────────────┬────────────────────────────────┐
  │ DENSE (cosine)          │ SPARSE (BM25)                   │
  ├────────────────────────┼────────────────────────────────┤
  │ "CVE-2021-44228" is a   │ exact-matches the token         │
  │ rare token → near-      │ "CVE-2021-44228" → top hit      │
  │ random vector → MISS    │ ✓                               │
  │                         │                                 │
  │ query: "how do I leave  │ "leave" / "quit" share no terms │
  │ a job gracefully"       │ with "resignation" → MISS       │
  │ → matches "resignation  │                                 │
  │   process" ✓            │                                 │
  └────────────────────────┴────────────────────────────────┘
   seam: rare/exact tokens flip the winner from dense to sparse
```

The seam is *token rarity*. Dense wins when the query and the answer say the same thing in different words (synonyms, paraphrase, intent). Sparse wins when the query *is* the exact string you need to find and meaning is irrelevant — identifiers, error codes, names. A dense-only system silently fails the second class, and the failure looks like "retrieval just didn't find it" with no signal why.

## How it works

**Move 1 — two scoring functions.** Both lanes rank chunks; they differ in what they score:

```
dense vs sparse scoring
  DENSE                              SPARSE (BM25)
  ┌──────────────────┐              ┌──────────────────────────┐
  │ embed query → vec │              │ tokenize query → terms    │
  │ cosine(q, chunk)  │              │ for each term:            │
  │ = semantic angle  │              │   tf in chunk × idf       │
  │                   │              │   (rare term = high idf)  │
  │ score ∈ [-1, 1]   │              │ sum, length-normalized    │
  └──────────────────┘              └──────────────────────────┘
   no notion of exact words          no notion of meaning
```

BM25 scores a chunk by how often the query's terms appear in it (**term frequency**), weighted by how rare each term is across the corpus (**inverse document frequency** — rare terms count more), with a saturation curve so a term appearing 50 times doesn't beat one appearing 5 times by 10x, plus a length penalty so long chunks don't win just by being long.

**What aptkit has — dense only.** The matching logic is one cosine function, no term math anywhere:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:46-57
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;                 // ← pure geometry; no token ever appears here
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;   // similarity, not a term match
}
```

There is no inverted index, no `tf`, no `idf` in the package. The query string never survives past `embed` — by the time the store sees it, it's a float array. That's the architectural fact that makes sparse a *new lane*, not a tweak.

**What sparse would add — a parallel contract.** `not yet exercised`. The clean shape mirrors `VectorStore`:

```
proposed SparseRetriever — parallel to VectorStore (DOES NOT EXIST YET)
┌──────────────────────────────────────────────┐
│ index(chunks: {id, text, meta}[]) → void       │  build inverted index
│ search(queryText: string, k) → VectorHit[]      │  BM25 score, top-k
└──────────────────────────────────────────────┘
   note: search takes TEXT (not a vector) — sparse never embeds
```

```ts
// SKETCH — what an aptkit BM25 retriever's core would look like (pseudocode)
function bm25Score(queryTerms, chunk, corpusStats, k1 = 1.5, b = 0.75) {
  let score = 0;
  for (const term of queryTerms) {
    const tf  = chunk.termFreq[term] ?? 0;            // term frequency in this chunk
    const idf = log((N - df[term] + 0.5) / (df[term] + 0.5) + 1); // rare term → big idf
    const norm = 1 - b + b * (chunk.len / avgChunkLen);          // length normalization
    score += idf * (tf * (k1 + 1)) / (tf + k1 * norm);           // saturation curve
  }
  return score;
}
```

The key contrast with dense: `search` takes the *raw query text*, tokenizes it, and looks terms up in an inverted index — it never calls `embed`. The two lanes share the `VectorHit` return shape (so fusion in file 06 can combine them) but nothing else.

**Move 3 — the principle.** Dense and sparse are complements, not rivals — they fail on disjoint query types. A dense-only system is blind to exact-match queries (and a sparse-only system is blind to paraphrase). The mature move isn't "pick the better one," it's "run both and fuse the rankings" — which is precisely why file 06 (hybrid + RRF) exists. aptkit is honest that it only has the dense lane today; the gap is named, not hidden, and the fix is bounded: add a parallel retriever behind its own contract, then fuse.

## Primary diagram

```
the two lanes, what each catches
  "passport renewal" ──► DENSE  ──► finds "renew your passport"  (synonyms)
                                     misses nothing here
  "CVE-2021-44228"   ──► DENSE  ──► near-random, MISS
                     ──► SPARSE ──► exact token hit, top result  ✓
  ─────────────────────────────────────────────────────────────
  aptkit today:  ████ DENSE ████   |   ░░░░ SPARSE (gap) ░░░░
  mature system: ████ DENSE ████   +   ████ SPARSE ████  → fuse (file 06)
```

aptkit owns the left lane; the right lane is the named gap, and combining them is hybrid retrieval.

## Elaborate

BM25 (Okapi BM25, 1994) is the probabilistic refinement of TF-IDF and is *still* the default in Elasticsearch/Lucene/OpenSearch thirty years on — it's a hard baseline that dense models took years to reliably beat. The frontier blurs the line: **SPLADE** and learned sparse models produce sparse vectors from a neural net (sparse lane, dense brains), and **ColBERT** does token-level late interaction (a third thing entirely). For aptkit's scope, a classic in-memory BM25 over the same chunks is the right first sparse lane. Read next: `06-hybrid-retrieval-rrf.md` (how to combine the two lanes) and `07-reranking.md` (the stage after fusion).

## Project exercises

### Add a BM25 sparse retriever behind a parallel contract

- **Exercise ID:** `EX-RAG-05a`
- **What to build:** A `SparseRetriever` contract + an `InMemoryBm25Retriever` implementing it: build an inverted index over the same chunks `indexDocument` produces, score queries with BM25, return `VectorHit[]` so it's fusion-ready.
- **Why it earns its place:** This is the missing lane. It's the prerequisite for hybrid retrieval (file 06) and the thing that fixes aptkit's silent exact-match blindness. Case B — the retriever doesn't exist, so building it is the target. Phase 2B.
- **Files to touch:** new `packages/retrieval/src/sparse-retriever.ts` (contract) and `packages/retrieval/src/bm25-retriever.ts` (impl); export from `packages/retrieval/src/index.ts`; feed it the same chunks as `indexDocument` (`packages/retrieval/src/pipeline.ts:32-47`).
- **Done when:** a query that's a rare exact token (e.g. an id) retrieves the right chunk via BM25 where the dense store misses it, proven by a side-by-side test.
- **Estimated effort:** `1–2 days`

### Build the dense-vs-sparse failure-case fixture

- **Exercise ID:** `EX-RAG-05b`
- **What to build:** A small fixture corpus + query set where dense wins some queries (paraphrase) and the (future) sparse lane wins others (exact identifiers), with the current dense-only misses documented.
- **Why it earns its place:** You can't justify adding sparse without queries that *prove* dense fails them. This fixture is the evidence and the regression net for `EX-RAG-05a`.
- **Files to touch:** test fixtures alongside `packages/retrieval/src/in-memory-vector-store.ts`.
- **Done when:** the fixture shows ≥2 queries the dense store provably misses that an exact-term matcher would catch.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Your RAG misses queries that are mostly an error code or function name. Why, and what fixes it?**

```
"CVE-2021-44228" → embed → near-random vector → cosine misses
   dense ranks by MEANING; a rare identifier has no useful semantic neighborhood
   fix: sparse (BM25) lane that matches the exact token
```

Anchor: dense retrieval is blind to rare exact tokens because they have no semantic neighborhood — BM25's exact-term matching is the complement, not a replacement.

**Q: If sparse is so good at exact matches, why not just use BM25 everywhere?**

```
"how do I leave a job" → BM25 → no shared terms with "resignation" → MISS
   sparse is blind to synonyms/paraphrase; dense catches intent
```

Anchor: each lane is blind to the other's strength — dense to exact tokens, sparse to paraphrase — so the answer is fusion, not a single winner.

## See also

- [01-embeddings.md](01-embeddings.md) — the dense lane's representation
- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — fusing dense + sparse
- [07-reranking.md](07-reranking.md) — refining the fused list
