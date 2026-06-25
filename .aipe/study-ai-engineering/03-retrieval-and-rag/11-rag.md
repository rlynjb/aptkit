# RAG — retrieve, augment, generate

**Industry names:** RAG, retrieval-augmented generation, grounded generation ·
*Industry standard*

## Zoom out, then zoom in

This is the anchor file — every other concept in this section is a part of the
machine assembled here. RAG is the end-to-end pipeline: fetch relevant text, get
it in front of the model, let it answer over it. AptKit now ships this for real
via `@aptkit/agent-rag-query` — and it ships the *agentic* shape: the model calls
`search_knowledge_base` mid-loop, gets ranked chunks back as a TOOL RESULT, and a
forced synthesis turn makes it answer over them with citations. The augment seam
is the tool boundary, not a pre-rendered prompt block.

```
  Zoom out — how RAG attaches in AptKit (agentic: retrieve-as-a-tool)

  ┌─ Retrieval layer (packages/retrieval) — EXISTS ──────────────────┐
  │  query ─► embed ─► InMemoryVectorStore.search ─► top-k chunks     │
  └──────────────────────────────────┬───────────────────────────────┘
                                      │  ranked chunks (TOOL RESULT)
  ┌─ Runtime loop (runAgentLoop) ──────▼───────────────────────────────┐
  │  model turn ─► calls search_knowledge_base ─► tool result back ─┐  │
  │      ▲                                                          │  │
  │      └──────────── loop (maxTurns 6, maxToolCalls 4) ◄──────────┘  │
  │  forced synthesis turn: answer OVER the chunks, cite sources  ◄ ★  │
  └──────────────────────────────────┬───────────────────────────────┘
                                      │  ModelProvider.complete()
  ┌─ Provider layer ──────────────────▼────────────────────────────────┐
  │  guarded Gemma (local) / fixture                                    │
  └─────────────────────────────────────────────────────────────────────┘
```

Zoom in: **RAG = retrieve → augment → generate.** You already shipped a one-shot
version in AdvntrCue (embed query → ANN over pgvector → top-k into a GPT-4 prompt
→ answer). AptKit's is the *successor*: retrieval is a tool the model steers, not
a block someone splices in before the call. The pattern's whole job is the same —
ground generation in text the model didn't have at training time. The single most
important judgment call is *when not to use it* — which this file ends on.

## Structure pass

