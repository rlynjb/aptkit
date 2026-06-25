# 09 — Deterministic in-browser RAG

**Industry names:** client-side compute / in-browser pipeline · deterministic replay (fake embedder + recorded model responses) · custom-page-vs-shell composition split. **Type:** Project-specific (the pattern of running a *real* core pipeline in the browser for a no-backend demo).

---

## Zoom out — where this lives

`RagQueryWorkspace` is one of the ten routes, but it's an *off-shell* page — it doesn't go through `AgentReplayShell` like the five agent workspaces. What's unusual is what runs when you click "Run fixture": a real retrieval pipeline, entirely in the browser.

```
  Where the in-browser RAG replay sits

  ┌─ UI layer (browser, client-rendered) ──────────────────────────┐
  │  App() route 'rag-query' → <RagQueryWorkspace/>  (custom page)  │
  │    onClick "Run fixture" → runRagQueryFixtureReplay(fixture)    │ ★ THIS CONCEPT ★
  │      ├─ makeFixtureEmbedder()        keyword-hash, no Ollama     │
  │      ├─ new InMemoryVectorStore()    @aptkit/retrieval           │
  │      ├─ pipeline.index(doc) × corpus index→embed→upsert          │
  │      ├─ RagQueryAgent.answer(q)      recorded Gemma drives loop  │
  │      └─ scorePrecisionAtK / scoreRecallAtK   @aptkit/evals       │
  │    one await → setResult(whole result) → render answer+chunks   │
  └──────────────────────────────────────────────────────────────────┘
   no /api/* call · no Ollama · runs core package logic in the browser
```

The question: **how do you demo a RAG agent — retrieval quality and all — on a static host with no backend, no model server, and no embeddings API?** You know how the other workspaces replay recorded responses against a fixture (`05-fixture-provider-mode-switch.md`). This goes further: it replays the *recorded model turns* but runs the *real retrieval pipeline* live, so the retrieved chunks and the precision/recall numbers are actually computed, not recorded.

## Structure pass

Axis — **"where does each piece of the RAG loop execute, and is it real or recorded?"** — traced across the loop.

```
  axis: "real compute (R) vs recorded (rec), and where it runs"

  ┌─ embedding ──────┐  fake keyword-hash, REAL compute, IN BROWSER (R)
  │  makeFixtureEmbed│  → deterministic, no Ollama
  └────────┬─────────┘
  ┌─ vector search ──▼┐  InMemoryVectorStore cosine, REAL, IN BROWSER (R)
  │  the seam ────────│  ═══► retrieval is genuinely executed
  └────────┬──────────┘
  ┌─ model turns ─────▼┐  recorded Gemma responses, REPLAYED (rec)
  │  FixtureModelProvider│  → the LLM is faked; everything around it is real
  └────────┬───────────┘
  ┌─ scoring ──────────▼┐  scorePrecisionAtK/RecallAtK, REAL, IN BROWSER (R)
  │  @aptkit/evals       │
  └─────────────────────┘
```

- **Layers:** the page (React state + render) sits above the runner (`runRagQueryFixtureReplay`), which wires four core packages — `@aptkit/retrieval`, `@aptkit/agent-rag-query`, `@aptkit/tools`, `@aptkit/evals` — into a working pipeline.
- **The load-bearing seam is the embedder.** Swap the real `OllamaEmbeddingProvider` for a deterministic keyword-hash fake and *everything downstream stays real* — the same `InMemoryVectorStore`, the same `search_knowledge_base` tool, the same agent, the same scorers. The fake embedder is the one substitution that makes the whole pipeline run with no network.
- **What flips at that seam:** determinism and dependencies. Above it (the pipeline) everything is the production code path; the fake embedder below it is the only thing standing in for infrastructure.

## How it works

### Move 1 — the mental model

