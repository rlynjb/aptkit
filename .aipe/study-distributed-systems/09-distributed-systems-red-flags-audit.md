# 09 — Distributed Systems Red-Flags Audit

**Industry name:** coordination & partial-failure risk audit — *Project-specific.*

Ranked by consequence. Each finding names the evidence (`file:line`), the failure it
causes, and the move. The honest frame first: aptkit is single-process with two real
network boundaries, so this is a *short* list of *real* risks plus an explicit map of
what's `not yet exercised`. Nothing here is invented to fill a template.

## Zoom out — the risk surface

```
  Where coordination risk concentrates (ranked R1–R5)

  ┌─ aptkit process ────────────────────────────────────────────────────┐
  │  runAgentLoop (maxTurns ✓, but no per-call deadline)                 │
  │       │                                                              │
  │       ▼ complete()                                                   │
  │  FallbackModelProvider ──► fetch(:11434)  ◄── R1: NO TIMEOUT         │
  │                                              (hang defeats fallback) │
  └──────────────────────────────┬───────────────────────────────────────┘
                                 │ HTTP / TCP
  ┌─ buffr process ──────────────▼───────────────────────────────────────┐
  │  indexDocumentRow ──► R3: dual write (orphan on partial commit)       │
  │  pg.Pool ──────────► R4: no checkout timeout / unbounded wait         │
  │  SupabaseTraceSink:  R2 (fixed!) ordering ✓ | R5: no backpressure /   │
  │                      Promise.all-fails-all                            │
  └─────────────────────────────────────────────────────────────────────┘
```

## Ranked findings

### R1 — Ollama HTTP calls have no per-call timeout (HIGH)

**Evidence:** `packages/providers/gemma/src/gemma-provider.ts:201-215`,
`packages/retrieval/src/ollama-embedding-provider.ts:60-75`. Both call `fetch()` with
only an optional `AbortSignal` — no `AbortSignal.timeout()`, no deadline.

**Failure it causes:** If the Ollama daemon wedges (model loading, GPU hang, swap
thrash), `complete()` / `embed()` hangs until the caller aborts or the socket dies.
Worse, in the `FallbackModelProvider` (`fallback-provider.ts:50-88`) the loop only
advances *on a thrown error* — a hung provider never throws, so the chain never tries
the next provider. A *slow* Ollama defeats the entire point of the fallback (surviving
local-model unavailability), while a *down* Ollama (which throws `ECONNREFUSED`) is
handled correctly. Slow is the dangerous case and it's unhandled.

**The move:** Wrap each transport `fetch` in a per-call deadline —
`AbortSignal.timeout(ms)` combined with the existing caller `signal`. Turns "infinitely
slow" into "threw," which every layer above (fallback, `maxTurns`) already handles. One-
function change per transport; the plumbing is already there. → `02`.

### R2 — Trace ordering under racing inserts (FIXED — keep it that way)

**Evidence:** `buffr/src/supabase-trace-sink.ts:49-93` + `persistMessage:26-30`.

**What was right:** `emit` is sync and queues writes into `pending[]`; `flush()` drains
with `Promise.all`, so inserts race. The fix: the event's emit-time ISO `timestamp` is
written into `created_at` (`coalesce($8::timestamptz, now())`), so replay does
`ORDER BY created_at` and recovers emit order regardless of which insert wins. This is
the repo's strongest distributed-systems decision — logical position attached to the
event, not trusted to the transport.

**The watch-item:** this guarantee depends on `timestamp()` being single-source
(`events.ts:30-32`). The day a second machine emits into `agents.messages`, wall-clock
ordering breaks (clock drift) and you'd need logical clocks. Not a bug; a boundary to
remember. → `06`, `07`.

### R3 — `indexDocumentRow` dual write, no atomicity across steps (MEDIUM)

**Evidence:** `buffr/src/runtime.ts` (`indexDocumentRow`) — commits the `documents`
row, then calls `pipeline.index()` (embed via Ollama + chunk upsert) in a *separate*
transaction.

**Failure it causes:** If the embed (R1's hang/fail) throws after the documents row
commits, you get an orphan — a document with zero chunks: searchable, returns nothing.
No compensation deletes the orphan; no reconciliation re-indexes it. Acceptable today
(one local doc, synchronous caller sees the throw).

**The move:** When indexing leaves the request path, use a transactional outbox — write
the documents row and an "index me" outbox row in *one* transaction; a worker drains
the outbox, does embed+upsert, retries on failure. At-least-once + the idempotent
`on conflict (id)` upsert = effectively-once. → `08`, `03`.

### R4 — Connection pool has no checkout timeout or explicit bound (MEDIUM-LOW)

**Evidence:** `buffr/src/db.ts:4-6` — `new pg.Pool({ connectionString })` with no
`max`, no `connectionTimeoutMillis`.

**Failure it causes:** Default pool size (10). Under concurrent writes, if all
connections are checked out, a borrower waits with *no timeout* — the same "no
deadline" hazard as R1, one layer down. A leaked connection (mitigated by the
`finally { client.release() }` in `pg-vector-store.ts:62`, which is correct) would
permanently shrink the pool. Low likelihood at single-user scale.

