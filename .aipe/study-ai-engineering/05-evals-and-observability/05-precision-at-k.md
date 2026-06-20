# precision@k / recall@k — measuring the retriever itself

**Industry names:** precision@k, recall@k, hit@k, top-k retrieval metrics, ranked-retrieval evaluation · *Industry standard*

## Zoom out, then zoom in

Every other rung on the eval ladder scores the *generation* — the answer the
model wrote. This one scores something earlier and dumber: the **retriever**.
Before the model ever sees a token, a vector store returned a ranked list of
chunk ids. precision@k and recall@k ask whether that list was any good. It's the
cheapest scorer in `@aptkit/evals` — a pure function over two lists of ids — and
it measures the part of a RAG system the LLM judge can't see. Here's where it
sits relative to the pipeline it grades.

```
  Zoom out — precision@k vs the retrieval pipeline it measures

  ┌─ RAG query path (@aptkit/retrieval, @aptkit/agent-rag-query) ──────────┐
  │  question ─► embed ─► store.search(vector, k) ─► ranked [id,score,meta]│
  │                              │                         │               │
  │                              ▼                         ▼               │
  │                    InMemoryVectorStore        pipeline.query(q, k)      │
  └──────────────────────────────┬─────────────────────────┬──────────────┘
                                 │ retrievedIds (the ranking)│ then ─► LLM answer
  ┌─ @aptkit/evals — the rung that grades RETRIEVAL ─▼───────┼──────────────┐
  │  precision-at-k.ts                                       │              │
  │    scorePrecisionAtK(retrievedIds, relevantIds, k) ◄── ★ measures the   │
  │    scoreRecallAtK(retrievedIds, relevantIds, k)         ranking, NOT    │
  │  rubric-judge.ts ── LLM-as-judge grades the ANSWER ◄────┘ the answer    │
  └────────────────────────────────────────────────────────────────────────┘
```

Zoom in: a search box you've used a hundred times has the same two questions.
Of the results on page one, how many were actually what you wanted — that's
*precision@k*. Of all the things that would have answered you, how many made it
onto page one at all — that's *recall@k*. precision is "is the top of the list
clean," recall is "did the list miss anything." Both are computed over the top
`k` ids of a ranking against a known set of relevant ids. No model, no tokens,
no judgment call — just set membership and division.

## Structure pass

**Layers.** One file, two public scorers, one private helper. The helper
`countDistinctHits` does the only real work — slice the top-k, dedupe, count
membership. The two scorers differ in *exactly one line*: the denominator. That
single line is the whole conceptual difference between precision and recall, and
the layering makes it impossible to miss.

**Axes.** Two.

```
  Two axes — what's being measured, and against what denominator

  precision@k  ─►  "of the top-k I returned, what fraction was relevant?"
                   denominator = min(k, retrievedIds.length)   ◄ how much I SHOWED
  recall@k     ─►  "of ALL relevant ids, what fraction did I surface in top-k?"
                   denominator = |relevantIds|                 ◄ how much there WAS

  numerator is shared: matched = DISTINCT relevant ids inside the top-k window
```

Same numerator, two denominators. Precision divides by what you *returned*;
recall divides by what *exists*. Push `k` up and recall can only rise (more
chances to surface a relevant id) while precision usually falls (you reach
deeper into the tail). They trade off, which is why you report both.

**Seams.** The load-bearing seam is `ok` versus `score`. `ok` is
**well-formedness**, not a quality gate — it is `false` only when the metric is
mathematically *undefined* (k ≤ 0, or a zero denominator). A perfectly valid
ranking that retrieved nothing relevant scores `0` and is still `ok: true`. This
mirrors `DetectionScoreResult` deliberately: in both, `ok` means "this number is
meaningful," and the *number* — not `ok` — is what you threshold on.

## How it works

You already know how to grade a search result by eye. The scorer is that
instinct turned into two divisions, with the edge cases nailed down so a short
result list or a duplicate id can't silently lie to you.

### Move 1 — the mental model

A ranking is a list of ids in rank order. A relevant set is the ids that *should*
have shown up. precision@k and recall@k both intersect the top-k slice of the
ranking with the relevant set; they differ only in what they divide the hit
count by.

