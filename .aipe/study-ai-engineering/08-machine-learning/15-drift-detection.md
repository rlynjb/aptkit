# Drift Detection

> data/concept drift detection · monitoring

Blunt first: **aptkit trains no model and monitors no feature distribution.** There's nothing in `packages/` doing drift detection — this is new ground, an exercise you'll build into buffr. Anchor it to contrl: you ship the pose-landmark rep counter, it works great on the phones you tested. Six months later a new flagship phone with a wider-FOV front camera ships, or people start filming in dimmer rooms, and the *distribution of landmark coordinates your model sees in production drifts away from the distribution it was trained on*. Accuracy quietly rots. Nothing crashes. No error fires. That silent rot is what drift detection catches.

## Zoom out, then zoom in

Drift detection isn't a training-time stage — it's a *post-deploy monitor* that compares live input distributions against the training baseline. Here it is on the pipeline.

```
Where drift detection lives
┌──────────────────────────────────────────────────────────────────────┐
│  DATA ──→ FEATURES ──→ TRAIN/VAL/TEST ──→ MODEL ──→ DEPLOY ──★         │
│   │          │                                        │      │         │
│   │ baseline │ baseline                               │  live │        │
│   │ dist.    │ feature dist. (TRAIN snapshot)         │  feature       │
│   ▼          ▼                                         ▼  dist.         │
│  ┌──────────────────────────┐          ┌──────────────────────────┐    │
│  │  TRAIN distribution       │  ◄─PSI─► │  PROD distribution        │    │
│  │  (frozen at train time)   │ compare  │  (rolling window, live)   │    │
│  └──────────────────────────┘          └──────────────────────────┘    │
│                            ★ drift monitor sits OFF the model path      │
└──────────────────────────────────────────────────────────────────────┘
```

The monitor lives downstream of deploy and reads two snapshots: the *frozen training distribution* of a feature and a *rolling production window* of the same feature. It never touches the model itself. Its only output is a number that says "these distributions have moved apart by this much."

## Structure pass

One axis: **how far has the production input distribution moved from training, and is that far enough to act?** Two seams sit on this axis, and conflating them is the classic mistake:

