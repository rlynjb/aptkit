# Success Metrics and Feedback Loop

Answer 9: how "it worked" becomes **observable** — not a feeling, a measurement — and the loop that closes so success keeps being true as the code changes. Coach posture: a metric a reviewer can't picture you checking is a wish, not a metric. Every one below names *what you run* and *what number or state you read.*

## The honest framing first

There are no users, so there are **no user-outcome metrics** — no retention, no conversion, no DAU. Inventing them would be the fastest way to lose the room. The metrics here measure the two things this problem is actually about: **does the retrieval work** (quality), and **is the substrate actually reusable** (the premise).

```
  TWO FAMILIES OF METRIC — quality + reuse, no user metrics

  ┌─ QUALITY (does RAG return the right thing?) ─────────────┐
  │  precision@k / recall@k over a small REAL corpus          │
  │  rubric-judge score on grounded answers                   │
  └────────────────────────────────────────────────────────────┘
  ┌─ REUSE (is the substrate actually reusable?) ────────────┐
  │  one-line VectorStore swap verified across TWO repos       │
  │  clean-clone `npm install` builds in buffr                 │
  └────────────────────────────────────────────────────────────┘
```

## The three success metrics

### Metric 1 — retrieval quality: precision@k / recall@k over a small real corpus

```
  WHAT YOU RUN                          WHAT YOU READ
  ─────────────                          ─────────────
  scorePrecisionAtK(ranked, relevant)  → precision@k  (0..1)
  scoreRecallAtK(ranked, relevant)     → recall@k     (0..1)
  over a SMALL, REAL corpus              trend across runs, not
  (not a synthetic benchmark)            an absolute target
```

- **EVIDENCE:** the scorers exist and are the published surface — `scorePrecisionAtK` / `scoreRecallAtK` in `packages/evals/src/precision-at-k.ts`. The corpus is deliberately small and real (`02` in-scope trims).
- **What "success" means here:** retrieval ranks relevant chunks above irrelevant ones, *measurably*, so a regression shows up as a number dropping — not as a user complaint that never comes (there are no users). **No target number is invented**; the metric is the *instrument*, and the success criterion is that the instrument exists and the number is tracked across runs.

### Metric 2 — answer quality: rubric-judge on grounded answers

```
  WHAT YOU RUN                  WHAT YOU READ
  ─────────────                  ─────────────
  rubric-judge over an          → per-dimension scores +
  agent's grounded answer         weakest dimension
  (LLM-as-judge against          (feeds the rubric-improvement
   an explicit rubric)            agent's next-action loop)
```

- **EVIDENCE:** `rubric-judge` in `packages/evals/src/rubric-judge.ts`; the `rubric-improvement` agent scores a subject against a rubric and emits the weakest dimension + next action (`context.md` agents). This is the qualitative complement to precision@k — precision@k says *did we retrieve right*, rubric-judge says *did we answer right*.

### Metric 3 — the reuse proof: one-line VectorStore swap, two repos, clean install

This is **the metric that validates the whole premise.** The other two measure quality; this one measures whether "reusable" is true.

```
  THE REUSE PROOF — observable in TWO states

  state 1: THE SWAP WORKS
  ┌──────────────────┐  same VectorStore contract  ┌──────────────────┐
  │ aptkit           │ ──────────────────────────► │ buffr            │
  │ InMemoryVector   │                             │ PgVectorStore    │
  │ Store (cosine)   │  swap = ONE binding at edge │ (Supabase        │
  │                  │  agent code UNTOUCHED        │  pgvector)       │
  └──────────────────┘                             └──────────────────┘
        verified by: buffr/test/pg-vector-store.test.ts passes

  state 2: CLEAN-CLONE INSTALL BUILDS
  ┌──────────────────────────────────────────────────────────┐
  │  fresh clone → npm install @rlynjb/aptkit-core → build     │
  │  succeeds in buffr (the standalone bundle is self-          │
  │  contained: 16 bundledDependencies, no monorepo needed)    │
  └──────────────────────────────────────────────────────────┘
```

