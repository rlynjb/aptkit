# Calibration

**Subtitle:** when the score is a probability, not just a rank · *Language-agnostic*

## Zoom out, then zoom in

aptkit has no trained model, so the layers diagram below is the *generic*
supervised pipeline again — but this time the starred box is the **score** that
falls out of the model's output, not the model itself. Calibration is a property
of that one box: does the number mean what it says?

```
  Zoom out — where the score lives in a supervised pipeline (generic)

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  labeled rows (X, y)                                            │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ featurize
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  numeric vectors X                                              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  f(X) → raw score s ∈ ℝ  (or a sigmoid output in [0,1])         │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ read the number
  ┌─ Decision layer ──────────▼─────────────────────────────────────┐
  │  ★ score s used as: rank · threshold · expected-value input ★   │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. Every model emits a number per prediction. You can do two things
with that number: **sort by it** (ranking) or **read it as a probability**
(thresholding, expected-value math, combining). Calibration is only about the
second use. A calibrated model's `p=0.8` predictions are right ~80% of the time.
A model can rank perfectly and still lie about the number — and most raw models
do.

## Structure pass

**Layers.** Model → raw score → decision. Calibration is a thin transform you
insert *between* the raw score and the decision layer. It never touches the
model and never changes the ranking; it only re-maps the number onto the
probability axis.

**Axis — is-the-score-a-rank-or-a-probability?** Trace what the downstream
consumer does with the number. If it only ever calls `sort()`, the raw score is
fine — calibration is wasted work. The moment the consumer writes `if (score >
0.7)` or `score_a * 0.6 + score_b * 0.4` or `score * value_if_true`, the number
is being read as a probability, and an uncalibrated number makes those decisions
wrong even when the ranking is perfect.

**Seam.** The load-bearing boundary is **the calibration map** `g(s) → p` — a
monotonic function fit on a *held-out* set that turns raw scores into observed
frequencies. It must be monotonic (so ranking is preserved) and it must be fit on
data the model never trained on (so it reflects real frequencies, not memorized
ones). When you fit it on the training scores, it lies for the same reason a
model overfits.

## How it works

### Move 1 — the mental model

You already have an uncalibrated score in this repo. `PgVectorStore.search(vector,
k)` (`/Users/rein/Public/buffr/src/pg-vector-store.ts`) returns
`Hit = {id, score, meta}`, where `score` is a cosine-similarity-derived retrieval
score. That number is *perfect for ranking* — `scorePrecisionAtK`
(`packages/evals/src/precision-at-k.ts`) only needs the sort order, and it never
reads the magnitude. So today the number being uncalibrated costs you nothing.

The trap is the day someone reads the magnitude. The instant a learned reranker
or a downstream policy writes `if (hit.score > 0.7) answer()`, that `0.7` is a
claimed probability — and a cosine-derived score is not one. Calibration is the
transform that earns you the right to threshold.

```
  Pattern — calibration sits between the model and the decision

  raw score s          ┌──────────────┐      calibrated p
  (good for sort) ────► │  g(s) → p    │ ───► (good for threshold,
  e.g. cosine 0.83      │  monotonic   │      expected value, combine)
                        │  fit on held │
                        │  -out data   │
                        └──────────────┘
   ranking unchanged (g is monotonic) · only the number changes
```

You don't change the model. You learn the map from "what the model says" to
"what actually happens."

### Move 2 — calibration, one part at a time

**The definition — probability matches frequency.** A model is calibrated if,
across all predictions where it said `p=0.8`, the fraction that turn out positive
is ~0.8. Bucket the predictions by their claimed probability and check the
observed rate in each bucket.

```
  Calibrated means: claim ≈ reality, per bucket

  claimed p=0.8 ─► gather all such predictions ─► count positives
                                                   ▼
                  100 predictions at p=0.8 ─► 80 positive  ✔ calibrated
                  100 predictions at p=0.8 ─► 55 positive  �’ overconfident
