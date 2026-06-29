# Trees, Tries & Balanced Indexes

**Industry name(s):** binary search tree · self-balancing trees (AVL / red-black / B-tree) · trie (prefix tree) · index structures — *Industry standard*

> **Status in aptkit: `not yet exercised`.** No tree, trie, or balanced index runs in aptkit's source. You've built `BinarySearchTree.ts` (insert/search/delete, all traversals, successor/predecessor) and `Tree.ts` (n-ary, generator traversals) from scratch. This file is curriculum — with **one real seam**: the thing aptkit's linear scan is missing *is* an index, and in the companion repo buffr that index is built (an HNSW graph, file **05**; B-tree/GIN indexes underneath, owned by `study-database-systems`). Trees are the answer to aptkit's `O(n)`-per-query problem.

---

## Zoom out, then zoom in

aptkit has no tree because it has no index — it scans a flat array. The whole reason trees matter *to this repo* is as the structure that would end the scan.

```
  Zoom out — the index-shaped hole in aptkit

  ┌─ aptkit Retrieval layer ────────────────────────────────────┐
  │  InMemoryVectorStore.search:                                │
  │    scan ALL n chunks, sort, slice    ← no index, O(n)       │
  │    ★ a tree/index would make lookup sub-linear ★            │
  └───────────────────────────┬─────────────────────────────────┘
                              │ same VectorStore contract, drop-in
  ┌─ buffr Storage layer (companion) ─▼─────────────────────────┐
  │  PgVectorStore → Postgres:                                  │
  │    HNSW graph index over embeddings (file 05)               │
  │    B-tree indexes on id/app_id columns (Postgres default)   │
  │    → query touches log(n) rows, not all n                   │
  │    [storage-engine mechanics owned by study-database-systems]│
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: a tree keeps data *ordered by a key* so you can find, range-scan, or rank without touching everything — `O(log n)` instead of `O(n)`. A trie does the same for *string prefixes*. A balanced index (B-tree) is the database's industrial version. aptkit's linear scan is precisely the structure you replace with one of these when `n` grows.

---

## Structure pass

**Layers (curriculum):** BST (ordered by comparable key), balanced BST / B-tree (ordered + height-bounded), trie (ordered by string prefix).

**Axis — lookup cost as a function of structure:** trace "how many elements do I touch to find one?"

```
  One axis — "how many elements to find a target?"

  flat array (aptkit) → touch ALL n           O(n)   — scan
  BST (balanced)      → touch one root-to-leaf O(log n) — comparisons
  B-tree (database)   → touch one path, wide   O(log n) — fewer disk pages
  trie                → touch len(key) nodes   O(L)   — prefix walk
```

**Seam — the no-index → indexed boundary at the `VectorStore` contract.** Both `InMemoryVectorStore` (aptkit) and `PgVectorStore` (buffr) implement the *same* `VectorStore` interface. On the aptkit side: no index, scan all `n`. Cross the contract into buffr: an HNSW index, touch `~log(n)`. The lookup-cost axis flips across that one seam — and because it's the *same contract*, swapping is a wiring change, not a rewrite.

---

## How it works

### Move 1 — the mental model

You built a BST: each node holds a key, everything in the left subtree is smaller, everything right is larger, so searching is "compare, go left or right, repeat" — `O(height)`, which is `O(log n)` if balanced. The index idea generalizes that: **keep data organized by a key so a query follows a path instead of scanning a list.** aptkit doesn't do this — it scans. The lesson is seeing the scan *as* a missing tree.

```
  Pattern — what a tree buys: path not scan

  flat array (aptkit search):
    [c0][c1][c2][c3][c4]...[cn]   ← compare EVERY one (O(n))

  BST / index (what replaces it):
                  [c_m]
                 /     \
            [c_lo]     [c_hi]      ← compare, branch, recurse
            /   \       /   \         touch only one root→leaf path
                                      O(log n)
```

But — and this is the catch that makes file **05** the real answer — a BST orders by a *scalar comparable key*. Embeddings are 768-dimensional vectors. There's no "<" on a vector. So a plain BST can't index them; you need a *spatial* / *approximate* structure, which is the HNSW graph. The tree intuition is the on-ramp; the vector case needs the graph.

### Move 2 — the walkthrough

#### Why aptkit has no tree: its key isn't orderable

The honest reason aptkit scans instead of indexing: its similarity query has no scalar key to build a BST on. Look at what `search` compares:

```ts
// packages/retrieval/src/in-memory-vector-store.ts:28-30
for (const chunk of this.chunks.values()) {
  hits.push({ id: chunk.id,
    score: cosineSimilarity(vector, chunk.vector),  // ← key computed PER QUERY
    meta: chunk.meta });
}
```

The ranking key — cosine similarity to *this query* — doesn't exist until the query arrives. You can't pre-order chunks in a tree by "distance to a query you haven't seen yet." That's why a naive vector store *must* either scan everything (aptkit) or use an index that approximates nearness in the embedding space *independent* of any single query (HNSW). A BST works when the key is fixed and scalar (the `chunk.id`, say); it does not work for nearest-neighbor over vectors.

The boundary condition: aptkit *does* have one place a tree-like index would trivially apply — keyed lookup by `chunk.id`. And it already uses one: the `Map<string, VectorChunk>` (file **02**) is a hash index on the id, `O(1)` lookup. So aptkit isn't index-free; it's *hash-indexed on the id key* and *scan-based on the similarity key*. Those are two different lookup problems.

#### The trie case: prefix search, and why aptkit doesn't need it

A trie indexes strings by shared prefix — each node is a character, paths spell words, `O(L)` lookup in word length regardless of dictionary size. It's the structure behind autocomplete and IP routing tables. aptkit does string work (the chunker, `parseAgentJson`) but never *prefix search* over a string set — it never asks "which keys start with `foo`?" So no trie. The contrast teaches the trie's niche: it earns its place only when you query by prefix, and aptkit's string operations are windowing and parsing, not prefix matching.

#### The balanced-index case: what buffr's pgvector adds underneath

When aptkit's `InMemoryVectorStore` is swapped for buffr's `PgVectorStore`, two index families enter — and they're both trees/graphs:

```
  buffr's indexes (companion repo — mechanics owned by study-database-systems)

  ┌─ on the embedding column ──────────────────────────────────┐
  │  HNSW (a layered GRAPH, not a tree) — file 05               │
  │  approximate nearest neighbor in vector space               │
  │  buffr/sql/001_agents_schema.sql:28-29                      │
  │    create index chunks_embedding_hnsw                       │
  │      using hnsw (embedding vector_cosine_ops)               │
  └──────────────────────────────────────────────────────────────┘
  ┌─ on the scalar columns (id, app_id) ──────────────────────┐
  │  B-tree (Postgres default) — balanced, height-bounded      │
  │  O(log n) keyed/range lookup on orderable columns          │
  └──────────────────────────────────────────────────────────────┘
