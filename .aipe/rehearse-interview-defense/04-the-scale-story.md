# Chapter 4 — The Scale Story

"What breaks first at 10x?" is the question that separates people who built a demo from people who think about systems. You don't need to have run aptkit at scale — you haven't, and you'll say so. What you need is to know, by reading your own design, where the first crack appears, where the second one is, and how you'd measure to know you've hit it. That's forward-looking systems thinking, and it's defensible entirely from the code you already wrote.

The honest frame up front: aptkit has never run under sustained load. It's a library plus a single-user laptop runtime. So this chapter is not "here's how we scaled" — it's "here's where my design breaks first, by construction, and what I'd add when."

## The chapter-opening diagram — the bottleneck sequence

Plot the load axis against what breaks. The first failure is by design and you can point at the exact line.

```
  WHAT BREAKS FIRST AS LOAD GROWS

  corpus size →  100 docs    10K docs        1M docs       100M docs
                 ─────────    ─────────       ─────────     ─────────
  in-memory      fine         SLOW (linear    won't fit     ✗
  cosine scan                 cosine scan)    in RAM
                              ▲
                              └─ FIRST BOTTLENECK: InMemoryVectorStore
                                 does O(n) cosine over every chunk per query
                                 → buffr's PgVectorStore + HNSW = sublinear ANN

  concurrent     fine         fine            embed calls   embed throughput
  users →                                     queue at       caps; Ollama is
                                              Ollama         one local process
                                              ▲
                                              └─ SECOND BOTTLENECK: embedding
                                                 throughput — one Ollama process,
                                                 no batching/queue in the hot path

  loop latency   ~6 turns     same            same          same
  per query →    × model      (latency is per-query, bounded by maxTurns;
                 latency       it doesn't degrade with corpus or user count —
                              it's a constant tax set by the turn budget)
```

The shape to carry: the **first** thing that breaks is the in-memory cosine scan — it's linear, so it degrades with corpus size, and I know the exact file. The **second** is embedding throughput at Ollama. Loop latency is a constant, not a scaling failure. Naming which is which is the whole answer.

## Scenario 1 — 100x the data

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "What happens when your corpus goes from a thousand     │
│    documents to a million?"                               │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Do you know your own data structure's complexity? Can   │
│   you name the first bottleneck precisely, and the fix    │
│   you've already designed for it — or do you wave at      │
│   "we'd add caching"?                                     │
└─────────────────────────────────────────────────────────┘
```

> "The first thing that breaks is the in-memory vector store. It does a linear cosine scan — every query compares against every chunk, so it's O(n) in corpus size. At a thousand chunks that's invisible; at a million it's the bottleneck, and at a hundred million it doesn't fit in RAM at all. The fix is already designed: buffr's `PgVectorStore` implements the same `VectorStore` contract over Postgres pgvector with an HNSW index, which turns the linear scan into sublinear approximate-nearest-neighbor. The agent code doesn't change — it's the same contract — so 'scaling the corpus' is a store swap I've already built, not a rewrite. How I'd know I'd hit it: I'd measure query latency against corpus size; the moment p50 climbs linearly with chunk count, the scan is the bottleneck."

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "If the data got big I'd add │ "The in-memory store does a  │
│ a real vector database and   │ linear O(n) cosine scan, so  │
│ probably some caching to     │ it's the first bottleneck as │
│ speed things up."            │ the corpus grows. The fix is │
│                              │ already built — buffr swaps  │
│                              │ in pgvector + HNSW behind the│
│                              │ same VectorStore contract,   │
│                              │ which is sublinear ANN. I'd  │
│                              │ know I hit it when p50       │
│                              │ latency climbs linearly with │
│                              │ chunk count."                │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ "A real vector database" and │ Names the exact complexity   │
│ "some caching" are generic.  │ (O(n) scan), the exact fix   │
│ It could describe any system.│ (HNSW, sublinear), that the  │
│ It shows no knowledge of YOUR │ fix is already designed       │
│ bottleneck or YOUR fix.      │ behind the SAME contract, and│
│                              │ the metric that detects it.  │
└──────────────────────────────┴──────────────────────────────┘
```

## Scenario 2 — 10x the concurrent users

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Ten times the users hitting it at once — what gives?"  │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Can you find the SECOND bottleneck, after the obvious   │
│   one? Do you know where the hot path serializes?         │
└─────────────────────────────────────────────────────────┘
```

> "Once the store is on pgvector, the next bottleneck moves to embedding throughput. Every query and every indexed document has to be embedded, and in the local setup that's one Ollama process — `OllamaEmbeddingProvider` calling a single local model server. Under concurrent load that serializes. The fix is in the same shape as the store fix: `EmbeddingProvider` is a contract, so I'd swap the local Ollama embedder for a hosted embedding API that scales horizontally, or put a batching queue in front of it. I haven't built that — it's the honest gap — but the seam is already there to do it. How I'd measure: embedding-call latency under concurrency; when it climbs while query-vector math stays flat, the embedder is the choke point."

The follow-up tree here matters because the second bottleneck has branches.

```
  "10x users — what breaks after the store?"
        │
        ▼
  Embedding throughput at the single Ollama process.
        │
        ├─► IF THEY ASK "why not just batch the embeds?"
        │     "Batching helps index time, where docs arrive in bulk.
        │      It doesn't help query embeds, which are one-at-a-time
        │      and latency-sensitive. For queries I'd scale out the
        │      embedder horizontally behind the contract."
        │
        ├─► IF THEY ASK "what about the model calls themselves?"
        │     "Local Gemma is also one process — same shape. In
        │      production you'd flip the default to a hosted model
        │      behind the ModelProvider port, which scales out. The
        │      port is what makes that a config change."
        │
        └─► IF THEY ASK "where's the queue?"
              "There isn't one yet — no Kafka, no Redis Streams in
               the hot path. That's an honest gap. The contracts give
               me the seam to add one; I haven't needed it at single
               -user scale."
