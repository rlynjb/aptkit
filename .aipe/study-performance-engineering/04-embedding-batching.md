# Embedding batching

**Industry name:** request batching / vectorized embedding calls · **Type:** Industry standard

The contract that lets the index path embed a whole document's chunks in one network round-trip instead of N, and the chunk-window size that trades retrieval recall against embedding cost.

---

## Zoom out, then zoom in

Embedding is a network call to a model that turns text into a 768-float vector. The index path has many texts to embed (every chunk of a document); the query path has one. The batch-shaped contract serves both, but the cost story is entirely about the index path — where batching collapses N round-trips into one.

```
  Zoom out — where batching lives

  ┌─ Pipeline layer ──────────────────────────────────────────┐
  │  indexDocument: chunkText(doc) → ★ embed(texts[]) ★ → upsert│ ← we are here
  │  queryKnowledgeBase: embed([query]) → search               │
  └───────────────────────────┬───────────────────────────────┘
                              │ EmbeddingProvider contract: embed(string[])
  ┌─ Provider layer ──────────▼───────────────────────────────┐
  │  OllamaEmbeddingProvider → POST /api/embed { input: texts }│
  └────────────────────────────────────────────────────────────┘
```

The contract is `embed(texts: string[]): Promise<number[][]>` (`packages/retrieval/src/contracts.ts:25`) — array in, array of vectors out. That batch shape is the whole optimization: it makes "embed 40 chunks" one HTTP request, not 40.

## The structure pass

Trace **the cost axis — "how many network round-trips does indexing one document cost?"** down to the provider.

```
  Axis: "round-trips to embed one document?" — across the batch seam

  ┌─ pipeline ───────────────────┐  seam   ┌─ provider ──────────────────┐
  │ chunkText → texts[40]         │ ══╪══►  │ POST /api/embed              │
  │ embed(texts) ONCE             │ (flips) │ { input: [t0..t39] }         │
  │ → vectors[40]                 │         │ ONE round-trip, 40 vectors   │
  └───────────────────────────────┘         └──────────────────────────────┘

  contrast — if the pipeline looped:  embed([t0]); embed([t1]); ... → 40 round-trips
```

- **Layers:** pipeline (has the array) → contract (batch-shaped) → provider (one POST).
- **Axis:** round-trips per indexed document. The batch contract pins it at **1**, regardless of chunk count.
- **Seam:** the `EmbeddingProvider.embed` contract. The array-in shape is what forces the cost to be one round-trip — a scalar `embed(text)` contract would have leaked an N-call loop into every caller.

## How it works

#### Move 1 — the mental model

You know the difference between `await fetch()` inside a `for` loop (N sequential requests, N round-trip latencies stacked) versus one `fetch()` with a batch payload (one round-trip). Embedding batching is that, applied to the embed call: the contract takes an array so the caller never writes the loop.

```
  Pattern — batch vs loop

  BATCHED (what the index path does):     LOOPED (what the contract prevents):

   texts[40] ──► embed(texts) ──► [v0..v39]   for t in texts:
                     │                            await embed([t])  ← 40× latency
                 1 round-trip                     vecs.push(...)
                                                  └─ 40 round-trips
```

#### Move 2 — the step-by-step walkthrough

**The index path batches — one embed call for the whole document.** `indexDocument` chunks the text into an array and hands the *entire array* to `embed` in a single call:

```ts
// packages/retrieval/src/pipeline.ts:37-46
const texts = chunkText(doc.text);                  // ← array of ~512-char windows
if (texts.length === 0) return;
const vectors = await wiring.embedder.embed(texts); // ← ONE call, all chunks, batched
const chunks = texts.map((text, i) => ({
  id: `${doc.id}#${i}`,
  vector: vectors[i]!,                              //   vectors[] aligns 1:1 with texts[]
  meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
}));
await wiring.store.upsert(chunks);
```

A 20 KB document chunks into ~40 windows (`CHUNK_SIZE = 512`, `chunker.ts:13`); this code embeds all 40 in one round-trip. The provider forwards the array straight to Ollama's batch endpoint:

```ts
// packages/retrieval/src/ollama-embedding-provider.ts:62-74
const res = await fetch(`${base}/api/embed`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: payload.model, input: payload.texts }),  // ← whole array as `input`
  ...
});
const json = (await res.json()) as OllamaEmbedResponse;
return json.embeddings ?? [];                       // ← array of vectors back, same order
```

**The query path doesn't batch — and shouldn't.** The query and memory-recall paths embed exactly one string, so they pass a one-element array (`embed([query])`, `pipeline.ts:56`; `embed([text])` / `embed([query])` in `conversation-memory.ts:76,90`). They use the batch contract with a batch of one. There is no waste here — there is genuinely only one thing to embed.

**Where it breaks — no chunk-level batch ceiling.** The index path embeds *all* chunks of a document in one call with no upper bound. For the demo corpus that is fine. For a very large document (thousands of chunks) that is one enormous request — the provider may cap payload size, and a single failed request loses the whole document's embeddings. Production batching usually caps batch size (e.g. 100 chunks per request) and chunks the chunk list. aptkit does not — it is `not yet exercised`. The contract *supports* sub-batching (the caller could slice and call `embed` per slice), but no caller does it yet.

#### Move 2.5 — the chunk-window tradeoff (recall vs cost)

Batching is the *cost* side. The *recall* side is the chunk window, and the two are coupled: smaller chunks mean more chunks mean more vectors to embed and store.

```
  Chunk size — the recall/cost dial   (chunker.ts:13-14)

  SMALLER chunks (e.g. 256):          LARGER chunks (e.g. 1024):
   ├ more chunks per doc               ├ fewer chunks per doc
   ├ each chunk more focused           ├ each chunk more diluted
   ├ better precision (less noise      ├ worse precision (relevant
   │  around the relevant passage)     │  fact buried in filler)
   └ MORE vectors to embed + store     └ FEWER vectors to embed + store
        (higher cost)                       (lower cost)

  aptkit's call: CHUNK_SIZE=512, CHUNK_OVERLAP=64
