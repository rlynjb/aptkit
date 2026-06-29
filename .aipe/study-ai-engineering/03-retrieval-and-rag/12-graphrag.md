# GraphRAG
> Graph-traversal retrieval · Industry standard

Vector RAG finds chunks that are *lexically/semantically similar* to your query. But some questions need chunks that are *structurally related* — connected through entities, not through shared words. "Which of our customers are affected by the bug in the auth service that Priya wrote?" touches customers, a bug, a service, and a person — and the chunks that answer it might share almost no vocabulary. Cosine can't follow that chain. GraphRAG can: extract entities and relationships into a graph, then *traverse* the graph from the query's entities to gather connected context. aptkit is pure dense vector RAG — there's no graph anywhere. This is `not yet exercised`, and your DSA background (you know graph traversal cold) makes it the most natural extension in this whole sub-section to build.

## Zoom out, then zoom in

GraphRAG is an alternative retrieval substrate — it would sit *beside* the vector store, not on top of it.

```
two retrieval substrates (aptkit has only the left)
┌──────────────────────────────────────────────────────────┐
│  search tool → retrieve context for the agent               │
└──────┬─────────────────────────────────────────┬───────────┘
       ▼                                           ▼
┌────────────────────────┐          ┌──────────────────────────────┐
│ ★ VECTOR RAG (aptkit) ★ │          │ GRAPH RAG                      │
│ embed → cosine → top-k  │          │  ✗ not yet exercised           │
│ ranks by SIMILARITY     │          │ entities + edges → traverse    │
│ flat chunks, no links   │          │ ranks by CONNECTION            │
└────────────────────────┘          └──────────────────────────────┘
```

aptkit's chunks are an unconnected bag — `VectorChunk` has `{id, vector, meta}` and no edges to other chunks. The graph that GraphRAG needs (entities as nodes, relationships as edges) doesn't exist in the data model. That's the gap: vector RAG treats the corpus as a set of independent passages; GraphRAG treats it as a connected structure you can walk.

## Structure pass

Pick the **state** axis: what relational state does each substrate hold?

```
relational state across the two substrates
  VECTOR RAG                         GRAPH RAG
  ┌──────────────────────┐          ┌──────────────────────────────┐
  │ chunks: a flat SET     │          │ nodes (entities) + edges      │
  │ no chunk knows another │          │ (relationships)               │
  │ relation = "close in   │          │ relation = an explicit EDGE   │
  │  vector space"         │          │  you can traverse             │
  └──────────────────────┘          └──────────────────────────────┘
   ★ seam: GraphRAG materializes relationships vector RAG only implies ★
```

The seam is *where relationships live*. In vector RAG, "related" is implicit and approximate — two chunks are related if their vectors are close, which only captures *semantic* similarity. In GraphRAG, relationships are explicit, typed edges ("Priya AUTHORED auth-service", "bug-42 AFFECTS auth-service") you extracted once and can now traverse exactly. Multi-hop questions — chains of 2+ relationships — are where this flips: cosine can't chain, traversal does it natively.

## How it works

**Move 1 — the mental model: corpus as a graph.** GraphRAG runs in two phases — build the graph (offline), traverse it (at query time):

```
GraphRAG, two phases
  BUILD (offline, once)                 QUERY (per request)
  ┌──────────────────────────┐         ┌──────────────────────────┐
  │ for each chunk:            │         │ extract entities in query  │
  │  LLM extracts entities +   │         │ locate them as graph nodes │
  │  relationships             │         │ traverse N hops out (BFS)  │
  │  → nodes + typed edges      │         │ gather connected chunks    │
  └──────────────────────────┘         └──────────────────────────┘
        builds the graph                     walks it for context
```

The build phase is an LLM extraction job: feed each chunk to a model, ask "what entities and relationships are in this?", accumulate into a graph. The query phase is pure DSA — your territory: find the query's entities as nodes, then BFS/DFS outward to collect connected context.