You've seen the other workspaces replay a recorded `ModelResponse[]` against a `FixtureModelProvider` — the model is faked, the agent loop is real. This page applies the *exact same idea to the embedder*: fake the one thing that needs a server (embeddings), keep everything else real. So instead of "real agent loop, fake model," it's "real *retrieval* pipeline + real agent loop, fake model **and** fake embedder." Two fakes, one real pipeline, fully deterministic.

```
  The pattern: fake the infra-bound parts, run the real pipeline

         fixture { corpus, question, relevant, modelResponses }
                          │
        ┌─────────────────┼──────────────────┐
   fake embedder    REAL pipeline         recorded model
   (keyword hash)   index→embed→search→    (Gemma turns)
        │           rank→agent-loop             │
        └──────────────► retrieved chunks ◄─────┘
                          │
                  REAL scorers → precision@1, recall@k
                          │
                  one setResult → render everything at once
```

Strategy in one line: **substitute only the two infra-bound nodes (embedder, model) with deterministic stand-ins; run the genuine `@aptkit/retrieval` + agent + eval code in the browser.**

### Move 2 — the walkthrough

#### Part A — the fake embedder (the one substitution that removes the backend)

`makeFixtureEmbedder()` (`agent-runners.ts:149-165`) returns an object satisfying the `EmbeddingProvider` contract: an `id`, a `dimension` (64), and an `async embed(texts)`. The embedding is a **keyword hash** — for each word, hash it to a bucket in a 64-dim vector and increment that bucket (a bag-of-words count vector). It's crude, but it's *deterministic* (same text → same vector, always) and needs no Ollama, no network.

What breaks without this substitution: the real `OllamaEmbeddingProvider` would POST to `localhost:11434`, which doesn't exist on a static host (or any visitor's machine). The fake embedder is the single change that lets the *rest* of the pipeline — which is the real code — run anywhere.

```
  keyword-hash embedding (deterministic, no network)

  text "I run Ollama and Gemma"
    │ lowercase, split on \W+
    ▼  [i, run, ollama, and, gemma]
  for each word: hash → bucket in [0..63], vector[bucket] += 1
    ▼
  [0,0,1,0,…,2,…,1,0]   ← same text always → same vector
```

#### Part B — the real retrieval pipeline (index path)

`new InMemoryVectorStore(RAG_EMBED_DIM)` + `createRetrievalPipeline({ embedder, store })` (`agent-runners.ts:172-173`) — these are the **actual `@aptkit/retrieval` exports**, the same contracts buffr backs with pgvector. Then `for (const doc of fixture.corpus) await pipeline.index({ id, text })` (`:174-176`) runs the real index path: doc → chunk → embed → upsert into the cosine store. This is not a mock; it's the production index path with a fake embedder plugged into its `EmbeddingProvider` slot.

What breaks if the dimensions disagree: `InMemoryVectorStore(64)` and the embedder's `dimension: 64` must match, or the store throws at upsert time (dimension mismatch is a one-way door in the retrieval package). The shared `RAG_EMBED_DIM = 64` constant (`agent-runners.ts:146`) feeds both, keeping them aligned.

```
  Layers-and-hops — index path, all in browser

  ┌─ fixture corpus ─┐  hop 1: each doc {id,text}
  │  3 notes         │ ──────────────────────────┐
  └──────────────────┘                            ▼
                              ┌─ pipeline.index() ──────────┐
                              │  chunk → embed (fake) → upsert│
                              └──────────────┬───────────────┘
                                hop 2: vector + meta
                                             ▼
                              ┌─ InMemoryVectorStore ───────┐
                              │  cosine-scannable array      │
                              └──────────────────────────────┘
```

#### Part C — the recorded agent loop (query path)

The tool: `createSearchKnowledgeBaseTool(pipeline, { minTopK: 3 })` (`agent-runners.ts:177`) — again the real tool — registered in an `InMemoryToolRegistry`. The model: `new QueryFixtureModelProvider(fixture.modelResponses)` (`:181`) replays the recorded Gemma turns. The agent: `new RagQueryAgent({ model, tools, profile, trace })` (`:183-188`), then `await agent.answer(fixture.question)` (`:190`).

