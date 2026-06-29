# 09 · Database Systems Red-Flags Audit

**Industry name(s):** storage-engine risk audit. **Type:** Project-specific.

The verdict, up front: **buffr's database layer is correct and minimal for what it is — a single-user laptop runtime — and its risks are almost all latent, not active.** The one thing it does that demands attention (per-document atomic upsert) it does right. Everything that's missing is missing *honestly* because the workload doesn't yet exercise it. The risks below are ranked by consequence-if-the-workload-grows, each with file:line evidence.

## Zoom out

```
  Zoom out — the audit surface

  ┌─ aptkit (control) ─────────────────────────────────────┐
  │  InMemoryVectorStore: no index, no durability, no txn   │
  │  → correct for tests/Studio; NOT a production store     │
  └─────────────────────────────────────────────────────────┘
  ┌─ buffr (the real database) ────────────────────────────┐
  │  PgVectorStore → Supabase Postgres + pgvector           │ ← audit target
  │  atomic per-doc upsert · HNSW · READ COMMITTED · 1 node │
  └─────────────────────────────────────────────────────────┘
```

The risks cluster into three buckets: **integrity** (the dropped FK), **observability** (no `EXPLAIN`, untuned HNSW), and **operational** (untested restore, no replica/failover). None is a present-tense bug; all are "the day the workload changes."

## Ranked risks

### R1 — Document/chunk integrity has no engine enforcement (HIGH if indexing ever concurrent/automated)

**Evidence:** `buffr/sql/001_agents_schema.sql:16-27` — the `chunks → documents` FK is explicitly dropped; `buffr/src/pg-vector-store.ts:40-65` — the upsert transaction wraps chunks only, not the document row.

**The risk:** indexing a document is two un-transacted writes (insert `documents` row, then `upsert` chunks). A crash between them leaves orphan chunks or a chunk-less document, and the dropped FK means Postgres won't catch it (05). Today it's tolerable — manual, single-writer, low-frequency indexing. It becomes a real consistency bug under automated or concurrent re-indexing.

**The move:** when indexing goes automated, either wrap document+chunk writes in one application-level transaction, or restore a `deferrable initially deferred` FK checked at commit. Both reintroduce the spanning boundary the contract gave up — accept the parity cost is what created this. → 01, 05.

### R2 — The hot query's plan is unverified; HNSW is untuned (HIGH for retrieval quality/latency)

**Evidence:** `buffr/src/pg-vector-store.ts:70-77` — the search SQL; `buffr/sql/001_agents_schema.sql:28-29` — HNSW built on defaults. No `EXPLAIN ANALYZE` anywhere in either repo.

**The risk:** two unknowns stacked. (a) Nobody has confirmed the planner uses the HNSW index — a stale-stats or unpushed-predicate fallback turns the search into a sequential scan + sort over fat embedding rows (04, 02), silently O(n). (b) `ef_search`/`ef_construction` are pgvector defaults, so recall-vs-latency is whatever the default trades — if retrieval starts missing relevant chunks, the lever isn't being pulled.

**The move:** run `EXPLAIN (ANALYZE, BUFFERS)` on the search query — single highest-value diagnostic in the repo. Confirm index usage, see TOAST/buffer reads, then tune `ef_search` if recall is weak. → 03, 04.

### R3 — Restore is assumed, never tested (HIGH for durability confidence)

**Evidence:** no `pg_dump`, backup script, or restore drill in `buffr/` anywhere; `buffr/src/migrate.ts` is the only DB-lifecycle script and it only applies forward.

**The risk:** Supabase manages backups and PITR, so backups are real. But a restore that's never been run is a restore you don't know works — "we have backups" ≠ "we have tested recovery" (07). A real data-loss event is the worst time to discover the restore path is broken or the corpus comes back un-searchable.

**The move:** a one-time restore drill — restore to a scratch database, re-run a search, confirm corpus count and recall. Converts an assumption into a verified property. → 07.

### R4 — Filtered ANN (`app_id` + HNSW) behavior is unknown (MEDIUM, latent until multi-tenant)