```

This is the punchline of the whole tree topic for aptkit: the embedding can't go in a B-tree (no scalar order), so the vector index is the *graph* in file **05**; the scalar columns get ordinary B-trees. The "tree" answer to aptkit's scan splits into "B-tree for the orderable keys, ANN graph for the vectors."

### Move 3 — the principle

**An index is a tree (or graph) that pre-pays the ordering cost so each query walks a path instead of scanning a list — but only when the key can be ordered.** aptkit scans because its similarity key is computed per-query and lives in 768-dim space where there's no "<". The moment you fix the key (an id) you *do* see an index — the hash `Map`. The moment you need *vector* nearness at scale, the index isn't a tree at all; it's the HNSW graph. Reach for a tree when the key is scalar and orderable; reach for a graph when "nearness" is the query.

---

## Primary diagram

The tree/index landscape against aptkit's actual structures.

```
  Indexes vs aptkit — what's used, what's missing, what buffr adds

  KEY TYPE          STRUCTURE              WHERE IN THE SYSTEM
  ────────────────  ─────────────────────  ──────────────────────────
  chunk id (scalar) hash Map (hash index)  aptkit InMemoryVectorStore ✓
  id / app_id       B-tree                 buffr Postgres (default)   ✓
  string prefix     trie                   NOT NEEDED (no prefix query)
  768-d vector      — no BST possible —    aptkit: linear SCAN (O(n))
  768-d vector      HNSW graph (ANN)       buffr PgVectorStore  → file 05 ✓

  the tree intuition (O(log n) path not O(n) scan) is right;
  for vectors the realization is a GRAPH, not a tree.
```

---

## Elaborate

The B-tree (1970) was designed for exactly aptkit's eventual problem: too much data to scan, stored where each access is expensive (disk pages then, network/memory now). It stays balanced and wide so the path from root to any record is short and touches few pages. Tries (1959) solve the orthogonal problem — prefix queries over strings — and underlie spell-checkers, autocomplete, and longest-prefix-match routing. Your `BinarySearchTree.ts` is the conceptual ancestor of both: the ordered-key, branch-and-recurse idea.

The reason this topic is curriculum-only in aptkit and not a gap to feel bad about: aptkit's job is *vector* retrieval, and vectors don't fit the comparable-key model trees assume. The correct index for aptkit's hard problem is the HNSW *graph* — which is why file **05**, not this one, holds the real production structure. Read `study-database-systems` for how buffr's Postgres actually builds and uses these indexes; this file only names them as the structural answer to the scan.

---

## Interview defense

**Q: aptkit scans every chunk on every query. Why not put them in a tree for `O(log n)` lookup?**

> Because the ranking key — cosine similarity to the query — doesn't exist until the query arrives, and embeddings are 768-dimensional, so there's no scalar "<" to build a BST on. A tree indexes an *orderable* key; nearest-neighbor over vectors isn't that. aptkit *does* use a hash index (`Map` on chunk id) for keyed lookup — it's only similarity ranking that scans. The real index for the vector case is a spatial/approximate structure: an HNSW graph, which is what buffr's `PgVectorStore` uses behind the same `VectorStore` contract.

```
  scalar key  → B-tree / hash       O(log n) / O(1)
  vector key  → no tree; HNSW graph ≈ O(log n) ANN   ← file 05
```

**Q: Would a trie help anywhere in aptkit?**

> No — a trie indexes string *prefixes*, and aptkit never queries by prefix. Its string work is fixed-window chunking and tolerant JSON parsing, not "find keys starting with X." Naming where a structure *doesn't* fit is as much the point as where it does.

Anchor: *aptkit scans because its key is a per-query vector, not an orderable scalar — the index it's missing is a graph (HNSW), not a tree.*

---

## See also

- **05-graphs-and-traversals.md** — HNSW, the actual index structure for vectors; the one real graph in the system.
- **02-arrays-strings-and-hash-maps.md** — the `Map` hash index aptkit *does* use, and the array scan it doesn't index.
- **01-complexity-and-cost-models.md** — the `O(n)`-per-query cost that an index removes.
- `study-database-systems` — how buffr's Postgres builds and queries B-tree / HNSW indexes.
