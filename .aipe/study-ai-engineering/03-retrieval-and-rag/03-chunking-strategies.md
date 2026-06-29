# Chunking strategies
> Fixed-size windowing · Industry standard

You can't embed a 40-page PDF as one vector — you'd average all its meaning into mush, and a query about page 3 would score the same as a query about page 30. So you cut the text into pieces small enough that each piece is *about one thing*, then embed each piece. That cut is chunking, and it's the most underrated lever in RAG: the best embedding model in the world can't retrieve a fact that got sliced in half. aptkit uses the simplest strategy that works — fixed-size character windows with a little overlap — and is honest that "simplest" sometimes means "lands mid-sentence."

## Zoom out, then zoom in

Chunking sits between the raw document and the embedder — it decides the *unit* of retrieval.

```
where chunking sits
┌──────────────────────────────────────────────────────────┐
│  RetrievalDocument   { id, text, meta }   (whole doc)       │
└───────────────┬────────────────────────────────────────────┘
                ▼  indexDocument calls chunkText(doc.text)
┌──────────────────────────────────────────────────────────┐
│  ★ chunker   text → ["...512 chars...", "...512 chars..."] ★ │  ← you are here
│     CHUNK_SIZE=512, CHUNK_OVERLAP=64, deterministic        │
└───────────────┬────────────────────────────────────────────┘
                ▼  each chunk → embed → upsert with id `${doc.id}#${i}`
┌──────────────────────────────────────────────────────────┐
│  EmbeddingProvider → VectorStore   (one vector per chunk)   │
└──────────────────────────────────────────────────────────┘
```

The chunk is the atom of retrieval — you never retrieve a document, you retrieve a chunk and use its `docId` to cite back. So the chunk boundary *is* the resolution of your whole system. Too big, and a hit drags in irrelevant text that dilutes the context. Too small, and a single fact gets split and neither half scores well. 512 chars is aptkit's bet on the middle.

## Structure pass

Pick the **state** axis: what survives across a chunk boundary, and what's lost?

```
state across a chunk boundary
  ...the passport office at 9am. Renewal takes |  ten business days unless...
                                          chunk i │ chunk i+1
                          ──────── no overlap ────┘
   the fact "renewal takes ten business days" is SPLIT → neither chunk has it whole
                                              │
                          ──── 64-char overlap ───┐
  ...the passport office at 9am. Renewal takes ten business days unless... | (i+1 starts here)
   the fact survives WHOLE in chunk i because the window extends past the cut
```

The seam is the window boundary, and overlap is the patch over it. Without overlap, every boundary is a place a fact can die. The 64-char overlap means the last 64 chars of chunk *i* are repeated as the first 64 of chunk *i+1*, so a fact straddling the cut lives intact in at least one chunk. You pay for it in storage (slightly more, overlapping) and in duplicate hits, but you stop losing facts at seams.

## How it works

**Move 1 — three strategies, one pattern.** Every chunker is a function from text to a list of strings; they differ only in *where they cut*:

```
chunking strategies (aptkit uses ★ fixed-size ★)
┌─────────────────┬──────────────────────────┬─────────────────────┐
│ ★ FIXED-SIZE ★  │ SENTENCE / RECURSIVE      │ STRUCTURAL          │
├─────────────────┼──────────────────────────┼─────────────────────┤
│ cut every N     │ cut on sentence / para    │ cut on doc structure │
│ chars           │ boundaries                │ (md headings, code)  │
│ deterministic   │ needs a splitter / NLP    │ needs a parser       │
│ may split mid-  │ respects meaning units    │ respects author's    │
│ sentence        │                           │ own boundaries       │
│ ZERO deps       │ medium deps               │ format-specific      │
└─────────────────┴──────────────────────────┴─────────────────────┘
```

aptkit picks fixed-size on purpose: deterministic, vendor-neutral, no tokenizer, trivially testable. It's the right default for a from-scratch pipeline — and the comment in `chunker.ts:11` says exactly that ("A smarter semantic/recursive splitter is a later drop-in; the contracts above it do not change").

**The sliding window.** The core is a stepped slice:

```ts
// packages/retrieval/src/chunker.ts:16-31
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length === 0) return [];              // empty → no chunks
  if (text.length <= size) return [text];        // short doc → one chunk, no slicing
  const step = Math.max(1, size - overlap);      // ← 512-64 = 448; advance by step, not size
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size)); // window of `size`, overlaps prev by `overlap`
    if (start + size >= text.length) break;       // stop once the window reaches the end
  }
  return chunks;
}
```

```
the sliding window (size=512, overlap=64, step=448)
  pos: 0          448         896
       ├─────512─────┤
       chunk 0       └──64 overlap──┐
                  ├─────512─────┤
                  chunk 1 (starts at 448)
                              ├─────512─────┤
                              chunk 2 (starts at 896)
  step = size - overlap = 448  ← every chunk shares 64 chars with the previous
```

`step = Math.max(1, size - overlap)` is the load-bearing line. The `Math.max(1, …)` guard means even a pathological `overlap >= size` can't make `step` zero and loop forever. The window is `size` wide; the *advance* is `step`, narrower by exactly the overlap.

**Chunk identity.** The pipeline stamps each chunk with a stable, ordinal id and carries the text in meta:

```ts
// packages/retrieval/src/pipeline.ts:41-45
const chunks = texts.map((text, i) => ({
  id: `${doc.id}#${i}`,                          // ← stable: doc "guide" → "guide#0","guide#1"
  vector: vectors[i]!,
  meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },  // text rides along for citation
}));
```

```
chunk id scheme — why `${doc.id}#${i}` matters
   doc "guide" re-indexed (edited)
     → chunk 0 → id "guide#0"  ──► upsert OVERWRITES old "guide#0"
     → chunk 1 → id "guide#1"  ──► upsert OVERWRITES old "guide#1"
   same doc, same ids, same chunk count = clean replace (incremental indexing, file 10)
