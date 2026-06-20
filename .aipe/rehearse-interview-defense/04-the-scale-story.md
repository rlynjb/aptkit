# Chapter 4 — The scale story

## Opening hook

Here's the trap in this chapter. An interviewer asks "what breaks first as this scales?" and the weak candidate hears "tell me how you'd make it web-scale" — so they start talking about load balancers and Kafka they never built. You don't have that, and faking it is the fastest way to fail a senior loop. The strong candidate hears the *real* question: do you know your own system well enough to predict its failure order, name the first thing that gives, and tell me how you'd measure to confirm it?

aptkit + buffr is a single-machine personal agent runtime. One device, one user, Gemma running locally on Ollama, a Postgres with pgvector behind it. That's not a weakness to hide — it's the frame. Your job in this chapter is to walk three scale scenarios (100x data, 10x users, 10x latency-sensitive requests) and for each one name the *first* bottleneck, the *second*, what you'd add and **when**, and how you'd **measure** to know you were right. You're not selling scale you don't have. You're showing you know exactly where your system bends and in what order.

```
  THE SCALE-BOTTLENECK MAP — what gives first, by axis

  axis ──────────────►  load grows  ──────────────────────────────►

  ┌─ (a) 100x DATA ───────────────────────────────────────────────┐
  │  few docs ──► 100k+ chunks                                     │
  │                                                                │
  │  1st: InMemoryVectorStore.search — O(n·d) linear cosine scan   │
  │       (re-scores EVERY chunk per query)                        │
  │  2nd: embedding throughput on bulk re-index                    │
  │  fix WHEN: corpus > a few thousand chunks                      │
  │  → swap to PgVectorStore + HNSW (same VectorStore contract)    │
  │  measure: query latency + precision@k / recall@k               │
  └────────────────────────────────────────────────────────────────┘

  ┌─ (b) 10x USERS / MULTI-APP ───────────────────────────────────┐
  │  one device, one user ──► many apps on shared agents schema   │
  │                                                                │
  │  1st: NO isolation — app_id is a column, not a boundary        │
  │  2nd: no API — callers import the runtime, can't call it       │
  │  fix WHEN: before app #2 touches the schema                    │
  │  → RLS on agents.* (A1) then Edge Functions API (A2)           │
  │  measure: cross-tenant read attempts blocked (auth tests)      │
  └────────────────────────────────────────────────────────────────┘

  ┌─ (c) 10x LATENCY-SENSITIVE REQUESTS ──────────────────────────┐
  │  occasional ask ──► many concurrent hot-path turns            │
  │                                                                │
  │  1st: local Gemma inference latency (seconds-scale per turn)   │
  │  2nd: embedding round-trips per query                          │
  │  fix WHEN: p95 turn latency crosses the budget you set         │
  │  → batch embeds / quantized model / cache / cloud-escalate     │
  │  measure: p50 + p95 turn latency, tokens per turn              │
  └────────────────────────────────────────────────────────────────┘

  honest floor: horizontal scale, queues, multi-region = NOT built.
```

That's the whole chapter in one frame. Three axes, and for each the failure order is *known*, not hand-waved. Now let's walk each scenario the way you'd say it in the room.

---

## Scenario (a) — 100x data

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "Your corpus is a handful of docs now. What happens    │
│    when it's a hundred thousand chunks?"                 │
│                                                          │
│ WHAT THEY'RE TESTING                                     │
│   Do you know the complexity of your own retrieval       │
│   path? Can you name the first thing that degrades —     │
│   and is it the thing you'd actually hit, or a generic   │
│   "the database gets slow"? Do you know the fix is a     │
│   drop-in, or would you panic-rewrite the pipeline?      │
└─────────────────────────────────────────────────────────┘
```

The strong answer starts with the picture, because you think in pictures and so does the interviewer once you draw it. Here's the shape of the bottleneck.

```
  The O(n·d) scan — why search slows linearly with the corpus

  InMemoryVectorStore.search(queryVec, k)   [in-memory-vector-store.ts:25]
        │
        ▼
  for each chunk in this.chunks.values():   ← touches ALL n chunks
        score = cosineSimilarity(queryVec, chunk.vector)  ← d mults each
        hits.push({ id, score, meta })
        │
        ▼
  hits.sort(desc by score)                  ← O(n log n) on top
  return hits.slice(0, k)

  cost per query = O(n · d)
    n = chunk count,  d = 768 (nomic dimension)
  100x more chunks  →  100x the per-query work. Linearly.
