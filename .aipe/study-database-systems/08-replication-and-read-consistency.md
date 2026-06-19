# 08 — Replication and read consistency

**Subtitle:** Replication / read replicas / replication lag / stale reads —
*Industry standard* (taught), *status: not yet exercised; analog:
deterministic replay as reproducible reads* (in-repo)

---

## Zoom out, then zoom in

Replication is keeping copies of your data on more than one node so reads can
scale out and the system survives a node dying — at the cost of *lag*, the
window where a replica hasn't caught up and serves a stale read. AptKit has no
replicas, no nodes, no lag, because it's a single machine writing local files.
But it has a cousin of the problem replication's *consistency* guarantees
solve: "will two reads of the same thing return the same answer?" AptKit
answers yes, and not through replication — through *determinism*. The
`FixtureModelProvider` replays recorded responses byte-for-byte, so a read is
reproducible by construction. This file teaches replication and stale reads,
then shows how deterministic replay delivers reproducible reads without any
distribution.

```
  Zoom out — where replication would sit (but there's one node)

  ┌─ Service layer (single process) ──────────────────────────┐
  │  FixtureModelProvider → same responses, same order, always │ ← we are here:
  │  (reproducible reads via determinism, not replicas)        │   consistency w/o
  └───────────────────────────┬───────────────────────────────┘   replication
  ┌─ Storage layer (single local disk) ───────────────────────┐
  │  artifacts/ + fixtures/  — no replicas, no failover        │
  └───────────────────────────────────────────────────────────┘
```

**Zoom in.** The question replication's consistency model answers: *if I read
the same record twice (or from two places), do I get the same bytes?* In a
replicated database that depends on lag and your consistency level. In AptKit
the answer is unconditionally yes — promoted fixtures replay deterministically,
the same input producing the same output every run. That reproducibility is
the in-repo analog; true replication is `not yet exercised`.

---

## Structure pass

The layers: the **authoritative source** (promoted fixtures = the baselines)
and the **served read** (a replay run). Axis to hold constant: **freshness /
agreement — do two reads of the same record agree?**

```
  One axis — "do two reads agree?" — across the consistency layers

  ┌───────────────────────────────────────────┐
  │ promoted fixture (the baseline record)    │  → fixed bytes on disk; the
  └───────────────────────────────────────────┘    authoritative version
      ┌───────────────────────────────────────┐
      │ replay run over that fixture          │  → SAME output every time:
      └───────────────────────────────────────┘    FixtureModelProvider serves
                                                    the same responses in order
      ┌───────────────────────────────────────┐
      │ HYPOTHETICAL second node / replica    │  → would introduce LAG → stale
      └───────────────────────────────────────┘    reads. Not present.

  the seam: AptKit's reads agree because the source is immutable AND the read
  is deterministic — there's no second copy to lag. Add a replica and you add
  the staleness window this file teaches.
```

The load-bearing seam: "one deterministic source" vs "multiple lagging
copies." AptKit lives entirely on the first side — reproducibility comes from
determinism over a single immutable source. Replication would move it to the
second side and introduce lag, the central cost this file exists to name.

---

## How it works

### Move 1 — the mental model

You know how a CDN serves a cached copy of your page from an edge node, and
sometimes you see a stale version until the cache updates? Read replicas are
that for a database: writes go to the primary, then propagate to replicas that
serve reads, and there's a window where a replica is behind. The mental model:
**replication = one writer (primary) fanning its changes out to read-only
copies, trading read scalability for a staleness window called lag.**

```
  the real mechanism: primary → replicas, with lag

   writes
     │
     ▼
  ┌─ PRIMARY ─┐  ship WAL   ┌─ replica A ─┐  reads ◄── client 1 (fresh)
  │ (writable)│ ──────────► │ (read-only) │
  └───────────┘     │       └─────────────┘
                    │       ┌─ replica B ─┐  reads ◄── client 2 (STALE:
                    └─────► │ (read-only) │              hasn't applied
                            └─────────────┘               latest WAL yet)
   lag = time between primary commit and replica apply → stale-read window
```

### Move 2 — the parts that matter

**The primary / replica split (absent).** Replication needs a designated
writer and one-or-more read-only copies, with a transport (usually shipping the
WAL) between them. AptKit has one process and one local disk — no split, no
transport. What this buys by its absence: there's no lag and no stale-read
window, because there's only one copy. What you give up: read scale-out and
node-failure survival. `not yet exercised`; trigger = reads must scale beyond
one machine, or survive a host failing.