Here's the choreography: the agent runs its real loop. Turn 1 of the recorded responses is a `tool_use` calling `search_knowledge_base` (see the fixture, `rag-query-fixtures.ts:30-37`) — so the agent *actually invokes* the real search tool against the *real* in-memory index, embedding the query with the fake embedder and cosine-ranking the corpus. Turn 2 is the recorded grounded answer with `[work.md]`-style citations. So the retrieval is genuinely computed; only the model's *decisions* (when to search, what to say) are recorded.

What breaks without the recorded `tool_use` first turn: the agent would never call the search tool, so `retrieved` would be empty and precision/recall would be zero. The fixture's first response *is* what triggers the real retrieval.

```
  Execution trace — what's real vs replayed per turn

  turn 1 (recorded): {tool_use: search_knowledge_base, query:"author work coffee"}
        │  agent EXECUTES the tool ──► fake-embed query ──► cosine search REAL index
        ▼  tool_call_end.result = { results: [chunks…] }   ← genuinely retrieved
  turn 2 (recorded): {text: "The author works as… [work.md] … coffee… [coffee.md]"}
        │  agent returns this as the answer
        ▼
  trace = [step, tool_call_start, tool_call_end, model_usage, …]
```

#### Part D — reading the retrieval back out of the trace, then scoring

The runner doesn't get the chunks as a return value — it digs them out of the trace. `trace.find(e => e.type === 'tool_call_end')` (`agent-runners.ts:193-195`), then reads `result.results` as the retrieved chunks (`:197-200`). From those it derives `retrievedDocIds` (dedup by `meta.docId`, `:202`) and runs the **real eval scorers**: `scorePrecisionAtK(retrievedDocIds, relevant, 1)` and `scoreRecallAtK(…, recallK)` (`:205-206`) — the same `@aptkit/evals` ranked-retrieval scorers used in the test suite.

What breaks if you read the agent's text answer instead of the trace: you'd score the *answer*, not the *retrieval*. Precision@k / recall@k are about which docs came back from search — that lives in the `tool_call_end`, not the final text. Pulling it from the trace is what makes the retrieval-quality metrics honest.

```
  scoring (real @aptkit/evals)

  retrievedDocIds = [work.md, coffee.md, stack.md]   (from tool_call_end)
  relevant        = {work.md, coffee.md}             (from fixture)

  precision@1 = (top-1 doc ∈ relevant?) → 1.00 if work.md is relevant
  recall@k    = |retrieved ∩ relevant| / |relevant| → 2/2 = 1.00
       │
       └─ issues[] flags precision<1 or recall<1 → evalOk = issues.length===0
```

#### Part E — the custom page: one run, one render

Unlike the streaming shell, `RagQueryWorkspace` does **one** await and **one** `setResult` (`RagQueryWorkspace.tsx:21-22`). No incremental trace paint — the whole `RagQueryReplayResult` (answer, retrieved chunks, doc-ids, precision, recall, trace, issues) lands at once and the page renders answer + highlighted chunks + the precision/recall grid + the trace + eval together. The chunk list highlights relevant hits by checking `result.relevant.includes(docId)` and applying `.ragChunk.relevant` (`RagQueryWorkspace.tsx:111-114`).

Why a custom page and not the shell: the shell's whole job is a *provider-mode* state machine (fixture / anthropic / openai) plus streaming. This page has no provider mode — it's deterministic, single-shot, no server stream. Forcing it into `AgentReplayShell<F,M,R>` would mean inventing a fake `M` it never uses. So it skips the shell and **reuses the leaf components instead** — `Panel`, `Metric`, `TracePanel`, `EvalPanel` (`RagQueryWorkspace.tsx:2`). Share the leaves, drop the generics.

### Move 2.5 — current vs future state

