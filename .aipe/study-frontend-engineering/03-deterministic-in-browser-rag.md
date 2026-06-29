# Deterministic in-browser RAG

**Industry name(s):** client-side RAG / in-browser retrieval; deterministic fixture replay
of an agent loop. **Type:** Project-specific composition of industry-standard parts (the RAG
pipeline is `@aptkit/retrieval`; running it browser-side with a fake embedder is the local
move).

> The RAG *algorithm* — embedding, ANN/cosine search, ranking, precision@k/recall@k —
> belongs to `study-ai-engineering`. This file is about the *frontend* fact: the page runs
> that real pipeline entirely in the browser, with no network, so the RAG demo works on
> static GitHub Pages. The frontend interest is "how does a from-scratch RAG pipeline run
> client-side and stay deterministic."

## Zoom out, then zoom in

Every other analytics agent in Studio either replays a recorded fixture or calls a live
provider through the dev middleware. The RAG Query page does something different: it
constructs and runs the *actual* `@aptkit/retrieval` pipeline in the browser. Here's where
the in-browser pipeline (the runner in `agent-runners.ts`) sits.

```
  Zoom out — where in-browser RAG lives

  ┌─ View layer (RagQueryWorkspace.tsx) ─────────────────────┐
  │  select fixture · Run · Answer / Chunks / precision@k     │
  └───────────────────────────────┬──────────────────────────┘
                                  │ runRagQueryFixtureReplay(fixture)
  ┌─ Runner layer (agent-runners.ts) ─▼──────────────────────┐
  │  ★ fake embedder + InMemoryVectorStore + RagQueryAgent ★  │ ← we're here
  │    (the REAL @aptkit/retrieval pipeline, no network)      │
  └───────────────────────────────┬──────────────────────────┘
                                  │ scorePrecisionAtK / scoreRecallAtK
  ┌─ Library layer (@aptkit/*) ───▼──────────────────────────┐
  │  retrieval pipeline · RagQueryAgent · evals               │
  └───────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do you demo a RAG agent on a static host with no Ollama, no
embedding API, no vector DB — and still show real precision@k numbers?"* The answer:
substitute a deterministic keyword-hash embedder for the real one, keep every other piece of
the pipeline real, and replay recorded model turns instead of calling a model.

## Structure pass

**Layers:** the view (selection + display) → the runner (wires the pipeline) → the
`@aptkit/retrieval` + `@aptkit/agent-rag-query` + `@aptkit/evals` libraries.

**One axis — *what is real vs faked?*** This is the axis that makes the pattern click:

```
  Axis: "real component or stand-in?"

  embedding          → FAKED   (keyword-hash, agent-runners.ts:149)   ┐ swapped for
  model responses    → FAKED   (recorded Gemma turns, fixture)        ┘ determinism
  ──────────────────────────────────────────────────────────────────
  vector store       → REAL    (InMemoryVectorStore, cosine scan)     ┐
  index/query paths  → REAL    (createRetrievalPipeline)              │ exercised
  search tool        → REAL    (createSearchKnowledgeBaseTool)        │ for real
  agent loop         → REAL    (RagQueryAgent over runAgentLoop)      │
  scoring            → REAL    (scorePrecisionAtK / scoreRecallAtK)   ┘
```

**The seam that matters:** the `EmbeddingProvider` contract (`agent-runners.ts:149`). That
boundary is the one place the fake is injected — everything below it (store, search, rank,
agent, eval) is the production code path. The contract is what *lets* you swap the embedder
without touching the pipeline; that swap is the whole reason the demo can run offline.

## How it works

### Move 1 — the mental model

You know how you swap a real `fetch` for a stub in a test so the code under test runs without
the network? Same move, one layer down: the pipeline depends on an `EmbeddingProvider`
*interface*, so you inject a deterministic stand-in that returns a vector for any string
without calling Ollama. The pipeline doesn't know or care — it gets vectors, runs cosine
search, ranks. Determinism falls out because the fake embedder is a pure function of the
input text.

```
  The pattern — inject a fake at the one contract seam

  fixture.corpus (3 notes)                    fixture.modelResponses (recorded)
        │ index()                                   │ replay
        ▼                                           ▼
  fakeEmbedder ──vectors──► InMemoryVectorStore ◄──search── RagQueryAgent
   (keyword hash)            (REAL cosine scan)     tool_use  (REAL loop)
                                  │                                │
                                  └────── retrieved chunks ────────┤
                                                                   ▼
                                              scorePrecisionAtK / scoreRecallAtK
