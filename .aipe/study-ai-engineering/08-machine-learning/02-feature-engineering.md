# Feature engineering (turning raw signals into model inputs)

**Industry names:** feature engineering, feature transforms, preprocessing, feature pipeline · *Industry standard*

## Zoom out, then zoom in

This is the second box on the pipeline conveyor from `01`. Raw data goes in; a
matrix of numbers a model can actually fit on comes out. It's the most
underrated stage — more model performance is won here than in model selection.

```
  Zoom out — feature engineering inside the pipeline

  ┌─ OFFLINE conveyor (from 01) ───────────────────────────────────────────┐
  │                                                                         │
  │  raw data ──► ★ FEATURES ──► split ──► fit ──► evaluate ──► freeze       │
  │   (events,    (THIS FILE)    (03)     (04)     (08)         (the seam)   │
  │    rows,        │                                                        │
  │    text)        ▼                                                        │
  │            X matrix:  rows × numeric columns the model consumes          │
  └─────────────────────────────────────────────────────────────────────────┘
                                                  online side applies the
                                                  SAME transforms (or skew)
```

Zoom in: AptKit ships no features because it ships no model. Your anchor is a
software primitive you use constantly — **data transformation / mapping**: you
take a record and project it into the shape a downstream consumer needs. Feature
engineering is exactly that, with one rule that doesn't exist in ordinary
mapping: any transform that *learns a parameter from the data* (a mean, a
standard deviation, a category vocabulary) must learn it from **training data
only**, then apply it everywhere. The pattern: **features are a learned mapping,
and the learning must be fenced to the training split.**

## Structure pass

**Layers.** Two kinds of transform, and the distinction is the whole concept.
**Stateless** transforms compute a value from a single row in isolation — parse a
timestamp into hour-of-day, take a ratio of two columns. **Stateful** (or
*fitted*) transforms compute a parameter *across rows* first, then apply it — z-score
needs the column's mean and std; one-hot encoding needs the set of categories
seen. The layer boundary is "does this transform need to look at other rows?"

**Axis — where does information flow?** Trace *information* through a transform.
In a stateless transform, information flows only within a row: nothing leaks. In
a stateful transform, information flows *from the dataset into the parameter* and
then back into every row. That backward flow is the danger: if the dataset it
learned from included your test or future rows, those rows' information has
leaked into the features the model trains on.

**Seam.** The load-bearing seam is **fit vs. transform**. A fitted transform has
two phases: `fit(train)` learns the parameter, `transform(anything)` applies it.
The seam is the rule that `fit` only ever touches the training split. Cross that
seam — fit the scaler on the full dataset before splitting — and you've committed
the most common leakage bug in the field. It's silent: the model looks great in
evaluation and falls over in production.

## How it works

You already know the shape from a **data-mapping / DTO layer**: raw record in,
clean typed object out, each field derived by a small pure function. Feature
engineering is that mapping with two additions — the output must be *numeric*
(models do arithmetic, not strings), and some derivations carry *fitted state*
that must be learned once and reused.

### Move 1 — the mental model

```
  Mental model — a mapping layer where some mappers carry learned state

  raw row ──────────────► [ transform pipeline ] ──────────► feature vector
  {price: "$40",            │                                  [40.0, 0.7,
   ts: "2026-06-19T..",     ├─ parse "$40"     → 40.0           1, 0, 0,
   country: "US",           │   (stateless)                     0.42]
   sessions: 7,             ├─ z-score(price)  → (x-μ)/σ
   purchases: 3}            │   (STATEFUL: μ,σ fit on train)
                            ├─ one-hot(country)→ [1,0,0]
                            │   (STATEFUL: vocab fit on train)
                            └─ purchases/sessions → 0.42
                                (stateless interaction term)
```

Stateless mappers (parse, ratio) are pure functions of the row. Stateful mappers
(z-score, one-hot) hold a parameter learned at fit time. The feature vector is
the concatenation — the single numeric row the model fits on.

### Move 2 — the load-bearing skeleton

Four transform families cover most tabular feature work. Each gets its own
diagram; each names a different failure if you skip it.

#### Normalization / scaling

Put numeric columns on a comparable scale so no single large-magnitude column
dominates the fit.

```
  z-score scaling — fit on train, apply everywhere

  TRAIN ──► fit: μ = mean(train.price), σ = std(train.price)   ← learns 2 params
                                  │
              ┌───────────────────┼───────────────────┐
              ▼                   ▼                   ▼
        transform(train)   transform(val)      transform(live)
        (x-μ)/σ            (x-μ)/σ              (x-μ)/σ
        SAME μ,σ everywhere — that's the whole point
```

Without it, a column measured in millions swamps a column measured in fractions
for distance- and gradient-based models. **Failure if you skip the fence:** fit
μ,σ on the full dataset → test rows influenced the mean → leakage.