```
  current (shipped, deterministic demo)      future (live RAG)
  ─────────────────────────────────────     ──────────────────────────────
  fake keyword-hash embedder, 64-dim         real OllamaEmbeddingProvider,
                                             nomic-embed-text 768-dim
  recorded Gemma modelResponses              live Gemma over Ollama
  runs in browser, no backend                runs via /api stream (the shell)
  precision/recall over a 3-note corpus      same scorers, real corpus

  migration cost: the EMBEDDER and MODEL swap; the pipeline,
  the tool, the agent, and the scorers DON'T change — they're
  already the real code. The fake nodes are the only stand-ins.
```

The takeaway is what *doesn't* change: the retrieval pipeline, the search tool, the agent, and the eval scorers are the production code already. Going live swaps only the two infra-bound nodes (embedder, model). That's the payoff of faking at the contract seam instead of mocking the whole pipeline.

### Move 3 — the principle

When you need a deterministic, dependency-free demo of a real pipeline, fake at the *narrowest infra-bound seam* — here, the `EmbeddingProvider` and the model — and run the genuine code everywhere else. The contract boundaries (`EmbeddingProvider`, `VectorStore`, `ModelProvider`) that exist for provider-neutrality are the *same* boundaries that let you substitute deterministic stand-ins. A demo built this way isn't a separate mock implementation that can drift from production; it *is* production, minus two plugged-in fakes. That's why the precision/recall numbers on the page are trustworthy — they come from the real scorers over real retrieval.

## Primary diagram

```
  Deterministic in-browser RAG — the whole replay

  ┌─ UI layer (browser) ───────────────────────────────────────────┐
  │  RagQueryWorkspace  "Run fixture" → runRagQueryFixtureReplay()  │
  │                                                                 │
  │  ┌─ runner: real pipeline + two fakes (agent-runners.ts:167) ─┐ │
  │  │  makeFixtureEmbedder()  ← FAKE (keyword hash, no Ollama)    │ │
  │  │  InMemoryVectorStore(64) + createRetrievalPipeline  ← REAL  │ │
  │  │  for doc in corpus: pipeline.index(doc)            ← REAL   │ │
  │  │  createSearchKnowledgeBaseTool(pipeline)           ← REAL   │ │
  │  │  QueryFixtureModelProvider(modelResponses)  ← RECORDED Gemma│ │
  │  │  RagQueryAgent.answer(question)                    ← REAL   │ │
  │  │      └ turn1 tool_use → search REAL index (fake-embed query)│ │
  │  │      └ turn2 grounded cited answer (recorded)              │ │
  │  │  read tool_call_end.results → retrievedDocIds             │ │
  │  │  scorePrecisionAtK / scoreRecallAtK  ← REAL @aptkit/evals  │ │
  │  └─────────────────────────────┬──────────────────────────────┘ │
  │  one setResult(RagQueryReplayResult)                            │
  │    → Answer · Retrieved chunks (relevant highlighted)           │
  │    · Precision@1 / Recall@k grid · Trace · Eval                 │
  └──────────────────────────────────────────────────────────────────┘
  no /api/* · no Ollama · the demo IS the production pipeline minus 2 fakes
```

## Implementation in codebase

### Use cases

The **RAG Query Agent** card on the gallery (`StudioHome.tsx:114-125`, "Deterministic in-browser RAG") opens this page. It exists to demo agentic retrieval — the model deciding when to search, grounded + cited answers, and *measured* retrieval quality — on the GitHub Pages static demo where there's no Ollama and no `/api` backend. Two fixtures ship: a two-part question answered from two notes, and a single-source question where the relevant note is one of three (`rag-query-fixtures.ts:20-80`).

### Code, line by line