```

### Move 2 — the step-by-step walkthrough

**The fake embedder — deterministic by construction.** Each word is hashed to a bucket in a
64-dim vector; the vector is a bag-of-word-hashes count. No model, no randomness — the same
text always yields the same vector, so a replay is bit-for-bit repeatable.

```ts
// agent-runners.ts:146-165
const RAG_EMBED_DIM = 64;
function makeFixtureEmbedder(): EmbeddingProvider {
  return {
    id: 'fixture-embed',
    dimension: RAG_EMBED_DIM,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vector = new Array<number>(RAG_EMBED_DIM).fill(0);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
          let hash = 0;
          for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;  // djb-ish string hash
          vector[hash % RAG_EMBED_DIM] += 1;                                   // bucket count
        }
        return vector;
      });
    },
  };
}
```

The boundary condition: this captures *lexical* overlap only — no semantics. A query that
shares words with the relevant note retrieves it; a paraphrase with no shared words wouldn't.
That's fine, because the fixtures are written so the relevant note shares vocabulary with the
question (`rag-query-fixtures.ts:5-18`). It's a demo embedder, and it's honest about it: the
`id` is literally `'fixture-embed'`.

**Wiring the real pipeline.** Index the corpus, build the search tool with a `minTopK` floor,
register it. This is the production `@aptkit/retrieval` API, unchanged.

```ts
// agent-runners.ts:170-184
const embedder = makeFixtureEmbedder();
const store = new InMemoryVectorStore(RAG_EMBED_DIM);       // REAL cosine store
const pipeline = createRetrievalPipeline({ embedder, store });
for (const doc of fixture.corpus) {
  await pipeline.index({ id: doc.id, text: doc.text });     // doc → chunk → embed → upsert
}
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 3 });
const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });

const model = new QueryFixtureModelProvider(fixture.modelResponses);  // recorded Gemma turns
const agent = new RagQueryAgent({ model, tools, profile: fixture.profile,
  trace: { emit: (event) => trace.push(event) } });
```

The dimension (`64`) is passed to both the embedder and the store. A mismatch throws at
wiring time — the contract treats embedding dimension as a one-way door (per the project
context). That loud failure is a feature: a silent dimension mismatch would produce garbage
similarity scores.

**Reading retrieval back out of the trace.** The agent doesn't return the chunks it
retrieved; they're a side effect of the tool call. So the runner mines the trace for the
`tool_call_end` event and pulls the results out of it — the UI shows exactly what the agent
saw.

```ts
// agent-runners.ts:192-202
const toolEnd = trace.find(
  (event): event is Extract<CapabilityEvent, { type: 'tool_call_end' }> => event.type === 'tool_call_end',
);
const rawResult = toolEnd?.result;
const retrieved: RagRetrievedChunk[] =
  rawResult && typeof rawResult === 'object' && Array.isArray((rawResult as { results?: unknown }).results)
    ? (rawResult as { results: RagRetrievedChunk[] }).results
    : [];
```

This is the frontend reaching into the trace as a data source — the same trace `TracePanel`
renders is also the channel the workspace reads structured results from. The defensive shape
checks are the boundary guard: a malformed tool result degrades to an empty chunk list, not a
crash.

**Scoring — real eval metrics on the real retrieval.** `scorePrecisionAtK` / `scoreRecallAtK`
from `@aptkit/evals` compare retrieved doc ids against the fixture's `relevant` set
(`agent-runners.ts:202-211`). These drive the `Precision@1` / `Recall@k` metric tiles and
the green/neutral tone in the UI (`RagQueryWorkspace.tsx:75-86`).

```
  Layers-and-hops — Run click to scored UI

  ┌─ RagQueryWorkspace ─┐ hop1: run() → runRagQueryFixtureReplay(fixture)
  │ Run fixture button  │ ───────────────────────────────────────────────┐
  └─────────────────────┘                                                 ▼
  ┌─ runner (agent-runners) ─┐ hop2: index corpus → agent.answer(question)
  │ fake embed + REAL store  │   (RagQueryAgent emits tool_call_end into trace)
  └──────────────────────────┘                                            │
  ┌─ scoring (@aptkit/evals) ┐ hop3: scorePrecisionAtK(retrievedDocIds, relevant)
  │ precision@1 / recall@k   │ ───────────────────────────────────────────┐
  └──────────────────────────┘                                            ▼
  ┌─ RagQueryWorkspace ─┐ hop4: setResult → <Metric>, <ragChunk relevant>, <EvalPanel>
  │ render result       │   (relevant chunks highlighted; precision tile turns green)
  └─────────────────────┘
