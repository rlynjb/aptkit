# Chunking — the chunk is the unit of retrieval

**Industry names:** chunking, text splitting, document segmentation · *Industry
standard*

## Zoom out, then zoom in

Chunking decides *what* you embed and therefore *what* you can retrieve. It sits
between raw documents and the embedder. AptKit now ships *two* chunkers, and they
feed two different sinks: a fixed-size character chunker that feeds retrieval
(`packages/retrieval/src/chunker.ts`), and the older structural splitter that
feeds content generation (`splitMarkdownSections`). Here's the map.

```
  Zoom out — chunking's place (AptKit ships TWO chunkers, two sinks)

  ┌─ Retrieval layer (packages/retrieval) — EXISTS ──────────────────┐
  │  chunkText(doc.text) ──► chunks ──► embed each ──► index  ★ HERE  │
  │     fixed-size 512/64 character windows (the retrieval chunker)   │
  └──────────────────────────────────┬───────────────────────────────┘
                                      │  top-k chunks
  ┌─ Tool boundary ────────────────────▼───────────────────────────────┐
  │  search_knowledge_base returns ranked chunks as a TOOL RESULT      │
  └─────────────────────────────────────────────────────────────────────┘

  ┌─ Workflows layer (packages/workflows) — EXISTS ──────────────────┐
  │  splitMarkdownSections(md) ──► sections   ◄── structural chunking │
  │       │                                       (for content gen,   │
  │       └─► round-robin angles ──► generate         NOT retrieval)  │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: a **chunk** is the atomic span you embed and store as one vector. It is
the unit of retrieval — you get back whole chunks, never half a chunk. So the
chunk boundary is a *product* decision: too big and you retrieve irrelevant
padding around the one relevant sentence; too small and you retrieve a fragment
with no context. In AdvntrCue you tuned this. The thing to internalize: **AptKit's
retrieval pipeline chunks fixed-size by character (`chunkText`), while content
generation chunks structurally (`splitMarkdownSections`) — same primitive, two
boundary rules, two sinks.**

## Structure pass

**Layers.** Two: the *splitter* (turns one document into many chunks by some
boundary rule) and the *retrieval contract* (whatever the splitter emits is the
granularity you can ever fetch — the splitter's output type is the index's input
type).

**Axis — what determines a boundary?** Trace *where do we cut?* across the three
strategies. Fixed-size cuts by character count (boundary = arithmetic). Sentence-
window cuts by sentence then pads with neighbours (boundary = punctuation +
overlap). Structural cuts by the document's own headings (boundary = the author's
structure). Same axis, three answers — and the answer determines retrieval
quality.

**Seam.** The load-bearing seam is the chunk boundary itself: it flips the *unit
of meaning* from "whole document" to "one retrievable span." Cut it in the wrong
place and you sever a sentence from the context that makes it answerable — the
retriever then returns a chunk that is technically a top hit but useless to the
model.

## How it works

You already split text all the time — `markdown.split('\n\n')` for paragraphs,
`text.slice(0, 500)` for a preview. Chunking is that, but the cut points are
chosen so each piece stands alone well enough to answer a question.

### Move 1 — the mental model

The shape: one document becomes an ordered list of spans, each small enough to
embed meaningfully and self-contained enough to be useful on its own.

```
  Chunking — one document → many retrievable spans

  ┌──────────────── document ────────────────┐
  │ ## Refunds                                │
  │ Refunds take 5 days...                    │ ─► chunk 1  ●vector
  │ ## Cancellation                           │
  │ To cancel, go to settings...              │ ─► chunk 2  ●vector
  │ ## Shipping                                │
  │ We ship in 2 days...                      │ ─► chunk 3  ●vector
  └───────────────────────────────────────────┘
        each chunk = one embedding = one retrievable unit
        retrieve chunk 2 ⇒ you get the WHOLE cancellation span, not half
