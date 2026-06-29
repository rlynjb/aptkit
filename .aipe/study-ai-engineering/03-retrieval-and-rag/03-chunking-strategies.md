# Chunking strategies — fixed-size character windows

**Subtitle:** Chunking · splitting documents into embeddable units · *Industry standard*

## Zoom out, then zoom in

Chunking is the step nobody sees but everybody pays for. It sits on the index path,
between the raw document and the embedder, and it silently decides the granularity
of everything downstream: what a "hit" can possibly be, what a citation points at,
how much irrelevant text rides into the prompt.

```
  Zoom out — where chunking sits on the index path

  ┌─ indexDocument (pipeline.ts:32) ────────────────────────────┐
  │  doc.text ─► ★ chunkText ★ ─► embed ─► upsert               │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ chunkText(text, 512, 64)
  ┌─ chunker (chunker.ts) ────▼─────────────────────────────────┐
  │  ["…512 chars…", "…512 chars (64 overlap)…", …]             │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You have sliced an array into pages before — `slice(start, start +
pageSize)` in a loop, advancing by a step. aptkit's chunker is exactly that, over a
string of characters: fixed 512-character windows, advancing by `step = 512 - 64`
so consecutive windows overlap by 64. No tokenizer, no sentence parser, no model
call. The choice is deliberately dumb, and the reasons it is dumb are the lesson.

## Structure pass

**Layers.** Strategy (fixed-size by character) → implementation (`chunkText`,
`chunker.ts:16`) → constants (`CHUNK_SIZE = 512`, `CHUNK_OVERLAP = 64`, `chunker.ts:13`).

**Axis — state.** Trace what the chunker remembers: nothing. `chunkText` is a pure
function of `(text, size, overlap)` — same input, same chunks, forever. That
statelessness is the feature: it makes chunking deterministic and the index path
reproducible. The axis "does this depend on anything outside its arguments?" is
flatly *no*.

**Seam.** The function signature `chunkText(text, size, overlap)`. Everything above
it (the pipeline) treats chunking as "text in, strings out" and never names the
strategy. Swap in a semantic splitter behind this signature and `indexDocument`
does not change — the strategy is the swappable part, the contract is the boundary.

## How it works

### Move 1 — the mental model

You know the sliding-window pattern from pagination or rate limiting: a window of
fixed size, advanced by a step smaller than the window so consecutive windows
share an edge. Chunking is that pattern applied to a document. The overlap is the
shared edge — it exists so a fact sitting on a window boundary is not cut in half
and lost from both chunks.

```
  Sliding window over text — step = size - overlap

  text:  [────────────────────────────────────────────────]
  win 0: [───── 512 chars ─────]
  win 1:                 [───── 512 chars ─────]
                         └64┘ overlap: the shared edge
  win 2:                                 [───── 512 chars ───]
   advance by step = 512 - 64 = 448 each time
```

### Move 2 — the chunker as it actually runs

**The constants and why these numbers.** `chunker.ts:13` fixes the two knobs:

```ts
export const CHUNK_SIZE = 512;     // CHARACTERS, not tokens
export const CHUNK_OVERLAP = 64;   // characters carried between windows
```

512 *characters* (not tokens) keeps each chunk comfortably inside nomic's context
while staying granular enough to isolate one passage. Characters — not tokens —
because that needs no tokenizer dependency and is vendor-neutral: the same chunker
works regardless of which model embeds the result.

```
  Why character windows, not token windows

  token-based:  text ─► tokenizer (model-specific dep) ─► count ─► split
  char-based:   text ─► .length / .slice (built-in)    ─► split
                 deterministic · vendor-neutral · trivially testable
```

**The loop: slice and advance.** `chunkText` (`chunker.ts:16`) is a windowed slice:

```ts
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  if (text.length === 0) return [];
  if (text.length <= size) return [text];          // small doc → one chunk
  const step = Math.max(1, size - overlap);        // advance < window → overlap
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += step) {
    chunks.push(text.slice(start, start + size));
    if (start + size >= text.length) break;        // last window covers the tail
  }
  return chunks;
}
```

Two guards earn their place: empty text yields `[]` (the pipeline returns early on
that, `pipeline.ts:38`), and a sub-512 doc yields a single chunk untouched. The
`break` stops the loop once a window reaches the end, so there is no trailing
fragment chunk.

```
  chunkText control flow

  text == ""            ─► []
  text.length <= 512    ─► [text]            (one chunk, no overlap)
  else                  ─► slide windows, step 448, break at the tail
```

**Why overlap matters — the boundary fact.** Without overlap, a sentence split by a
window edge appears in neither chunk's *embedding* coherently — half its meaning is
in chunk N, half in chunk N+1, and neither vector represents the whole fact.
Overlap of 64 chars carries the seam into both windows so the fact survives.

```
  No overlap                       64-char overlap
  …token verifi│cation fails…      …token verification fails…
  win N ───────┘                   win N ──────────────────┘
  win N+1       └──────…            win N+1      └───────────…
  fact split, both vectors weak    fact intact in win N+1 too
