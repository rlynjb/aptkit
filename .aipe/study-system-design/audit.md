# audit.md — the 8-lens system-design sweep

Pass 1. Walk aptkit against the 8 system-design lenses. Every lens is checked;
where the repo doesn't exercise a lens, it says `not yet exercised` plainly rather
than inventing infrastructure. Significant findings cross-link into the Pass 2
pattern files.

Scope note: aptkit is the *library*. buffr (`/Users/rein/Public/buffr`) is the one
known *deployment* that consumes it. Both are in scope because the architectural
story is the seam between them — but findings stay labelled with which repo they
live in.

---

## 1. system-map-and-boundaries

The full map is in `00-overview.md`. The skeleton is four library layers plus one
deployment consumer:

- **Studio** (`apps/studio`, React/Vite) — dev-only UI. Five analytics agents run
  behind a shared `AgentReplayShell`; three off-shell pages (`CapabilitiesWorkspace`,
  `RagQueryWorkspace`, `DocPage`). Studio runs the *real* agent code in-process via
  Vite middleware (`apps/studio/vite.config.ts:201`) and streams the trace as NDJSON.
- **agents** (`packages/agents/*`) — six capabilities. Each is a thin assembly:
  prompt package + tool policy + `runAgentLoop` config + output validator. Not a
  service each — a function each.
- **runtime** (`packages/runtime`) — the foundation, zero internal deps. Owns the
  three load-bearing contracts: `ModelProvider` (`model-provider.ts:54`),
  `CapabilityEvent`/`CapabilityTraceSink` (`events.ts:1`), and the bounded
  `runAgentLoop` (`run-agent-loop.ts:76`).
- **providers** (`packages/providers/*`) — `ModelProvider` adapters: `gemma` (local
  Ollama, the default), `local` (context-window guard wrapper), `fallback`
  (sequential chain), plus `anthropic`/`openai` (unbundled cloud adapters).
- **retrieval + memory** (`packages/retrieval`, `packages/memory`) — the RAG
  pipeline behind the `EmbeddingProvider`/`VectorStore` contracts (`contracts.ts:22`),
  and an episodic memory engine that reuses those same two contracts.

**Trust boundaries.** The hard boundary is the library/deployment seam: aptkit
ships as `@rlynjb/aptkit-core@0.4.1` to npm (root `private:true`, `packages/core`
holds `bundledDependencies` for all 16 internal packages). buffr is a *separate*
repo that imports the published bundle. The other boundary is the local-vs-cloud
network edge — the default path makes **zero** cloud calls: gemma talks to Ollama
over plain HTTP `:11434`, no key, no TLS (`gemma-provider.ts:201`). Cloud keys
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) live in a gitignored `.env` and are only
read by the unbundled cloud adapters.

**External dependencies.** Ollama (local HTTP) for the default model + embeddings;
npm registry for distribution; Supabase Postgres — but only on buffr's side.

→ The boundaries are deep enough that three earn their own pattern files:
`01-provider-neutral-model-seam.md`, `02-retrieval-contracts-as-the-swap-point.md`,
`03-library-vs-deployment-split.md`.

## 2. request-response-and-data-flow

Two flows matter.

**Agent answer flow** (the hot path). A question enters an agent's `answer()`,
which calls `runAgentLoop`. The loop alternates model turns and tool turns until
the model stops calling tools, a turn budget is hit, or a tool-call budget is hit.
For the RAG agent (`rag-query-agent.ts:62`): question → `runAgentLoop` (maxTurns 6,
maxToolCalls 4) → model decides to call `search_knowledge_base` → tool embeds the
query, searches the store, returns ranked chunks with citations → model synthesizes
a grounded answer. The model decides *whether* to retrieve — that's agentic
retrieval, not a fixed pipeline.

→ Walked in full in `04-bounded-agent-loop.md`.

**Index flow.** `indexDocument` (`pipeline.ts:32`): doc → `chunkText` →
`embedder.embed(texts)` → `store.upsert(chunks)`, each chunk id `<docId>#<i>`, meta
carrying `docId`/`chunkIndex`/`text` for citations. The query flow is the mirror:
`queryKnowledgeBase` (`pipeline.ts:50`) embeds the query, searches, returns ranked
hits. `remember`/`recall` in memory are literally this same index/query pair with a
`kind:'memory'` tag (`conversation-memory.ts`).

**Studio handoff.** Studio's Vite middleware runs the agent and streams each
`CapabilityEvent` to the browser as `application/x-ndjson`
(`apps/studio/vite.config.ts:901`), so the UI renders the trajectory live.

