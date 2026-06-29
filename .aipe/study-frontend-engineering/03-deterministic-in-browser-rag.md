# 03 — Deterministic in-browser RAG

**Industry name(s):** client-side retrieval demo / deterministic replay of a
RAG pipeline. **Type:** Project-specific (the real `@aptkit/retrieval` pipeline
run in the browser with a stubbed embedder).

> This is the **frontend half** of RAG. The retrieval mechanism, embeddings,
> cosine search, and scoring math live in `study-ai-engineering`. Here we cover
> what the *UI* does: run the real pipeline in the browser with no backend, read
> the retrieved chunks back out of the trace, and score them live.

## Zoom out, then zoom in

The RAG Query screen runs an *actual* retrieval pipeline — `createRetrievalPipeline`,
`InMemoryVectorStore`, `createSearchKnowledgeBaseTool`, the real `RagQueryAgent`
loop — entirely in the browser, with zero server. Here's where it sits.

```
  Where in-browser RAG lives

  ┌─ UI layer (browser) ────────────────────────────────────────┐
  │  RagQueryWorkspace.tsx  (useState: result/running/error)     │
  │            │ run()                                            │
  │            ▼                                                  │
  │  ★ agent-runners.ts runRagQueryFixtureReplay() ★  ← here     │
  │     fake embedder + InMemoryVectorStore + RagQueryAgent      │
  └───────────────────────────┬─────────────────────────────────┘
                              │  NO network — all in-process
  ┌─ @aptkit/retrieval (real pkg, bundled) ─────────────────────┐
  │  index(doc→chunk→embed→upsert) · search(embed→cosine→rank)  │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the question is *"how do you demo a working RAG agent — retrieval,
grounding, citations, precision@k — on a static host with no model server and
no vector DB?"* The answer: keep everything *real* except the two things that
need infrastructure — swap the Ollama embedder for a deterministic hash, and
replay recorded model responses instead of calling Gemma.

## Structure pass

**Layers:** (1) UI — `RagQueryWorkspace`; (2) orchestration —
`runRagQueryFixtureReplay`; (3) the real retrieval pipeline; (4) the recorded
model + agent loop.

**Axis — what's *real* vs *stubbed* (trust/fidelity):** the whole design hinges
on which boxes are authentic.

```
  axis: real vs stubbed — what's load-bearing fidelity?

  ┌ embedder ────────┐  STUBBED — keyword-hash, 64-dim (deterministic)
  ┌ vector store ────┐  REAL — InMemoryVectorStore, real cosine scan
  ┌ search tool ─────┐  REAL — createSearchKnowledgeBaseTool, minTopK floor
  ┌ agent loop ──────┐  REAL — RagQueryAgent decides when to search
  ┌ model responses ─┐  STUBBED — recorded Gemma turns (tool_use, then text)
  ┌ scoring ─────────┐  REAL — scorePrecisionAtK / scoreRecallAtK
```

**Seam:** the `EmbeddingProvider` contract. That's exactly where the stub is
injected — the pipeline can't tell a real Ollama embedder from a fake one
because both satisfy the same interface. That seam *is* the reason this demo can
exist; it's the strongest evidence the contract was the right boundary (the
same seam buffr fills with pgvector).

## How it works

### Move 1 — the mental model

You know how a test swaps a real HTTP client for a stub that returns canned
responses — the code under test runs unchanged because the stub satisfies the
same interface. This is that, twice: stub the embedder (it satisfies
`EmbeddingProvider`) and stub the model (recorded `ModelResponse[]`). Everything
between them — index, search, rank, the agent loop — is the production code.

```
  The kernel — real pipeline, two stubs at the seams

   fixture.corpus ──► index() ──► [InMemoryVectorStore]  (REAL)
                         ▲                  │
            fake embedder│                  │ cosine search (REAL)
            (64-d hash)  │                  ▼
   question ──► RagQueryAgent.answer() ──► search_knowledge_base tool (REAL)
                    ▲                          │
   recorded Gemma   │                          ▼ results in trace
   responses ───────┘                   read chunks back from tool_call_end
                                              │
                                              ▼  score
                                  precision@1 / recall@k  (REAL)
