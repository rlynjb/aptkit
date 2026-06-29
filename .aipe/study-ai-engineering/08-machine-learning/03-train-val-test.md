# Train / validation / test split

**Subtitle:** train fits · val tunes · test reports once · *Industry standard*

## Zoom out, then zoom in

aptkit has no trained model, so the layers below are the *generic* supervised
pipeline. You saw this stack in file 01. This file lives inside the starred box:
how you carve the rows so the number you report actually predicts production.

```
  Zoom out — where the split sits (generic; aptkit has none)

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  raw rows + LABELS                                              │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ feature engineering (file 02)
  ┌─ Feature layer ───────────▼─────────────────────────────────────┐
  │  fixed-width numeric vectors X, label vector y                  │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ split (this file)
  ┌─ Split layer ─────────────▼─────────────────────────────────────┐
  │  ★ train · val · test — disjoint, split at the inference unit ★ │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ fit + select (files 04–08)
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  fitted f(X) → ŷ — graded ONCE on held-out test                │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ ship
  ┌─ Serving layer ───────────▼─────────────────────────────────────┐
  │  new units arrive — the model has never seen them               │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. The split is the one box that protects you from lying to yourself.
A model can memorize its training rows and score perfectly on them — and then
fail the moment a *new* input arrives in production. The split exists to simulate
that new input *before* you ship, by hiding a slice of data and grading on it.
Get the split wrong and every downstream number is fiction. This is the cheapest
box to build and the most expensive to get wrong.

## Structure pass

**Layers.** One labeled dataset → three disjoint subsets. **Train** is what the
model fits on. **Validation** is what you tune knobs and pick models against.
**Test** is the sealed envelope you open exactly once, at the end, to report the
number you'll quote in the PR. Three sets, three jobs, no overlap.

**Axis — where does leakage enter?** Trace any row from raw data to its subset.
Leakage is any path by which information about a test row reaches the model
before scoring: the *same query* split across train and test, the *same user*'s
events on both sides, a *future* fact used to predict a past event, or a feature
computed over the whole dataset before splitting. Every one of these inflates the
test score and the model fails in prod.

**Seam.** The load-bearing boundary is **the split key** — the column you group
by before partitioning. Split by `row` and a per-query model leaks; split by
`query_id` and it holds. The seam is "what unit arrives *new* at inference time?"
You must split at exactly that unit. Everything else follows from naming it.

## How it works

### Move 1 — the mental model

You already know not to test your code against the same fixture you hand-tuned it
to pass — that's grading the answer key. The split is that instinct made
statistical. Train is the practice problems; test is the sealed exam you write
once. If a single exam question appeared in the practice set, the score tells you
nothing about a real student.

```
  Pattern — the sealed envelope

  one labeled dataset
  ┌───────────────────────────────────────────────┐
  │  ████████████████  ██████████  ░░░░░░░░░░░░░░  │
  └───────┬──────────────────┬──────────────┬──────┘
          ▼                  ▼              ▼
     ┌─────────┐        ┌─────────┐    ┌─────────┐
     │  TRAIN  │        │   VAL   │    │  TEST   │
     │ fit on  │        │ tune /  │    │ open    │
     │ these   │        │ select  │    │ ONCE ★  │
     └─────────┘        └─────────┘    └─────────┘
       ~70%               ~15%           ~15%
       (touch freely)   (touch often)  (touch once)
```

You write the split key, not the model. The split decides whether your test
number is a promise or a lie.

### Move 2 — building the split

**Part 1 — split at the inference unit, not the row.** Ask: what arrives *new* in
production? For a learned reranker over aptkit retrieval, a whole *query* arrives
new — never an individual `(query, doc)` row. So you group by `query_id` and send
whole queries to one side. Split by row and the model sees `q1`'s docs in
training, then gets graded on more of `q1`'s docs in test — it has effectively
memorized that query.

```
  Wrong: split by row            Right: split by query_id
  ┌──────────────────┐           ┌──────────────────┐
  │ q1·d4 → TRAIN     │          │ q1·d4 → TRAIN     │
  │ q1·d9 → TEST  ✗   │  leak →  │ q1·d9 → TRAIN     │  q1 whole → TRAIN
  │ q2·d2 → TRAIN     │          │ q2·d2 → TEST      │  q2 whole → TEST
  │ q2·d7 → TEST  ✗   │          │ q2·d7 → TEST      │
  └──────────────────┘           └──────────────────┘
   same query both sides          each query one side only