```
  apps/studio/src/agent-runners.ts:149-165  — the fake embedder (the key substitution)

  function makeFixtureEmbedder(): EmbeddingProvider {   ← satisfies the REAL contract
    return {
      id: 'fixture-embed',
      dimension: RAG_EMBED_DIM,                          ← 64, shared with the store
      async embed(texts) {
        return texts.map((text) => {
          const vector = new Array(RAG_EMBED_DIM).fill(0);
          for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
            let hash = 0;
            for (const ch of word) hash = (hash*31 + ch.charCodeAt(0)) >>> 0;
            vector[hash % RAG_EMBED_DIM] += 1;           ← bag-of-words count vector
          }
          return vector;                                 ← deterministic, no network
        });
      },
    };
  }
       │
       └─ this is the ONLY infra fake on the retrieval side. Everything that
          consumes an EmbeddingProvider downstream is the real code path.
```

```
  apps/studio/src/agent-runners.ts:170-190  — wiring the real pipeline + recorded model

  const embedder = makeFixtureEmbedder();
  const store = new InMemoryVectorStore(RAG_EMBED_DIM);       ← REAL @aptkit/retrieval
  const pipeline = createRetrievalPipeline({ embedder, store });  ← REAL
  for (const doc of fixture.corpus) {
    await pipeline.index({ id: doc.id, text: doc.text });     ← REAL index path
  }
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 3 });  ← REAL tool
  const tools = new InMemoryToolRegistry([tool.definition], {…});

  const model = new QueryFixtureModelProvider(fixture.modelResponses);  ← RECORDED Gemma
  const agent = new RagQueryAgent({ model, tools, profile, trace });    ← REAL agent
  const answer = await agent.answer(fixture.question);                  ← runs the loop
       │
       └─ the recorded turn-1 tool_use makes the agent actually call the real
          search tool against the real index — so retrieval is genuinely computed
```

```
  apps/studio/src/agent-runners.ts:193-211  — read retrieval from trace, score it real

  const toolEnd = trace.find(e => e.type === 'tool_call_end');  ← chunks live in the trace,
  const retrieved = toolEnd?.result?.results ?? [];                not the text answer
  const retrievedDocIds = [...new Set(retrieved.map(h =>
                            String(h.meta?.docId ?? h.id)))];   ← dedup by source doc
  const relevant = new Set(fixture.relevant);
  const precisionAt1 = scorePrecisionAtK(retrievedDocIds, relevant, 1).score;  ← REAL evals
  const recallAtK   = scoreRecallAtK(retrievedDocIds, relevant, recallK).score;
  …
  if (precisionAt1 < 1) issues.push('retrieval: top chunk is not in the relevant set');
  if (recallAtK   < 1) issues.push('retrieval: not all relevant docs were retrieved');
       │
       └─ scoring the RETRIEVAL (from tool_call_end), not the answer text — that's
          what makes precision@1/recall@k meaningful here
```

```
  apps/studio/src/RagQueryWorkspace.tsx:107-127  — render: chunks, relevant highlighted

  {result.retrieved.map((chunk) => {
    const docId = String(chunk.meta?.docId ?? chunk.id);
    const isRelevant = result.relevant.includes(docId);        ← did this chunk's doc
    return (                                                      belong to the gold set?
      <li className={isRelevant ? 'ragChunk relevant' : 'ragChunk'}>  ← .relevant highlight
        <span className="ragChunkId">{docId}</span>                  (styles.css:259)
        <span className="ragChunkScore">{chunk.score.toFixed(3)}</span>  ← cosine score
        <p>{chunk.citation}</p>
      </li>
    );
  })}
```

## Elaborate

This is the retrieval-side analogue of the `FixtureModelProvider` pattern (`05-fixture-provider-mode-switch.md`): both fake an infra-bound dependency at its contract seam so a pipeline can run deterministically. The broader idea — run the real pipeline with a deterministic stand-in for the one thing that needs infrastructure — shows up wherever you want a demo or a test that exercises real logic without real dependencies: in-memory databases for ORM tests, fake clocks for scheduler tests, recorded HTTP cassettes. The reason it's clean here is that aptkit's contracts (`EmbeddingProvider`, `VectorStore`, `ModelProvider`) were designed for provider-neutrality, and provider-neutrality and test/demo-substitutability are the same property viewed from two angles. The retrieval *mechanism* (cosine, embeddings, ranking) is `@aptkit/retrieval`'s and is taught in `study-ai-engineering`; what's frontend here is running it client-side and rendering its measured output.

