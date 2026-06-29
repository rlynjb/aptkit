# Domain gap

**Subtitle:** train on one distribution, serve on another · *Language-agnostic*

## Zoom out, then zoom in

Before any definition, here is where a domain gap lives. The supervised pipeline
runs left-to-right; the model is fit on the *train distribution* and then shipped
across a boundary into a *serve distribution*. The starred boundary is where the
gap opens — the model never sees that the world changed.

```
  Zoom out — the train→serve boundary (generic supervised pipeline)

  ┌─ Train world ──────────────────────────────────────────────────┐
  │  rows drawn from distribution  D_train                          │
  │  (one app's queries · one embedding model · one point in time)  │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit  →  f: X → ŷ
  ┌─ Model ───────────────────▼─────────────────────────────────────┐
  │  f learned the shape of D_train and ONLY that shape             │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ ★ DEPLOY — the gap opens here ★
  ┌─ Serve world ─────────────▼─────────────────────────────────────┐
  │  live inputs drawn from distribution  D_serve  ≠  D_train       │
  │  (buffr's personal corpus · a different provider · today)       │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. A *domain gap* is when `D_serve ≠ D_train` at the moment you deploy —
not later, *now*. The model is unchanged and the code is unchanged; only the
*inputs* are drawn from a different distribution than the one `fit` saw. Nothing
errors. The metric you measured on your held-out test set was honest about
`D_train` and silent about `D_serve`. Quality collapses without a stack trace.

## Structure pass

**Layers.** Train world → model → serve world. The model is the middle layer and
it is *frozen* across the deploy boundary: it encodes the geometry of `D_train`
and applies it blindly to whatever arrives.

**Axis — train-distribution-vs-serve-distribution.** The whole topic is one
question asked twice: what distribution produced the rows `fit` saw, and what
distribution produces the rows inference sees? When the answer differs, you have
a gap. Trace the axis through each input dimension — *source* (which app's
queries), *embedding model* (which version produced the vectors), *user* (whose
corpus), *time* (when). A shift on any one is enough.

**Seam.** The load-bearing boundary is the **deploy step itself** — the arrow
marked ★. Above it the model was validated against data it will never see again;
below it the model meets data it was never validated against. Distinguish this
from temporal *drift* (file 15): drift is the serve distribution sliding *over
time after* deploy; a domain gap exists *at* deploy, on day one, because the two
worlds were never the same to begin with.

## How it works

### Move 1 — the mental model

You already grade retrieval with `scorePrecisionAtK` / `scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts`): hand it `retrievedIds` and
`relevantIds`, get back `matched / total`. That score is only meaningful for the
distribution the queries were drawn from. A domain gap is the moment you reuse a
model — or a recorded fixture — across distributions and keep trusting the old
score.

```
  Pattern — one model, two distributions, two truths

   measured here ─┐                         ┌─ trusted here (WRONG)
                  ▼                          ▼
   D_train  ──► fit f ──► precision@k = 0.90 │ D_serve ──► f ──► precision@k = 0.42
   (app A's        (held-out test            │ (buffr's        (nobody measured
    queries)        from D_train)            │  personal corpus) this until prod)
                                             ▲
                              the model is identical; only the inputs moved
```

The trap is that `f` returns confident outputs on `D_serve` exactly as it did on
`D_train`. Confidence is not calibrated across the gap. You only learn the number
fell if you *re-measure on the target distribution*.

### Move 2 — diagnosing and closing the gap

Take the concrete case: a **learned reranker** trained on app A's
queries/corpus, redeployed over buffr's `PgVectorStore`
(`/Users/rein/Public/buffr/src/pg-vector-store.ts`). Buffr's corpus is personal
(`work.md`, `stack.md`, `coffee.md` — see
`/Users/rein/Public/buffr/eval/queries.json`), the query phrasing is different,
and the embeddings come from `nomic-embed-text:v1.5`. Three distribution shifts
at once.

**Spot the shift — compare feature statistics, not vibes.** Before trusting any
model across a boundary, profile the same features on both distributions. A gap
shows up as different means/spreads.

```
  feature            D_train (app A)      D_serve (buffr)     shifted?
  cosine_sim         mean 0.71 sd 0.08    mean 0.52 sd 0.19   ★ yes
  doc_length(toks)   mean 220  sd  40     mean 95   sd 70     ★ yes
  has_exact_match    rate 0.38            rate 0.06           ★ yes
                                          ▲ embeddings from a different model
                                            put cosine on a different scale
