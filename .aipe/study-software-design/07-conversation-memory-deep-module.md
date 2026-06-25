# 07 — Conversation memory: the deep-module shape, a third time (and a named workaround)

**Industry names:** Port / Adapter (hexagonal) · dependency injection ·
episodic / long-term memory over a vector store · "deep module" (APOSD).
**Type:** Language-agnostic design pattern.

---

## Zoom out, then zoom in

AptKit grew a memory package — `@aptkit/memory`. The interesting part for *this*
guide is not that it does memory; it's that it reached for the *same* design move
`ModelProvider` (`01`) and the retrieval contracts (`06`) already use, and applied
it a third time. `createConversationMemory` is a small surface
(`{ remember, recall }`) over a large hidden body, and it depends on nothing but
the two contracts retrieval already defined — `EmbeddingProvider` and
`VectorStore`. No new abstraction style invented; the house style reused.

```
  Zoom out — where conversation memory sits

  ┌─ Capabilities / tools ─────────────────────────────────────────┐
  │  search_memory tool  →  registered into ToolRegistry            │
  │  (mirrors search_knowledge_base's { definition, handler })      │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ calls recall()
  ┌─ Memory (@aptkit/memory) ─────▼─────────────────────────────────┐
  │  createConversationMemory → remember() / recall()              │
  │      depends ONLY on the SAME two contracts as @aptkit/retrieval│
  │  ★ EmbeddingProvider ★          ★ VectorStore ★  ◄── injected   │
  └──────────┬──────────────────────────────────┬───────────────────┘
             │ embed(texts)                      │ upsert / search(vec, k)
  ┌─ Adapters ▼──────────────────┐   ┌───────────▼───────────────────┐
  │ OllamaEmbeddingProvider      │   │ InMemoryVectorStore (tests)    │
  │ (nomic, 768-dim, over HTTP)  │   │ PgVectorStore (durable, buffr) │
  └──────────────────────────────┘   │ — identical logic either way   │
                                     └────────────────────────────────┘
```

**Zoom in.** Same pattern as `01` and `06`: **maximise behaviour behind the
interface, minimise the interface itself.** `ConversationMemory` is two methods —
`remember(turn)` and `recall(query, k)`. Behind them sits embedding, id
namespacing, per-conversation counters, an upsert tagged as memory, and an
over-fetch-then-filter recall. The question it answers: *how does an agent
remember past exchanges and pull back the relevant ones — without the engine ever
naming a database?* The answer is the same as the other two: the store is
injected, so nothing inside the module names `PgVectorStore` or
`InMemoryVectorStore`.

The one genuinely new thing this file has to teach — the part worth your
attention — is what happens when the deep module hits a capability the contract
it depends on *doesn't have*. `VectorStore.search` has no metadata filter. Memory
needs one (it must return memory rows, not document rows, even when the two share
a store). Watch how the module handles that gap: a deliberate, *commented*
over-fetch-then-filter workaround. That tension — deepen the contract vs. work
around it in the consumer — is the design decision this file exists to walk.

---

## Structure pass — layers · axis · seams

**Layers:** tool (`search_memory`) → memory engine (`remember`/`recall`) → the two
contracts (`EmbeddingProvider`, `VectorStore`) → adapters (Ollama HTTP, in-memory
cosine / pgvector) → network / process memory / Postgres.

**Axis — trace "what does this layer know about where memory is stored?"**

```
  one question down the stack: "does this layer name a database?"

  ┌──────────────────────────────────────┐
  │ search_memory handler                 │  → NO. calls memory.recall().
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ createConversationMemory          │  → NO. calls contract methods only;
      │ remember / recall                 │    comment: "the engine never names
      └──────────────────────────────────┘    a database."
          ┌──────────────────────────────┐
          │ EmbeddingProvider / VectorStore│ → NO. dimension is a number;
          │ (the injected contracts)      │    upsert/search are opaque.
          └──────────────────────────────┘
              ┌──────────────────────────┐
              │ InMemoryVectorStore (test)│  → YES. one is a Map + cosine;
              │ PgVectorStore   (durable) │    the other is Postgres + pgvector.
              └──────────────────────────┘

  the answer flips at the adapter line — the SAME seam shape as 01 and 06
```