→ The trace handoff is its own pattern: `05-capability-event-trace.md`.

## 3. state-ownership-and-source-of-truth

aptkit the library is almost entirely **stateless** — its job is to define
contracts and run pure-ish functions over injected state. The state that exists:

- **Conversation state** lives in `runAgentLoop`'s local `messages` array
  (`run-agent-loop.ts:94`) — owned by a single run, discarded when it returns.
  There is no cross-call history in aptkit; each `answer()` is independent. buffr's
  `session.ts:24` calls this out explicitly as still-missing sequential history.
- **Vector corpus state** is owned by whatever `VectorStore` is injected. In
  aptkit's default that's `InMemoryVectorStore` — a `Map` (`in-memory-vector-store.ts:12`),
  process-lifetime only. In buffr it's `PgVectorStore` — durable Postgres, the real
  source of truth.
- **Memory state** is vector rows in that same store, namespaced `memory:<convId>:<n>`,
  tagged `kind:'memory'` — a logical partition over a shared collection.
- **Trace state** is write-only and owned by the sink: in-memory for Studio replay,
  Postgres `agents.messages` for buffr (`supabase-trace-sink.ts:49`).

The clean answer: aptkit owns *behavior*, the injected store/sink owns *state*. The
source of truth for durable data is buffr's Postgres, not anything in aptkit.

## 4. caching-and-invalidation

`not yet exercised` as a deliberate cache layer. There is no read cache, no
memoized model response, no embedding cache, no TTL/invalidation logic anywhere in
either repo. The only thing cache-adjacent:

- buffr holds **one warm pg pool** per `ChatSession` (`session.ts:39`) — connection
  reuse, not a data cache.
- `runAgentLoop` truncates tool results to 16,000 chars before feeding them back
  (`run-agent-loop.ts:52`) — context-window protection, not caching.
- Fixtures (recorded `ModelResponse[]`) are *replayed* deterministically, which is
  cache-like in effect (skip the model), but it's a test artifact, not a runtime
  cache — see `06-fixture-replay-evals.md`.

If aptkit later cached embeddings or model responses, the invalidation key would be
(model id + input hash) — but nothing does today.

## 5. storage-choice-and-durability-boundaries

Two stores behind one contract — this is the second-most load-bearing thing in the
repo.

- **`InMemoryVectorStore`** (`in-memory-vector-store.ts:10`) — a `Map<id, chunk>`,
  cosine similarity by linear scan. Zero durability: state dies with the process.
  Its job is "build the whole RAG pipeline with zero cloud" and to be the test
  double. It is intentionally O(n) per query — fine at fixture scale, a bottleneck
  at corpus scale (see lens 7).
- **`PgVectorStore`** (buffr, `pg-vector-store.ts:19`) — `implements VectorStore`
  over Supabase pgvector. Durable, transactional upsert (`begin`/`commit`/`rollback`,
  `pg-vector-store.ts:40`), partitioned by `app_id`, cosine *distance* via the
  `<=>` operator with `score = 1 - distance` (`pg-vector-store.ts:69`). This is the
  real durability boundary.

The dimension is a one-way door: `assertWiring` (`pipeline.ts:22`) and both stores'
`assertDimension` throw loudly on a mismatch, because a silently mismatched vector
corrupts ranking rather than erroring.

→ Storage *choice as a swap point* is `02-retrieval-contracts-as-the-swap-point.md`.
Engine internals (HNSW index, pgvector operators, transaction mechanics) belong to
**`study-database-systems`**; the schema shape (the `agents` tables, `app_id` key,
the dropped FK for memory rows) belongs to **`study-data-modeling`**.

## 6. failure-handling-and-reliability

Failure containment is real and lives at three levels:

- **Per-tool-call** (`run-agent-loop.ts:158`) — a tool throw is caught, serialized
  as `{ error }`, and fed back to the model as a `tool_result` with `isError:true`.
  One tool failing does not abort the run; the model gets to react.
- **Provider fallback** (`fallback-provider.ts:47`) — try adapters in order, record
  each failed attempt, emit a `warning` trace event, advance. All-fail throws a
  `ProviderFallbackError` carrying every attempt. Abort signals are *not* swallowed
  — they re-throw immediately (`fallback-provider.ts:65`).
- **Pre-flight guard** (`context-window-guard.ts:57`) — the local guard estimates
  input tokens and throws `ContextWindowExceededError` *before* calling the model,
  so an oversized prompt fails fast and (in a fallback chain) hands off to the next
  provider instead of erroring deep inside Ollama.

