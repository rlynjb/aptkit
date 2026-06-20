# Embeddings — turning text into points in space

**Industry names:** embeddings, vector representations, dense vectors, semantic
vectors · *Industry standard*

## Zoom out, then zoom in

Embeddings are the foundation the whole rest of this section stands on. Every
later concept — chunking, vector DBs, hybrid search, reranking, RAG — assumes
you can turn a piece of text into a vector and compare two vectors. AptKit now
ships exactly this: `OllamaEmbeddingProvider` is the front door of the retrieval
layer, and `cosineSimilarity` inside `InMemoryVectorStore` is the comparison.

```
  Zoom out — where embeddings live in AptKit (packages/retrieval)

  ┌─ Retrieval layer — packages/retrieval (REAL) ────────────────────┐
  │  ★ OllamaEmbeddingProvider.embed(texts) → number[][] (768-dim)    │
  │       │                                  ←── THIS CONCEPT         │
  │       ▼                                                          │
  │  InMemoryVectorStore.upsert(vectors)  ──►  .search(q, k) via      │
  │                                            cosineSimilarity       │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  ranked chunks (id, score, meta)
  ┌─ Tool boundary (search_knowledge_base) ▼────────────────────────────┐
  │  pipeline.query() called as a tool mid-loop                         │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │
  ┌─ Runtime layer (packages/runtime) ▼────────────────────────────────┐
  │  runAgentLoop ──► ModelProvider.complete() (Gemma / Anthropic)      │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: an **embedding** is a function that maps text to a fixed-length list of
floats — here **768** of them (nomic-embed-text) — such that texts with *similar
meaning* land *close together* in that high-dimensional space. You ran the cloud
version in AdvntrCue: a chunk went in, a 1536-dim OpenAI vector came out, pgvector
stored it, a query vector found its neighbours. AptKit is the local-first mirror:
nomic instead of OpenAI, 768 instead of 1536, in-memory instead of pgvector. The
concept is identical — "meaning becomes geometry." Distance is similarity.

## Structure pass

**Layers.** Two: the *model* layer (an embedding model turns text into a vector
— a one-shot transform, no loop) and the *space* layer (all your vectors live in
one shared coordinate system where distance has meaning).

**Axis — what does "close" mean?** Trace the single question *how do we decide
two things are similar?* down the stack. At the text layer, "similar" is fuzzy
and human ("these mean roughly the same"). At the vector layer, "similar" is a
hard number: the cosine of the angle between two vectors. The embedding model is
the thing that converts the first into the second.

**Seam.** The load-bearing seam is the embedding function boundary: text on one
side, vectors on the other. It flips the *comparison axis* from "needs a human or
an LLM to judge" to "a `for` loop can compute it." Everything downstream —
indexes, ANN, RRF — only works because comparison became arithmetic at this seam.

## How it works

You already compare strings with `===` (exact) or `includes()` (substring).
Embeddings give you a third comparison: *by meaning*. "How do I cancel my plan"
and "stop my subscription" share no words — `includes()` finds nothing — but
their vectors sit close, so cosine similarity scores them high.

### Move 1 — the mental model

The shape: text goes through a model once and comes out as a point. Two points
that mean similar things are near each other; you measure nearness by the angle
between them.

```
  Embeddings — meaning becomes a point in space

      "cancel my plan"  ──embed──►  v1 = [0.21, -0.04, ... ]  ●
      "stop subscription" ─embed─►  v2 = [0.19, -0.06, ... ]  ● ← small angle
      "blue running shoes" ─embed► v3 = [-0.8, 0.5, ...   ]      ● ← large angle

              v1 ●  small angle  ● v2     →  cosine ≈ 0.95 (similar)
                  \            /
                   \          /
                    \  big   /
                     \ angle/
                      ●  v3              →  cosine ≈ 0.10 (different)

  similarity = cosine of the angle, NOT distance walked between them