```

```python
# PSEUDOCODE — group-aware split for a per-query reranker
# rows: (query_id, doc_id, features, label) — many rows share a query_id
def split_by_query(rows, val_frac=0.15, test_frac=0.15, seed=0):
    query_ids = unique(r.query_id for r in rows)
    shuffle(query_ids, seed)                  # randomize the UNIT, not the row
    n = len(query_ids)
    test_ids  = set(query_ids[: int(n*test_frac)])
    val_ids   = set(query_ids[int(n*test_frac): int(n*(test_frac+val_frac))])
    # a query lands wholly in one bucket — never straddles two
    train = [r for r in rows if r.query_id not in test_ids | val_ids]
    val   = [r for r in rows if r.query_id in val_ids]
    test  = [r for r in rows if r.query_id in test_ids]
    return train, val, test
# For a per-USER intent model, the same code with key = r.user_id.
```

**Part 2 — three sets, three jobs.** Train fits the parameters. Val is where you
*choose*: which hyperparameters, which features, which of two models. Every time
you look at val and change something, val gets a little "used up" — that's fine,
it's the tuning set. Test is touched once, after all decisions are frozen,
because the moment you tune against test it becomes another training set and
stops predicting prod.

```
  ┌─────────┐  fit params   ┌─────────┐
  │  TRAIN  │ ────────────► │ model A │
  └─────────┘               └────┬────┘
  ┌─────────┐  score, tune,      │ pick the winner on VAL
  │   VAL   │ ◄──── repeat ──────┘   (look as often as you like)
  └─────────┘
  ┌─────────┐  ONE final score → the number you report
  │  TEST   │ ◄──── open once, never tune against it ★
  └─────────┘
```

```python
# PSEUDOCODE — the three jobs, in order
candidates = [model_simple, model_strong]
fitted = [m.fit(X_train, y_train) for m in candidates]          # TRAIN: fit
best = argmax(fitted, key=lambda f: score(f, X_val, y_val))     # VAL: select/tune
final_number = score(best, X_test, y_test)                      # TEST: report ONCE
# If you now go back and re-tune to beat final_number, test is burned.
```

**Part 3 — temporal split when you predict the future.** If the prediction is
about something that happens *later* (will this user click next week?), a random
split leaks the future into the past. Sort by time and cut: train on the past,
test on the future. Random splitting here lets the model peek at outcomes it
could never know at serve time.

```
  time ──────────────────────────────────────────────►
  ┌──────────────── TRAIN ────────────┬─ VAL ─┬─ TEST ─┐
  │  weeks 1–8                         │ wk 9  │ wk 10  │
  └────────────────────────────────────┴───────┴────────┘
   the cut is a DATE, not a random shuffle
   serving = "predict week 11" — test mimics exactly that
```

**Part 4 — leakage, the silent inflator.** Leakage is any way test-row
information reaches the model before scoring. Most common: featurizing or
normalizing over the *whole* dataset before splitting (the test rows' statistics
bleed into train). Fit transforms on train only, then apply them to val/test.

```
  Wrong order                     Right order
  normalize(ALL rows)             split first
        │                              │
     then split          ──►      fit scaler on TRAIN only
   (test stats leaked)            apply that scaler to VAL/TEST
```

```python
# PSEUDOCODE — fit transforms on train, apply to the rest
train, val, test = split_by_query(rows)
scaler = fit_scaler(train.features)     # statistics from TRAIN only
Xtr = scaler.apply(train.features)
Xva = scaler.apply(val.features)        # test/val never inform the scaler
Xte = scaler.apply(test.features)
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.
The closest real artifact is the eval layer: aptkit's fixtures
(`packages/agents/query/fixtures/*.json`) and replay artifacts
(`artifacts/replays/*.json`) are a held-out test set *in spirit* — graded by
`scorePrecisionAtK`/`scoreRecallAtK` (`packages/evals/src/precision-at-k.ts`) and
`scoreDetections` (`packages/evals/src/detection-scorer.ts`), and never trained
on, because there's nothing to train. They are the sealed envelope without a
model behind it.

### Move 3 — the principle

Split at the unit that arrives new at inference time, and keep the test set
sealed until the end. The split key is the seam: name "what is new in
production?" and group by it. Everything that inflates a test score — query
leakage, user leakage, future leakage, transform leakage — is a failure to
respect that one boundary. *(K-fold cross-validation is the same idea spun: when
data is scarce, rotate which fold is held out across k runs and average — but
each fold still splits at the inference unit, never the row.)*

