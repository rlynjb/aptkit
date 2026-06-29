# Model selection

**Subtitle:** train both, compare on val, pick the simpler · *Language-agnostic*

## Zoom out, then zoom in

Model selection is one box in the supervised pipeline — the *fit + select* step.
Everything above it (data, features, split) is fixed before you choose; the
starred box is the one decision this file is about: *which algorithm becomes
`f`?*

```
  Zoom out — model selection inside the pipeline (generic; aptkit has none)

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  labeled rows                                                   │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ featurize
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  numeric X, label y                                             │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ split (disjoint)
  ┌─ Split layer ─────────────▼─────────────────────────────────────┐
  │  train · val · test                                             │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit candidates, compare on val
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  ★ SELECT: logistic regression  vs  gradient-boosted trees ★    │
  │     train both → score on val → pick by the metric, then ship   │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. "Model selection" sounds like picking the cleverest algorithm. It
is the opposite: it is a *comparison discipline*. You fit two or three
candidates, grade them on the validation set with the one metric that matters,
and default to the simplest one that wins. The clever model only gets to ship if
it beats the simple one by enough to pay for its added cost. Most beginners reach
for the complex model first; the senior move is to make it earn its seat.

## Structure pass

**Layers.** Candidate algorithms → fit on train → score on val → decision rule →
final report on test. The decision happens entirely on val; test is touched once,
after the winner is chosen, to estimate production performance honestly.

**Axis — simplicity vs capacity.** Trace it: a linear model has *low capacity*
(it can only draw a hyperplane) but is *interpretable, fast, hard to break*.
Gradient-boosted trees have *high capacity* (they capture feature interactions
automatically) but are *opaque, slower, easier to overfit, harder to debug*. Every
selection lives on this axis. You are not choosing "the best model" in the
abstract — you are choosing where on the simplicity↔capacity line your problem
sits, given its operational constraints.

**Seam.** The load-bearing boundary is **the validation set + the metric**. That
pair is the judge. Every candidate is graded by the same judge, and the judge
must never be the test set (that's reserved) and never be your intuition. When
the judge is precision@k on held-out val, "model A is better" becomes a number,
not an argument.

## How it works

### Move 1 — the mental model

You already know aptkit's provider fallback chain. `packages/providers/fallback`
wraps several `ModelProvider`s; you don't pick one by vibes, you order them by a
measured property (does it answer, is it cheap, is it up) and the chain selects.
Model selection is the same move applied to *trained* candidates: you have
alternatives, you grade each with a number, and the number — not your preference
for a fancy algorithm — decides.

```
  Pattern — selection by measured score, not by vibes

   candidates                judge (val set + metric)        winner
  ┌──────────────┐          ┌───────────────────────┐
  │ logistic reg │ ───fit──►│ precision@k on VAL     │──┐
  └──────────────┘          └───────────────────────┘  │
  ┌──────────────┐          ┌───────────────────────┐  ▼  pick by score,
  │ GBT (XGB/LGB)│ ───fit──►│ precision@k on VAL     │──► tie-break to
  └──────────────┘          └───────────────────────┘     the SIMPLER one
       same judge for every candidate · decision is a number
```

Like the fallback chain, the *ordering rule* is explicit and cheap to audit. You
can read off why a model was chosen. "It scored higher on val" is a defensible
sentence; "it felt more powerful" is not.

### Move 2 — the two-candidate bake-off

Concretely: a learned reranker over aptkit retrieval. buffr's
`PgVectorStore.search(vector, k)` returns `{ id, score, meta }[]` ranked by cosine
similarity. A reranker is a model that *re-scores* those candidates per query.
You want to know which algorithm makes a better reranker, so you bake off two.

**Part 1 — fit the simple baseline.** Logistic regression on the per-candidate
feature vector. Linear, interpretable, trains in milliseconds. This is your
floor; nothing ships unless it beats this.

```
  Logistic regression — a weighted sum through a squashing function

   features x = [cosine, doc_len, exact_match]
        │  w·x + b   (one weight per feature — you can READ them)
        ▼
   ┌──────────┐    σ()    ┌──────────────┐
   │  w·x + b │ ────────► │ P(relevant)  │  ── threshold/rank ──► ŷ
   └──────────┘           └──────────────┘
   capacity: a single hyperplane · no feature interactions