**Evidence:** `buffr/src/pg-vector-store.ts:74-76` — `where app_id = $2` rides a separate b-tree (`001_agents_schema.sql:30`) while `order by embedding <=>` uses HNSW.

**The risk:** the tenant filter and the ANN scan use different indexes. If HNSW returns its nearest candidates and most belong to another `app_id`, the post-filter can under-return below `k` (03). Invisible today because `app_id` defaults to `'laptop'` for everything — a single-tenant no-op. Real the day a second `app_id` shares the database.

**The move:** before multi-tenanting, `EXPLAIN` the filtered query and consider a partial HNSW index per app_id or a pre-filter strategy. RLS would also formalize the tenant boundary (currently deferred — application-level `where app_id`). → 03.

### R5 — MVCC bloat from re-index churn is unmanaged (MEDIUM, grows with re-index frequency)

**Evidence:** `buffr/src/pg-vector-store.ts:48-54` — `on conflict do update` churns row versions; no vacuum strategy, autovacuum tuning, or `vacuum` call anywhere.

**The risk:** every re-index `do update`s chunks, leaving dead heap tuples *and* dead HNSW index entries (06). Vector index bloat is a known pgvector operational concern. Autovacuum handles it by default, but untuned — and on the HNSW index, bloat degrades both scan quality and write cost.

**The move:** monitor dead-tuple ratio and HNSW index size if re-index frequency climbs; tune autovacuum or schedule maintenance. Not urgent at current corpus size. → 06.

### R6 — Write path is a per-row N+1 (LOW, a latency cost not a correctness bug)

**Evidence:** `buffr/src/pg-vector-store.ts:43-57` — `for (const c of chunks)` fires one `INSERT` per chunk inside the transaction.

**The risk:** a 50-chunk document is 50 round trips that one multi-row `INSERT` could collapse to one (04). Correctness is fine (one transaction, one commit); it's pure network-latency waste, and HNSW insert cost is paid per row regardless.

**The move:** collapse to a multi-row insert or `unnest` once profiling shows indexing latency matters. Clean, low-risk win; not urgent on a small corpus. → 04.

### R7 — No replica, no failover handling (LOW today, by design)

**Evidence:** `buffr/src/db.ts:4-6` — one `pg.Pool`, one `DATABASE_URL`; no reconnect/health-check logic.

**The risk:** single endpoint means a mid-query failover surfaces as an error, not a retry (08); and the day a read replica is added, the index→search and remember→recall paths become read-your-own-write stale-read hazards — in RAG, a retrieval *miss* the model launders into a confident wrong answer.

**The move:** none now — one primary is correct for a single-user laptop runtime. When scaling, design read-your-own-write routing first, add pool reconnect, run a failover drill. → 08.

## The honest summary

```
  Risk register — consequence × likelihood-given-growth

  R1 doc/chunk integrity     ████████  HIGH   (active the moment indexing concurrent)
  R2 unverified plan/HNSW    ████████  HIGH   (affects retrieval quality NOW, unmeasured)
  R3 untested restore        ███████   HIGH   (durability confidence, one drill fixes)
  R4 filtered ANN            █████     MED    (latent until 2nd app_id)
  R5 MVCC/HNSW bloat         █████     MED    (grows with re-index frequency)
  R6 write N+1               ███       LOW    (latency only, correctness fine)
  R7 no replica/failover     ██        LOW    (by design for laptop runtime)
```

The single highest-leverage action across the whole register is **run `EXPLAIN (ANALYZE, BUFFERS)` on the search query** (R2): it's free, it confirms or kills the biggest unknown (is HNSW even being used), and it surfaces the page/TOAST and filtered-ANN behavior that R4 and the storage-layout questions depend on. After that, the **restore drill** (R3) converts the durability assumption into a verified property. Everything else is "the day the deployment grows past single-user" — correctly deferred, correctly named.

## See also

- `00-overview.md` — the ranked findings these risks expand.
- `04-query-planning-and-execution.md` — R2/R6 detail.
- `07-wal-durability-and-recovery.md` — R3 detail.
- `08-replication-and-read-consistency.md` — R7 detail.
- study-data-modeling — R1 as a modeling/integrity decision.
- study-system-design — R7 as a scaling decision.