## Primary diagram

```
  The split, the keys, and the one-shot test

  labeled rows (query_id · doc_id · features · label)
        │
        │  ★ group by INFERENCE UNIT (query_id / user_id / time) ★
        ▼
  ┌───────────┐   fit    ┌───────────┐  select  ┌───────────┐  report once
  │  TRAIN    │ ───────► │  model(s) │ ───────► │   VAL     │ ──────┐
  │  ~70%     │          │           │          │  ~15%     │       │
  └───────────┘          └───────────┘          └───────────┘       ▼
                                                              ┌───────────┐
   transforms fit on TRAIN only, applied outward ───────────►│   TEST    │
   (no whole-dataset normalize · no future · no shared unit) │  ~15% ★   │
                                                              └───────────┘
                                                               opened ONCE
```

## Elaborate

The hard-won lesson: a leaked split produces a *beautiful* test number and a
model that dies in prod, and the failure is invisible until production traffic
arrives. That's why this is the most dangerous box in the pipeline — wrong
features merely underperform, but a wrong split actively lies and tells you to
ship. The discipline is mechanical: name the inference unit first, split on it,
fit every transform on train only, and don't look at test until you've frozen
every decision. The reranker case makes this concrete — `query_id` is the unit
because aptkit retrieval (`PgVectorStore.search()` →
`{ id, score, meta }[]` in `/Users/rein/Public/buffr/src/pg-vector-store.ts`)
returns a ranked list *per query*, and a whole query is what arrives new. Read
file 02 first for where `features` comes from, file 04 for what `fit`/`select`
actually do.

## Project exercises

### Build a group-aware split for the reranker dataset
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that takes the labeled rows (one positive + several
  negatives per query, built from `/Users/rein/Public/buffr/eval/queries.json`
  and the retrieval results) and partitions them into train/val/test *by
  `query_id`*, asserting no `query_id` appears in more than one bucket.
- **Why it earns its place:** group-aware splitting at the inference unit is the
  single most-tested ML correctness skill; doing it by row is the classic
  rejection.
- **Files to touch:** new
  `/Users/rein/Public/buffr/eval/split-rerank-dataset.ts`, reading the labeled
  output and `/Users/rein/Public/buffr/eval/queries.json`.
- **Done when:** running it prints three disjoint sets whose `query_id` sets have
  empty pairwise intersection, and a test asserts that intersection is empty.
- **Estimated effort:** `1–4hr`

### Write the temporal-split design note for a per-user intent model
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a written note that, for a learned replacement of the
  keyword heuristic in `packages/agents/query/src/intent.ts`, decides the split
  key (`user_id` vs row vs time), justifies whether the prediction is about the
  future, and shows where leakage would enter.
- **Why it earns its place:** forces you to name the inference unit and the
  leakage paths *before* writing code — the senior move that prevents a buried
  prod failure.
- **Files to touch:** new
  `/Users/rein/Public/buffr/docs/intent-split-plan.md`.
- **Done when:** the note names the split key, states whether a temporal cut is
  required, and lists the three leakage paths (shared user, future fact,
  whole-dataset transform) with how each is closed.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Why three sets and not just train/test?"**
Because two jobs hide inside "evaluation": *choosing* (which model, which knobs)
and *reporting* (the honest number). If you choose against test, you've tuned to
it and it's no longer held out — it predicts your tuning, not production. Val
absorbs all the looking; test stays sealed for one final score.

```
  TRAIN ─ fit │ VAL ─ choose (look often) │ TEST ─ report (look once ★)
```
*Anchor: val is for selection, test is the sealed envelope opened once.*

**Q: "You split a per-query reranker by row and it scored great. What's wrong?"**
The same `query_id` is on both sides, so the model memorized those queries
instead of learning to rank — the test score is inflated and it'll collapse on
genuinely new queries in prod. Split by `query_id` so a whole query lands in one
bucket; the inference unit is the query, never the row.

```
  by row:  q1 in TRAIN & TEST  → leak → inflated, fails in prod
  by query_id: q1 wholly one side → honest, mimics a new query
```
*Anchor: split at the unit that arrives new at inference time.*

## See also

- `01-supervised-pipeline.md` — the full arc this split lives inside
- `02-feature-engineering.md` — where `features` and the train-only transforms come from
- `04-evals-and-observability/` — how aptkit grades its held-out fixtures today
