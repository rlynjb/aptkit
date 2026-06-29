# 02 — Retrieval as a tool (RAG behind two ports)

> **Subtitle:** Retrieval-augmented generation / Tool-mediated retrieval —
> *Industry standard.* Two ports (`EmbeddingProvider`, `VectorStore`) are the
> retrieval seam; the pipeline is the client; `search_knowledge_base` is the
> tool that exposes the query path to the agent. Port/adapter role-vocabulary
> is owned by `study-software-design` → PATTERN VOCABULARY.

## Zoom out — where this sits

RAG in aptkit isn't a fixed step the agent always runs. It's a *tool* the
model can choose to call. And the retrieval machinery behind that tool sits
behind two swappable ports, so the same pipeline runs over an in-memory array
in tests and over Supabase pgvector in production.

```
  Zoom out — retrieval in the stack

  ┌─ Capability layer (agents) ───────────────────────────────┐
  │  rag-query agent — model DECIDES when to search            │  the client
  └───────────────────────────┬────────────────────────────────┘
                              │ tool call: search_knowledge_base(query, top_k)
  ┌─ Tool boundary ───────────▼────────────────────────────────┐
  │  ★ search_knowledge_base ★  → pipeline.query()              │ ← we are here
  │  packages/retrieval/src/search-knowledge-base-tool.ts:43    │
  └───────────────────────────┬────────────────────────────────┘
            ┌──────────────────┼───────────────────┐
            ▼                                       ▼
  ┌─ EmbeddingProvider (port) ─┐        ┌─ VectorStore (port) ────────┐
  │  OllamaEmbeddingProvider   │        │  InMemoryVectorStore (aptkit)│
  │  nomic, 768-dim            │        │  PgVectorStore (buffr)       │
  └────────────────────────────┘        └──────────────────────────────┘
```

Two design choices stack here. First, retrieval is *agentic* — the model emits
a `tool_use` for `search_knowledge_base` when it wants context, instead of the
code prepending retrieved chunks unconditionally. Second, the retrieval
substrate is vendor-neutral: `nomic`/`pgvector`/in-memory are incidental.

## Structure pass — layers, axis, seam

Layers: the **client** (agent), the **tool** (`search_knowledge_base`), the
**pipeline** (index + query paths), the **ports** (embed + store). Trace one
axis — **who decides control flow** — across them:

```
  axis traced: "who decides whether retrieval happens?"

  ┌─ agent / loop ──────────────┐   the MODEL decides (emits tool_use or doesn't)
  └──────────────┬───────────────┘
       seam ═════╪═════  ← control flips: code stops deciding, model decides
  ┌─ tool ────────▼─────────────┐   CODE decides the floor (minTopK) + filter safety
  └──────────────┬───────────────┘
  ┌─ pipeline ────▼─────────────┐   CODE decides: embed → search → rank (fixed order)
  └──────────────┬───────────────┘
       seam ═════╪═════  ← vendor flips: nomic/pgvector are swappable here
  ┌─ ports ───────▼─────────────┐   the ADAPTER decides how (cosine scan vs HNSW)
  └─────────────────────────────┘
```

Two seams. The tool boundary is where *control* flips to the model (agentic).
The port boundary is where the *vendor* flips. Both are load-bearing: the
first is what makes it agentic RAG, the second is what makes it deployable
anywhere.

## How it works

### Move 1 — the mental model

You already know RAG as a shape: retrieve → augment → generate. The twist here
is *who pulls the trigger* on retrieve. Instead of the code always retrieving,
the model calls a tool when it decides it needs context — same way a function
in your code calls `fetch()` only down a branch where it actually needs data.

```
  the pattern — agentic retrieval loop

  question ─► model ─┬─ "I know this" ──────────────► answer
                     │
                     └─ tool_use: search_knowledge_base(q)
                            │
                            ▼
                     embed(q) ─► store.search(v,k) ─► ranked chunks + citations
                            │
                            ▼
                     model reads chunks ─► answer (or search again)
```

The model can loop: search, read, search again with a refined query, then
synthesize. That's the agentic part — covered as the loop in `03`.

### Move 2 — the two ports

**The ports themselves** (`packages/retrieval/src/contracts.ts:22-37`):