**Replication lag and stale reads (absent).** Lag is the gap between a write
committing on the primary and being visible on a replica; a read hitting a
behind replica is *stale*. The consistency levels (read-your-writes,
monotonic reads, eventual) exist to manage which staleness you'll tolerate.
AptKit has none of this to manage — a read always sees the one current file.
Trigger to care: the moment a second copy can answer reads.

**The in-repo analog: deterministic replay = reproducible reads.** Here's the
real connection. The *value* a consistency model protects is "the same read
gives the same answer." AptKit guarantees that not by syncing copies but by
making the read deterministic: the `FixtureModelProvider` holds a fixed
`ModelResponse[]` and serves them in order by an integer cursor, so replaying
the same fixture produces the same output on every run, on any machine, with
no model call. Promotion bakes a live run's *answer* into a fixture
(`promote-replay-to-fixture.mjs:44-74`) precisely so that answer becomes a
reproducible baseline — the equivalent of a fully-replicated, never-stale
read. What breaks the reproducibility: running in `openai`/`anthropic` mode
instead of `fixture` mode, which calls a live model — now the "read" is
non-deterministic, the way a stale replica read is non-deterministic relative
to the primary.

```
  deterministic replay gives reproducible reads (the consistency value),
  without any replication

  promoted fixture (fixed responses)
        │
        ▼
  FixtureModelProvider.complete() → responses[index++]   ← same bytes, same order,
        │                                                   every run, every machine
        ▼
  agent output  ==  agent output  ==  agent output
   (run 1)          (run 2)           (run N)
        ▲
        └─ "read-your-writes" and "monotonic reads" hold trivially: there's one
           immutable source and a deterministic reader. No lag because no copy.

  switch mode fixture → openai:  live model call → output may DIFFER per run
                                  (the non-determinism replication-lag would add)
```

### Move 3 — the principle

Replication trades a staleness window for read scale and fault tolerance; the
consistency model is just how you choose to spend that window. The deeper value
underneath — *reproducible reads* — can be bought a different way entirely:
make the read deterministic over an immutable source, and two reads agree
without any copy to keep in sync. AptKit buys exactly that with fixture replay.
The generalizable rule: **distribution is one way to get consistency
guarantees, determinism is another — and when your data fits on one node,
determinism gives you reproducibility with none of replication's lag.** The
day reads must outscale one machine or survive its death, you take on
replication and inherit lag as the price.

---

## Primary diagram

```
  AptKit "read consistency" — determinism instead of replication

  ┌─ authoritative source (one local disk) ───────────────────┐
  │  promoted fixture: fixed ModelResponse[]                  │
  │  (baked by promotion — promote-replay-to-fixture.mjs)     │
  └───────────────────────────┬───────────────────────────────┘
                              │ replay (fixture mode)
  ┌─ deterministic reader ────▼───────────────────────────────┐
  │  FixtureModelProvider.index++  → responses[index]         │
  │  same input → same output, every run, no model call       │
  └───────────────────────────┬───────────────────────────────┘
                              │ contrast
  ┌─ non-deterministic read (live mode) ──────────────────────┐
  │  openai/anthropic provider → live call → output may vary  │  ← the only
  │  (the variability a stale replica read would also have)   │     "stale" analog
  └───────────────────────────────────────────────────────────┘

  no primary/replica, no lag, no failover — one node, deterministic reads.
```

---

## Implementation in codebase

**Use cases.** Reproducible reads are exercised every time a promoted fixture
is replayed — in CI, in the per-package `replay:promoted` scripts, and in the
Studio promoted-fixture panels. The non-deterministic contrast appears the
moment a replay runs in `openai`/`anthropic` mode against a live provider.

**The deterministic reader** — `fixture-provider.ts:11-17`:

```
  async complete(request) {
    this.requests.push(request);
    const response = this.responses[this.index]; ← read at the current cursor
    this.index += 1;                              ← advance — deterministic order
    if (!response) throw new Error(`fixture model exhausted after ${this.index - 1} responses`);
    return response;
  }
       │
       └─ the entire "read consistency" mechanism. Same responses array + same
          call order ⇒ identical output every run. This is reproducibility by
          determinism, the value replication's consistency levels protect —
          achieved with zero distribution.
```

**Promotion bakes the reproducible baseline** —
`scripts/promote-replay-to-fixture.mjs:52-67`:

