# Embeddings — text → vector

**Subtitle:** Embeddings · text mapped to a fixed-length numeric vector · *Industry standard*

## Zoom out, then zoom in

The embedder is the front door of retrieval. Every piece of text — a corpus chunk
on the way in, a question on the way out — passes through it and comes back as a
768-number array. That array is the only language the vector store speaks.

```
  Zoom out — where the embedder sits

  ┌─ Pipeline (stateless) ──────────────────────────────────────┐
  │  index: doc → chunk → embed → upsert                         │
  │  query: question → embed → search → rank                     │
  └───────────────────────────┬─────────────────────────────────┘
                              │ EmbeddingProvider.embed(texts)
  ┌─ Embedder (adapter) ──────▼─────────────────────────────────┐
  │  ★ OllamaEmbeddingProvider — nomic-embed-text, 768-dim ★     │ ← we are here
  │  text in ─► [0.013, -0.21, …768 floats…] out                │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You already know how to turn a record into a sortable key — you pull
a field, hash it, index on it. An embedding is that idea pushed to its limit: the
"key" is a 768-dimensional point chosen so that *meaning* maps to *position*. Two
sentences that mean the same thing land close together even when they share no
words. That single property — proximity equals similarity — is what makes semantic
search possible, and it is the whole reason the vector store can answer "closest"
instead of "exact match."

## Structure pass

**Layers.** Contract (`EmbeddingProvider` in `contracts.ts:22`) → adapter
(`OllamaEmbeddingProvider`) → transport (`EmbedTransport`, injectable) → physical
model (Ollama serving nomic on localhost).

**Axis — cost.** What does one `embed` call cost? Trace it: the contract is free
glue; the adapter batches all texts into one call (`ollama-embedding-provider.ts:50`);
the transport is the expensive hop — a POST to `/api/embed` that runs the neural
net. So you batch: `indexDocument` embeds every chunk of a doc in a single call
(`pipeline.ts:40`), not one call per chunk.

**Seam.** The `EmbeddingProvider` contract (`contracts.ts:22`): `{id, dimension,
embed}`. The axis "which model? local or cloud?" flips below this line. Above it
the pipeline names no vendor; below it nomic-on-Ollama lives, and an OpenAI or
Voyage adapter is a later drop-in (`not yet exercised`).

## How it works

### Move 1 — the mental model

You know `Array.prototype.indexOf` finds an item by exact identity. An embedding
replaces identity with *position in space*. Picture a hash map where, instead of
buckets keyed by exact value, items land at coordinates and nearby coordinates
mean "similar." The lookup is no longer "is this key present" but "what is near
this point."

```
  Embedding space — proximity is meaning

      "how do I reset my password?"  ●
                                      ╲  close (cosine ≈ 0.9)
      "steps to recover login access" ●
              ......................... far .........................
      "what's the capital of France?"                              ●

  same words not required — what's measured is meaning, as distance
```

### Move 2 — the embedding as it actually flows

**The contract: id, dimension, embed.** The whole surface an embedder must offer
is three fields (`contracts.ts:22`):

```ts
export type EmbeddingProvider = {
  id: string;                                  // 'nomic-embed-text'
  dimension: number;                           // 768 — fixed per provider
  embed(texts: string[]): Promise<number[][]>; // batch in, batch of vectors out
};
```

`embed` takes an array and returns an array of arrays — batch in, batch out. That
shape is deliberate: it forces callers to batch and makes one round trip do the
work of many.

```
  The contract surface

  ["chunk 0 text", "chunk 1 text", …]
        │ embed()
        ▼
  [[v0…768], [v1…768], …]   one row per input, each row 768 floats
```

**The adapter: nomic via Ollama, transport-injectable.** `OllamaEmbeddingProvider`
(`ollama-embedding-provider.ts:38`) fixes `id = 'nomic-embed-text'` and
`dimension = 768`, then delegates the actual work to an injectable transport:

```ts
async embed(texts: string[], options?: EmbedCallOptions): Promise<number[][]> {
  options?.signal?.throwIfAborted();
  return this.embedTransport({ model: this.model, texts, ... });
}
```

The transport is the testing seam. In production it POSTs to Ollama's `/api/embed`
(`ollama-embedding-provider.ts:60`). In tests you inject a function that returns
recorded, deterministic vectors — so the entire pipeline runs with **no live
Ollama**. Same trick as the Gemma chat transport.

```
  Adapter + injectable transport

  embed(texts)
     │
     ▼  this.embedTransport({ model, texts })
  ┌─ default ──────────────┐    ┌─ test ─────────────────┐
  │ POST /api/embed (HTTP) │ OR │ return [[…recorded…]]  │
  │ runs the real net      │    │ deterministic, no net  │
  └────────────────────────┘    └────────────────────────┘