```

### Move 2 — the walkthrough

**Stub one — the deterministic embedder.**
The only thing that genuinely needs a server (Ollama + nomic-embed-text) is the
embedder. So the UI provides a fake one: a keyword-hash into a fixed-size
vector. Same words → same vector, every time, no network.

```ts
// apps/studio/src/agent-runners.ts:149-165
function makeFixtureEmbedder(): EmbeddingProvider {
  return {
    id: 'fixture-embed',
    dimension: RAG_EMBED_DIM,                 // 64 (agent-runners.ts:146)
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const vector = new Array<number>(RAG_EMBED_DIM).fill(0);
        for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
          let hash = 0;
          for (const ch of word) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;  // string hash
          vector[hash % RAG_EMBED_DIM] += 1;   // bag-of-hashed-words
        }
        return vector;
      });
    },
  };
}
```

It's a bag-of-words count bucketed by a per-word hash — crude, but it satisfies
`EmbeddingProvider` (the seam) and cosine similarity over it still ranks the
note that shares the most query words first. The boundary condition: `dimension`
must match the store's dimension, or the pipeline throws at wiring time
(`InMemoryVectorStore(RAG_EMBED_DIM)`, `agent-runners.ts:172`) — embedding
dimension is a one-way door, named in `study-ai-engineering`.

**Build the real pipeline and index the corpus.**
Everything below the embedder is production code from `@aptkit/retrieval`.

```ts
// apps/studio/src/agent-runners.ts:171-178
const embedder = makeFixtureEmbedder();
const store = new InMemoryVectorStore(RAG_EMBED_DIM);
const pipeline = createRetrievalPipeline({ embedder, store });
for (const doc of fixture.corpus) {
  await pipeline.index({ id: doc.id, text: doc.text });   // doc→chunk→embed→upsert
}
const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 3 });
```

The corpus is tiny on purpose (`rag-query-fixtures.ts:5-18` — three short notes,
one chunk each) so retrieval is *readable* in the UI: you can see which note won.

**Stub two — replay recorded model turns through the real agent loop.**
The model is the second thing needing infra (Ollama + Gemma). So the agent runs
on a `FixtureModelProvider` fed recorded responses: turn 1 is a `tool_use`
(search), turn 2 is the grounded answer.

```ts
// apps/studio/src/agent-runners.ts:181-190
const model = new QueryFixtureModelProvider(fixture.modelResponses);
const trace: CapabilityEvent[] = [];
const agent = new RagQueryAgent({ model, tools, profile: fixture.profile,
  trace: { emit: (event) => trace.push(event) } });
const answer = await agent.answer(fixture.question);
```

The recorded responses (`rag-query-fixtures.ts:28-49`) make the agent *choose*
to call `search_knowledge_base` then cite `[work.md]`/`[coffee.md]` — the loop,
tool dispatch, and grounding are all real; only the model's tokens are canned.

**Read retrieved chunks back out of the trace.**
This is the frontend-specific move. The UI doesn't get the retrieved chunks as a
return value — it *recovers* them by finding the `tool_call_end` event the loop
emitted and pulling `.result.results`.

```ts
// apps/studio/src/agent-runners.ts:193-202
const toolEnd = trace.find(
  (event): event is Extract<CapabilityEvent, { type: 'tool_call_end' }> =>
    event.type === 'tool_call_end',
);
const rawResult = toolEnd?.result;
const retrieved: RagRetrievedChunk[] =
  rawResult && typeof rawResult === 'object' && Array.isArray((rawResult as { results?: unknown }).results)
    ? (rawResult as { results: RagRetrievedChunk[] }).results
    : [];
const retrievedDocIds = [...new Set(retrieved.map((hit) => String(hit.meta?.docId ?? hit.id)))];
```

The trace is the seam between agent and UI: the agent emits `CapabilityEvent`s,
the UI reads them back. The defensive type-narrowing (`typeof … 'object'`,
`Array.isArray`) is the boundary condition — the trace is a loose discriminated
union, so the UI validates before trusting `.results`.

**Score it live — real precision@k / recall@k.**
The retrieved doc ids are scored against the fixture's `relevant` set with the
real evals package, in the browser.

```ts
// apps/studio/src/agent-runners.ts:203-211
const relevant = new Set(fixture.relevant);
const recallK = Math.max(retrievedDocIds.length, fixture.relevant.length || 1);
const precisionAt1 = scorePrecisionAtK(retrievedDocIds, relevant, 1).score;
const recallAtK = scoreRecallAtK(retrievedDocIds, relevant, recallK).score;
const issues: string[] = [];
if (precisionAt1 < 1) issues.push('retrieval: top chunk is not in the relevant set');
if (recallAtK < 1)   issues.push('retrieval: not all relevant docs were retrieved');
```

**Render — UI as a function of the result (layers-and-hops).**
The result flows into local state and out to four panels. No store, no fetch.

```
  result → UI, all in-process

  ┌ orchestration ─┐ runRagQueryFixtureReplay() → RagQueryReplayResult
  │ agent-runners  │ ───────────────────────────────────────────────►
  └────────────────┘ hop 1: setResult(next)  (RagQueryWorkspace.tsx:22)
                                  │
  ┌ UI · RagQueryWorkspace ───────▼──────────────────────────────────┐
  │  Answer panel · Retrieved-chunks (relevant ones highlighted,      │
  │  RagQueryWorkspace.tsx:110-122) · Precision@1/Recall@k metrics ·  │
  │  TracePanel(result.trace)                                         │
  └───────────────────────────────────────────────────────────────────┘