**The query-time traversal.** `not yet exercised`. The traversal is exactly the graph BFS you'd write in an interview:

```
traversal from query entities (pseudocode — DOES NOT EXIST in aptkit)
function graphRetrieve(query, graph, maxHops = 2):
    seeds = extractEntities(query)          # "Priya", "auth service"
    visited, context = set(), []
    frontier = [(node, 0) for node in seeds if node in graph]
    while frontier:                          # BFS — your DSA muscle memory
        node, depth = frontier.pop(0)
        if node in visited or depth > maxHops: continue
        visited.add(node)
        context += node.chunks               # gather chunks attached to this entity
        for edge in graph.edges(node):       # follow relationships outward
            frontier.push((edge.target, depth + 1))
    return context                           # connected, not just similar
```

```
multi-hop example cosine CANNOT do
  query: "customers affected by Priya's auth bug"
   Priya ──AUTHORED──► auth-service ──HAS_BUG──► bug-42 ──AFFECTS──► [CustomerA, CustomerB]
     │                                                                      │
   hop 0                hop 1            hop 2          hop 3 (the answer)
   cosine: "Priya" and "CustomerA" share NO words/meaning → never co-retrieved
   graph:  3 hops of typed edges → lands exactly on CustomerA, CustomerB ✓
```

That chain is the whole point: the answer (CustomerA, CustomerB) is structurally three hops from the query's entities but semantically unrelated to the query text. Vector RAG can't reach it; graph traversal walks straight to it.

**The contract it'd need.** aptkit's `VectorChunk` has nowhere to put edges — GraphRAG needs a new data model:

```ts
// what's MISSING — aptkit's chunk has no relational structure
// packages/retrieval/src/contracts.ts:8-12
export type VectorChunk = {
  id: string;
  vector: number[];
  meta: Record<string, unknown>;     // ← no entities, no edges; chunks are islands
};
// GraphRAG would add: GraphNode { id, type, chunkIds[] }, GraphEdge { from, to, relation }
```

In buffr's Postgres, the graph has a natural home: an `agents.entities` table and an `agents.edges` table alongside `agents.chunks` — recursive CTEs (`WITH RECURSIVE`) do the traversal in SQL, or you load the graph into memory and BFS it. Either way it's net-new structure.

**Move 3 — the principle.** Vector RAG and GraphRAG answer different question shapes. Vector RAG wins on "find me passages about X" — single-hop, similarity-driven, the common case. GraphRAG wins on "what connects X to Y through the corpus" — multi-hop, relationship-driven, where the answer shares no vocabulary with the question. You don't replace one with the other; you reach for the graph when questions are about *connections* and cosine keeps missing because similarity isn't the right relation. The build cost is real (an LLM pass over the whole corpus to extract the graph), so you earn it on corpora where structure is the point — org charts, dependency graphs, knowledge bases with rich cross-references.

## Primary diagram

```
GraphRAG vs vector RAG on a multi-hop query (the buildable target)
   query: "which customers hit Priya's auth bug?"
        │
        ├─► VECTOR RAG: embed → cosine → chunks SIMILAR to the query text
        │     finds: chunks mentioning "auth bug" — MISSES the customers
        │     (CustomerA shares no words with the query)
        │
        └─► GRAPH RAG (gap): extract {Priya, auth-service} → BFS 3 hops
              Priya ─AUTHORED→ auth-service ─HAS_BUG→ bug-42 ─AFFECTS→ {A, B}
              gathers the connected chunks → answer the customers ✓
   ─────────────────────────────────────────────────────────────────────
   build cost: 1 LLM extraction pass over the corpus (offline, once)
```

When the answer is *connected* to the query rather than *similar* to it, traversal reaches what cosine can't.

## Elaborate