```

### Move 2 variant — the load-bearing skeleton

Strip it down and the pattern is: **one faked dependency at a contract seam, everything else
real, plus a deterministic replay of the model.** The load-bearing parts:

1. **The injected fake embedder at the `EmbeddingProvider` seam** — drop the injection (use
   the real Ollama embedder) and the page needs a local model running; the static demo dies.
2. **The real `InMemoryVectorStore` + pipeline** — drop these for a hard-coded result and you
   no longer demo retrieval at all, just print an answer. The point is that real cosine search
   ran.
3. **Recorded model responses** (`QueryFixtureModelProvider`) — drop these for a live model
   and you reintroduce nondeterminism and a network dependency.
4. **Trace-mining for the retrieved chunks** — drop it and the UI can't show *what* was
   retrieved, only the final answer; precision@k would have nothing to score against.

The `minTopK: 3` floor and the defensive result-shape checks are hardening.

### Move 3 — the principle

A good interface lets you replace the expensive, nondeterministic part of a pipeline with a
cheap deterministic stand-in *without touching the rest*. Here that single swap — real
embedder → keyword-hash embedder, behind the `EmbeddingProvider` contract — is what moves a
RAG agent from "needs Ollama + a vector DB + a model" to "runs in a browser tab on a static
host, with real, reproducible eval numbers." The contract is the load-bearing design; the
demo is what it buys you.

## Primary diagram

```
  Deterministic in-browser RAG — full picture

  ┌─ View (RagQueryWorkspace.tsx) ────────────────────────────────────────┐
  │  fixture <select> · Run · metrics(precision@1, recall@k, chunks, ms)   │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │ runRagQueryFixtureReplay
  ┌─ Runner (agent-runners.ts:167) ───▼───────────────────────────────────┐
  │  fakeEmbedder(64d) ──┐                                                  │
  │  fixture.corpus ─index─► InMemoryVectorStore(64) ──search──┐           │
  │  createSearchKnowledgeBaseTool(minTopK:3) ─────────────────┤           │
  │  QueryFixtureModelProvider(recorded turns) ─► RagQueryAgent.answer()   │
  │       │ emits trace: step → tool_call_start → tool_call_end → text     │
  │       ▼ trace.find(tool_call_end).result.results = retrieved chunks    │
  │  scorePrecisionAtK / scoreRecallAtK(retrievedDocIds, relevant)         │
  └───────────────────────────────────┬───────────────────────────────────┘
                                      │ RagQueryReplayResult
  ┌─ View render ─────────────────────▼───────────────────────────────────┐
  │  Answer · Retrieved chunks (relevant ones highlighted) · Eval verdict  │
  └───────────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is the capstone of the toolkit's "retrieval-neutral pipeline" seam: `EmbeddingProvider`
and `VectorStore` are vendor-neutral contracts, and the in-browser demo is the strongest
proof they're the right boundary — the same pipeline that runs against Ollama + (in buffr)
pgvector runs against a 12-line keyword hash + an in-memory array, with no pipeline changes.
The trace-mining detail (`agent-runners.ts:192-200`) connects to `04-generic-trace-replay-
shell.md`: the trace is both a display artifact and a structured data channel. For the RAG
algorithm itself — why cosine, what precision@k measures, agentic retrieval (model decides
when to search) — go to `study-ai-engineering`; for the contract-as-seam design quality, go
to `study-software-design`.

## Interview defense

**Q: How do you demo a RAG agent with no backend, no model, and no vector DB?**
Inject a deterministic keyword-hash embedder at the `EmbeddingProvider` seam and replay
recorded model turns. Every other piece — the vector store, cosine search, ranking, the
agent loop, the eval scorers — is the real production code. The page runs the genuine
pipeline entirely in the browser, and because the embedder is a pure function of the text,
the precision@k numbers are reproducible.

```
  EmbeddingProvider contract
        │
   ┌────┴────────────┐
   │                 │
 Ollama          keyword-hash      ← same seam; only this swaps
 (real)          (demo)            ← everything below is unchanged
```

Anchor: *"one fake at the contract seam; the rest is the real pipeline."*

**Q: Where do the displayed chunks come from if the agent only returns an answer?**
From the trace. The retrieval is a tool-call side effect, so the runner finds the
`tool_call_end` event and reads `result.results` out of it (`agent-runners.ts:192-200`). The
trace is the channel for both the visible step log and the structured retrieved-chunk data.

Anchor: *"the trace is a data source, not just a log."*

## See also

- `04-generic-trace-replay-shell.md` — the trace as the shared display/data channel
- `05-fixture-as-build-input.md` — how the corpus + recorded turns reach the bundle
- `audit.md` — lens 4 (data-fetching) and lens 7 (platform: `performance.now`)
- `study-ai-engineering` — the RAG algorithm, precision@k/recall@k, agentic retrieval
- `study-software-design` — `EmbeddingProvider`/`VectorStore` as deep-module contracts
