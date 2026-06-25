# 02 — Agent Memory Tiers

*Agent memory / memory tiers / "what the agent remembers" — Pattern + honest
in-codebase (the three-tier model is universal; AptKit ships the working tier in
its runtime AND an episodic-memory ENGINE in `@aptkit/memory` — but no agent in
this repo wires that engine into a loop yet).*

## Zoom out, then zoom in

"Memory" in agents is an overloaded word, and the fastest way to think clearly
about it is to separate it by *lifetime* — how long a piece of information
survives. Three tiers fall out, and most production confusion comes from
conflating them.

The verdict up front, because it changed: AptKit used to be a clean
working-tier-only case. It no longer is. The new `@aptkit/memory` package
(`packages/memory/src/conversation-memory.ts`) is a real **episodic memory
engine** — `remember(turn)` / `recall(query, k)` over the same
`EmbeddingProvider` + `VectorStore` contracts `@aptkit/retrieval` uses. So the
honest statement is now precise: AptKit *runs* the working tier (every
`runAgentLoop` call), and *ships* the episodic tier as an engine + a
`search_memory` tool — but no capability in this repo constructs a
`ConversationMemory` and calls `remember`/`recall` inside its loop. The durable
store (`PgVectorStore`) and the agent runtime that actually exercises memory (an
Ink TUI `chat` CLI) live in the **buffr** repo. AptKit ships the engine; buffr
runs it.

```
  Memory tiers by lifetime (longest-lived at the bottom)

  ┌─ WORKING memory ── lives for ONE run ──────────────────────────────┐
  │  the messages[] array: user + assistant + tool_result blocks        │
  │  born when runAgentLoop starts, GONE when it returns                 │
  │  ★ AptKit RUNS this tier in every agent loop ★                       │
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │  survives past one run via remember()...
  ┌─ EPISODIC memory ── lives across runs/sessions ────────────────────┐
  │  "what was discussed before": past Q/A exchanges, embedded + recalled│
  │  ★ ENGINE SHIPPED (@aptkit/memory) — remember/recall + search_memory ★│
  │  but NO agent in THIS repo wires it; the chat CLI that does is in buffr│
  └───────────────────────────────┬─────────────────────────────────────┘
                                  │  ...and would survive indefinitely
  ┌─ LONG-TERM memory ── lives indefinitely, semantic ─────────────────┐
  │  durable facts/embeddings, retrieved by similarity, unbounded       │
  │  the DURABLE store (PgVectorStore) lives in buffr; AptKit's stores   │
  │  are in-memory (die with the process)                               │
  └─────────────────────────────────────────────────────────────────────┘
```

The frontend anchor: working memory is `useState` inside a mounted component —
it lives while the component is mounted and vanishes on unmount. Episodic memory
is `localStorage` — it survives the page reload. Long-term memory is the backend
database your app queries by key or similarity. AptKit now has `useState` *and*
a `localStorage`-shaped engine — but in this repo nobody's called `setItem` from
inside an agent yet; the host (buffr) does that.

## Structure pass

Trace the **persistence axis** — *where does the data physically live, and what
event destroys it.* This is the seam between "in the function" and "outside it" —
and the new seam this run adds is the one between "engine shipped" and "engine
wired into a loop."

```
  The persistence axis: where memory lives and what kills it

  Tier        Lives in                  Destroyed by            In this repo?
  ──────────  ────────────────────────  ──────────────────────  ─────────────
  working     messages[] (JS array,      runAgentLoop returns    RUN (line 94)
              in-function, in-RAM)        (GC'd)
  ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ◄ SEAM 1
  episodic    a VectorStore via          store eviction /        ENGINE SHIPPED
              @aptkit/memory             process exit (in-mem)   but UNWIRED here
  ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ◄ SEAM 2
  long-term   a DURABLE vector DB        never (until evicted)   in BUFFR
              (PgVectorStore)            (PgVectorStore is buffr's)
```

There are now two seams, not one. **Seam 1** is still the `return` statement of
`runAgentLoop`: above it, `messages[]` holds the run's working memory; below it
the array is GC'd. Nothing in `runAgentLoop` writes through to a store — so
working memory's lifetime is one function call, unchanged.

