# Drift detection

**Subtitle:** when production stops looking like training · *Industry standard*

## Zoom out, then zoom in

aptkit has no trained model, so the layers below are the *generic* supervised
pipeline again — the same stack as file 01. The new thing in this file is the
band marked ★: a monitoring loop sitting over the serving layer, watching what
flows through it and feeding signals *back* to the data layer. Drift lives in
that band.

```
  Zoom out — the monitoring band over a deployed pipeline

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  raw rows + LABELS (the distribution you trained on)           │◄─┐
  └───────────────────────────┬─────────────────────────────────────┘  │
                              │ featurize                              │
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐  │
  │  fixed-width numeric vectors X                                  │  │
  └───────────────────────────┬─────────────────────────────────────┘  │
                              │ fit (frozen at ship time)              │
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐  │
  │  fitted model: f(X) → ŷ   (snapshot of the world at training)   │  │
  └───────────────────────────┬─────────────────────────────────────┘  │
                              │ ship                                   │
  ┌─ Serving layer ───────────▼─────────────────────────────────────┐  │
  │ ┌── ★ MONITORING BAND ★ ──────────────────────────────────────┐ │  │ retrain
  │ │  watch P(X) · P(ŷ) · the metric, prod-vs-train over TIME    │ │  │ signal
  │ │  drift? ──► alert ──► investigate ─────────────────────────────┼──┘
  │ └──────────────────────────────────────────────────────────────┘ │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. A fitted model is a *snapshot*. It froze the relationship between
inputs and answers as it stood on training day. The world keeps moving; the
snapshot does not. Drift is the slow divergence between the world the model
remembers and the world it now serves. The monitoring band's whole job is to
notice that divergence *before* the metric craters — and ideally before any
labels arrive, because in production labels are late, expensive, or absent.

## Structure pass

**Layers.** The drift you can measure is layered by *how much you need to know*.
Input drift you can see with zero labels (just compare distributions). Prediction
drift you see from the model's own outputs (still no labels). Performance drift
you can only confirm once labels arrive. Cheapest-to-watch on top, truest-signal
on the bottom.

**Axis — what shifted: the input, the relationship, or the metric?** This is the
whole taxonomy.

- **Data / covariate drift** — `P(X)` moved. New kinds of inputs, new value
  ranges. The model still encodes the old `P(y|X)`, but it is now being asked
  about regions of input space it saw rarely or never.
- **Prediction / label drift** — `P(ŷ)` moved. The mix of outputs the model
  emits changed (suddenly 80% "class A" where it used to be 50%). Often a
  *downstream symptom* of covariate drift.
- **Concept drift** — `P(y|X)` moved. The *relationship itself* changed: the
  same input now deserves a different answer. The input distribution can look
  identical and the model still rots, because the rule it learned is now wrong.
- **Performance drift** — the metric dropped. The honest, final signal — but it
  needs ground-truth labels, which is exactly what you usually lack in prod.

**Seam.** The load-bearing boundary is the **training reference distribution** —
the saved record of what `X`, `ŷ`, and the metric looked like at ship time.
Drift is *always* prod-vs-reference. With no frozen reference you cannot measure
drift at all; you can only measure the present, which tells you nothing about
movement. Save the reference at the same moment you freeze the model.

## How it works

### Move 1 — the mental model

You already have a drift detector in this repo, and it watches performance drift.
`scorePrecisionAtK` / `scoreRecallAtK` (`packages/evals/src/precision-at-k.ts`)
grade retrieval against a *fixed* eval set. Run that fixed set today, get 0.82.
Run the same fixed set next month against the same corpus and embedding stack,
get 0.71. The eval set did not change — so a falling curve is the world (or your
index, or your embedding model) drifting out from under a frozen expectation.
That drop *is* performance drift, measured with the metric you already trust.

```
  Pattern — drift is movement against a frozen reference

      training day                      months later
   ┌───────────────┐                 ┌───────────────┐
   │ reference:    │   compare over  │ production:    │
   │ P(X), P(ŷ),   │ ◄────TIME─────► │ P(X), P(ŷ),    │
   │ metric=0.82   │                 │ metric=0.71    │
   └───────────────┘                 └───────────────┘
          ▲ frozen at ship             ▲ recomputed on a schedule
   drift = the gap, and especially the gap's TREND