```

**Why raw scores are uncalibrated.** SVMs return signed distances to a
hyperplane, not probabilities. Boosted trees push scores toward 0 and 1 to
minimize loss. Neural nets with a softmax are routinely overconfident. All three
*rank* well — the highest score is the most-likely-positive — but the number
itself is on its own arbitrary scale. Cosine similarity is the same story: a
great sort key, not a probability.

**The reliability diagram — the one picture.** Plot claimed probability (x) against
observed frequency (y), one point per bucket. A perfectly calibrated model lands
on the diagonal. A typical model sags below it: it claims high probabilities it
doesn't earn (overconfident).

```
  Reliability diagram — diagonal is perfect, sagging curve is overconfident

  observed
  frequency
   1.0 ┤                                            ╱ ★ perfect (y = x)
       │                                        ╱ ·
   0.8 ┤                                    ╱ ·
       │                                ╱ ·         ● model: claims 0.8,
   0.6 ┤                            ╱ ·                observes ~0.55
       │                        ╱ ·         ●·····
   0.4 ┤                    ╱ ·       ●·····
       │                ╱ ·    ●·····
   0.2 ┤            ╱ ·  ●·····
       │        ╱ ·●·····
   0.0 ┼────╱─┬──────┬──────┬──────┬──────┬──────► claimed p
        0.0  0.2    0.4    0.6    0.8    1.0
       ╱ = the ideal diagonal   ●····· = the model's sagging curve
   gap between curve and diagonal = miscalibration
```

The vertical gap between the curve and the diagonal *is* the calibration error.
A curve below the diagonal on the right means "when it says 0.8, reality is 0.55"
— overconfident.

**Fix A — Platt scaling.** Fit a one-parameter logistic regression that maps raw
scores to probabilities, using a held-out set of `(score, label)` pairs. It's a
sigmoid squashed to fit the curve. Cheap, smooth, works when the miscalibration
is roughly sigmoid-shaped (common for SVMs).

```
  Platt scaling — fit a logistic on held-out (score, label) pairs

       raw scores s ─┐
                     ▼
            p = 1 / (1 + exp(A·s + B))     A, B fit on held-out data
                     ▲
   smooth S-curve · 2 parameters · monotonic in s (ranking preserved)
```

```text
  # PSEUDOCODE — illustrative only; aptkit has no such code
  # Inputs: held-out raw scores s[], true labels y[] (0/1)

  A, B = fit_logistic(            # minimize log-loss over the held-out set
           inputs  = s,           # the model's raw scores
           targets = y)           # the actual outcomes

  def calibrate(s):               # the map g(s) → p
      return 1 / (1 + exp(A * s + B))
  # A is negative when higher score → higher p; monotonic, so sort is safe
```

**Fix B — isotonic regression.** Fit a *monotonic step function* to the held-out
`(score, label)` pairs — the best non-decreasing fit. No shape assumption, so it
corrects arbitrary monotonic distortions; the cost is it needs more data and can
overfit small held-out sets.

```
  Isotonic regression — monotonic step fit (no sigmoid assumption)

   p
   1.0 ┤                              ┌──────────
       │                       ┌──────┘
   0.6 ┤                ┌───────┘
       │         ┌──────┘
   0.2 ┤ ────────┘
       └───────────────────────────────────────► raw score s
   non-decreasing steps · follows the data's shape, not a curve
```

```text
  # PSEUDOCODE — illustrative only; aptkit has no such code
  # Fit the best non-decreasing step function on held-out (s, y)

  steps = fit_isotonic(            # pool-adjacent-violators under monotonic constraint
            inputs  = s,           # held-out raw scores, sorted
            targets = y)           # outcomes

  def calibrate(s):                # the map g(s) → p
      return steps.lookup(s)       # the step value covering s
  # monotonic by construction → ranking preserved; flexible but data-hungry
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.

### Move 3 — the principle

Calibration matters exactly when a downstream consumer reads the score *as a
number* — thresholding, expected-value decisions, or combining scores across
sources. It is irrelevant when you only care about rank order. So the senior
move is not "always calibrate"; it's *trace what the consumer does with the
number*, and add the calibration map only at the seam where a rank turns into a
claimed probability.

## Primary diagram

```
  The score's two lives, and where calibration earns its place

  model / retrieval
  ┌──────────────┐  raw score s
  │ f(X) → s     │ ──────────────┬──────────────────────────────┐
  │ (cosine,     │               │                              │
  │  SVM, tree)  │               ▼                              ▼
  └──────────────┘        ┌─────────────┐               ┌──────────────┐
                          │ sort(s)     │               │ g(s) → p     │ ← THE SEAM
                          │ RANK use    │               │ calibrate    │
                          └──────┬──────┘               └──────┬───────┘
                                 ▼                             ▼
                       precision@k, top-k          if p>0.7 · p·value · combine
                       (magnitude ignored)         (magnitude IS the decision)
                       calibration NOT needed       calibration REQUIRED
```