#### Encoding categoricals

Models do arithmetic; "US"/"CA"/"UK" is not a number. Map categories to numbers
*without inventing a fake order*.

```
  one-hot encoding — categories become indicator columns

  country: "US"  ──► [is_US=1, is_CA=0, is_UK=0]   ← vocab {US,CA,UK} fit on train
  country: "CA"  ──► [is_US=0, is_CA=1, is_UK=0]
  country: "ZZ"  ──► [is_US=0, is_CA=0, is_UK=0]   ← unseen at train → all-zero
       │
       └─ alternative: target/mean encoding (category → mean label) is powerful
          but LEAK-PRONE — must be fit with cross-fold or it sees its own label
```

Without it, you either can't use the column or you label-encode it
(US=0,CA=1,UK=2) and the model reads a fake ordering. **Failure if you skip the
fence:** a category that appears only in test gets a column the model never
trained on; or target-encoding computed on the full dataset leaks the label.

#### Interaction terms

Some signal lives only in the *combination* of features. A linear model can't
discover interactions on its own — you hand it the product or ratio.

```
  interaction term — combine columns the model can't combine itself

  sessions=7, purchases=3  ──► conversion = purchases/sessions = 0.43
  price, is_weekend        ──► price × is_weekend  (weekend price effect)
       │
       └─ this is why MODEL CHOICE (04) matters: a linear model NEEDS these
          hand-built; gradient-boosted trees find interactions on their own
```

Without them, a linear model misses any signal that's nonlinear in the raw
columns. This is the direct hinge into 04 — feature engineering effort and model
family trade against each other.

#### Leakage-free transforms (the discipline over all of the above)

The transform that quietly uses information unavailable at inference time is the
career-ending bug. Two shapes: *temporal* leakage (a feature computed from data
that arrives after the label) and *split* leakage (a fitted parameter learned
across the split boundary).

```
  Leakage check — could this feature exist at inference time, fit on train only?

  candidate feature ──► Q1: at serve time, is every input it needs
                        ALREADY known when we predict?
                              │ no ──► TEMPORAL LEAK (drop it)
                              │ yes
                              ▼
                        Q2: if it's fitted, was the param
                        learned on TRAIN ONLY?
                              │ no ──► SPLIT LEAK (refit inside split)
                              │ yes
                              ▼
                        keep it
```

Without this gate, the previous three families each become a leak vector. **The
gate is the load-bearing part of the whole file.**

**Skeleton vs. hardening.** The four families are the skeleton. Hardening:
imputation for missing values (also fitted on train), feature selection, a
feature store so transforms are shared and versioned across models, and bucketing
/ binning continuous values. The skeleton is enough to teach; production adds the
rest.

### Move 3 — the principle

A feature is a **learned mapping fenced to the training split**, and it must be
computable from information that exists at inference time. Two questions decide
whether a feature is legitimate: *will every input it needs be available when I
predict?* and *was any parameter it carries learned on training data alone?* Pass
both and the feature is honest; fail either and you've built a model that grades
its own homework.

## Primary diagram

The features stage end to end, fit/transform seam marked.

```
  Feature engineering — full picture

  raw rows ─────────────────────────────────────────────────────────────┐
     │                                                                    │
     ▼                                                                    │
  SPLIT FIRST (03) ──► train │ val │ test                                 │
     │                  │                                                 │
     ▼                  ▼                                                 │
  ┌─ fit phase (TRAIN ONLY) ──────────────────────────┐                  │
  │  scaler.fit → μ,σ      encoder.fit → vocab          │  ★ THE SEAM:     │
  │  imputer.fit → fill    (stateless transforms: none) │  fit never sees  │
  └──────────────────────────┬─────────────────────────┘  val/test/live   │
                             │ frozen params                              │
       ┌─────────────────────┼─────────────────────────┐                 │
       ▼                     ▼                          ▼                 │
  transform(train)     transform(val/test)        transform(live) ◄───────┘
       │                     │                          │
       ▼                     ▼                          ▼
  X_train ──► fit(04)   X_val ──► tune          X_live ──► predict
                                                (SAME transforms = no skew)
```

## Implementation in codebase

**Not yet implemented in AptKit — AptKit ships no trained model, so it has no
learned features.** The honest near-cousin: the anomaly categories carry
hand-authored thresholds — e.g. `conversion_drop` fires at `{ critical: 20,
warning: 10 }` percent in
`packages/agents/anomaly-monitoring/src/categories.ts`. Those thresholds are
*hand-written heuristics a human chose*, not features learned from data; a
feature-engineering pipeline would *learn* boundaries like these from labelled
history rather than declaring them by hand.

## Elaborate