```

## Scenario 3 — 10x more latency-sensitive requests

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "What if these queries had a tight latency budget —     │
│    sub-second?"                                            │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Do you understand where YOUR latency comes from? Can    │
│   you separate the constant cost from the scaling cost?   │
└─────────────────────────────────────────────────────────┘
```

> "The dominant latency in aptkit isn't retrieval — it's the agent loop. It's bounded at maxTurns, 6 for the RAG agent, and each turn is a model call. So the floor is roughly the number of turns times model latency, and with a local model that's the slow part. To hit a tight budget I'd do three things: flip to a faster hosted model behind the port, cut maxTurns where the task allows, and — the structural one — the loop already forces a synthesis turn at the end, so the model can't burn the budget asking for endless tool calls. The bounded loop is a latency guarantee, not just a safety rail. What I can't promise sub-second on is the local-model path; that's a real limit of the default."

```
  ▸ Separate the constant from the scaling cost. Loop latency
    is a fixed tax set by the turn budget — it doesn't degrade
    with load. The cosine scan does. Know which is which.
```

## When you don't know — horizontal scale

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                        ║
║                                                           ║
║   They push: "Okay, now you're at a million queries a     ║
║   day across a fleet. How do you shard the vector store?  ║
║   How do you handle replica lag? Multi-region?"           ║
║                                                           ║
║   This is the wall. You've built a library and a single-  ║
║   user laptop runtime. You have NOT built distributed     ║
║   systems at horizontal scale, sharding, or multi-region  ║
║   replication. Faking it here ends the interview.         ║
║                                                           ║
║   Say:                                                    ║
║   "That's past what I've built. AptKit is a library and   ║
║    buffr is single-user — I haven't run a sharded fleet   ║
║    or dealt with replica lag in production, so I'm not    ║
║    going to invent an answer. What I can reason about is  ║
║    the shape: pgvector lives in Postgres, so sharding and ║
║    replication become Postgres problems, which is a well- ║
║    trodden path I'd lean on rather than reinvent. But the ║
║    operational reality of multi-region under load is      ║
║    territory I'd be learning on the job, and I'd want to  ║
║    pair with someone who's run it."                       ║
║                                                           ║
║   What this signals: a hard, clean boundary on what you've║
║   done, plus the ability to reason structurally up to     ║
║   that boundary, plus zero bluffing. Senior interviewers  ║
║   respect the clean stop far more than a confident guess. ║
║                                                           ║
║   Do NOT say:                                             ║
║   "I'd shard by user ID and use eventual consistency      ║
║    with a leader-follower setup..." — reciting patterns   ║
║   you haven't operated. The first real follow-up exposes  ║
║   it.                                                     ║
╚═══════════════════════════════════════════════════════════╝
```

This is the chapter where the gap is largest — distributed scale is exactly the territory `me.md` names as not-yet-built. The recovery box above is the most important box in the book for you. Practice it until the clean stop feels comfortable, because the instinct under pressure is to keep talking.

## What you'd change

If scale were the goal from the start, you'd build the embedding path for throughput, not just correctness. Right now `OllamaEmbeddingProvider` is one process and there's no batching or queue in the index path — fine for a single user, the second bottleneck under load. You'd put a batching layer behind the `EmbeddingProvider` contract for bulk index operations and design the query embed path to scale horizontally. The contract is already the right seam; you just haven't built the throughput-oriented adapter behind it because single-user never demanded it.

## One-page summary

**Core claim:** You haven't run this at scale, and you say so — but you can name the first bottleneck (linear cosine scan), the second (embedding throughput at one Ollama process), and how you'd measure each, all from your own design.

**Scenarios covered:**
- *100x data* → in-memory O(n) cosine scan breaks first; buffr's pgvector+HNSW (sublinear ANN) behind the same contract is the built fix; detect via latency-vs-chunk-count.
- *10x users* → embedding throughput at the single Ollama process is the second bottleneck; scale the embedder behind the contract; no queue yet (honest gap).
- *10x latency-sensitive* → dominant latency is the loop (turns × model call), a constant tax; bounded loop + forced synthesis is a latency guarantee; local model can't promise sub-second.
- *Horizontal fleet / sharding* → past what you've built; clean stop; reason structurally (pgvector inherits Postgres sharding) without bluffing.

**Pull quote:** Separate the constant from the scaling cost. Loop latency is a fixed tax; the cosine scan degrades with load. Know which is which.

**What you'd change:** Build the embedding path for throughput — batching for bulk index, horizontal scale-out for query embeds — behind the contract that's already there.