**The load-bearing seam, and the gap in it.** The memory engine sits behind one
swap point: the store. But unlike the document pipeline, memory needs a capability
the `VectorStore` contract never promised — a *metadata predicate* (`kind ===
'memory'`). The contract gives you `search(vector, k)` and nothing else. So the
seam has a hole, and `recall` has to fill it from the consumer side. That hole —
and the decision *not* to widen the contract to close it — is the one new design
finding `@aptkit/memory` adds on top of `06`.

---

## How it works

You already know the deep-module shape from `01` and `06`: one narrow interface, a
large hidden body, the vendor (or here, the database) trapped below the seam. Two
of memory's three moving parts are exactly that shape reused. The third — `recall`'s
client-side filter — is the new lesson: what a deep module does when its dependency
is missing a feature it needs.

### Move 1 — the shape: inject the store, tag the rows, over-fetch the recall

```
  conversation memory — the kernel

  remember(turn):
     text   = format(turn)                  ← render exchange to embeddable text
     vector = embed([text])[0]
     upsert([{ id: "memory:<convId>:<n>",   ← id NAMESPACED by kind
               vector,
               meta: { kind:"memory", conversationId, text } }])  ← TAG the row

  recall(query, k):
     qVec  = embed([query])[0]
     fetchK = max(k*4, 20)                   ← OVER-FETCH (no metadata filter exists)
     hits  = store.search(qVec, fetchK)
     return hits
       .filter(h => h.meta.kind === "memory") ← FILTER client-side to memory rows
       .slice(0, k)
```

Three load-bearing decisions sit in that kernel: **tag the row** (so memory is
distinguishable from documents), **over-fetch** (because search returns the
top-`fetchK` by similarity, and in a *shared* store documents can outrank memory),
and **filter client-side** (because the contract has no predicate). Drop the tag
and recall can't tell memory from documents. Drop the over-fetch and a shared
store returns `k` rows that might all be documents, leaving zero memories. Drop the
filter and recall returns document chunks as if they were past exchanges.

### Move 2 — the parts

**`remember` — the deep-module half.** Embed, namespace an id, tag the meta,
upsert. The id is `${kind}:${conversationId}:${n}` where `n` comes from a
per-conversation counter (`counters: Map<string, number>`). The break point: the
counter lives in memory, not the store, so two `ConversationMemory` instances over
the *same* store and *same* conversationId would both start `n` at 0 and collide
their ids. The code names this assumption in a comment — "conversationId is assumed
unique per conversation, so ids never collide across conversations" — which is
honest, but the within-conversation collision across instances is a real boundary
condition a reader should know.

**The dimension guard — the shared-fact check, reused from `06`.** Construction
throws if `embedder.dimension !== store.dimension`. This is the *exact* invariant
`assertWiring` enforces in retrieval (`06`), here inlined into the constructor.
Same fact, same fail-loud-at-wiring-time decision — a third instance of "promote
the shared number to a checked invariant."

**`recall`'s over-fetch-then-filter — the named workaround.** Here's the part to
study. `recall` wants memory rows only. The `VectorStore` contract has *no*
metadata filter — `search(vector, k)` ranks by cosine similarity and returns the
top `k`, full stop. So the engine can't ask the store "give me the top `k` rows
*where kind = memory*." It does the next best thing:

```
  the gap, and the workaround

  what recall WANTS:   store.search(qVec, k, where kind="memory")   ← doesn't exist
  what the contract HAS: store.search(qVec, k)                      ← no predicate

  the workaround:
     fetchK = max(k*4, 20)              ← pull a wider net…
     hits   = store.search(qVec, fetchK)
     hits.filter(kind=="memory").slice(0, k)   ← …then keep only memory, trim to k

  WHY k*4 (min 20): in a SHARED store, documents can rank above memory rows.
  Over-fetching makes it likely enough memory rows survive the filter to fill k.
  It is NOT a guarantee — if >fetchK documents outrank every memory row, recall
  still under-returns. The comment names this; the number is a heuristic, not a proof.
```

