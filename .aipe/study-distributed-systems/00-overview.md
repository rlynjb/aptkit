# Study — Distributed Systems (applied to aptkit + buffr)

> The question this guide answers: **what stays correct when coordination crosses a boundary and any participant can be slow, duplicated, stale, or unavailable?**

## Verdict first

aptkit is a single-process TypeScript library. Most of the distributed-systems canon — consensus, replication, quorums, leader election, partitioning, exactly-once delivery — is **`not yet exercised`**. Saying that plainly is the whole point of this guide: you have not built distributed systems at scale (`me.md`), and pretending the repo does would teach you nothing transferable.

But "single-process" is not "single-node." The moment a call leaves the process, you are in distributed-systems territory whether you asked to be or not. aptkit + buffr cross a boundary in exactly **four** places, and every one of them has a real, citable failure mode:

```
  The four real coordination boundaries (everything else is in-process)

  ┌─ aptkit (single process, in-memory) ───────────────────────────┐
  │                                                                 │
  │   runAgentLoop  ──►  FallbackModelProvider  ──►  GemmaProvider  │
  │                          (seam 2)                    │          │
  └──────────────────────────────────────────────────────┼─────────┘
                                                          │ HTTP, no timeout
                                            seam 1 ───────▼─────────────┐
                                          ┌─ Ollama daemon :11434 ──────┐│
                                          │  separate service, no TLS   ││
                                          └─────────────────────────────┘│
                                                                         │
  ┌─ buffr (the "body", consumes aptkit from npm) ───────────────────────┘
  │                                                                       │
  │   indexDocumentRow  ──►  documents insert  ──►  pipeline.index()      │
  │       (seam 4: dual write)        │                   │               │
  │                                   │ pg.Pool           │ PgVectorStore │
  │   SupabaseTraceSink ──────────────┼───────────────────┼───────────┐   │
  └───────────────────────────────────┼───────────────────┼───────────┼───┘
                                       │ TCP :5432         │           │
                          seam 3 ──────▼───────────────────▼───────────▼──┐
                        ┌─ Supabase Postgres (network DB, pgvector) ───────┐│
                        │  agents.documents · agents.chunks · agents.messages│
                        └────────────────────────────────────────────────┘│
                                                                            │
```

That diagram is the map. Four seams, drawn where an axis (control / failure / state / guarantees) flips from one side to the other. The rest of the canon attaches to those seams as *what would have to change* when the repo grows — taught honestly as `not yet exercised`, with the attach point named.

## The four real seams

| # | Seam | What it is | Real file | The failure that bites |
|---|------|-----------|-----------|------------------------|
| 1 | **app ↔ Ollama** | a separate service reached over local HTTP | `gemma-provider.ts:201` | daemon down or wedged, and **no per-call timeout** — the `fetch` waits forever |
| 2 | **the failover chain** (`FallbackModelProvider`) | ordered providers tried in sequence | `fallback-provider.ts:50` | advances **only on a thrown error** — a slow provider that never throws defeats the chain |
| 3 | **app ↔ Supabase Postgres** | a network database behind a connection pool | `pg-vector-store.ts:40` | per-document chunk upsert is atomic via `on conflict (id)`; the trace sink persists an emit-timestamp so `ORDER BY` recovers order from racing inserts |
| 4 | **the dual write** | `documents` row, then `chunks` in a *separate* transaction | `runtime.ts:11` + `:17` | an embed failure after the doc insert **orphans the document** — a latent saga/outbox |

## Ranked findings (by consequence)

1. **No deadline anywhere on the Ollama path** (`gemma-provider.ts:201`, `fallback-provider.ts:50`). The single most consequential gap. A wedged daemon — not crashed, just hung — blocks the `fetch`, which blocks the provider, which blocks the failover chain (it advances only on a *thrown* error), which blocks `runAgentLoop`. One slow node freezes the whole call. This is the textbook reason distributed systems use deadlines, and the repo has none. → `02-partial-failure-timeouts-and-retries.md`