```

### Move 2 — the three strategies, one at a time

**Strategy 1 — fixed-size (with overlap).** Cut every N characters (or tokens),
with an overlap window so a sentence straddling a boundary survives in at least
one chunk. Dead simple, works on any text, ignores structure entirely.

```
  Fixed-size with overlap — execution trace (N=100, overlap=20)

  text length = 250 chars
  chunk 1: chars   0..100
  chunk 2: chars  80..180   ← 20-char overlap with chunk 1
  chunk 3: chars 160..250   ← 20-char overlap with chunk 2

  why overlap: a sentence spanning char 95..110 is whole in chunk 2,
  so it's not severed at the boundary
```

The boundary that bites: with no overlap a fact split across a cut point appears
in *neither* chunk fully, and the retriever can never return it intact.

**Strategy 2 — sentence-window.** Embed one sentence per chunk for precise
matching, but at retrieval time return that sentence *plus its neighbours* so the
model gets context. The match is precise; the returned context is wide.

```
  Sentence-window — narrow match, wide return

  embed:    [s1] [s2] [s3] [s4] [s5]     ← one vector per sentence
  query best-matches s3
  return:   ... [s2] [s3] [s4] ...        ← window of ±1 around the hit
            └── precise match on s3, but model sees the surrounding context
```

The boundary: pick the window too wide and you're back to retrieving padding;
too narrow and the model gets a contextless fragment.

**Strategy 3 — structural.** Cut on the document's own structure — markdown
headings, sections, list items. Each chunk is a semantically complete unit the
author already delimited. This is exactly what AptKit's `splitMarkdownSections`
does: split on `##`, keep `###`+ inside the current section.

```
  Structural — cut on the author's headings (the AptKit splitter's rule)

  ## Refunds          ┐
  text...             ├─► chunk { heading: "Refunds", content: "text..." }
  ### Edge cases      ┘   (### stays INSIDE — not its own chunk)
  ## Cancellation     ┐
  text...             ├─► chunk { heading: "Cancellation", content: "..." }
                      ┘
  boundary rule: split on "## " only; never on "### "
```

The boundary: structural chunking is only as good as the document's structure. A
wall of text with no headings collapses to one giant chunk — which is why
real pipelines often combine structural + a size cap (split a too-big section
further by fixed-size).

### Move 2.5 — two chunkers, two sinks

AptKit ships two chunkers that pick *different* boundary rules for *different*
sinks. Worth drawing the split precisely, because it's the live answer to "which
strategy and why."

```
  Two chunkers, two sinks — same primitive, different boundary rule

  Retrieval (packages/retrieval) — fixed-size by character
    doc.text ─► chunkText (512/64 windows) ─► chunks
                                                │
                                                ▼ embed each chunk
                                        store vector ─► search at query time

  Content generation (packages/workflows) — structural
    sourceMarkdown ─► splitMarkdownSections ─► sections
                                                │
                                                ▼ round-robin by angle
                                        generate a content variant per section
```

The interesting part: structural is usually the *better* default (each chunk is
a complete thought), yet retrieval here picks fixed-size. That's deliberate —
see the next section for why a from-scratch in-memory pipeline wants the dumb,
deterministic, tokenizer-free cut first, with the smarter splitter as a later
drop-in behind the same `chunkText`-shaped seam.

### Move 3 — the principle

The chunk boundary is the granularity contract of the entire retrieval system:
you can only ever retrieve whole chunks, so the cut decides the ceiling on
relevance. Cut on meaning (structure) where you can, fall back to size with
overlap where you can't, and remember that the unit you embed is the unit you're
forever stuck retrieving.

## Primary diagram

The decision and the pipeline in one frame.

```
  Chunking — strategy choice → pipeline

  document
     │
     ▼  pick a boundary rule
  ┌──────────────┬───────────────────┬─────────────────────┐
  │ fixed-size   │ sentence-window   │ structural (## )     │
  │ + overlap    │ embed s, return   │ author's headings    │
  │ AptKit RETR. │ s ± neighbours    │ AptKit content-gen   │
  └──────┬───────┴─────────┬─────────┴──────────┬───────────┘
         └─────────────────┼────────────────────┘
                           ▼
                  ordered list of chunks
                           │ embed each (chunkText, wired in retrieval)
                           ▼
                  vector index ──► top-k at query time
                           │
                           ▼  ranked chunks returned as a TOOL RESULT
```

