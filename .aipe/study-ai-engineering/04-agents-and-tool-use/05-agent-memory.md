# Agent memory

**Subtitle:** Conversation / episodic memory · retrieval contracts reused, zero new infra · *Industry standard (built; wired in buffr, not yet in an aptkit agent)*

## Zoom out, then zoom in

Agent memory is how a conversation outlives a single turn — short-term (the messages
in this run) and long-term (past exchanges recalled later). The headline in aptkit is
that long-term memory adds **zero new infrastructure**: it reuses the exact retrieval
contracts (an `EmbeddingProvider` + a `VectorStore`). `remember` *is* the RAG index
path; `recall` *is* the RAG query path. Memory is RAG pointed at conversations.

```
  Zoom out — memory rides the retrieval contracts

  ┌─ ConversationMemory (conversation-memory.ts) ──────────────┐
  │  ★ remember(turn) = embed the exchange → store.upsert ★     │ ← we are here
  │  ★ recall(query)  = embed query → store.search → filter ★   │
  │  uses EmbeddingProvider + VectorStore — NOTHING new         │
  └───────────────────────────┬─────────────────────────────────┘
                              │ same contracts as documents
  ┌─ Retrieval (@aptkit/retrieval) ───▼─────────────────────────┐
  │  embed → vector store → search — the RAG pipeline           │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. There are two memory *layers*. Short-term is the `messages` array inside
`runAgentLoop` — in-context, and it dies when the conversation ends. Long-term is the
vector-stored exchanges, recalled by similarity on a future query. The clever part is
that long-term memory needed no new component: it borrows RAG's two contracts and
tags its rows `kind: 'memory'` so it can coexist with documents in the same store.

## Structure pass

**Layers.** Conversation loop (short-term, the `messages` array) → `ConversationMemory`
(long-term engine) → `EmbeddingProvider` + `VectorStore` (the shared contracts) →
durable store (buffr's `PgVectorStore`).

**Axis — lifetime of state.** How long does a turn survive? Trace it: a turn lives in
the `messages` array only for the current run (`run-agent-loop.ts:94`) — short-term,
dies with the conversation. `remember` embeds and upserts it into the vector store
(`conversation-memory.ts:80`) — now it survives across runs, even across sessions.
The axis "does this turn outlive the conversation?" flips at the `store.upsert` in
`remember` — that's the short-term → long-term boundary.

**Seam.** The `VectorStore` contract. `ConversationMemory` never names a database; the
store is *injected* (`conversation-memory.ts:60`). Pass buffr's `PgVectorStore` for
durable memory or an `InMemoryVectorStore` for tests — the engine logic is identical.
That injection seam is why memory is infrastructure-free: it speaks the contract, the
caller supplies the implementation.

## How it works

### Move 1 — the mental model

You know two kinds of state in a web app: component state (lives for this render,
gone on unmount) and a database row (persists, queried later). Agent memory is the
same split. Short-term memory is component state — the `messages` array, alive for
this run. Long-term memory is the database row — except the "query" isn't a `WHERE`
clause, it's a similarity search. To recall, you don't look up by key; you embed the
new question and find the most *similar* past exchanges.

```
  Two memory layers ≈ component state vs a DB row

  SHORT-TERM (messages array)        LONG-TERM (vector-stored exchange)
  ┌────────────────────────┐         ┌──────────────────────────────────┐
  │ alive this run only     │        │ survives across runs/sessions      │
  │ in-context, free        │        │ recalled by similarity, not by key │
  │ dies with conversation  │        │ remember = upsert, recall = search │
  └────────────────────────┘         └──────────────────────────────────┘
```

### Move 2 — the mechanisms

**Mechanism 1 — `remember` is the RAG index path.** To remember an exchange, format
it, embed it, and upsert it as a vector row tagged `kind: 'memory'`
(`conversation-memory.ts:74`):

```ts
async remember(turn: MemoryTurn): Promise<void> {
  const text = format(turn);                          // "user asked: ... assistant answered: ..."
  const [vector] = await embedder.embed([text]);
  if (!vector) return;
  const n = counters.get(turn.conversationId) ?? 0;
  counters.set(turn.conversationId, n + 1);
  await store.upsert([{
    id: `${kind}:${turn.conversationId}:${n}`,        // id e.g. memory:<convId>:3
    vector,
    meta: { kind, conversationId: turn.conversationId, text },   // tagged as memory
  }]);
}
```

This is *literally* the document-indexing path — embed, upsert — pointed at a
conversation exchange instead of a doc chunk. The `kind` tag is the only thing that
distinguishes a memory row from a document row in a shared store.

```
  remember — the RAG index path, reused

  exchange ─► format ─► embed ─► store.upsert({id: memory:conv:n, meta:{kind:'memory', text}})
                                       (identical to indexing a document chunk)
