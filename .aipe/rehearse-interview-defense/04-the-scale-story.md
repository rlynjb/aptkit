# Chapter 4 — The Scale Story

At some point someone asks "what breaks first when this gets big?" This is a
forward-looking question and it's a trap in two directions. Overclaim — "oh
it scales fine, it's all stateless" — and they'll prove you wrong in two
follow-ups. Underclaim — "I don't know, I never scaled it" — and you look
like you can't reason about systems you haven't run. The senior answer is in
between: name the first bottleneck, the second, what you'd add when, and how
you'd *measure* to know it's time.

Be honest up front about your footing here. You have not run a distributed
system at horizontal scale. That's a real gap and you don't fake it. What you
*can* do is reason precisely about where *this specific system* breaks,
because you know exactly what's in it. That's the answer that lands: not "I've
scaled things" but "here's how I'd find the bottleneck in *this* system."

## The chapter-opening diagram — what breaks, in order

This is the bottleneck sequence. As load grows along three axes, things break
in a predictable order. Memorize the order; the order is the answer.

```
SCALE BOTTLENECKS — what breaks first, in sequence

  AXIS 1: MORE USERS (10x concurrent requests)
    1st ► local Gemma / Ollama: one laptop, serialized
          inference. Throughput ceiling hits almost instantly.
    2nd ► agent loop is synchronous per request — no queue.
    fix ► swap to frontier provider (1-line, complete()),
          add a request queue. MEASURE: p95 latency, queue depth.

  AXIS 2: MORE DATA (100x corpus)
    1st ► InMemoryVectorStore: brute-force cosine scan is O(n)
          per query, whole corpus in RAM. Dies on big corpora.
    2nd ► embedding throughput at index time (nomic, local).
    fix ► PgVectorStore + HNSW (buffr ALREADY does this — the
          swap exists). MEASURE: recall@k vs scan, query latency.

  AXIS 3: MORE LATENCY-SENSITIVE REQUESTS (10x, tighter SLA)
    1st ► multi-turn agent loop: each turn is a full model
          round-trip. maxTurns=8 means up to 8 sequential calls.
    2nd ► no caching of embeddings or retrieval results.
    fix ► cap maxToolCalls tighter, cache query embeddings,
          stream partial answers. MEASURE: turns-per-answer,
          tokens-per-answer (usage-ledger already tracks these).

  the move: for each axis, name 1st + 2nd bottleneck + the fix
  + the metric that tells you it's time. never just "it scales."
```

The structure of every good scale answer is in that diagram: first
bottleneck, second bottleneck, the fix, the metric. Let's walk each axis as a
spoken answer.

### Question 1 — "What breaks first at 10x users?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Say you 10x the concurrent users. What's the     │
│    first thing that falls over?"                    │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Can you find the bottleneck in YOUR system, not   │
│   recite generic scaling advice? Do you know which  │
│   part is the constraint, and can you order the     │
│   failures?                                         │
└─────────────────────────────────────────────────────┘
```

> "The first thing that falls over is the local Gemma. Ollama is one process
> on one laptop doing serialized inference — there's no concurrency story
> there at all. At 10x concurrent requests, inference throughput is the wall,
> and it's a low wall. That's actually the cleanest thing to fix because of
> the provider contract: I swap the default from Gemma to a frontier provider
> in one line — same `complete()` interface — and now I'm bounded by the API
> provider's concurrency, not my laptop's.
>
> The *second* bottleneck shows up after that: the agent loop is synchronous
> per request, and there's no request queue. So I'd put a queue in front and
> measure two things — p95 latency and queue depth. Queue depth climbing while
> p95 stays flat means I'm absorbing burst; both climbing means I need more
> inference capacity. I haven't run this at that scale, so I'd be measuring to
> learn, not asserting from experience."

That last sentence is the honest footing. It doesn't weaken the answer — it
makes the rest of it credible, because you've told them which parts are
reasoned vs lived.

```
┃ The provider contract turns my worst scale bottleneck —
┃ a local model on one laptop — into a one-line fix.
```

### Question 2 — "What breaks at 100x data?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Now 100x the corpus size. What breaks?"          │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand the cost of YOUR retrieval       │
│   implementation? Do you know that brute-force       │
│   cosine is O(n) and when that stops being okay?     │
└─────────────────────────────────────────────────────┘
```

