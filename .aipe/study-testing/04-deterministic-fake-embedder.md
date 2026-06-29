# Deterministic fake embedder — making cosine ranking exact

**Industry name:** the test double as a *fake* (a pure deterministic stand-in)
at the `EmbeddingProvider` port; defeats randomness-driven flakiness. Type
label: Industry standard (test-double), Project-specific construction.

## Zoom out, then zoom in

Retrieval and memory tests rank vectors by cosine similarity. A real embedder
(`nomic-embed-text` via Ollama, 768-dim) gives you opaque floats that are slow,
network-bound, and — for an assertion like "the moon doc ranks first" —
effectively random. So the tests inject a fake embedder with one property: you
can predict its output by reading it.

```
  Zoom out — where the fake embedder sits

  ┌─ retrieval / memory pipeline ────────────────────────────┐
  │  index: text → ★ embed ★ → upsert into VectorStore        │
  │  query: text → ★ embed ★ → search → rank by cosine        │
  └──────────────────────────┬───────────────────────────────┘
                             │ EmbeddingProvider port  ← the seam
  ┌─ adapter ────────────────▼───────────────────────────────┐
  │  test:  fake keyword-presence embedder (pure, exact)      │
  │  prod:  OllamaEmbeddingProvider (nomic, 768, network)     │
  └────────────────────────────────────────────────────────────┘
```

**Zoom in.** The fake maps text to a vector by *keyword presence* — a word is
present or it isn't, so the vector is a deterministic function of the input you
can compute in your head. Cosine over those vectors is exact, so "the Paris doc
ranks first" is a stable assertion, not a probabilistic one. The question: *how
do you test ranked retrieval without a flaky, slow, opaque embedding model?*
Inject an embedder whose output is a pure function of the text.

## Structure pass

**Layers:** pipeline → `EmbeddingProvider` port → embedder adapter.
**One axis — predictability of output:**

```
  Axis: can you predict the vector from the text?

  ┌─ pipeline ─┐   seam    ┌─ embedder ─────────┐
  │ ranks hits │ ◄══╪═════  │ test: YES (keyword)│
  │ by cosine  │  (flips)   │ prod: NO  (opaque  │
  └────────────┘            │       768 floats)  │
                            └────────────────────┘
```

Predictability flips at the port. In prod the embedder is an opaque model; in
test it's a function you can evaluate by hand, so the *exact* cosine ranking is
known in advance. That flip is what lets the test assert `results[0].id` rather
than just "some result came back."

## How it works

### Move 1 — the mental model

Think of a one-hot encoding for a list render: each known word lights up one
slot. "Paris" → `[1,0,0]`, "Tokyo" → `[0,1,0]`. Two texts sharing a word point
in overlapping directions, so cosine similarity between them is high — and you
can see *why* without running anything. The fake embedder is exactly this: a
fixed vocabulary, presence = 1.

```
  The pattern — keyword presence → predictable vector

  VOCAB = ['paris','tokyo','berlin']
  "weather in Paris" → [1,0,0]     // 'paris' present
  "Tokyo is..."      → [0,1,0]     // 'tokyo' present
  cosine([1,0,0],[1,0,0]) = 1.0    // exact, hand-computable
  cosine([1,0,0],[0,1,0]) = 0.0
```

### Move 2 — the walkthrough

#### The 3-dim vocab fake (rag-query)

The simplest form — a fixed 3-word vocab, one-hot by presence:

```ts
// packages/agents/rag-query/test/rag-query-agent.test.ts:21
const VOCAB = ['paris', 'tokyo', 'berlin'];
class FakeEmbedder implements EmbeddingProvider {
  readonly id = 'fake';
  readonly dimension = 3;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      return VOCAB.map((word) => (lower.includes(word) ? 1 : 0));   // presence = 1
    });
  }
}
```

Because the Paris doc contains "Paris" and the query "weather in Paris" does
too, they share the first dimension and rank together — exactly. So `:106` can
assert `scorePrecisionAtK(retrievedDocIds, new Set(['paris-doc']), 1).score === 1`
("the Paris doc should rank first"). No flake possible: the ranking is a fixed
function of the fixed text.

#### The hashing fake (search-knowledge-base) — same idea, more slots

When two words need to not collide in 3 dims, the tool test uses a 64-dim hashed
version — still pure, still deterministic:

```ts
// packages/retrieval/test/search-knowledge-base-tool.test.ts:14
function makeFakeEmbedder(dimension: number): EmbeddingProvider {
  return {
    id: 'fake', dimension,
    async embed(texts) {
      return texts.map((text) => {
        const v = new Array<number>(dimension).fill(0);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
          let h = 0;
          for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;  // deterministic hash
          v[h % dimension] += 1;                                          // bucket the word
        }
        return v;
      });
    },
  };
}
```