```
  PATTERN — the shared shape of both scorers

  retrievedIds: [ a, b, c, d, e ]   relevantIds: { a, c, e, z }   k = 3
                  └──top-k──┘
                  [ a, b, c ]
                     │
                     ▼  intersect with relevantIds, count DISTINCT
                  matched = { a, c } → 2
                     │
        ┌────────────┴─────────────┐
        ▼ precision                 ▼ recall
   total = min(k, len) = 3     total = |relevant| = 4
   score = 2 / 3               score = 2 / 4
```

The numerator is identical. The only fork is the denominator. Hold that picture
and both functions are obvious; the rest is making the edges honest.

### Move 2 — the step-by-step walkthrough

#### Step 1 — `countDistinctHits`: the load-bearing helper

Slice the top-k window, walk it, collect the relevant ids into a `Set`. The
`Set` is not decoration — it's what makes a repeated id count once.

```
  countDistinctHits — distinctness is the whole point

  retrievedIds = [ a, a, b, c, d ]   relevantIds = { a, c, e, z }   k = 4
                   └─── top-4 ───┘
                   [ a, a, b, c ]
                        │  for each, if in relevantIds → seen.add(id)
                        ▼
                   seen = { a, c }   (the second 'a' adds nothing)
                        │
                        ▼
                   return seen.size = 2     ◄ NOT 3
```

Drop the `Set` and a chunk that appears twice in the window inflates the score —
you'd report `matched: 3` for two distinct relevant ids. We measure relevance
*coverage*, not frequency. This is the skeleton part you cannot remove.

#### Step 2 — `scorePrecisionAtK`: divide by what you returned

Precision's denominator is `min(k, retrievedIds.length)`. The `min` is the
honest part: when fewer than `k` ids came back, divide by the *actual* count, not
`k`, so a short result list isn't penalised for chunks it never had a chance to
return.

```
  EXECUTION TRACE — scorePrecisionAtK(['a','b','c','d','e'], {a,c,e,z}, 10)

  k = 10
  k <= 0 ?                         no
  total = min(10, len=5)           = 5     ◄ k > retrieved, so cap at 5, NOT 10
  total === 0 ?                    no
  matched = countDistinctHits(...) top-10 capped to [a,b,c,d,e] → {a,c,e} = 3
  score   = matched / total        = 3 / 5 = 0.6
  return  { ok: true, score: 0.6, matched: 3, total: 5 }
```

Had it divided by `k = 10`, the same ranking would score `0.3` — punished for
asking for ten and only having five. The `min` is why precision@10 on a 5-doc
corpus is fair. (This is the second precision test, `precision-at-k.test.ts:19-26`.)

#### Step 3 — `scoreRecallAtK`: divide by what exists

Recall's denominator is `|relevantIds|`, the full relevant-set size. Same
numerator, different question: of *everything* that mattered, how much did the
top-k surface?

```
  EXECUTION TRACE — scoreRecallAtK(['a','b','c','d','e'], {a,c,e,z}, 3)

  k = 3
  k <= 0 ?                         no
  total = relevantIds.size         = 4      ◄ the FULL relevant set, not min(k,len)
  total === 0 ?                    no
  matched = countDistinctHits(...) top-3 = [a,b,c] → {a,c} = 2
  score   = matched / total        = 2 / 4 = 0.5
  return  { ok: true, score: 0.5, matched: 2, total: 4 }
```

`z` is relevant but ranked nowhere in the corpus, and `e` sits at rank 5 outside
the top-3 — so recall@3 is 0.5. Grow `k` to 5 and `e` enters the window: recall
climbs to 3/4 (`precision-at-k.test.ts:80-86`). Recall is monotonic in `k`; that
property is the test.

#### Step 4 — well-formedness gates

Both scorers refuse to invent a number when the metric is undefined. `k <= 0` is
nonsense; a zero denominator is division by zero. Either returns the shared
`NOT_WELL_FORMED` sentinel — all zeros, `ok: false`.