```

> "My retrieval is an exact O(n·d) cosine scan today. That's the right call for a few docs and the wrong call for a hundred thousand chunks — and I know it, because I built it behind a contract so I can swap it without touching the pipeline."

**Here's the first-person answer.**

I'd say: "Today retrieval is `InMemoryVectorStore.search` in `packages/retrieval/src/in-memory-vector-store.ts`. It's an exact cosine scan — it walks every chunk in the map, scores each one against the query vector, sorts, and slices the top-k. That's O(n·d): n is the chunk count, d is 768 because nomic embeds at 768 dimensions. So the *first* bottleneck at 100x data is query latency on that scan — it grows linearly with the corpus. At a few docs it's nothing. At 100k chunks every single query re-scores all 100k vectors.

The second bottleneck is embedding throughput on bulk re-index — every chunk has to be embedded once, and if I swap the embedder I have to re-embed the whole corpus because the dimension is a one-way door.

The fix is already designed for. `search` sits behind the `VectorStore` contract in `contracts.ts` — `upsert` and `search`, that's the whole surface. buffr's `PgVectorStore` implements that exact contract and is backed by an HNSW index — that's the `chunks_embedding_hnsw` index in `buffr/sql/001_agents_schema.sql`, `using hnsw (embedding vector_cosine_ops)`. HNSW is an approximate-nearest-neighbor index, so it stops being O(n) per query — it's roughly logarithmic. The pipeline doesn't change at all; I swap which `VectorStore` I wire in. **When** I'd do it: once the corpus crosses a few thousand chunks, because below that the linear scan is faster than the index lookup overhead anyway.

How I'd measure to know it worked: two numbers, not one. Query latency, obviously. But the one people forget — **precision@k and recall@k**, which I already have scorers for in `packages/evals/src/precision-at-k.ts`. HNSW is *approximate*. It can quietly drop recall — return a fast answer that's missing a chunk the exact scan would've found. So I measure recall@k before and after the swap. If latency drops but recall@k drops with it, the index is too aggressive and I tune it. That's the trap with ANN — you can make it fast and not notice it got worse."

That answer lands because it names the seam (the `VectorStore` contract), the successor (`PgVectorStore` + HNSW), the trigger (a few thousand chunks), and the *two* measurements — and the recall one is the part that signals you've actually thought about ANN, not just heard the acronym.

### The load-bearing part people forget

The interviewer is waiting to see if you'll say "I'd add HNSW and it's faster" and stop. The senior move is the second sentence: *approximate means recall can silently regress.* Naming precision@k/recall@k as the guard — not just latency — is the part that separates "I read about vector indexes" from "I'd actually ship one and watch it." The scorers exist in the repo. Point at them.

```
┌─────────────────────────┬─────────────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER                   │
├─────────────────────────┼─────────────────────────────────┤
│ "At 100k chunks I'd     │ "First bottleneck is the O(n·d) │
│ move to a real vector   │ cosine scan in                  │
│ database. pgvector or   │ InMemoryVectorStore.search — it │
│ Pinecone. It'd be way   │ re-scores every chunk per       │
│ faster."                │ query. The VectorStore contract │
│                         │ is the swap seam: buffr's       │
│                         │ PgVectorStore + an HNSW index   │
│                         │ drops in with zero pipeline     │
│                         │ change. I'd swap past a few      │
│                         │ thousand chunks. I measure query│
│                         │ latency AND recall@k — HNSW is  │
│                         │ approximate, so I watch that it │
│                         │ doesn't silently drop recall."  │
├─────────────────────────┼─────────────────────────────────┤
│ Why it's weak:          │ Why it works:                   │
│ "real vector database"  │ Names the exact function and    │
│ and "way faster" are    │ its complexity, names the seam  │
│ guesses. No complexity, │ that makes the fix cheap, names │
│ no seam, no trigger, no │ the trigger and — critically —  │
│ measurement. It sounds  │ the recall risk of ANN with the │
│ like you read a blog,   │ scorer that catches it. This is │
│ not built the pipeline. │ someone who built it.           │
└─────────────────────────┴─────────────────────────────────┘
```

Here's how the conversation branches after you give the strong answer.

```
  "What breaks first at 100x data?"
        │
        ▼
  You give the O(n·d) scan → VectorStore contract → HNSW answer.
        │
        ├─► IF THEY ASK "why is the swap free?"
        │     The pipeline only calls store.search(vec, k) and
        │     store.upsert(chunks). Both InMemoryVectorStore and
        │     PgVectorStore implement that contract. The pipeline
        │     never names a vendor. Point at contracts.ts.
        │
        ├─► IF THEY ASK "how does HNSW work internally?"
        │     This is the "I don't know" line. See the box below.
        │     Own the boundary; don't bluff graph internals.
        │
        ├─► IF THEY ASK "what about re-indexing cost?"
        │     Real. Embedding dimension is a one-way door — swap
        │     the embedder and you re-embed the whole corpus. The
        │     chunks.embedding_model column tracks which model
        │     produced each vector; a reindex command is deferred
        │     work in buffr's next-moves (B2).
        │
        └─► IF THEY ASK "why not start with pgvector?"
              Because zero-cloud build came first. In-memory let me
              build and test the whole pipeline with no Postgres
              running. The contract meant that choice cost me
              nothing later.