**Seam 2 is the new one, and it's the load-bearing distinction this run adds:**
the boundary between an episodic-memory *engine that exists* and an agent loop
that *calls it*. `createConversationMemory` is a deep module
(`conversation-memory.ts:60`) — it embeds, upserts tagged rows, over-fetches and
filters on recall. It's tested (`packages/memory/test/*`). But grep the six
agents in `packages/agents/*` and not one constructs it or calls
`remember`/`recall`. The capability that *does* — an Ink TUI `chat` CLI — lives
in buffr. So the persistence axis flips twice: working memory dies on return,
episodic memory *could* persist but no loop here feeds it, and durable long-term
persistence is buffr's `PgVectorStore`. AptKit owns the engine and the contract;
it does not own a running memory.

## How it works

### Move 1 — the mental model

Each tier is a different scope of *recall*. Working memory recalls "this run."
Episodic recalls "past exchanges." Long-term recalls "everything I was ever
told." You add a tier only when the agent demonstrably needs to recall beyond the
scope it has — and each tier you add is a store you now own, write to, evict
from, and secure.

The key reframe for AptKit's episodic engine: episodic memory here is
**retrieval-backed**. `recall` is not "read the last N rows of a runs table" —
it's *embed the query and ANN-search past exchanges by similarity*. Episodic
memory is RAG whose corpus is your own past conversations, not a document set.
That's why it's built on the exact same `EmbeddingProvider` + `VectorStore`
contracts as document retrieval — and why a recalled memory looks identical to a
retrieved chunk to the agent.

```
  Memory tiers as widening recall scopes (PATTERN)

  query about THIS run        ──▶ WORKING   (just read messages[])
  "what did we discuss before?"──▶ EPISODIC (embed query → ANN over past Q/A)
  "what do we know about X?"   ──▶ LONG-TERM (durable vector DB, buffr)

  scope widens ───────────────────────────────────────────▶
  cost & ownership widen with it (each tier = a store you maintain)
```

The discipline still holds: don't add episodic/long-term because it sounds
smart. AptKit's engine is the right shape *and* unwired in this repo precisely
because the six analytics agents are stateless single-shot capabilities — they
have no concrete cross-run-recall failure. The capability that *needs* episodic
recall is a multi-turn conversational assistant, which is why the engine gets
exercised in buffr's chat CLI, not here.

### Move 2 — the tiers, one at a time

**Tier 1 — WORKING memory (the only one AptKit has)**

```
  messages[] IS working memory; it accumulates then dies

  runAgentLoop starts
       │
  messages = [ userPrompt ]                    ← born (line 94)
       │  each turn: push assistant, push tool_result
  messages = [ user, asst, tool_result, asst, tool_result, ... ]
       │
  runAgentLoop returns ──▶ messages GC'd       ← dies; nothing persisted
```

Pseudocode: `messages = [userPrompt]; loop pushes turns; return; // array gone`.
The model "remembers" everything within a run because the whole array is re-sent
each turn. It remembers *nothing* across runs because the array doesn't outlive
the call.

**Tier 2 — EPISODIC memory (the engine `@aptkit/memory` ships)**

This is the tier that changed. There are two operations, and the second one
carries the subtlety.

```
  remember: embed a formatted exchange and upsert it tagged as memory

  turn { conversationId, question, answer }
       │  format → "Past exchange — user asked: ... assistant answered: ..."
       ▼
  embed(text) ──▶ vector
       │
  upsert { id: "memory:<convId>:<n>", vector,
           meta: { kind:'memory', conversationId, text } }
       ▲
   the meta.kind tag is load-bearing — it's how recall tells a
   memory row apart from a document row in a SHARED store
```

```
  recall: over-fetch, filter by kind, slice — because VectorStore
          has NO metadata filter

  query ──▶ embed ──▶ search(vector, fetchK = max(k*4, 20))
       │                          │  may return documents ABOVE memory
       │                          ▼  in a shared store
       │              filter( meta.kind === 'memory' )   ← client-side
       │                          │
       └──────────────────────────▼  slice(0, k) ──▶ MemoryHit[]
```

