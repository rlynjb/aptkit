# Pass 1 — the system-design audit

Eight lenses, walked against real `file:line` evidence. Each lens names what AptKit actually does, or says `not yet exercised` honestly. When a finding is big enough to deserve a full walk, it cross-links to a Pass 2 pattern file rather than restating it.

The honest framing up front: this is a **library monorepo** of 16 internal packages (published as `@rlynjb/aptkit-core` 0.4.1), not a deployed distributed system. Six of the eight lenses have rich findings (boundaries, flow, state, durability, failure, evolution). The caching lens stays mostly `not yet exercised`, and the scale lens now has one real internal bottleneck — the in-memory vector store's linear scan — which is correct for a from-scratch RAG adapter, not a gap to paper over. There's still no traffic, no SQL datastore, no replicas. The default model is now *local*: Gemma + nomic embeddings over Ollama, so the default deployment makes no cloud call at all.

The newest delta is `@aptkit/memory` (the 16th package): episodic conversation memory built by **reusing the existing `EmbeddingProvider` + `VectorStore` retrieval contracts** — a *second* consumer of those seams with zero new infrastructure contracts. It's the strongest evidence in the repo that those contracts were drawn at the right boundary. It also shifts the state lens for the first time: with memory wired (in buffr's `chat` CLI, over a durable `PgVectorStore`), an agent now has state that **persists across runs** — though that durability lives across the repo boundary, in buffr. → see `10-memory-store-topology.md`.

---

## 1. system-map-and-boundaries

Every major component, its responsibility, and its trust boundaries. The full picture is in `00-overview.md`; this lens names the boundaries.

**Layered dependency boundary (the spine).** `packages/runtime` has zero internal dependencies — it's the foundation everything points at. The dependency arrow always points *toward* runtime: agents depend on runtime + tools + context + prompts; providers depend only on runtime's `ModelProvider` contract; retrieval depends on tools (for the tool contract); core depends on all of them. This is enforced by the build order in `package.json` (`build:core:deps`), which compiles runtime first, then tools/context/prompts/evals/workflows, then the six agents (now including `agent-rag-query`), then `retrieval` + `provider-gemma` + `provider-local`, then core last (`build:core`).

**The central seam — `ModelProvider.complete()`** (`packages/runtime/src/model-provider.ts:54-58`). Every model call in the entire system crosses this one interface. No agent, no loop, no eval ever touches a vendor SDK directly. → see `01-provider-abstraction.md`.

**The two retrieval seams — `EmbeddingProvider` and `VectorStore`** (`packages/retrieval/src/contracts.ts:22-37`). The from-scratch RAG capability adds a *second* pair of provider-neutral seams, the same shape as `ModelProvider`: the pipeline turns text→vectors→search without ever naming nomic, OpenAI, pgvector, or in-memory. A `dimension` field on both sides is the safety latch that makes the swap safe. → see `09-retrieval-pipeline-seam.md`.

**The seam now has a second consumer — `@aptkit/memory`** (`packages/memory/src/conversation-memory.ts:1`). Episodic conversation memory imports `EmbeddingProvider`, `VectorStore`, `VectorHit` straight from `@aptkit/retrieval` and speaks *nothing else* — no new contract, no database client, no new control flow. `remember` is the RAG index path and `recall` is the RAG query path, pointed at a corpus of conversation turns instead of documents. That a whole new capability dropped in as a second consumer of an existing seam is the strongest evidence in the repo that the retrieval contracts were drawn at the right boundary. The store is *injected*, so the caller chooses the topology: **shared** with documents (memory mixes into the corpus and surfaces via `search_knowledge_base` — no extra tool) or **dedicated** (isolated, recalled via a `search_memory` tool from `createMemoryTool`). → see `10-memory-store-topology.md`.