```

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                       ║
║                                                          ║
║   They push past the swap and ask how HNSW actually      ║
║   works internally — the layer graph, the greedy search, ║
║   ef_construction vs ef_search tuning. You picked it on  ║
║   pgvector's defaults; you have not gone deep on the     ║
║   algorithm.                                             ║
║                                                          ║
║   Say:                                                   ║
║   "I haven't gone deep into HNSW's internal graph        ║
║    construction — the layered navigable small-world      ║
║    structure. What I know is the shape: it's an          ║
║    approximate index that trades exact recall for        ║
║    sub-linear search, and the knob I'd actually watch    ║
║    is the recall@k regression, which I have a scorer     ║
║    for. If you want to walk the layer-graph mechanics,   ║
║    start me off and I'll reason through it."             ║
║                                                          ║
║   What this signals: you know the boundary of your       ║
║   knowledge, you know the operational consequence        ║
║   (recall tradeoff) even without the internals, and      ║
║   you'll engage in real time. All three are senior.      ║
║                                                          ║
║   Do NOT say:                                            ║
║   "It's a graph thing where it hops between nodes that   ║
║    are sort of close and... finds the nearest ones       ║
║    fast?" — vague bluffing in territory you don't own    ║
║    is the surest way to lose the room.                   ║
╚═══════════════════════════════════════════════════════════╝
```

---