The crucial detail is that this is *commented*, not hidden:
`conversation-memory.ts:92-93` says "Over-fetch then filter: a shared store may
return documents above memory, and search itself cannot filter by metadata." The
limitation is named at the exact line a maintainer would hit it. That's the APOSD
move — when you can't define a problem out, at least make the workaround *obvious*
rather than a silent surprise.

**Should the fix be to deepen the contract instead?** This is the live design
question, and it's worth being opinionated. Two options:

```
  option A — keep the workaround        option B — deepen the contract
  ────────────────────────────          ──────────────────────────────
  recall over-fetches + filters         add search(vec, k, filter?) to
  in the consumer.                       VectorStore.

  + zero change to a load-bearing       + recall becomes one exact query;
    contract (VectorStore is also         no over-fetch heuristic, no
    implemented by buffr's                under-return failure mode.
    PgVectorStore — widening it          - every VectorStore impl must now
    ripples there).                        support filtering: InMemory (easy),
  + InMemoryVectorStore stays trivial.     PgVectorStore (a real WHERE clause),
  - the heuristic can under-return         and any future adapter. The contract
    on a hostile shared corpus.            got SHALLOWER-to-implement, wider.
  - every consumer that wants a filter   - pgvector CAN do this efficiently
    re-derives the over-fetch trick.       (a metadata WHERE + ANN index),
                                           so the capability is real, not faked.
```

The honest verdict: **for a single consumer, the workaround is the right call** —
widening a contract that buffr's `PgVectorStore` also implements is a ripple you
don't pay for one caller. But the moment a *second* consumer wants a metadata
predicate (and a multi-tenant `app_id` filter is the obvious next one), the
workaround stops being a local hack and becomes duplicated knowledge — the same
over-fetch trick re-derived in two places, which is exactly the
information-leakage smell audit Lens 3 hunts. At that point deepen the contract.
The design isn't wrong today; it has a named expiry condition.

