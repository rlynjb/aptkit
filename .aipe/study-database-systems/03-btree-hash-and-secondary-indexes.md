# B-tree, Hash, and Secondary Indexes

**Industry name:** B-tree index / approximate nearest neighbor (HNSW) · *Industry standard*

## Zoom out — the two index kinds in one schema

buffr's schema has two *completely different* kinds of index doing two
different jobs. Knowing which is which is the whole lesson:

```
  Zoom out — indexes in agents.chunks

  ┌─ Storage engine (Postgres + pgvector) ────────────────────┐
  │                                                            │
  │  ┌─ B-tree indexes (exact lookup) ────────────────────┐   │
  │  │ chunks_pkey       on (id)        ← PK, auto         │   │
  │  │ chunks_app_id     on (app_id)    ← explicit         │   │
  │  └─────────────────────────────────────────────────────┘   │
  │                                                            │
  │  ┌─ ★ HNSW index (approximate vector search) ★ ──────┐    │
  │  │ chunks_embedding_hnsw                              │    │ ← we are here
  │  │   on (embedding vector_cosine_ops)                 │    │
  │  └─────────────────────────────────────────────────────┘   │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — what this file covers

The question: **how does each index find a row, what does each cost on
write, and why is the vector index *approximate* when the others are exact?**
The surprising one is the HNSW index (the secondary index over embeddings):
it trades exactness for speed, which no B-tree does.

## Structure pass

**Layers.** Exact-match indexes (B-tree on `id`, on `app_id`) on one level;
the approximate index (HNSW on `embedding`) on another. They answer
different *question shapes*.

**Axis — trace "what question does this index answer?"**

```
  One question per index: "what can it find for me?"

  chunks_pkey (id)          → "the row with exactly THIS id"   exact, O(log n)
  chunks_app_id (app_id)    → "all rows for THIS tenant"       exact, range
  chunks_embedding_hnsw     → "the k rows CLOSEST to this      approximate,
    (embedding)                vector" — there is no 'exact'   sublinear
                               match; nearness is the query

  the axis-answer flips at the HNSW index: it's the only one where
  the query has no exact answer — only a best-effort ranked guess
```

**Seam.** The seam is **exact vs approximate**. Cross it and the guarantee
changes: a B-tree lookup either finds the row or it doesn't; an HNSW search
returns *probably* the nearest k, and might miss a true nearest neighbor.
That's the load-bearing distinction in a vector database.

## How it works

### Move 1 — the mental model

You've built a BST and a Binary Heap from scratch (`BinarySearchTree.ts`,
`BinaryHeap.ts`). A B-tree is your BST's disk-friendly cousin: same
ordered-tree idea, but each node holds many keys to match the page size, so
the tree stays shallow and a lookup is a handful of page reads. HNSW is a
different animal — it's a **navigable graph**, closer to the BFS/greedy
traversal you wrote in `Graph.ts` than to a tree.

```
  Two index shapes

  B-tree (exact, on id / app_id)        HNSW (approximate, on embedding)
  ──────────────────────────────        ────────────────────────────────
         [root keys]                     layer 2:  o─────────o   (sparse,
        /    |     \                                |         |    long hops)
   [..] [..] [..] [..]   leaves          layer 1:  o──o───o──o
    descend by key compare               layer 0:  o-o-o-o-o-o-o (dense,
    → land on exact row                            greedy-walk toward query
                                                   vector, hop to nearest
                                                   neighbor each step)
```

### Move 2 — index by index

**The primary key index (B-tree on `id`).** `id text primary key`
(`001_agents_schema.sql:15`) auto-creates a B-tree. It's what makes the
`upsert`'s `on conflict (id) do update` cheap (`pg-vector-store.ts:50`) —
Postgres needs to find whether a row with this `id` already exists, and the
PK B-tree answers that in O(log n) page reads.

```
  Upsert conflict check — the PK B-tree earns its keep

  INSERT ... id='doc.md#3' on conflict (id) do update
                  │
                  ▼ probe chunks_pkey (B-tree)
        found? ── yes ──► UPDATE this row (re-embed overwrites)
               └─ no  ──► INSERT new row
```

The consequence: re-indexing a document is idempotent. Same chunk ids
(`<docId>#<index>`), so the second index *overwrites* rather than
duplicates. Without the PK index that conflict check would be a full scan.

**The tenant index (B-tree on `app_id`).** `chunks_app_id`
(`001_agents_schema.sql:30`) supports the `where app_id = $2` filter that
every search applies (`pg-vector-store.ts:74`). With one `app_id` (`'laptop'`)
in a single-user runtime, this index does almost nothing today — every row
matches. *Observed*: it's built defensively for multi-tenant later, not
exercised now. Honest read: with one tenant, the planner may ignore it
entirely and scan, because the index doesn't narrow anything.

**The vector index (HNSW on `embedding`) — the load-bearing one.**

```sql
-- buffr/sql/001_agents_schema.sql:28-29
create index if not exists chunks_embedding_hnsw
  on agents.chunks using hnsw (embedding vector_cosine_ops);
```

