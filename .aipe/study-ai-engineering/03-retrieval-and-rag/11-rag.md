# RAG — retrieve, augment, generate

**Industry names:** RAG, retrieval-augmented generation, grounded generation ·
*Industry standard*

## Zoom out, then zoom in

This is the anchor file — every other concept in this section is a part of the
machine assembled here. RAG is the end-to-end pipeline: fetch relevant text,
stuff it into the prompt, let the model answer over it. AptKit ships none of it,
but the *attach point* is unambiguous: the `schemaSummary()` /
`WorkspaceDescriptor` prompt-context seam, feeding `runAgentLoop` /
`generateStructured`.

```
  Zoom out — where a RAG pipeline would attach in AptKit

  ┌─ (new) Retrieval layer — packages/retrieval — DOES NOT EXIST ────┐
  │  query ─► embed ─► search index ─► top-k chunks                  │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  retrieved strings
  ┌─ Context layer (packages/context) ▼────────────────────────────────┐
  │  schemaSummary() ──┐                                                │
  │                    ├─► system prompt block  ★ AUGMENT happens here  │
  │  retrieved chunks ─┘                                                │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  system: string
  ┌─ Runtime layer (packages/runtime) ▼────────────────────────────────┐
  │  runAgentLoop({ system, ... })  /  generateStructured(...)  ◄ GEN   │
  └──────────────────────────────────┬────────────────────────────────┘
                                      │  ModelProvider.complete()
  ┌─ Provider layer ──────────────────▼────────────────────────────────┐
  │  anthropic / openai / fixture                                       │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: **RAG = retrieve → augment → generate.** You already shipped this in
AdvntrCue (embed query → ANN over pgvector → top-k into a GPT-4 prompt → answer,
with session memory). The pattern's whole job is to ground generation in text the
model didn't have at training time. The single most important judgment call is
*when not to use it* — which this file ends on.

## Structure pass

**Layers.** Three, and the names are the pipeline: *retrieve* (a function of the
query → chunks), *augment* (splice chunks into the prompt — the AptKit
`schemaSummary` seam), *generate* (the model answers, grounded). Two of the three
already exist in AptKit — augment (`schemaSummary` renders a context block) and
generate (`runAgentLoop`/`generateStructured`). Only retrieve is missing.

**Axis — where does the answer's *evidence* come from?** Trace it across the
layers. Without RAG, evidence comes only from model weights (training data) plus
whatever's already in the prompt. With RAG, evidence comes from the *index* —
external, updatable text fetched at request time. RAG moves the source of truth
out of the weights and into a store you control.

**Seam.** The load-bearing seam is the augment boundary: the moment retrieved
strings become part of the system prompt. In AptKit that is the
`schemaSummary()` output boundary in `packages/context`. It flips the *trust/
freshness* axis — text on the model side is frozen at training time; text spliced
in at this seam is as fresh as your index. Get this seam wrong (bad formatting,
no source attribution, chunks dumped without delimiters) and the model can't tell
evidence from instruction.

## How it works

You already know the shape: a `fetch()` that grabs data, then a render that
interpolates it into a template. RAG is that — fetch relevant chunks, interpolate
them into the prompt — with the fetch being a similarity search instead of a REST
call.

### Move 1 — the mental model

The shape is a three-stage pipe. The query forks: it goes to the retriever to
fetch evidence, and the evidence rejoins it in the prompt before the model sees
anything.

```
  RAG — the three-stage pipe

        user query
           │
           ├──────────────► retrieve: embed(query) → search → top-k chunks
           │                                                      │
           ▼                                                      ▼
        ┌─────────────────── augment ─────────────────────────────┐
        │  system prompt = instructions + [chunk1, chunk2, ...] +  │
        │                  schemaSummary(workspace)  +  query      │
        └───────────────────────────┬─────────────────────────────┘
                                     ▼
                              generate (model answers OVER the chunks)
                                     │
                                     ▼
                          grounded answer (+ optional citations)
```

The brain to hold: retrieval is just-in-time context. The model stays generic;
the *prompt* gets specific, per request.

### Move 2 — the pipeline, one stage at a time

**Stage 1 — retrieve.** Embed the query, search the index, take the top-k chunks.
This is everything the first ten files in this section build: chunking decided
the units, embeddings made them comparable, the vector DB stores them, hybrid +
rerank order them best-first.

```
  Stage 1 — retrieve (assembled from the earlier files)

  query ─embed─► q
     │
     ▼  search index (dense, or hybrid + RRF)
  candidate chunks [c_a, c_b, c_c, c_d, ...]
     │
     ▼  rerank (cross-encoder)  ── optional but high-leverage
  top-k = [c_b, c_a, c_d]      ← best-first, k small (3–8)