A word hashes to the same bucket every time (`h * 31 + charCode`), so "moon"
always lands in the same slot. The query "how often does the moon orbit earth"
shares the "moon"/"orbit"/"earth" buckets with the space doc, so `:59` asserts
`results[0].id === 'space#0'` exactly.

#### The memory fake — and the non-zero bias trick

The memory test (`conversation-memory.test.ts:9`) adds one detail worth naming:
a constant bias dimension.

```ts
// packages/memory/test/conversation-memory.test.ts:9
return [
  s.includes('editor') || s.includes('neovim') ? 1 : 0,
  s.includes('coffee') ? 1 : 0,
  s.includes('deadline') ? 1 : 0,
  1,   // ← bias dim keeps every vector non-zero
];
```

Cosine similarity is undefined for a zero vector (division by zero magnitude).
A text matching none of the keywords would otherwise embed to `[0,0,0]` and
break the ranking. The `1` bias dim guarantees every vector is non-zero, so
cosine is always defined. That's a real boundary the fake handles — naming it
shows you've thought about the cosine edge case.

### Move 2 variant — the load-bearing skeleton

Kernel: **a pure function from text to vector + a fixed vocabulary/hash + a
guarantee the vector is non-zero.** What breaks without each:

- **Drop purity** (e.g. call the real model) → the test is slow, network-bound,
  and the ranking is opaque — you can't assert `results[0].id` exactly.
- **Drop the fixed mapping** → you can't predict which doc ranks first, so the
  assertion has to weaken to "something came back," which tests almost nothing.
- **Drop the non-zero guarantee** → a no-keyword text embeds to all-zeros, cosine
  divides by zero, the test flakes or throws on an unrelated input.

### Move 3 — the principle

When a test depends on a model that returns opaque, non-deterministic output,
replace it with a fake whose output you can compute by hand. The fake doesn't
need to be a *good* embedder — it needs to be a *predictable* one. Correctness
of retrieval logic (does it rank by cosine, honor `top_k`, dedupe ids) is
separable from quality of embeddings (does nomic place semantically-similar text
nearby), and the fake lets you test the former without the latter.

## Primary diagram

```
  Deterministic fake embedder — full picture

  text ──► ┌─ fake embedder (pure) ─┐ ──► vector (predictable)
           │ keyword presence /     │      e.g. "Paris" → [1,0,0]
           │ hash to bucket + bias 1│
           └────────────────────────┘
                     │ same EmbeddingProvider port as prod
                     ▼
  ┌─ InMemoryVectorStore (real cosine scan) ─┐
  │  rank hits by cosine — EXACT, no flake    │
  └──────────────────┬────────────────────────┘
                     ▼
  assert: results[0].id === expected (the planted doc ranks first)
          precision@k === 1
```

## Elaborate

This pairs with `in-memory-vector-store.test.ts`, which tests the *store's*
cosine math directly with hand-chosen unit vectors (`[1,0,0]` aligned vs
`[0,1,0]` orthogonal vs `[-1,0,0]` opposite, `:6`) and asserts strictly
descending scores. So the suite tests cosine ranking from two angles: the store
with raw vectors, and the pipeline with the fake embedder producing those
vectors from text. Both deterministic, neither touching Ollama.

What this deliberately does NOT test: whether `nomic-embed-text` actually places
semantically similar documents near each other. That's embedding *quality* — a
study-ai-engineering eval concern (precision@k as a *metric over real
embeddings*), not a correctness test (precision@k *math*, tested here in
`precision-at-k.test.ts`). The same scorer, two halves of the determinism seam.

## Interview defense

**Q: How do you test ranked retrieval without a flaky embedding model?**
Inject a fake embedder that maps text to a vector by keyword presence — a pure
function you can compute by hand. Cosine over those vectors is exact, so "the
Paris doc ranks first" is a stable assertion. The real Ollama embedder stays out
of the test entirely.

```
  text → [keyword presence] → predictable vector → exact cosine rank
         (real model: opaque floats, can't assert exactly)
```

Anchor: *the fake needs to be predictable, not good — retrieval-logic correctness
is separable from embedding quality.*

**Q: What's the cosine edge case the fake has to handle?**
A zero vector. Cosine divides by magnitude, so an all-zero embedding (a text
matching no keywords) is undefined. The memory fake adds a constant bias
dimension (`1`) so every vector is non-zero and cosine is always defined.

```
  no-keyword text → [0,0,0] → cosine div-by-zero
  fix: append bias dim → [0,0,0,1] → always non-zero
```

Anchor: *naming the bias dim shows you've handled the cosine boundary, not just
the happy keyword match.*

## See also

- `01-injected-model-port.md` — the same inject-a-fake-at-the-port move for the
  model.
- `05-bug-to-regression-test.md` — uses this fake embedder to reproduce the
  hallucinated-filter bug.
- `audit.md` lens 4 (determinism — randomness designed out).
- study-ai-engineering — precision@k as a quality metric over real embeddings.