**The move:** Set `connectionTimeoutMillis` so a borrower fails fast instead of
hanging when the pool is exhausted, and an explicit `max` sized to the workload. The
`finally release` is already the right defensive line; keep it. → `05`.

### R5 — Trace sink has no backpressure and fails the whole flush on one bad write (LOW)

**Evidence:** `buffr/src/supabase-trace-sink.ts:87-93` — `pending[]` is unbounded;
`flush()` uses `Promise.all`.

**Failure it causes:** (a) No backpressure — `emit` is sync and never blocks, so if
Postgres lags, `pending[]` grows unbounded with memory. (b) Poison message — one
rejected insert rejects the whole `Promise.all`, failing the entire turn's trace
persistence (throws out of `ask`). Both are inconsequential at one-agent-run scale
(tiny per-turn buffer).

**The move:** If trace volume grows, switch `Promise.all` → `Promise.allSettled`
(persist what you can, collect failures) and bound the buffer with periodic flushing
(flush every N events / T ms). → `06`.

## Lens inventory — every concept checked

| Lens | Verdict | Evidence / note |
| --- | --- | --- |
| System map / failure domains | exercised | 4 domains: aptkit, Ollama, buffr, Postgres (`01`) |
| Timeouts | **gap (R1)** | no per-call deadline on Ollama `fetch` |
| Retries | exercised | cross-provider fallback chain (`fallback-provider.ts:50-88`) |
| Failure classification | exercised | `shouldFallback` hook; `isAbortError` re-throw |
| Backoff / jitter | `not yet exercised` | fallback tries next provider immediately (correct — different endpoint) |
| Idempotency | exercised | `on conflict (id) do update` (`pg-vector-store.ts:49`) |
| Idempotency keys (synthetic) | `not yet exercised` | natural keys suffice; no retried HTTP endpoint |
| Delivery semantics | exercised | chunk=exactly-once; trace=at-least-once (no dedup); memory=at-most-once |
| Exactly-once delivery | `not yet exercised` | impossible to claim; not built |
| Consistency / read-your-writes | exercised | holds via single store+writer; breaks on swallowed `remember` (`04`) |
| Stale replica reads | `not yet exercised` | one Postgres, no replica |
| Eventual consistency | `not yet exercised` | single copy, nothing to converge |
| Replication | `not yet exercised` | one node |
| Partitioning / shard key | partial | `app_id` is a logical partition key, single-node (`05`) |
| Quorum (R+W>N) | `not yet exercised` | one copy |
| Connection pool (bounded resource) | **gap (R4)** | no checkout timeout (`db.ts:4-6`) |
| Queues / streams | exercised | NDJSON trace + `pending[]` write queue (`06`) |
| Ordering under races | exercised (R2) | `created_at` from emit timestamp |
| Backpressure | **gap (R5)** | unbounded `pending[]`, sync emit |
| Poison message handling | **gap (R5)** | `Promise.all` fails whole flush |
| Wall vs logical clock | exercised | single-source wall time, valid (`07`) |
| Leader election / lease | `not yet exercised` | one writer |
| Split-brain | `not yet exercised` | no second would-be leader |
| Distributed transactions / 2PC | `not yet exercised` | the dual write avoids it (`08`) |
| Sagas / compensation | partial | `remember` = empty-compensation step; `indexDocumentRow` = uncompensated dual write |
| Transactional outbox | `not yet exercised` | the fix for R3 if indexing goes async |
| Reconciliation | `not yet exercised` | no orphan-doc repair job |

## The priority order, one line each

```
  R1  add per-call timeouts to Ollama fetch ........ unblocks the fallback chain (do first)
  R4  add pool checkout timeout .................... same hazard, one layer down
  R3  outbox for indexDocumentRow .................. only when indexing goes async
  R5  allSettled + bounded buffer .................. only when trace volume grows
  R2  keep created_at-ordered replay ............... already right; don't regress
```

## See also

- `00-overview.md` — the ranked findings in context
- `02-partial-failure-timeouts-and-retries.md` — R1 in full
- `08-sagas-outbox-and-cross-boundary-workflows.md` — R3 in full
- `06-queues-streams-ordering-and-backpressure.md` — R2/R5 in full
- **study-debugging-observability** — using the trace to detect these failures in practice
- **study-system-design** — why the single-node shape was the right scale choice
```
