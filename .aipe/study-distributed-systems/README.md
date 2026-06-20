# Study — Distributed Systems (AptKit)

The headline, up front, no hedging: **AptKit is a single-process TypeScript
library plus a local dev tool. There are no distributed components.** No
service mesh, no replicas, no message queues, no background workers, no
consensus, no leader election, no multi-region anything.

The distributed surface is **external-service dependencies** — and there are now
two flavors of them: cloud LLM APIs, and a local Ollama process:

```
  the external-service edges in the system

  ┌─ AptKit process (your machine / one Node runtime) ──────────┐
  │                                                             │
  │   runAgentLoop  →  ModelProvider.complete()  ──────┐        │
  │   RagQueryAgent →  EmbeddingProvider.embed() ──┐    │        │
  └─────────────────────────────────────────────────┼────┼───────┘
                                          HTTP localhost  │  HTTPS
                                                    ▼     ▼
  ┌─ Local Ollama process (you run it) ─┐  ┌─ Cloud provider API (you don't own) ─┐
  │   :11434 /api/chat · /api/embed      │  │   api.anthropic.com / api.openai.com  │
  │   not running · loading · slow       │  │   slow · down · rate-limited · flaky  │
  └───────────────────────────────────────┘  └────────────────────────────────────┘
```

Everything else in the codebase — the agent loop, the tool registry, the
retrieval pipeline, the evals, the Studio UI — runs inside one process and talks
to those boundaries. The distributed-systems discipline matters here because
**those boundaries are dependencies you don't fully control**: they can be slow,
down, rate-limited, or return garbage, and your process has to stay correct
anyway. The key new lesson: the Ollama hop is on `localhost` but it's still a
*separate process* — a separate failure domain, handled the same way as the
cloud. AptKit is **not** a distributed system itself; the multi-node sync plane
is deferred to the `buffr` repo (`docs/personal-agent-packages.md:81-86`).

So this guide is **curriculum-style, not audit-style.** It teaches the
distributed-systems foundations you'd be asked about in any senior interview —
CAP, partial failure, retries and backoff, idempotency, delivery semantics,
consistency, replication, quorums, queues, clocks, sagas — and for each one it
does an honest mapping:

- **Real analog** — where AptKit genuinely exercises a weaker version of the
  concept (almost always at an external-service boundary — cloud or Ollama),
  cited by `file:line`.
- **`not yet exercised`** — the (many) concepts AptKit has no instance of, with
  the concrete trigger that would make it real.

## The honest gap (from `me.md`)

Rein has shipped five system shapes (dryrun, buffr, contrl, aipe, AdvntrCue)
but has **not built distributed systems at horizontal scale** — no Kafka, no
Redis Streams, no multi-region replication, no load balancing under sustained
traffic. This guide teaches those concepts as foundations. It does **not**
anchor them to code that doesn't exist. Where the repo has no instance, it says
so and names the trigger.

## Reading order

```
  00-overview ─────────────────► the map + ranked findings + the gap
       │
       ▼
  01-distributed-system-map ───► nodes, the one boundary, failure domains
  02-partial-failure-...   ────► timeouts, retries, backoff, classification ★ real
  03-idempotency-...       ────► duplicate work, delivery semantics       ★ partial
  04-consistency-...       ────► staleness, read-your-writes              ~ weak analog
  05-replication-...       ────► replicas, shards, quorums                not yet exercised
  06-queues-streams-...    ────► ordering, backpressure, poison messages  not yet exercised
  07-clocks-coordination-..────► time, leases, leadership, split-brain    not yet exercised
  08-sagas-outbox-...      ────► multi-step workflows, compensation       ~ weak analog
  09-...-red-flags-audit   ────► ranked coordination risks in the repo
```

Start at `00-overview.md`. Read `02` and `03` closely — they are the two files
that genuinely live in this repo. The rest are foundations to *know cold*, with
honest "here's what would make this real" triggers.

## Where this sits — partition

```
  study-distributed-systems  correctness ACROSS the provider boundary
  study-system-design        architectural shape (the fallback chain as design)
  study-database-systems      datastore-local consistency (AptKit has none)
  study-networking           the transport under the provider hop (TLS, HTTP, DNS)
  study-runtime-systems       in-process execution: cancellation, bounded work
```

A finding belongs to the generator that owns the mechanism. This guide
cross-links rather than re-teaching.

## Cross-links

- **`study-networking`** — the provider hop's transport layer: DNS, TLS,
  HTTP/2, connection pooling, socket timeouts. This guide treats the hop as a
  black box that can fail; networking opens the box.
- **`study-system-design`** — the fallback chain as an architectural pattern
  (provider abstraction, swappable adapters). This guide treats it as
  partial-failure handling; system-design treats it as a boundary decision.
- **`study-runtime-systems`** — `AbortSignal` cancellation and the bounded
  agent loop as in-process execution control. This guide treats bounded turns
  as an idempotency/recovery analog; runtime-systems owns the execution model.
- **`study-ai-engineering` / `study-agent-architecture`** — the RAG retrieval
  pipeline and Gemma's tool-call emulation themselves. This guide only cares
  that the embed/chat calls to Ollama can fail and how the repo copes (failover,
  retry-on-parse); those guides own how RAG and tool-calling actually work.