```

The boundary that bites: k is a budget, not "more is better." Past a point,
extra chunks dilute the signal and burn context window. Retrieve narrow.

**Stage 2 — augment.** Splice the chunks into the prompt as clearly delimited
evidence — labelled, ideally with source ids so the model (and you) can attribute
claims. In AptKit this is structurally identical to how `schemaSummary()` builds
its block: take structured input, render a deterministic string, drop it into
`system`.

```
  Stage 2 — augment via the AptKit schemaSummary seam (layers-and-hops)

  ┌─ Context layer ───────────────────────────────────────────────┐
  │  retrieved chunks ─► renderChunks() ─┐                          │
  │                                      ├─► system string          │
  │  WorkspaceDescriptor ─► schemaSummary()─┘                       │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ hop: system: string
  ┌─ Runtime layer ───────────────▼───────────────────────────────┐
  │  runAgentLoop({ system, userPrompt: query, ... })              │
  └────────────────────────────────────────────────────────────────┘

   the new renderChunks() sits BESIDE schemaSummary — same seam, same sink
```

The boundary: never paste chunks raw. Delimit them (`--- source: faq#cancel ---`)
so the model treats them as reference, not as instructions to obey. Unlabelled
chunks are an injection vector and an attribution black hole.

**Stage 3 — generate.** Run the model over the augmented prompt. In AptKit this
is the existing machinery untouched: `generateStructured` for a one-shot
grounded answer, or `runAgentLoop` if the answer needs tool calls on top of the
retrieved context. The retrieval is *additive* — it changes the prompt, not the
loop.

```
  Stage 3 — generate, instructed to ground

  system: "Answer using ONLY the sources below. If they don't cover it,
           say you don't know. Cite the source id."
          + [chunks]  + schemaSummary
  user:   the query
     │
     ▼  ModelProvider.complete()
  answer grounded in the chunks, with citations
     │
     └─ if the chunks don't contain it → "I don't know" (not a hallucination)
```

The boundary: the instruction "answer only from the sources, else say you don't
know" is what converts retrieval into *grounding*. Without it the model blends
retrieved text with its own priors and you lose the one guarantee RAG offers.

### Move 2.5 — the above-threshold rule (when NOT to add RAG)

This is the judgment that separates someone who's read about RAG from someone
who's run it. RAG has a real cost: an index to build and keep fresh, an extra
embed + search hop per request, latency, and a new failure mode (retrieves the
wrong chunks → confidently wrong answer). You add it *only* when the task needs
knowledge the model doesn't have and that changes over time.

```
  The above-threshold rule — does this task even need RAG?

  Does the answer depend on text NOT in the model's weights
  AND that text changes / is private / is large?
        │                                   │
       yes                                  no
        │                                   │
        ▼                                   ▼
  RAG earns its place               DON'T add RAG.
  (private docs, fresh data,        Prompt-stuff it, fine-tune,
   large corpus)                    or just let the model answer.

  AptKit's analytics agents are the "no" case: the model doesn't need
  a similarity index — it calls a tool to fetch the exact metric. Adding
  RAG there would be cost with no benefit. (That's agentic retrieval —
  see .aipe/study-agent-architecture/02-agentic-retrieval/.)
```

The takeaway: AptKit deliberately answers over *structured tool calls*, not a
similarity index, because its data is queryable analytics, not a prose corpus.
RAG would be the wrong tool for those agents. It would earn its place if AptKit
grew a body of prose — runbooks, past incident write-ups, capability docs — that
an agent should ground answers in.

### Move 3 — the principle

RAG decouples *what the model knows* from *what the model was trained on*: the
weights provide reasoning and language, the index provides current, private,
specific facts. The art is the augment seam (clean, attributed evidence) and the
discipline is the threshold (don't retrieve when the model — or a direct tool
call — already has the answer).

## Primary diagram

The whole pipeline, every stage and the AptKit seam labelled.