**The default `format` is a pulled-down decision.** `recall`/`remember` both route
through `format(turn)` (default: a "Past exchange — user asked…/assistant
answered…" template), overridable via options. That's complexity pulled *down* —
the module owns a sane default so no caller has to, and the same renderer is used
for both the stored text and the recalled text, so they can't drift. Same instinct
as `runAgentLoop`'s defaults (audit Lens 5).

### Move 2.5 — current state vs future state

Memory is built but the durable half lives elsewhere, so it's worth drawing the
seam between what's in *this* repo and what's gated behind buffr.

```
  Phase A (this repo, now)          Phase B (with buffr's PgVectorStore)
  ─────────────────────────         ───────────────────────────────────
  store = InMemoryVectorStore       store = PgVectorStore
  memory lost on process exit       memory survives restarts
  per-conversation counter in RAM   (same counter caveat — see Move 2)
  recall over-fetches + filters     recall STILL over-fetches + filters
                                    (the contract didn't change, so neither
                                     did the engine — that's the payoff)

  what has to change to go A → B: ONE line at the app edge —
  the store passed into createConversationMemory({ embedder, store }).
  zero lines inside @aptkit/memory.
```

The takeaway is the same as `06`'s pgvector swap: because the store is injected
behind a contract the engine never names, moving from a throwaway in-memory store
to durable Postgres is a wiring change at the edge, not a code change in the
engine. The over-fetch workaround rides along unchanged — which is *also* the
argument for not deepening the contract until you must.

### Move 3 — the principle

**A deep module reused a third time is a house style; a workaround that's
commented at the line it bites is honesty about a contract's edge.** Memory adds
nothing to AptKit's abstraction vocabulary — it's `ModelProvider`'s move (`01`)
seen for the third time, over the *same* contracts `06` defined. What it *does*
add is a worked example of the moment a deep module's dependency falls short: the
`VectorStore` contract has no metadata predicate, memory needs one, and rather
than silently widening a load-bearing contract or hiding a fragile hack, the
engine over-fetches, filters, and *names the limitation in a comment*. The general
lesson: when your contract can't express what you need, the first move is a
visible, commented workaround in the consumer — and the trigger to deepen the
contract is the *second* consumer that needs the same thing, not the first.

---

## Primary diagram

```
  Conversation memory — the full picture

  ┌─ Tool layer ───────────────────────────────────────────────────┐
  │  search_memory  (mirrors search_knowledge_base exactly:          │
  │                  { definition, handler }, top_k → recall(q, k))  │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ memory.recall(query, k)
  ┌─ Memory engine (db-agnostic) ─▼─────────────────────────────────┐
  │  remember: turn → format → embed → upsert{ kind:"memory", … }   │
  │  recall:   q → embed → search(fetchK=max(k*4,20))               │
  │                       → FILTER kind=="memory" → slice(k)        │
  │  ctor: embedder.dimension === store.dimension  (fail loud)      │
  └──────────┬───────────────────────────────────┬──────────────────┘
             │ embed(texts)                       │ upsert / search(vec, k)
   ┌─ EmbeddingProvider ─┐               ┌─ VectorStore (INJECTED) ───┐
   │ OllamaEmbedding     │               │ InMemoryVectorStore (test) │
   │ nomic · 768 · HTTP  │               │ PgVectorStore (buffr)      │
   └─────────┬───────────┘               │ — NO metadata filter; the  │
             │ POST /api/embed           │   over-fetch works around it│
             ▼                           └────────────┬───────────────┘
        Ollama (localhost:11434)               process mem / Postgres
```

---

## Implementation in codebase

**Use cases in this repo.** A host app wires
`createConversationMemory({ embedder, store })` and calls `remember` after each
agent answer to persist the exchange, then either (a) lets the *existing*
`search_knowledge_base` tool surface memory automatically when memory shares the
document store, or (b) registers a dedicated `createMemoryTool(memory)` →
`search_memory` when memory lives in its own store and the agent should recall it
explicitly. Both paths are documented in the module comments. For tests, the same
code runs over `InMemoryVectorStore`; for durability, over buffr's `PgVectorStore`
— identical engine logic, the store is the only thing that changes.

**The two-method contract — `packages/memory/src/conversation-memory.ts:34-39`:**

```
  export type ConversationMemory = {
    remember(turn: MemoryTurn): Promise<void>;   ← embed + store one exchange
    recall(query: string, k?: number): Promise<MemoryHit[]>;  ← similarity recall
  };                                             └─ two members; the whole body hidden
```

Two methods, like `ModelProvider`'s one and the retrieval contracts' three. The
interface is about as small as episodic memory gets.

**The injected store — `conversation-memory.ts:18-31, 60-61`:**

```
  export type ConversationMemoryOptions = {
    embedder: EmbeddingProvider;
    store: VectorStore;            ← INJECTED. comment: "the engine never names
    format?: (turn) => string;       a database. Pass a PgVectorStore for durable
    kind?: string;                   memory, an InMemoryVectorStore for tests —
  };                                 the logic is identical."
  ...
  const { embedder, store } = opts;  ← the only two things the engine touches
```

The `store` field is the whole information-hiding move: nothing in the engine body
names Postgres or a Map. Swapping durable for in-memory is a caller decision.

**The dimension guard — `conversation-memory.ts:62-66`:**

```
  if (embedder.dimension !== store.dimension) {     ← same invariant as 06's
    throw new Error(                                   assertWiring, inlined here
      `embedder dimension ${embedder.dimension} != `
      + `store dimension ${store.dimension}`);
  }                                                  └─ fail loud at construction
```

The third appearance of the shared-`dimension` check (`01` has none; `06`'s
`assertWiring`; here at construction). A house pattern: when two injected things
must agree on a number, check it the instant you wire them.

**The over-fetch-then-filter workaround — `conversation-memory.ts:89-105`:**

```
  async recall(query, k = 5): Promise<MemoryHit[]> {
    const [vector] = await embedder.embed([query]);
    if (!vector) return [];
    // Over-fetch then filter: a shared store may return documents above memory,
    // and search itself cannot filter by metadata.        ← the NAMED limitation
    const fetchK = Math.max(k * 4, 20);                    ← pull a wider net
    const hits = await store.search(vector, fetchK);
    return hits
      .filter((h) => h.meta?.kind === kind)                ← keep only memory rows
      .slice(0, k)                                         ← trim back to k
      .map((h) => ({ id: h.id, score: h.score, text: ..., conversationId: ... }));
  }
        │
        └─ the comment at lines 92-93 is the design artifact: it names WHY the
           over-fetch exists (no metadata predicate in VectorStore) at the exact
           line a maintainer would question it. Without the tag on remember's
           upsert (meta.kind), this filter has nothing to match on.
```

This is the same over-fetch trick `search_knowledge_base` already uses for its
filter (`search-knowledge-base-tool.ts:85`, `fetchK = filter ? topK * 4 : topK`) —
which is itself a small consistency finding: the repo has now derived the
"over-fetch because `VectorStore` can't filter" pattern in *two* places, the
clearest signal yet that the contract is one capability short.

**`search_memory` mirrors `search_knowledge_base` — `memory-tool.ts:28-60`:**

```
  export function createMemoryTool(memory, options = {}):
    { definition: ToolDefinition; handler: ToolHandler } {   ← SAME return shape
    const definition: ToolDefinition = {
      name: 'search_memory',
      description: 'Search past conversation exchanges …',
      inputSchema: { /* query (required), top_k */ },        ← same {query, top_k}
    };
    const handler: ToolHandler = async (args) => {
      const topK = typeof args.top_k === 'number' ? args.top_k : defaultTopK;
      const hits = await memory.recall(String(args.query ?? ''), topK);
      return { query, memories: hits.map(h => ({ id, score, text })) };
    };
    return { definition, handler };                          ← register + filterToolsForPolicy
  }
```

Byte-for-byte the same *shape* as `createSearchKnowledgeBaseTool` (`06`): a
`{ definition, handler }` pair, a `{query, top_k}` input schema, register into
`InMemoryToolRegistry`, select with `filterToolsForPolicy`. That consistency is the
finding — a second tool that surfaces vector search to an agent looks identical to
the first, so a reader who learned one knows the other for free.

---

## Elaborate

This is the **Port/Adapter** (hexagonal) pattern a third time, and the
**dependency-injection** instinct stated plainly in a comment ("the engine never
names a database"). The reusable lesson over `06` is narrow but real: `06` showed
the deep-module move *composed twice* with a shared-fact invariant; `07` shows the
same move with a *missing-capability workaround* — what a deep module does when the
contract it leans on can't express something it needs.

The interesting tension is between two APOSD chapters pulling opposite ways. The
information-hiding chapter says *don't leak knowledge across modules* — and the
over-fetch trick now lives in two consumers (`recall` and the search tool), which
is leakage by duplication. The deep-modules chapter says *don't widen a narrow
interface* — and adding a filter to `VectorStore` makes it wider and harder for
every implementer (including buffr's `PgVectorStore`). The repo currently resolves
this in favor of the narrow contract plus a commented workaround, which is correct
for one-and-a-half consumers. The expiry condition is explicit: a second
*independent* need for a metadata predicate (multi-tenant `app_id` filtering is the
obvious one) tips the balance toward deepening the contract.

Adjacent reading: the chunker (`06`'s Elaborate) is the same "small deep module
with a documented why" instinct; `format` here is the chunker's analogue — a
pulled-down default the caller rarely overrides.

---

## Interview defense

**Q: "You have `ModelProvider` and the retrieval contracts as deep modules
already. Why is conversation memory a separate pattern and not just 'more of the
same'?"**

Mostly it *is* the same — that's the point, and I'd say so: it's the third
deliberate reuse of the narrow-contract-over-large-body move, over the exact same
`EmbeddingProvider`/`VectorStore` contracts retrieval defined, with the store
injected so the engine never names a database. What earns it a separate file is the
*one new thing*: what the deep module does when its dependency is missing a feature.
`VectorStore.search` has no metadata filter, but `recall` needs memory rows only —
so it over-fetches `max(k*4, 20)`, filters client-side on `meta.kind`, and
*comments the limitation at the line it bites*. That's a real design decision —
work around it in the consumer vs. deepen the contract — not just boilerplate.

```
  the gap a deep module hit, and how it answered

  needs:    search(vec, k, where kind="memory")   ← contract can't express this
  has:      search(vec, k)
  answer:   over-fetch k*4 (min 20) → filter kind → slice k  (commented)
  expiry:   2nd consumer needing a predicate → deepen the contract instead
```

**Anchor:** "Same deep-module move a third time; the new lesson is the
over-fetch-then-filter workaround for a `VectorStore` that has no metadata
predicate — commented at the line it bites, with a named expiry condition."

**Q: "Wouldn't the over-fetch under-return memories on a big shared corpus? Why
not just add a filter to `VectorStore`?"**

Yes — it can under-return, and the code's comment is honest that `k*4` is a
heuristic, not a guarantee: if more than `fetchK` documents outrank every memory
row, recall comes back short. The reason I'd still keep it *today*: `VectorStore`
is a load-bearing contract that buffr's `PgVectorStore` also implements, so
widening it to take a filter ripples into a second repo and makes every
implementer (including the trivial in-memory one) carry a predicate. For a single
consumer that's a bad trade. The honest trigger to flip the decision is a *second*
consumer that needs a metadata predicate — a multi-tenant `app_id` filter is the
obvious one — because then the over-fetch trick is duplicated knowledge, and
duplicated knowledge across modules is exactly the leak you deepen the contract to
remove. pgvector can do a metadata `WHERE` + ANN index efficiently, so the
capability would be real, not faked.

---

## Validate

1. **Reconstruct:** write the `ConversationMemory` type and the `recall` kernel
   from memory. Two methods; over-fetch `max(k*4, 20)`; filter `meta.kind`. Check
   against `packages/memory/src/conversation-memory.ts:34, 89`.
2. **Explain:** why does `recall` over-fetch instead of calling `search(vec, k)`
   directly? What capability is the `VectorStore` contract missing, and where is
   that named? (`conversation-memory.ts:92-94`.)
3. **Apply:** you swap `InMemoryVectorStore` for buffr's `PgVectorStore`. Which
   files in `@aptkit/memory` change? (Answer: none — the store is
   constructor-injected; only the wiring at the app edge changes. The over-fetch
   workaround rides along unchanged.)
4. **Defend:** a teammate wants to add a metadata filter to `VectorStore` so
   `recall` can query memory rows directly. Argue both sides, then pick — for one
   consumer keep the commented workaround (don't ripple a contract buffr also
   implements); the moment a *second* consumer needs a predicate, deepen the
   contract.

---

## See also

- `01-model-provider-deep-module.md` — the original deep-module move this file
  reuses a third time; read it first.
- `06-retrieval-contracts-as-deep-seams.md` — the `EmbeddingProvider`/`VectorStore`
  contracts memory injects, and the `search_knowledge_base` tool `search_memory`
  mirrors; the over-fetch-then-filter trick first appears there too.
- `04-capability-agent-template.md` — `search_memory`'s `{ definition, handler }`
  shape is the tool seam agents select with `filterToolsForPolicy`.
- `05-bundle-as-public-surface.md` — `@aptkit/memory` is now re-exported by
  `@rlynjb/aptkit-core`, pushing the bundle to 16 packages.
- `audit.md` Lens 2 (deep modules), Lens 3 (information leakage — the over-fetch
  trick now duplicated in two consumers), Lens 5 (pull complexity downward — the
  `format` default).
- APOSD ch. 4 (deep modules), ch. 5 (information hiding — the shared `dimension`
  fact and the workaround-vs-deepen tension), ch. 8 (pull complexity downward).