```

The brain to hold: it's the *angle*, not raw distance, that matters most for
text. Two vectors pointing the same direction are similar even if one is longer.

### Move 2 — the step-by-step walkthrough

**Step 1 — tokenize and feed the model.** The embedding model takes your raw
text and produces one vector. This is a single forward pass, no generation, no
loop. Same text in always gives the same vector out (deterministic per model
version).

```
  Step 1 — the embed transform (one hop, no loop)

  ┌─ caller ─────┐  text: "stop my subscription"  ┌─ embed model ─┐
  │  your code   │ ─────────────────────────────► │ (forward pass)│
  │              │ ◄───────────────────────────── │               │
  └──────────────┘  vector: [0.19, -0.06, ...]    └───────────────┘
                    length = the model's dim (e.g. 1536), fixed
```

The boundary that bites: the dimension is fixed *per model*. A 1536-dim vector
from one model cannot be compared to a 768-dim vector from another. Mixing
models silently produces garbage similarities.

**Step 2 — normalize (usually).** Most pipelines normalize each vector to unit
length. Once vectors are unit-length, cosine similarity equals the dot product —
one multiply-and-sum, fast and cheap. This is why you'll see "normalize then dot
product" everywhere; it's the same thing as cosine but quicker.

```
  Step 2 — cosine similarity via execution trace

  v1 = [0.6, 0.8]      (already unit length: 0.6² + 0.8² = 1)
  v2 = [0.8, 0.6]      (unit length too)

  dot(v1, v2) = 0.6·0.8 + 0.8·0.6
              = 0.48   + 0.48
              = 0.96            ← cosine similarity ≈ 0.96 → very similar

  v3 = [-0.8, 0.6]
  dot(v1, v3) = 0.6·(-0.8) + 0.8·0.6
              = -0.48 + 0.48 = 0.0   ← orthogonal → unrelated
```

The boundary: cosine ranges -1 (opposite) to 1 (identical direction). For text
embeddings you almost never see negatives in practice; the useful band is
roughly 0.2 (unrelated) to 0.95 (near-duplicate).

**Step 3 — store and search.** You embed every chunk once at index time and keep
the vectors. At query time you embed the query and find the nearest stored
vectors. With a handful of vectors you brute-force every comparison; with
millions you reach for an ANN index (the vector-DB file covers that).

```
  Step 3 — query-time nearest-neighbour (brute force)

  query "cancel plan" ─embed─► q = [...]
        │
        ▼   for each stored chunk vector cᵢ:
   score = dot(q, cᵢ)
        │
        ▼   sort descending, take top-k
   [ chunk_7 (0.91), chunk_2 (0.88), chunk_9 (0.74), ... ]
        │
        └──► these k chunks are what you stuff into the prompt
```

### Move 3 — the principle

An embedding is a lossy compression of meaning into a fixed-size vector, chosen
so that *geometric closeness approximates semantic closeness*. Once meaning is
geometry, "find me the relevant text" becomes "find the nearest points" — a
problem computers are extremely good at. That single conversion is what makes
all of retrieval possible.

## Primary diagram

The full path, index-time and query-time in one frame.

```
  Embeddings end to end — index time and query time

  INDEX TIME (once per chunk)            QUERY TIME (once per request)
  ┌──────────────────────┐               ┌──────────────────────┐
  │ chunk text           │               │ user query text      │
  └──────────┬───────────┘               └──────────┬───────────┘
             │ embed                                 │ embed
             ▼                                       ▼
  ┌──────────────────────┐               ┌──────────────────────┐
  │ vector cᵢ  (1536-dim) │               │ vector q   (1536-dim)│
  └──────────┬───────────┘               └──────────┬───────────┘
             │ store                                 │
             ▼                                       ▼
  ┌────────────────────────────────────────────────────────────┐
  │  vector index   ──► nearest-neighbour: max dot(q, cᵢ)        │
  │                 ──► top-k chunk ids ──► fetch chunk strings   │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼  the retrieved strings → prompt-context seam
