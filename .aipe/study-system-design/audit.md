# audit.md — the 8-lens system-design audit

Pass 1. Each lens walked against the live codebase. Grounded in real
`file:line`, or `not yet exercised` when the repo doesn't reach it. Where a
finding is load-bearing enough for its own deep walk, the lens cross-links to
the Pass 2 pattern file.

---

## 1. system-map-and-boundaries

The full picture is in `00-overview.md`. The components and their boundaries:

**Components**
- Presentation: `apps/studio` (React/Vite dev UI + static Pages demo) and
  buffr's CLI TUI (`/Users/rein/Public/buffr/src/cli/chat.tsx`).
- Capabilities: six agents under `packages/agents/*`. Each is one capability
  = prompt package + tool policy + loop config + validator (the shape is
  enumerated in `packages/core/src/index.ts:11-75`).
- Runtime foundation: `packages/runtime` — `runAgentLoop`
  (`run-agent-loop.ts:76`), the `CapabilityEvent` union (`events.ts:1-24`),
  JSON extraction, usage ledger. Zero internal dependencies.
- Model port: `ModelProvider` (`packages/runtime/src/model-provider.ts:54-58`)
  with five adapters (`packages/providers/{gemma,local,fallback,anthropic,openai}`).
- Retrieval ports: `EmbeddingProvider` + `VectorStore`
  (`packages/retrieval/src/contracts.ts:22-37`), implemented by
  `OllamaEmbeddingProvider` + `InMemoryVectorStore` in aptkit, `PgVectorStore`
  in buffr (`/Users/rein/Public/buffr/src/pg-vector-store.ts:19`).
- Memory: `@aptkit/memory` (`packages/memory/src/conversation-memory.ts:60`)
  — a second consumer of the retrieval ports, no new infra.

**Trust / deployment boundaries** (where an axis flips):
- **The model port** — above it, code decides control flow; below
  `complete()` the boundary is to an external system (Ollama localhost, or a
  cloud SDK). Trust and failure-origin flip here. → `01-provider-abstraction.md`.
- **The deployment boundary** — aptkit ships as a bundle; buffr installs it
  and supplies the durable slots. Library code (deployment-agnostic) vs
  deployment code (Supabase-specific) flip here. → `05-library-vs-deployment-split.md`.
- **The tool boundary** — each agent sees only an allowlisted subset of tools
  (`packages/tools/src/tool-policy.ts:11-23`); capability scope flips at the
  policy filter. The agents are all read-only.

**External dependencies**: Ollama (`:11434`, no key/no TLS), Anthropic SDK,
OpenAI SDK (cloud, env-keyed), and — in buffr only — Supabase Postgres +
pgvector.

→ Deep walk of the whole map: `00-overview.md`.

---

## 2. request-response-and-data-flow

The one important end-to-end flow is **a question answered by an agent**.
Control flows down, `CapabilityEvent`s flow back up.

```
  end-to-end: a RAG query (buffr deployment)

  CLI turn ─► RagQueryAgent ─► runAgentLoop ─┬─► ModelProvider.complete()  (gemma → Ollama)
                                             │
                                             └─► search_knowledge_base ─► pipeline.query()
                                                     │
                                                     ├─ embed query  (OllamaEmbeddingProvider)
                                                     └─ store.search  (PgVectorStore: <=> cosine over HNSW)
                                             ◄── ranked chunks + citations
            ◄── finalText (forced synthesis on last turn) + trace events (NDJSON)
```

- The loop is **sequential within a turn, multi-turn across the question**:
  the model decides whether to call `search_knowledge_base` again or answer
  (`run-agent-loop.ts:98-190`). This is agentic retrieval — no fixed waterfall.
  → `02`, `03`.
- **No fan-out / parallel work.** Tool calls within a turn are awaited in a
  serial `for` loop (`run-agent-loop.ts:139-187`). One model call, then its
  tool calls, then the next turn.
- **Handoff to the client**: in Studio, the runtime's trace events are written
  to the response as newline-delimited JSON
  (`apps/studio/vite.config.ts`, `content-type: application/x-ndjson`), so the
  browser renders each step as it arrives. → `04`.

---

## 3. state-ownership-and-source-of-truth

aptkit is almost stateless by design; durable state lives in buffr.

