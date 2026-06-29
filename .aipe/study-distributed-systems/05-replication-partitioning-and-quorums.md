# 05 — Replication, Partitioning, and Quorums

**Industry names:** replication (leader/follower) · partitioning/sharding · partition key · quorum (R + W > N) · failover. **Type:** Industry standard.

## Zoom out, then zoom in

Verdict up front: replication, sharding, and quorums are **`not yet exercised`** in this repo. One Postgres, no replica, no shard, no quorum. What the repo *does* have are two things that look like distant cousins of these — a tenant column (`app_id`) and a logical tag (`kind:'memory'`) — and the lesson is precisely why those are *not* partition keys.

```
  Zoom out — what exists vs what the canon would add

  ┌─ App ──────────────────────────────────────────────────────────┐
  │  PgVectorStore.search / .upsert  — one connection target        │
  └──────────────────────────────────┬───────────────────────────────┘
                                     │ pg.Pool → ONE primary
  ┌─ Storage (single node) ───────────▼──────────────────────────────┐
  │  agents.chunks   app_id='laptop'   kind:'memory' | (document)     │ ← we are here
  │  └─ app_id = TENANT column (filter)  ┄┄ NOT a shard key           │
  │  └─ kind  = LOGICAL partition (filter) ┄┄ NOT a physical shard    │
  │                                                                   │
  │  ┄┄ not yet exercised: replicas, shards across nodes, quorum ┄┄  │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: **replication** is keeping copies of the same data on multiple nodes (for availability and read scale). **Partitioning/sharding** is splitting *different* data across nodes by a key (for write scale and dataset size). **Quorum** is the rule for how many copies must agree on a read or write to call it durable. The repo has one node, so all three are absent — but it has the *data shapes* that would become partition keys, and recognizing the difference between "a column I filter on" and "a key that decides which node holds the row" is the whole point.

## Structure pass — layers, one axis, the seams

**Layers:** logical (the `app_id` / `kind` tags in the row) → physical (which node holds the row → today: always the one primary).

**The one axis: *what decides where a row physically lives?*** Trace it:

```
  "what decides which NODE stores this row?"  — traced down

  ┌──────────────────────────────────────────────┐
  │ app_id = 'laptop'      decides nothing about   │  ← a FILTER, not a router
  │                        location; all on 1 node │
  └────────────────────┬──────────────────────────┘
       ┌───────────────▼──────────────────────────┐
       │ kind = 'memory'|'document'  decides nothing│  ← a logical partition
       │                 about location; 1 node     │     (a WHERE clause)
       └───────────────┬──────────────────────────┘
             ┌─────────▼──────────────────────────┐
             │ a real shard key (not yet exercised)│  ← WOULD decide the node
             │  hash(app_id) % N → node            │
             └─────────────────────────────────────┘
```

Every existing tag answers "decides nothing about location." Only the third row — `not yet exercised` — would flip that answer. **A partition key is one whose value routes you to a node; a filter column just narrows a scan on the node you already chose.** The repo has filter columns dressed in partition-key vocabulary.

**The seam:** there isn't a replication or sharding seam yet, because there's only one node. The closest real seam is the `kind` tag, which is a *logical* partition over a *shared physical collection* — worth walking because it's the genuine version of "partitioning" the repo exercises.

## How it works

### Move 1 — the mental model

You already know filtering from a `WHERE` clause and `.filter()` in JS — narrowing a set you already have. A *partition key* is the opposite direction: it's the value you compute *before* you have the data, to decide *where to go look*. Replication you know from git: `origin` and your local clone are two copies of the same history that can diverge and must be reconciled.

```
  Partition vs filter — the kernel difference

  FILTER (what the repo has):
    have all rows on node N  →  WHERE app_id='laptop'  →  subset

  PARTITION KEY (not yet exercised):
    have a key K  →  route(K) → node N  →  THEN read only node N
    ───────────────────────────────────────────────────────────
  the partition key runs BEFORE you touch data; the filter runs after
```

The kernel of partitioning: **a deterministic routing function from key to node.** No routing function, no partitioning — you just have a column.

### Move 2 — walking what's actually there

**Part 1 — `app_id`: a tenant column, not a shard key.** The schema stamps every row with `app_id` (`001_agents_schema.sql`):

```sql
-- agents.documents and agents.chunks both carry:
app_id text not null default 'laptop',
```

In a multi-tenant system at scale, `app_id` would be the natural shard key — hash it, route each tenant's data to a node. Here it's a *filter*: every row has `app_id='laptop'`, all on one node, and queries narrow by it. It's doing tenancy-isolation duty (so a future second tenant's rows are separable) without doing any routing duty. That's the right call for a single-laptop runtime — but calling it a "shard key" would be wrong, and the distinction is the lesson: same column, completely different job depending on whether a routing function consumes it.

**Part 2 — the `kind` tag: a real logical partition.** This is the genuine partitioning the repo does. Memory and documents share *one* vector collection; they're separated by a tag, not a table (`context.md`, `packages/memory`):

```
  Logical partition over a shared physical collection

  agents.chunks (ONE physical collection)
  ┌────────────────────────────────────────────────────────┐
  │ id "guide.md#0"         meta.kind = (document)           │
  │ id "memory:conv1:0"     meta.kind = "memory"             │
  │ id "memory:conv1:1"     meta.kind = "memory"             │
  └────────────────────────────────────────────────────────┘
        recall(query) over-fetches, then filters by kind='memory'
        search_knowledge_base over-fetches, then filters documents
