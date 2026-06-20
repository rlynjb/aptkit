# 03 — B-tree, hash, and secondary indexes

**Subtitle:** Index structures / B-tree vs hash / secondary / ANN indexes —
*Industry standard* (taught), *analogs: the filename sort (on disk) and a
linear cosine scan in `InMemoryVectorStore` (in memory)* (in-repo)

---

## Zoom out, then zoom in

An index is the data structure that turns "scan every row to find one" into
"jump straight to it." Databases live or die on theirs — B-trees for range
scans, hash indexes for point lookups, secondary indexes for querying by a
non-key column. AptKit has exactly one index, and it isn't a data structure
at all: it's the *order the filenames sort in*. That single, accidental index
is powerful enough to make "list runs newest-first" instant and fragile
enough to break the moment a filename stops leading with a timestamp.

```
  Zoom out — where the "index" lives

  ┌─ Service layer (the read path) ───────────────────────────┐
  │  readdir(dir) → filter → ★ .sort() ★ → read each          │ ← we are here
  │                          the ONLY index in the whole repo  │
  └───────────────────────────┬───────────────────────────────┘
  ┌─ Storage layer ───────────▼───────────────────────────────┐
  │  filenames: 2026-06-18T19-29-11-225Z-...-studio.json      │
  │  the timestamp PREFIX is what makes the sort meaningful    │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question: *how does AptKit find or order records without an
index structure?* Answer: it doesn't find by anything but a full scan, and it
orders by sorting filenames lexicographically. Because the filenames start
with a zero-padded ISO-8601 timestamp, a *string* sort happens to equal a
*chronological* sort. That coincidence is the index. Understand why it holds
and exactly when it fails.

---

## Structure pass

The layers: the **logical query** ("give me runs, newest first" or "give me
the run for capability X") and the **physical lookup** (what the code does to
satisfy it). Axis to hold constant: **lookup cost — how many records must I
touch to answer the query?**

```
  One axis — "records touched per query" — across the index layers

  ┌───────────────────────────────────────────┐
  │ query: "newest run first"                 │  → answered by filename sort:
  └───────────────────────────────────────────┘    touch all N to sort, but the
                                                    sort key needs no file read
      ┌───────────────────────────────────────┐
      │ query: "the run for capability=query" │  → NO index: must read +
      └───────────────────────────────────────┘    parse all N, then filter
                                                    (full scan, O(N) reads)

  the seam: ordering by time is cheap (filename-encoded); ordering or
  filtering by ANY other attribute is a full scan. That asymmetry IS the
  index design.
```

The load-bearing seam is between "queryable from the filename alone"
(timestamp ordering) and "requires opening the record" (everything else).
Anything you want fast must be encoded in the filename; anything not in the
filename costs a full scan. That's the entire index story, and it's why the
N+1 in file `04` exists.

---

## How it works

### Move 1 — the mental model

You know how a phone book is sorted by last name, so you binary-search to a
name instead of reading every entry? A B-tree is that, kept balanced as you
insert, so lookups and range scans stay logarithmic. The mental model: **an
index is a sorted (or hashed) copy of one column plus pointers back to the
rows, so you search the small sorted thing instead of the big table.**

```
  the real mechanism: a B-tree index (sorted, balanced, pointers to rows)

                 ┌──────── [ M ] ────────┐         ← root: one comparison
                 ▼                        ▼            picks a subtree
          ┌──[ D | H ]──┐          ┌──[ T | X ]──┐  ← internal nodes
          ▼      ▼      ▼          ▼      ▼      ▼
        [A..C][E..G][I..L]      [N..S][U..W][Y..Z] ← leaves → row pointers

  point lookup "H":  root → right of D, left of T... → leaf → row   (O(log N))
  range scan "D..L": find D in leaf, walk leaves rightward          (sequential)