```

The single most important word above is **frozen**. One measurement is a point.
Drift is a *slope*. You need the reference and a schedule.

### Move 2 — the four drifts, then how to measure the cheap one

**The drift taxonomy, by what moved.** Walk an example. A learned reranker over
buffr retrieval takes a query, produces relevant doc ids. Here is how each drift
shows up at the seam.

```
  What moved                   What you observe              Need labels?
  ┌──────────────────────┐
  │ covariate  P(X) moved │ ─► new query shapes hit search   ── no
  ├──────────────────────┤     (PgVectorStore.search inputs)
  │ prediction P(ŷ) moved │ ─► output mix shifts              ── no
  ├──────────────────────┤
  │ concept  P(y|X) moved │ ─► same query, "right" doc        ── yes
  │                       │     changed (corpus re-meaning)      (to confirm)
  ├──────────────────────┤
  │ performance metric ↓  │ ─► precision@k falls               ── yes
  └──────────────────────┘
```

The query distribution `P(X)` here is literally the stream of vectors handed to
`PgVectorStore.search(vector, k) → Hit[]` (`/Users/rein/Public/buffr/src/pg-vector-store.ts`).
Watching covariate drift means watching how those inputs shift, no labels
required — which is why it is the workhorse signal in production.

**PSI — the standard covariate-drift measure.** Population Stability Index
compares the *shape* of one feature, training vs production. Bin the feature,
take the proportion of mass in each bin for each population, and sum a
per-bin divergence term. It is symmetric-ish, bounded in practice, and has
rules of thumb everyone in industry shares.

```
  Two histograms of one feature: cosine_similarity of the top hit

  TRAIN (reference)                 PROD (this week)
  bin        %                      bin        %
  [0.0,0.2)  05 ██                  [0.0,0.2)  20 ████████
  [0.2,0.4)  10 ████                [0.2,0.4)  25 ██████████
  [0.4,0.6)  35 ██████████████      [0.4,0.6)  30 ████████████
  [0.6,0.8)  35 ██████████████      [0.6,0.8)  15 ██████
  [0.8,1.0)  15 ██████              [0.8,1.0)  10 ████
                                    ▲ mass slid LEFT: hits got worse-matched
```

The mass slid toward low-similarity bins — prod queries are matching the corpus
worse than training queries did. PSI puts a number on that slide:

```
  PSI = Σ over bins  (prod% − train%) · ln(prod% / train%)
```

Annotated pseudocode (NOT aptkit code — study ground):

```python
# psi(reference, production, bins) -> float
# reference, production: raw values of ONE feature
def psi(reference, production, n_bins=10):
    # 1. Freeze bin edges from the REFERENCE (quantiles is common).
    #    Same edges for both populations — comparing shape, not range.
    edges = quantile_edges(reference, n_bins)

    # 2. Proportion of each population's mass per bin.
    train_pct = histogram(reference,  edges, normalize=True)   # sums to 1
    prod_pct  = histogram(production, edges, normalize=True)   # sums to 1

    total = 0.0
    for t, p in zip(train_pct, prod_pct):
        # 3. Floor empty bins so ln() and division stay finite.
        #    An empty prod bin (p≈0) or empty train bin would blow up.
        t = max(t, 1e-6)
        p = max(p, 1e-6)
        # 4. Per-bin term: signed mass change × log mass ratio.
        total += (p - t) * math.log(p / t)
    return total            # this is the PSI
```

Worked numbers on the histograms above (percentages as fractions):

```
  bin        train(t)  prod(p)   (p−t)    ln(p/t)    term
  [0.0,0.2)   0.05      0.20      0.15     1.386      0.2079
  [0.2,0.4)   0.10      0.25      0.15     0.916      0.1374
  [0.4,0.6)   0.35      0.30     -0.05    -0.154      0.0077
  [0.6,0.8)   0.35      0.15     -0.20    -0.847      0.1695
  [0.8,1.0)   0.15      0.10     -0.05    -0.405      0.0203
                                                     ──────
                                            PSI  =    0.543
```

**Reading PSI — the industry rules of thumb.**

```
  PSI < 0.10   ── stable.        No meaningful shift; do nothing.
  0.10 – 0.25  ── moderate.      Watch it; investigate the cause.
  PSI > 0.25   ── significant.   The input has moved. Investigate, likely retrain.
       │
   0.543 here ──► well past 0.25 ──► this feature has significantly drifted