**Layers.** Three, and the names are the pipeline: *retrieve* (a function of the
query → chunks), *augment* (the chunks reach the model — in AptKit, as a tool
result mid-loop), *generate* (the model answers, grounded). All three exist in
AptKit now: retrieve (`packages/retrieval`: embed + `InMemoryVectorStore` +
search), augment (`search_knowledge_base` returns ranked chunks into the loop),
generate (`runAgentLoop`'s forced synthesis turn).

**Axis — where does the answer's *evidence* come from?** Trace it across the
layers. Without RAG, evidence comes only from model weights (training data) plus
whatever's already in the prompt. With RAG, evidence comes from the *index* —
external, updatable text fetched at request time. RAG moves the source of truth
out of the weights and into a store you control.

**Seam.** The load-bearing seam is the augment boundary: the moment retrieved
chunks reach the model. In AptKit that is the `search_knowledge_base` **tool
boundary** — the model emits a tool call, the handler runs the query path, and
the ranked chunks come back as a tool result the next turn reads. It flips the
*trust/freshness* axis — text in the weights is frozen at training time; chunks
returned at this seam are as fresh as your index. Get this seam wrong (citations
without source ids, chunks returned without the `[docId]` label) and the model
can't attribute claims or tell you where an answer came from.

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
  RAG — the three-stage pipe (AptKit: agentic / retrieve-as-a-tool)

        user query
           │
           ▼
        model turn ──► "call search_knowledge_base(query)"  ◄ the model decides
           │
           ▼  retrieve: embed(query) → InMemoryVectorStore.search → top-k chunks
        ┌─────────────────── augment ─────────────────────────────┐
        │  ranked chunks come BACK as a TOOL RESULT into the loop  │
        │  each as "[docId] snippet"  (the citation form)          │
        └───────────────────────────┬─────────────────────────────┘
                                     ▼
                  forced synthesis turn: generate OVER the chunks
                                     │
                                     ▼
                          grounded answer + citations
```

The brain to hold: retrieval is just-in-time context, and in AptKit the model
*pulls* it — it issues the search itself rather than receiving a pre-built block.
The model stays generic; the per-request context arrives as a tool result.

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

**Stage 2 — augment.** The chunks reach the model as a tool result, each carrying
a source id so the model (and you) can attribute claims. In AptKit the
`search_knowledge_base` handler builds that result: it maps each `VectorHit` to a
`citation` string of the form `[docId] snippet`. That `[docId]` prefix is the
attribution; the synthesis turn is instructed to cite it.

```
  Stage 2 — augment via the search_knowledge_base tool boundary

  ┌─ Runtime loop (runAgentLoop) ─────────────────────────────────┐
  │  model turn ─► tool call: search_knowledge_base(query)         │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ handler runs the query path
  ┌─ Retrieval layer ─────────────▼───────────────────────────────┐
  │  pipeline.query ─► hits ─► toResult: "[docId] snippet"  ◄ cite │
  └───────────────────────────────┬───────────────────────────────┘
                                   │ ranked results return as TOOL RESULT
  ┌─ Runtime loop ────────────────▼───────────────────────────────┐
  │  next model turn reads the chunks; synthesis turn answers      │
  └────────────────────────────────────────────────────────────────┘

   the chunks are never spliced into the system prompt — they ride back
   through the tool channel, which is what makes this AGENTIC RAG
```

The boundary: never return chunks without a source id. The `[docId]` label is
what lets the model attribute a claim and what stops a citation-free answer.
Unlabelled chunks are an attribution black hole.

**Stage 3 — generate.** `runAgentLoop` runs the model over the loop, and after
the tool result lands it issues a *forced synthesis turn* — the
`synthesisInstruction` tells the model to "answer the question directly and
concisely, citing the sources you retrieved." That's the turn that turns chunks
into a grounded answer. If the loop produces nothing, the agent returns a fixed
`FALLBACK_ANSWER` rather than a fabricated one.

```
  Stage 3 — generate, instructed to ground

  system: "Always call search_knowledge_base first. Ground every answer in the
           retrieved chunks and cite their sources. If the KB doesn't contain
           the answer, say so plainly rather than guessing."
  loop:   model ─► search_knowledge_base ─► chunks back ─► synthesis turn
     │
     ▼  ModelProvider.complete()
  answer grounded in the chunks, with [docId] citations
     │
     ├─ chunks don't contain it → "say so plainly" (not a hallucination)
     └─ loop produced no text   → FALLBACK_ANSWER
```

The boundary: the system prompt's "ground every answer in the retrieved chunks /
if the KB lacks it, say so" is what converts retrieval into *grounding*. Without
it the model blends retrieved text with its own priors and you lose the one
guarantee RAG offers.

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

  AptKit now has BOTH sides live, which is exactly how you read the rule:
    • rag-query agent  → YES: a prose KB, grounded by VECTOR search
    • analytics agents → NO:  queryable metrics, grounded by EXACT tool calls
  Both ground via tools; only one needs a similarity index. The data shape
  decides. (Tool-call grounding is agentic retrieval — see
  .aipe/study-agent-architecture/02-agentic-retrieval/.)
```

The takeaway: AptKit ships both answers to the rule. The rag-query agent earns a
vector index because its source is a prose corpus where "relevant" is fuzzy. The
analytics agents deliberately don't — their source is queryable analytics, so a
tool that fetches the exact metric beats a similarity search every time. The rule
isn't abstract anymore: it's literally the line AptKit draws between its two kinds
of agent.

### Move 3 — the principle

RAG decouples *what the model knows* from *what the model was trained on*: the
weights provide reasoning and language, the index provides current, private,
specific facts. The art is the augment seam (clean, attributed evidence) and the
discipline is the threshold (don't retrieve when the model — or a direct tool
call — already has the answer).

## Primary diagram

The whole pipeline, every stage and the AptKit seam labelled.

```
  RAG end to end — AptKit agentic shape (retrieve-as-a-tool)

  ┌─ Generate loop (packages/runtime: runAgentLoop) ───────────────────┐
  │  system="always search first; ground answers; cite; else say so"   │
  │  model turn ─► tool call ────────────────┐                         │
  │      ▲                                    │                         │
  │      │  tool result (ranked chunks)       ▼                         │
  │  ┌─ Augment ──────────────────────────────────────────────────┐    │
  │  │  search_knowledge_base handler: toResult → "[docId] snippet" │    │
  │  └─────────────────────────────┬──────────────────────────────┘    │
  │                                │ runs the query path                │
  │  ┌─ Retrieval (packages/retrieval) ─────────────────────────────┐  │
  │  │  query ─embed─► InMemoryVectorStore.search ─► top-k chunks    │  │
  │  └──────────────────────────────────────────────────────────────┘  │
  │  forced synthesis turn ─► grounded answer + [docId] citations  ◄ ★  │
  └────────────────────────────────────────────────────────────────────┘
       provider: guarded Gemma (local) / fixture
```

## Implementation in codebase

**Shipped, as agentic RAG.** The agent is `RagQueryAgent` in
`packages/agents/rag-query/src/rag-query-agent.ts`. It wires a model (a guarded
Gemma), a tool registry holding `search_knowledge_base`, an optional injected
profile, and runs `runAgentLoop` with a least-privilege policy and a forced
synthesis turn. The whole augment-and-ground discipline lives in three places:
the system prompt, the tool policy, and the loop config.

```
  packages/agents/rag-query/src/rag-query-agent.ts  (lines 14-83)

  export const ragQueryToolPolicy = {                       ← lines 15-18
    capabilityId: RAG_QUERY_CAPABILITY_ID,
    allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   ← least privilege: search ONLY
  };

  const DEFAULT_SYSTEM_TEMPLATE = [                          ← lines 20-27
    'Always call search_knowledge_base first ...',     ← retrieve before answering
    'Ground every answer in the retrieved chunks and cite their sources.',
    'If the KB does not contain the answer, say so plainly rather than guessing.',
  ].join('\n');

  const FALLBACK_ANSWER = "I couldn't find anything ...";  ← line 31, no-result floor

  await runAgentLoop({                                       ← lines 66-80
    system: this.system, userPrompt: question, toolSchemas,
    maxTurns: 6, maxToolCalls: 4,                      ← bounded agentic loop
    synthesisInstruction: buildSynthesisInstruction(
      'Now answer the question directly and concisely, citing the sources ...',
    ),                                                 ← the forced grounding turn
  });
       │
       └─ no chunk block is spliced into `system`. The chunks arrive as a TOOL
          RESULT during the loop; the synthesis turn answers over them.
```

The grounding-with-citation is produced in the tool, not the prompt — the handler
turns each ranked hit into a `[docId] snippet` string:

```
  packages/retrieval/src/search-knowledge-base-tool.ts  (lines 108-118)

  function toResult(hit: VectorHit): SearchKnowledgeBaseResult {
    const docId = typeof hit.meta.docId === 'string' ? hit.meta.docId : hit.id;
    const text  = typeof hit.meta.text  === 'string' ? hit.meta.text  : '';
    const snippet = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    return {
      id: hit.id, score: hit.score,
      citation: snippet ? `[${docId}] ${snippet}` : `[${docId}]`,  ← the citation
      meta: hit.meta,
    };
  }
       │
       └─ the `[docId]` prefix is the attribution the synthesis turn cites.
          (The tool also has a minTopK floor — stops a weak local model from
          starving its own retrieval by passing top_k: 1.)
```

AptKit now ships BOTH halves of the lineage: a real vector index (chunk → embed →
`InMemoryVectorStore`), and the agentic loop that steers it. The analytics agents
still ground via exact tool calls (no vectors) — the above-threshold rule made
real, in the same repo.

## Elaborate

RAG (Lewis et al., 2020) named the pattern of conditioning generation on
retrieved passages, but the *idea* — answer over fetched evidence — predates
neural retrieval (open-domain QA, search-then-read). Its rise tracks the LLM era
because it solves the two things weights can't: staleness (training cutoff) and
privacy (your data was never in the corpus).

The frontier has moved past one-shot RAG toward *agentic* retrieval (retrieve,
read, decide whether to retrieve again) — which is exactly the shape the rag-query
agent has: the model calls `search_knowledge_base` inside `runAgentLoop` and the
loop bounds the back-and-forth. AptKit ships BOTH the vector foundation and the
agentic loop over it — vector search behind a tool the agent steers. The analytics
agents are the same agentic shape over *non*-vector tools (see
`.aipe/study-agent-architecture/02-agentic-retrieval/`); the rag-query agent is
that shape over a similarity index, which is what you reach for once the source is
a prose corpus instead of structured analytics endpoints.

Adjacent: the augment block is prompt engineering
([../02-context-and-prompts/](../02-context-and-prompts/)); grounding's failure
mode (confidently wrong on bad retrieval) is an eval concern
([../05-evals-and-observability/](../05-evals-and-observability/)); and the same
pipeline pointed at the agent's *own past* is conversation memory
([13-conversation-memory.md](13-conversation-memory.md)) — RAG over history, shipped
as `@aptkit/memory`.

## Project exercises

*Provenance: Phase 2B — RAG pipeline (C2.x). No `aieng-curriculum.md` present;
IDs are by-phase convention. **Case A — RAG is implemented (rag-query agent);
these exercises run it, measure it, and extend it past in-memory.***

### Exercise — run the agent, then measure its retrieval with precision@k

- **Exercise ID:** `[A2B.1]` Phase 2B, RAG anchor concept
- **What to build:** First run the live demo path
  (`npm run ask -w @aptkit/agent-rag-query`) against a small indexed corpus and
  watch the loop call `search_knowledge_base` and cite sources. Then add a
  `scorePrecisionAtK` (from `packages/evals`) harness over a labelled query set so
  the agent's retrieval has a number, not a vibe — a fixture provider keeps it
  deterministic.
- **Why it earns its place:** It closes the loop from "it answers" to "its
  retrieval is *good*" — the difference between a demo and a measured capability.
- **Files to touch:** a test under `packages/agents/rag-query/test/` (or
  `packages/retrieval/test/`) that indexes a fixture corpus, runs queries, and
  asserts a precision@k floor.
- **Done when:** A test reports precision@k for a handful of labelled queries and
  asserts it stays above a threshold; the demo answers a known question with a
  `[docId]` citation and answers an out-of-corpus question with the fallback.
- **Estimated effort:** `1–4hr`

### Exercise — swap InMemoryVectorStore for a durable store, same contract

- **Exercise ID:** `[A2B.2]` Phase 2B, persistence-behind-the-contract concept
- **What to build:** Stand the rag-query agent up over a durable `VectorStore`
  (the `PgVectorStore` / Supabase implementation) instead of `InMemoryVectorStore`,
  with no change to the pipeline or the agent — the swap happens entirely behind
  the `VectorStore` contract. Note: `PgVectorStore` lives in the separate **buffr**
  repo (out of aptkit scope); aptkit ships the in-memory store and the contract.
- **Why it earns its place:** It proves the seam is real — a different storage
  engine drops in without the agent noticing — and it's the actual path from a toy
  in-memory index to a production one.
- **Files to touch:** in buffr, a `PgVectorStore` implementing aptkit's
  `VectorStore`; in aptkit, only the wiring that constructs the pipeline.
- **Done when:** The same `RagQueryAgent` answers identically whether wired to the
  in-memory or the pg-backed store, proven by running the same query set through
  both.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: Walk me through a RAG pipeline. Where does the retrieved text actually go?**

```
  retrieve ─► augment ─► generate   (agentic: retrieve-as-a-tool)

  model ─► search_knowledge_base ─► chunks back as TOOL RESULT ─► synthesis ─► answer
                                       └── the augment seam: the tool boundary
```

"Three stages: retrieve — embed the query, search the index, take top-k; augment
— get those chunks in front of the model with source ids; generate — run the
model with an instruction to ground in them and cite. In our codebase it's
*agentic* RAG: the model calls `search_knowledge_base` mid-loop, the handler runs
the query path and returns ranked chunks as a tool result — each as `[docId]
snippet` — and a forced synthesis turn in `runAgentLoop` answers over them. The
augment seam is the tool boundary, not a block spliced into the system prompt.
That's the agentic shape — the model pulls retrieval rather than receiving it."
*Anchor: in agentic RAG the model steers retrieval; the augment seam is the tool
result, not a pre-rendered prompt block.*

**Q: When would you NOT add RAG?**
"When the task doesn't need external, changing, or private text — or when a
direct tool call already fetches the exact answer. We have both cases live in one
repo: the rag-query agent uses a vector index because its source is a prose KB,
while the analytics agents call a metric tool — exact data, no similarity search —
so RAG there would be pure cost. The data shape decides: fuzzy-relevant prose gets
vectors; queryable facts get a tool."
*Anchor: don't retrieve when a direct tool call already has the exact answer.*

## Validate

- **Reconstruct:** Write the three stages from memory — retrieve / augment /
  generate — and map each to AptKit: retrieve = `packages/retrieval` embed +
  `InMemoryVectorStore.search`; augment = the `search_knowledge_base` tool result;
  generate = `runAgentLoop`'s forced synthesis turn
  (`rag-query-agent.ts:66-80`).
- **Explain:** Where does the citation come from, and why does it matter? (The
  tool handler's `toResult` builds `[docId] snippet` at
  `search-knowledge-base-tool.ts:108-118`; the `[docId]` prefix is the attribution
  the synthesis turn cites — without it the answer can't say where it came from.)
- **Apply:** The analytics agents answer over read-only analytics tools. Should
  they use vector RAG? (No — above-threshold rule fails; they fetch exact data by
  tool call. The rag-query agent is the YES case — a prose KB grounded by vector
  search. Same agentic shape, different tool.)
- **Defend:** Why does the retriever live in `packages/retrieval` and reach the
  model through a tool rather than a prompt block? (Keeping retrieval behind the
  `search_knowledge_base` tool boundary lets the model *steer* it inside the loop —
  agentic RAG — and keeps the embedder/store deps out of the runtime contract.)

## See also

- [01-embeddings.md](01-embeddings.md) — the retrieve stage's first step
- [03-chunking-strategies.md](03-chunking-strategies.md) — the unit you retrieve
- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — better retrieval ordering
- [07-reranking.md](07-reranking.md) — the precision pass before augment
- [../05-evals-and-observability/05-precision-at-k.md](../05-evals-and-observability/05-precision-at-k.md) — how to measure the agent's retrieval quality
- [13-conversation-memory.md](13-conversation-memory.md) — the same pipeline over past exchanges (`@aptkit/memory`)
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — the short-term vs long-term taxonomy
- `.aipe/study-agent-architecture/` — the orchestration/loop internals the rag-query agent runs on
- the **buffr** repo — durable persistence (`PgVectorStore`/Supabase) and the live precision@k-over-real-corpus eval run (out of aptkit scope)
