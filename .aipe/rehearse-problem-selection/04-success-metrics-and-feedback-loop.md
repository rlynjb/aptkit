# Success Metrics and the Feedback Loop

"It works" is not a metric — it's a vibe. This file replaces the vibe with three observable outcomes the repo can actually produce, and the loop that turns a live run into a regression test. Lead with the loop, because a metric with no loop behind it is a number you measured once and never again.

## The feedback loop — where every metric comes from

Here is the cycle that produces the numbers: a live run becomes a trace, the trace gets scored, a good run gets frozen into a fixture, and the fixture guards against regression forever after.

```
  THE FEEDBACK LOOP — live run to permanent regression test

  ┌─ 1. LIVE RUN ──────────────────────────────────────────────┐
  │  runAgentLoop against Gemma (local) + a real corpus.       │
  │  Bounded by maxTurns/maxToolCalls; forces a synthesis turn.│
  └───────────────────────────────┬────────────────────────────┘
                                  │ emits CapabilityEvent trace
  ┌─ 2. TRACE ────────────────────▼────────────────────────────┐
  │  Every step recorded. In buffr, SupabaseTraceSink persists │
  │  each event to agents.messages. Studio replays it visually.│
  └───────────────────────────────┬────────────────────────────┘
                                  │ score the run
  ┌─ 3. SCORE ────────────────────▼────────────────────────────┐
  │  precision@k / recall@k over the retrieval ·               │
  │  rubric-judge (Claude judges Gemma — anti-circular)        │
  └───────────────────────────────┬────────────────────────────┘
                                  │ run good enough? freeze it
  ┌─ 4. PROMOTE TO FIXTURE ───────▼────────────────────────────┐
  │  Record the ModelResponse[] as a fixture. FixtureModel-    │
  │  Provider replays it deterministically — no network.       │
  └───────────────────────────────┬────────────────────────────┘
                                  │ guard it forever
  ┌─ 5. REGRESSION ───────────────▼────────────────────────────┐
  │  Golden-master replay stays green on every change, or the  │
  │  diff tells you exactly what behavior moved.                │
  └───────────────────────────┬───────────────────────────────┘
                              │ next change → back to step 1
                              └──────────────────────────────► loop
```

The load-bearing part is step 4. Without it, every metric is a one-time measurement that rots the moment you touch the code. The promotion-to-fixture is what makes a passing run *stay* passing — and it's only possible because `FixtureModelProvider` is the same `ModelProvider` contract as the live one, so a recorded run replays through the exact code path.

```
┃ "A metric without the loop is a number I measured once.
┃  The loop is the whole point: a good live run becomes a
┃  fixture, and the fixture catches the regression the next
┃  change would have shipped."
```

## The three success metrics

Three numbers, each tied to one of the three premise-words — reusable, swappable, local. Each is observable in the repo, not aspirational.

```
  THE THREE METRICS — one per premise-word

  ┌─ METRIC 1 · LOCAL IS GOOD ENOUGH ──────────────────────────┐
  │  precision@k / recall@k over a small REAL corpus           │
  │  scorePrecisionAtK / scoreRecallAtK · rubric-judge scores  │
  │  PASS = retrieval ranks the right chunks; Gemma's answers  │
  │         clear the Claude-judged rubric on the real corpus  │
  │  HONEST LIMIT: "small corpus" — not validated at app scale │
  └─────────────────────────────────────────────────────────────┘
  ┌─ METRIC 2 · SWAPPABLE ACROSS REPOS ────────────────────────┐
  │  The one-line VectorStore swap verified across TWO repos:  │
  │  InMemoryVectorStore (aptkit) → PgVectorStore (buffr),     │
  │  same contract, against LIVE Supabase pgvector             │
  │  PASS = buffr's PgVectorStore ranks the planted chunk on   │
  │         top AND throws on a dimension mismatch — same as   │
  │         the in-memory store's test                          │
  │  HONEST LIMIT: proven at n=1 consumer, not generalized     │
  └─────────────────────────────────────────────────────────────┘
  ┌─ METRIC 3 · REUSABLE CLEAN-CLONE ──────────────────────────┐
  │  `npm install @rlynjb/aptkit-core` in a clean buffr clone  │
  │  builds — one tarball, one version, all dist/ inlined      │
  │  PASS = clean clone → install → build green, no "has no    │
  │         exported member" (the files-allowlist gotcha)      │
  │  HONEST LIMIT: tests the bundle, not long-term maintenance │
  └─────────────────────────────────────────────────────────────┘
```

