# Study — Distributed Systems (AptKit)

The headline, up front, no hedging: **AptKit is a single-process TypeScript
library plus a local dev tool. There are no distributed components.** No
service mesh, no replicas, no message queues, no background workers, no
consensus, no leader election, no multi-region anything.

There is exactly **one** real distributed-systems edge in this whole repo:

```
  the only network hop in the system

  ┌─ AptKit process (your machine / one Node runtime) ──────────┐
  │                                                             │
  │   runAgentLoop  →  ModelProvider.complete()  ──────┐        │
  │                                                    │        │
  └────────────────────────────────────────────────────┼────────┘
                                                        │
                                ★ the distributed edge ★ │  HTTPS
                                                        ▼
                            ┌─ External provider API (you don't own) ─┐
                            │   api.anthropic.com / api.openai.com     │
                            │   slow · down · rate-limited · flaky     │
                            └──────────────────────────────────────────┘
```

Everything else in the codebase — the agent loop, the tool registry, the
evals, the Studio UI — runs inside one process and talks to that boundary.
The distributed-systems discipline matters here because **that boundary is a
network dependency you don't control**: it can be slow, down, rate-limited,
or return garbage, and your process has to stay correct anyway.

So this guide is **curriculum-style, not audit-style.** It teaches the
distributed-systems foundations you'd be asked about in any senior interview —
CAP, partial failure, retries and backoff, idempotency, delivery semantics,
consistency, replication, quorums, queues, clocks, sagas — and for each one it
does an honest mapping:

- **Real analog** — where AptKit genuinely exercises a weaker version of the
  concept (almost always at the provider boundary), cited by `file:line`.
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