```

```text
# PSEUDOCODE — not aptkit code. Profile each feature on both distributions.
def domain_report(train_rows, serve_rows, feature_names):
    for name in feature_names:
        t = column(train_rows, name)          # values seen at fit time
        s = column(serve_rows, name)          # values seen at serve time
        # large gap in mean/sd ⇒ the model's learned thresholds are off-scale
        report(name, mean(t), sd(t), mean(s), sd(s),
               shifted = abs(mean(t) - mean(s)) > 2 * sd(t))
```

**Mitigation 1 — normalization (make the scale match).** If `cosine_sim` lives at
mean 0.71 in train and 0.52 in serve because a *different embedding model*
produced the vectors, the model's learned weights are reading the wrong scale.
Standardize each feature to z-scores so "where it sits relative to its own
distribution" is what the model sees, not the raw magnitude.

```
  raw feature                z-score (per-distribution standardize)
  ┌──────────────┐           ┌──────────────────────────────┐
  │ cosine 0.52  │  ──────►  │ z = (0.52 - μ_serve)/σ_serve │ ──► comparable
  │ (serve)      │           │   = (0.52 - 0.52)/0.19 = 0.0 │     to train z
  └──────────────┘           └──────────────────────────────┘
   absolute scale differs       relative position is preserved
```

```text
# PSEUDOCODE — fit the scaler on TRAIN ONLY, then apply the SAME params at serve.
scaler = fit_standardizer(X_train)            # stores μ, σ per feature
X_train_z = scaler.transform(X_train)         # train on z-scores
# ...later, at inference...
x_serve_z = scaler.transform(x_serve)         # SAME μ, σ — never re-fit on serve
y = f(x_serve_z)
# Caveat: if the SCALE shifted (new embedding model), the saved μ/σ are stale.
# Normalization fixes units; it does not invent target-domain knowledge.
```

**Mitigation 2 — data augmentation (train on variety so f generalizes).** If you
*know* serve inputs will be shorter and noisier, perturb the train rows so `fit`
sees that variety: truncate documents, drop tokens, jitter cosine scores, mix in
paraphrased queries. The model learns a decision boundary that survives the
perturbations instead of memorizing app A's exact shape.

```
  one train row ──► augment ──► many rows covering the serve variety
  q="what stack"          ┌─ q="which tools and stack"   (paraphrase)
  doc=220 toks  ──────────┤─ doc truncated to 95 toks    (length jitter)
  cosine=0.71             └─ cosine += noise(±0.1)        (scale jitter)
```

**Mitigation 3 — domain adaptation (lean toward the target).** Collect a small
batch of *target-domain* labels — real buffr queries with their right doc — and
either fine-tune `f` on them or reweight training so target-like rows count more.
This is the only mitigation that injects actual knowledge of `D_serve`.

```
  D_train (large, cheap)        D_serve labels (small, expensive)
  ┌──────────────┐              ┌──────────────┐
  │ 10k app-A    │   reweight   │ 80 buffr     │
  │ rows         │ ───────────► │ labeled rows │ ──► fine-tune f toward D_serve
  └──────────────┘   or         └──────────────┘
                     fine-tune
   bulk shape                   the shape you actually serve
```

```text
# PSEUDOCODE — collect target labels, then adapt. The honest baseline mitigation.
serve_labeled = collect_labels(real_serve_queries)   # the work nobody wants to do
f_adapted = fine_tune(f, serve_labeled)              # or: refit with sample weights
# Always re-measure on a HELD-OUT slice of the TARGET distribution:
report(scorePrecisionAtK(predict(f_adapted, serve_test), relevant, k))
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.
The closest *real* gap aptkit ships is in fixtures: every recorded fixture was
captured under one provider and one embedding model. Replay an eval under a
*different* provider and you have a domain gap by another name — and
`packages/evals` is exactly the harness that would catch the precision@k drop.

### Move 3 — the principle

A test score is a claim about *one distribution*. The moment you move a model — or
a fixture — across a source, a user, an embedding-model version, or (at deploy)
time, that claim expires. The senior move is to never trust a metric measured on
`D_train` as a prediction for `D_serve`; re-measure on the target, and if you
can't, treat the deploy as unvalidated.

## Primary diagram