The load-bearing mechanic is the **over-fetch-then-filter** on recall. The
`VectorStore` contract has no metadata filter (that's a deliberate
narrow-contract choice in `@aptkit/retrieval`), so when memory *shares* a store
with documents, a plain `search(vector, k)` could come back entirely documents
and zero memory rows. The fix: ask for `max(k*4, 20)` results, drop everything
whose `meta.kind` isn't `'memory'`, then take the top `k`. The `4x` over-fetch
is the budget that buys back the filter the contract doesn't provide. Get the
over-fetch wrong (ask for exactly `k`) and recall silently returns too few — or
zero — memories on a busy shared store.

The second decision the engine pushes to the caller: **shared store vs dedicated
store.** The `store` is injected, and the module "does not care which"
(`conversation-memory.ts:18-26`):

```
  SHARED store          memory rows + document rows in ONE VectorStore
                        memory surfaces via the EXISTING search_knowledge_base
                        tool (no separate tool); recall's kind-filter is what
                        keeps document hits out of a memory-only recall

  DEDICATED store       memory isolated in its OWN VectorStore
                        recalled via the NEW search_memory tool
                        (createMemoryTool) — the agent decides when to recall
```

**Tier 3 — LONG-TERM / durable memory (the durable store lives in buffr)**

```
  long-term = the SAME engine, pointed at a DURABLE store

  remember(turn) ──▶ embed ──▶ PgVectorStore.upsert   ← survives process exit
  recall(query)  ──▶ embed ──▶ PgVectorStore.search
       ▲
   AptKit's stores are IN-MEMORY (InMemoryVectorStore) — they die with the
   process. The durable PgVectorStore that makes memory long-term is buffr's.
```

Here's the clean part of the design: long-term is not a different engine. It's
the *same* `createConversationMemory`, with a durable `VectorStore` injected
instead of an in-memory one. The docstring says it outright — "pass a
`PgVectorStore` for durable memory, an `InMemoryVectorStore` for tests — the
logic is identical" (`conversation-memory.ts:55-57`). So AptKit's episodic engine
*is* the long-term engine; what makes it short-lived here is purely the in-memory
store binding. The five analytics agents' "retrieval" is still tool-calling over
analytics APIs plus the deterministic schema summary — no memory at all. The
`rag-query` vector store is still a read-only knowledge base, not memory: no run
writes a learned fact back. The new thing is that the *machinery to write
exchanges back* now exists as a package — it just isn't wired into a loop in this
repo.

### Move 3 — the principle

Memory is recall scoped by lifetime, and the load-bearing engineering distinction
is between a memory *engine* and a wired memory *loop*. AptKit now ships the
engine — episodic recall as RAG over past exchanges, durable when you inject a
durable store — but the engine sitting in a package doesn't make the agents
stateful; only a loop that calls `remember`/`recall` does, and that loop lives in
buffr. The discipline still holds: episodic/long-term is a store you own, evict,
and secure, added on a concrete recall failure — which is why AptKit's *stateless*
analytics agents correctly don't wire it.

## Primary diagram

AptKit's actual memory architecture — the working tier it runs, the episodic
engine it ships-but-doesn't-wire, drawn against the host that runs it.

```
  AptKit memory: working tier RUN here · episodic ENGINE shipped · loop in buffr

  ┌─ aptkit: every agent run ──────────────────────────────────────────────┐
  │  ┌─ run #1 ───────┐  ┌─ run #2 ───────┐  ┌─ run #3 ───────┐            │
  │  │ messages=[...] │  │ messages=[...] │  │ messages=[...] │  WORKING    │
  │  └───────┬────────┘  └────────────────┘  └────────────────┘  (run-local)│
  │          │ return ──▶ [ GC'd ]  ← no agent here calls remember()        │
  └──────────┼─────────────────────────────────────────────────────────────┘
             │
  ┌─ aptkit: @aptkit/memory (SHIPPED ENGINE, no caller in this repo) ───────┐
  │  createConversationMemory({ embedder, store }) → remember / recall      │
  │  createMemoryTool(memory) → search_memory tool                          │
  └──────────┬──────────────────────────────────────────────────────────────┘
             │ injected store decides durability
  ┌─ buffr: the runtime that WIRES it ─────────────────────────────────────┐
  │  chat CLI loop: recall(q) → answer → remember({q, a})                   │
  │  store = PgVectorStore  ← durable: memory survives across sessions      │
  └─────────────────────────────────────────────────────────────────────────┘
```