## Scenario (b) — 10x users / multi-app

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "This is one user on one laptop. What breaks when      │
│    you point ten users — or a second app — at it?"       │
│                                                          │
│ WHAT THEY'RE TESTING                                     │
│   Do you know your isolation story? Can you tell the     │
│   difference between an app_id COLUMN and an actual      │
│   tenant BOUNDARY? Will you overclaim multi-tenancy you  │
│   don't have, or name the gap and the exact migration    │
│   that closes it?                                        │
└─────────────────────────────────────────────────────────┘
```

This is the scenario where honesty is the whole answer. The temptation is to point at the `app_id` column and call it multi-tenancy. It isn't, and a senior interviewer will catch it in one follow-up. Draw the real picture.

```
  app_id is a column, not a boundary

  ┌─ Today: single device, single user ───────────────────┐
  │                                                        │
  │   agents.chunks                                        │
  │     app_id text not null default 'laptop'  ← a COLUMN  │
  │     ...                                                │
  │   index chunks_app_id on (app_id)          ← keyed     │
  │                                                        │
  │   isolation = "every query remembers to filter         │
  │                by app_id" = by CONVENTION only          │
  │                                                        │
  │   ANY caller can read/write ANY app's rows.            │
  └────────────────────────────────────────────────────────┘
            │  add app #2  →  the convention is the only wall
            ▼
  ┌─ Deferred: real isolation (buffr next-moves A1/A2) ───┐
  │                                                        │
  │   A1: Row-Level Security on agents.*                   │
  │       USING (app_id = jwt claim)  ← a BOUNDARY now     │
  │   A2: Edge Functions API in front of the SQL           │
  │       (/agents/search, /agents/documents)              │
  │                                                        │
  │   the schema is ALREADY app_id-keyed → RLS is a        │
  │   migration, not a redesign.                           │
  └────────────────────────────────────────────────────────┘