```
  RAG end to end — attached to the AptKit prompt-context seam

  ┌─ Retrieval (new: packages/retrieval) ──────────────────────────────┐
  │  query ─embed─► search index ─► candidates ─rerank─► top-k chunks   │
  └───────────────────────────────────────────────────┬────────────────┘
                                                        │ chunks
  ┌─ Augment (packages/context) ───────────────────────▼────────────────┐
  │  renderChunks(chunks) + schemaSummary(workspace) ──► system string   │
  │      (delimited, source-labelled — the load-bearing seam)            │
  └───────────────────────────────────────────────────┬────────────────┘
                                                        │ system: string
  ┌─ Generate (packages/runtime) ──────────────────────▼────────────────┐
  │  generateStructured / runAgentLoop                                   │
  │    system="answer ONLY from sources, cite ids, else say don't know"  │
  └───────────────────────────────────────────────────┬────────────────┘
                                                        │ complete()
  ┌─ Provider ─────────────────────────────────────────▼────────────────┐
  │  anthropic / openai / fixture ──► grounded answer + citations        │
  └──────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Not yet implemented in AptKit.** There is no retriever, no index, and no
augment-from-chunks step anywhere in the repo. Two of the three RAG stages do
exist and are reusable as-is: *augment* — `schemaSummary()` in
`packages/context/src/workspace-summary.ts:11-52` already renders structured
input into a deterministic system-prompt block, which is precisely where a
`renderChunks()` would sit beside it; and *generate* — the runtime's
`generateStructured` / `runAgentLoop` already take a `system` string and run the
model over it. The only missing stage is *retrieve*: a new `packages/retrieval`
with `embed` + index + search.

```
  packages/context/src/workspace-summary.ts  (lines 39-51) — the AUGMENT seam

  return [
    `Project: ${workspace.projectName} (${workspace.projectId})`,   ← structured
    `Total customers: ${workspace.totalCustomers.toLocaleString()}`,    input...
    ...
    eventHeading,
    eventsText,                          ← ...flattened into a prompt block
    '',
    `Customer properties: ${customerPropsText}`,
  ].join('\n');
       │
       └─ a retrieved-chunks block would be assembled the SAME way and
          concatenated into the same `system` string. This function is the
          template every AptKit prompt-context renderer follows; RAG's
          augment stage is a sibling renderer, not a new layer.
```

The honest gap: nothing produces `chunks` to feed that sibling renderer. AptKit's
agents instead ground via tool calls (agentic retrieval), which is why no vector
RAG exists — and, for those agents, correctly so (the above-threshold rule).

## Elaborate

RAG (Lewis et al., 2020) named the pattern of conditioning generation on
retrieved passages, but the *idea* — answer over fetched evidence — predates
neural retrieval (open-domain QA, search-then-read). Its rise tracks the LLM era
because it solves the two things weights can't: staleness (training cutoff) and
privacy (your data was never in the corpus).

The frontier has moved past one-shot RAG toward *agentic* retrieval (retrieve,
read, decide whether to retrieve again) — which is exactly the shape AptKit's
analytics agents already have over tools. So in a real sense AptKit shipped the
*successor* to vector RAG without shipping vector RAG: see
`.aipe/study-agent-architecture/02-agentic-retrieval/`. The vector foundation in
this section is what you'd add if the *source* became a prose corpus instead of
structured analytics endpoints.

Adjacent: the augment block is prompt engineering
([../02-context-and-prompts/](../02-context-and-prompts/)); grounding's failure
mode (confidently wrong on bad retrieval) is an eval concern
([../05-evals-and-observability/](../05-evals-and-observability/)); long-term
agent memory is RAG over the agent's own past
([../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md)).

## Project exercises

*Provenance: Phase 2B — RAG pipeline (C2.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. **Case B — RAG is not implemented; this is the
capstone build that assembles the whole section.***

### Exercise — a grounded "docs query" capability over capability docs

- **Exercise ID:** `[B2B.1]` Phase 2B, RAG anchor concept
- **What to build:** A minimal RAG capability that indexes AptKit's own `docs/`
  markdown (chunk → embed → in-memory index), and answers a natural-language
  question by retrieving top-k chunks, rendering them via a new `renderChunks()`
  beside `schemaSummary`, and calling `generateStructured` with an "answer only
  from sources, cite the doc, else say you don't know" system prompt.
- **Why it earns its place:** It assembles every part of this section into the
  one shape that matters, and it attaches at the real AptKit seam — proving you
  can land RAG without disturbing the runtime or provider boundary.
- **Files to touch:** `packages/retrieval/src/{chunk,embed,index,search}.ts`,
  `packages/context/src/render-chunks.ts` (sibling to `workspace-summary.ts`),
  a new `packages/agents/docs-query/` capability, and a unit test with a fixture
  provider.
- **Done when:** Asking "how do replay artifacts work?" retrieves the relevant
  `docs/` chunk and produces a cited answer; asking something not in the docs
  yields "I don't know" rather than a fabricated answer; both proven with a
  `FixtureModelProvider` test.
- **Estimated effort:** `1–2 days`

### Exercise — the above-threshold guard as an explicit decision

- **Exercise ID:** `[B2B.2]` Phase 2B, when-not-to-RAG concept
- **What to build:** Add a one-paragraph `RETRIEVAL.md` in `docs/` (or a doc
  comment on the new capability) that records the above-threshold decision: which
  AptKit agents should *not* use RAG (the analytics agents — they call tools) and
  which would (a future prose-corpus agent). Encode it as a guard that throws if
  someone wires the docs-query retriever into an analytics agent's tool policy.
- **Why it earns its place:** Knowing when *not* to add RAG is the senior signal;
  making that decision executable (a guard) rather than a comment is the AptKit
  way (capabilities are config + policy).
- **Files to touch:** `docs/RETRIEVAL.md`,
  `packages/retrieval/src/applicability-guard.ts`, a unit test.
- **Done when:** Wiring the retriever into an analytics-agent capability fails a
  test with a clear "this task is below the RAG threshold — use tool calls"
  message.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Walk me through a RAG pipeline. Where does the retrieved text actually go?**

```
  retrieve ─► augment ─► generate

  query ─► top-k chunks ─► [chunks + schemaSummary] = system ─► model ─► answer
                              └── the augment seam: chunks become prompt text
