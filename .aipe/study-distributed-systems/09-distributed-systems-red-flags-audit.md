# 09 — Distributed Systems Red-Flags Audit

**Industry names:** failure-mode review · coordination-risk audit. **Type:** Project-specific.

This is the ranked risk list — every coordination and partial-failure hazard in aptkit + buffr, ordered by consequence, each with its evidence and its fix. It's the file to scan before touching any of the four seams.

## Zoom out — the risk surface in one frame

```
  Zoom out — the four seams, colored by risk

  ┌─ App ───────────────────────────────────────────────────────────┐
  │  runAgentLoop → FallbackProvider → GemmaProvider → fetch          │
  │                      ▲ R1 (no deadline anywhere on this path)     │ ← highest
  └──────────────────────┼───────────────────────────────────────────┘
                         │ HTTP, no timeout
  ┌─ buffr ──────────────┼───────────────────────────────────────────┐
  │  indexDocumentRow:  doc INSERT  ──[R2 orphan window]──► chunks    │ ← second
  │  model retry (R3, no idem key)   trace ORDER BY ts (R4, sound)    │
  │  pg.Pool default size (R5)       app_id/kind not shard keys (R6)  │
  └────────────────────────────────────────────────────────────────────┘
```

## Ranked risks

### R1 — No deadline on the Ollama path (highest consequence)

**Verdict:** A wedged Ollama daemon hangs the entire agent call, and the failover chain — whose job is to survive a bad provider — cannot save you, because it advances only on a *thrown* error.

**Evidence:**
- `packages/providers/gemma/src/gemma-provider.ts:201-215` — `fetch(/api/chat, { …signal? })` arms no `AbortController` and no `setTimeout`; a timeout exists *only* if the caller passes a `signal`.
- `packages/providers/fallback/src/fallback-provider.ts:50-64` — the loop does `await provider.complete(request)` and advances only in the `catch`. No throw → no advance → the `await` blocks forever.
- `packages/runtime/src/run-agent-loop.ts:98` — `runAgentLoop` bounds *turns* (`maxTurns=8`), never *time*.

**Failure that bites:** daemon up, TCP connected, request accepted, no response. Indistinguishable from "slow." Everything above the `fetch` blocks.

**Fix:** arm an `AbortController` with `setTimeout` in `defaultHttpTransport`; on expiry it throws, the chain's `shouldFallback` treats it as retryable, and the chain advances. Add deadline propagation later so total time — not just each hop — is bounded. → `02`

### R2 — Dual write orphans documents (second; the latent saga)

**Verdict:** `indexDocumentRow` commits a `documents` row, then upserts chunks in a separate transaction. An embed failure between them leaves a document with zero chunks, and nothing detects or repairs it.

**Evidence:**
- `buffr/src/runtime.ts:5-18` — two sequential `await`s with no enclosing transaction; the doc `INSERT` auto-commits before `pipeline.index()` runs.
- `buffr/src/pg-vector-store.ts:42-58` — chunks upsert has its *own* `BEGIN/COMMIT`, confirming the two writes are separate units.
- `buffr/sql/001_agents_schema.sql:14-27` — the `chunks → documents` foreign key is explicitly dropped for `VectorStore` contract parity, so the DB can't flag the orphan.

**Failure that bites:** the embed step calls Ollama (see R1) — exactly the call most likely to fail or hang. When it does, the document is durable, invisible to retrieval, and silently inconsistent.

**Fix:** compensation (`try/catch` → delete/mark), transactional outbox (commit intent atomically + worker drain), or a reconciliation scan for zero-chunk documents. All lean on the idempotent upsert. → `08`

### R3 — Model-call retries are not idempotent (third)

**Verdict:** A failover advance or forced final turn issues a fresh `provider.complete` with no idempotency key, so a retry after a *lost response* re-does the work — double cost, different output.

**Evidence:**
- `packages/providers/fallback/src/fallback-provider.ts:55,64` — advance issues a new `provider.complete(request)`; `ModelRequest` carries no dedup key.
- Contrast `buffr/src/pg-vector-store.ts:47` — the DB writes *are* idempotent (`on conflict (id) do update`), so the asymmetry is the point.

**Failure that bites:** today, read-only agents (`toolPolicy` allowlists) mean the blast radius is cost and output nondeterminism, not corruption. It becomes a real bug the day a tool gains a side effect.

**Fix:** an idempotency key on `ModelRequest` + a short-lived response cache the chain checks before calling. → `03`

### R4 — Trace ordering depends on a single-clock assumption (low today, sound)

**Verdict:** Event order is recovered by an emit-timestamp, which is *correct* while one process stamps all events, and *silently wrong* the day a second writer with its own clock joins.

**Evidence:**
- `packages/runtime/src/events.ts:30-32` — `timestamp() = new Date().toISOString()`, a physical wall clock.
- `buffr/src/supabase-trace-sink.ts:27-36` — `created_at = coalesce($8::timestamptz, now())`, persisting the *app's* emit stamp; `ORDER BY created_at` recovers order under racing inserts.