```

The `recall` path embeds the query, runs the vector search over the *whole* collection, then filters to `kind:'memory'` client-side — because the `VectorStore` contract has no metadata predicate (`context.md`). This is exactly the at-application-level partitioning you do when the storage layer can't partition for you: **over-fetch, then filter.** It costs you — you retrieve rows you'll discard, so top-k has to be inflated to survive the filter (the `minTopK` floor in `search_knowledge_base`). That's the real, citable partitioning tradeoff in the repo: a logical partition with no index support pays an over-fetch tax.

**Part 3 — replication and failover — `not yet exercised`, with the attach point.** There's one Postgres primary. No follower, no `replica`, no failover. Where it attaches: buffr's `createPool` (`db.ts`) points at a single `connectionString`. To replicate you'd add a follower and route reads to it — and the instant you do, you inherit the staleness window from `04` (the follower lags) and you need a failover rule for "primary died, promote the follower." aptkit's contracts don't care — `PgVectorStore` runs SQL against whatever pool it's handed — but the *operational* machinery (who promotes, how clients rediscover the new primary) is entirely absent.

**Part 4 — quorums — `not yet exercised`, with the attach point.** A quorum is the rule **R + W > N**: with N copies, a write must land on W of them and a read must consult R of them, and if R + W > N the read is guaranteed to see the latest write. The repo has N=1, so R=W=1 trivially and quorums are meaningless. The attach point is the same as replication: the day you have N>1 copies of the chunk corpus, you choose R and W to trade latency against consistency. The friendly fact carried over from `03`/`04`: the chunk upsert is idempotent and convergent, so a quorum system replicating it would heal naturally — the data model is already quorum-friendly even though the topology isn't there.

### Move 3 — the principle

Partitioning and replication answer different questions and people conflate them constantly. **Replication = same data, many copies (availability + read scale). Partitioning = different data, split by key (write scale + size).** A column you filter on is neither until a routing function or a copy-set consumes it. The repo teaches the distinction cleanly precisely because it has the *shapes* (`app_id`, `kind`) without the *machinery* — so you can see that the machinery, not the column, is what makes it distributed.

## Primary diagram

What exists, what each tag actually does, and where the canon would attach.

```
  Replication / partitioning map — exercised vs not yet exercised

  ┌─ Logical layer (in the row) ───────────────────────────────────┐
  │  app_id='laptop'   → tenant filter   (WHERE), not a router       │
  │  kind='memory'|doc → logical partition over ONE collection;      │
  │                       over-fetch then filter (recall, minTopK)   │
  └──────────────────────────────────┬──────────────────────────────┘
                                     │ all rows → one place
  ┌─ Physical layer ────────────────── ▼─────────────────────────────┐
  │  ONE Postgres primary  (buffr createPool → single connectionString)│
  │                                                                   │
  │  ┄┄ NOT YET EXERCISED ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  │
  │  replicas (read scale, failover) · shards by hash(key)%N          │
  │  · quorum R+W>N  → but the idempotent upsert is convergence-ready │
  └────────────────────────────────────────────────────────────────────┘
```

## Elaborate

The leader/follower replication model (one writer, many read replicas) is the workhorse of every relational stack, including Supabase/Postgres — it's available, just not used here. Sharding by a hash of the key (consistent hashing, to minimize reshuffling when nodes change) is the write-scale answer when one node can't hold the dataset. Quorum systems (Dynamo-style, R + W > N) blur the line by replicating *and* letting you tune consistency per call.

The `kind`-tag over-fetch is a small, honest instance of a real pattern: when your store can't partition or filter at the index, you partition in the application and pay a retrieval tax. The same shape appears in multi-tenant search, in feature-flagged data, and in soft-deleted rows — anywhere a logical subset shares physical storage. The fix at scale is a partial index or a separate physical partition; the repo hasn't needed it because the corpus is small.

## Interview defense

**Q: "Is `app_id` your shard key?"**
"No — it's a tenant filter. Every row is `app_id='laptop'` on one node; queries narrow by it. It'd be the *natural* shard key if this went multi-node — hash it, route per tenant — but nothing routes on it today, so it's a `WHERE` clause, not a router. The distinction is whether a function consumes the value to pick a node, and here nothing does."

```
  app_id: WHERE app_id='laptop'  (filter)   ≠   route(app_id)→node  (shard)
```

Anchor: *a partition key routes before you touch data; this column only filters after.*

**Q: "Does the repo partition anything?"**
"Yes, logically: memory and documents share one vector collection separated by a `kind` tag. Recall over-fetches the whole collection then filters to `kind:'memory'` client-side, because the `VectorStore` contract has no metadata predicate — that's why there's a `minTopK` floor. It's real application-level partitioning with a real cost: the over-fetch tax. Physical replication and quorums are `not yet exercised` — one primary, N=1."

Anchor: *the `kind` tag is a logical partition paying an over-fetch tax; physical sharding/quorum is N=1, not exercised.*

## See also

- `04-consistency-models-and-staleness.md` — replica lag is the staleness window a read replica would open
- `03-idempotency-deduplication-and-delivery-semantics.md` — why the convergent upsert makes the corpus quorum-friendly
- `07-clocks-coordination-and-leadership.md` — failover needs leader election, also not yet exercised
- `study-database-systems` — Postgres replication internals, partial indexes
- `study-data-modeling` — the `app_id` tenant column and `kind`-tagged shared collection
