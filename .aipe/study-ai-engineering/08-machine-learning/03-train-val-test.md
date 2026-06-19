# Train / validation / test (split discipline, leakage, and the unit seen new at inference)

**Industry names:** train/val/test split, holdout, data leakage, cross-validation, the split · *Industry standard*

## Zoom out, then zoom in

This is the third box on the conveyor from `01`, and it's the one interviewers
probe hardest — because it's where honest models and self-deceiving models part
ways. Split wrong and every downstream number lies.

```
  Zoom out — the split inside the pipeline

  ┌─ OFFLINE conveyor (from 01) ────────────────────────────────────────────┐
  │  raw data ──► features ──► ★ SPLIT ──► fit ──► evaluate ──► freeze        │
  │   (01)        (02)         (THIS FILE) (04)     (08)         (the seam)   │
  │                              │                                           │
  │                              ▼                                           │
  │              train  │  val  │  test                                      │
  │             (learn) (tune)  (grade ONCE)                                 │
  └───────────────────────────────────────────────────────────────────────────┘
```

Zoom in: AptKit ships no split because it ships no training. But this concept has
the *closest* honest cousin in the whole repo —
`packages/evals/src/detection-scorer.ts` already computes
precision/recall-shaped numbers (matched / missed / unexpected) over the anomaly
agent's detections. That scorer is the *evaluate* end of this box; what AptKit
lacks is the *split* end feeding it held-out data. Your anchor stays contrl: you
ran a model on-device but didn't carve the splits that produced it. The pattern:
**you split off data the model never sees, at the unit that will be new at
inference, so your reported number estimates real-world performance — not
memorization.**

## Structure pass

**Layers.** Three partitions, by *role*. **Train** — the model learns its
parameters here. **Validation** — you tune *your* choices here (hyperparameters,
the decision threshold, which features, which model family from 04); the model
doesn't learn on it but you do. **Test** — touched exactly once, at the very end,
to produce the number you report. The three-way split exists because tuning on
the same data you grade on inflates the grade: val absorbs the tuning so test
stays clean.

**Axis — has the model (or you) seen this row's information?** Trace
*has-it-been-seen*. Train rows: seen by the model's weights. Val rows: seen by
*your* tuning decisions (a subtler kind of seen). Test rows: seen by nothing
until the final grade. The whole discipline is keeping these three "seen-by"
levels strictly nested and never letting information jump inward.

**Seam.** The load-bearing seam is **the boundary you split *along*.** The naive
choice is "split rows randomly." The correct choice is "split at the unit that's
*new at inference time*." If your model will see new *users* in production, two
rows from the same user must not straddle the train/test line — or the model
memorizes that user in train and gets quizzed on them in test, and your number is
a fantasy. Get this seam wrong and you leak through the split itself, invisibly.

## How it works

You already know this from **separating fixtures from the code under test**, or
from a **holdout set in any A/B sense**: you never validate a system on the exact
inputs you built it against. The twist in ML is that "the same input" is sneaky —
two different rows from the same user, or two timestamps from the same session,
carry shared information, so row-level separation isn't enough.

### Move 1 — the mental model

```
  Mental model — three nested "seen-by" rings

      ┌──────────── TEST (seen by nothing until final grade) ──────────┐
      │   ┌──────── VAL (seen by YOUR tuning, not the weights) ──────┐  │
      │   │   ┌──── TRAIN (seen by the model's weights) ────┐        │  │
      │   │   │     fit parameters here                     │        │  │
      │   │   └─────────────────────────────────────────────┘        │  │
      │   │     pick hyperparams / threshold / features here          │  │
      │   └───────────────────────────────────────────────────────────┘  │
      │     produce the ONE honest number here, once                      │
      └────────────────────────────────────────────────────────────────────┘
        information may flow OUTWARD (train→report) but NEVER inward
```

Information is allowed to flow outward — what you learned on train informs the
report. It must never flow inward — test rows must not touch tuning, tuning rows
must not touch fitting. Each ring is a tighter promise about what's been seen.

### Move 2 — the load-bearing skeleton

Strip it to the discipline that's still the concept. Three moving parts; each
fails differently.

#### Split at the right unit