```

**Mechanism 2 — `recall` is the RAG query path, with a client-side filter.** To
recall, embed the query, search, and keep only memory rows
(`conversation-memory.ts:89`):

```ts
async recall(query: string, k = DEFAULT_RECALL_K): Promise<MemoryHit[]> {
  const [vector] = await embedder.embed([query]);
  if (!vector) return [];
  const fetchK = Math.max(k * 4, 20);                 // OVER-FETCH
  const hits = await store.search(vector, fetchK);
  return hits
    .filter((h) => h.meta?.kind === kind)             // keep only memory rows
    .slice(0, k)
    .map((h) => ({ id: h.id, score: h.score, text: ..., conversationId: ... }));
}
```

The over-fetch (`k*4`, min 20) then client-side filter is forced by the contract: the
`VectorStore.search` has *no metadata predicate* (`conversation-memory.ts:94`). In a
store shared with documents, a top-k search could return all documents and zero memory
rows — so you fetch extra and filter for `kind: 'memory'` in JS. A contract limitation
shaping the call pattern.

```
  recall — the RAG query path + a JS filter

  query ─► embed ─► store.search(fetchK = max(k*4, 20))   ← over-fetch (no metadata predicate)
                          │
                          ▼
                  filter kind=='memory' ─► slice(k)   ← keep memory rows only
```

**Mechanism 3 — the store is injected: shared or dedicated.** The caller decides where
memory lives (`conversation-memory.ts:18`). Two wirings:

- **Shared store** — memory rows live alongside documents; they surface through the
  *existing* `search_knowledge_base` tool. No new tool needed.
- **Dedicated store** — memory is isolated and recalled explicitly via a `search_memory`
  tool from `createMemoryTool` (`memory-tool.ts:28`, `SEARCH_MEMORY_TOOL_NAME = 'search_memory'`).

```
  Two wirings of the same engine

  SHARED store                          DEDICATED store
  docs + memory in one store            memory isolated
  recalled via search_knowledge_base    recalled via search_memory (createMemoryTool)
  (no new tool)                         (a policy-gated tool the agent picks)
```

**Mechanism 4 — short-term is just the loop's `messages` array.** No component for
this: the in-context history is the `messages` array `runAgentLoop` builds and grows
each turn (`run-agent-loop.ts:94, 124, 189`). It's free, it's in-context, and it's
gone when the run returns. Long-term memory is what bridges *across* runs.

```
  Short-term — the loop's own messages array

  messages = [user, assistant, tool_result, assistant, ...]   ← grows each turn
       │ alive only for this runAgentLoop call
       ▼ run returns → array discarded (short-term memory ends)
  (recall pulls relevant LONG-term exchanges back in on the next run)
```

### Move 2.5 — built, not yet wired into an aptkit agent

Be honest about state: `ConversationMemory` and `createMemoryTool` exist and are
tested, but **no aptkit agent wires memory into its loop today**. The agents
(`RagQueryAgent`, etc.) take a model, tools, and profile — none calls
`remember`/`recall`. The durable wiring lives downstream in **buffr's** session
runtime (`/Users/rein/Public/buffr/src/session.ts`): it builds memory over its own
`PgVectorStore`, *shares* the document store, and after each turn calls
`memory.remember({ conversationId, question, answer })` — so future turns surface past
exchanges through `search_knowledge_base`, across sessions.

```
  Current wiring — buffr drives it, aptkit agents don't (yet)

  ┌─ aptkit agents ──────────────┐     ┌─ buffr session.ts ──────────────────┐
  │ RagQueryAgent(model, tools,  │     │ memory = createConversationMemory({  │
  │   profile) — NO memory       │     │   embedder, store: PgVectorStore })  │
  │                              │     │ ask(): answer = agent.answer(q)      │
  │ (future: agent.recall(q)     │     │        memory.remember({...})  ◄──── │ best-effort
  │  before the loop)            │     │ shared store → surfaces via          │
  └──────────────────────────────┘     │ search_knowledge_base                │
                                        └──────────────────────────────────────┘
```

The future move is wiring `recall` *into* an aptkit agent: before the loop, recall the
top-k relevant past exchanges and prepend them to the system prompt or `messages`.
buffr's own comment notes the gap — sequential in-prompt turn history isn't there yet;
each `answer()` still treats the question independently, and relevance-based recall is
what fills it for now. Pseudocode for the not-yet-built agent-side recall:

```text
# NOT in the repo yet — the future aptkit-side wiring
async answer(question):
    past = await memory.recall(question, k=3)        # long-term, by similarity
    system = injectPastExchanges(this.system, past)  # prepend recalled context
    result = await runAgentLoop({ system, userPrompt: question, ... })
    await memory.remember({ conversationId, question, answer: result.finalText })
    return result.finalText