GraphRAG was named and popularized by Microsoft Research (2024) — their pipeline adds **community detection** (Leiden clustering over the graph) and **community summaries** so the model can answer global "what are the themes" questions, not just entity lookups. Adjacent: **knowledge graphs** (the decades-old structured-knowledge idea GraphRAG revives with LLM extraction), **entity linking** (resolving "Priya"/"P. Sharma"/"she" to one node — the hard part of the build phase), and **hybrid graph+vector** (use vectors to find seed entities, then traverse — the practical combination most production systems land on). Your DSA strength is the leverage here: the traversal is BFS/DFS over a typed graph, exactly the shape you know cold. Read next: `11-rag.md` (the vector RAG this extends) and `05-dense-vs-sparse.md` / `06-hybrid-retrieval-rrf.md` (the other "different relation" retrieval lanes).

## Project exercises

### Extract entities from the corpus into a graph, traverse on query

- **Exercise ID:** `EX-RAG-12a`
- **What to build:** A build step that runs an LLM extraction over each chunk into `GraphNode`/`GraphEdge` structures, plus a `graphRetrieve(query, maxHops)` that extracts query entities and BFS-traverses to gather connected chunks.
- **Why it earns its place:** It's the substrate aptkit entirely lacks, it answers the multi-hop questions cosine provably can't, and the traversal plays directly to your DSA strength. Case B — net-new from scratch. Phase 2B.
- **Files to touch:** new `packages/retrieval/src/graph-store.ts` (node/edge model + BFS) and `packages/retrieval/src/graph-extractor.ts` (LLM extraction, injectable transport like `OllamaEmbeddingProvider`); new tables (`agents.entities`, `agents.edges`) alongside `buffr/sql/001_agents_schema.sql` for the durable path.
- **Done when:** on a fixture with a known 3-hop chain, `graphRetrieve` returns the structurally-connected chunk that the dense store (`packages/retrieval/src/in-memory-vector-store.ts`) provably fails to retrieve, with a test contrasting the two.
- **Estimated effort:** `≥1 week`

### Build the multi-hop fixture that breaks vector RAG

- **Exercise ID:** `EX-RAG-12b`
- **What to build:** A small corpus + query set engineered so the answer is N hops from the query entities but lexically/semantically dissimilar to the query — the case where cosine misses and traversal must win.
- **Why it earns its place:** GraphRAG is only justified by questions vector RAG fails; this fixture is that proof and the regression net for `EX-RAG-12a`. It also sharpens *when* to reach for a graph at all.
- **Files to touch:** test fixtures alongside `packages/retrieval/src/in-memory-vector-store.ts`.
- **Done when:** the fixture has ≥2 multi-hop queries where the dense top-5 provably excludes the correct answer chunk.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Give a query your vector RAG can't answer but GraphRAG can.**

```
"customers affected by Priya's auth bug"
   answer = CustomerA, 3 hops away, shares NO words with the query
   cosine: similarity(query, "CustomerA chunk") ≈ 0 → never retrieved
   graph: Priya→service→bug→customers, BFS lands on it
```

Anchor: multi-hop questions where the answer is *connected* to the query but not *similar* to it — cosine ranks by similarity and can't chain relationships; graph traversal follows the edges.

**Q: GraphRAG sounds strictly better. Why is most RAG still vector-only?**

```
build cost: an LLM extraction pass over the ENTIRE corpus (offline, expensive)
   + entity linking is hard (Priya / P. Sharma / "she" → one node)
   most queries are single-hop "about X" → cosine already nails them
```

Anchor: GraphRAG pays a heavy offline build (LLM extraction + entity resolution) to win on multi-hop connection questions — most real queries are single-hop similarity, where vector RAG is cheaper and already sufficient.

## See also

- [11-rag.md](11-rag.md) — the vector RAG this extends
- [05-dense-vs-sparse.md](05-dense-vs-sparse.md) — another "different relation" retrieval lane
- [06-hybrid-retrieval-rrf.md](06-hybrid-retrieval-rrf.md) — fusing substrates (graph + vector)