| State | Lives in | Owner | Mutability |
| --- | --- | --- | --- |
| conversation messages (in a turn) | `runAgentLoop`'s local `messages[]` (`run-agent-loop.ts:94`) | the loop | discarded after the run |
| tool-call records / trace | emitted as events, not stored in aptkit | the trace sink | append-only |
| vector corpus (aptkit) | `InMemoryVectorStore` (a JS array) | the store instance | lost on process exit |
| vector corpus (buffr) | `agents.chunks` (Postgres) | buffr's `PgVectorStore` | durable, `app_id`-keyed |
| conversation memory rows | the SAME vector store, tagged `meta.kind:'memory'` (`conversation-memory.ts:80-86`) | memory engine | durable only if store is PgVectorStore |
| trace persistence | `agents.messages` etc. (buffr) | `SupabaseTraceSink` | durable (buffr only) |
| replay artifacts | `artifacts/replays/*.json` (filesystem) | scripts | append-only files |
| fixtures | `packages/agents/*/fixtures/*.json` | promote pipeline | regenerated, not hand-edited |

The source of truth for *correctness* is the **promoted fixture set** — a
deterministic baseline replayed by `FixtureModelProvider`. → `07`.

The embedding dimension is a one-way-door piece of state: the corpus is
embedded at 768 dims and a mismatched query vector is rejected loudly
(`contracts.ts:28-37`, enforced in `in-memory-vector-store.ts` and at wiring
in `pipeline.ts`). → `02`.

---

## 4. caching-and-invalidation

**`not yet exercised` as a deliberate cache layer.** There is no response
cache, no embedding cache, no CDN, no memoization of model calls. Two things
that look adjacent but are *not* caches:

- The in-memory vector store is the *primary* store in aptkit, not a cache of
  a durable one (`in-memory-vector-store.ts`).
- Studio replay reads recorded artifacts instead of calling a live model, but
  that's deterministic replay for testing, not a freshness cache. → `07`.

The closest thing to invalidation is the **fixture-promotion** flow: a fixture
is the cached "correct answer," and re-promotion (`promote:replay`) is its
manual invalidation. Noted here, walked in `07`.

---

## 5. storage-choice-and-durability-boundaries

Two stores, one contract.

- **`InMemoryVectorStore`** (`packages/retrieval/src/in-memory-vector-store.ts`)
  — a cosine-similarity linear scan over a JS array. Exists so the library
  and tests run with zero external dependencies. Durability: none; dies with
  the process. Owns nothing persistent.
- **`PgVectorStore`** (`/Users/rein/Public/buffr/src/pg-vector-store.ts:19`)
  — implements the same `VectorStore` contract over Supabase pgvector. Uses
  the cosine-distance operator `<=>` with an HNSW index
  (`/Users/rein/Public/buffr/sql/001_agents_schema.sql:28-29`,
  `hnsw (embedding vector_cosine_ops)`). Durable, `app_id`-keyed for
  multi-tenant separation. Owns the persistent corpus + memory rows.

The durability boundary *is* the deployment boundary: aptkit holds no durable
state on purpose; buffr supplies it by implementing the port. → `05`.

Engine internals (HNSW graph structure, pgvector query execution, the `<=>`
operator) belong to **`study-database-systems`**. The schema shape
(documents/chunks/conversations/messages/profiles) belongs to
**`study-data-modeling`**. This guide owns only the boundary: why the store is
a swappable port rather than a hardcoded database.

---

## 6. failure-handling-and-reliability

The repo handles a specific set of failures explicitly:

- **Slow / dead model provider** → the fallback chain
  (`packages/providers/fallback/src/fallback-provider.ts:50-88`) tries
  providers in order, emits a trace warning per failover, throws
  `ProviderFallbackError` only if all fail. A `shouldFallback` hook can stop
  the chain early. → `01`.
- **Context-window overflow** → the local guard
  (`packages/providers/local/src/context-window-guard.ts`) estimates input
  tokens against `maxTokens - outputReserve` (default reserve 768) and throws
  `ContextWindowExceededError` *before* the call — fail-fast, no truncation.
- **Runaway agent** → the loop is bounded by `maxTurns` and `maxToolCalls`,
  and forces a final synthesis turn when the budget is spent
  (`run-agent-loop.ts:101-109`). The loop cannot run forever or end without an
  answer. → `03`.