```

PSI 0.543 is a loud alarm: the similarity distribution your reranker was tuned on
no longer describes production. The model is now being asked questions from a
region of input space it under-saw.

**KS-test aside.** PSI bins, so it is sensitive to bin choice. The
Kolmogorov–Smirnov test is the bin-free alternative for a continuous feature: it
takes the maximum vertical gap between the two cumulative distributions (the KS
statistic `D`) and gives a p-value for "same distribution." Use KS when you want
a hypothesis test on one continuous feature; use PSI when you want a single
monitorable number per feature with shared thresholds across a team. They answer
the same question — "did `P(X)` move?" — with different machinery.

**The cleanest signal, when you have labels.** All of PSI and KS are proxies for
the thing you actually care about: did the model get worse? If labels arrive,
skip the proxies and *watch the metric directly*. A falling precision@k on a
fixed eval set is unambiguous performance drift — no binning, no thresholds, no
inference about cause. Proxies exist only because labels are usually late.

**The monitor → alert → investigate → maybe retrain loop.** Drift detection is
not a one-shot; it is a running loop, and the last step is deliberately
*maybe*.

```
  ┌─────────┐   schedule   ┌─────────┐  threshold  ┌────────────┐
  │ MONITOR │ ───────────► │  ALERT  │ ──crossed──► │ INVESTIGATE│
  │ PSI/KS/ │              │ PSI>.25 │              │  why moved?│
  │ metric  │              │ p@k drop│              └─────┬──────┘
  └─────────┘              └─────────┘                    │
       ▲                                          ┌───────┴────────┐
       │                                          ▼                ▼
       │                                   real concept       upstream bug
       │                                   drift?              (data pipe,
       │                                      │                 bad join)?
       └──────── back to monitoring ──────────┴──► RETRAIN (file 16) or FIX
```

You investigate before retraining because a PSI spike is just as often a broken
upstream join, a units change, or a logging bug as it is genuine concept drift.
Retraining on a *pipeline bug* bakes the bug into the new model. Confirm the
cause, then act.

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study
ground.

### Move 3 — the principle

Drift detection is *measuring movement against a frozen reference, cheapest
signal first*. Watch the inputs when you have no labels (PSI/KS over `P(X)`);
watch the metric when you do (precision@k on a fixed set); never trust a single
measurement — drift is a trend, not a point. And always investigate the cause
before retraining, because half of all "drift" is an upstream bug wearing a
costume.

## Primary diagram

The two faces of the signal: a covariate-drift detector that needs no labels,
and a performance-drift curve that confirms the damage once labels exist.

```
  COVARIATE (no labels)                 PERFORMANCE (needs labels)
  PSI over a feature, per week          precision@k on a FIXED eval set

  PSI                                   p@k
  0.6 │              ●  ◄ >0.25 alert   0.85│●
  0.5 │           ●                     0.80│  ●─●
  0.4 │        ●                        0.75│       ●
  0.3 │─────●──────────── 0.25 line     0.70│          ●─●
  0.2 │  ●                              0.65│              ●  ◄ falling = drift
  0.1 │●                                0.60│
      └──┬──┬──┬──┬──┬──► week              └──┬──┬──┬──┬──┬──► run
        w1 w2 w3 w4 w5 w6                     r1 r2 r3 r4 r5 r6
   input shape moving away from ref       same eval, dropping score
   ◄──────── leads in time ────────────►  ◄──── confirms later ────►
