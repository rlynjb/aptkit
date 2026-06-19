# Embeddings — turning text into points in space

**Industry names:** embeddings, vector representations, dense vectors, semantic
vectors · *Industry standard*

## Zoom out, then zoom in

Embeddings are the foundation the whole rest of this section stands on. Every
later concept — chunking, vector DBs, hybrid search, reranking, RAG — assumes
you can turn a piece of text into a vector and compare two vectors. AptKit does
not do this anywhere yet, so picture where it *would* sit: at the very front of
a retrieval layer feeding the prompt-context seam.

```
  Zoom out — where embeddings would live in AptKit

  ┌─ (new) Retrieval layer — packages/retrieval ─────────────────────┐
  │  ★ embed(text) → number[]  ←── THIS CONCEPT                       │
  │       │                                                          │
  │       ▼                                                          │
  │  store vector in an index  ──►  search by similarity at query    │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  top-k chunks (strings)
  ┌─ Context layer (packages/context) ▼────────────────────────────────┐
  │  schemaSummary() + retrieved-chunks block ──► system prompt         │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │
  ┌─ Runtime layer (packages/runtime) ▼────────────────────────────────┐
  │  runAgentLoop / generateStructured ──► ModelProvider.complete()     │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: an **embedding** is a function that maps text to a fixed-length list of
floats — say 1536 of them — such that texts with *similar meaning* land *close
together* in that high-dimensional space. You ran this in AdvntrCue: a chunk
went in, a 1536-dim vector came out, pgvector stored it, and a query vector
found its neighbours. The concept is "meaning becomes geometry." Distance is
similarity.

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

**Not yet implemented in AptKit.** There is no `embed()` function, no vector
type, and nothing imports an embedding model anywhere in the repo. The closest
*shape* is `schemaSummary()` in `packages/context/src/workspace-summary.ts` —
also a deterministic text transform — but it flattens structured workspace
metadata into a prompt string; it does not produce vectors or compare anything by
similarity. If embeddings were added, the `embed()` function would be the front
door of a new `packages/retrieval` package, and its output would feed an index
the context layer reads from before rendering the prompt.

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
present; IDs are by-phase convention. **Case B — embeddings are not implemented;
this exercise is the buildable first brick.***

### Exercise — an embed-and-compare primitive

- **Exercise ID:** `[B2A.1]` Phase 2A, embeddings concept
- **What to build:** A new `packages/retrieval` package exporting
  `embed(text: string): Promise<number[]>` (call OpenAI `text-embedding-3-small`
  behind the existing provider-key env pattern) and a pure
  `cosineSimilarity(a, b): number`. Add a tiny demo script that embeds three
  workspace event names from a `WorkspaceDescriptor` and prints their pairwise
  similarities.
- **Why it earns its place:** It introduces the missing primitive every other
  retrieval concept needs, while respecting AptKit's provider-neutral boundary
  (the embedder is an adapter, exactly like `ModelProvider`).
- **Files to touch:** `packages/retrieval/src/embed.ts`,
  `packages/retrieval/src/cosine.ts`, `packages/retrieval/test/cosine.test.ts`,
  `packages/retrieval/package.json`.
- **Done when:** A unit test proves `cosineSimilarity` returns ~1.0 for identical
  vectors, ~0.0 for orthogonal ones, and the demo prints higher similarity for
  two related event names than for an unrelated pair.
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
  `embed(text) → vector`, `cosine(a,b) = dot(â, b̂)`. No AptKit file to check —
  it doesn't exist yet; that's the point.
- **Explain:** Why can't you compare a 1536-dim vector from one model with a
  768-dim vector from another? (Different coordinate systems; the axes don't mean
  the same thing, and the dimensions don't even line up.)
- **Apply:** You embed the event name `product_viewed` and the customer property
  `last_purchase_category`. You expect them weakly related. Where would these
  strings come from in AptKit today? (`WorkspaceDescriptor.events[].name` and
  `WorkspaceDescriptor.customerProperties` —
  `packages/context/src/workspace-descriptor.ts:1-28`. Today they're flattened by
  `schemaSummary`, never embedded.)
- **Defend:** Why normalize before storing? (So query-time similarity is a single
  dot product instead of a divide-by-magnitudes every comparison — cheaper at
  scale, identical result.)

## See also

- [02-embedding-model-choice.md](02-embedding-model-choice.md) — which embedder, and why it's a one-way door
- [03-chunking-strategies.md](03-chunking-strategies.md) — what text you embed
- [04-vector-databases.md](04-vector-databases.md) — where the vectors live
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — embeddings vs term-matching
- [11-rag.md](11-rag.md) — the full pipeline these vectors feed