```ts
export type EmbeddingProvider = {
  id: string;
  dimension: number;                          // fixed per provider (768 = nomic)
  embed(texts: string[]): Promise<number[][]>;
};
export type VectorStore = {
  dimension: number;                          // carries its own dimension
  upsert(chunks: VectorChunk[]): Promise<void>;
  search(vector: number[], k: number): Promise<VectorHit[]>;
};
```

Two verbs on the store (`upsert`, `search`) and one on the embedder (`embed`).
Notice both carry `dimension` — that's a load-bearing invariant, below.

**The index path** (`packages/retrieval/src/pipeline.ts`, `indexDocument`):
doc → `chunkText()` → `embed(texts)` → `store.upsert(chunks)`. Each chunk gets
`id: "<docId>#<index>"` and `meta` carrying `docId`/`chunkIndex`/`text` so a
hit can be turned into a citation.

**The query path** (`pipeline.ts`, `queryKnowledgeBase`): `embed([query])` →
`store.search(vector, topK)` → ranked `VectorHit[]`.

```
  layers-and-hops — query path crossing the ports

  ┌─ tool ──────────┐ hop1: query text   ┌─ EmbeddingProvider ─┐
  │ search_knowledge│ ─────────────────► │ embed([query])      │
  │ _base handler   │ hop2: number[768] ◄│ (Ollama :11434)     │
  └────────┬─────────┘                    └─────────────────────┘
           │ hop3: search(vector, k)
           ▼
  ┌─ VectorStore ───────────────────────────────────────────────┐
  │  InMemoryVectorStore: cosine scan over JS array  (aptkit)    │
  │  PgVectorStore:       <=> over HNSW index        (buffr)     │
  │  hop4: VectorHit[] { id, score, meta } ──────────────────────┘
```

**The dimension one-way door.** A corpus embedded at 768 dims can't be
searched by a query vector of another length — cosine over mismatched vectors
is meaningless. So the store rejects mismatched vectors *loudly*
(`contracts.ts:28-37`), and the pipeline asserts embedder-dimension ==
store-dimension at wiring time (`assertWiring` in `pipeline.ts`). Fail at
construction, not silently at query time with garbage rankings.

**The two guardrails on the tool** — these exist because the default model is
emulated-tool-calling gemma (see `01`), which is weak
(`search-knowledge-base-tool.ts`):

```ts
const minTopK = Math.max(1, options.minTopK ?? 1);    // line 51
// ...
const topK = Math.max(requestedTopK, minTopK);        // line 81: floor applied
//   ↑ stops a weak model passing top_k:1 and starving its own retrieval

function matchesFilter(hit, filter) {                 // lines 101-105
  // a filter key only excludes hits that HAVE the key with a DIFFERENT value;
  // absent keys are ignored — so a hallucinated filter can't wipe every result
  return Object.entries(filter).every(([k, v]) => !(k in hit.meta) || hit.meta[k] === v);
}
```

Both are code-side decisions defending against the model. The `minTopK` floor
fixes multi-part-question misses; the tolerant filter stops a hallucinated
`{textContains:"x"}` from silently returning zero hits.

#### Move 2 variant — the load-bearing skeleton

The irreducible RAG kernel here: **embed query → similarity search → rank →
hand back with citation**. Name each part by what breaks if it's gone:

- **embed (the embedder port)** — gone, and there's no vector to search; RAG
  can't start.
- **search + rank (the store port)** — gone, and you have no relevance
  ordering; the model gets unranked or no context.
- **the citation metadata (`docId`/`text` in `meta`)** — gone, and the model
  can answer but can't *cite*; grounding becomes unverifiable.
- **the dimension invariant** — gone, and mismatched vectors produce silent
  garbage rankings instead of a loud failure. This is the part people forget.

Hardening on top: `minTopK`, the tolerant filter, over-fetch-then-filter.

### Move 2.5 — memory reuses these exact ports (current vs future)

The strongest evidence the ports are the right boundary: episodic conversation
memory (`@aptkit/memory`) is built on the *same two ports*, zero new infra
(`packages/memory/src/conversation-memory.ts:60`). `remember` is the index
path; `recall` is the query path. Rows are tagged `meta.kind:'memory'` and
`recall` over-fetches then filters by `kind` because the `VectorStore`
contract has no metadata predicate (`conversation-memory.ts:89-106`).