## Elaborate

The discipline's hard-won lesson: ranking quality and calibration are
*independent*. You can have a model with great AUC (perfect ranking) that is
wildly overconfident, and a poorly-ranking model that is perfectly calibrated.
They're measured by different things — AUC/precision@k for ranking, reliability
diagrams and Brier score / expected calibration error for the number. The
classic production bug is shipping a model whose ranking was validated, then
letting a product manager wire a hard threshold (`score > 0.7`) onto the raw
number — now every expected-value and gating decision is silently wrong, and the
offline ranking metric never flagged it because ranking was never the problem.
Always calibrate on *held-out* data, never on the training scores, for the same
reason you never report on the training set: the map would memorize, not
generalize.

## Project exercises

### Build a reliability diagram for buffr retrieval scores
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that runs the existing vector retrieval over
  `/Users/rein/Public/buffr/eval/queries.json`, collects `(Hit.score,
  is_relevant)` pairs across all queries, buckets them by score, and prints a
  text reliability table (bucket → mean claimed score, observed relevant
  frequency, count).
- **Why it earns its place:** makes the abstract "uncalibrated" concrete on a
  number from your own repo — you see the cosine score is a fine *sort* key and a
  bad *probability* on the same data.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/reliability-diagram.ts`,
  reading `/Users/rein/Public/buffr/eval/queries.json` and
  `/Users/rein/Public/buffr/src/pg-vector-store.ts` (using `search()`).
- **Done when:** the script prints one row per score bucket with claimed-vs-
  observed columns over the 3-doc corpus, and you can state which buckets are
  over/underconfident.
- **Estimated effort:** `1–4hr`

### Write the threshold decision note for a learned reranker
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a design note that specifies, for a hypothetical learned
  reranker over aptkit retrieval, exactly where a calibration map would be
  inserted before any `if (score > τ)` gate, and which existing consumers (rank
  vs threshold) would and would not need it.
- **Why it earns its place:** forces the core judgment — naming the seam where a
  rank becomes a claimed probability is the senior decision, not the choice of
  Platt vs isotonic.
- **Files to touch:** new `/Users/rein/Public/buffr/docs/reranker-calibration-seam.md`,
  referencing `/Users/rein/Public/buffr/src/pg-vector-store.ts` and
  `packages/evals/src/precision-at-k.ts`.
- **Done when:** the note states which consumers use rank (no calibration) vs the
  number (calibration required), and pins the held-out-fit rule.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "What does it mean for a model to be calibrated, and when do you care?"**
Calibrated means the claimed probability matches the observed frequency: of 100
predictions at `p=0.8`, ~80 are positive. You care only when a consumer reads the
number — thresholding, expected-value decisions, or combining scores. If you only
sort by the score, calibration is irrelevant because the ranking is unaffected.

```
  rank use  ─► sort(s) ─► top-k        ─► calibration NOT needed
  number use ─► s > 0.7 / s·value / mix ─► calibration REQUIRED
```
*Anchor: calibration matters iff the downstream consumer reads the score as a number.*

**Q: "Your retrieval scores rank fine but a new gate `score > 0.7` behaves
weirdly. Diagnose."**
The cosine-derived `Hit.score` is uncalibrated — a great sort key, not a
probability. `0.7` is a claimed probability the raw score never promised. Build a
reliability diagram on held-out `(score, label)` pairs; the curve will sag off
the diagonal. Fix with Platt scaling or isotonic regression fit on held-out data,
then threshold the *calibrated* `p`, not the raw score. The ranking metrics
stayed fine because ranking was never the problem.

```
  raw cosine s ──(uncalibrated)──► s>0.7 lies
  reliability diagram off diagonal ─► g(s)→p (Platt/isotonic, held-out)
  threshold p, not s ─► gate behaves
```
*Anchor: the gate reads a probability the raw score never was; calibrate the map, keep the sort.*

## See also

- `08-confusion-matrices.md` — what a threshold on the (calibrated) score produces
- `01-supervised-pipeline.md` — where the score's model layer sits
- `05-evals-and-observability/` — how aptkit grades rank-order outputs today