```
  Split-by-unit — the single most-probed decision

  Question: what is NEW at inference time?
       │
       ├─ new ROWS of known users ─► split by ROW is fine
       │
       ├─ new USERS ──────────────► split by USER (all of a user's
       │                             rows go to ONE side)
       │
       └─ FUTURE time ────────────► split by TIME (train on past,
                                     test on future — never shuffle)

  WRONG (user model, row split):
    user42 rows ──► some in TRAIN, some in TEST
                    model memorizes user42 in train, aced in test → fantasy
```

The rule: **split along whatever entity is unseen at serve time.** A churn model
sees new users → split by user. A forecasting model sees the future → split by
time, no shuffling. Get this wrong and you leak through the split itself.

#### The validation set absorbs tuning

```
  Why three sets, not two

  every time you tune on a set, that set gets "used up" as a grader.
  tune on TEST  ──► test is now contaminated by your choices
  tune on VAL   ──► val absorbs it; TEST stays a virgin grader
       │
       ▼
  train (model learns) │ val (you learn) │ test (nobody learns — final grade)
```

Without a separate val set, you tune against test and your reported number is
optimistic by however hard you tuned. Cross-validation (k-fold) is the
data-efficient version: rotate which fold is val across k splits and average —
but the *test* set still stays out of the rotation.

#### Leakage audit — information jumping inward

```
  Leakage taxonomy — three ways info crosses a boundary it shouldn't

  ┌ target leakage ─┐  a feature contains the answer (or a proxy that
  │                 │  only exists after the label is known)
  └─────────────────┘
  ┌ train/test leak ┐  the same entity (user/session) straddles the split,
  │                 │  OR a transform fit on the full set (see 02)
  └─────────────────┘
  ┌ temporal leak ──┐  a feature uses data from AFTER the prediction time
  │                 │  (future info the model won't have at serve)
  └─────────────────┘
       │
       ▼
  symptom of ALL three: suspiciously high offline score, collapse in prod
```

Without the audit, leakage is silent — it *improves* your offline number, so it
looks like success. The only tell is the gap between offline glory and online
collapse. **This is the part interviewers dig at hardest.**

**Skeleton vs. hardening.** The three parts above are the skeleton. Hardening:
stratified splitting (preserve class balance across splits — matters under
imbalance, 05), group k-fold (cross-validation that respects the split-by-unit
rule), nested CV (an outer test loop around an inner tuning loop), and a frozen,
versioned test set you never look at twice. Skeleton teaches it; production needs
the rest.

### Move 3 — the principle

A split is a **promise about what the model and you have never seen**, made at
the unit that will be new at inference. The reported number is only honest if
information never flowed inward across the rings — no answer hidden in a feature,
no entity straddling the line, no future bleeding into the past. The discipline
isn't about ratios (70/15/15 vs 80/10/10 barely matters); it's about the *seam
you split along* and the *audit that nothing leaked across it.*

## Primary diagram

The split stage end to end, with the leakage gate.

```
  Train/val/test — full picture

  raw data
     │
     ▼
  ┌─ choose the split UNIT ──────────────────────────────────────┐
  │  what is new at inference? row / user / time → split along it │  ★ THE SEAM
  └───────────────────────────┬──────────────────────────────────┘
                              ▼
        train (≈70%)  │   val (≈15%)   │   test (≈15%)
            │              │                  │
            ▼              ▼                  │  (sealed — touched once)
        fit(04) ◄──── tune hyperparams,       │
        features        threshold, family ────┤
        scaler.fit      (02 transforms        │
        (02, train      fit on TRAIN only) ───┘
         only)
            │              │                  │
            └──────────────┴──────► LEAKAGE AUDIT ◄── target / split / temporal
                                          │
                                          ▼
                                 evaluate ONCE on test ──► the honest number
                                 (precision/recall — cf. detection-scorer.ts)
```

## Implementation in codebase

**Not yet implemented in AptKit — AptKit ships no trained model, so it splits no
data.** But the *evaluate* end of this box has a genuine cousin:
`packages/evals/src/detection-scorer.ts` already computes
precision/recall-shaped numbers — `matched`, `missed`, `unexpected`, and a
normalized `score` — over the anomaly agent's category detections against
expected sets. It's the nearest thing to ML evaluation in the repo; what's
missing in front of it is held-out, leakage-audited data. `packages/evals/` is
the expected home for any ML-metric evaluation of the existing agents.

## Elaborate