```
  Phase A (now, in aptkit)            Phase B (buffr deployment)
  ───────────────────────            ───────────────────────────
  retrieval + memory share the       memory.remember() persists to
  two ports; tested over             PgVectorStore — durable across
  InMemoryVectorStore.               sessions. buffr/src/session.ts:53,66
  No aptkit agent wires memory yet.  wires it; aptkit ships the engine.
```

What *doesn't* change moving to Phase B: the memory engine names no database.
Swap the injected store from in-memory to `PgVectorStore` and the
remember/recall logic is byte-identical.

### Move 3 — the principle

Make retrieval a tool the model invokes, not a step the code forces — and put
the substrate behind a contract so the vendor is incidental. The reuse by
memory is the proof: a second feature fell out of the same two ports with no
new infrastructure.

## Primary diagram

```
  retrieval-as-a-tool, end to end

  ┌─ agent (rag-query) ─────────────────────────────────────────────┐
  │  model emits tool_use: search_knowledge_base(query, top_k)       │
  └──────────────────────────────┬───────────────────────────────────┘
              tool boundary ──────┼──── (control flips to model)
  ┌─ tool handler ────────────────▼───────────────────────────────────┐
  │  minTopK floor · tolerant filter · over-fetch-then-filter          │
  └──────────────┬─────────────────────────────────┬───────────────────┘
                 │ embed([query])                   │ search(vector, k)
  ┌─ Embedding port ▼──────────┐      ┌─ VectorStore port ▼──────────────┐
  │ OllamaEmbeddingProvider    │      │ InMemoryVectorStore (cosine scan) │
  │ nomic · 768-dim · :11434   │      │ PgVectorStore (<=> over HNSW)      │
  └────────────────────────────┘      └────────────────────────────────────┘
       ▲ dimension invariant: embedder.dimension == store.dimension (asserted at wiring)
       └──────────────── memory (remember/recall) reuses BOTH ports, zero new infra
```

## Elaborate

This is classic RAG with two design choices that aren't universal: agentic
(tool-mediated) retrieval rather than always-retrieve, and a vendor-neutral
substrate. The agentic choice trades a guaranteed retrieval for letting the
model skip it when it already knows the answer — at the cost of a weak model
not searching when it should (hence `minTopK`). The neutral-substrate choice
is what lets buffr drop in pgvector. The pgvector engine internals (HNSW,
`<=>`) belong to `study-database-systems`; the `agents` schema shape belongs to
`study-data-modeling`. Read `03` for the loop that drives the tool call.

## Interview defense

**Q: Why is retrieval a tool instead of a pipeline step?**
So the model decides when context is needed. A direct question gets answered in
one turn; a multi-part question triggers multiple searches. The cost is that a
weak model might not search when it should — which is why there's a `minTopK`
floor stopping it from passing `top_k:1` and starving itself.

```
  question ─► model ─┬─ knows it ─────────────► answer (no retrieval)
                     └─ tool_use search ─► chunks ─► answer (grounded)
```
*Anchor:* "Retrieval reaches the agent as a tool, not bespoke control flow."

**Q: What's the part people forget in a RAG store contract?**
The dimension invariant. A corpus embedded at 768 dims searched by a query of
another length gives silent garbage rankings. Both ports carry `dimension` and
the wiring asserts they match — fail loud at construction, not quietly at query.

```
  embedder.dimension (768) ══ must equal ══ store.dimension (768)
       mismatch → throw at wiring, never a silent bad ranking
```
*Anchor:* "Embedding dimension is a one-way door — mismatch throws."

## See also

- `00-overview.md` — the retrieval ports on the full map
- `01-provider-abstraction.md` — same ports-and-adapters shape, model side
- `03-bounded-agent-loop.md` — the loop that lets the model call the tool
- `study-database-systems` — pgvector / HNSW / cosine `<=>` internals
- `study-data-modeling` — the `agents` schema shape
- `study-software-design` → PATTERN VOCABULARY — port / adapter / client