```

A hash index drops the ordering: it hashes the key to a bucket for O(1) point
lookups, but loses range scans entirely. AptKit's filename sort is neither a
B-tree nor a hash — it's a sort performed fresh on every query, over keys
that happen to live in the filenames.

### Move 2 — the parts that matter

**The clustered "index": filename order.** A clustered index decides the
physical order records are stored in. AptKit's records are stored in a
directory with no inherent order, so the *query* imposes order by sorting
filenames. Because each filename is `<ISO-timestamp>-<slug>-<provider>.json`,
and ISO-8601 timestamps are designed to sort lexicographically the same as
chronologically, `.sort()` gives newest-or-oldest-by-time for free. What
concretely happens: `listReplayArtifacts` calls `.sort()` (ascending string
order); `listReplaySummaries` calls `createdAt.localeCompare` descending.
Boundary condition: **this only works because of the timestamp prefix.** Drop
it, pad a month without a leading zero, or switch to UUID filenames, and the
"index" returns garbage order with no error.

```
  the filename IS the index key — and it's a string sort, not a date sort

  2026-06-18T16-45-45-185Z-...   ┐
  2026-06-18T16-53-02-698Z-...   │  string sort  ==  chronological sort
  2026-06-18T17-18-41-781Z-...   │  ONLY because ISO-8601 is zero-padded
  2026-06-18T19-29-11-225Z-...   ┘  and fixed-width

  break it:  "6-18-..." vs "12-18-..."  → "12" sorts before "6"  → WRONG