```
  ok is WELL-FORMEDNESS, not quality — two distinct meanings of "score 0"

  scorePrecisionAtK([], {a,c}, 5)        ─► ok:false  total:0   (nothing retrieved)
  scoreRecallAtK(rank, {}, 3)            ─► ok:false  total:0   (no relevant set)
  scorePrecisionAtK(['x','y'], {a,c}, 2) ─► ok:TRUE   score:0   (valid: zero hits)

  ok:false  → "I can't compute this"     ok:true, score:0 → "I computed it: bad"
```

The third row is the one people get wrong. A retriever that returned two
irrelevant chunks scored a *real* 0 — that's a measurement, not an error. `ok`
stays `true`. Threshold on `score`; check `ok` only to know the number means
something (`precision-at-k.test.ts:37-67`).

### Move 3 — the principle

This is the cheapest rung that tells you something the generation grader can't.
A rubric judge scoring a wrong answer can't tell you *why* it's wrong — bad
retrieval or bad synthesis. precision@k/recall@k isolates the retriever: if
precision is low, the model never had the right context and no prompt tweak will
save it. Measure the retriever as a pure function of ids, deterministically, for
free, *before* you reach for the LLM judge to grade the prose on top of it.

## Primary diagram

The full file: one helper feeding two scorers that diverge on a single line, with
the well-formedness gates that keep every number honest.

```
  precision-at-k.ts — one helper, two scorers, one differing line

  ┌─ countDistinctHits(retrievedIds, relevantIds, k) ──────── lines 27-34 ─┐
  │   topK = retrievedIds.slice(0, k)                                       │
  │   seen = new Set()                                                      │
  │   for id in topK: if relevantIds.has(id) → seen.add(id)                 │
  │   return seen.size            ◄ DISTINCT hits — dedupe is load-bearing  │
  └───────────────────────────────┬──────────────────────┬─────────────────┘
                  shared numerator │                      │
  ┌─ scorePrecisionAtK ── 47-57 ───▼──┐   ┌─ scoreRecallAtK ── 68-78 ───────▼──┐
  │  if k <= 0 → NOT_WELL_FORMED      │   │  if k <= 0 → NOT_WELL_FORMED        │
  │  total = min(k, retrieved.length)│   │  total = relevantIds.size           │
  │  if total === 0 → NOT_WELL_FORMED│   │  if total === 0 → NOT_WELL_FORMED   │
  │  matched = countDistinctHits(...)│   │  matched = countDistinctHits(...)   │
  │  score = matched / total         │   │  score = matched / total            │
  └──────────────────────────────────┘   └─────────────────────────────────────┘
       ▲ denominator = what I RETURNED         ▲ denominator = what EXISTS
       └────────── the ONLY line that differs ─┘
```

## Implementation in codebase

**Use cases.** This scorer is the **ruler for RAG**. The retrieval pipeline
(`@aptkit/retrieval`) returns a ranked `VectorHit[]` from `pipeline.query`; the
rag-query agent (`@aptkit/agent-rag-query`) drives that ranking through the
`search_knowledge_base` tool. precision@k/recall@k is how you put a number on
"did the ranking surface the right chunks." It already runs as a regression
assertion in the agent's own test suite — package D (evals) grading package B
(retrieval).

**The two scorers**, `packages/evals/src/precision-at-k.ts:47-78`, side by side
with the one differing line called out:

```
  packages/evals/src/precision-at-k.ts  (lines 47-78)

  export function scorePrecisionAtK(retrievedIds, relevantIds, k) {
    if (k <= 0) return { ...NOT_WELL_FORMED };
    const total = Math.min(k, retrievedIds.length);   ◄ what I RETURNED (capped)
    if (total === 0) return { ...NOT_WELL_FORMED };    ◄ nothing retrieved → undefined
    const matched = countDistinctHits(retrievedIds, relevantIds, k);
    return { ok: true, score: matched / total, matched, total };
  }

  export function scoreRecallAtK(retrievedIds, relevantIds, k) {
    if (k <= 0) return { ...NOT_WELL_FORMED };
    const total = relevantIds.size;                    ◄ what EXISTS (full set)
    if (total === 0) return { ...NOT_WELL_FORMED };    ◄ no relevant set → undefined
    const matched = countDistinctHits(retrievedIds, relevantIds, k);
    return { ok: true, score: matched / total, matched, total };
  }
       │
       └─ identical except line 53 vs line 74. The denominator IS the metric.
```