```

**The vector means nothing alone — only relative to others.** A single 768-float
array is opaque; no one reads dimension 412. It earns meaning only when compared.
The comparison is cosine similarity (`in-memory-vector-store.ts:46`): the cosine of
the angle between two vectors, in [-1, 1], with a guard returning 0 for a
zero-length vector to avoid NaN. Direction carries meaning; magnitude is ignored.

```
  Cosine similarity — angle, not length

  cos(a,b) = (a·b) / (|a| · |b|)        zero-vector ─► 0 (no NaN)

      a ╲θ        small θ ─► cos ≈ 1 ─► "very similar"
         ╲────► b   large θ ─► cos ≈ 0 ─► "unrelated"
```

### Move 3 — the principle

An embedding is a learned coordinate where meaning is geometry. Engineer around two
facts: the dimension is fixed by the model and not negotiable, and the vector is
worthless except as input to a similarity comparison. So you batch the calls (one
hop per doc, not per chunk), you fix the comparison (cosine), and you never compare
vectors from two different models — their spaces don't line up.

## Primary diagram

```
  Embeddings end to end

  text ─► EmbeddingProvider.embed (contracts.ts:22) ─► [768 floats]
             │  OllamaEmbeddingProvider (nomic, dim 768)
             │  └─ EmbedTransport: POST /api/embed  | injected test vectors
             ▼
  stored as chunk.vector ──────────────┐
                                        │ cosineSimilarity (in-memory-vector-store.ts:46)
  query text ─► embed (SAME provider) ─►┘  angle between query and each chunk
                                        ▼
                              ranked by similarity, top-k
```

## Elaborate

The 768 is not arbitrary — it is nomic-embed-text's output width, baked into the
model weights. You do not get to choose it; you inherit it. That is why the
contract carries `dimension` as a field and the pipeline guards it
(`assertWiring`, `pipeline.ts:22`): the embedding space is a one-way door, covered
in `02-embedding-model-choice.md`. What the vector *means* — that semantic
neighbors are geometric neighbors — is the property `04-vector-databases.md`
exploits to make "search" mean "nearest neighbors."

## Project exercises

### Add a cached embedding layer in front of the provider
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a decorator implementing `EmbeddingProvider` that wraps another
  provider and caches `embed` results by text hash, so re-indexing an unchanged doc
  skips the expensive transport call.
- **Why it earns its place:** the embed call is the one expensive hop in the index
  path; a cache proves you found the cost seam and respected the contract while
  optimizing behind it.
- **Files to touch:** a new `packages/retrieval/src/cached-embedding-provider.ts`,
  `packages/retrieval/src/contracts.ts` (no change — you implement the existing
  type), a new test in `packages/retrieval/test/`.
- **Done when:** a test shows embedding the same text twice calls the inner
  transport once, and `dimension`/`id` pass through unchanged.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "What is an embedding and why does cosine similarity work on it?"**
An embedding is a fixed-length vector (768 here) produced by a model trained so
that semantically similar text lands at nearby points. Cosine similarity measures
the angle between two such vectors, ignoring magnitude — so it scores "do these
point the same way in meaning-space," which is exactly the question retrieval asks.
The model guarantees the geometry; cosine reads it.

```
  meaning ─► position (the model's job)
  position ─► similarity via angle (cosine's job)
```
Anchor: *the model puts meaning into geometry; cosine reads the geometry back out.*

**Q: "Why does `embed` take and return arrays?"**
Batching. The transport hop — the neural net — is the expensive part, so the
contract is shaped to do one round trip for a whole document's chunks
(`pipeline.ts:40`) instead of N trips. One `embed([c0, c1, …])` call returns one
vector per input, aligned by index.

```
  N texts ─► ONE embed call ─► N vectors   (one hop, not N)
```
Anchor: *the contract shape forces batching because the model call is the cost.*

## See also

- `02-embedding-model-choice.md` — why nomic, and the dimension one-way door
- `03-chunking-strategies.md` — what text gets embedded (512/64-char windows)
- `04-vector-databases.md` — how the vector is searched (cosine over the store)
- `11-rag.md` — the pipeline the embedder fronts
- `01-llm-foundations/08-provider-abstraction.md` — the same adapter discipline for chat models