```

**The missing secondary index.** A secondary index lets you query by a
non-primary column (find all runs where `capabilityId = 'query-agent'`).
AptKit has none. To answer "give me the query-agent runs," `listReplaySummaries`
reads and parses *every* file, then you'd filter in memory. What breaks
without a secondary index: every by-attribute query is a full scan. This is
`not yet exercised` as a real index — the trigger is "you query artifacts by
`capabilityId`/`provider`/`fixture` often enough that scanning all of them
hurts."

**The missing point-lookup (hash) index.** There's no "fetch the artifact
with id X in O(1)." The closest the repo gets is the `FixtureModelProvider`
serving responses by an integer `index` (`fixture-provider.ts:13`) — a
direct array-offset lookup, which is the degenerate case of a hash index
(perfect hashing by position). But that's over an in-memory array, not the
on-disk artifacts. The new `InMemoryVectorStore` *does* hold a true hash index
for point lookups — its chunks live in a `Map<string, VectorChunk>`
(`in-memory-vector-store.ts:11`), so `upsert` replacing an id is an O(1) hash
write. But that hash is only used for upsert dedup, never for read: the read
path (`search`) ignores the `Map`'s keys entirely and scans all values.

**The vector "index" that is really a full scan (the new one).** This is the
load-bearing addition. `@aptkit/retrieval`'s `InMemoryVectorStore.search`
(`in-memory-vector-store.ts:25-33`) answers a similarity query — "give me the k
chunks closest to this query vector" — and the way it does it is the entire
lesson of this file in miniature. It computes `cosineSimilarity` against
*every* stored chunk, pushes them all into an array, sorts descending by score,
and slices the top k. That is `ORDER BY similarity LIMIT k` executed as a
**sequential scan with a sort** — no index assist at all. The right structure
for this query is an **ANN index** (Approximate Nearest Neighbor), of which
**HNSW** (Hierarchical Navigable Small World) is the standard: a multi-layer
graph you greedily walk to land near the answer in `O(log N)` hops instead of
touching all N vectors.

```
  scan (what aptkit does)  vs  HNSW ANN index (what a real store does)

  query vector q, N stored chunks, dimension d

  InMemoryVectorStore.search:
    for each of N chunks:  score = cosine(q, chunk)   ← touch ALL N, O(N·d)
    sort N scores                                     ← O(N log N)
    slice top-k                                       ← O(k)
    total: O(N·d + N log N)  — linear in corpus size

  HNSW (buffr's PgVectorStore, "using hnsw"):
            ┌── top layer (few nodes, long hops) ──┐
            │   enter ──► greedy-walk toward q       │
            └────────────────┬─────────────────────┘
                 descend to denser layer, repeat
            ┌── base layer (all nodes, short hops) ─┐
            │   land in q's neighborhood, return k   │
            └───────────────────────────────────────┘
    total: ~O(log N) nodes visited — sub-linear, the whole point of an index
```

What breaks without the ANN index: nothing, until the corpus grows. At a few
hundred chunks the scan is microseconds and an index would be pure overhead —
which is exactly why the in-memory store skips it. The trigger to need HNSW is
"the corpus is large enough that touching every vector per query hurts," and
that trigger is met in the **buffr** repo, not here:
`buffr/sql/001_agents_schema.sql:28-29` builds a real HNSW index
(`using hnsw (embedding vector_cosine_ops)`) and `buffr/src/pg-vector-store.ts:67-78`
queries it with pgvector's `<=>` cosine-distance operator behind the *same*
`VectorStore` contract aptkit defines. The adapter is swappable; the index
lives in the durable store.

### Move 3 — the principle

An index is a precomputed answer to a query you'll ask repeatedly, traded
against the cost of maintaining it on every write. AptKit precomputed exactly
one: time order, encoded into the filename for free at write time. Everything
else is a scan. The generalizable rule: **you get the queries your indexes
were built for cheaply, and pay full-scan for the rest — so index the queries
you actually run, and encode the cheap ones into the key if you can.**

---

## Primary diagram

```
  AptKit indexing — one index (time), everything else a scan

  QUERY                         MECHANISM                       COST
  ─────                         ─────────                       ────
  newest run first         →   .sort() on filenames        →   sort N keys,
                               (replay-runner.ts:43)            no file reads
                               localeCompare(createdAt)         O(N log N)
                               (vite.config.ts:983)

  run by capabilityId      →   read+parse every file,      →   FULL SCAN
                               filter in memory                 O(N) file reads
                               (no secondary index)

  artifact by id           →   not supported on disk;      →   would be O(N)
                               in-memory cursor by index        (in-mem: O(1))
                               (fixture-provider.ts:13)
```

---

## Implementation in codebase

**Use cases.** The time-order index is hit every time Studio lists prior runs
(newest first) and every time the CLI eval walks the directory (ascending).
There is no by-attribute lookup in the repo today — every consumer that wants
a subset reads all and filters.

**The only index — CLI side** — `packages/evals/src/replay-runner.ts:40-44`:

```
  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
    .map((entry) => join(dir, entry.name))
    .sort();   ← THE INDEX. Lexicographic ascending. Correct ordering depends
               │  entirely on filenames starting with a sortable ISO timestamp.
               └─ no comparator, no date parse — pure string compare
```

**The only index — Studio side** — `apps/studio/vite.config.ts:983`:

```
  return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
                                          │         │
                                          │         └─ uses the parsed createdAt
                                          │            field, not the filename
                                          └─ DESCENDING (newest first) for the UI
       │
       └─ subtle: this sorts on the createdAt STRING inside the record, while
          the CLI sorts on the FILENAME. Both rely on ISO-8601 being
          lexicographically chronological. They agree today because the
          filename is derived from createdAt (vite.config.ts:376) — but they
          are two separate "indexes" that could drift if naming changes.
```

**The degenerate point-lookup** — `fixture-provider.ts:11-16`:

```
  async complete(request) {
    this.requests.push(request);
    const response = this.responses[this.index];  ← O(1) lookup by integer offset
    this.index += 1;                               ← cursor advances; sequential
    if (!response) throw new Error(`fixture model exhausted ...`);
    return response;
  }
       │
       └─ this is a positional index over an in-memory array — the simplest
          possible "index." It's how deterministic replay finds the next
          response (file 08), not how on-disk artifacts are found.
```

**The vector "index" = a full scan** — `packages/retrieval/src/in-memory-vector-store.ts:25-33`:

```
  async search(vector, k) {
    this.assertDimension(vector, 'query vector');  ← integrity guard: a wrong-length
                                                      query throws (ranking would be
                                                      garbage otherwise)
    const hits = [];
    for (const chunk of this.chunks.values()) {    ← SCAN: touch EVERY chunk —
      hits.push({ id: chunk.id,                       no index narrows it, O(N)
        score: cosineSimilarity(vector, chunk.vector),← O(d) per chunk → O(N·d) total
        meta: chunk.meta });
    }
    hits.sort((a, b) => b.score - a.score);        ← ORDER BY similarity DESC, O(N log N)
    return hits.slice(0, Math.max(0, k));          ← LIMIT k
  }
       │
       └─ the Map<id> buys O(1) UPSERT dedup, but read ignores its keys and
          scans all values. This is the exact query an ANN index (HNSW) exists
          to make sub-linear — buffr's PgVectorStore does, behind this same
          contract. Here it's a deliberate full scan: correct while N is small.
```

---

## Elaborate

Encoding the sort key into the object's name is an old, good trick — it's
why log files are named with dates and why S3 keys are designed with sortable
prefixes. It gives you an index with zero maintenance cost because the write
path names the file and the read path sorts names. The price is that you get
*one* ordering, fixed at write time, and any other query degrades to a scan.
Real engines pay write-time cost to maintain B-trees precisely so they can
offer many orderings and point lookups. AptKit chose zero index maintenance
and one ordering, which is correct while N is small and time-ordering is the
only query. The trigger to add a real index: you find yourself parsing every
artifact to answer "which runs match attribute X," and N is no longer small.

The repo now holds *two* "index" stories at once, and the contrast is the
lesson. On disk: one ordering encoded into a filename, everything else a scan.
In memory: the new `InMemoryVectorStore` is a similarity store whose "index" is
a linear cosine scan — deliberately no ANN structure, because at a few hundred
chunks a scan beats the overhead of building and walking an HNSW graph. The
genuine ANN version of the *same* `VectorStore` contract ships in the **buffr**
repo: `buffr/sql/001_agents_schema.sql:28-29` declares
`create index ... using hnsw (embedding vector_cosine_ops)` and
`buffr/src/pg-vector-store.ts` queries it with pgvector. So aptkit teaches the
naive scan and the contract; buffr supplies the real index behind that contract.
That boundary is the whole adaptability argument: the pipeline code never names
a store, so swapping the scan for HNSW is a one-line wiring change and zero
pipeline change. The trigger to make that swap is corpus size — the same
"queries you actually run × N grew large" rule, applied to similarity search
instead of attribute lookup.

---

## Interview defense

**Q: "How do you look up a stored run, and what happens when you need to
query by something other than time?"**

> Time is free — filenames start with an ISO timestamp, so `.sort()` on
> filenames is a chronological index with zero maintenance. Anything else is a
> full scan: to find runs by `capabilityId` I read and parse every file. The
> fragile part people miss is that the "index" is a *string* sort that only
> equals a *date* sort because ISO-8601 is zero-padded — change the filename
> format and the order silently breaks with no error.

```
  filenames:  2026-06-18T16-45-...  ┐  string sort == time sort
              2026-06-18T19-29-...  ┘  ONLY while ISO-prefixed & zero-padded
```

**Anchor:** "The index is `.sort()` at `replay-runner.ts:43` — and it's
load-bearing on the filename format."

---

## Validate

1. **Reconstruct:** Draw a B-tree point lookup, then draw AptKit's filename
   sort, and label which queries each makes cheap.
2. **Explain:** Why do `replay-runner.ts:43` and `vite.config.ts:983` agree on
   ordering today, and what would make them disagree?
3. **Apply:** You add 10,000 artifacts and need "all runs for provider=openai"
   on every page load. Describe the current cost and the index you'd add.
4. **Defend:** Argue why one filename-encoded index is the right amount of
   indexing for AptKit now, and name the trigger to add a secondary index.

---

## See also

- `02-records-pages-and-storage-layout.md` — why a scan reads the whole record
- `04-query-planning-and-execution.md` — the scan-and-filter "plan", the N+1,
  and the cosine top-k scan as a query execution path
- `08-replication-and-read-consistency.md` — the in-memory cursor as a lookup
- `09-database-systems-red-flags-audit.md` — the vector store's no-durability
  / linear-scan risk, ranked
- `study-data-modeling` → the `createdAt`/`capabilityId` fields the index uses,
  and the `VectorChunk` shape
