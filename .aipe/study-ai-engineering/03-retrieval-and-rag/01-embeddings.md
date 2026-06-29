# Embeddings
> Dense vector representations · Industry standard

You already lived this in AdvntrCue: text goes in, a float array comes out, and you store it next to the text in pgvector. An embedding is that float array. It's a point in a 768-dimensional space where "similar meaning" maps to "geometrically close." That's the whole trick — you turn a fuzzy semantic question ("is this passage about X?") into a precise geometric one ("how close are these two points?"), and geometry you can compute with a dot product and a square root.

## Zoom out, then zoom in

Embeddings are the first hop of the retrieval stack — everything downstream operates on the vectors this layer produces, not on the text.

Where embeddings sit in aptkit's retrieval stack:

```
aptkit retrieval stack (top = closest to the agent)
┌─────────────────────────────────────────────────────────┐
│  search_knowledge_base tool   (agent-facing seam)         │
├─────────────────────────────────────────────────────────┤
│  pipeline   indexDocument / queryKnowledgeBase            │
├─────────────────────────────────────────────────────────┤
│  chunker    text → 512-char windows                       │
├─────────────────────────────────────────────────────────┤
│  ★ EmbeddingProvider   text[] → number[][]  (768-dim)  ★  │  ← you are here
│     (OllamaEmbeddingProvider → nomic-embed-text)          │
├─────────────────────────────────────────────────────────┤
│  VectorStore   stores + cosine-ranks the vectors          │
└─────────────────────────────────────────────────────────┘
        ▲ everything below this line is just float math
```

The embedding model (nomic-embed-text) is the only place in the stack that understands language. Below it, nothing knows the difference between a paragraph about kayaking and a paragraph about taxes — it's all 768 floats either way. That's a feature: it means the store, the chunker, and the search tool never need a vendor. The contract (`EmbeddingProvider`) is three lines because the abstraction is genuinely that thin.

## Structure pass

Pick the **trust** axis: how much does each layer "know" the meaning of what it handles?

```
trust-of-meaning across the layers
text ──► [embedding model] ──► vector ──► [store] ──► ranked ids
 high      KNOWS meaning      none        BLIND       none
                │
                ▼
        ★ the seam: meaning is FROZEN into geometry here ★
```

The seam is the embedding call. Above it, you have language a human can read. Below it, you have coordinates. Once the model has run, the meaning is *baked in* — the store can't recover "what was this about," it can only measure "how close is this to that other point." If the embedding model is bad at your domain, no amount of clever ranking downstream fixes it. The quality ceiling is set right here.

## How it works

**Move 1 — mental model.** An embedding model is a function that maps text into a fixed-size space such that things-that-mean-similar-things end up near each other. Picture three documents dropped into the space:

```
the geometric picture (2D projection of 768-D)
                 ▲
                 │   ● "renew passport online"
                 │  ╱  ← small angle = high cosine = similar
                 │ ●  "passport renewal portal"
                 │
                 │            ● "best trail running shoes"
                 │           ╱  ← large angle = low cosine = unrelated
                 └──────────────────────────────────►
   cosine similarity = cos(angle between the two vectors)
```

You don't measure distance with a ruler (magnitude is noise here); you measure the *angle*. Two vectors pointing the same direction have cosine 1.0; perpendicular is 0.0. That's exactly the math you'd write for two heaps of features — `dot(a,b) / (|a||b|)`.

**The provider contract.** aptkit names the abstraction, not the vendor. The embedding model (nomic-embed-text) lives behind `EmbeddingProvider`:

```
EmbeddingProvider — the only language-aware contract
┌──────────────────────────────────────────────┐
│ id: string          ← "nomic-embed-text"       │
│ dimension: number   ← 768 (FIXED per provider) │
│ embed(texts) ─────► number[][]  (one vec each) │
└──────────────────────────────────────────────┘
```

```ts
// packages/retrieval/src/contracts.ts:22-26
export type EmbeddingProvider = {
  id: string;                                   // identity, used in error messages
  dimension: number;                            // 768 — the one-way door (file 02)
  embed(texts: string[]): Promise<number[][]>;  // batch in, batch out, aligned by index
};
```

`embed` takes an *array* and returns an *array* — batching is built into the contract. The chunker hands you N chunks; you get N vectors back, aligned by index. That alignment is load-bearing: `pipeline.ts:41` zips `texts[i]` to `vectors[i]` with no key, so the provider must return them in order.

**The Ollama implementation.** The concrete provider (`OllamaEmbeddingProvider`) POSTs to a local model and pins its dimension:

```ts
// packages/retrieval/src/ollama-embedding-provider.ts:39-40
readonly id = 'nomic-embed-text';
readonly dimension = 768;                       // hard-coded — nomic's output size
// ...:50-57  embed() delegates to an injectable transport
async embed(texts, options?) {
  options?.signal?.throwIfAborted();            // cancellation-aware
  return this.embedTransport({ model: this.model, texts, ... });
}
// :63 default transport POSTs http://localhost:11434/api/embed → json.embeddings
```