```

Ordinal ids by chunk index are what make re-indexing a doc *overwrite* rather than *duplicate* — that's the incremental-indexing primitive (file 10). And `text` in meta is what lets the search tool build a citation snippet without a second lookup (file 11).

**Move 3 — the principle.** Chunking sets the resolution of retrieval, and there's no free lunch: a boundary either respects meaning (costs a parser/tokenizer and determinism) or it's mechanical (costs the occasional split fact). aptkit takes mechanical + overlap because overlap buys back most of what mechanical loses, for the price of a little duplicate storage. Be honest about the failure: fixed-size *will* land mid-sentence sometimes, and a fact spanning more than your overlap window still gets split. If your corpus is markdown or code, the structural cut is strictly better — which is the exercise.

## Primary diagram

```
chunking end to end
  doc.text (long)
        │  chunkText(text, 512, 64)
        ▼
  ┌──────────┬──────────┬──────────┐   each window overlaps prev by 64 chars
  │ chunk 0  │ chunk 1  │ chunk 2  │   step = 448
  └────┬─────┴────┬─────┴────┬─────┘
       │ embed    │ embed    │ embed
       ▼          ▼          ▼
   [vec0]      [vec1]      [vec2]
       │          │          │   id = `${doc.id}#${i}`, meta carries text
       ▼          ▼          ▼
   ┌─────────────────────────────┐
   │  VectorStore (one row each)  │  re-index → same ids → overwrite
   └─────────────────────────────┘
```

One doc becomes N overlapping chunks, each its own searchable, citable, overwritable unit.

## Elaborate

Fixed-size is the floor every RAG tutorial starts at; the industry moved up to **recursive character splitting** (LangChain's default — split on paragraph, then sentence, then char, preferring the largest natural boundary that fits) and **semantic chunking** (embed sentences, cut where adjacent similarity drops). Adjacent knobs: **chunk size vs context budget** (bigger chunks = fewer, richer hits but more tokens stuffed per result), and **token-based vs char-based** sizing (aptkit's char-based is deterministic but doesn't map cleanly to the model's token limit — 512 chars ≈ 128 tokens, comfortably inside nomic). Read next: `01-embeddings.md` (what each chunk becomes) and `10-incremental-indexing.md` (why the `#i` id scheme matters).

## Project exercises

### Add structural (markdown-heading) chunking as a second strategy

- **Exercise ID:** `EX-RAG-03a`
- **What to build:** A `chunkMarkdown(text)` that splits on heading boundaries (`#`, `##`, …), keeps each section whole when it fits, and falls back to the sliding window for oversized sections — selectable so `indexDocument` can choose per-doc.
- **Why it earns its place:** Most real corpora (docs, READMEs, this very guide) are markdown with author-chosen boundaries. Structural chunking respects them and stops the mid-sentence splits fixed-size suffers. The comment in `chunker.ts:11` already promises "a smarter splitter is a later drop-in" — this is that drop-in. Phase 2A.
- **Files to touch:** new `packages/retrieval/src/markdown-chunker.ts`; thread a strategy choice through `indexDocument` (`packages/retrieval/src/pipeline.ts:32-47`); export from `packages/retrieval/src/index.ts`.
- **Done when:** a markdown doc chunks on headings (verified by test), each chunk's `text` starts at a heading, and oversized sections still respect `CHUNK_SIZE` via the fallback.
- **Estimated effort:** `1–4hr`

### Prove overlap saves a boundary-straddling fact

- **Exercise ID:** `EX-RAG-03b`
- **What to build:** A test that places a known fact across the 448-char boundary and asserts at least one chunk contains it whole with overlap, but neither does with `overlap=0`.
- **Why it earns its place:** Overlap is the chunker's whole reason for existing past line 24 — pin its payoff so a future "optimization" that drops overlap visibly fails.
- **Files to touch:** test file alongside `packages/retrieval/src/chunker.ts`.
- **Done when:** the test passes with `CHUNK_OVERLAP=64` and fails (fact split) with `overlap=0`.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Why overlap chunks at all — isn't it just wasted storage?**

```
no overlap:  ...renewal takes | ten days...     fact SPLIT, neither chunk scores
overlap 64:  ...renewal takes ten days... | ... fact WHOLE in chunk i
   cost: 64 dup chars/chunk    benefit: facts at seams survive
```

Anchor: overlap is insurance against facts dying at boundaries; you pay duplicate storage to stop losing the one sentence that straddles a cut.

**Q: Why fixed-size by character instead of by token or by sentence?**

```
char-based:  deterministic, zero deps, may split mid-sentence  ← aptkit
token-based: maps to model limit, needs a tokenizer
sentence:    respects meaning, needs NLP, non-deterministic
```

Anchor: aptkit optimizes for a from-scratch pipeline — determinism and zero dependencies beat boundary-quality, and the contract above the chunker doesn't change when you later swap in a smarter splitter.

## See also

- [01-embeddings.md](01-embeddings.md) — what each chunk becomes
- [10-incremental-indexing.md](10-incremental-indexing.md) — the `${doc.id}#${i}` overwrite primitive
- [11-rag.md](11-rag.md) — how chunk `text` in meta becomes a citation