Notice each metric carries its own honest limit. A reviewer hears "precision@k on a small corpus" and trusts it *more* than "great retrieval quality," because the scope is bounded and stated.

## Why the rubric-judge is anti-circular — name it

The metric most likely to draw a "isn't that circular?" challenge is the LLM-as-judge, so the diagram pre-empts it.

```
  ANTI-CIRCULAR JUDGING — different model judges the work

  ┌─ THE WORK ─────────────────────────────────────────────────┐
  │  Gemma2:9b (local) produces the agent's answer             │
  └───────────────────────────────┬────────────────────────────┘
                                  │ judged by a DIFFERENT model
  ┌─ THE JUDGE ───────────────────▼────────────────────────────┐
  │  Claude scores Gemma against a rubric.                     │
  │  Gemma does NOT grade its own homework → not circular.     │
  └─────────────────────────────────────────────────────────────┘
```

If the same model produced and scored the answer, the metric would be self-confirming. Using Claude to judge Gemma breaks that loop — the grader has no stake in the answer looking good.

```
▸ The rubric-judge isn't Gemma grading its own homework.
  A different model (Claude) scores it against a rubric —
  that's what makes the number mean something instead of
  just confirming itself.
```

## What success is NOT — guard the metrics

Be explicit about the outcomes you are *not* measuring, so no one mistakes a missing metric for a hidden failure.

```
  NOT A SUCCESS METRIC HERE

  ┌─ NOT MEASURED — and why that's correct ────────────────────┐
  │  · external user adoption  → there are no external users   │
  │  · revenue / cost savings  → personal tooling, no business │
  │  · query latency at scale  → small corpus, n=1; not the bet│
  │  · ANN recall vs brute force at 1M vectors → out of scope  │
  └─────────────────────────────────────────────────────────────┘
```

The metrics measure the *premise* — reusable, swappable, local — not a product's health, because there's no product. Choosing the right thing to measure is itself the signal.

## The discovery question the metrics leave open

One outcome matters most and the repo can't measure it.

```
  THE UNMEASURABLE METRIC

  Q  Does the portfolio artifact change interview outcomes —
     does building the substrate actually land the pivot?

  · This is the real-world success metric for the whole bet.
  · The repo CANNOT measure it. Only the job search can.
  · discovery: track whether aptkit comes up in interviews
    and whether the substrate-depth story lands. That's the
    only number that tells you the portfolio bet paid off.
```

Listing this is the honest close: the in-repo metrics prove the *engineering* succeeded; only the pivot proves the *investment* did.

## One-screen recap

```
  METRICS IN ONE FRAME

  LOOP    live run → trace → score → promote to fixture →
          regression (step 4 is load-bearing: makes a good
          run STAY good)
  M1      precision@k / recall@k + rubric-judge on a small
          real corpus      → "local is good enough"
  M2      one-line VectorStore swap green across TWO repos
          (InMem → Pg, live)→ "swappable"
  M3      clean-clone `npm i @rlynjb/aptkit-core` builds
                           → "reusable"
  JUDGE   Claude judges Gemma — anti-circular, not self-grading
  NOT     external adoption · revenue · scale latency · ANN recall
  OPEN    does the artifact land the pivot? — only the job
          search can measure it
```

**The one thing to remember:** three metrics, one per premise-word, each carrying its own honest limit — and a loop that turns a good live run into a fixture so the number stays true. The in-repo metrics prove the engineering worked; only the pivot proves the investment did, and that one you can only measure in the interview room.
