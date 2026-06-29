# Query Planning and Execution

**Industry name:** query planner / execution plan / N+1 · *Industry standard*

## Zoom out — the queries the engine actually runs

buffr issues a small, fixed set of SQL. No ORM, no query builder — raw
parameterized `pg` calls. Here's every query in the system and where it lives:

```
  Zoom out — buffr's entire query surface

  ┌─ Application (buffr) ──────────────────────────────────────┐
  │  index-cmd ─► INSERT documents      (runtime.ts:11)         │
  │  index-cmd ─► INSERT chunks ×N       (pg-vector-store:47)   │
  │  session   ─► SELECT ... order by <=> (pg-vector-store:70)  │ ← we are here
  │  session   ─► INSERT messages        (supabase-trace-sink)  │
  │  session   ─► INSERT conversations   (supabase-trace-sink:5)│
  └───────────────────────────┬────────────────────────────────┘
                              │ pg pool → Supabase
  ┌─ Planner + executor (Postgres) ──────▼─────────────────────┐
  │  parse → plan (pick indexes/scans) → execute → rows        │
  └────────────────────────────────────────────────────────────┘
```

## Zoom in — what this file covers

The question: **for buffr's hot query — the vector search — what plan does
the engine pick, and where does the N+1 trap hide?** The hot path is one
statement; the trap is elsewhere, in how chunks get written one row at a time.

## Structure pass

**Layers.** SQL text (what buffr writes) → plan (what the planner decides) →
execution (scans, index probes, sort, limit).

**Axis — trace "how much work per query?" (the cost axis).**

```
  One question across the queries: "what does it cost to run?"

  SELECT order by <=> limit k   → HNSW index scan + limit   cheap, hot path
  INSERT chunks (one row)       → heap write + HNSW insert  cheap each...
    ×N in a loop                → ...but N round-trips       ← N+1 shape
  INSERT documents / messages   → single-row write          cheap

  the cost flips at the chunk INSERT loop: each call is cheap, but
  the loop turns one logical operation into N sequential statements
```

**Seam.** The seam is **one statement vs a loop of statements**. The search
is a single planned query; the chunk write is a `for` loop issuing N inserts
on one connection (`pg-vector-store.ts:43`). That loop is where execution
cost stops being "what the planner does" and becomes "how many round-trips
the app makes."

## How it works

### Move 1 — the mental model

A query planner is a cost-based optimizer: it looks at your SQL, the
available indexes, and table statistics, then picks the cheapest physical
plan. You already reason this way when you choose `.find()` vs a `Map`
lookup — the planner just does it automatically, per query, using stats.

```
  The hot query's plan (the vector search)

  SELECT id, content, ..., 1 - (embedding <=> $1) as score
  FROM agents.chunks
  WHERE app_id = $2
  ORDER BY embedding <=> $1
  LIMIT $3
        │
        ▼  planner picks:
  ┌─────────────────────────────────────────────┐
  │  HNSW index scan on chunks_embedding_hnsw    │  ← order-by-distance
  │   walk graph, emit nearest first             │     drives index choice
  │  → filter app_id = $2                         │  ← B-tree or in-scan
  │  → LIMIT k stops the scan early               │  ← key: don't sort all
  └─────────────────────────────────────────────┘
```

### Move 2 — the moving parts

**The ORDER BY drives the plan.** The line that makes this query fast is
`order by embedding <=> $1::vector` paired with `limit $3`
(`pg-vector-store.ts:75-76`). pgvector teaches the planner that the HNSW
index can *produce rows in distance order* — so instead of computing every
chunk's distance and sorting (an O(n log n) sort over the whole table), the
executor walks the HNSW graph and emits the nearest first, stopping at
`limit k`. Drop the `limit` and you'd lose that early stop. Drop the
`order by <=>` and the HNSW index becomes unusable for this query.

```
  Why limit + order-by-distance is the whole game

  WITHOUT index-ordered scan:        WITH HNSW index scan:
  ─────────────────────────          ────────────────────
  compute distance for ALL n rows    walk graph greedily
  sort all n by distance             emit nearest-first
  take top k                         stop after k
  → O(n) distance + O(n log n) sort  → sublinear, bounded by ef_search
```

**The N+1 write — the trap.** Here's the chunk write loop:

```ts
// buffr/src/pg-vector-store.ts:40-64 (condensed)
await client.query('begin');
for (const c of chunks) {                    // ← one query per chunk
  await client.query(
    `insert into agents.chunks (...) values ($1,...,$6::vector,...)
     on conflict (id) do update set ...`,
    [c.id, ...],
  );
}
await client.query('commit');
```