- **Model refuses to answer / returns no parse** → recovery turn
  (`run-agent-loop.ts:204-228`): a second constrained call demands only the
  structured answer.
- **Weak local model starves retrieval** → `minTopK` floor and a
  hallucination-tolerant metadata filter
  (`search-knowledge-base-tool.ts:51,81,101-105`) so a bad `top_k:1` or a
  hallucinated filter can't silently wipe results. → `02`.
- **Tool throws** → caught per call, serialized as an error tool-result so the
  model can react instead of crashing the run (`run-agent-loop.ts:163-186`).
- **Cancellation** → `AbortSignal` checked each turn and threaded into model +
  tool calls (`run-agent-loop.ts:99,159`). See `study-runtime-systems`.

**`not yet exercised`**: retries with backoff (the fallback chain tries each
provider once, no retry), circuit breakers, dead-letter queues, idempotency
keys. The coordination-correctness reasoning for the fallback chain belongs to
**`study-distributed-systems`**.

---

## 7. scale-bottlenecks-and-evolution

What breaks first, honestly:

- **Single process, single laptop.** buffr holds one conversation in-process
  with one `pg.Pool` (`buffr/src/cli/chat.tsx`, confirmed: no queue, worker,
  cluster, load-balancer, or multi-region code anywhere in either repo). At
  10x concurrent users this is the first wall — there is no horizontal scale
  story. **`not yet exercised`** and named as the top red flag below.
- **`InMemoryVectorStore` is a linear scan.** O(n) per query over a JS array.
  Fine for a demo corpus; it falls over well before the HNSW index would. The
  port design means the fix is already shipped — swap in `PgVectorStore`. The
  *architecture* scales even though the default adapter doesn't.
- **Serial tool execution** within a turn (`run-agent-loop.ts:139`). No
  parallel fan-out; a multi-tool turn is as slow as the sum of its tools.
- **The bundle.** 16 packages inlined into one tarball. Adding a package means
  remembering its `"files": ["dist/src"]` or `npm pack` silently drops it
  (`RELEASE.md`). This is a publishing-process bottleneck, not a runtime one. → `06`.

**What stays stable at 10x**: every port. Swapping `InMemoryVectorStore` →
`PgVectorStore`, or gemma → a hosted model, requires zero changes above the
adapter. The seam design is the evolution path. → `01`, `02`, `05`.

**What would force a rearchitecture**: real concurrent multi-user load. The
in-process, single-conversation runtime in buffr would need a request layer,
a connection-pooling story beyond one `pg.Pool`, and a queue for long agent
runs. None of that exists yet.

---

## 8. system-design-red-flags-audit

Ranked by architectural risk, each grounded:

1. **No horizontal-scale path (highest).** Single-process, single-laptop
   runtime; no queue/worker/load-balancer (`buffr/src/cli/chat.tsx`, confirmed
   absent across both repos). This is acceptable *today* — buffr is explicitly
   a laptop runtime — but it's the change that forces rearchitecture if usage
   grows. Honest `not yet exercised` for everything past one user.
2. **In-memory store is O(n) and non-durable by default.** The default aptkit
   path loses the corpus on exit and scans linearly
   (`in-memory-vector-store.ts`). Mitigated by the port: the durable HNSW
   adapter exists in buffr. Risk is "someone ships the default to prod," not a
   design flaw.
3. **Gemma tool-calling is emulated, not native.** The gemma adapter fakes
   tool-calling by asking for a JSON object and parse-retrying
   (`packages/providers/gemma/src/gemma-provider.ts:129-187`). A model that
   ignores the format wastes the retry budget. The `minTopK` floor + tolerant
   filter (`02`) are the guardrails bolted on because of exactly this fragility.
4. **Bundle-publishing footgun.** A new bundled package without
   `"files": ["dist/src"]` is silently excluded from the tarball
   (`RELEASE.md`, `scripts/pack-core-standalone.mjs`). Process risk, caught
   only at install time downstream. → `06`.
5. **`rubric-improvement` has no `replay:promoted` wired into the root
   pipeline** (others do; `.aipe/project/context.md`). One capability's
   correctness baseline isn't in the deterministic gate. → `07`.