```

## Implementation in codebase

**Use cases.** The `rag-query` agent embeds your knowledge-base documents at index
time and embeds each query at search time, so a question can find a semantically
related passage even when they share no words. Tests embed with an injected
transport (deterministic vectors, no live Ollama); the live demo embeds with real
nomic over Ollama.

**The embed transform**, `packages/retrieval/src/ollama-embedding-provider.ts:38-58`:

```
  packages/retrieval/src/ollama-embedding-provider.ts  (lines 38-58)

  export class OllamaEmbeddingProvider implements EmbeddingProvider {
    readonly id = 'nomic-embed-text';
    readonly dimension = 768;               ← fixed per model — the one-way door
    ...
    async embed(texts, options) {
      options?.signal?.throwIfAborted();    ← cancellation before any work
      return this.embedTransport({ model, texts, ... });  ← one batch call to Ollama
    }
  }
       │
       └─ embed() is the front door. `dimension = 768` is declared, not inferred,
          so a wiring that pairs this with a non-768 store fails loudly at
          construction (see pipeline.ts assertWiring), never silently corrupts ranking.
```

**The comparison**, `packages/retrieval/src/in-memory-vector-store.ts:46-57` — the
`cosineSimilarity` Move 2 described, in real code:

```
  packages/retrieval/src/in-memory-vector-store.ts  (lines 46-57)

  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot  += a[i]! * b[i]!;          ← dot product
    magA += a[i]! * a[i]!;          ← |a|²
    magB += b[i]! * b[i]!;          ← |b|²
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;   ← 0 for a zero vector → avoids NaN
       │
       └─ This store does NOT pre-normalize, so it divides by the magnitudes
          every comparison (the full cosine, not the dot-product shortcut). Fine
          at in-memory scale; a pgvector backend would normalize + index instead.
```

## Elaborate

Modern text embeddings come from transformer encoders (the lineage runs
sentence-transformers → OpenAI `text-embedding-3` → Cohere/Voyage, etc.). The
deep idea predates them: the *distributional hypothesis* — words that appear in
similar contexts have similar meanings — is what training on huge corpora
exploits. word2vec (2013) made it famous with "king − man + woman ≈ queen";
sentence embeddings extend the same trick from words to spans of text.

Why cosine and not Euclidean distance? Text-embedding magnitudes carry little
meaning (longer text isn't "more"), so the *direction* is the signal. Cosine
ignores magnitude by construction. This is also why normalization is standard —
it makes the cheap dot product equal the meaningful cosine.

Adjacent concepts: chunking ([03-chunking-strategies.md](03-chunking-strategies.md))
decides *what* you embed; model choice
([02-embedding-model-choice.md](02-embedding-model-choice.md)) decides *which*
embedder; dense-vs-sparse ([05-dense-vs-sparse.md](05-dense-vs-sparse.md))
contrasts embeddings with term-matching.

## Project exercises

*Provenance: Phase 2A — Retrieval foundations (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. **Case A — embeddings now ship
(`OllamaEmbeddingProvider` + `cosineSimilarity`); these exercises deepen them.***

### Exercise — a second embedding adapter (prove the seam holds)

- **Exercise ID:** `[B2A.1]` Phase 2A, embeddings concept
- **What to build:** A second `EmbeddingProvider` — e.g. an
  `OpenAIEmbeddingProvider` (`text-embedding-3-small`, 1536-dim) behind the
  existing provider-key env pattern — implementing the same
  `{ id, dimension, embed() }` contract as `OllamaEmbeddingProvider`. Wire it into
  a pipeline and confirm `assertWiring` rejects pairing a 1536-dim embedder with
  the 768-dim store.
- **Why it earns its place:** It proves the embedding *vendor* is an adapter
  exactly like `ModelProvider` — and it makes the dimension one-way-door concrete
  by triggering the mismatch throw on purpose.
- **Files to touch:** `packages/retrieval/src/openai-embedding-provider.ts`,
  `packages/retrieval/test/openai-embedding-provider.test.ts`.
- **Done when:** A test proves the new provider satisfies the contract (with an
  injected transport, no live API), and a second test proves
  `createRetrievalPipeline` throws the dimension-mismatch error when the embedder
  and store disagree.
- **Estimated effort:** `1–4hr`

### Exercise — normalize-once to earn the dot-product shortcut

- **Exercise ID:** `[B2A.2]` Phase 2A, embeddings (cosine optimization)
- **What to build:** Add an opt-in `normalize` to `InMemoryVectorStore` that
  unit-normalizes vectors at `upsert` and the query vector at `search`, then
  replaces the full cosine with a plain dot product (Move 2, Step 2). Keep the
  existing zero-vector guard.
- **Why it earns its place:** It's the textbook "normalize then dot" optimization
  against the repo's actual `cosineSimilarity`, and it forces you to prove the
  ranking is identical before and after.
- **Files to touch:** `packages/retrieval/src/in-memory-vector-store.ts`,
  `packages/retrieval/test/in-memory-vector-store.test.ts`.
- **Done when:** A test proves normalized-dot ranking matches full-cosine ranking
  on the same corpus, and a micro-benchmark shows fewer ops per comparison.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: What is an embedding, and how do you decide two pieces of text are
similar?**

```
  text ─embed─► vector ;  similar = small angle between vectors

      v1 ●───small angle───● v2   → cosine ≈ 0.95 (similar)
          \
           ●  v3              → cosine ≈ 0.10 (unrelated)
