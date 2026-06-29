# GraphRAG — retrieval over an entity graph

**Subtitle:** GraphRAG · traversing relations vector search can't see · *Industry standard*

## Zoom out, then zoom in

GraphRAG answers questions that vector search structurally cannot: "what connects
these two things," "what depends on this." It sits beside the vector store as a
*second* retrieval substrate — a graph of entities and relations rather than a flat
pile of chunks. aptkit's corpus is flat (chunks with meta, no graph), so this is
`not yet exercised` — taught as the pattern and where aptkit's metadata could seed
one.

```
  Zoom out — two retrieval substrates, aptkit ships one

  ┌─ Retrieval substrates ──────────────────────────────────────┐
  │  ★ FLAT: chunks + cosine ★         ← aptkit does this        │ ← we are here
  │    GRAPH: entities + relations     ← not yet exercised       │
  └───────────────────────────┬─────────────────────────────────┘
                              │ aptkit's reality:
  ┌─ VectorStore ─────────────▼─────────────────────────────────┐
  │  chunk.meta {docId, chunkIndex, text} — NO relations         │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. You know the difference between a `WHERE text LIKE` scan and a `JOIN`
across foreign keys. Vector search is the scan — it finds chunks that *resemble* the
query. A graph traversal is the join — it finds chunks *connected* to the query's
entities, even when they share no vocabulary. "Which services call the auth module?"
needs the join: the answer chunks may never contain the word "auth." aptkit only has
the scan.

## Structure pass

**Layers.** Substrate (flat chunks / entity graph) → unit (chunk / node + edge) →
retrieval move (cosine similarity / graph traversal).

**Axis — state.** Trace what each substrate stores. Flat: a vector and free-text meta
per chunk — no links between chunks. Graph: nodes (entities) and edges (relations) —
the links *are* the data. The axis "are relationships represented?" flips: aptkit's
meta has `docId`/`chunkIndex` (provenance) but no edges, so relationships exist only
implicitly in prose, never as queryable structure.

**Seam.** There is no graph seam in aptkit — only the flat `VectorStore`. The
*would-be* foothold is chunk meta (`docId`, `chunkIndex`, `pipeline.ts:44`): it could
seed a document-level graph (chunks of the same doc are connected; docs that cite
each other are connected). Nothing builds edges today; GraphRAG is `not yet
exercised`.

## How it works

### Move 1 — the mental model

You know two queries. `SELECT * FROM posts WHERE body LIKE '%auth%'` finds posts that
*mention* auth — that's vector search, by resemblance. `SELECT * FROM services JOIN
deps ON … WHERE target = 'auth'` finds services that *depend on* auth — that's a
graph traversal, by connection. The second answer set can be completely disjoint from
the first: a service can depend on auth without the word "auth" appearing anywhere in
its description. GraphRAG retrieves by connection, not resemblance.

```
  Resemblance vs connection — disjoint answer sets

  query: "what's affected if auth breaks?"
  ┌─ VECTOR (resemblance) ────────┐   ┌─ GRAPH (connection) ───────────┐
  │ chunks SAYING "auth"          │   │ chunks for services that DEPEND │
  │ — the auth docs themselves    │   │   on auth (may never say "auth")│
  └────────────────────────────────┘   └─────────────────────────────────┘
   vector finds the topic; graph finds the blast radius
```

### Move 2 — what GraphRAG adds, and aptkit's flat reality

**aptkit is flat: chunks carry provenance, not relations.** Each chunk's meta is set
in `indexDocument` (`pipeline.ts:44`):

```ts
meta: { ...(doc.meta ?? {}), docId: doc.id, chunkIndex: i, text },
```

`docId` and `chunkIndex` say *where a chunk came from*. They do not say *what it
relates to*. There is no entity list, no edge table, no traversal — retrieval is
cosine over independent vectors (`in-memory-vector-store.ts:25`). Two chunks about
the same entity in different words are neighbors only if their *embeddings* are
close; structurally they're strangers.

```
  aptkit's flat corpus — provenance, no edges

  chunk { vector, meta { docId, chunkIndex, text } }
                          └─ "where from"     └─ NOT "connected to what"
   retrieval = cosine(query, each chunk) — no relationship is ever traversed
```

**GraphRAG's two extra steps (PSEUDOCODE — not yet exercised).** A graph pipeline
adds an extraction step at index time and a traversal step at query time:

```
  GraphRAG index step (not built)
  for each chunk:
      entities  = llm.extractEntities(chunk.text)     # "auth module", "billing svc"
      relations = llm.extractRelations(chunk.text)     # billing --depends_on--> auth
      graph.addNodes(entities); graph.addEdges(relations)

  GraphRAG query step (not built)
  seeds   = vectorSearch(query)            # entry points (resemblance) — aptkit has this
  related = graph.traverse(seeds, hops=2)  # connected chunks (connection) — aptkit lacks this
  return rank(seeds + related)
```

The vector search still finds the *entry points*; the graph traversal expands to
chunks *connected* to those entry points that the query's vocabulary would never
surface.

```
  Two-substrate retrieval (the target shape)

  query ─► vector search ─► seed chunks ─► graph.traverse(2 hops) ─► connected chunks
              resemblance            │              connection
                                     └──► merged & ranked