For decades feature engineering *was* applied ML — the deep-learning era's pitch
was "let the network learn the features," which is true for images, audio, and
text but largely *false for tabular data*, where hand-built features plus
gradient-boosted trees (04) still win. So this skill stayed central exactly where
the anomaly data lives: structured rows. The leakage discipline here is the same
discipline as in 03 — both are about not letting information cross a boundary it
won't have at inference. In LLM-application work, the analog of "feature
engineering" is **context engineering**: deciding what goes into the prompt is
choosing the model's inputs, and "don't include the answer in the context" is
the same leakage rule wearing a different hat.

What to read next: 03 (the split must come *before* fitting any transform — this
file leaned on that), then 04 (which features you need depends on the model
family you pick).

## Project exercises

*Provenance: Phase 2C — Machine learning (C2C.x). No `aieng-curriculum.md`;
IDs by-convention. Case B — nothing here exists; thought-experiment plus a small
deliverable.*

### Exercise — design a leakage-safe feature set for the anomaly data

- **Exercise ID:** `[C2C.2]` Phase 2C, feature-engineering concept
- **What to build:** Take the ten anomaly categories in
  `packages/agents/anomaly-monitoring/src/categories.ts` and design the feature
  vector you'd hand a trained classifier instead of the hand-coded thresholds:
  e.g. (event count this window − trailing-window mean) / trailing std as a
  z-score per metric, one-hot of the category id, an interaction like
  `purchase/session_start`. For each feature run the leakage gate: is it
  computable at inference, and is its fitted parameter (the trailing mean/std)
  fit on train only? Land the buildable slice: a pure transform function in
  `packages/evals/` (or a scratch module) that turns a window of detection-like
  records into a numeric vector, with a unit test proving the scaler is fit on a
  train subset only.
- **Why it earns its place:** Replacing hand-tuned thresholds with learned,
  leakage-checked features is the exact move that separates "I configured a
  heuristic" from "I engineered features for a model." Interviewers probe the
  fit/transform seam hard; having a concrete, leak-audited feature set is a rare,
  strong signal.
- **Files to touch:** `packages/evals/` (transform + test — the natural home for
  data-shaping helpers); the training side is honestly **a new repo/package**.
- **Done when:** A documented feature list with a pass/fail leakage verdict per
  feature exists, and a `fit`/`transform` function with a test asserting `fit`
  was called on train rows only.
- **Estimated effort:** `1–4hr` (design + the transform slice)

## Interview defense

**Q: What's the most common leakage bug in feature engineering and how do you
prevent it?**
I'd sketch the fit/transform seam:

```
  WRONG: scaler.fit(ALL data) ─► split ─► train   (test leaked into μ,σ)
  RIGHT: split ─► scaler.fit(TRAIN) ─► transform(train/val/test)  same params
```

"Fitting a scaler or encoder on the full dataset before splitting. The test
rows' values bleed into the mean, so the model sees a hint of the test
distribution and your evaluation is optimistic. Fix: split first, fit fitted
transforms on train only, then apply those frozen parameters everywhere."
*Anchor: split before you fit anything that learns a parameter.*

**Q: When do you need to hand-build interaction features?**
"When the model can't find interactions itself. A linear model — logistic
regression — only sees a weighted sum of inputs, so any signal living in
`a×b` or `a/b` has to be handed to it explicitly. A gradient-boosted tree splits
on combinations natively, so you lean less on hand-built interactions there.
That's why feature effort and model choice (04) trade off."
*Anchor: linear models need interactions spelled out; trees find them.*

## Validate

- **Reconstruct:** From memory, list the four transform families and which two
  carry fitted state. Check against Move 2.
- **Explain:** Why is target/mean encoding more leak-prone than one-hot? (Because
  it maps each category to the mean of the *label* for that category — so it's
  literally built from the answer, and unless fit with cross-folds it lets each
  row see its own label.)
- **Apply:** The anomaly category `conversion_drop` uses a hand-set threshold of
  20% critical. If you turned that into a learned feature, what would the feature
  be and what parameter would it need fit on train? (Feature: z-scored deviation
  of the window's conversion rate from its trailing baseline; fitted parameters:
  the baseline mean and std, learned on training windows only.)
- **Defend:** "Just normalize the whole dataset, then split — the math is the
  same." Refute it. (It isn't the same: normalizing the whole set computes μ,σ
  from rows that will become your test set, so test information leaks into the
  features the model trains on, and your held-out number is no longer honest.)

## See also

- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the conveyor this stage sits in
- [03-train-val-test.md](03-train-val-test.md) — why you split *before* fitting transforms
- [04-model-selection.md](04-model-selection.md) — how feature effort trades against model family
- [README.md](README.md) — the honest banner and the LLM-analog table