In AptKit, run #2 still cannot know what run #1 found — the only memory the
*agents* use is `messages[]`, and it dies on return. The episodic engine exists
one layer over but no agent here feeds it. The wiring — recall before answering,
remember after — is buffr's, with a `PgVectorStore` that makes the memory durable.
That partition is *by design*: AptKit stays the deployment-agnostic engine; buffr
fills the store slot and runs the loop. It's also why the latent pipeline
(`../03-multi-agent-orchestration/03-sequential-pipeline.md`) passes data by
*return value*, not by a shared memory store.

## Implementation in codebase

**Use case — working memory is `messages[]`, full stop.**
`packages/runtime/src/run-agent-loop.ts:94`:

```ts
const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }]; // line 94
// ... each turn:
messages.push({ role: 'assistant', content: response.content });          // line 124
// ... after tool calls:
messages.push({ role: 'user', content: toolResults });                    // line 189
// ...
return { finalText, toolCalls, parsed };                                   // line 201 ← messages dies
```

Line 94 is the birth, lines 124/189 are the accumulation, line 201 is the death.
There is no `store.save(messages)` anywhere — search the runtime and you won't
find a persistence call. That absence *is* the architecture.

**The closest thing to episodic memory — and why it isn't AptKit's.**
`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:17-24`:

```ts
allowedTools: [
  'get_recent_judgments',        // ← reads PRIOR judgments...
  'get_user_pattern_history',    // ← reads PRIOR user patterns...
  'get_rubric_definition',
  'get_current_attempt_context',
  'save_judgment',               // ← even writes one back
  'generate_next_scenario',
] as const,
```

This *looks* like episodic memory: the agent can read recent judgments and even
`save_judgment`. But it's a **tool policy** (an allowlist of tool *names*), not a
memory store AptKit implements. The handlers behind those names are wired by the
host (`InMemoryToolRegistry` in tests, real services in production) — AptKit
defines the *interface* the agent reaches through, never the store. So the
honest classification: AptKit gives the rubric agent a *door* to host-provided
episodic data; it does not own the room behind it. Cross-link to
`03-tool-calling-and-mcp.md` for why a tool name is not a capability.

**The episodic engine — `recall`'s over-fetch-then-filter.**
`packages/memory/src/conversation-memory.ts:89-106`:

```ts
async recall(query: string, k = DEFAULT_RECALL_K): Promise<MemoryHit[]> {
  const [vector] = await embedder.embed([query]);            // ← embed the query
  if (!vector) return [];
  const fetchK = Math.max(k * 4, 20);                        // ← over-fetch (line 94)
  const hits = await store.search(vector, fetchK);           // ← ANN, no meta filter
  return hits
    .filter((h) => h.meta?.kind === kind)                    // ← keep memory rows only
    .slice(0, k)                                             // ← then trim to k
    .map((h) => ({ id: h.id, score: h.score, text: ..., conversationId: ... }));
}
       │
       └─ line 94's max(k*4, 20) is load-bearing: the VectorStore contract has
          no metadata filter, so a shared store can return all documents above
          memory. Ask for exactly k and recall returns too few; over-fetch then
          filter recovers the k memory rows the contract can't pre-filter.
```

**Memory as a tool — the same capability kernel, one more granted tool.**
`packages/memory/src/memory-tool.ts:28-60`. `createMemoryTool(memory)` returns
the identical `{ definition, handler }` pair shape as
`createSearchKnowledgeBaseTool` — so `search_memory` registers into an
`InMemoryToolRegistry` and is selected by `filterToolsForPolicy` exactly like any
other tool. This is the agent-control point: granting an agent memory is *not* a
new control-flow primitive. It's one more entry in a `ToolPolicy.allowedTools`
allowlist, surfaced through the same `runAgentLoop` kernel
(`capability = prompt + policy + loop + validator`) the six analytics agents use.
Compare the `rag-query` agent's grant
(`packages/agents/rag-query/src/rag-query-agent.ts:14-18`):