This is the **N+1 pattern**: one logical operation ("store this document's
chunks") executed as N separate `INSERT` statements, each a round-trip to
Postgres. It's wrapped in one transaction so it's *atomic* (good — see `05`),
but it's not *batched*. The consequence: indexing a doc that chunks into 40
pieces is 40 sequential `await client.query` calls on one connection. At a
laptop's ingest rate, invisible. The fix when it bites: a multi-row
`INSERT ... values ($1,...),($9,...),...` or `COPY`, collapsing N round-trips
into one. buffr hasn't needed it. Naming it honestly: this is the most
likely query-execution bottleneck in the codebase if ingest ever scales.

**No EXPLAIN, ever.** buffr never runs `EXPLAIN` or `EXPLAIN ANALYZE` on any
query (`not yet exercised`). So every claim about the plan above is read off
*how pgvector queries are supposed to plan*, not off an observed plan. The
honest gap: nobody has confirmed the HNSW index is actually chosen vs a
fallback sequential scan. The way you'd check is one `EXPLAIN ANALYZE` on the
search query — if you see `Seq Scan on chunks` instead of an index scan, the
opclass or operator mismatched and search silently degraded.

**The `app_id` filter and join behavior.** The search filters
`where app_id = $2` (`pg-vector-store.ts:74`). There are **no JOINs anywhere
in buffr** — the dropped FK (`05`) and the flat `meta` rebuild mean search
reads only `chunks`, and citations are reconstructed from columns on that one
table (`pg-vector-store.ts:80-84`), not joined from `documents`. So the
classic "join explosion" failure mode doesn't exist here. The cost is paid
elsewhere: `documents` and `chunks` can drift out of sync because nothing
joins or constrains them.

### Move 3 — the principle

The query that matters is the one on the hot path, and you make it fast by
giving the planner an index that produces rows in the order you ask for them
— here, `order by <=> ... limit k` lets HNSW emit nearest-first and stop
early. The query that *bites you later* is rarely the hot one; it's the
innocent-looking write loop that's secretly N+1. Find both with one
`EXPLAIN ANALYZE` and one count of "how many statements per logical
operation."

## Primary diagram

```
  Query execution recap — buffr

  HOT READ (vector search)              WRITE (index a document)
  ────────────────────────              ────────────────────────
  one SELECT                            INSERT documents  ── TXN A
  order by <=> limit k                  then:
        │                                begin
        ▼                                for chunk in chunks:   ← N+1
  HNSW index scan (nearest-first)          INSERT chunk $i      one round
  → app_id filter                        commit                 trip each
  → stop at k                                  └─ TXN B (atomic, not batched)
        │
        ▼ rows {id, score, content, meta}
  meta rebuilt for citations (no JOIN to documents)

  EXPLAIN: never run → plans are inferred, not verified
```

## Elaborate

The reason buffr gets away with a raw `pg` layer and zero plan tuning is
scale: a single user's indexed markdown is small enough that even a
worst-case sequential scan would be sub-second. That's the same bet AdvntrCue
makes with Drizzle over one Postgres. The discipline you'd add the moment
this serves real traffic is unglamorous and high-leverage: turn on
`pg_stat_statements`, run `EXPLAIN ANALYZE` on the top queries, and batch the
chunk inserts. None of that changes the `VectorStore` contract — it's all
inside the adapter, which is exactly why the contract was worth drawing.

## Interview defense

**Q: Walk me through your hottest query's plan.**
The vector search: `order by embedding <=> $1 limit k`. The order-by-distance
lets the planner use the HNSW index to emit rows nearest-first, and the
`limit` stops the scan early — so it's a bounded index walk, not a full-table
distance computation plus sort.

```
  order by <=> + limit  →  HNSW index scan, stop at k
```

**Q: Any N+1 in your write path?**
Yes — chunk inserts loop one `INSERT` per chunk inside the upsert
transaction (`pg-vector-store.ts:43`). It's atomic but not batched. Invisible
at laptop scale; the fix is a multi-row insert or `COPY`. And I'll be honest:
I've never run `EXPLAIN ANALYZE`, so the read plan is inferred, not verified.

**Anchor:** "The hot read is one index-ordered, limit-bounded statement; the
hidden cost is an N+1 write loop and the fact I've never actually EXPLAINed
either."

## See also

- `03-btree-hash-and-secondary-indexes.md` — the HNSW index this query depends on.
- `05-transactions-isolation-and-anomalies.md` — why the N+1 loop is one transaction.
- `09-database-systems-red-flags-audit.md` — no-EXPLAIN and N+1 as flagged risks.
