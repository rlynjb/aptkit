# Study — Distributed Systems (applied to aptkit + buffr)

## The honest verdict, up front

aptkit is a **single-process TypeScript monorepo.** Most of the distributed-systems
canon — consensus, replication, sharding, leader election, distributed
transactions, exactly-once delivery — is `not yet exercised` here. There is no
cluster, no quorum, no second replica, no message broker. Saying otherwise would
be inventing infrastructure you didn't build.

But "single-process" is not "no coordination." The moment your code calls
`fetch()` to Ollama, or buffr opens a `pg.Pool` to a Supabase Postgres across the
network, you have crossed a boundary where the other side can be **slow,
unavailable, wedged, or racing your other writes** — and your correctness now
depends on what happens when it is. That is the entire subject of distributed
systems, in miniature. This guide teaches the full concept set, then anchors each
one to the *real* coordination seam in your repos where it lives — or marks it
`not yet exercised` and tells you exactly where it would attach if aptkit scaled.

```
  The whole coordinated system — what actually crosses a boundary

  ┌─ Process: aptkit agent (single Node process) ──────────────────────┐
  │                                                                     │
  │   runAgentLoop ──► ModelProvider.complete()                         │
  │       │                   │                                         │
  │       │            ┌──────┴───────┐                                 │
  │       │            ▼              ▼                                  │
  │       │     FallbackModelProvider   ContextWindowGuardedProvider     │
  │       │     (try A, then B,         (reject before the call         │
  │       │      record attempts)        if input too big)              │
  │       │            │                                                 │
  │  emit(CapabilityEvent)  ── the in-process event log (the trace) ──┐  │
  └───────┼─────────────┼────────────────────────────────────────────┼──┘
          │             │ HTTP (no per-call timeout)                  │
          │             ▼                                             │
  ┌───── Network boundary ─────┐                                      │
          │     ┌─ Ollama daemon :11434 ─┐  ← separate process/service│
          │     │  POST /api/chat        │    partial failure lives here
          │     │  POST /api/embed       │                            │
          │     └────────────────────────┘                           │
          │                                                          │
  ┌─ Process: buffr runtime ───────────────────────────────────────┼──┐
  │   ChatSession.ask() ──► PgVectorStore / SupabaseTraceSink       │  │
  │       │                       │ pg.Pool (TCP)                   ▼  │
  │       │              ┌────────┴────────┐         SupabaseTraceSink  │
  │       │              ▼                 ▼         drains the trace   │
  └───────┼──────── Network boundary ──────┼──── into agents.messages  │
          │     ┌─ Supabase Postgres ──────▼─┐                         │
          │     │  agents.{documents,chunks,  │  ← network DB:          │
          │     │   conversations,messages}   │    pool, transactions,  │
          │     │  + pgvector                 │    racing inserts       │
          │     └─────────────────────────────┘                        │
```

## The real coordination seams (everything else is curriculum)

There are exactly **four** places in these two repos where coordination crosses a
boundary and partial failure is real. Learn these cold; they are your whole
distributed-systems portfolio today.

```
  Seam                          where it lives                       what can break
  ────────────────────────────  ───────────────────────────────────  ──────────────────────────
  1. app ↔ Ollama (HTTP)        gemma-provider.ts:201-215             daemon down / wedged;
                                ollama-embedding-provider.ts:60-75    NO per-call timeout
  2. provider fallback chain    fallback-provider.ts:47-89            one provider fails →
                                                                      try next, record attempt
  3. buffr ↔ Supabase Postgres  buffr/pg-vector-store.ts:38-65        pool exhaustion; per-doc
                                buffr/supabase-trace-sink.ts:49-94    transaction; racing inserts
  4. the trace as an event log  runtime/events.ts:1-32                ordering survives the race
                                runtime/run-agent-loop.ts:111-187     only via event timestamp
```

## Ranked findings — read these first

1. **The Ollama HTTP calls have no per-call timeout (highest consequence).**
   `gemma-provider.ts:201-215` and `ollama-embedding-provider.ts:60-75` call
   `fetch()` with only an optional `AbortSignal` — no `AbortSignal.timeout()`, no
   deadline. If the Ollama daemon wedges (model still loading, swap thrashing, a
   hung GPU), `complete()` hangs until the caller aborts or the socket dies. In
   the fallback chain this is worse: a *slow* provider never throws, so the chain
   never advances to the next provider. Timeouts convert "infinitely slow" into
   "failed fast," which is the only way the fallback logic and `maxTurns` budget
   can actually protect you. → see `02-partial-failure-timeouts-and-retries.md`.

