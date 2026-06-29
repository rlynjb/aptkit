# Success Metrics and Feedback Loop

*Brief-answer 9: the observable outcomes that say the substrate earned its
keep, and the loop that keeps them honest.*

No vanity metrics. No invented numbers. Three observable checks, each
grounded in code that exists in the repos today. Two measure "the RAG
works." The third measures "the *substrate* works" — the thing the build
decision was actually betting on.

```
  The three metrics, mapped to what each one proves

  metric                     proves                    evidence (real file)
  ──────                     ──────                    ────────────────────
  1. precision@k /           retrieval surfaces the    scorePrecisionAtK /
     recall@k                right chunks, not noise   scoreRecallAtK
     (over a small                                     (packages/evals/src/
      REAL corpus)                                      precision-at-k.ts:47,68)

  2. rubric-judge score      the generated answer is   rubric-judge
                             grounded + cited, not     (packages/evals/src/
                             hallucinated              rubric-judge.ts)

  3. the swap held           the CONTRACT is the       PgVectorStore
     (InMemory → Pg,          right boundary — the     implements VectorStore
      one line, two           build premise itself     (buffr/src/
      repos) + clean-                                  pg-vector-store.ts:19),
      clone build                                      wired buffr/src/
                                                       session.ts:41
```

---

## Metric 1 — retrieval quality: precision@k / recall@k

```
  Ranked-retrieval scoring — the shape

  query ──► embed ──► search store ──► ranked hits [h1 h2 h3 ... hk]
                                              │
                                  ┌───────────┴───────────┐
                                  ▼                       ▼
                       precision@k = relevant     recall@k = relevant
                       among top-k / k            found / all relevant
```

▸ **What it measures:** does the from-scratch retrieval pipeline put the
  right chunks in the top-k for a *real* corpus (not a synthetic toy set)?
▸ **Why it's the first metric:** RAG answer quality is capped by retrieval
  quality. If the right chunk isn't retrieved, no model fixes it.
▸ **The honest caveat:** the corpus is small and real, not a benchmark
  dataset. The number is directional for *this* substrate, not a
  leaderboard claim. State it that way.

---

## Metric 2 — answer quality: rubric-judge

▸ **What it measures:** given retrieved context, is the answer grounded in
  it and cited — or did the model wander off the source?
▸ **Why it's separate from metric 1:** you can retrieve perfectly and still
  generate a bad answer. Metric 1 grades the retrieval; metric 2 grades
  the generation on top of it. Both, or you can't tell which half failed.
▸ **The mechanism behind it:** the rag-query agent
  (`packages/agents/rag-query`) composes Gemma + `search_knowledge_base` +
  `injectProfile` so the model *decides when to search* and answers with
  citations — rubric-judge then scores that output.

---

## Metric 3 — the swap held (the load-bearing metric)

This is the one that validates BUILD over ADOPT. The other two would pass
even if aptkit were a single-app library. Only this one proves the contract
crosses a repo boundary.

```
  The one-line swap, across two repos — what the contract bought

  ┌─ aptkit (the substrate) ─────────────────────────────────┐
  │  VectorStore  ◄── contract (load-bearing)                 │
  │  InMemoryVectorStore  implements VectorStore              │
  │  (cosine scan, dev/test default)                          │
  └────────────────────────────┬───────────────────────────────┘
                               │  published as @rlynjb/aptkit-core@0.4.1
                               │  buffr pins "^0.4.1"
                               ▼
  ┌─ buffr (the consumer) ───────────────────────────────────┐
  │  PgVectorStore  implements VectorStore  ← SAME contract   │
  │  (buffr/src/pg-vector-store.ts:19)                        │
  │  wired in:  const store = new PgVectorStore({...})        │
  │  (buffr/src/session.ts:41)                                │
  └────────────────────────────────────────────────────────────┘

  swap cost = one line: which VectorStore you new up.
  no rewrite of the RAG pipeline, the agent, or the eval harness.
```

▸ **What it measures, concretely:**
  1. `PgVectorStore implements VectorStore` — the swap is satisfying one
     contract, not forking the pipeline. **Verified** (file:line above).
  2. **Clean-clone build:** `npm install @rlynjb/aptkit-core` in a fresh
     buffr checkout builds and runs RAG against Supabase/pgvector.
▸ **Why it's load-bearing:** if this fails, the substrate is a single-app
  library wearing a contract costume, and the skeptic's "just adopt
  LangChain" wins retroactively. This metric is the build decision's
  scoreboard.

┃ The strongest in-repo confirmation arrived *before* buffr: `@aptkit/memory`
┃ reuses the same `EmbeddingProvider`/`VectorStore` contracts with zero new
┃ infrastructure (`remember` = index path, `recall` = query path). A second
┃ consumer of the contract existed inside aptkit itself — buffr's
┃ `PgVectorStore` is the cross-repo confirmation on top.

---

## The feedback loop — how the metrics stay honest

The metrics aren't a one-time report card. They run on a replay-centric
loop that turns a live run into a regression baseline.

```
  Replay-centric feedback loop (context.md: the testing/observability backbone)

  ┌─ live run ──┐   ┌─ artifact ──┐   ┌─ eval ──────────────┐
  │ agent loop  │──►│ JSON trace  │──►│ structural-diff /   │
  │ emits NDJSON│   │ + output    │   │ detection /         │
  │ trace       │   │ (artifacts/ │   │ rubric-judge /      │
  └─────────────┘   │  replays/)  │   │ precision@k         │
        ▲           └─────────────┘   └──────────┬──────────┘
        │                                        │ promote
        │           ┌─ deterministic replay ─────▼──────────┐
        └───────────│ FixtureModelProvider replays recorded │
          regression│ ModelResponse[] → same eval, no model │
          guard     │ calls (promoted fixtures = baselines) │
                    └────────────────────────────────────────┘
```

▸ A good run gets **promoted to a fixture** — a frozen correctness baseline
  (`fixtures/promoted/*.json`). Replaying it later, deterministically,
  catches regressions without spending model calls.
▸ This closes the loop: metric 1 and 2 don't drift silently, because the
  promoted fixture re-runs the same scorers on the same recorded responses.

**Known loop gap (honest):** `rubric-improvement` has no `replay:promoted`
script wired into the root pipeline (context.md notes/open items). The loop
is real but not yet uniform across every agent.