**Trust boundaries.** There are two real ones:
- **The model/embedding HTTP calls** — the only places data leaves the process, over HTTP(S). The bundled default is *local*: `GemmaModelProvider` POSTs to Ollama's `/api/chat` (`packages/providers/gemma/src/gemma-provider.ts`), and `OllamaEmbeddingProvider` POSTs to Ollama's `/api/embed` (`packages/retrieval/src/ollama-embedding-provider.ts:60-75`) — both default to `http://localhost:11434`, so the default deployment never leaves the machine. (Cloud SDK adapters for Anthropic/OpenAI still exist under `packages/providers/` but are no longer in the published bundle's build chain — see lens 8.)
- **The tool-policy boundary** (`packages/tools/src/tool-policy.ts:11-23`) — each agent can only see the tools on its allowlist. The rag-query agent is the tightest case: its policy grants exactly one tool, `search_knowledge_base` (`packages/agents/rag-query/src/rag-query-agent.ts:15-18`). This is a *capability* boundary, not a security perimeter, but it's a real containment seam. → see `04-capability-as-tool-policy.md`.

**The publish boundary** (`packages/core/package.json` `bundledDependencies`). `bundledDependencies` inlines all 16 internal packages into one tarball (runtime, tools, context, prompts, evals, workflows, retrieval, memory, provider-gemma, provider-local, and the six agents); the must-not-change rule is that app-specific product logic never crosses *into* core. → see `08-monorepo-bundle-boundary.md`.

**External dependencies:** the default surface is the **local Ollama HTTP server** (`gemma2:9b` for reasoning, `nomic-embed-text` 768-dim for embeddings). No database, no cache server, no message broker. Anthropic/OpenAI remain as optional cloud adapters but are not in the default bundle.

---

## 2. request-response-and-data-flow

The important end-to-end flows.

**The inner flow — one agent run** (`packages/runtime/src/run-agent-loop.ts:98-190`). A capability method seeds a user message, then loops: `model.complete()` → if the response has tool-use blocks, execute them via the registry and feed results back as a user message → repeat until the model stops calling tools or the budget is spent. The loop is bounded and forces a final synthesis turn. → see `02-bounded-agent-loop.md`.

**The pipeline flow — monitor → diagnose → recommend** (wired in `apps/studio/vite.config.ts` and `apps/studio/src/agent-runners.ts`). `anomaly-monitoring.scan()` returns `Anomaly[]`; one anomaly feeds `diagnostic-investigation.investigate(anomaly)` → `Diagnosis`; both feed `recommendation.propose(anomaly, diagnosis)` → `Recommendation[]`. The output type of each stage is the input type of the next — a typed handoff. → see `05-multi-agent-pipeline.md`.

**The Studio flow — replay over the wire** (`apps/studio/vite.config.ts:887-918` server, `apps/studio/src/api.ts:119-166` client). Click "Replay" → `fetch` POST to a Vite middleware route → the route runs the agent with an `onEvent` callback that writes each `CapabilityEvent` as an NDJSON line → the React client decodes the stream incrementally and accumulates a live trace. → see `07-ndjson-stream-handoff.md`.

**The eval flow — the testing backbone** (`packages/evals/src/replay-runner.ts`, `scripts/*.mjs`). Live run → write artifact JSON → evaluate → promote to fixture → deterministic replay. → see `06-replay-eval-pipeline.md`.

**The retrieval flow — RAG's two paths** (`packages/retrieval/src/pipeline.ts:32-59`). Two sequential paths over one validated wiring: the *index* path `doc → chunkText → embedder.embed → store.upsert` builds the corpus offline; the *query* path `query → embedder.embed → store.search → ranked hits` answers online. The query path is reached as a *tool* inside the agent loop — `search_knowledge_base` (`packages/retrieval/src/search-knowledge-base-tool.ts`) wraps `pipeline.query()` so the rag-query agent calls retrieval the same way it would call any other tool. → see `09-retrieval-pipeline-seam.md`.

**The memory flow — remember after, recall before** (`packages/memory/src/conversation-memory.ts:74-106`). Two paths over the same injected store, reusing the retrieval flow shape. The *write* path runs after a turn completes: `{question, answer} → format → embed → upsert(kind=memory)`. The *read* path runs when the past is needed: `query → embed → search(k×4) → filter kind==memory → top k`. In buffr's `chat` session this is wired so `session.ask()` calls `memory.remember(...)` best-effort after every answer (`buffr/src/session.ts:66`), and recall surfaces through the *existing* `search_knowledge_base` tool because memory shares the document store. The `k×4` over-fetch exists because the `VectorStore` contract has no metadata filter — in a shared store, documents can out-rank memory rows, so recall over-fetches then filters by tag. → see `10-memory-store-topology.md`.

No parallel fan-out anywhere — every flow is sequential. The agent loop is sequential by construction (each turn depends on the last), the multi-agent pipeline is sequential by data dependency, the fallback chain is sequential by design, retrieval's two paths run one chunk-batch at a time, and memory's remember/recall are single embed-then-store/search hops.

---

## 3. state-ownership-and-source-of-truth

Who owns each piece of state and who mutates it.

**The agent loop owns conversation state — within one run** (`packages/runtime/src/run-agent-loop.ts:94-96`). The `messages` array, `toolCalls` record, and `finalText` are local to one `runAgentLoop` invocation — born when the loop starts, gone when it returns. The loop itself remains stateless across invocations: nothing in `runAgentLoop` survives between runs. This is the cleanest kind of state ownership inside the loop: there isn't any to leak.

**But agent state now persists across runs — through `@aptkit/memory`, not the loop** (`packages/memory/src/conversation-memory.ts:74-87`). This is the first lens-3 delta in the repo's history. With memory wired, an exchange is embedded and `upsert`ed into a `VectorStore` after each turn, and recalled by similarity on a later turn — *across sessions*. Crucially, the loop is **still** stateless; the cross-run state lives entirely in the injected store, owned by whoever supplies it. In buffr's `chat` CLI that's a durable `PgVectorStore` over Supabase Postgres (`buffr/src/session.ts:41,53`), so memory survives the process. The state-ownership boundary is sharp: aptkit owns the *engine* (embed, tag, recall) and never names a database; the *durability* of the persisted memory rows is owned by the consuming repo's store. Memory rows are written **best-effort** — buffr swallows a `remember` failure so it can't lose the answer the user already has (`buffr/src/session.ts:64-69`). → see `10-memory-store-topology.md`. → schema shape of the persisted rows is owned by buffr's `.aipe/study-database-systems/`.

**The trace is append-only, owned by the caller's sink** (`packages/runtime/src/events.ts:26-28`). The loop never holds the trace — it `emit()`s `CapabilityEvent`s to a `CapabilityTraceSink` the caller provides. Studio's sink accumulates into React state (`apps/studio/src/AgentReplayShell.tsx:91-96`); a script's sink pushes to an array. The runtime owns *producing* events; the caller owns *storing* them. Clean separation. → schema shape is owned by `.aipe/study-data-modeling/`.

**The replay artifact is the durable source of truth for "what happened"** (`artifacts/replays/*.json`). Keys: `schemaVersion`, `capabilityId`, `createdAt`, `durationMs`, `provider`, `fixture`, the per-capability output, `trace`, `eval`, `modelTurns`. It's the only thing written to disk during a live run.

**The fixture is the source of truth for "what should happen"** (`packages/agents/*/fixtures/*.json`, `fixtures/promoted/*.json`). A fixture's `modelResponses: ModelResponse[]` is replayed in order by `FixtureModelProvider` (`packages/agents/recommendation/src/fixture-provider.ts:3-18`). Promoted fixtures are correctness baselines — the must-not-change rule (`context.md`) says they're regenerated via `promote:replay`, never hand-edited.

**`WorkspaceDescriptor` is read-only input state** (`packages/context`). It's metadata about a workspace (events, catalogs, totals, data horizon) summarized into prompts — never mutated by an agent.

No URL state, no form state, no client-side persistence beyond React component state in Studio. No server-side session store.

---

## 4. caching-and-invalidation

**Mostly `not yet exercised`.** There is no cache layer, no memoization of model calls, no TTL, no invalidation strategy. Every live `model.complete()` hits the vendor API fresh.

The one thing that *rhymes* with caching is the **fixture-as-recorded-response** mechanism (`FixtureModelProvider`, `packages/agents/*/src/fixture-provider.ts`): a recorded `ModelResponse[]` replayed deterministically instead of calling the model. That's not a cache (no freshness logic, no key-based lookup, no invalidation) — it's a *test double*. But it occupies the architectural slot a response cache would, and it's why eval runs cost zero tokens. → see `06-replay-eval-pipeline.md`.

If this repo ever needs a real cache (e.g. dedup identical `complete()` calls), the `ModelProvider` seam is exactly where a caching decorator would slot in — same shape as `ContextWindowGuardedProvider` already uses. Worth naming as the natural future seam.

The newer thing that *rhymes* differently is the **`InMemoryVectorStore`** (`packages/retrieval/src/in-memory-vector-store.ts`). It's a process-lifetime store of embeddings — closer to an index than a cache (no TTL, no invalidation; the corpus is rebuilt on each run by re-indexing). It carries a `dimension` and rejects mismatched vectors loudly, which is the analogue of a cache-key contract. → see `09-retrieval-pipeline-seam.md`.

---

## 5. storage-choice-and-durability-boundaries

**No datastore.** Per `context.md`, there is no SQL/relational database. "Data" is file- and stream-shaped:

- **NDJSON streams** — `CapabilityEvent`s encoded one-per-line (`packages/runtime/src/ndjson-stream.ts:31-33`). Ephemeral on the wire to Studio; durable when a script writes them into an artifact's `trace`.
- **JSON files on the filesystem** — replay artifacts (`artifacts/replays/*.json`), fixtures (`packages/agents/*/fixtures/*.json`). Durability is "whatever the filesystem and git give you." Promoted fixtures are committed; replay artifacts are working output.
- **In-memory embeddings (ephemeral)** — `InMemoryVectorStore` holds the indexed corpus in a process-lifetime `Map` (`packages/retrieval/src/in-memory-vector-store.ts:12`). Zero durability by design: the corpus is re-indexed on each run. The `VectorStore` contract is the seam where a durable store (`PgVectorStore` is the named drop-in) would slot in without touching the pipeline. → see `09-retrieval-pipeline-seam.md`.
- **Persisted conversation memory (durable — but the durability lives in buffr)** — `@aptkit/memory` writes embedded exchanges through the *same* `VectorStore` seam (`packages/memory/src/conversation-memory.ts:80-86`). In this repo, memory over an `InMemoryVectorStore` is ephemeral like everything else. Durability is unlocked by the *consumer's* store choice: buffr injects a `PgVectorStore`, and memory rows then survive the process and the session. This is the cleanest illustration of the durability boundary in the whole repo — aptkit defines *what* is stored (a tagged vector row) and never *where* it durably lives; the consuming repo owns that. → see `10-memory-store-topology.md`; schema shape lives in buffr's `.aipe/study-database-systems/`.

Why no database? Because nothing here needs one. The agents are stateless request-shaped capabilities; the only persistent data is test fixtures and observability records, both of which are git-tracked JSON. Adding Postgres would be architecture for its own sake.

The durability guarantee that *does* matter: **promoted fixtures are correctness baselines** and must survive unchanged (`context.md` must-not-change constraints). The "boundary" is the `fixtures/promoted/` directory plus the rule that they're only regenerated, never hand-edited. → schema shape lives in `.aipe/study-data-modeling/`.

---

## 6. failure-handling-and-reliability

The richest lens after the boundaries lens — failure handling is genuinely designed here, not bolted on.

**Bounded work is the primary reliability mechanism** (`packages/runtime/src/run-agent-loop.ts:98-102`). The loop *cannot* run forever: `for (let turn = 0; turn < maxTurns; turn += 1)` plus the `maxToolCalls` budget. A misbehaving model that keeps calling tools hits a hard ceiling and gets forced into a final answer (`forceFinal` at line 102 strips tools so the model *must* synthesize). → see `02-bounded-agent-loop.md`.

**Provider fallback** (`packages/providers/fallback/src/fallback-provider.ts:47-89`). If one provider throws (rate limit, outage, bad key), the chain tries the next. Abort signals are preserved (`isAbortError`), and a customizable `shouldFallback` predicate can stop the chain early. Exhausting the chain throws a `ProviderFallbackError` carrying every attempt. → see `03-fallback-chain.md`.

**Context-window guard** (`packages/providers/local/src/context-window-guard.ts:57-70`). Pre-flight token estimation rejects an over-budget request *before* it's sent — throws `ContextWindowExceededError` and emits a warning rather than letting the vendor reject it. Composed in front of a provider, ahead of or inside the fallback chain. → see `03-fallback-chain.md`.

**Structured-generation retry** (`packages/runtime/src/structured-generation.ts:62-100`). When a model returns malformed JSON, it retries up to `maxAttempts` (default 2), appending a strict "return ONLY valid JSON" suffix on the retry. Failure emits an error event and returns `{ ok: false }` — degraded, not crashed.

**Loop-level recovery** (`packages/runtime/src/run-agent-loop.ts:192-228`). If `parseResult` returns null after the loop, an optional `recoveryPrompt` triggers one more bare model call to coax a parseable answer. Recovery failures emit warnings but don't propagate.

**Graceful degradation everywhere.** The query agent returns a `FALLBACK_ANSWER` if the loop produces nothing (`packages/agents/query/src/query-agent.ts:101`). Anomaly monitoring returns `[]` rather than failing when no anomaly is found. Memory writes are **best-effort**: `recall` returns `[]` rather than throwing if the embedder yields no vector (`packages/memory/src/conversation-memory.ts:91`), and the consumer treats `remember` as fire-and-forget — buffr wraps it in a try/catch that swallows failures so a memory-write error can't lose the answer the user already received (`buffr/src/session.ts:64-69`). The design call: memory is an *enhancement*, so its failure degrades silently rather than failing the turn.

Partial failure across a *process boundary*? `not yet exercised` — there's only one synchronous external call (the SDK), and its failure is handled by the fallback chain. No two-phase commit, no saga, no distributed retry. → coordination mechanics would belong to study-distributed-systems.

---

## 7. scale-bottlenecks-and-evolution

What breaks first, and what would force a rearchitecture.

**At 10x usage (10x more agent runs):** nothing in *this* repo breaks first — the bottleneck is the **vendor API rate limit and cost**, which is external. The fallback chain (`03-`) already routes around a single provider's limit; the next move would be a response cache at the `ModelProvider` seam (the slot named in lens 4) and request batching. Both slot into the existing seam without touching agents.

**At 10x fixtures/replays:** the eval pipeline reads every artifact file synchronously (`packages/evals/src/replay-runner.ts:70-94`, `evaluateReplayArtifactFiles` loops files one at a time). That's fine at tens of fixtures; at thousands it's a linear file-IO scan with no parallelism. Stays stable far longer than you'd think because evals run in CI, not the hot path.

**At 10x corpus (10x more indexed chunks):** `InMemoryVectorStore.search` does an O(n) cosine scan over every chunk per query (`packages/retrieval/src/in-memory-vector-store.ts:25-33`), and the corpus re-indexes on each process start. That's the first retrieval bottleneck — fine for a personal-notes corpus, linear at thousands of chunks. The fix is the `VectorStore` seam: a `PgVectorStore` with an ANN index replaces the scan and adds persistence, with no change to the pipeline, the `search_knowledge_base` tool, or the rag-query agent. → `09-retrieval-pipeline-seam.md`.

**At 10x memory (a long-lived user accumulating exchanges):** in the *shared* topology, every remembered turn adds a row to the same store documents live in, and memory recall is the same O(n) scan plus a `k×4` over-fetch to clear documents off the top (`packages/memory/src/conversation-memory.ts:94`). Two pressures compound: the store grows unbounded (no decay/consolidation — explicitly out of scope, `packages/memory/README.md`), and memory rows increasingly compete with documents for top-k slots. The same `VectorStore`/ANN-index fix handles the scan; the *unbounded growth* would force memory management (summarization, decay) that the package deliberately defers. The dedicated-store topology trades one operated store for clean isolation. → `10-memory-store-topology.md`.

**What stays stable under any growth:** the `ModelProvider` contract, the `EmbeddingProvider` / `VectorStore` retrieval contracts (now proven by *two* consumers — the RAG pipeline and memory), `CapabilityEvent`, `ToolRegistry`, `WorkspaceDescriptor` (the load-bearing interfaces). They're narrow; growth happens behind them.

**What would force a rearchitecture:** moving from "library a host app imports" to "hosted service with traffic." That introduces everything currently `not yet exercised` — an HTTP server, auth, a request queue, a real datastore for traces, horizontal replicas. The current architecture has *no server* (Studio's Vite middleware is a dev convenience, not production). That's the cliff. Everything up to it is incremental.

---

## 8. system-design-red-flags-audit

Ranked architectural risks, each grounded in real evidence. These are honest observations, not alarms — most are "fine for a library, would bite as a service."

1. **The pipeline orchestration lives in Studio, not in a package** (`apps/studio/vite.config.ts`, `apps/studio/src/agent-runners.ts`). The monitor→diagnose→recommend wiring is in the dev app, not in `packages/`. A host app importing core gets the six agents but has to re-wire the pipeline itself. If the pipeline is a real product capability, it belongs in a package with its own contract. Right now it's only demonstrated, not shipped. → `05-multi-agent-pipeline.md` walks this.

2. **Cost pricing only covers `gpt-4.1-*`** (`usage-ledger.ts`). The usage/cost ledger silently under-reports for any other model. Lower blast radius now that the default reasoning model is *local Gemma* (zero marginal cost) — but if a host app wires a cloud adapter back in, a model the ledger doesn't price reports wrong cost numbers without erroring.

3. **`InMemoryVectorStore.search` is a full linear scan** (`packages/retrieval/src/in-memory-vector-store.ts:25-33`) and the corpus is re-indexed on every run (no persistence). Correct for the from-scratch in-memory adapter and tiny corpora; at thousands of chunks it's O(n) cosine per query with no ANN index. The `VectorStore` contract is exactly the seam where `PgVectorStore` slots in to fix both — named, not yet built. → `09-retrieval-pipeline-seam.md`.

4. **`rubric-improvement` has no `replay:promoted` script wired into the root pipeline** (`context.md`). The other agents with deterministic regression coverage have promoted fixtures; this one doesn't. It can drift under a model update without a test catching it. → `06-replay-eval-pipeline.md` covers what the others get that this one misses.

5. **Token estimation is a `charsPerToken` heuristic** (`packages/providers/local/src/context-window-guard.ts:100-103`, default 3 chars/token). It's a coarse approximation — a request near the budget edge could be wrongly admitted or wrongly rejected. This guard matters *more* now: the bundled default is local Gemma with a ~8k window (`ask.ts:52` sets `maxTokens: 8192`), so the estimate is the thing standing between a too-long prompt and a vendor rejection. Fine as a guard rail; not a precise accountant.

6. **No cache means identical `complete()` calls re-run** (lens 4). Cheaper now that the default model is local (no per-token cost), but still wasted compute at scale. The seam to fix it already exists.

7. **Shared-store memory has no bound and pollutes document recall** (`packages/memory/src/conversation-memory.ts`, `buffr/src/session.ts:53`). In the topology buffr actually wires, memory rows share the document store and grow unbounded — there's no decay, summarization, or consolidation (deliberately out of scope per `packages/memory/README.md`). Memory rows also rank against documents in `search_knowledge_base`; the `k×4` over-fetch mitigates starvation but the corpora still compete. Correct for a personal single-user runtime; the dedicated-store topology (with a `search_memory` tool) is the named fix and is built but not yet exercised by any consumer. → `10-memory-store-topology.md`.

None of these are "stop the ship." They're the difference between a clean library and a production service — which is exactly the line this repo sits on.