```ts
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],   // ← one tool granted
};
// ...later, line 64:
const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);
```

A memory-enabled conversational agent is this same wiring with
`SEARCH_MEMORY_TOOL_NAME` added to `allowedTools` — the agent then *decides when
to recall* (call `search_memory` mid-loop) exactly as `rag-query` decides when to
search documents. No planner, no new loop. The reasoning is: tool-as-memory means
the model controls recall (it recalls when it judges the answer depends on the
past); the alternative — auto-injection — recalls every turn regardless. AptKit
ships the tool-as-memory path; the shared-store path lets the *existing*
`search_knowledge_base` tool surface memory with no new tool at all.

**Not yet exercised in THIS repo: any agent that wires the memory engine.** Grep
`packages/agents/*` — no capability constructs `createConversationMemory` or
calls `remember`/`recall`. The six agents are stateless. The capability that
wires the engine (an Ink TUI `chat` CLI: recall → answer → remember) lives in
buffr, with a durable `PgVectorStore`. AptKit owns the engine and the
`search_memory` tool; buffr owns the loop and the durable store.

**Still a knowledge base, not memory: `rag-query`.** The `rag-query` vector store
is read-only — no run writes a learned fact back
(`../02-agentic-retrieval/04-agentic-rag-over-vector-search.md`). What changed is
that the *write-back machinery* (`remember`) now exists in a sibling package; it's
just not wired into `rag-query`.

## Elaborate

**Origin.** The working/episodic/long-term split is borrowed from cognitive
science and adopted by agent frameworks (LangChain memory, the MemGPT/letta line
of work). The useful engineering insight is that they differ by *lifetime and
retrieval method*, not by importance.

**Adjacent — why working-only is still right for the agents that ship here.**
Cross-run memory is a liability until it's an asset: it goes stale, it leaks data
across users/sessions (a privacy surface), and it makes runs non-reproducible. A
stateless agent is trivially reproducible — which is exactly what makes AptKit's
deterministic replay eval possible (`04-agent-evaluation.md`). Statelessness and
testability are the same property. The episodic engine doesn't break that, because
shipping `@aptkit/memory` as a package separate from any agent loop means the six
analytics capabilities stay stateless and replayable; the statefulness moves to
buffr's conversational loop, where reproducibility is traded for recall on
purpose. The separation of engine from caller is what keeps both properties
available.

**Adjacent — the message array as the only memory ties directly to context
engineering.** Working memory *is* the dynamic half of the context window
(`01-context-engineering.md`); growing `messages[]` is the same as growing the
window, which is why the budgets bound both at once.

## Interview defense

**Q: "What kind of memory does your agent have?"**

```
  RUN here:    working — messages[] (run-agent-loop.ts:94), dies on return
  SHIPPED:     episodic engine — @aptkit/memory remember/recall + search_memory
  WIRED here:  none — no agent in this repo calls remember/recall
  DURABLE:     buffr's PgVectorStore (the chat CLI wires the engine)
```

Anchor: "The six agents in this repo run the working tier only — the message
array, scoped to one run, GC'd on return. But the repo *ships* an episodic-memory
engine, `@aptkit/memory`: `remember`/`recall` as RAG over past exchanges, plus a
`search_memory` tool. It's just not wired into any agent here — the analytics
agents are deliberately stateless. The loop that uses it, with a durable
`PgVectorStore`, lives in the companion repo buffr. Engine here, running memory
there."

**Q: "But the rubric agent has `get_recent_judgments` — isn't that memory?"**

```
  tool NAME in a policy  ≠  a memory store AptKit owns
  rubric-improvement-agent.ts:17 = allowlist; handler is HOST-provided
```

Anchor: "That's a host-provided tool, not an AptKit memory store. AptKit defines
the door — the tool interface — but never owns the room behind it. It's the
closest thing to episodic memory and it's still not one."

