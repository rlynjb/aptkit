# The supervised learning pipeline

**Subtitle:** data → features → split → train → deploy · *Language-agnostic*

## Zoom out, then zoom in

aptkit has no ML pipeline, so the layers diagram below is the *generic*
supervised pipeline — the thing every classifier, regressor, and recommender is
built from. The starred box is the whole arc; the rest of this section zooms
into one box each.

```
  Zoom out — the supervised pipeline (generic; aptkit has none)

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  raw rows + LABELS (the thing you want to predict)              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ feature engineering (file 02)
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  fixed-width numeric vectors X, label vector y                  │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ split (file 03)
  ┌─ Split layer ─────────────▼─────────────────────────────────────┐
  │  train · val · test  (disjoint, split at the inference unit)    │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit + select (files 04–08)
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  ★ fitted model: f(X) → ŷ ★   evaluated on held-out test       │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ ship
  ┌─ Serving layer ───────────▼─────────────────────────────────────┐
  │  same feature code at inference; monitor drift (file 15)        │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. "Training a model" is the smallest box in that stack. The arc is
mostly *data plumbing*: getting clean labeled rows, turning them into stable
numeric features, and splitting them so your test score predicts production. An
LLM person already knows the serving end — you call a function, you get an
output. Supervised ML adds everything *left* of serving: you build the function
by fitting it to examples instead of downloading it.

## Structure pass

**Layers.** Data → features → split → model → serving. Each layer hands a
narrower, more numeric artifact to the next. The model layer is where the
"learning" happens, but it is fed entirely by the three layers above it.

**Axis — where does error originate?** Trace a bad prediction backward. Was the
label wrong (data layer)? Was the feature uninformative or computed differently
at inference (feature layer)? Did test leak into train (split layer)? Only if
all three are clean is the error actually the *model's*. Beginners debug the
model; the error is almost always upstream.

**Seam.** The load-bearing boundary is **the feature function** — the code that
maps raw input to the numeric vector `X`. It must run identically at training
time and inference time. Training reads it from a labeled dataset; serving reads
it from one live request. Same function, two callers. When training and serving
compute features differently, every downstream metric lies.

## How it works

### Move 1 — the mental model

You already know precision@k from this repo. `scorePrecisionAtK`
(`packages/evals/src/precision-at-k.ts`) takes *retrieved ids* and *relevant
ids* and returns `matched / min(k, retrieved)`. A supervised pipeline is the
machine that *produces* the thing being scored. Today the "relevant ids" come
from your vector store's similarity sort. In a trained pipeline, a fitted model
produces them — and you grade it with the exact same metric.

```
  Pattern — the pipeline as a function factory

  examples            ┌──────────────┐        a function
  (X, y) ───────────► │  fit / train │ ─────► f: X → ŷ
  labeled rows        └──────────────┘        (deploy this)
                                              │
  one live request ───────────────────────────┘
   (same feature code) ───► f(x) ───► prediction
```

You don't *write* `f`. You write the feature code and pick the algorithm; `fit`
writes `f` for you by minimizing error on the examples.

### Move 2 — the arc, one box at a time

**Data layer — rows with labels.** Supervised means every training row carries
the answer. For a learned reranker over aptkit retrieval, a row is *(query,
candidate document, was-this-the-right-doc?)*. The label is the load-bearing
column; without it there is nothing to learn from.

```
  query_id  doc_id   features…        label (relevant?)
  q1        d4       [0.81, 12, 1]    1
  q1        d9       [0.40,  3, 0]    0
  q2        d2       [0.77,  8, 1]    1