The live wiring, `packages/agents/rag-query/test/rag-query-agent.test.ts:106-111`
— the ranking comes from `pipeline.query`, the ids come from each hit's metadata,
and the scorer grades them against a hand-built relevant set:

```
  packages/agents/rag-query/test/rag-query-agent.test.ts  (lines 106-111)

  const pipeline = await buildPipeline();              ◄ index paris-doc + tokyo-doc
  const hits = await pipeline.query('weather in Paris', 2);  ◄ real ranked retrieval
  const retrievedDocIds = hits.map((hit) => hit.meta.docId as string);
  const { score } = scorePrecisionAtK(retrievedDocIds, new Set(['paris-doc']), 1);
  assert.equal(score, 1, 'the Paris doc should rank first');
       │
       └─ precision@1 == 1 asserts the RIGHT doc ranks first. This is the ruler
          in production use: a number on retrieval quality, no model, no tokens.
```

**Honest scope.** aptkit ships the *scorers* — pure functions over id lists.
That's the ruler. The *live precision@k run over a real corpus* — a durable,
embedded knowledge base with a `PgVectorStore` behind it — lives in the separate
`buffr` repo. aptkit gives you the instrument; buffr does the measuring against
real data. The test above proves the instrument works against an in-memory
corpus; buffr points it at the real one.

## Elaborate

precision@k and recall@k are textbook information-retrieval metrics — older than
RAG by decades — and that's the point: RAG retrieval *is* an IR problem wearing
embeddings, so the IR ruler applies unchanged. The `@k` is the only modern
wrinkle: you never evaluate the whole ranking, only the top window the model
will actually read, because that window is the model's entire view of the corpus.

The contrast with the rubric judge two doors down is the whole reason this rung
exists. The judge is an LLM call — it costs tokens, it varies run to run, and it
carries its own bias. This is a pure function over two lists of strings:
deterministic, free, auditable, and it measures the *retriever* rather than the
*generation*. Different target, different cost class. When a RAG answer is wrong,
the judge tells you the answer is bad; precision@k tells you whether the context
was ever there to be right. You want both, and you want this one first because
it's cheaper and it localises the fault.

The framing that makes this file load-bearing: **measure, then decide.**
Reranking, query rewriting, HyDE — every retrieval upgrade is a guess until you
score precision/recall@k (or hit@k) *before and after*. The rule "don't add
reranking until you've measured" is just words without a scorer to make it
executable. This file is that scorer. The `search_knowledge_base` tool's
`minTopK` floor is exactly the kind of change you'd validate with it: a weak
local Gemma can ask for `top_k: 1` and starve retrieval, so the tool floors the
requested `k` (`packages/retrieval/src/search-knowledge-base-tool.ts`, tested at
`packages/retrieval/test/search-knowledge-base-tool.test.ts:77`). Whether that
floor *helped* is a precision/recall@k question — you measure with the floor and
without, and the numbers decide.

Adjacent: the method ladder this rung lives on
([02-eval-methods.md](02-eval-methods.md)); the detection scorer whose result
shape it mirrors ([02-eval-methods.md](02-eval-methods.md)); the rubric judge
that grades the answer this retriever feeds
([03-llm-as-judge-bias.md](03-llm-as-judge-bias.md)).

## Project exercises