```

The left curve usually moves *first* — inputs shift before the metric visibly
suffers — which is exactly why covariate monitoring buys you lead time.

## Elaborate

The hard-won lesson is that the cheapest signal and the truest signal are
different signals, and you need both. Performance drift (the metric) is the
truth, but it is *lagging*: you only see it after labels arrive, by which time
users already ate the bad predictions. Covariate drift (PSI/KS) is *leading* but
*circumstantial*: `P(X)` can move without hurting the metric (the model
generalizes fine to the new region), and `P(y|X)` can move while `P(X)` sits
perfectly still — pure concept drift, invisible to PSI. So the mature setup runs
PSI per feature for early warning *and* re-runs a labeled eval set for ground
truth, and treats disagreement between them as information. The most dangerous
case is concept drift with stable inputs: every distribution looks fine, the
relationship has silently inverted, and only the labeled metric catches it.

This is distinct from **domain gap** (file 06). Domain gap is a *mismatch present
at deploy time* — you trained on one population and shipped to another, and the
model was wrong from minute one. Drift is a *mismatch that grows over time* in a
deployment that started healthy. Same symptom (prod ≠ train), different clock:
domain gap is a step at `t=0`; drift is a slope after `t=0`. The fix differs too
— domain gap wants a better training set or domain adaptation; drift wants a
monitoring loop and a retraining cadence (file 16).

## Project exercises

### Case B 1 — a PSI monitor over a retrieval feature

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that computes PSI for one retrieval feature — the
  top-hit cosine similarity from `PgVectorStore.search` — comparing a saved
  *reference* window of values against a recent *production* window, and prints
  the PSI plus its band (stable / moderate / significant).
- **Why it earns its place:** PSI is the single most-asked drift question in ML
  interviews, and building it once over a real feature makes the binning,
  flooring, and threshold reading concrete instead of memorized.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/psi-monitor.ts`, reading
  similarity values produced via
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`; reference window saved as a
  small JSON alongside it.
- **Done when:** the script emits a PSI number and the correct band for a
  hand-constructed shifted distribution (verify against the worked example: a
  left-slid histogram yields PSI > 0.25).
- **Estimated effort:** `1–4hr`

### Case B 2 — a performance-drift curve from replay artifacts

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a job that re-runs aptkit's fixed eval set, computes
  precision@k via `scorePrecisionAtK`, and plots the score over time keyed by the
  timestamps in the replay artifacts at
  `/Users/rein/Public/aptkit/artifacts/replays/*.json` — turning a pile of runs
  into a time series.
- **Why it earns its place:** it builds the *truest* drift signal (the metric on
  a frozen eval set) and proves you can assemble a time series from logged
  artifacts — the substrate every real drift dashboard is built on.
- **Files to touch:** new under
  `/Users/rein/Public/aptkit/packages/evals/` (e.g. a `drift-curve` script),
  using `packages/evals/src/precision-at-k.ts` and reading
  `/Users/rein/Public/aptkit/artifacts/replays/`.
- **Done when:** the job outputs an ordered series of `(timestamp, precision@k)`
  points across the replay artifacts, and a falling sequence is visibly distinct
  from a flat one.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "How do you detect drift when you have no labels in production?"**
Watch the input distribution against a frozen training reference. Bin each
feature, compute PSI = Σ (prod% − train%)·ln(prod%/train%) per feature on a
schedule, and alert when PSI crosses 0.25 (KS-test if you want a bin-free
hypothesis test on a continuous feature). It is a *leading* proxy — `P(X)` moving
is circumstantial, so you investigate before retraining — but it is the only
signal available before labels arrive.

```
  ref P(X) ──frozen──┐
                     ▼
  prod P(X) ──► PSI per feature ──► >0.25? ──► alert ──► investigate
   (no labels needed; this is the early-warning line)
```
*Anchor: PSI compares prod-vs-train per binned feature; >0.25 is significant.*

**Q: "What's the difference between domain gap and drift?"**
Same symptom — production doesn't match training — different clock. Domain gap is
a mismatch present at `t=0`: wrong from the first request because you trained on
one population and served another. Drift is a mismatch that *grows* after `t=0`
in a deployment that started healthy. Domain gap is a step; drift is a slope.
Fixes differ: better/adapted training data for gap, a monitoring-and-retraining
loop for drift.

```
  metric                domain gap            drift
        │  ●●●●●●●●●●     low & flat      │ ●●●●●____      starts high,
        │                from minute one  │         ●●●●   slopes down
        └──────────► t                    └──────────► t
            (mismatch @ t=0)                  (mismatch grows)
```
*Anchor: domain gap = mismatch at deploy time; drift = mismatch that grows over time.*

## See also

- `06-domain-gap.md` — the mismatch present at deploy time (drift's static cousin)
- `16-retraining-pipelines.md` — what the "maybe retrain" branch of the loop runs
- `01-supervised-pipeline.md` — the pipeline this monitoring band sits over
- `packages/evals/src/precision-at-k.ts` — the metric that makes performance drift measurable