```

**Feature layer — raw → numeric.** Models eat fixed-width numeric vectors, not
prose. The query/doc pair becomes `[cosine_sim, doc_length, has_exact_match]`.
This is file 02, and it is 60–80% of the work.

**Split layer — disjoint sets.** Carve the rows into train / val / test so the
test set contains *units never seen in training* (file 03). For a per-query
reranker, split by `query_id`, not by row — or the same query leaks across sets.

**Model layer — fit and select.** Run `fit(X_train, y_train)`, tune on val,
report once on test. Train a simple model and a strong one, pick the simpler
that wins (file 04).

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study
ground. The closest real artifact is the eval layer (`packages/evals`), which
*grades* outputs with the same metrics a trained pipeline would use, but the
"model" it grades is retrieval + an LLM, never a fitted `f`.

### Move 3 — the principle

A supervised pipeline is mostly *data engineering with a fitting step in the
middle*. The model is one box; the value is in clean labels, honest splits, and
a feature function that runs the same in both worlds. Optimize the pipeline, not
the algorithm.

## Primary diagram

```
  The full arc, with the seam marked

  TRAINING                                    SERVING
  ┌──────────┐                                ┌──────────┐
  │ labeled  │                                │ one live │
  │ rows     │                                │ request  │
  └────┬─────┘                                └────┬─────┘
       │            ★ same feature function ★      │
       ▼  ┌─────────────────────────────────┐  ◄──┘
          │  featurize(raw) → numeric X      │   ← THE SEAM
       ▼  └─────────────────────────────────┘
  ┌──────────┐   split   ┌──────────┐  fit   ┌──────────┐
  │ X_train  │ ────────► │ X_val    │ ─────► │ f: X → ŷ │ ──► prediction
  │ y_train  │           │ X_test   │ report └──────────┘
  └──────────┘           └──────────┘ once
```

## Elaborate

The discipline's hard-won lesson: the algorithm is rarely the bottleneck. Two
teams with the same data and different algorithms usually land within a few
points of each other; two teams with the same algorithm and different *features*
diverge wildly. That is why files 02 and 03 are longer than file 04. The serving
seam (the shared feature function) is also where production failures cluster —
"works in the notebook, fails in prod" is almost always train/serve feature
skew, not a bad model.

## Project exercises

### Build a labeled dataset for a learned reranker
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that reads `/Users/rein/Public/buffr/eval/queries.json`
  and the corpus, runs the existing vector retrieval, and emits a labeled CSV of
  `(query_id, doc_id, cosine_score, doc_len, is_relevant)` rows — `is_relevant`
  from the known answer per query.
- **Why it earns its place:** forces you to produce the *(X, y)* artifact that
  the entire rest of this section consumes. You cannot fake the data layer.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/build-rerank-dataset.ts`,
  reading `/Users/rein/Public/buffr/eval/queries.json` and
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** the script writes a CSV where each query contributes one
  positive row and several negatives, and row counts match
  `queries × candidates`.
- **Estimated effort:** `1–4hr`

### Diagram the train/serve seam for an intent classifier
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a written design note that identifies, for a learned
  replacement of `packages/agents/query/src/intent.ts`, the single feature
  function that must run identically at train and serve time, and where each
  caller lives.
- **Why it earns its place:** the seam is the #1 production ML bug; naming it
  before any code is the senior move.
- **Files to touch:** new `/Users/rein/Public/buffr/docs/intent-classifier-seam.md`.
- **Done when:** the note names the shared `featurize(query)` function and shows
  both call sites (batch training vs single live request).
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Walk me through a supervised pipeline end to end."**
Data with labels → feature function turns raw into numeric `X` → split into
disjoint train/val/test at the inference unit → fit a model, tune on val, report
once on test → deploy the *same feature function* at serving time → monitor for
drift. The model is one box; the rest is data plumbing.

```
  data ─► features ─► split ─► fit ─► test ─► deploy ─► monitor
            ▲ same code reused at serve time ▲
```
*Anchor: the feature function is the seam shared by training and serving.*

**Q: "A prediction is wrong in production. Where do you look first?"**
Upstream, not at the model. Check the label quality, then whether the feature
was computed the same way at serve time as at train time (skew), then whether
test leaked into train. The model is the *last* suspect because it only sees
what those layers feed it.

```
  bad ŷ  ─► label? ─► feature skew? ─► leakage? ─► (only now) model?
```
*Anchor: error originates upstream; debug the data and the seam first.*

## See also

- `02-feature-engineering.md` — the load-bearing feature layer
- `03-train-val-test.md` — the split that makes test predict prod
- `05-evals-and-observability/` — how aptkit grades outputs today