```

### Move 3 — the principle

Memory isn't a new subsystem — it's retrieval pointed at conversations. By making
`remember`/`recall` speak the same `EmbeddingProvider` + `VectorStore` contracts as
documents, aptkit gets durable, cross-session memory for the cost of a `kind` tag and
a client-side filter. The two honest caveats are the interview gold: the over-fetch is
forced by a contract with no metadata predicate, and the whole thing is *built but not
wired into an aptkit agent yet* — buffr drives it. Naming both shows you understand
the design and its current limits.

## Primary diagram

```
  Agent memory — RAG contracts, two layers, injected store

  ┌─ SHORT-TERM — runAgentLoop messages[] ─────────────────────────────┐
  │  in-context history, free, dies when the run returns                │
  └──────────────────────────────────────────────────────────────────────┘
  ┌─ LONG-TERM — ConversationMemory ───────────────────────────────────┐
  │  remember = embed exchange → store.upsert (id memory:conv:n, kind)  │
  │  recall   = embed query → store.search(k*4) → filter kind=='memory' │
  │  store INJECTED: shared (search_knowledge_base) | dedicated (search_memory)
  └───────────────┬─────────────────────────────────────────────────────┘
                  │ same EmbeddingProvider + VectorStore as documents
  ┌─ Durable store — buffr PgVectorStore ─▼─────────────────────────────┐
  │  buffr/src/session.ts: remember() after each turn (shared store)    │
  │  NO aptkit agent wires recall into its loop yet                     │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The field splits memory into short-term (the context window) and long-term
(externalized, usually a vector store) — and increasingly "episodic" (specific past
exchanges) vs "semantic" (distilled facts). aptkit's `ConversationMemory` is episodic:
it stores raw exchanges and recalls them by similarity. The design choice worth
defending is reusing the retrieval contracts rather than building a memory service —
it's the same instinct as memory being "just another corpus." The contract gap (no
metadata filter, hence the over-fetch) is a real cost; a durable backing like buffr's
`PgVectorStore` could push the `kind` filter into SQL and skip the over-fetch entirely.
Read `03-retrieval-and-rag/11-rag.md` for the index/query paths memory borrows,
`04-tool-routing.md` for how `search_memory` becomes a policy-gated tool, and
`/Users/rein/Public/buffr/src/session.ts` for the only live wiring today.

## Project exercises

### Wire `recall` into the RagQueryAgent before the loop
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** give `RagQueryAgent` an optional `memory`; on `answer`, call
  `recall(question, k)` and prepend the recalled exchanges to the system prompt, then
  `remember` the new exchange after — closing the loop aptkit built but never wired.
- **Why it earns its place:** memory is built but inert in aptkit; making an agent
  actually use it is the highest-leverage gap to close, and it's the difference
  between "I have a memory module" and "my agent remembers."
- **Files to touch:** `packages/agents/rag-query/src/rag-query-agent.ts`,
  reading `packages/memory/src/conversation-memory.ts`, the agent's `test/`.
- **Done when:** a two-turn test where turn 2 references turn 1 ("what about that?")
  answers correctly because the turn-1 exchange was recalled into the prompt.
- **Estimated effort:** `1–4hr`

### Push the `kind` filter into a metadata-aware search to kill the over-fetch
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend the `VectorStore` contract (or `PgVectorStore`) with an
  optional metadata predicate, and have `recall` pass `{ kind: 'memory' }` so it stops
  over-fetching `k*4` and filtering in JS.
- **Why it earns its place:** the over-fetch is a known workaround for a contract gap;
  fixing the contract instead of the symptom is exactly the design-vs-patch judgment
  interviewers probe.
- **Files to touch:** `packages/retrieval/src/` (the `VectorStore` type + a store impl),
  `packages/memory/src/conversation-memory.ts`, both packages' `test/`.
- **Done when:** `recall` requests exactly `k` and a test asserts no document rows are
  ever fetched for a shared store.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "How does your agent's long-term memory work, and what did it cost to add?"**
It cost no new infrastructure — it reuses the retrieval contracts. `remember` is the
RAG index path: format the exchange, embed it, upsert it tagged `kind: 'memory'`.
`recall` is the RAG query path: embed the new question, search, keep only memory rows.
Memory is RAG pointed at conversations. The store is injected, so the same engine runs
on Postgres in production or in-memory in tests. Two honest caveats: recall over-fetches
because the store contract has no metadata predicate, and it's wired in buffr's session
runtime, not yet inside an aptkit agent.

```
  remember = embed exchange → upsert (kind:memory)   |   recall = embed query → search → filter kind
  reuses EmbeddingProvider + VectorStore — zero new infra
```
Anchor: *long-term memory is RAG over conversations — index path + query path, reused.*

**Q: "Why does recall over-fetch and filter in JS instead of querying memory directly?"**
Because the `VectorStore.search` contract has no metadata predicate — it returns the
top-k nearest vectors and nothing else. In a store shared with documents, a plain top-k
could come back all documents and zero memory rows, so `recall` fetches `max(k*4, 20)`
and filters `kind === 'memory'` client-side to be sure it has enough memory hits. It's
a deliberate workaround for a contract limitation; the right fix is a metadata-aware
search that pushes the filter into the store.

```
  no metadata predicate → over-fetch k*4 → filter kind=='memory' in JS → slice(k)
```
Anchor: *the over-fetch is a contract gap workaround — push the filter into the store to remove it.*

## See also

- `03-retrieval-and-rag/11-rag.md` — the index/query paths memory reuses
- `04-tool-routing.md` — `search_memory` as a policy-gated tool
- `03-react-pattern.md` — short-term memory is the loop's messages array
- `01-agents-vs-chains.md` — the loop memory would plug into
- `/Users/rein/Public/buffr/src/session.ts` — the only live memory wiring today