- **Data drift** — the input distribution `P(X)` shifts. The features themselves look different now. (New camera FOV → landmark coordinates cluster differently.) The model is unchanged, the world feeding it changed.
- **Concept drift** — the relationship `P(y | X)` shifts. The same input now means a different label. (Same landmark pattern that used to be "rep complete" now isn't, because users changed their exercise form.) Far nastier — your features can look identical while the truth underneath moved.

PSI detects **data drift** directly — it only looks at `X`. Concept drift needs labels and usually shows up as a performance drop, not a distribution shift. Know which one your metric can and can't see.

## How it works

### Move 1 — Mental model

PSI (Population Stability Index) asks one question: **bin a feature; did the proportion of values landing in each bin change from train to prod?** It's a weighted sum of per-bin disagreement.

```
PSI mental model — per-bin proportion disagreement
 feature value range, binned:
   bin1   bin2   bin3   bin4   bin5
  ┌────┬──────┬──────┬──────┬────┐
TRAIN%  10  │  25  │  30  │  25  │ 10 │   ← frozen baseline
PROD %  05  │  15  │  25  │  35  │ 20 │   ← live window
  └────┴──────┴──────┴──────┴────┘
            │
            ▼  per bin: (prod% - train%) * ln(prod% / train%)
            ▼  sum across bins  =  PSI
```

The `ln(prod/train)` term makes it *signed-magnitude weighted*: a bin that doubled and a bin that halved both contribute, and bigger moves contribute more. Sum the bins, get one PSI number.

### Move 2 — Step by step

**Part A: Bin the feature and compute proportions**

Fix the bin edges from the *training* data and reuse them for prod — otherwise you're comparing apples to differently-sliced apples.

```
Step A — fixed bins, two proportion vectors
TRAIN sample ──► bin with edges E ──► train_pct[] = [.10 .25 .30 .25 .10]
PROD  sample ──► bin with SAME E  ──► prod_pct[]  = [.05 .15 .25 .35 .20]
                                       (edges E frozen from train)
```

**Part B: Sum the per-bin PSI contributions**

```
Step B — the PSI sum
        n_bins
 PSI  =   Σ    (prod_pct[i] - train_pct[i]) * ln(prod_pct[i] / train_pct[i])
        i = 1
```

```python
# not yet exercised in aptkit — no feature monitoring exists in packages/
EPS = 1e-6  # guard log(0) / divide-by-zero on empty bins

def psi(train_pct, prod_pct):
    total = 0.0
    for t, p in zip(train_pct, prod_pct):
        t = max(t, EPS)
        p = max(p, EPS)
        total += (p - t) * math.log(p / t)
    return total
```

The `EPS` guard matters: an empty prod bin gives `ln(0)` = `-inf` and tanks the whole score. Real PSI implementations all clamp.

**Part C: Apply the threshold rule**

PSI is meaningless without an action mapping. This table *is* the decision.

```
PSI threshold rule (industry-standard bands)
┌──────────────┬───────────────────────┬──────────────────────────┐
│ PSI value    │ interpretation         │ action                   │
├──────────────┼───────────────────────┼──────────────────────────┤
│ PSI < 0.10   │ stable                 │ no action                │
│ 0.10 – 0.20  │ moderate shift         │ investigate, watch       │
│ PSI > 0.20   │ significant shift      │ retrain (→ 16-retraining)│
└──────────────┴───────────────────────┴──────────────────────────┘
```

```python
# not yet exercised in aptkit
def psi_action(value):
    if value < 0.10: return "stable"
    if value < 0.20: return "investigate"
    return "retrain"   # hands off to 16-retraining-pipelines.md
```

**`not yet exercised in aptkit`** — there is no feature store, no prod feature window, and no monitor in the repo. This is something you'd add to buffr, not something I'm describing in shipped code.

### Move 3 — Principle

**Models fail silently; only their inputs warn you in advance.** A live metric drop tells you you're *already* losing — by then users felt it. PSI on inputs is a leading indicator: distributions move before labels confirm the damage. Monitor `P(X)` so you act before `P(y|X)` punishes you.

## Primary diagram

```
Drift monitor, end to end
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  TRAIN TIME                          PROD TIME (rolling)              │
│  ┌──────────────┐                    ┌──────────────────┐            │
│  │ training set  │                    │ last N days of    │            │
│  │ feature col X │                    │ live feature X    │            │
│  └──────┬───────┘                    └─────────┬─────────┘            │
│         │ bin (edges E)                         │ bin (SAME edges E)   │
│         ▼                                        ▼                     │
│  train_pct[] ───────────┐          ┌──────── prod_pct[]               │
│                         ▼          ▼                                  │
│                   ┌──────────────────────┐                            │
│                   │  PSI = Σ (p−t)·ln(p/t)│                            │
│                   └──────────┬───────────┘                            │
│                              ▼                                        │
│              ┌───────────────┴────────────────┐                       │
│              ▼               ▼                 ▼                       │
│         PSI < .10        .10–.20          PSI > .20                    │
│         no action       investigate      RETRAIN ──► 16-retraining    │
│                                                                       │
│  Caveat: PSI sees DATA drift P(X). CONCEPT drift P(y|X) hides here.   │
└───────────────────────────────────────────────────────────────────────┘
```

Before the monitor, a drifting input population is invisible until accuracy complaints arrive. After, the new-camera-FOV shift in contrl's landmark distribution registers as a PSI spike on the affected coordinate features, days before the rep-count accuracy visibly degrades.

## Elaborate

- **Bin edges come from train, always.** Re-deriving edges from prod data hides the very shift you're hunting. Freeze edges at training, store them next to the model.
- **PSI per feature, not global.** Compute one PSI per monitored feature. A global number averages away the one coordinate that's drifting hard. For contrl you'd track PSI on each landmark axis separately — the FOV change hits the outer landmarks first.
- **Rolling window size is a tuning knob.** Too short → noisy PSI that false-alarms on a quiet weekend. Too long → slow to notice real drift. Match it to your traffic volume.
- **PSI is blind to concept drift — say so out loud.** This is the trap. The same `X` distribution with a flipped `P(y|X)` shows PSI ≈ 0 while the model is failing. Concept drift surfaces as a *performance* drop (cross-ref the performance-triggered path in `16-retraining-pipelines.md`), and is itself a flavor of the domain-gap problem (cross-ref `06-domain-gap.md`): train and serve distributions diverging.
- **Domain gap is drift's static cousin.** `06-domain-gap.md` is the gap that exists *at launch* (you trained on one population, deploy to another). Drift is that gap *opening over time* on a population that started matched. Same math (distribution distance), different clock.

## Project exercises

### EX-ML-15a — PSI scorer over two feature snapshots

- **Exercise ID:** `EX-ML-15a` (Phase 3 — the ML-evals layer; PSI is a monitoring eval that runs against snapshots, not a training step)
- **What to build:** A `psi(trainSnapshot, prodSnapshot, binEdges)` function that bins both snapshots with shared edges, computes per-feature PSI with an epsilon guard, and maps each score to `stable` / `investigate` / `retrain` via the threshold table. Take the two snapshots as plain arrays of feature values; emit `{ feature, psi, band }` per feature.
- **Why it earns its place:** It's the leading-indicator monitor the retraining pipeline's drift trigger depends on — `16` literally calls "PSI > 0.20" as a trigger condition. Building the scorer first means the retraining policy has something real to react to. It also makes the data-vs-concept-drift distinction concrete: you'll *see* PSI stay flat under a synthetic label flip.
- **Files to touch:** `Case B (new)` — `/Users/rein/Public/buffr/src/ml/drift/psi.ts` (new scorer); `/Users/rein/Public/buffr/src/ml/drift/psi.test.ts` (new test with a known hand-computed PSI fixture).
- **Done when:** The scorer reproduces a hand-computed PSI (e.g. the `[.10 .25 .30 .25 .10]` vs `[.05 .15 .25 .35 .20]` example) within float tolerance; an empty prod bin does not produce `NaN`/`Infinity`; and a feature with identical train/prod proportions scores `0.0 → stable`.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: PSI is 0.04 but your model's accuracy dropped 15%. What happened?**

```
P(X) unchanged  ─────►  PSI ≈ 0.04  (stable, no input drift)
P(y|X) flipped  ─────►  accuracy ↓ 15%   ← PSI is BLIND to this
                        = CONCEPT DRIFT, not data drift
```

PSI only watches inputs. The relationship between input and label moved — concept drift — and you only catch that with a *performance* signal, not a distribution one. One-line anchor: *PSI sees the world change; it can't see the meaning of the world change.*

**Q: Why bin from training edges instead of recomputing edges on prod?**

If you re-derive edges from prod, you reshape the bins to fit the new data, which absorbs and hides the shift. Frozen edges are the fixed yardstick. One-line anchor: *you can't measure movement against a ruler that moves with the thing you're measuring.*

## See also

- [`06-domain-gap.md`](./06-domain-gap.md) — the static train/serve gap that drift is the time-evolving version of
- [`16-retraining-pipelines.md`](./16-retraining-pipelines.md) — what a PSI > 0.20 spike triggers
- [`14-training-run-logging.md`](./14-training-run-logging.md) — the prod-model run a drift spike implicates