```

```python
# PSEUDOCODE — not aptkit code; aptkit ships no trained models.
# X_train/y_train come from the labeled (query, candidate, is_relevant) rows.
baseline = LogisticRegression()
baseline.fit(X_train, y_train)              # fast; convex; one global optimum
# weights are inspectable — this is the interpretability win:
#   baseline.coef_  -> e.g. [+3.1 cosine, -0.2 doc_len, +1.4 exact_match]
val_scores_A = baseline.predict_proba(X_val)   # used to RANK candidates per query
```

**Part 2 — fit the strong contender.** Gradient-boosted trees (XGBoost or
LightGBM). An additive ensemble of small decision trees, each correcting the
previous one's errors. It captures interactions (e.g. "high cosine *and* short
doc") for free, and on tabular data it usually wins.

```
  GBT — many small trees, each fixing the residual of the last

   tree_1      tree_2          tree_3        ...   (additive)
   ┌────┐  +   ┌────┐    +     ┌────┐
   │ <─ │      │ <─ │          │ <─ │   ──►  sum of leaf scores ──► ŷ
   └────┘      └────┘          └────┘
   capacity: high · captures interactions automatically · OPAQUE
```

```python
# PSEUDOCODE — not aptkit code.
contender = GradientBoostedTrees(
    n_estimators=...,   # HYPERPARAMETER — tuned on VAL, never on test
    max_depth=...,      # HYPERPARAMETER — controls capacity / overfit
    learning_rate=...,  # HYPERPARAMETER
)
contender.fit(X_train, y_train)
val_scores_B = contender.predict_proba(X_val)
```

**Part 3 — judge both on val with the metric that matters.** Reuse this repo's
real scorer. For each query, rank candidates by the model's score, take the
top-k, and call `scorePrecisionAtK(rankedIds, relevantIds, k)`
(`packages/evals/src/precision-at-k.ts`). Average across queries. Same judge,
both candidates.

```
  The judge — same metric, every candidate, on the held-out VAL set

   per query q:
     rank candidates by model score ──► topK ids
     scorePrecisionAtK(topK, relevant_q, k) ──► p@k_q

   model_score = mean_q( p@k_q )    on VAL, never on test
   ┌─────────────────────┬─────────────┬──────────────┐
   │ candidate           │ p@5 (val)   │ p50 latency  │
   ├─────────────────────┼─────────────┼──────────────┤
   │ logistic regression │   0.71      │   0.4 ms     │
   │ GBT                 │   0.74      │   6 ms       │
   └─────────────────────┴─────────────┴──────────────┘
```

**Part 4 — apply the decision rule.** Now you have two numbers. The rule is *not*
"highest score wins". It is **pick the simpler model unless the complex one
clearly wins**, where "wins" is weighed against operational cost.

```python
# PSEUDOCODE — the decision is a rule, not a feeling.
margin = score(contender, X_val) - score(baseline, X_val)
if margin > MEANINGFUL_THRESHOLD:   # clearly better, not noise
    chosen = contender              # capacity earned its cost
else:
    chosen = baseline               # Occam: simpler, faster, debuggable, wins ties
# ONLY NOW: report chosen ONCE on the test set for an honest prod estimate.
final = score(chosen, X_test)
```

A 3-point val gain (0.71 → 0.74) often does *not* clear the bar once you price in
GBT's opacity, retrain cost, and latency. If logistic regression is within noise,
you ship logistic regression — it's faster, you can read its weights, and it has
fewer ways to fail silently in production.

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.

### Move 3 — the principle

Selection is a comparison under constraints, not a hunt for the most powerful
algorithm. Train a simple baseline and a strong contender, grade both with the
same metric on val, tune hyperparameters on val (never test), and default to the
simpler model unless the complex one clearly clears a margin that justifies its
operational cost — opacity, latency, retrain pain, more failure modes. Capacity
is a liability until measured benefit proves otherwise.

## Primary diagram

```
  Model selection — the full discipline, with the seam marked

  ┌──────────────┐   fit on    ┌──────────────┐
  │ logistic reg │ ──TRAIN───► │  candidate A │ ─┐
  └──────────────┘             └──────────────┘  │
  ┌──────────────┐   fit on    ┌──────────────┐  │  ★ same judge ★
  │ GBT (XGB/LGB)│ ──TRAIN───► │  candidate B │ ─┤  scorePrecisionAtK
  └──────────────┘             └──────────────┘  │  on VAL  ← THE SEAM
                                                  ▼
                              ┌───────────────────────────────┐
                              │ compare scores + op-cost       │
                              │ tie / small margin → SIMPLER   │
                              │ clear win → complex            │
                              └───────────────┬───────────────┘
                                              │ chosen model
                              ┌───────────────▼───────────────┐
                              │ report ONCE on TEST (honest)   │
                              └───────────────────────────────┘
   tuning lives on VAL · test is touched exactly once, at the end