```

The relevant-chunk highlight (`isRelevant = result.relevant.includes(docId)`,
`RagQueryWorkspace.tsx:112`) is the teaching payoff: you *see* whether retrieval
pulled the right note.

### Move 3 — the principle

Stub at the contract, not inside the logic. By injecting fakes only at the two
infrastructure seams (`EmbeddingProvider`, the model), the demo runs the
*production* retrieval pipeline and scorers unchanged — so it teaches the real
shape, not a toy reimplementation. The fact that a 16-line fake embedder drops
into the same slot Ollama uses is the proof the contract boundary was drawn in
the right place.

## Primary diagram

```
  Deterministic in-browser RAG — the complete picture

  ┌─ UI (RagQueryWorkspace) ────────────────────────────────────┐
  │  selectedId / result / running / error / runId  (useState)   │
  │  Run fixture ─► run() ─────────────────────────────┐         │
  └────────────────────────────────────────────────────┼─────────┘
                                                        ▼
  ┌─ runRagQueryFixtureReplay (agent-runners.ts) ───────────────┐
  │  fake embedder ─►┐                                           │
  │  InMemoryVectorStore ◄─ index(corpus) ─ pipeline (REAL)      │
  │  RagQueryAgent.answer(q) ──► search_knowledge_base (REAL)    │
  │       ▲ recorded Gemma turns        │ emits CapabilityEvent  │
  │       │                             ▼                        │
  │  trace.find(tool_call_end).result.results ──► retrieved[]    │
  │  scorePrecisionAtK / scoreRecallAtK ──► precision@1, recall@k│
  └────────────────────────────┬────────────────────────────────┘
                              ▼
   Answer · Chunks(relevant highlighted) · Metrics · Trace panels
```

## Elaborate

This is the "fixture replay" idea (recorded responses played back
deterministically — the testing/observability backbone of aptkit) extended to
RAG, with the embedder stub added because retrieval has a *second* infra
dependency the analytics agents don't. It's the only Studio screen that runs a
real pipeline rather than just rendering a recorded artifact — note it does
*not* use `AgentReplayShell` (file 04); it's a bespoke screen because its run
shape (index a corpus, recover chunks from the trace, score retrieval) doesn't
fit the shell's fixture/server-mode contract. The retrieval internals, the
cosine math, the `minTopK` floor, and the precision/recall definitions live in
`study-ai-engineering`.

## Interview defense

**Q: Is this real RAG or a fake?**
Real pipeline, two stubs. The vector store, the search tool, the agent loop, and
the precision/recall scorers are the production `@aptkit/retrieval` and
`@aptkit/evals` code. The only fakes are the embedder (a deterministic
keyword-hash instead of Ollama) and the model (recorded Gemma responses instead
of a live call) — and both are injected at their interface, so the pipeline runs
unchanged.

```
  what's real vs stubbed

  REAL: vector store · search tool · agent loop · scorers
  STUB: embedder (hash)  ·  model (recorded turns)
        ↑ both swapped at a contract, not inside logic
```

**Q: How does the UI know which chunks were retrieved?**
It reads them back from the trace. The agent loop emits a `tool_call_end`
`CapabilityEvent` carrying the search tool's result; the runner finds that event
and pulls `.result.results` (`agent-runners.ts:193`). The trace is the seam
between agent and UI — the agent doesn't return chunks, it *emits* them, and the
UI recovers them, narrowing the loose union type defensively before trusting it.

**Q: Why a 64-dim keyword hash and not real embeddings?**
Real embeddings need Ollama running — impossible on a static host. The hash is
deterministic (same words → same vector) so the demo is reproducible, and it
satisfies the `EmbeddingProvider` contract so the rest of the pipeline can't
tell the difference. It's crude — cosine over bag-of-hashed-words — but on the
tiny three-note corpus it still ranks the right note first, which is all the
demo needs to teach the shape.

**Anchor:** *"Real pipeline, fakes only at the two infra seams — and the UI
recovers the retrieved chunks from the trace, not a return value."*

## See also

- `04-generic-replay-shell.md` — the *other* replay screens; this one is
  bespoke because its run shape doesn't fit the shell.
- `05-fixture-as-build-input.md` — how the corpus/responses get inlined.
- `study-ai-engineering` — the retrieval mechanism, embeddings, cosine, and the
  precision@k/recall@k definitions (the other half of this pattern).
- `audit.md` → lens 4 (data flow), lens 8 #1 (no abort guard on this screen).