Two things to read here. `using hnsw` picks the graph-based ANN index (vs
pgvector's other option, IVFFlat). `vector_cosine_ops` tells the index to
build its distances with **cosine** — which has to match the `<=>` operator
the query uses (`pg-vector-store.ts:74`) and the cosine similarity the
in-memory store computes. If the opclass and the query operator disagreed,
the index wouldn't be used and search would silently fall back to a full
scan. They agree here, deliberately.

Here's the kernel of how HNSW answers a query — name each part by what
breaks without it:

```
  HNSW search kernel — greedy walk down layered graphs

  start at an entry node, top (sparsest) layer
  repeat per layer, descending:
    look at current node's neighbors
    move to the neighbor closest to the query vector   ← greedy step
    when no neighbor is closer, drop to the layer below
  at layer 0: collect the ef_search closest seen        ← candidate pool
  return the top-k                                       ← answer
```

- Drop the **layered structure** → it's a flat graph; you lose the
  log-scale long hops and search degrades toward linear.
- Drop the **greedy "move to closest neighbor"** → no convergence toward the
  query; you're wandering.
- Drop **`ef_search`** (the candidate-pool size) → you keep only the single
  greedy path and accuracy collapses; bigger `ef_search` = more accurate,
  slower. **buffr never sets `ef_search`** — it runs at pgvector's default
  (`not yet exercised`). That's the one knob that trades recall for latency,
  and it's untouched.

The *approximate* part lives in that greedy walk: it can get stuck in a
local pocket of the graph and never visit the globally-nearest vector. For
buffr's corpus (a laptop's worth of indexed markdown) that's fine; at
millions of vectors with a tight latency budget, tuning `ef_search` and the
build-time `m` is where you'd spend your time.

**Write cost — the part people forget.** Every `INSERT` into `chunks`
doesn't just write the heap tuple; it inserts the vector into the HNSW graph,
which means finding neighbors and wiring edges. HNSW writes are *more*
expensive than B-tree writes. The consequence for buffr: re-indexing a doc
pays HNSW insert cost per chunk, inside the `upsert` transaction
(`pg-vector-store.ts:40-64`). At buffr's scale, invisible. At bulk-ingest
scale, it's the reason you'd build the index *after* loading, not before.
`not yet exercised` — buffr always has the index live during writes.

### Move 3 — the principle

Pick the index by the *question shape*, not by habit. Exact-match and
range questions want a B-tree. "Find the k closest in a high-dimensional
space" has no exact answer at all — that's what an ANN index like HNSW is
for, and the price of admission is that it's approximate and writes are
costlier. A vector database is the case where you deliberately give up
exactness because exact nearest-neighbor in 768 dimensions is too slow to
matter.

## Primary diagram

```
  Index recap — agents.chunks, two index families

  ┌─ EXACT (B-tree) ──────────────────────────────────────────┐
  │  chunks_pkey (id)      → upsert conflict check, O(log n)   │
  │  chunks_app_id (app_id)→ tenant filter (no-op at 1 tenant) │
  └────────────────────────────────────────────────────────────┘

  ┌─ APPROXIMATE (HNSW) ──────────────────────────────────────┐
  │  chunks_embedding_hnsw (embedding vector_cosine_ops)      │
  │                                                            │
  │   query vector ──► greedy walk down layered graph ──►     │
  │                    ef_search candidate pool ──► top-k     │
  │   write: insert vector into graph (costlier than B-tree)  │
  │   knobs untuned: ef_search, m  → not yet exercised        │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

HNSW (Hierarchical Navigable Small World) comes from the ANN-search
literature: build a multi-layer proximity graph where upper layers have long
edges for fast coarse navigation and the bottom layer is dense for precision.
It beat tree-based ANN methods (KD-trees, which collapse in high dimensions)
and is now the default for in-database vector search — it's what pgvector,
and therefore your AdvntrCue Postgres, reach for. The conceptual bridge from
your DSA work: it's a greedy graph traversal (you wrote greedy shortest-path
in `Graph2.ts` for Dijkstra) with a probabilistic layer structure on top.
The thing that makes it *not* Dijkstra is that it doesn't guarantee the
optimal answer — it guarantees a fast, usually-right one.

## Interview defense

**Q: You have an HNSW index. Why not just a B-tree on the vector?**
A B-tree orders by a comparable key; "closeness in 768-dim space" isn't a
single orderable key, so a B-tree can't answer nearest-neighbor at all. HNSW
is a navigable graph you greedily walk toward the query vector — sublinear,
but approximate.

```
  B-tree: descend by key compare → exact
  HNSW:   greedy graph walk → approximate top-k
```

**Q: What's the one HNSW knob you'd reach for under load, and have you tuned it?**
`ef_search` — the candidate-pool size; bigger means higher recall, slower
query. I have *not* tuned it; buffr runs pgvector's default. At a laptop's
corpus size it doesn't bite. At millions of vectors with a latency budget,
that's the first dial.

**Anchor:** "B-tree answers 'which row is this'; HNSW answers 'which rows are
near this' — and 'near' has no exact answer, so it's approximate by design."

## See also

- `02-records-pages-and-storage-layout.md` — the embedding column the HNSW index covers.
- `04-query-planning-and-execution.md` — how the planner chooses (or skips) these indexes.
- `09-database-systems-red-flags-audit.md` — untuned HNSW as a flagged risk.