```

**Where aptkit's meta could seed a graph.** `docId` already implies one cheap edge:
chunks of the same document are related. A doc-level graph (nodes = docs, edges =
"cites"/"same-topic") could be built from existing meta without entity extraction —
a lighter GraphRAG that aptkit's data *almost* supports. But nothing constructs even
that; the meta is provenance the search tool reads for citations, not a graph.

### Move 2.5 — current state vs future state

```
  Phase A (aptkit, now)             Phase B (GraphRAG — not yet exercised)
  ┌────────────────────────┐        ┌──────────────────────────────────┐
  │ FLAT corpus             │        │ entity graph alongside vectors     │
  │ cosine over chunks      │  add   │ extract entities+relations @ index │
  │ meta = provenance only  │ graph  │ vector seeds ─► traverse ─► merge  │
  │ no relations traversed  │        │ answers "what connects/depends"    │
  └────────────────────────┘        └──────────────────────────────────┘
   docId in meta COULD seed a doc-level graph — nothing builds one
```

### Move 3 — the principle

Vector search retrieves by resemblance; some questions need retrieval by connection,
and no amount of better embeddings gives you that — the relationships have to be
*represented*, not inferred from prose. GraphRAG is the substrate that represents
them: extract entities and relations at index time, traverse them at query time,
seed the traversal with vector search. Reach for it only when the questions are
relational ("what depends on X," "how do these connect"); for a resemblance corpus
like aptkit's notes, the flat store is correct and a graph is overhead.

## Primary diagram

```
  GraphRAG vs aptkit's flat retrieval

  ┌─ aptkit today (flat) ──────────────────────────────────────┐
  │ query ─► embed ─► cosine over chunks ─► top-k (resemblance) │
  │ chunk.meta = {docId, chunkIndex, text}  — no edges          │
  └────────────────────────────────────────────────────────────┘
                              vs
  ┌─ GraphRAG (not yet exercised) ─────────────────────────────┐
  │ index: extract entities + relations ─► build graph          │
  │ query: vector seeds ─► graph.traverse(hops) ─► connected    │
  │        rank(seeds + related)  — resemblance THEN connection  │
  └────────────────────────────────────────────────────────────┘
   docId could seed a doc-level graph; nothing constructs it
```

## Elaborate

GraphRAG is the most-overreached pattern in retrieval — it's expensive (an LLM
extraction pass over the whole corpus, plus a graph store) and only pays off for
genuinely relational questions. aptkit's corpus is a personal knowledge base where
questions are overwhelmingly "find the note about X" — resemblance, which the flat
cosine store nails. Naming GraphRAG as `not yet exercised` is the honest call: the
data (`docId` in meta, `pipeline.ts:44`) hints at a cheap doc-level graph, but
building entity extraction would be solving a problem aptkit doesn't have. The skill
is recognizing the *trigger* — relational questions, "what connects/depends" — not
reaching for the graph by default. Read `05-dense-vs-sparse.md` for the other axis of
"what vector search misses" and `04-vector-databases.md` for the flat store GraphRAG
would sit beside.

## Project exercises

### Build a document-level graph from existing chunk meta
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a graph where nodes are documents and edges link chunks of the
  same `docId` (and optionally docs sharing top terms); a `traverse(seedChunks,
  hops)` that expands vector hits to sibling chunks, merged into the result.
- **Why it earns its place:** it adds retrieval-by-connection using only data that
  already exists (`pipeline.ts:44` meta), proving you can recognize when the cheap
  graph is available without an expensive entity-extraction pass.
- **Files to touch:** a new `packages/retrieval/src/doc-graph.ts`,
  `packages/retrieval/src/search-knowledge-base-tool.ts` (expand seeds before
  `toResult`), a new test in `packages/retrieval/test/`.
- **Done when:** a test shows a query surfacing one chunk of a doc also returns its
  sibling chunks via traversal, even when those siblings score low on cosine.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "When would you reach for GraphRAG over plain vector search?"**
When the questions are relational — "what depends on X," "how do these connect,"
"what's the blast radius if Y breaks." Vector search retrieves by *resemblance*, so
it finds chunks that mention the topic; it structurally can't find chunks
*connected* to the topic that share no vocabulary. GraphRAG represents those
relations as edges and traverses them, seeded by a vector search. For a resemblance
corpus like aptkit's notes, it's overhead — which is why it's `not yet exercised`.

```
  resemblance question ─► vector search   |   connection question ─► graph traversal
```
Anchor: *vector search finds the topic; a graph finds what's connected to it.*

**Q: "Could aptkit support GraphRAG today?"**
Partially, and cheaply. Chunk meta already carries `docId` (`pipeline.ts:44`), which
implies a document-level graph: chunks of the same doc are connected, and docs that
cite each other could be edges — no entity extraction needed. But nothing builds even
that graph; the meta is provenance the search tool reads for citations
(`search-knowledge-base-tool.ts:109`), not a traversable structure. Full GraphRAG
would add an LLM extraction pass aptkit's corpus doesn't justify.

```
  docId in meta ─► COULD seed a doc-level graph ─► but nothing constructs edges
```
Anchor: *the provenance meta hints at a cheap graph; aptkit ships none — flat is correct here.*

## See also

- `05-dense-vs-sparse.md` — the other axis of what vector search misses
- `04-vector-databases.md` — the flat store GraphRAG would sit beside
- `01-embeddings.md` — why resemblance, not connection, is what cosine measures
- `11-rag.md` — the chunk meta (`docId`, `chunkIndex`) that could seed a graph
- `04-agents-and-tool-use/03-react-pattern.md` — multi-hop reasoning the agent does instead