2. **The dual write is a latent saga with no compensation** (`runtime.ts:5-18`). `indexDocumentRow` writes the `documents` row on the pool (auto-commit), then calls `pipeline.index()` which opens its *own* transaction for chunks. The two are not atomic, and `agents.chunks` deliberately has **no foreign key** to `documents` (`001_agents_schema.sql:27`). An embed failure between the two leaves a document with zero chunks and nothing to detect or repair it. → `08-sagas-outbox-and-cross-boundary-workflows.md`

3. **Idempotency is real but partial** (`pg-vector-store.ts:47`). The chunk upsert is genuinely idempotent — `on conflict (id) do update` means re-running ingestion converges. But the `documents` write is *also* an idempotent upsert, while the failover chain and `runAgentLoop` retries are **not** idempotency-aware: a retried model call is a fresh call, billed again, with no dedup key. → `03-idempotency-deduplication-and-delivery-semantics.md`

## Reading order

```
  00-overview                  ← you are here: the map + the verdict
   │
   ├─ 01-distributed-system-map        nodes, boundaries, ownership, failure domains
   ├─ 02-partial-failure-timeouts-…    the #1 finding: no deadlines on the Ollama path
   ├─ 03-idempotency-dedup-…           the upsert that converges; the retry that doesn't
   ├─ 04-consistency-models-…          stale reads, read-your-writes across the DB seam
   ├─ 05-replication-partitioning-…    mostly not yet exercised; the kind tag as a soft partition
   ├─ 06-queues-streams-ordering-…     NDJSON trace stream; ordering recovered by timestamp
   ├─ 07-clocks-coordination-…         ISO timestamps, no leader, no lease — why that's fine here
   ├─ 08-sagas-outbox-…                the #2 finding: the orphaning dual write
   └─ 09-distributed-systems-red-flags-audit   ranked risks with evidence
```

Read 02 and 08 first if you read nothing else — they carry the two load-bearing findings. Everything else either grounds those two or honestly marks where the canon doesn't yet apply.

## Repo-grounded vs `not yet exercised`

**Grounded in real files (you can open these and see the seam):**
- partial failure across a service boundary (Ollama HTTP), and the *absence* of a timeout
- a failover chain that records attempts and advances on thrown errors
- idempotent upsert via `on conflict (id)`
- per-document transaction atomicity (chunks) vs non-atomic dual write (doc + chunks)
- ordering recovered from an emit-timestamp under racing inserts (`SupabaseTraceSink`)
- a discriminated trace-event stream serialized as NDJSON
- a logical partition (the `kind:'memory'` tag over a shared vector collection)

**`not yet exercised` (taught with the attach point named, not invented):**
- consensus / leader election / leases — single writer, no quorum (→ 07)
- replication / quorums / failover of a replica — one Postgres, no replica (→ 05)
- partitioning / shard keys — `app_id` is a tenant column, not a shard key (→ 05)
- distributed transactions / 2PC — the dual write is the closest thing, and it's a *missing* saga (→ 08)
- idempotency keys on model calls — upserts have them, retries don't (→ 03)
- backoff / jitter — no retry loop on the network paths to back off (→ 02)
- circuit breakers — failover records failures but never trips open (→ 02)
- exactly-once delivery — at-most-once on the model call, at-least-once-ish on ingest (→ 03)
- queue infrastructure, consumer groups, poison-message handling — no broker (→ 06)

## Cross-links to neighboring guides

This guide owns **correctness across a coordination boundary**. It does not re-teach:
- **`study-networking`** — the transport itself: DNS, TCP, TLS, HTTP semantics, connection pooling mechanics, socket timeouts.
- **`study-database-systems`** — datastore-*local* consistency: MVCC, isolation levels, the storage engine behind `on conflict`, index structure of pgvector.
- **`study-system-design`** — the architectural shape and scale tradeoffs of the whole system.
- **`study-debugging-observability`** — how you'd *see* a wedged daemon or an orphaned doc: the trace events, the logs, the incident.

When a mechanism belongs to one of those, this guide cross-links instead of duplicating.