```

"An embedding maps text to a fixed-length vector so that semantically similar
text lands at a small angle. I measure similarity with cosine — the dot product
of unit-normalized vectors. It ranges -1 to 1; for text the useful band is about
0.2 to 0.95. The key constraint is that all vectors must come from the *same*
model and dimension, or the comparison is meaningless."
*Anchor: meaning becomes geometry; similarity is the cosine of an angle.*

**Q: Why cosine and not plain distance?**
"Text-embedding magnitude carries almost no signal — a longer chunk isn't 'more.'
The direction is the meaning. Cosine ignores magnitude; that's why pipelines
normalize to unit length and then use the dot product, which is the same number
but cheaper to compute."
*Anchor: direction is signal, magnitude is noise.*

## Validate

- **Reconstruct:** From memory, write the two-line embed-then-compare pipeline:
  `embed(text) → vector`, `cosine(a,b) = dot(a,b) / (|a||b|)`. Check against
  `in-memory-vector-store.ts:46-57`.
- **Explain:** Why can't you compare a 1536-dim vector from one model with a
  768-dim vector from another? (Different coordinate systems; the axes don't mean
  the same thing, the dimensions don't even line up. In AptKit this is enforced:
  `assertWiring` in `pipeline.ts:22-29` throws before any indexing if the
  embedder's `dimension` ≠ the store's.)
- **Apply:** You index a doc and query it; the top hit's `score` is 0.0 even
  though the doc clearly matches. What's the most likely bug? (A zero-magnitude
  vector — `cosineSimilarity` returns 0 for it by design to avoid NaN,
  `in-memory-vector-store.ts:56`. Check the embedder actually returned a vector,
  not `[]`.)
- **Defend:** AptKit's store does *not* normalize and divides by magnitudes every
  comparison. Why is that fine here, and what changes at scale? (At in-memory
  corpus sizes the divide is negligible; at pgvector scale you normalize once at
  index time and use an indexed dot product so search is sub-linear, not a full
  scan.)

## See also

- [02-embedding-model-choice.md](02-embedding-model-choice.md) — which embedder, and why it's a one-way door
- [03-chunking-strategies.md](03-chunking-strategies.md) — what text you embed
- [04-vector-databases.md](04-vector-databases.md) — where the vectors live
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — embeddings vs term-matching
- [11-rag.md](11-rag.md) — the full pipeline these vectors feed