> "This one I'm confident about because I built the store. `InMemoryVectorStore`
> does a brute-force cosine scan over an array — it's O(n) in the corpus size
> per query, and the whole corpus sits in RAM. That's completely fine at the
> scale I built for, and it falls apart at 100x: linear scan time climbs and
> RAM becomes the ceiling.
>
> The fix already exists, which is the part I like. buffr's `PgVectorStore`
> implements the same `VectorStore` contract over Supabase pgvector with an
> HNSW index — that's sub-linear approximate nearest-neighbor instead of a
> full scan, and the corpus lives in Postgres, not in process memory. So 100x
> data isn't a redesign, it's the swap the architecture was built for. The
> way I'd verify it's working is to compare recall@k between the brute-force
> scan and the HNSW index on the same corpus — HNSW is *approximate*, so I'd
> want to confirm recall didn't drop below my threshold while latency
> improved. I've got `scoreRecallAtK` in `packages/evals/precision-at-k.ts`
> exactly for that."

The recall@k point is sharp: you know HNSW trades exactness for speed, and you
have the scorer to measure the trade. That's reasoning about a tradeoff you
deliberately don't fully own internally (HNSW math) using a tool you *do* own
(your recall scorer). Strong move.

```
"What breaks at 100x data?"
      │
      ├─► IF THEY ASK "why is in-memory O(n)?"
      │     Brute-force cosine over an array — every query
      │     compares against every chunk. No index. Fine small,
      │     dead large. → it's a deliberate reference impl, Ch03.
      │
      ├─► IF THEY ASK "how do you know HNSW recall is good?"
      │     scoreRecallAtK against the brute-force scan as
      │     ground truth. Approximate index, so I MEASURE the
      │     recall drop, not assume it. → evals.
      │
      └─► IF THEY ASK "what about index build time / memory?"
            Honest gap: I haven't profiled HNSW build cost at
            100x. I took the pgvector default. → recovery box.
```

### Question 3 — "What about latency-sensitive requests?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "What if you 10x the requests AND tighten the     │
│    latency SLA? What's the constraint then?"        │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand that a multi-turn agent loop is  │
│   inherently latency-unfriendly? Can you name the    │
│   knobs you'd turn?                                  │
└─────────────────────────────────────────────────────┘
```

> "The constraint here is the agent loop itself. Each turn is a full model
> round-trip, and `maxTurns` defaults to 8 — worst case that's eight
> sequential model calls before an answer. For a tight latency SLA that's the
> enemy. The knobs: cap `maxToolCalls` tighter so the loop forces synthesis
> sooner, cache query embeddings so repeated questions skip the embed step,
> and stream partial answers so time-to-first-token drops even if
> time-to-complete doesn't.
>
> I'd measure turns-per-answer and tokens-per-answer to know where the time
> goes — and I already track tokens, there's a usage-and-cost ledger in the
> runtime. If most answers finish in two turns, `maxTurns=8` isn't my
> problem; if they're routinely hitting six, the loop is the bottleneck and I
> tune the budget."

### Strong vs weak — the scale answer

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "It should scale fine — the  │ "First bottleneck at 10x     │
│  runtime is stateless and    │  users is the local Gemma:   │
│  the vector store can be      │  one laptop, serialized      │
│  swapped for something        │  inference. I swap to        │
│  bigger. I'd add caching and  │  frontier in one line. At    │
│  horizontal scaling if I      │  100x data the in-memory     │
│  needed to."                  │  O(n) scan dies; buffr's     │
│                              │  HNSW swap already exists. I │
│                              │  measure recall@k to confirm │
│                              │  the approximate index holds."│
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ "should scale fine" +        │ Names the SPECIFIC first      │
│ "horizontal scaling" is the  │ bottleneck in THIS system,    │
│ generic answer of someone    │ orders the failures, ties each│
│ who hasn't found the actual  │ fix to a real mechanism, and  │
│ bottleneck. Invites a brutal │ names the metric. Honest about│
│ "scale WHAT, exactly?"       │ what's reasoned vs lived.     │
└──────────────────────────────┴──────────────────────────────┘
```