The train/test split is the oldest idea in empirical ML and the one most often
botched — Kaggle's leaderboard culture exists precisely because public/private
test splits catch people who (often unknowingly) leaked. The split-by-unit rule
is the single most expensive lesson in applied ML: row-level random splits on
user-grouped data are the textbook silent killer, and they pass code review
because the code *looks* correct. In LLM-application work the same discipline
appears as **don't tune your prompt on your eval set** — your held-out eval cases
are a test set, and iterating a prompt against them until they pass is exactly
the leakage of tuning-on-test. AptKit's eval layer is where that discipline would
live.

What to read next: 02 (the *transform-fit-on-train* rule is half of split
leakage), then 05 (class imbalance changes *how* you split — stratify) and 08
(confusion matrices — what you build on the test set once the split is honest).

## Project exercises

*Provenance: Phase 2C — Machine learning (C2C.x). No `aieng-curriculum.md`;
IDs by-convention. Case B — thought-experiment plus a measurable deliverable in
`packages/evals/`.*

### Exercise — define an honest holdout and leakage audit for an anomaly-agent eval

- **Exercise ID:** `[C2C.3]` Phase 2C, train/val/test concept
- **What to build:** Treat the anomaly agent as a classifier and design its
  evaluation properly. Decide the *split unit*: the agent sees new *workspaces*
  at inference, so a holdout must split by workspace, not by detection-row — two
  detections from the same workspace must not straddle train/test. Then write the
  leakage audit: confirm no expected-category fixture leaks into the prompt the
  agent receives. Land the deliverable: extend or wrap
  `packages/evals/src/detection-scorer.ts` so a fixture set is partitioned by
  workspace and scored only on a held-out workspace, with the resulting
  precision/recall reported per held-out group.
- **Why it earns its place:** Naming "split by the unit new at inference" out
  loud and applying it to a real artifact is the single highest-signal move in
  this section — it's the question interviewers use to separate people who've
  *shipped* models from people who've *read about* them.
- **Files to touch:** `packages/evals/` (a holdout/group-split helper around
  `detection-scorer.ts`); fixtures of anomaly detections grouped by workspace.
- **Done when:** A scorer partitions fixtures by workspace, evaluates on a
  held-out group only, and a test proves no workspace appears in both the
  tuning and held-out partitions.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: You're building a churn model. How do you split your data?**
I'd sketch the user-grouped split:

```
  WRONG (row split):  user42 ─► [train rows | test rows]  → memorized
  RIGHT (user split): user42 ─► ALL to train  ;  user99 ─► ALL to test
                      split along USER = the unit new at inference
```

"Churn means the model scores *new users* in production, so the split unit is the
user, not the row. All of a user's rows go to one side. A random row split lets
the model memorize user42 in train and get quizzed on user42 in test — the score
looks great and collapses on actual new users."
*Anchor: split at the unit that's new at inference time.*

**Q: Your offline F1 is 0.95 and production is 0.6. What happened?**
"That gap is the signature of leakage. I'd check three things, fastest first:
target leakage — does a feature encode the answer or a post-label proxy?
train/test leakage — did an entity straddle the split, or was a scaler/encoder
fit on the full dataset (02)? temporal leakage — does a feature use data from
after the prediction time? High offline, low online almost always means
information jumped inward across a split boundary."
*Anchor: a too-good offline number is a leakage symptom, not a win.*

## Validate

- **Reconstruct:** Draw the three nested rings and state which way information may
  flow. Check against Move 1.
- **Explain:** Why three sets instead of two? (Because tuning *consumes* a set as
  a grader: if you tune on test, test is contaminated by your choices. Val
  absorbs the tuning so test stays a clean, single-use grader.)
- **Apply:** AptKit's anomaly agent sees new *workspaces* at serve time. What's
  the split unit, and what's the bug if you split by detection-row instead?
  (Split by workspace; a row split lets detections from the same workspace land
  on both sides, so the eval over-credits the agent on workspaces it effectively
  saw during tuning.)
- **Defend:** "70/15/15 vs 80/10/10 — which ratio is correct?" (Wrong question.
  The ratio barely matters; what matters is the *unit* you split along and that
  nothing leaks across it. A perfect ratio on a row-split of user data is still a
  fantasy.)

## See also

- [01-supervised-pipeline.md](01-supervised-pipeline.md) — the conveyor this split sits in
- [02-feature-engineering.md](02-feature-engineering.md) — fit transforms on train only (split leakage's other half)
- [04-model-selection.md](04-model-selection.md) — the choice you tune on the validation set
- [README.md](README.md) — the `detection-scorer.ts` connection, stated honestly