```

"Three stages: retrieve — embed the query, search the index, take top-k;
augment — splice those chunks into the system prompt as delimited, source-
labelled evidence; generate — run the model with an instruction to answer only
from the sources. In our codebase the augment seam already exists as
`schemaSummary` in `packages/context` — it renders structured input into a prompt
block. A RAG retriever would render chunks into a sibling block right there, then
hand the `system` string to `runAgentLoop` unchanged."
*Anchor: retrieval changes the prompt, not the loop; the augment seam is where
chunks become text.*

**Q: When would you NOT add RAG?**
"When the task doesn't need external, changing, or private text — or when a
direct tool call already fetches the exact answer. Our analytics agents are that
case: the model calls a metric tool, not a similarity index, so RAG would be pure
cost. RAG earns its place when you have a prose corpus the model wasn't trained on
and that changes over time."
*Anchor: don't retrieve when the model — or a tool — already has the answer.*

## Validate

- **Reconstruct:** Write the three stages from memory — retrieve / augment /
  generate — and name which two already exist in AptKit (`schemaSummary` augment;
  `generateStructured`/`runAgentLoop` generate) and which is missing (retrieve).
- **Explain:** Why must chunks be delimited and source-labelled in the prompt?
  (So the model treats them as reference not instruction — unlabelled chunks are
  an injection vector and an attribution black hole.) See the augment seam at
  `packages/context/src/workspace-summary.ts:39-51` for the rendering pattern to
  mirror.
- **Apply:** The query agent answers over ~49 read-only analytics tools. Should
  it use RAG? (No — above-threshold rule fails; it fetches exact data by tool
  call. That's agentic retrieval, not vector RAG.)
- **Defend:** Why add the retriever as a new `packages/retrieval` rather than
  inside `packages/runtime`? (Runtime is provider-neutral foundation with no
  internal deps; the retriever depends on an embedder adapter and would belong in
  its own package feeding the context layer — keeping the runtime contract clean.)

## See also

- [01-embeddings.md](01-embeddings.md) — the retrieve stage's first step
- [03-chunking-strategies.md](03-chunking-strategies.md) — the unit you retrieve
- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — better retrieval ordering
- [07-reranking.md](07-reranking.md) — the precision pass before augment
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — long-term memory is RAG over the agent's past
- `.aipe/study-agent-architecture/02-agentic-retrieval/` — the loop-driven retrieval AptKit actually ships
