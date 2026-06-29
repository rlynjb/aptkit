# Embedding batching

*Industry names: batched embedding / vectorized API call / request coalescing.
Type: Industry standard.*

## Zoom out, then zoom in

Indexing a document means embedding every chunk of it, and embedding is a
network round-trip to the model server. The question this file answers: **does
aptkit pay one round-trip per chunk, or one per document?** The answer is one
per document — the embedder takes an array and the pipeline hands it the whole
chunk list at once.

```
  Zoom out — where batching happens in the index path

  ┌─ Retrieval pipeline (packages/retrieval) ───────────────────┐
  │  indexDocument: doc → chunkText() → embed(texts[]) → upsert  │
  │                                     ★ THIS CONCEPT ★         │ ← we are here
  └───────────────────────────┬──────────────────────────────────┘
                              │  ONE POST /api/embed with N texts
  ┌─ Embedding provider (Ollama, local) ▼─────────────────────────┐
  │  OllamaEmbeddingProvider → fetch(:11434/api/embed) → number[][]│
  └───────────────────────────────────────────────────────────────┘

  the contract embed(texts[]) → number[][] makes batching the DEFAULT, not an
  optimization you remember to apply. a 20-chunk doc is 1 HTTP call, not 20.
```

The pattern: **coalesce many small I/O operations into one** by making the
contract plural. `EmbeddingProvider.embed` takes `string[]` and returns
`number[][]` — so the natural way to call it *is* the batched way. You'd have to
go out of your way to embed one chunk at a time.

## The structure pass

Trace the **I/O cost** axis (round-trips) across the index path.

```
  One axis (round-trips) — batched vs the naive alternative

  ┌─ pipeline ──────────┐         ┌─ provider ──────────┐
  │ chunkText → texts[N]│ ══════► │ embed(texts[N])     │  1 round-trip
  └─────────────────────┘  (one)  └─────────────────────┘
                                            vs

  ┌─ naive (NOT this code) ─┐     ┌─ provider ──────────┐
  │ for chunk: embed([c])   │ ══► │ embed([c]) ×N       │  N round-trips
  └─────────────────────────┘     └─────────────────────┘
```

- **Layers:** pipeline (decides the call shape) over provider (does the I/O).
- **Axis:** round-trips per document. Batched = 1; naive = N.
- **Seam:** the `embed(texts[])` signature. The plural contract is the seam
  that makes the cheap path the default path — the cost axis can only be "1
  round-trip" because the contract refuses to take a single string.

## How it works

#### Move 1 — the mental model

You know how you'd never `fetch` a list of 20 items with 20 separate requests
when one `?ids=1,2,3` call does it — the per-request overhead (connection,
headers, model warm-up) dwarfs the marginal cost of more items in one call?
Batched embedding is that instinct applied to the model server.