```
  The gap, the silence, and the three mitigations

  D_train ─► fit ─► f ─► precision@k = 0.90  (measured, honest about D_train)
                    │
                    │ ★ DEPLOY — no error, no warning ★
                    ▼
  D_serve ─────────► f ─► precision@k = 0.42  (NOT measured until prod)
   │                       ▲
   │  why it dropped:      └─ f reads serve features on the wrong scale
   │                          / shapes it never trained on
   ├─► normalize    : put features on a comparable scale (μ,σ from train)
   ├─► augment      : train on perturbed rows so f covers serve variety
   └─► adapt        : collect target-domain labels; fine-tune / reweight
        then ALWAYS ─► re-measure on a held-out slice of D_serve
```

## Elaborate

The discipline's hard-won lesson: "it worked in the notebook, it died in prod"
is, more often than train/serve *feature skew* (file 01's seam), a train/serve
*distribution* gap — the feature code is identical but the inputs come from a
different world. The two failure modes look the same in a dashboard (precision
fell) and have opposite fixes: skew is a code bug, you make the two callers
identical; a domain gap is a data fact, you cannot code your way out, you must
either normalize the scale, augment toward the variety, or pay for target labels.
The embedding-model version is the sneakiest axis — swapping `nomic-embed-text`
for another model silently re-bases every cosine score, so a reranker tuned on
the old scale degrades with zero code change. Read `15-drift-detection.md` next:
same metric collapse, but the gap opens *over time after* deploy rather than *at*
deploy.

## Project exercises

### Build a domain-gap report between two corpora
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that runs buffr's retrieval over two corpora (e.g.
  the personal corpus vs. a synthetic generic one), computes per-feature stats
  (`cosine_sim`, `doc_length`, `has_exact_match`) on each, and prints a shift
  table flagging features where the means differ by more than 2 train-sd.
- **Why it earns its place:** makes the gap *visible as numbers* before any model
  exists — the only honest way to know a model would transfer.
- **Files to touch:** new
  `/Users/rein/Public/buffr/eval/domain-gap-report.ts`, reading
  `/Users/rein/Public/buffr/eval/queries.json` and
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** the script prints a table with `mean/sd` per feature for both
  corpora and a `shifted?` column, and at least one feature is flagged.
- **Estimated effort:** `1–4hr`

### Re-measure a fixture eval under a swapped embedding model
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** an eval run that scores buffr retrieval with
  `scorePrecisionAtK` under the recorded embedding model, then re-embeds the same
  `queries.json` with a *different* model dimension/version and re-scores — the
  delta is the domain gap, in points.
- **Why it earns its place:** proves the harness in `packages/evals` is what
  catches a silent collapse, and that the embedding-model version is a
  distribution axis, not a config detail.
- **Files to touch:** new
  `/Users/rein/Public/buffr/eval/embedding-domain-gap.test.ts`, using
  `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts` and
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** the test reports two precision@k numbers (original model vs.
  swapped) and asserts the harness surfaces the drop rather than throwing.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "Your reranker scored 0.90 in eval and tanks in production. Walk me through it."**
First I ask whether the production inputs come from the same distribution my test
set did — different app, different user, different embedding-model version, or
just first day on a new corpus. If yes, it's a domain gap: the 0.90 was honest
about the train distribution and silent about the serve one. I re-measure on a
held-out slice of the *target* distribution to size the drop, then choose a
mitigation by *why* it shifted — scale (normalize), variety (augment), or genuine
novelty (collect target labels and adapt).

```
  test 0.90 ─► [is D_serve = D_test?] ─no─► domain gap
                       │yes                  ├─ re-measure on D_serve
                       ▼                      └─ normalize / augment / adapt
                   look elsewhere
```
*Anchor: a test score is a claim about one distribution; re-measure on the target before trusting it.*

**Q: "How is a domain gap different from drift?"**
Same symptom, different *when*. A domain gap exists *at deploy* — `D_serve` was
never equal to `D_train`, so day one is already broken. Drift is `D_serve`
*sliding away over time after* a deploy that started healthy. The gap is a
property of where you shipped the model; drift is a property of time. The gap is
fixed by adaptation/normalization at deploy; drift is caught by monitoring and
re-fitting on a schedule (file 15).

```
  domain gap:  D_train ─┃─► D_serve   (≠ from the first request)
                       deploy
  drift:       D_serve(t0) ──► D_serve(t1) ──► D_serve(t2)   (slides over time)
                  healthy        ...            degraded
```
*Anchor: domain gap is train-vs-serve at deploy; drift is serve-vs-itself over time.*

## See also

- `01-supervised-pipeline.md` — the train/serve seam this gap rides across
- `15-drift-detection.md` — the same metric collapse, but opening over time
- `05-evals-and-observability/` — the harness (`packages/evals`) that catches the precision@k drop