```
  modelResponses: [
    {
      content: [{ type: 'text', text: `\`\`\`json\n${JSON.stringify(toAscii(
        stripRecommendationIds(artifact.recommendations)), null, 2)}\n\`\`\`` }],
                                          ← the live run's ANSWER, frozen as the
                                            single response the fixture will replay
      usage: { inputTokens: ..., outputTokens: ..., estimated: true },
      model: `promoted-${providerId}-replay`,
    },
  ],
       │
       └─ note the promotion's own note (line 72): "captures the final replay
          answer deterministically; it does not reconstruct the live provider
          tool loop." That sentence IS the consistency model: the promoted read
          is the frozen answer, reproducible forever, never stale.
```

**The mode switch that breaks determinism** — `apps/studio/vite.config.ts:756-760`:

```
  if (mode === 'fixture') return new FixtureModelProvider(fixture.modelResponses);
                                  ← deterministic, reproducible read
  if (mode === 'anthropic') {
    return providerWithConfiguredFallback(requireAnthropicProvider(), ...);
  }                                ← LIVE model: output may differ run-to-run
  return providerWithConfiguredFallback(requireOpenAIProvider(), ...);
       │
       └─ choosing 'fixture' vs 'openai'/'anthropic' is choosing reproducible
          vs non-deterministic reads — AptKit's nearest thing to "fresh vs stale."
```

---

## Elaborate

Replication is where distributed databases get genuinely hard: synchronous
replication trades write latency for zero data loss; asynchronous trades a
small loss window for speed; quorum systems (Dynamo-style) let you tune
consistency per request. All of it is machinery for keeping copies agreeing
under network delay and partial failure. AptKit needs none of it because it's
single-node — but it cares about the same *outcome* (reproducible reads) and
gets it through determinism, which is the technique behind record-and-replay
testing, deterministic simulation, and event sourcing. Rein has shipped the
real distributed version of the consistency problem in buffr
(SQLite-canonical-local with a Supabase mirror has to reconcile two copies
that can diverge) — that's where replication lag and stale reads actually
bite. AptKit deliberately stays single-node and leans on determinism instead.

The trigger for real replication: reads must scale past one machine, or the
artifact/fixture store must survive a host dying without a manual git restore.
At that point you take on a primary/replica split and inherit lag — and the
fixture-replay determinism stays useful as your *test* consistency even after
production goes distributed.

The streaming transport that carries replay results to the client (NDJSON over
HTTP) is `study-system-design`'s concern; this file owns only the read-
consistency semantics.

---

## Interview defense

**Q: "No replicas — how do you guarantee two reads of the same thing agree?"**

> I don't replicate; I make the read deterministic. A promoted fixture holds a
> fixed set of model responses, and `FixtureModelProvider` serves them in order
> by an integer cursor, so replaying the same fixture produces identical output
> every run on any machine — no model call, no copy to keep in sync. That's the
> value a consistency model protects (reproducible reads) bought through
> determinism instead of distribution. There's no lag because there's no second
> copy. The non-deterministic case is live mode — calling OpenAI/Anthropic
> directly — which is my only analog to a stale read.

```
  promoted fixture → FixtureModelProvider.index++ → same bytes every run
                       (reproducible read, zero lag, one node)
```

**Anchor:** "Determinism replaces replication for read consistency —
`fixture-provider.ts:13` is the whole mechanism."

---

## Validate

1. **Reconstruct:** Draw primary→replica with lag, then draw AptKit's
   deterministic-replay read path, and mark where staleness could enter each.
2. **Explain:** Why does replaying a promoted fixture twice give identical
   output? Cite `fixture-provider.ts:13` and the promotion note at
   `promote-replay-to-fixture.mjs:72`.
3. **Apply:** You move the artifact store behind two read replicas. What new
   anomaly appears, and which consistency level prevents a user from not seeing
   their own just-saved run?
4. **Defend:** Argue why single-node determinism is the right consistency story
   for AptKit, and name the trigger to take on real replication.

---

## See also

- `07-wal-durability-and-recovery.md` — shipping the WAL is how replicas sync
- `06-locks-mvcc-and-concurrency-control.md` — immutability behind reproducibility
- `05-transactions-isolation-and-anomalies.md` — read-your-writes as an isolation cousin
- `study-system-design` → NDJSON streaming and the single-node deployment choice
- `study-data-modeling` → the promoted-fixture schema that freezes the baseline