```
  Pattern — coalesce N embeds into one call

  doc text
     │ chunkText (512/64 windows)
     ▼
  [c0, c1, c2, …, cN]        ← N chunks
     │  embed(  ALL of them  )   ONE call
     ▼
  [[v0],[v1],[v2],…,[vN]]    ← N vectors, index-aligned with chunks
     │  map: chunk i ↔ vector i
     ▼
  upsert([{id:"doc#0",vector:v0},…])
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — chunk the document.** `chunkText` slices fixed 512-char windows with
64-char overlap — `chunker.ts:13-31`. The window size is itself a perf/quality
knob: smaller chunks → more chunks → more vectors to embed and scan (cost up,
precision up); larger chunks → fewer, cheaper, blunter. 512 is chosen to sit
"comfortably inside nomic-embed-text's context" (`chunker.ts:5-11`). The overlap
exists so a fact straddling a boundary isn't split across two chunks and lost —
a *recall* decision with a *cost* side effect (overlap means more total
characters embedded).

**Step 2 — embed the whole chunk array in one call.** The load-bearing line —
`pipeline.ts:37-40`:

```ts
const texts = chunkText(doc.text);          // N chunks
if (texts.length === 0) return;
const vectors = await wiring.embedder.embed(texts);   // ← ONE call, all N texts
const chunks = texts.map((text, i) => ({
  id: `${doc.id}#${i}`,
  vector: vectors[i]!,                       // ← positional alignment: texts[i] ↔ vectors[i]
  meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
}));
```

One `await embedder.embed(texts)` for the entire document. The alignment is
positional — `vectors[i]` is the embedding of `texts[i]` — which is the implicit
contract the batching relies on: the provider must return vectors in input
order. The `!` non-null assertion bakes that assumption in.

**Step 3 — the provider issues exactly one HTTP request.** `OllamaEmbeddingProvider.embed`
passes the array straight through to the transport — `ollama-embedding-provider.ts:50-57`
— and the default transport posts it as one body — `:62-74`:

```ts
const res = await fetch(`${base}/api/embed`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: payload.model, input: payload.texts }),  // ← all texts, one body
  ...(signal ? { signal } : {}),
});
const json = (await res.json()) as OllamaEmbedResponse;
return json.embeddings ?? [];                 // number[][], one per input
```

`input: payload.texts` — the whole array in a single POST. Ollama embeds them
server-side and returns `embeddings: number[][]`. For a 20-chunk doc that's one
TCP round-trip and one model warm-up instead of 20.

**The boundary condition: the batch is unbounded.** There's no cap on how many
texts go in one call. A 10,000-chunk document would attempt to embed all 10,000
in a single request — which could exceed the server's request-size limits or
exhaust memory building one giant `number[][]`. For the demo corpus and
realistic personal-knowledge docs that never bites; at scale you'd want
chunked-batching (batch the batches, e.g. 100 texts per call). That's the
hardening the current code omits — `not yet exercised`.

**The transport is injectable** (`ollama-embedding-provider.ts:18-22, 46-48`) —
tests pass deterministic vectors so no live Ollama is needed. That's a testing
seam, not a perf one, but it's why the Studio in-browser RAG demo can run a
*fake* embedder client-side (`rag-query-fixtures.ts`) without any network at
all.

#### Move 2 variant — the load-bearing skeleton

The kernel of batching: **(1) a plural contract (`texts[] → vectors[]`), (2)
index-aligned results, (3) one transport call over the whole array.**

- Drop the plural contract → callers embed one at a time → N round-trips, the
  cost you were avoiding.
- Drop index alignment → you can't map vectors back to chunks → corrupt
  ids/citations.
- Drop the single transport call (loop inside the provider) → you've moved the
  N round-trips down a layer; the plural signature was a lie.

Optional hardening: a per-call batch-size cap (to bound request size), retry on
partial failure, an embedding cache to skip re-embedding unchanged chunks (the
repo has *none* — re-indexing a doc re-embeds every chunk from scratch, the
caching gap from the audit). The skeleton is the plural contract honored by a
single call.

#### Move 3 — the principle

Make the contract plural and the cheap path becomes the default path — nobody
has to *remember* to batch because the API won't take a single item gracefully.
The generalizable rule: **when an operation crosses a network boundary, shape
its interface around the batch, not the item**, so request overhead amortizes by
construction. The honest limits here: the batch is unbounded (fine until it
isn't) and there's no embedding cache, so repeated indexing pays full freight.

## Primary diagram

```
  Embedding batching — one document, one round-trip

  ┌─ Pipeline layer (packages/retrieval) ───────────────────────┐
  │  indexDocument(doc)                                          │
  │    doc.text ─ chunkText(512/64) ─► [c0 … cN]                 │
  │    embed([c0 … cN])  ──────────────────┐  ONE call           │
  │    map texts[i] ↔ vectors[i] ◄─────────┘                     │
  │    upsert([{id:doc#i, vector:vi, meta}…])                    │
  └───────────────────────────┬──────────────────────────────────┘
                              │  POST :11434/api/embed { input:[c0…cN] }
  ┌─ Provider layer (Ollama, local HTTP) ▼────────────────────────┐
  │  nomic-embed-text → embeddings: number[][]  (768-dim each)    │
  └───────────────────────────────────────────────────────────────┘
     1 round-trip per doc · unbounded batch · NO embed cache (the gap)
```

## Elaborate

Batching is the oldest I/O optimization there is — amortize fixed per-request
cost over many items. For embeddings it's especially sharp because the fixed
cost includes model warm-up, not just network. The plural contract also future-
proofs the cost story: when the embedder swaps from local Ollama to a paid API
(OpenAI/Voyage are named drop-ins in the project context), batching directly
cuts the *bill*, not just latency, because paid embedding APIs charge per token
but bill the request overhead in latency and rate-limit budget. Read next:
`02-linear-scan-vs-ann-tradeoff.md` (the scan over the vectors this produces)
and `06-over-fetch-then-filter.md` (a different cost — over-fetching at query
time).

## Interview defense

**Q: How does your indexing pipeline keep embedding cheap?**

Verdict first: the embedder contract is plural — `embed(texts[]) → vectors[]` —
so a whole document's chunks go in one HTTP call, one model warm-up, instead of
one call per chunk. The detail: chunk → embed-the-array → map positionally
(`vectors[i]` is `texts[i]`'s embedding) → upsert. Batching is the default
because the API won't take a single string gracefully.

```
  sketch while you talk:

  chunkText(doc) → [c0…cN] → embed( ALL ) → [v0…vN] → upsert(zip(c,v))
                              └ ONE round-trip, not N ┘
```

One-line anchor: *"plural contract makes the batched path the default path — you
can't accidentally embed one at a time."*

**Q: Where does this break?**

The batch is unbounded — a huge document tries to embed every chunk in one
request, which can blow request-size or memory limits; you'd want to cap batch
size at scale. And there's no embedding cache, so re-indexing an unchanged
document re-embeds every chunk. Both are fine for the local demo corpus, both
are real at production scale, and neither has been measured.

## See also

- `audit.md` — lens 5 (io-network), lens 6 (caching gap).
- `02-linear-scan-vs-ann-tradeoff.md` — the scan over the vectors this builds.
- `06-over-fetch-then-filter.md` — over-fetch cost at query time.