```

`CHUNK_SIZE = 512`, `CHUNK_OVERLAP = 64` (`chunker.ts:13-14`) is the chosen point: ~512 chars sits comfortably inside nomic-embed-text's context while staying granular enough to isolate one passage, and the 64-char overlap stops a fact straddling a window boundary from being split across two chunks and lost. Drop the size and you get sharper retrieval at more embedding/storage cost; raise it and you save cost but dilute each vector. This is a recall-vs-cost decision made at chunk time and locked into how many vectors the batch carries.

#### Move 3 — the principle

Make the expensive operation's contract take a batch, and the caller can never accidentally write the N-call loop. The array-in/array-out shape of `embed` is what guarantees the index path costs one round-trip per document instead of one per chunk — the optimization is baked into the interface, not left to caller discipline. The chunk window is the upstream knob that decides how big that batch is, trading retrieval recall against embedding and storage cost.

## Primary diagram

```
  Embedding batching — full picture

  ┌─ index path ──────────────────────────────────────────────────┐
  │  doc.text                                                       │
  │     │ chunkText (CHUNK_SIZE=512, OVERLAP=64)  ← recall/cost dial │
  │     ▼                                                           │
  │  texts[N] ──► embedder.embed(texts) ──────────────────────────┐ │
  │                     │  ONE batched call                       │ │
  └─────────────────────┼─────────────────────────────────────────┘ │
                        │  EmbeddingProvider contract: embed(string[])│
  ┌─ provider ──────────▼───────────────────────────────────────────┘
  │  POST /api/embed { input: texts[N] }  →  embeddings[N]
  │     1 round-trip regardless of N   (no sub-batch ceiling — see "where it breaks")
  └──────────────────────────────────────────────────────────────────

  query path:  embed([query])  → batch of one, no waste
```

## Elaborate

Batching is the first optimization any embedding pipeline reaches for, because embedding APIs price and rate-limit per request as much as per token — collapsing N requests into one cuts both round-trip latency and request-count overhead. The batch-shaped contract here is the same dependency-inversion move that makes `VectorStore` swappable (`01-linear-scan-vs-ann-tradeoff.md`): the interface encodes the right usage so implementations and callers both inherit it. The missing piece — a sub-batch ceiling for very large documents — is the standard hardening this would grow at scale, and the contract already permits it without a change.

## Interview defense

**Q: How does your RAG pipeline embed a document efficiently?**
The `EmbeddingProvider.embed` contract takes a string array, so `indexDocument` chunks the doc and embeds *all* chunks in one batched call — one HTTP round-trip per document, not one per chunk. The batch shape is in the interface, so no caller can accidentally loop.

```
  texts[40] ─► embed(texts) ─► [v0..v39]   ← 1 round-trip
  (vs. for t in texts: embed([t])           ← 40 round-trips)
```
Anchor: "the batch is in the contract, so the loop never gets written."

**Q: How do you pick chunk size?**
It's a recall-vs-cost dial. Smaller chunks → sharper retrieval but more vectors to embed and store; larger → cheaper but each vector is diluted. I run 512 chars with 64 overlap — inside nomic's context, granular enough to isolate a passage, with overlap so a boundary-straddling fact isn't split. The overlap is the part people forget; without it you lose facts at window seams.

Anchor: "chunk size trades recall for cost; overlap is what stops boundary loss."

## See also

- `01-linear-scan-vs-ann-tradeoff.md` — same dependency-inversion seam, the store side
- `06-over-fetch-then-filter-cost.md` — the other per-query cost the recall path pays
- `audit.md` — Lens 5 (I/O), Lens 6 (batching: partial)
- `study-ai-engineering` — embedding models, chunking strategy, retrieval recall