**Q: "Memory's a tool here — why not just inject recalled memories every turn?"**

```
  tool-as-memory (what ships):   agent calls search_memory WHEN it judges
                                 the answer depends on the past
  auto-injection (alternative):  recall every turn, prepend to context,
                                 regardless of relevance
  shared-store (third path):     existing search_knowledge_base surfaces
                                 memory — no new tool at all
```

Anchor: "Memory as a tool means the *model* controls recall — it recalls when it
decides the answer depends on something discussed earlier, the same way
`rag-query` decides when to search documents. Auto-injection recalls every turn
and burns context on irrelevant history. The third option is the shared-store
path: put memory rows in the same `VectorStore` as documents and the existing
`search_knowledge_base` tool surfaces them — recall's `meta.kind` filter is what
keeps it honest. Granting memory is one entry in a tool policy allowlist through
the same `runAgentLoop` kernel — not a new control loop."

**Q: "When would you wire the engine into an agent?"**

```
  wire episodic recall ONLY when a capability needs cross-turn recall:
    stateless single-shot analytics ──▶ no memory (the 6 agents here)
    multi-turn conversational assistant ──▶ recall before answer (buffr's chat)
  durability = inject PgVectorStore instead of InMemoryVectorStore (same engine)
```

Anchor: "When the capability is conversational and the next answer depends on the
last — which the stateless analytics agents never are, so they correctly don't
wire it. The engine ships; the loop that needs it is buffr's chat CLI. Going
durable is a one-line swap: inject `PgVectorStore` for `InMemoryVectorStore`, same
`createConversationMemory`." This is the load-bearing judgment: memory is a
liability you add on evidence, and shipping the engine separately from the loop is
what lets the stateless agents stay stateless while the conversational host stays
durable.

## Validate

- **Reconstruct:** Draw the three tiers by lifetime and mark which AptKit has
  (working: yes, line 94; episodic: no; long-term: no).
- **Explain:** Why does run #2 know nothing about run #1?
  (`run-agent-loop.ts:201` — `messages[]` is the only memory and it's GC'd on
  return; no write-through store exists.)
- **Apply:** You want a conversational assistant to recall what the user said
  earlier this session. Which tier, which package, and how is recall controlled?
  (episodic — `@aptkit/memory`'s `createConversationMemory`; `recall(query, k)`
  embeds and ANN-searches past exchanges; the agent controls *when* via the
  `search_memory` tool granted in its `ToolPolicy.allowedTools`. The engine ships
  in this repo; the loop that wires it is buffr's chat CLI.)
- **Explain:** Why does `recall` over-fetch `max(k*4, 20)` then filter?
  (`conversation-memory.ts:94` — the `VectorStore` contract has no metadata
  filter; in a shared store, `search(vector, k)` could return all documents and
  zero memory rows, so over-fetch then drop non-`memory` rows recovers the k.)
- **Defend:** A teammate calls the rubric agent "stateful because it has
  `save_judgment`." Correct them. (`rubric-improvement-agent.ts:17-24` — that's a
  tool *name* in an allowlist; the store is host-provided, AptKit owns no memory.)

## See also

- [01-context-engineering.md](01-context-engineering.md) — working memory is the
  dynamic half of the context window
- [03-tool-calling-and-mcp.md](03-tool-calling-and-mcp.md) — why a tool name in a
  policy is not a capability AptKit owns; `search_memory` is granted the same way
- `../02-agentic-retrieval/04-agentic-rag-over-vector-search.md` — the
  `EmbeddingProvider` + `VectorStore` contracts episodic memory reuses; recall is
  RAG whose corpus is past exchanges, not documents
- [04-agent-evaluation.md](04-agent-evaluation.md) — statelessness is what makes
  deterministic replay possible
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — `messages[]` birth and
  death in the kernel
- `../03-multi-agent-orchestration/03-sequential-pipeline.md` — why agents pass
  data by return value, not shared memory
- `.aipe/study-ai-engineering/` — the agent-memory two-layer split, taught from
  first principles