```

> "The schema is app_id-keyed, but that's a column, not a wall. Today isolation is by convention — any caller can read any app's rows. RLS is the migration that turns the column into a boundary, and the schema was built knowing that."

**Here's the first-person answer.**

I'd say: "First, the honest frame: this is a single-device, single-user tool right now. So the first bottleneck at 10x users isn't performance — it's *isolation*. The `agents` schema in buffr is already `app_id`-keyed — every table has `app_id text not null default 'laptop'`, and there's a `chunks_app_id` index on it. But that's a column, not a boundary. Isolation across `app_id` today is by convention — any caller can read or write any app's rows. That's fine for one user on one laptop. It's the single blocker before app #2.

The fix is the first item in buffr's next-moves doc, A1: row-level security on `agents.*`, with policies keyed by an `app_id` claim derived from the auth token — never trusted from the client. Because the schema is *already* `app_id`-keyed, RLS is a migration plus auth wiring, not a redesign. The second piece, A2, is an Edge Functions API in front of the SQL — `/agents/search`, `/agents/documents` — so other apps call the agent over HTTPS instead of importing the runtime directly. Direct `pg` is fine for one local client; multiple apps need an API. A2 depends on A1, because the API is the multi-tenant entry point and RLS is what makes it safe.

**When** I'd do it: A1 before a second app or user ever touches the schema. It's a hard prerequisite, not an optimization. How I'd measure: this one isn't a latency number — it's correctness. I'd write auth tests that attempt cross-tenant reads — app A's token trying to read app B's rows — and the measure is that every one of those is blocked at the database. RLS that you don't test is RLS you don't have.

What I would *not* claim is that this is built. It's deliberately deferred. Horizontal scale, load balancing, queues across many users — that's not in this system, and I'd be honest that I haven't built distributed systems at that scale."

That last sentence is not a confession — it's a signal. Naming the deferral and the gap, with the exact migration that closes it, reads as someone who knows the difference between what they shipped and what they'd ship next. That's the senior move.

```
┌─────────────────────────┬─────────────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER                   │
├─────────────────────────┼─────────────────────────────────┤
│ "It's already multi-    │ "It's single-tenant today.      │
│ tenant — there's an     │ app_id is a column, not a       │
│ app_id on every table,  │ boundary — isolation is by      │
│ so each app's data is   │ convention, any caller can read │
│ separated. It'd scale   │ any app's rows. First fix is    │
│ to more apps fine."     │ RLS keyed on an app_id JWT      │
│                         │ claim (next-moves A1), then an  │
│                         │ Edge Functions API (A2). The    │
│                         │ schema's already app_id-keyed,  │
│                         │ so RLS is a migration, not a    │
│                         │ redesign. I'd do A1 before app  │
│                         │ #2 and test it with cross-      │
│                         │ tenant read attempts that must  │
│                         │ all be blocked."                │
├─────────────────────────┼─────────────────────────────────┤
│ Why it's weak:          │ Why it works:                   │
│ Confuses a column with  │ Names the gap precisely         │
│ enforcement. A column   │ (column vs boundary, isolation  │
│ you have to remember to │ by convention), names the exact │
│ filter on is not        │ migration, names the trigger    │
│ isolation. One follow-  │ (before app #2), and measures   │
│ up — "what stops app A  │ with an auth test, not a vibe.  │
│ reading app B?" — and   │ Honest about the deferral       │
│ this answer collapses.  │ instead of overclaiming.        │
└─────────────────────────┴─────────────────────────────────┘
```

```
  "What breaks at 10x users?"
        │
        ▼
  You give the isolation answer: app_id is a column, RLS is the fix.
        │
        ├─► IF THEY ASK "what exactly stops app A reading app B today?"
        │     Nothing but convention. Say it plainly. That honesty
        │     IS the answer — the gap is real and named.
        │
        ├─► IF THEY ASK "why didn't you build RLS up front?"
        │     Single user, single device. RLS with no second tenant
        │     is overhead with no payoff. The schema was built
        │     app_id-keyed so the migration is cheap when it's needed.
        │
        ├─► IF THEY ASK "how do you handle load from many users?"
        │     This is the deferral line. Horizontal scale, queues,
        │     load balancing — not built. Don't fake it. Name it as
        │     deferred architecture (next-moves section C).
        │
        └─► IF THEY ASK "where does app_id come from — the client?"
              Never the client. From the auth token's claim. Trusting
              an app_id sent by the caller would defeat RLS entirely.
```

---

## Scenario (c) — 10x latency-sensitive requests

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                 │
│   "What happens to latency when requests pile up and     │
│    they're time-sensitive?"                              │
│                                                          │
│ WHAT THEY'RE TESTING                                     │
│   Do you know where the seconds go in a single turn?     │
│   Can you separate inference latency from retrieval      │
│   round-trips? Do you have a measurement plan, or just   │
│   a list of optimizations you'd "try"?                   │
└─────────────────────────────────────────────────────────┘
```

The honest anchor here is one observation, and you should frame it exactly as what it is: an anecdote, not a benchmark. Draw where the time goes in a single turn.

```
  Where the seconds go in one RAG turn

  user question
       │
       ▼
  ┌─ embed the query ─────────────┐  round-trip to Ollama /api/embed
  │  OllamaEmbeddingProvider      │  (local HTTP :11434)
  └───────────────┬───────────────┘
                  ▼
  ┌─ search ──────────────────────┐  fast today (in-memory scan)
  └───────────────┬───────────────┘
                  ▼
  ┌─ Gemma generates ─────────────┐  ◄── THE COST: seconds-scale
  │  local inference on Ollama    │      local token generation
  │  + may loop (maxTurns 6,      │      per turn, and the loop
  │    maxToolCalls 4)            │      can run several turns
  └───────────────┬───────────────┘
                  ▼
  ┌─ embed again if it re-searches┐  another round-trip per search
  └───────────────┬───────────────┘
                  ▼
              final answer

  1st bottleneck: local Gemma inference latency (seconds per turn)
  2nd bottleneck: embedding round-trips, one per search the model does
```

> "The seconds are in local generation, not retrieval. One tool-call turn I watched ran around seven seconds — that's an anecdote, not a benchmark, and I'd say so. The honest answer to 'how slow' is 'I'd measure p95, I haven't yet.'"

**Here's the first-person answer.**

I'd say: "The first bottleneck is local Gemma inference latency. The default provider runs Gemma on Ollama locally — seconds-scale per turn. I'll give you a concrete anchor, but I want to be clear it's an anecdote, not a benchmark: I watched one tool-call turn take around seven seconds. One observation, not a measured p95. The agent loop can also run several turns — `maxTurns` is 6, `maxToolCalls` is 4 in the rag-query agent — so a multi-turn answer stacks that latency.

The second bottleneck is embedding round-trips. Every search embeds the query through `OllamaEmbeddingProvider` — a round-trip to Ollama's `/api/embed`. If the model searches more than once in a turn, that's more round-trips. One thing I already do right: the embedder batches. `embed(texts[])` takes an array, so when I index a document all its chunks go in *one* call, not one call per chunk.

The fixes, roughly in the order I'd reach for them: batch embeds where I'm not already — that's mostly done on the index path. Then a smaller or quantized Gemma model to cut generation time. Then response caching for repeated questions. And the escape hatch for genuinely hot paths: escalate to a cloud model. aptkit already has the provider-fallback chain — `FallbackModelProvider` in `packages/providers/fallback` — so I can put a cloud model behind local Gemma and route hot requests to it instead of eating the local latency. buffr's next-moves B1 is exactly this: wrap Gemma in the fallback chain.

**When** I'd reach for each: I wouldn't, until I'd set a latency budget and measured against it. Which is the real answer to how I'd measure — p50 and p95 turn latency, plus tokens per turn so I know whether a slow turn is the model being slow or the model generating too much. Right now I have single observations, not a distribution. The first thing I'd actually do is instrument the turn so 'it feels slow' becomes a p95 number I can hold a budget against."

The strength here is the refusal to inflate the anecdote into a benchmark, paired with a concrete measurement plan. Saying "I'd measure p95, I haven't yet" is stronger than inventing a number, because the interviewer knows you can't have a real distribution from a personal tool and they're testing whether you'll pretend you do.

### The load-bearing part people forget

Everyone lists optimizations — quantize, cache, batch. The part that signals seniority is *gating them on a measurement you don't have yet*. "I wouldn't tune anything until p95 crosses a budget I set" is the line. It says you optimize against numbers, not vibes — and it's honest that the numbers aren't there yet on a single-device tool.

```
┌─────────────────────────┬─────────────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER                   │
├─────────────────────────┼─────────────────────────────────┤
│ "Gemma's fast enough.   │ "First bottleneck is local      │
│ It runs locally so      │ Gemma inference — seconds per   │
│ there's no network      │ turn. I watched one tool-call   │
│ latency. If it got slow │ turn run ~7s, but that's an     │
│ I'd just cache things   │ anecdote, not a benchmark.      │
│ or use a bigger         │ Second is embedding round-trips │
│ machine."               │ per search. Fixes in order:     │
│                         │ batch embeds (mostly done),     │
│                         │ quantized model, response       │
│                         │ cache, or escalate hot paths to │
│                         │ a cloud model via the           │
│                         │ FallbackModelProvider chain. I  │
│                         │ wouldn't tune anything until I  │
│                         │ measured p50/p95 turn latency   │
│                         │ and tokens per turn against a   │
│                         │ budget — which I haven't yet."  │
├─────────────────────────┼─────────────────────────────────┤
│ Why it's weak:          │ Why it works:                   │
│ "fast enough" with no   │ Separates inference latency     │
│ number, treats local as │ from retrieval round-trips,     │
│ free (it's the SLOWEST  │ marks the anecdote as an        │
│ part), and "bigger      │ anecdote, names the existing    │
│ machine" doesn't scale  │ batching, names the real escape │
│ concurrent requests.    │ hatch (fallback chain), and     │
│ No measurement at all.  │ gates the work on a p95 budget. │
└─────────────────────────┴─────────────────────────────────┘
```

```
  "What happens to latency under load?"
        │
        ▼
  You give the local-inference-first answer with the p95 plan.
        │
        ├─► IF THEY ASK "how slow exactly?"
        │     "One turn I watched, ~7 seconds — an anecdote, not a
        │      benchmark. I don't have a measured p95 yet; that's
        │      the first thing I'd instrument." Don't invent a
        │      distribution you don't have.
        │
        ├─► IF THEY ASK "what about concurrent requests?"
        │     This is the deferral line. No queue, no worker pool,
        │     no load balancing. Single device serializes. Name it
        │     as not built (the honest gap), don't fake a queue.
        │
        ├─► IF THEY ASK "why not just always use a cloud model?"
        │     Local-first is the whole point — privacy, no key, no
        │     per-token cost, works offline. Cloud is the escape
        │     hatch for hot paths via the fallback chain, not the
        │     default. That's a deliberate tradeoff, not a gap.
        │
        └─► IF THEY ASK "where's the embedding cost?"
              One round-trip per search to Ollama /api/embed. Index
              path already batches a doc's chunks into one embed()
              call. Query path embeds one query per search the model
              decides to run.
```

---

## What you'd change

If I were building this for scale from day one — which I wasn't, and that was correct — I'd put the measurement in before the optimizations. The honest weak spot in this chapter isn't the missing HNSW index or the deferred RLS; those are deliberate deferrals with clear triggers. The real gap is that I'm reasoning about latency from single observations, not a p95 distribution. The first thing I'd add is turn-level instrumentation — timestamp every step of the agent loop, record tokens per turn, build the latency histogram — so that every "what breaks first" answer in this chapter is backed by a number instead of an anecdote. The bottleneck *order* I'm confident about. The bottleneck *magnitudes* I'd want measured before I touched anything. And I'd say exactly that in the room: I know the order, I'd measure the magnitudes before optimizing.

---

## One-page summary — the night before

**Core claim:** I know my system's failure order across three axes, name the first bottleneck for each, the fix and its trigger, and — critically — how I'd *measure* to confirm it. I don't fake scale I haven't built; I name the deferrals.

**The three scenarios, one line each:**

- **(a) 100x data** — 1st bottleneck: `InMemoryVectorStore.search` is an O(n·d) linear cosine scan (`in-memory-vector-store.ts`). 2nd: bulk re-index embedding throughput. Fix: swap to buffr's `PgVectorStore` + **HNSW** index — free, because both implement the `VectorStore` contract. **When:** past a few thousand chunks. **Measure:** query latency **and** recall@k (ANN can silently drop recall — scorers in `precision-at-k.ts`).
- **(b) 10x users / multi-app** — 1st bottleneck: no isolation. `app_id` is a column, not a boundary; isolation is by convention. 2nd: no API, callers import the runtime. Fix: **RLS** keyed on an `app_id` JWT claim (next-moves A1), then **Edge Functions API** (A2). **When:** A1 before app #2. **Measure:** cross-tenant read attempts all blocked (auth tests). Honest: single-device tool today.
- **(c) 10x latency-sensitive** — 1st bottleneck: local Gemma inference (seconds/turn; ~7s on one observed turn — **anecdote, not benchmark**). 2nd: embedding round-trips per search. Fix: batch embeds (mostly done), quantized model, response cache, or escalate hot paths to cloud via `FallbackModelProvider`. **When:** once p95 crosses a budget. **Measure:** p50/p95 turn latency + tokens per turn.

**The honest floor:** horizontal scale, hot-path queues, load balancing, multi-region — **not built**. Deferred deliberately (next-moves section C). I defer; I don't fake.

**Pull quotes to carry in:**

```
┃ "My retrieval is an exact O(n·d) cosine scan — the right
┃  call for a few docs, the wrong call for 100k chunks, and
┃  I built it behind a contract so the fix costs nothing."
```

```
┃ "app_id is a column, not a boundary. Isolation is by
┃  convention today. RLS is the migration that turns the
┃  column into a wall."
```

```
        ▸ I know the bottleneck order. I'd measure the
          bottleneck magnitudes before touching anything.
          That's the difference between a plan and a guess.
```

**What you'd change:** Instrument the turn first — build the p95 latency distribution — so every scale answer is backed by a number, not an anecdote. The order I'm sure of; the magnitudes I'd measure before optimizing.