2. **The trace's monotonic ordering is reconstructed from event timestamps, not
   insert order — and that's the one place you got distributed-systems-correct.**
   `SupabaseTraceSink.emit()` is synchronous (aptkit's contract), but the Postgres
   writes are queued promises drained by `flush()` via `Promise.all`
   (`buffr/supabase-trace-sink.ts:49-94`). Those inserts race. The fix that makes
   replay deterministic: the event's ISO `timestamp` is written into
   `created_at`, so replay orders by *emit time*, not by *which insert won the
   race*. This is logical-clock thinking applied to a real racing-writes problem.
   → see `07-clocks-coordination-and-leadership.md` and
   `06-queues-streams-ordering-and-backpressure.md`.

3. **`indexDocumentRow` is a dual write with no atomicity across the two systems
   (a latent saga seam).** `buffr/runtime.ts` writes the `agents.documents` row in
   one query, then calls `pipeline.index()` which embeds (Ollama) and upserts
   chunks in a *separate* transaction. If the embed step throws after the
   documents row is committed, you have a document with no chunks — a partial
   commit across two operations. Today the blast radius is one local doc, so it's
   acceptable; the moment indexing moves async or to a worker, this becomes a
   textbook outbox/saga problem. → see `08-sagas-outbox-and-cross-boundary-workflows.md`.

## Reading order

```
  01  distributed-system-map ........... the coordination map (start here)
  02  partial-failure-timeouts-retries .. the most consequential gap (finding #1)
  03  idempotency-dedup-delivery ........ upsert-by-id is your one idempotency win
  04  consistency-models-staleness ...... stale recall, read-your-writes
  05  replication-partitioning-quorums .. mostly `not yet exercised`
  06  queues-streams-ordering ........... the trace sink's pending-queue
  07  clocks-coordination-leadership .... finding #2, timestamp-ordered replay
  08  sagas-outbox-cross-boundary ....... finding #3, the dual-write seam
  09  red-flags-audit ................... ranked risks, evidence per verdict
```

## What is `not yet exercised` (named honestly)

| Concept | Status | Where it would attach if aptkit scaled |
| --- | --- | --- |
| Consensus (Raft/Paxos) | `not yet exercised` | only if multiple buffr nodes shared write authority |
| Replication / replica reads | `not yet exercised` | a Supabase read replica behind `PgVectorStore.search` |
| Partitioning / sharding | `not yet exercised` | `app_id` is *already* a partition key (logical, single-node) |
| Leader election | `not yet exercised` | a singleton indexer across multiple workers |
| Distributed transactions / 2PC | `not yet exercised` | the `indexDocumentRow` dual write (finding #3) |
| Sagas / compensation | latent, not built | same dual write, if it went async |
| Idempotency keys | partial | `upsert ... on conflict (id)` gives idempotent writes |
| Exactly-once delivery | `not yet exercised` | impossible to claim; the trace flush is at-most-once |
| Message queue / broker | `not yet exercised` | the in-process `pending[]` array is the only "queue" |
| Quorum reads/writes | `not yet exercised` | requires ≥3 replicas; there is one Postgres |

## Cross-links to neighbor guides

- **study-networking** — the transport mechanics of the Ollama HTTP calls and the
  `pg` TCP connection: DNS, connection reuse, TLS, the missing timeout at the
  socket layer. This guide owns *coordination correctness*; networking owns *the wire*.
- **study-database-systems** — the *datastore-local* consistency of Postgres: the
  `begin/commit/rollback` in `PgVectorStore.upsert`, isolation levels, pgvector's
  index. This guide owns coordination *across* the DB boundary; that one owns
  what happens *inside* it.
- **study-system-design** — the architectural shape and scale tradeoffs (why
  local-first, why a single Postgres). This guide owns what stays correct when a
  boundary is crossed.
- **study-debugging-observability** — the trace as evidence for incident
  reconstruction. This guide owns the trace's *ordering guarantees*; that one owns
  reading it to debug.
```
