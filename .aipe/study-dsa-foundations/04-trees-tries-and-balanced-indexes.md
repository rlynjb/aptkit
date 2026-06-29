# Trees, Tries & Balanced Indexes

**Hierarchies · binary search trees · tries (prefix trees) · balanced trees (B-tree / B+tree) · hierarchical graph indexes** — Industry standard. **Status in aptkit: `not yet exercised`. In buffr: HNSW is a hierarchical graph index (cross-repo).**

## Zoom out, then zoom in

aptkit runs no tree. No BST, no trie, no B-tree, nothing recursive over a hierarchy. The *production* retrieval path, though, leans hard on a hierarchical index — HNSW — but that lives in **buffr**, not aptkit. This file teaches the tree family, then walks the one real hierarchical index in the story (buffr's HNSW, more graph than tree) and is honest that aptkit's own code has none.

```
  Zoom out — where hierarchical structures sit (none in aptkit)

  ┌─ aptkit Storage layer — packages/retrieval ──────────────────┐
  │  InMemoryVectorStore → FLAT array + linear scan              │ ← NO index,
  │    no tree, no balanced structure, no prefix index           │   no tree
  └───────────────────────────────────────────────────────────────┘

  ┌─ buffr Storage layer — sql/001_agents_schema.sql ────────────┐
  │  ★ HNSW index → hierarchical layered graph ★                  │ ← the one
  │    create index ... using hnsw (vector_cosine_ops)           │   hierarchical
  │  B-tree → Postgres primary-key / btree indexes (implicit)    │   index, and
  └───────────────────────────────────────────────────────────────┘   it's in BUFFR
```

Zoom in: a tree is a hierarchy where each node has children and there's one path from the root to any node. The *point* of the tree family is `O(log n)` operations by halving the search space at each level — a BST halves by value, a trie by character prefix, a B-tree by key range (and packs many keys per node for disk), HNSW by "skip-list-over-a-graph" layers. aptkit's flat array is the *opposite* choice: no hierarchy, `O(n)` scan, but dead simple. You've built BST and n-ary `Tree` in `reincodes`; this file is about the *index* role trees play — which aptkit declines and buffr accepts.

## Structure pass

```
  layers:  the hierarchy  →  what it splits on  →  the lookup cost
  axis held constant: "how does each level shrink the search space?"

  ┌─ BST ───────────────────────┐   split by VALUE; balanced → O(log n)
  │  reincodes/BinarySearchTree  │   → ordered keys, in-order = sorted
  └──────────────┬───────────────┘
                 │  seam: split key flips value → character prefix
  ┌─ trie ──────────────────────┐   split by PREFIX char; O(len) lookup
  │  autocomplete, routing       │   → shared prefixes stored once
  └──────────────┬───────────────┘
                 │  seam: split flips to KEY RANGE, packed for disk
  ┌─ B-tree / B+tree ───────────┐   split by range, high fan-out; O(log n)
  │  Postgres btree index        │   → disk-friendly, the DB default
  └──────────────┬───────────────┘
                 │  seam: split flips to PROXIMITY in vector space
  ┌─ HNSW (layered graph) ──────┐   split by layer; greedy → ~O(log n)
  │  buffr pgvector index        │   → approximate, vectors not keys
  └──────────────────────────────┘
```

The axis to hold: every level of every one of these *shrinks the search space*. A BST throws away half the values; a B-tree throws away all-but-one range; HNSW drops a layer and zooms in on a neighborhood. aptkit's flat array shrinks *nothing* per step — it just reads everything. That's the trade: zero index-build cost and exactness, paid for with `O(n)`.

## How it works

### Move 1 — the mental model

The tree family is one idea wearing different clothes: **make each step eliminate a chunk of the remaining candidates.** A balanced BST eliminates half the values per node (`O(log n)`). HNSW does the same trick but for *proximity* instead of *order*, and on a graph instead of a strict tree.

```
  the shared trick — each level eliminates candidates

  flat scan (aptkit)        balanced tree / index (buffr)
  ───────────────────       ──────────────────────────────
  [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓]        [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓]
  check all n: O(n)              ╱ halve ╲
                            [▓▓▓▓▓▓▓▓]  drop
                              ╱ halve ╲
                          [▓▓▓▓] drop
                          → O(log n) levels, each halves
```

### Move 2 — the one real hierarchical index: buffr's HNSW

aptkit has nothing to walk here, so the honest move is to walk the structure the *production* path actually uses — in buffr — and clearly label it cross-repo.

**HNSW is a hierarchical small-world graph — a skip-list over a proximity graph.** It lives in `buffr/sql/001_agents_schema.sql:28`:

```sql
  create index if not exists chunks_embedding_hnsw
    on agents.chunks using hnsw (embedding vector_cosine_ops);
```

Read what that one line buys. `using hnsw` tells Postgres (via pgvector) to build a multi-layer graph over the chunk embeddings. The top layer has a few nodes with long-range links; each layer down is denser; the bottom layer holds every vector. A search drops in at the top, greedily hops toward the query vector, descends a layer, repeats — so it touches `O(log n)` nodes instead of all `n`. The `vector_cosine_ops` part says "measure closeness by cosine," matching aptkit's `cosineSimilarity` exactly — same *metric*, completely different *traversal*.

```
  HNSW — hierarchical layers, greedy descent (buffr's index)
  (Storage layer — Postgres / pgvector)

  layer 2 (sparse)   ●━━━━━━━━━━━━━━━●        ← enter, long hops
                     │               │
  layer 1 (denser)   ●──●────●───────●──●     ← descend, medium hops
                     │  │    │       │  │
  layer 0 (all n)    ●─●●─●─●●─●─●─●─●●─●─●    ← every vector, short hops
                          ▲
                       query lands near here
  greedy: hop toward query each layer, descend → ~O(log n) nodes touched
```

The boundary condition — and it's the whole reason aptkit *doesn't* use it: HNSW is **approximate**. The greedy descent can miss the true nearest neighbor if it commits to the wrong neighborhood early. aptkit's flat scan is **exact** — it cannot miss, because it scores everything. So the seam between aptkit and buffr isn't "in-memory vs Postgres," it's **exact `O(n)` scan vs approximate `O(log n)` graph walk.** You trade a small recall error for a massive speedup, and you only make that trade when `n` is too big to scan. (File 05 walks HNSW as a *graph*; this file frames it as the *index/hierarchy* role.)

**Postgres's B-tree — the index you get for free.** buffr's `agents` schema has primary keys, and Postgres backs those with B-tree indexes automatically. A B-tree is the balanced tree built for *disk*: huge fan-out (hundreds of keys per node) so the tree is shallow and each node is one disk page. You won't see it in the SQL — it's implicit in `primary key` — but it's the reason a lookup by chunk id in buffr is `O(log n)`, not a table scan. aptkit's `Map<id, chunk>` is the in-memory equivalent (`O(1)` hash vs `O(log n)` tree) — same job, the structure differs because memory and disk reward different shapes.

**Tries — `not yet exercised` anywhere.** No autocomplete, no prefix routing, no longest-prefix match in aptkit or buffr. If aptkit ever added prefix-based tool routing or a typeahead over capability names, a trie would be the fit. Today: nothing. Don't manufacture it.

### Move 3 — the principle

A tree (or any hierarchical index) earns its keep by eliminating candidates per level — that's `O(log n)`. aptkit declines the index entirely: a flat array, `O(n)`, exact, zero build cost — correct while `n` is small. buffr accepts a *graph* index (HNSW) the moment `n` is large enough that exactness isn't worth a full scan. The structure you choose encodes how much you'll pay for certainty.

## Primary diagram

```
  trees & indexes across the story — one frame

  WHERE          structure         role                  status
  ──────────────────────────────────────────────────────────────────
  aptkit         (flat array)      no index, O(n) scan   no tree
  aptkit         Map<id, chunk>    O(1) identity lookup   hash, not tree
  buffr          B-tree (implicit) O(log n) key lookup   cross-repo
  buffr        ★ HNSW graph        O(log n) ANN search   cross-repo ★
  reincodes      BST, n-ary Tree   you BUILT these       drill, not evidence

  the seam:  aptkit EXACT O(n)  ═══►  buffr APPROXIMATE O(log n)
             (the metric is the same cosine; the traversal flips)
```

## Elaborate

The B-tree (Bayer & McCreight, 1972) and the trie (Fredkin, 1960) are the classic answers to "index by range" and "index by prefix." HNSW (Malkov & Yashunin, 2016) is the modern answer to "index by proximity in high-dimensional space" — and it's a *graph*, not a tree, because in 768 dimensions there's no clean ordering to build a BST on. That's the deep reason aptkit's array→HNSW jump skips trees entirely: vectors don't have a total order to split on, so the index has to be a navigable graph. The DB-engine view of HNSW (build params, `m`, `ef_construction`, recall tuning) belongs to **study-database-systems**; the graph-traversal view belongs to file 05; this file owns only the "it's a hierarchical index that beats the flat scan" framing.

## Interview defense

**Q: aptkit scans a flat array. What index would the production version use, and what does it trade?**
buffr uses HNSW — a hierarchical navigable small-world graph. It drops search from exact `O(n)` to approximate `O(log n)` by greedily hopping toward the query through layered graph links. The trade is exactness: HNSW can miss the true nearest neighbor. You accept that recall error only when `n` is too large to scan exactly.

```
  aptkit flat array   exact   O(n)       small n
  buffr HNSW graph    approx  O(log n)   large n
  same cosine metric, different traversal — that's the seam
```

Anchor: "Vectors have no total order, so the index can't be a BST — it has to be a navigable graph. That's why the jump is array → graph index, skipping trees."

**Q: Why not a B-tree on the embeddings?**
A B-tree indexes by *ordered key range*. A 768-dim vector has no single ordering — "closer in cosine space" isn't a range you can binary-search. B-trees handle the *id* lookups (Postgres does this implicitly for primary keys); proximity search needs a graph index like HNSW.

## See also

- `05-graphs-and-traversals.md` — HNSW walked as a graph traversal (greedy frontier)
- `02-arrays-strings-and-hash-maps.md` — the `Map` (hash) that does aptkit's id lookups instead of a B-tree
- `06-sorting-searching-and-selection.md` — the flat scan this index would replace
- **study-database-systems** — HNSW as a Postgres/pgvector index, build params, recall tuning