## Implementation in codebase

**Two chunkers, two boundary rules.** AptKit ships a fixed-size character chunker
for retrieval (`packages/retrieval/src/chunker.ts`) and a structural splitter for
content generation (`splitMarkdownSections`). The retrieval one is the new arrival
and the surprising choice — fixed-size, not structural — so look at it first.

```
  packages/retrieval/src/chunker.ts  (lines 16-31) — the RETRIEVAL chunker

  export function chunkText(text, size = 512, overlap = 64): string[] {
    if (text.length === 0) return [];          ← empty doc → no chunks
    if (text.length <= size) return [text];     ← fits in one window → one chunk

    const step = Math.max(1, size - overlap);   ← slide forward by size-overlap
    const chunks: string[] = [];                   (512-64 = 448 chars/step)
    for (let start = 0; start < text.length; start += step) {
      chunks.push(text.slice(start, start + size));  ← a 512-char window
      if (start + size >= text.length) break;        ← last window covers the tail
    }
    return chunks;
  }
       │
       └─ pure arithmetic: no tokenizer, no headings, no sentence parsing.
          The 64-char overlap carries the seam between windows so a fact that
          straddles char 510 survives whole in the NEXT chunk. The output
          string[] is what indexDocument embeds (pipeline.ts:37-46).
```

Why fixed-size here, when structural is usually the better default? Because this
is a from-scratch in-memory pipeline, and fixed-size-by-character is the right
*first* cut for it: deterministic (same input → same chunks, every run), vendor-
neutral (no tokenizer dependency to pin per model), and trivially testable (the
boundaries are arithmetic you can assert). ~512 chars keeps each chunk inside
nomic-embed-text's context window. The doc comment is explicit that a smarter
semantic/recursive splitter is a later drop-in — the contracts above `chunkText`
don't change when you swap it.

The other chunker is structural, and it feeds content generation, not retrieval:

```
  packages/workflows/src/markdown-sections.ts  (lines 25-34) — content-gen chunker

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('## ') && !trimmed.startsWith('### ')) {  ← the boundary rule
      flush();                       ← close the current section
      heading = trimmed.slice(3).trim();   ← start a new one at this ##
    } else {
      body.push(line);               ← everything else accretes into the section
    }
  }
  flush();
       │
       └─ this IS structural chunking: cut on ##, keep ###+ inside. Its
          MarkdownSection[] flows into planContentVariant (content-generation-
          workflow.ts:139-157), picked round-robin to GENERATE content for —
          never embedded, never indexed. Different sink entirely.
```

The honest point: AptKit's retrieval uses the *dumber* strategy on purpose. The
structural splitter already existed and is arguably the nicer chunk shape, but
retrieval reached for fixed-size because a from-scratch pipeline is easier to
trust when its chunk boundaries are arithmetic.

## Elaborate

Chunking is the least glamorous and most outcome-determining knob in RAG. The
field's consensus has drifted from naive fixed-size toward structure-aware
splitting (LangChain's `RecursiveCharacterTextSplitter`, LlamaIndex's node
parsers, "semantic chunking" that cuts where embedding similarity drops between
adjacent sentences). The reason is empirical: retrieval quality is gated by
whether the relevant fact lives intact inside one chunk.

The subtle trap is the *embed-vs-return mismatch* (sentence-window): the text you
embed for matching need not be the text you hand the model. Embedding a short,
focused span gives a clean match; returning a wider window gives the model the
context to use it. AptKit sidesteps that mismatch entirely in retrieval: a
fixed-size chunk is the embed unit *and* the return unit — the same 512-char
window goes into the vector and comes back as the citation snippet. Simpler, at
the cost of the cleaner boundaries structural chunking would give. That trade is
the whole reason a structural-with-size-cap splitter is the natural next drop-in.

Adjacent: embeddings ([01-embeddings.md](01-embeddings.md)) consume chunks;
incremental indexing ([10-incremental-indexing.md](10-incremental-indexing.md))
re-chunks only what changed; the chunk's freshness vs its source is
[09-stale-embeddings.md](09-stale-embeddings.md).

## Project exercises