**Failure that bites:** none today — one process, one clock, total order. The risk is *latent*: two concurrent writers with drifting clocks make `ORDER BY created_at` misorder causally-related events.

**Fix (when a second writer appears):** assign order at a single sequencing point (a DB sequence) or use a logical clock. Until then this is correct as written. → `06`, `07`

### R5 — Connection pool is untuned and the target port may not match the pooling mode (low)

**Verdict:** `createPool` passes only a connection string, so the pool runs at pg defaults (max 10, 30s idle). The configured `DATABASE_URL` points at port **5432** (direct), not Supabase's transaction-mode pooler on **6543** — fine for a single-process laptop runtime, a problem if many short-lived connections ever appear.

**Evidence:**
- `buffr/src/db.ts` — `new pg.Pool({ connectionString })`, no `max`, `idleTimeoutMillis`, or `connectionTimeoutMillis`.
- `.env` (observed) — `…supabase.co:5432/postgres`, the direct port, not `:6543`.

**Failure that bites:** at single-process scale, none. If buffr ever runs many instances or a serverless fan-out, a 10-connection direct pool against Postgres exhausts connection slots fast; that's the case Supabase's 6543 pooler exists for.

**Fix:** set explicit pool bounds and a `connectionTimeoutMillis` (so acquiring a connection itself has a deadline — the same R1 lesson at the pool); route through `:6543` if connection count grows. → `04`, `study-networking`

### R6 — Partition-key vocabulary on filter columns (informational, not a bug)

**Verdict:** `app_id` and the `kind` tag look like partition keys but are filter columns over a single node. No bug — but mislabeling them as shard keys would lead to wrong scaling decisions later.

**Evidence:**
- `buffr/sql/001_agents_schema.sql` — `app_id text not null default 'laptop'` on documents/chunks; every row shares one value, all on one primary.
- `packages/memory` + `context.md` — `kind:'memory'` is a logical partition over a shared collection; `recall` over-fetches then filters client-side (the `minTopK` floor), because the `VectorStore` contract has no metadata predicate.

**Failure that bites:** none functionally. The over-fetch tax is real but small at this corpus size.

**Fix:** none needed; just name them correctly. They become a true shard key / partition only when a routing function or replica set consumes them. → `05`

## Coverage check — every concept walked

```
  Concept                        Status in this repo
  ─────────────────────────────  ─────────────────────────────────────────
  partial failure / timeouts     EXERCISED (the gap is the finding) — R1, 02
  retries / backoff / jitter      retries: per-provider once; backoff/jitter: NOT YET — 02
  circuit breaker                 NOT YET (chain records, never trips) — 02
  idempotency / upsert            EXERCISED (on conflict id) — R3, 03
  idempotency keys (model calls)  NOT YET — R3, 03
  delivery semantics              EXERCISED (at-most/at-least/effective-once) — 03
  consistency / read-your-writes  EXERCISED (single primary) — 04
  eventual consistency / converge NOT YET (no replica; upsert is convergence-ready) — 04
  replication / failover          NOT YET — 05
  partitioning / shard key        logical (kind tag) yes; physical NOT YET — R6, 05
  quorums (R+W>N)                  NOT YET (N=1) — 05
  queues / brokers                NOT YET (no broker) — 06
  streams / ordering              EXERCISED (NDJSON + emit-timestamp) — R4, 06
  backpressure / poison msg       NOT YET (synchronous emit) — 06
  clocks (physical)               EXERCISED (single-clock, sound) — R4, 07
  logical clocks / happens-before NOT YET — 07
  leader election / lease         NOT YET (single writer) — 07
  split-brain                     NOT YET (can't have two leaders) — 07
  saga / compensation             NOT YET (dual write is the missing saga) — R2, 08
  transactional outbox            NOT YET — R2, 08
  reconciliation                  NOT YET — R2, 08
```

## The one-line verdict per seam

```
  seam 1 (Ollama HTTP)   → R1: add a deadline. Highest leverage, smallest diff.
  seam 2 (failover chain)→ R1/R3: advances on throw only; not idempotency-aware.
  seam 3 (Postgres pool) → R4/R5: sound today; clock + pool assumptions are latent.
  seam 4 (dual write)    → R2: a saga missing its envelope. Closest real bug.
```

## See also

- `00-overview.md` — the map and the reading order
- `02-partial-failure-timeouts-and-retries.md` — R1 in full
- `08-sagas-outbox-and-cross-boundary-workflows.md` — R2 in full
- `03-idempotency-deduplication-and-delivery-semantics.md` — R3 in full
- `study-debugging-observability` — how you'd *detect* R1 (hang) and R2 (orphan) in production
- `study-system-design` — the architectural framing of these same four seams