The transport is injectable (`:18-22`) so tests feed deterministic vectors with no live Ollama — you assert ranking behavior without a model running. Note `dimension = 768` is a constant, not read from the response. The provider *asserts* its shape rather than discovering it; if Ollama ever returned something else, downstream dimension checks would catch it loudly (file 02).

**Move 3 — the principle.** An embedding gives you a *similarity score*, not *meaning*. It can tell you "passport renewal portal" is close to "renew passport online." It cannot tell you *why*, cannot reason, cannot tell you the second result is actually about a different country. Retrieval ranks; it doesn't understand. Everything in RAG downstream is built on the assumption that "close in this space" ≈ "relevant," and that approximation is exactly where retrieval quality lives or dies.

## Primary diagram

```
the full embedding hop, end to end
  "renew my passport"                         (a chunk of corpus text)
        │                                              │
        ▼ embed([query])                               ▼ embed([chunk])
  ┌───────────────┐                            ┌───────────────┐
  │ nomic-embed   │  same model, same 768-dim  │ nomic-embed   │
  │  -text (768)  │◄──── MUST match ──────────►│  -text (768)  │
  └───────┬───────┘                            └───────┬───────┘
          ▼                                            ▼
   [0.02, -0.7, ...]  ──── cosine similarity ────  [0.05, -0.6, ...]
       query vec              = score ∈ [-1,1]         chunk vec
                                   │
                                   ▼
                          higher score = retrieve
```

Query and corpus must pass through the *same* model — mixing a 768-dim corpus with a query from a different model is the one-way-door failure (file 02).

## Elaborate

Embeddings as we use them descend from word2vec (2013) and the "king − man + woman ≈ queen" demos — the insight that meaning could be *arithmetic* in a learned space. Modern sentence/passage embedders (nomic, OpenAI's text-embedding-3, the BGE/E5 family) extend that from words to whole passages. Adjacent ideas worth knowing: **contrastive training** (the model is trained to pull related pairs together and push unrelated ones apart — that's *why* cosine works), and **dimensionality** (more dims = more capacity but more storage and slower scan; 768 is a common middle). Read next: `02-embedding-model-choice.md` (why nomic, and why dimension is a one-way door) and `04-vector-databases.md` (where the vectors live).

## Project exercises

### Add a second embedding provider behind the same contract

- **Exercise ID:** `EX-RAG-01a`
- **What to build:** An `OpenAIEmbeddingProvider implements EmbeddingProvider` wrapping `text-embedding-3-small` (1536-dim), selectable at wiring time. This is a Phase 2A move — proving the contract is real by adding a second vendor.
- **Why it earns its place:** The whole point of `EmbeddingProvider` is vendor-swappability. You haven't proven the seam holds until a second provider sits behind it with a *different* dimension — which forces you to confront the one-way door (file 02) for real.
- **Files to touch:** new `packages/retrieval/src/openai-embedding-provider.ts`; export from `packages/retrieval/src/index.ts`; mirror the transport-injection pattern in `packages/retrieval/src/ollama-embedding-provider.ts`.
- **Done when:** a pipeline wired with the OpenAI provider (1536-dim) + an `InMemoryVectorStore(1536)` indexes and queries with passing tests using an injected transport (no live API), and wiring it to a 768-dim store throws at `createRetrievalPipeline`.
- **Estimated effort:** `1–4hr`

### Make the embed call cancellable end to end

- **Exercise ID:** `EX-RAG-01b`
- **What to build:** Thread an `AbortSignal` from `queryKnowledgeBase` through `embed` so a slow Ollama call can be cancelled mid-query.
- **Why it earns its place:** `OllamaEmbeddingProvider.embed` already honors a signal (`:51`), but `pipeline.ts:56` never passes one — the cancellation path dead-ends. Wiring it through is a small, real correctness fix.
- **Files to touch:** `packages/retrieval/src/pipeline.ts` (`queryKnowledgeBase`, `indexDocument`); `packages/retrieval/src/contracts.ts` (extend `embed` signature if needed).
- **Done when:** an aborted query rejects fast instead of waiting on the HTTP call, with a test using a transport that respects the signal.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Why cosine similarity and not Euclidean distance?**

```
two vectors, same direction, different length
   short ●──►          cosine: angle only → 1.0 (identical meaning)
   long  ●──────►       euclid: far apart → "different" (WRONG here)
```

Anchor: embeddings encode meaning in *direction*, not magnitude — cosine ignores length, so a short doc and a long doc about the same thing still match.

**Q: What does an embedding NOT give you?**

```
"close in space"  ≈  "relevant"     ← an approximation, not truth
       │
       └─► no reasoning, no "why", no fact-check
```

Anchor: retrieval ranks by similarity; it never understands. Everything in RAG rests on the closeness≈relevance approximation, and that's where quality is won or lost.

## See also

- [02-embedding-model-choice.md](02-embedding-model-choice.md) — why nomic, and the dimension one-way door
- [03-chunking-strategies.md](03-chunking-strategies.md) — what text you embed
- [04-vector-databases.md](04-vector-databases.md) — where the vectors are stored and searched
- [11-rag.md](11-rag.md) — the full retrieve-then-generate loop
