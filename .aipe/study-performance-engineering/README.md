# Study — Performance Engineering (AptKit)

A per-repo performance-engineering study guide for the AptKit monorepo.
**The central fact: for an LLM system the dominant cost and latency is the
model round-trip — tokens and turns — not CPU or memory.** Every perf
control in this repo bounds, measures, skips, or hides model work. The
guide is read through that lens throughout.

This is an **audit-style** guide: Pass 1 is a single lens audit; Pass 2 is
a set of discovered-pattern files named after the real perf patterns the
repo exercises.

## Reading order

1. **00-overview.md** — the map, ranked findings, and the `not yet
   exercised` list. Start here.
2. **audit.md** — Pass 1. The 8-lens walk (budget, baselines/profiling,
   latency/tail, CPU/memory, I/O/network, caching/batching/backpressure,
   rendering, red-flags). Honest `not yet exercised` where a lens finds
   nothing.
3. **Pass 2 — discovered patterns:**
   - **01-turn-and-tool-budget.md** — the load-bearing control: a hard
     turn/tool ceiling + forced-synthesis turn that bounds the bill and the
     latency tail.
   - **02-token-cost-ledger.md** — measuring spend (tokens → USD), and the
     gap: cost is `n/a` for the default Anthropic provider.
   - **03-context-window-preflight-guard.md** — failing fast on a call that
     won't fit, via a crude `length/3` token estimate.
   - **04-fixture-replay-as-zero-cost-path.md** — the $0, deterministic
     dev/eval path (a test double, explicitly *not* a runtime cache).
   - **05-streaming-for-perceived-latency.md** — NDJSON trace streaming that
     drops time-to-first-feedback without changing total time.
   - **06-bounded-json-scan.md** — bounded JSON extraction that can't be
     turned into a CPU sink.
   - **07-linear-vector-scan.md** — the RAG search is an O(n·d) flat cosine
     scan: the exact-search baseline, with buffr's HNSW index as the proven
     drop-in behind the same `VectorStore` contract.
   - **08-embedding-batch-and-topk-floor.md** — embeddings batch a whole
     document into one round-trip; the `minTopK` floor stops a weak local
     model (Gemma) from starving its own retrieval by asking for `top_k: 1`.
   - **09-memory-recall-overfetch.md** — `@aptkit/memory`'s episodic recall on
     the same vector store: it over-fetches `max(k*4, 20)` rows to filter by
     `kind` client-side (no metadata filter on the contract), grows unbounded
     with no eviction, and puts an unbatched embed on the write path —
     amplifying the file-07 linear scan three ways.

## What's honestly absent

No model-response cache (the biggest unclaimed lever), no latency SLO or
percentile tracking, no CPU/memory profiling, no *model* request batching
(embeddings ARE batched), no indexed/ANN vector search here (the in-memory
store is a flat scan; buffr's HNSW-indexed pgvector is the contracted
drop-in), no metadata filter on the `VectorStore` contract (which is why
memory recall over-fetches), no memory eviction/TTL/summarization, no real
backpressure, no bundle-size budget. The overview and audit name when each
would start to matter. The repo's perf model is tokens-and-turns; these gaps
are about traffic and scale it doesn't yet have.

## Cross-links to neighbor guides

- **study-runtime-systems** — the loop/cancellation *mechanism* behind the
  budget.
- **study-debugging-observability** — the trace events this guide reads as a
  cost/latency instrument.
- **study-ai-engineering** — cost-of-serving, provider economics, and RAG
  retrieval quality (precision@k/recall@k as a perf baseline).
- **study-distributed-systems** — provider-hop latency and the fallback chain.
- **study-database-systems** — pgvector + HNSW (in buffr), the indexed
  contrast to the in-memory linear scan.