What to read next: `05-fixture-provider-mode-switch.md` (the model-side fake this mirrors), `03-shared-replay-shell.md` (the shell this page deliberately skips), then `study-ai-engineering` for the retrieval pipeline internals and `study-testing` for the eval/scorer seam.

## Interview defense

**Q: How do you demo RAG retrieval quality with no backend, no Ollama, no embeddings API?**
Fake at the narrowest infra seam: a keyword-hash `EmbeddingProvider` replaces Ollama, recorded Gemma responses replace the model — and *everything else is the real code*. The actual `@aptkit/retrieval` pipeline (index, embed, cosine search, the `search_knowledge_base` tool), the real `RagQueryAgent`, and the real `@aptkit/evals` precision@k/recall@k scorers all run in the browser (`agent-runners.ts:167-228`). So the retrieved chunks and the metrics are genuinely computed, not recorded.

```
  fake embedder + recorded model → REAL pipeline (index→search→agent→score) → in browser
```
Anchor: `agent-runners.ts:149-165` (fake embedder), `:170-211` (real pipeline + scoring).

**Q: Why is it a custom page and not the shared `AgentReplayShell`?**
The shell exists for the provider-*mode* state machine (fixture/anthropic/openai) and streaming. This page has no provider mode — it's deterministic and single-shot, one `await` then one `setResult` (`RagQueryWorkspace.tsx:21-22`). Forcing it into `AgentReplayShell<F,M,R>` would mean inventing an `M` it never uses. So it skips the shell and reuses the *leaf* components — `Panel`, `Metric`, `TracePanel`, `EvalPanel`. The rule: a page uses the shell only if it replays one agent against a provider mode.

```
  shell = provider-mode machine + stream;  this page = neither → custom, reuse leaves
```
Anchor: `RagQueryWorkspace.tsx:2,8`.

**Q: How are the precision/recall numbers trustworthy if the model is faked?**
Because they score the *retrieval*, not the model. The chunks are read from the agent's real `tool_call_end` trace event (`agent-runners.ts:193-200`) — the output of the real cosine search over the real index — and fed to the same `scorePrecisionAtK`/`scoreRecallAtK` used in the test suite. The fake is the *embedding function*, but the ranking, the tool, and the scorers are all real.

## Validate

1. **Reconstruct:** name the two fakes and the four real components in `runRagQueryFixtureReplay`. (Fakes: keyword-hash embedder, recorded model. Real: pipeline/store, search tool, agent, eval scorers.)
2. **Explain:** why read retrieved chunks from `tool_call_end` rather than the agent's answer? (Precision/recall measure which docs search returned — that's in the tool result, not the text.)
3. **Apply:** going live to real Ollama + real Gemma — what changes? (Only the embedder and the model swap; pipeline, tool, agent, scorers are unchanged — they're already real.)
4. **Defend:** a teammate says "just mock the whole retrieval pipeline for the demo." Argue the call. (A separate mock can drift from production; faking at the `EmbeddingProvider`/`ModelProvider` contract runs the *real* pipeline, so the demo can't lie about retrieval behavior.)

## See also

- `05-fixture-provider-mode-switch.md` — the model-side `FixtureModelProvider` fake this mirrors on the retrieval side.
- `03-shared-replay-shell.md` — the shell this custom page deliberately skips, and the leaf components it reuses.
- `00-overview.md` — the off-shell pages in the component tree.
- Cross-guide: `study-ai-engineering` (the retrieval pipeline + RAG internals), `study-testing` (the precision@k/recall@k eval seam), `study-software-design` (contract seams as substitution points).