**Cancellation** is threaded end-to-end via `AbortSignal`: the loop calls
`signal?.throwIfAborted()` each turn (`run-agent-loop.ts:99`), passes it to the
model and tools, and abort errors are distinguished from real failures everywhere.

**Recovery turn** — when the loop ends without parseable structured output, an
optional `recoveryPrompt` runs one final no-tools turn to coax the answer
(`run-agent-loop.ts:204`). A failure there is swallowed into a `warning`, not raised.

**buffr durability** — memory writes are best-effort: a `memory.remember` failure is
caught and swallowed so the user still gets the answer they already have
(`session.ts:65`). Trace writes are queued and `flush()`ed after the run.

Coordination correctness *across processes* is **not yet exercised** — see lens 7
and **`study-distributed-systems`**.

## 7. scale-bottlenecks-and-evolution

What breaks first, honestly:

- **`InMemoryVectorStore` is O(n) linear scan** (`in-memory-vector-store.ts:25`) and
  process-bound. It breaks at any real corpus size. The evolution is already built:
  swap in `PgVectorStore` (HNSW index, ANN search) — no pipeline change, because
  both satisfy the same contract. This is the design paying off.
- **Single process, single conversation.** buffr's `ChatSession` (`session.ts:34`)
  is one warm pool, one conversation, in-process. There is **no horizontal scale, no
  queue, no load balancer, no worker pool, no multi-region anything** — `not yet
  exercised`. The model is "one laptop, one user." At 10x users this needs a request
  queue and connection-pool tuning; at 100x it needs a different architecture
  entirely. The honest framing: this is laptop-runtime system design, not
  large-fleet system design.
- **No sequential conversation history.** Each `answer()` is independent
  (`session.ts:24` flags it). Retrieval-based memory gives relevance-based recall but
  not turn-order context — an aptkit-side change when it lands.
- **Tool-call emulation tax.** Gemma has no native tool-calling, so the gemma
  provider renders tools into the system prompt and parses JSON back with up to 2
  retries (`gemma-provider.ts:62`). That's latency and fragility the cloud adapters
  don't pay. Swapping to anthropic/openai removes it — the seam is already there.

What stays stable under all of the above: the four contracts. That's the point of
the design — scale changes the implementation behind a seam, never the seam.

## 8. system-design-red-flags-audit

Ranked architectural risks, each grounded:

1. **In-memory store presented as a store, not a demo double.** `InMemoryVectorStore`
   is the aptkit default and the only bundled `VectorStore`. A consumer who forgets
   to inject `PgVectorStore` ships a process-lifetime corpus that silently vanishes
   on restart. Mitigation exists (buffr does inject it) but the default is the
   dangerous one. Evidence: `in-memory-vector-store.ts:10`, `session.ts:41`.
2. **No cross-process coordination, but the schema invites it.** buffr's `agents`
   schema is `app_id`-keyed and durable — it *looks* multi-tenant — yet the runtime
   is single-process with no locking, no queue, no idempotency on writes. Two
   concurrent `ChatSession`s on the same `app_id` would interleave trace writes with
   no ordering guarantee beyond the persisted `created_at`. `not yet exercised` is the
   honest label; the risk is that the schema's shape implies a concurrency story the
   runtime doesn't have. Evidence: `supabase-trace-sink.ts:49`, `session.ts:34`.
3. **Tool-call emulation is a correctness surface, not just latency.** The gemma
   provider parses free-form model text into tool calls (`gemma-provider.ts:168`).
   A weak local model can botch the JSON; the retry/nudge + `minTopK` floor
   (`search-knowledge-base-tool.ts:51`) are real mitigations, but the failure mode
   (silent wrong-or-no tool call) is subtler than a cloud provider's typed tool API.
4. **Published-API surface is broad and hand-maintained.** `packages/core/src/index.ts`
   re-exports 16 packages, some with explicit per-name lists and type aliases
   (`MonitoringAnomaly`, `DiagnosticAnomaly`). Every one is a semver compatibility
   commitment (`0.4.x`). Drift between what's exported and what's documented is a
   real maintenance risk. Evidence: `packages/core/src/index.ts`.
5. **Fixtures as correctness baselines can rot silently.** Promoted fixtures are the
   test oracle (`06-fixture-replay-evals.md`). If a fixture is promoted from a buggy
   run, the bug becomes the baseline. The pipeline assumes the promoter judged the
   run correct. Evidence: `scripts/promote-replay-to-fixture.mjs`, fixtures under
   `packages/agents/*/fixtures/promoted/`.