The weak answer's tell is "horizontal scaling" with no subject. Horizontal
scaling of *what*? The inference? The store? The queue? Naming the specific
constraint is the entire difference.

```
╔════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                     ║
║                                                         ║
║   They push into distributed scale: "How would you      ║
║   shard the vector store across nodes? How do you       ║
║   handle replication lag between regions?"              ║
║                                                         ║
║   This is your real gap. You have NOT built distributed ║
║   systems at horizontal scale — no sharding, no multi-  ║
║   region replication, no hot-path queue infrastructure. ║
║   Do not fake it. This is the territory most likely to  ║
║   push past your depth.                                 ║
║                                                         ║
║   Say:                                                  ║
║   "I'll be straight — I haven't built sharded or multi- ║
║    region systems. My background is seven years of      ║
║    frontend at enterprise scale and these AI-native     ║
║    projects; distributed storage at horizontal scale    ║
║    isn't something I've run. What I CAN reason about is  ║
║    that my VectorStore contract gives me the seam to     ║
║    put a sharded store behind it without touching the   ║
║    pipeline — the same way buffr put pgvector behind it. ║
║    The sharding strategy itself, the replication-lag     ║
║    tradeoffs — I'd be learning those, and I'd want to    ║
║    learn them from someone who's run them. Have you?"    ║
║                                                         ║
║   What this signals: you know exactly where your         ║
║   experience ends, you don't pretend, you show the       ║
║   contract gives you the seam even where you lack the    ║
║   experience, and you turn it into a learning exchange.  ║
║                                                         ║
║   Do NOT say:                                            ║
║   "I'd just shard by document ID and use eventual        ║
║    consistency..." — reciting distributed-systems         ║
║   vocabulary you haven't practiced is the fastest way     ║
║   to get exposed by the next follow-up.                  ║
╚════════════════════════════════════════════════════════╝
```

```
        ▸ Don't say "it scales." Say what breaks first, what
          breaks second, and the metric that tells you when.
```

## What you'd change

If I were building for scale from the start — which I deliberately wasn't — I'd
add the usage instrumentation as a richer signal earlier. Right now the
runtime tracks tokens and cost, which tells me the *spend* but not the
*shape* of latency across turns. I'd add per-turn timing to the
`CapabilityEvent` trace so that when someone does ask "what's slow," I can
answer from data instead of reasoning. The honest framing: I built this to
understand the substrate at small scale, so I optimized for clarity over
observability-at-scale — and the first thing I'd add the moment it had real
load is the timing breakdown that tells me which bottleneck I actually hit.

## One-page summary — Chapter 4

```
CORE CLAIM
  Never say "it scales." Name the 1st bottleneck, the 2nd, the
  fix, and the metric — per axis. Honest about reasoned vs lived.

QUESTIONS COVERED
  Q: 10x users? A: Gemma/Ollama serialized inference dies first
     → frontier swap (1 line). 2nd: no queue. Measure p95, depth.
  Q: 100x data? A: InMemoryVectorStore O(n) scan dies → buffr's
     PgVectorStore + HNSW (swap exists). Measure recall@k.
  Q: tight latency? A: multi-turn loop (up to 8 round-trips) is
     the enemy → cap maxToolCalls, cache embeddings, stream.
  Q: distributed sharding/replication? A: honest gap — contract
     gives the seam; I haven't run it. (recovery box)

PULL QUOTES
  ▸ The provider contract turns my worst bottleneck into a 1-line fix.
  ▸ Say what breaks first, second, and the metric that tells you when.

WHAT YOU'D CHANGE
  Add per-turn timing to the CapabilityEvent trace so "what's slow"
  is answered from data, not reasoning. Built for clarity, not scale.
```