*Provenance: Phase 5 — Evals and observability (C5.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the scorer and a single-assertion
wiring already exist; this hardens that wiring into a real regression gate over a
golden set.*

### Exercise — wire precision@k into the rag-query agent as a regression gate

- **Exercise ID:** `[C5.5]` Phase 5, precision@k concept, Case A (harden)
- **What to build:** Turn the single `precision@1 == 1` assertion
  (`rag-query-agent.test.ts:106-111`) into a real gate. Build a small golden set
  — an array of `{ query, relevantDocIds }` (3-5 entries) — index a corpus, run
  `pipeline.query(query, k)` for each, map hits to `meta.docId`, score with
  `scorePrecisionAtK`, and assert the *mean* precision@k stays above a declared
  floor (e.g. `0.7`). Report `score`, `matched`, `total` per query on failure so
  a regression names which query degraded.
- **Why it earns its place:** One assertion proves the scorer runs; a golden-set
  floor proves *retrieval quality* and catches regressions a single happy-path
  case misses. It also makes "measure before you change retrieval" executable —
  this gate is what would catch a `minTopK` or reranking change that *hurt*.
- **Files to touch:** `packages/agents/rag-query/test/rag-query-agent.test.ts`,
  `packages/evals/src/precision-at-k.ts` (read-only — the scorer is done).
- **Done when:** A test with a 3+ entry golden set asserts mean precision@k above
  a floor and *fails* (with a per-query breakdown) when you intentionally remove
  a relevant doc from the indexed corpus.
- **Estimated effort:** `1-4hr`

## Interview defense

**Q: A RAG answer came back wrong. How do you tell if it's the retriever or the model?**

```
  question ─► [ RETRIEVER ] ─► top-k chunks ─► [ MODEL ] ─► answer
                  │                                 │
        precision@k / recall@k              rubric / LLM-judge
        "was the context there?"            "did it use the context well?"
        pure fn, free, deterministic        tokens, varies, biased
                  └──── score THIS first ────┘
```

"I split the pipeline at the retrieval boundary and measure the retriever first,
because it's free and it localises the fault. I take the ranking
`pipeline.query` returned, map each hit to its doc id, and run `scorePrecisionAtK`
and `scoreRecallAtK` against a golden relevant set —
`packages/evals/src/precision-at-k.ts:47-78`. If precision@k is low the right
context never reached the model and no prompt change will help — fix retrieval.
If precision is high but the answer's still wrong, *now* I cross the
model-in-the-loop seam to the rubric judge. I measure the cheap deterministic
rung before I pay tokens, and I never add reranking or query rewriting until
these numbers say the baseline needs it."
*Anchor: precision@k grades the retriever; the rubric judge grades the answer — score the cheap one first.*

## Validate

- **Reconstruct:** From memory, write both denominators. precision@k divides by
  `min(k, retrievedIds.length)`; recall@k divides by `|relevantIds|`. Check
  against `packages/evals/src/precision-at-k.ts:53` and `:74` — those two lines
  are the only difference between the scorers.
- **Explain:** Why does `countDistinctHits` collect ids into a `Set`
  (`precision-at-k.ts:27-34`) instead of just counting matches in the loop? (So a
  chunk that appears twice in the top-k window counts once — we measure relevance
  coverage, not frequency. Without the `Set`, a duplicate relevant id inflates
  `matched` and the score lies. Verified by `precision-at-k.test.ts:28-35`.)
- **Apply:** A retriever returns `['x', 'y']` for a query whose relevant set is
  `{a, c}`, scored at k=2. What does precision@k return, and is `ok` true?
  (`{ ok: true, score: 0, matched: 0, total: 2 }` — a valid measurement of a bad
  result, not an error. `ok` is well-formedness, not quality.) Trace
  `precision-at-k.ts:52-56` and `precision-at-k.test.ts:61-67`.
- **Defend:** Why keep this pure-function rung when the rubric judge could grade
  the whole answer? (The judge can't see the retrieval — it grades the prose, not
  the context that produced it. precision@k isolates the retriever for free and
  deterministically, so when an answer is wrong you know whether the context was
  ever there. It's also the ruler that makes "measure before adding reranking"
  executable. See `precision-at-k.ts` vs `rubric-judge.ts`.)

## See also

- [02-eval-methods.md](02-eval-methods.md) — the scoring ladder this rung sits on; `DetectionScoreResult` whose shape it mirrors
- [03-llm-as-judge-bias.md](03-llm-as-judge-bias.md) — the judge that grades the answer this retriever feeds
- [04-llm-observability.md](04-llm-observability.md) — running scorers over replay artifacts
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the agent loop whose `search_knowledge_base` ranking this scores