- **EVIDENCE (state 1):** two implementations of one `VectorStore` contract — `InMemoryVectorStore` in `packages/retrieval/src/in-memory-vector-store.ts`, `PgVectorStore` in `/Users/rein/Public/buffr/src/pg-vector-store.ts` — with the contract at `packages/retrieval/src/contracts.ts:33`. Tested at `/Users/rein/Public/buffr/test/pg-vector-store.test.ts`.
- **EVIDENCE (state 2):** buffr depends on `"@rlynjb/aptkit-core": "^0.4.1"` (`buffr/package.json`); the standalone tarball inlines all 16 internal packages via `bundledDependencies` (`scripts/pack-core-standalone.mjs`, `context.md` publishing).
- **PARTIALLY OPEN (honest):** "clean-clone install builds" is the one metric the brief flags as *verify, don't assume* (`01` discovery questions). The success criterion is binary: a fresh clone + `npm install @rlynjb/aptkit-core` + build in buffr exits zero. Run it; read the exit code.

## The feedback loop — how success stays true

A metric without a loop decays the moment the code changes. aptkit's loop is its **replay-centric evaluation backbone**, and it's already wired.

```
  THE FEEDBACK LOOP — live run → artifact → eval → fixture → replay

  ┌─ live run ─────┐   emits NDJSON trace + output
  │ agent loop     │ ─────────────────────────────────►┐
  └────────────────┘                                    │
                                                        ▼
  ┌─ artifact ─────────────────────────────────────────────┐
  │  artifacts/replays/*.json  (output + trace + eval)       │
  └────────────────────────────┬─────────────────────────────┘
                               │ score it
  ┌─ eval ─────────────────────▼─────────────────────────────┐
  │  structural-diff · detection-scorer · rubric-judge ·      │
  │  precision-at-k   → ReplayArtifactEvalSummary             │
  └────────────────────────────┬─────────────────────────────┘
                               │ promote the good ones
  ┌─ fixture ──────────────────▼─────────────────────────────┐
  │  fixtures/promoted/*.json  — timestamped correctness       │
  │  baselines, replayed by FixtureModelProvider               │
  └────────────────────────────┬─────────────────────────────┘
                               │ replay deterministically
  ┌─ replay ───────────────────▼─────────────────────────────┐
  │  re-run against the baseline → regression shows as a       │
  │  number/diff, NOT a silent drift                           │
  └────────────────────────────────────────────────────────────┘
```

- **EVIDENCE:** this is `context.md`'s "Replay-centric evaluation" seam — live run → artifact → eval → promote to fixture → deterministic replay, named "the testing/observability backbone." The pieces: `replay-runner` + `ReplayArtifactEvalSummary` (`packages/evals`), promoted fixtures replayed by `FixtureModelProvider`, scripts `eval-replay-artifacts` / `promote-replay-to-fixture` / `replay-promoted-fixtures`.
- **Why the loop closes the metrics:** Metric 1 (precision@k) and Metric 2 (rubric-judge) aren't run once and forgotten — they're scorers *inside* this loop, so every promoted fixture carries a baseline a future change is measured against. A drop in precision@k on replay is the regression signal that, without users, you'd otherwise never get.
- **Honest gap in the loop:** the `rubric-improvement` agent has **no `replay:promoted` script wired into the root pipeline** while the others do (`context.md` notes). So the loop is closed for most agents and *open at one node*. Naming the open node is the metric-honesty move.

## What is NOT a success metric (and why)

```
  ✗ user retention / DAU / conversion  — no users, by design
  ✗ revenue / cost savings             — no customers; not a product
  ✗ a third consumer existing          — >1 consumer is a non-goal (02)
  ✗ benchmark-leading precision@k      — small REAL corpus, not a
                                          leaderboard; trend > absolute
```

▸ The load-bearing metric is **Metric 3, the reuse proof** — it's the only one that tells you the *problem* got solved, not just that a component works. precision@k and rubric-judge can both look great while the substrate is still un-reusable. The two-repo swap is what closes the loop on the premise itself.

## See also

- `02-scope-cuts-and-non-goals.md` — the small-real-corpus trim behind Metric 1
- `05-skeptical-reviewer-questions.md` — "how do you know it works with no users?" defended
- `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts` — the ranked-retrieval scorers
- `/Users/rein/Public/buffr/test/pg-vector-store.test.ts` — the reuse proof, executable