*Provenance: Phase 2A — Retrieval foundations (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. **Case A — the fixed-size retrieval chunker
ships; this exercise upgrades it to structural and proves the trade was real.***

### Exercise — swap the fixed-size chunker for structural, behind the same seam

- **Exercise ID:** `[A2A.3]` Phase 2A, chunking concept
- **What to build:** A `chunkText`-shaped replacement in `packages/retrieval`
  that calls the existing `splitMarkdownSections`, then size-caps any section
  longer than `maxChars` into fixed-size sub-chunks with overlap (structural with
  a size-cap fallback). Keep it behind the same `string[]`-returning seam the
  pipeline already calls so `indexDocument` doesn't change.
- **Why it earns its place:** It exercises the explicit drop-in the doc comment
  promises, reuses AptKit's real structural splitter, and — the point — lets you
  *measure* whether structural actually beats fixed-size here with
  `scorePrecisionAtK` (from `packages/evals`), before and after the swap.
- **Files to touch:** `packages/retrieval/src/chunker.ts`,
  `packages/retrieval/test/` (a chunker test plus a precision@k comparison over a
  small fixture corpus).
- **Done when:** A test proves a doc with one 5,000-char section under a 1,000-char
  cap yields multiple overlapping sub-chunks while short sections pass through
  whole; chunk ids are stable across runs; and a precision@k number is recorded
  for both strategies on the same corpus.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How do you chunk documents for retrieval, and why does the boundary
matter?**

```
  chunk = unit of retrieval ; you get back WHOLE chunks

  ## Cancellation          ┐
  To cancel, go to ...     ├─► one chunk, one vector, retrieved intact
                           ┘
  bad cut: "To cancel, go" | "to settings"  ← neither chunk answers the query
```

"The chunk is the unit of retrieval — you always get back whole chunks, so the
boundary sets the ceiling on relevance. I prefer structural chunking, cutting on
the document's own headings, because each chunk is then a complete thought. I
fall back to fixed-size with overlap for unstructured text so a fact straddling a
boundary survives in at least one chunk. Interestingly, our retrieval pipeline
actually went the other way — fixed-size by character (`chunkText`), not
structural — because it's a from-scratch in-memory pipeline and deterministic,
tokenizer-free boundaries were easier to trust. The structural splitter
(`splitMarkdownSections`) exists too, but it's wired to content generation; making
it the retrieval chunker is the planned drop-in."
*Anchor: the unit you embed is the unit you're forever stuck retrieving.*

**Q: Sentence-window chunking — what's the trick?**
"Embed a narrow span — one sentence — for a precise match, but return that
sentence plus its neighbours so the model has context. The text you match on and
the text you hand the model don't have to be the same span."
*Anchor: narrow match, wide return.*

## Validate

- **Reconstruct:** Write the fixed-size slide-window from memory: `step = size -
  overlap`, push `text.slice(start, start+size)`, break when `start+size >=
  text.length`. Check against `packages/retrieval/src/chunker.ts:24-29`.
- **Explain:** Why does fixed-size chunking need overlap? (A fact spanning a cut
  point would otherwise appear fully in neither chunk and be unretrievable —
  the 64-char `CHUNK_OVERLAP` carries it into the next window.)
- **Apply:** You call `chunkText` on a doc shorter than 512 chars. How many
  chunks? (One — the `text.length <= size` early return at `chunker.ts:22`.)
  And on `splitMarkdownSections` over a heading-less wall of text? (Also one,
  via its `sections.length === 0` fallback at `markdown-sections.ts:36`.)
- **Defend:** Why did retrieval pick fixed-size over structural, when structural
  is usually the better default? (Deterministic, vendor-neutral, tokenizer-free,
  trivially testable — the right first cut for a from-scratch in-memory pipeline;
  the structural-plus-size-cap splitter is an explicit later drop-in.)

## See also

- [01-embeddings.md](01-embeddings.md) — what each chunk becomes
- [10-incremental-indexing.md](10-incremental-indexing.md) — re-chunk only what changed
- [09-stale-embeddings.md](09-stale-embeddings.md) — chunk vector vs source drift
- [11-rag.md](11-rag.md) — the pipeline chunks feed
