# Chunking — the chunk is the unit of retrieval

**Industry names:** chunking, text splitting, document segmentation · *Industry
standard*

## Zoom out, then zoom in

Chunking decides *what* you embed and therefore *what* you can retrieve. It sits
between raw documents and the embedder. AptKit has a genuine structural splitter
already — but it feeds content generation, not retrieval. Here's the map, with
the splitter that exists marked separately from the retrieval wiring that does
not.

```
  Zoom out — chunking's place (and AptKit's existing splitter)

  ┌─ Workflows layer (packages/workflows) — EXISTS ──────────────────┐
  │  splitMarkdownSections(md) ──► sections   ◄── structural chunking │
  │       │                                       (for content gen,   │
  │       └─► round-robin angles ──► generate         NOT retrieval)  │
  └──────────────────────────────────────────────────────────────────┘

  ┌─ (new) Retrieval layer — packages/retrieval — DOES NOT EXIST ────┐
  │  chunk(doc) ──► chunks ──► embed each ──► index   ★ THIS CONCEPT  │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  top-k chunks
  ┌─ Context layer (packages/context) ▼────────────────────────────────┐
  │  schemaSummary() + retrieved-chunks block ──► system prompt         │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: a **chunk** is the atomic span you embed and store as one vector. It is
the unit of retrieval — you get back whole chunks, never half a chunk. So the
chunk boundary is a *product* decision: too big and you retrieve irrelevant
padding around the one relevant sentence; too small and you retrieve a fragment
with no context. In AdvntrCue you tuned this. The thing to internalize: **the
chunking primitive already exists in AptKit (`splitMarkdownSections`) — it is
just not connected to any retrieval index.**

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

### Move 2.5 — current state vs future state

This is the one concept in this section where AptKit has half the machinery.
Worth drawing the gap precisely.

```
  Phase A (now) vs Phase B (retrieval) — same splitter, different sink

  Phase A — TODAY (content generation)
    sourceMarkdown ─► splitMarkdownSections ─► sections
                                                  │
                                                  ▼ round-robin by angle
                                          generate a content variant per section

  Phase B — IF RETRIEVAL ADDED
    sourceMarkdown ─► splitMarkdownSections ─► sections
                                                  │
                                                  ▼ embed each section
                                          store vector ─► search at query time

  what does NOT change: the splitter. The cut logic is reusable as-is.
  what's missing: the embed + index + search sink. That's the whole gap.
```

The takeaway: AptKit already *splits structurally*. Retrieval would reuse that
exact function and add an embedding sink. The chunking primitive is not the
missing piece — the index is.

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
  │ any text     │ s ± neighbours    │ (AptKit's splitter)  │
  └──────┬───────┴─────────┬─────────┴──────────┬───────────┘
         └─────────────────┼────────────────────┘
                           ▼
                  ordered list of chunks
                           │ embed each (NOT wired in AptKit)
                           ▼
                  vector index ──► top-k at query time
                           │
                           ▼  retrieved spans → schemaSummary seam → prompt
```

## Implementation in codebase

**Partially present — but NOT for retrieval.** AptKit ships exactly one chunking
primitive: `splitMarkdownSections` in
`packages/workflows/src/markdown-sections.ts`. It is real structural chunking,
and it's used by the content-generation workflow, not a retriever.

```
  packages/workflows/src/markdown-sections.ts  (lines 25-34)

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
       └─ this IS structural chunking: cut on ##, keep ###+ inside.
          The output `MarkdownSection[]` is exactly the granularity a
          retriever would embed — but nothing embeds it. The consumer is
          ensureGeneratedContent (content gen), via splitMarkdownSections
          at content-generation-workflow.ts:72.
```

The honest gap: `MarkdownSection` flows into `planContentVariant`
(`packages/workflows/src/content-generation-workflow.ts:139-157`) which picks a
section to *generate content for* by round-robin — not to embed and index. There
is no `embed(section)`, no vector store, no similarity search. The chunking step
of RAG exists in the repo; the retrieval that consumes chunks does not.

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
context to use it. AptKit's structural sections happen to be reasonable as *both*
the embed unit and the return unit, which is why structural chunking is a good
default.

Adjacent: embeddings ([01-embeddings.md](01-embeddings.md)) consume chunks;
incremental indexing ([10-incremental-indexing.md](10-incremental-indexing.md))
re-chunks only what changed; the chunk's freshness vs its source is
[09-stale-embeddings.md](09-stale-embeddings.md).

## Project exercises

*Provenance: Phase 2A — Retrieval foundations (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. **Case B — the splitter exists but is not
wired to retrieval; this exercise wires it.***

### Exercise — turn `splitMarkdownSections` into a retrieval chunker

- **Exercise ID:** `[B2A.3]` Phase 2A, chunking concept
- **What to build:** A `chunkDocument(markdown, { maxChars })` in
  `packages/retrieval` that calls the existing `splitMarkdownSections`, then
  splits any section longer than `maxChars` into fixed-size sub-chunks with a
  small overlap. Emit a `{ id, heading, content }[]` ready to embed.
- **Why it earns its place:** It reuses AptKit's real structural splitter (no
  reinventing) and adds the size-cap fallback that production chunkers need —
  demonstrating the structural-plus-size hybrid that's the field default.
- **Files to touch:** `packages/retrieval/src/chunk.ts` (imports
  `@aptkit/workflows` `splitMarkdownSections`),
  `packages/retrieval/test/chunk.test.ts`.
- **Done when:** A test proves a doc with one 5,000-char section under a 1,000-char
  cap yields multiple overlapping sub-chunks, while short sections pass through
  whole; chunk ids are stable across runs of identical input.
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
boundary survives in at least one chunk. Interestingly, our repo already has a
structural splitter — `splitMarkdownSections` — it's just wired to content
generation, not a retriever."
*Anchor: the unit you embed is the unit you're forever stuck retrieving.*

**Q: Sentence-window chunking — what's the trick?**
"Embed a narrow span — one sentence — for a precise match, but return that
sentence plus its neighbours so the model has context. The text you match on and
the text you hand the model don't have to be the same span."
*Anchor: narrow match, wide return.*

## Validate

- **Reconstruct:** Write the structural boundary rule from memory: split on `## `,
  keep `### `+ inside the section. Check against
  `packages/workflows/src/markdown-sections.ts:27`.
- **Explain:** Why does fixed-size chunking need overlap? (A fact spanning a cut
  point would otherwise appear fully in neither chunk and be unretrievable.)
- **Apply:** You point `splitMarkdownSections` at a markdown doc that's one giant
  paragraph with no `##`. How many chunks? (One — see the
  `sections.length === 0` fallback at `markdown-sections.ts:36`. That's the case
  the size-cap exercise fixes.)
- **Defend:** Why is structural chunking a good *default* but not sufficient
  alone? (It's only as good as the document's structure; a heading-less wall of
  text collapses to one chunk, so you need a size-cap fallback.)

## See also

- [01-embeddings.md](01-embeddings.md) — what each chunk becomes
- [10-incremental-indexing.md](10-incremental-indexing.md) — re-chunk only what changed
- [09-stale-embeddings.md](09-stale-embeddings.md) — chunk vector vs source drift
- [11-rag.md](11-rag.md) — the pipeline chunks feed