```

**The chunk id ties back to the doc.** After chunking, `indexDocument` assigns each
chunk a stable id `${doc.id}#${i}` (`pipeline.ts:42`) and stores the chunk *text*
in `meta.text`. The index is the position in the window sequence — which is why
re-indexing a shorter doc can leave orphan high-index chunks (the deletion gap in
`10-incremental-indexing.md`).

### Move 3 — the principle

Pick the simplest chunker that is deterministic and vendor-neutral, and treat it as
a swappable strategy behind a one-line signature. Fixed-size-by-character wins by
default because it has no dependencies, reproduces exactly, and is trivially
testable — and chunking quality is rarely the retrieval bottleneck at small scale.
A semantic or recursive splitter is a `not yet exercised` upgrade you slot in
*behind the same signature* when measurement says chunking, not ranking, is the
limit.

## Primary diagram

```
  Chunking on the index path

  doc.text "…long markdown…"
        │ chunkText(text, 512, 64)        ── pure, deterministic
        ▼
  ["…512c (0–512)…", "…512c (448–960)…", "…512c (896–…)…"]
        │ each gets id `${doc.id}#${i}`, text in meta (pipeline.ts:42)
        ▼
  embed (one batched call) ─► upsert into VectorStore

  overlap 64 ─► boundary facts survive   |   strategy swappable behind chunkText()
```

## Elaborate

The temptation is to reach for a "smart" splitter immediately — sentence-aware,
recursive, model-tokenized. Resist it until measurement justifies it. A smarter
chunker adds a dependency (a tokenizer or NLP library), loses determinism (output
shifts with the dependency's version), and is harder to test — all to fix a problem
you may not have. aptkit's chunker is the right default precisely because retrieval
quality is gated by ranking and the corpus is small. When you do upgrade, the
`chunkText` signature is the seam: the pipeline (`pipeline.ts:37`) calls it
unchanged. Read `01-embeddings.md` for what happens to each chunk and
`10-incremental-indexing.md` for the orphan-chunk consequence of the `#index` id
scheme.

## Project exercises

### Add a recursive/semantic splitter behind the chunkText signature
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** an alternative splitter that prefers paragraph/sentence
  boundaries within a max size, exposed with the same `(text, size, overlap)`
  signature so `indexDocument` can call either.
- **Why it earns its place:** proving you can upgrade the strategy without touching
  the pipeline demonstrates the seam is real — and a before/after precision@k
  measurement shows you optimize from evidence, not vibes.
- **Files to touch:** a new `packages/retrieval/src/semantic-chunker.ts`,
  `packages/retrieval/src/pipeline.ts` (inject the splitter), a new test in
  `packages/retrieval/test/`, optionally `packages/evals/src/precision-at-k.ts` to
  compare.
- **Done when:** both chunkers pass the same boundary-fact test and a precision@k
  run reports a number for each.
- **Estimated effort:** `1–2 days`

### Make chunk size and overlap injectable per document
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** thread `size`/`overlap` from `RetrievalDocument.meta` (or a
  pipeline option) into `chunkText`, so code-heavy docs can use smaller windows.
- **Why it earns its place:** shows you can parameterize a strategy without breaking
  its determinism or the contract above it.
- **Files to touch:** `packages/retrieval/src/pipeline.ts`,
  `packages/retrieval/src/chunker.ts` (already parameterized — wire it through), a
  test in `packages/retrieval/test/`.
- **Done when:** a doc indexed with custom size produces the expected chunk count in
  a test.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Why chunk by character instead of by token?"**
Determinism and zero dependencies. Token-based chunking needs a model-specific
tokenizer, which ties the chunker to a vendor and shifts output across versions.
Character windows use `.slice` — reproducible, vendor-neutral, trivially testable.
512 chars sits inside nomic's context and is granular enough to isolate a passage;
the chunker stays a pure function of its arguments.

```
  token split → tokenizer dep, vendor-locked, version-fragile
  char split  → .slice, deterministic, vendor-neutral, testable
```
Anchor: *the dumb deterministic chunker wins until measurement says chunking is the bottleneck.*

**Q: "What does the 64-char overlap buy you?"**
It stops a fact straddling a window boundary from being split across two chunks and
weakened in both embeddings. By advancing the window by `step = 512 - 64 = 448`,
consecutive chunks share their 64-char seam, so a boundary-crossing sentence appears
whole in at least one chunk and embeds coherently.

```
  step = size - overlap = 448 ─► 64-char seam shared ─► boundary fact survives
```
Anchor: *overlap is the shared edge that keeps a boundary fact from falling between two chunks.*

## See also

- `01-embeddings.md` — what each chunk becomes (a 768-dim vector)
- `11-rag.md` — `indexDocument` calling the chunker, chunk ids and meta.text
- `10-incremental-indexing.md` — the `#index` id scheme and orphan chunks
- `04-vector-databases.md` — where the chunks are stored
- `05-evals-and-observability/01-eval-set-types.md` — measuring chunking via precision@k