```

## Elaborate

Two rules carry most of the weight. First, **hyperparameter tuning belongs on
val, not test.** GBT has knobs (`n_estimators`, `max_depth`, `learning_rate`);
every time you peek at test to choose a knob, test stops predicting production —
you've fit to it. The split exists so test stays a sealed estimate; spend val for
all tuning and selection, break the test seal once. Second, **Occam plus
operational cost.** Among models that score within noise of each other, the
simplest is correct by default — it is cheaper to serve, easier to debug, has
fewer failure modes, and is faster to retrain when data drifts. On tabular data
GBT usually does win outright, and when the margin is real you take it. But the
burden of proof is on the complex model, and "usually wins" is a prior, not a
verdict — you still run the bake-off, because *your* features and *your* metric
decide, not the textbook.

## Project exercises

### Bake off two reranker models on buffr retrieval
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that loads the labeled `(query_id, doc_id, features,
  is_relevant)` rows, fits both a logistic-regression reranker and a GBT reranker
  on the train split, and prints a comparison table of mean precision@k on the
  *val* split for each.
- **Why it earns its place:** forces the core discipline — two candidates, one
  judge, decision by number — instead of reaching for the fancy model first.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/rerank-bakeoff.ts` (or
  `.py`), reading `/Users/rein/Public/buffr/eval/queries.json` and the rows
  produced from `/Users/rein/Public/buffr/src/pg-vector-store.ts`
  (`search(vector, k)` → `{ id, score, meta }[]`); grade with
  `scorePrecisionAtK` from
  `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`.
- **Done when:** the table shows both models' mean p@k on val, and the script
  prints which model the decision rule selects (with the margin it used).
- **Estimated effort:** `1–4hr`

### Write the selection decision rule as code, not prose
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a small `selectModel(scoreA, scoreB, margin, opCost)`
  function plus a unit test that encodes "tie or small margin → simpler model;
  clear win → complex model", and only then reports the winner once on test.
- **Why it earns its place:** makes the Occam/operational-cost rule explicit and
  testable — the difference between a defensible selection and a vibe.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/select-model.ts` and a
  test asserting the simpler model wins on a sub-threshold margin; grade inputs
  with `scorePrecisionAtK`
  (`/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`).
- **Done when:** `node --test` passes cases for (a) clear GBT win → GBT, (b)
  within-noise → logistic regression, and (c) asserts the test set is consulted
  only after selection.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "You have logistic regression at 0.71 and GBT at 0.74 on val. Which ships?"**
Probably logistic regression. Three points may be noise, and even if real, GBT
costs opacity, higher latency, more overfit risk, and harder retrains. I'd check
whether the gap clears a meaningful margin and survives across val folds; if it's
within noise, the simpler model wins by Occam. The strong model has to *clearly*
beat the baseline to justify its operational cost — capacity is a liability until
the benefit is measured.

```
  A 0.71      B 0.74        margin small / noisy?
  ───────────────────────►  yes ─► ship SIMPLER (A)
                            clear ─► ship B (cost is paid for)
```
*Anchor: pick the simpler model unless the complex one clearly wins.*

**Q: "Where do you tune hyperparameters, and why does it matter?"**
On the validation set, never on test. The test split is a sealed, one-shot
estimate of production performance. Every time I tune a knob against test, I
leak it into the model and the test score stops predicting prod. So selection and
all tuning happen on val; I break the test seal exactly once, after the winner is
chosen, to get an honest number.

```
  train ─► fit candidates
  val   ─► tune knobs + select winner   (touch freely)
  test  ─► report ONCE                  (sealed until the end)
```
*Anchor: tuning lives on val; test is consulted exactly once.*

## See also

- `01-supervised-pipeline.md` — the arc this selection box lives inside
- `03-train-val-test.md` — why the judge must be val, not test
- `05-evals-and-observability/` — the precision@k scorer used as the judge here
