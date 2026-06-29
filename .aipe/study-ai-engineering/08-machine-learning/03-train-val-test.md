# Train / Validation / Test Split Discipline

> train/validation/test split · evaluation hygiene

One more time, plainly: **aptkit trains no model, so aptkit has no split.** There is no `train_test_split`, no held-out set, no grouped-split utility in `packages/`. This is new ground — study material and exercises, not shipped code.

This is also the file with the highest ratio of "looks trivial, ruins everything." Splitting data sounds like a one-liner: shuffle, take 80% to train, 20% to test. For contrl-shaped data — time series where adjacent rows are near-identical — that naive one-liner produces a model that looks brilliant offline and fails on the first new person. The bug is invisible in the metrics. That's why this gets its own file.

## Zoom out, then zoom in

The split is the third stage. It's the seam between features and the model, and it decides whether your reported numbers mean anything. Star on the split.

```
Where the split lives (★ = this file)
┌──────┐   ┌──────────┐   ┌────────────────────┐   ┌───────┐   ┌────────┐
│ DATA │──▶│ FEATURES │──▶│ TRAIN / VAL / TEST ★ │──▶│ MODEL │──▶│ DEPLOY │
└──────┘   └──────────┘   └────────────────────┘   └───────┘   └────────┘
                            ▲ split at the level the model
                              will see as NEW, or your metrics lie
```

The split's only job is to *simulate the future*. Val and test exist to answer "how will this do on data it has never seen?" If the data it's tested on isn't truly new — because near-identical rows leaked into training — the answer is a comforting lie. Everything in this file is about making "new" mean new.

## Structure pass

There are three sets and one rule that governs how they're carved.

- **Train.** The model fits on this. Big.
- **Validation.** You tune hyperparameters and choose between models against this. You may look at it many times.
- **Test.** You touch this **once**, at the very end, to report a number. Look at it twice and it becomes a second validation set — its honesty is spent.
- **The split rule (the whole file).** Carve along the unit the model sees as new at serving time. Row-level for independent rows; **group-level (session/user) for correlated rows.** For contrl, that's per-workout-session and ultimately per-person — never per-frame.

The seam that bites: choosing the split granularity. Get it wrong and the other three sets are fine individually but the boundary between them leaks.

## How it works

### Move 1 — Mental model

A leak is a **peek at the answer key.** Whenever information from val/test reaches the model during training — directly or through a near-duplicate row — the model is partly memorizing the test, and its score is inflated. The mental model: imagine the model is a student and the test is an exam. Row-wise splitting of time series hands the student the exam questions during study, just slightly reworded.

```
Mental model — the leak is a peek at the answer key
  CORRECT split (by session)            LEAKY split (by frame)
  session A ─┐                          frame 1 ─┐
  session B ─┼─▶ TRAIN                  frame 2 ─┼─▶ TRAIN
  session C ─┘                          frame 3 ─┘
  ─────────────────────                 frame 4 ─┐   ← frame 3 and 4 are
  session D ──▶ TEST (truly new)        frame 5 ─┼─▶ TEST   nearly identical!
                                        frame 6 ─┘   model already "saw" it
   model meets a NEW person             model is graded on near-copies → fake 0.99
```

Adjacent frames in a 30fps pose stream differ by millimeters. A row-wise shuffle scatters frame 3 into train and frame 4 into test — so the test is essentially the training data with a tiny jitter. The score is meaningless.

### Move 2 — Step by step

Pseudocode for a *new* grouped-split utility. **Not yet exercised in aptkit** — there is no split code anywhere in `packages/`; the contrl reference is prose only.

**Part 1 — Identify the group key.**

```
Group-key decision
Are rows independent?
   yes ──▶ row-level split is fine (rare for sensor/time data)
   no  ──▶ what makes two rows "the same situation"?
            same workout session?  → group = session_id
            same person?           → group = user_id  (stronger: tests new people)
```

Pick the *strongest* grouping you can afford. For contrl, splitting by `user_id` answers the question you actually care about: "does this work for someone the model has never seen?"

**Part 2 — Split by group, not by row.**

```
Grouped split
all sessions: [A B C D E F G H]   (each session = many correlated frames)
group-shuffle, then carve:
   TRAIN: [A B C D E]      VAL: [F G]      TEST: [H]
   ▲ no session appears in more than one set → no frame leaks across the boundary
```

```python
def grouped_split(rows, group_key, ratios=(0.7, 0.15, 0.15)):  # not in aptkit
    groups = unique(r[group_key] for r in rows)
    shuffle(groups)
    cut1 = int(len(groups) * ratios[0])
    cut2 = cut1 + int(len(groups) * ratios[1])
    train_g, val_g, test_g = groups[:cut1], groups[cut1:cut2], groups[cut2:]
    return (filter_by(rows, group_key, train_g),
            filter_by(rows, group_key, val_g),
            filter_by(rows, group_key, test_g))
```

The key line: you shuffle and split *groups*, then assign every row to the set its group landed in. A whole session moves together.

**Part 3 — Prove the absence of a leak with a test.**

```
Leakage assertion
TRAIN groups ∩ VAL groups ∩ TEST groups  ==  ∅   (empty)
        │
        ▼ if any group_id appears in two sets → FAIL the build
```

```python
def assert_no_leak(train, val, test, group_key):    # not in aptkit
    g = lambda rows: {r[group_key] for r in rows}
    assert g(train).isdisjoint(g(val))
    assert g(train).isdisjoint(g(test))
    assert g(val).isdisjoint(g(test))
```

This test is your insurance. It's three set-intersection checks and it catches the single most expensive ML mistake before it ever reaches a metric.

### Move 3 — The principle

**Split at the level the model will see as new, then prove the sets are disjoint at that level.** Validation honesty is not a property of the percentages — it's a property of the boundary. If correlated rows straddle the boundary, no amount of test-set size saves you.

## Primary diagram

The canonical picture: the same dataset split two ways, with the resulting (real) metric next to each, so you see the leak as a number.

```
Two splits, same data — the leak shown as a metric
                 ┌─────────────────────────────────────────────┐
  ROW-WISE       │ shuffle all frames, take 20% as test         │
  (LEAKY)        │ test frames are near-copies of train frames  │  VAL: 0.99 ──▶ PROD: 0.71
                 │ ┌──────────────┐  ┌────────┐                 │  ▲ the lie
                 │ │ train frames │  │ test ≈ │  same sessions  │
                 │ │  A1 A2 B1 B2 │  │ A3 B3  │  in BOTH         │
                 │ └──────────────┘  └────────┘                 │
                 └─────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────┐
  GROUP-WISE     │ split whole sessions; no session in two sets │  VAL: 0.84 ──▶ PROD: 0.83
  (HONEST)       │ ┌──────────────┐  ┌────────┐                 │  ▲ the truth
                 │ │ sessions A,B │  │ session│  disjoint        │
                 │ │   (train)    │  │ C (test)│  groups         │
                 │ └──────────────┘  └────────┘                 │
                 └─────────────────────────────────────────────┘
```

The leaky split reports 0.99 and ships something that does 0.71 in production. The honest split reports a humbler 0.84 that *holds*. The lower offline number is the more valuable one — it didn't lie to you.

## Elaborate

- **The leak is silent — that's what makes it dangerous.** A leaky split produces *better* offline metrics, so nothing alerts you. You only find out in production, weeks later, when it's expensive.
- **Test set is touch-once.** Every time you peek at the test set to make a decision, you leak a little of it into your choices. Keep a frozen test set and report against it exactly once per real release.
- **Fit transforms on train only.** Scalers, encoders, imputers — anything that *learns* parameters — must be fit on train and applied to val/test. Fitting a scaler on the whole dataset leaks test statistics. This is the same disease as a group leak, just subtler.
- **Time-based data wants a time-based split.** If there's temporal structure ("predict tomorrow from today"), split by time — train on the past, test on the future — so you never train on data from after your test window. For contrl's offline modeling, grouping by session/person usually dominates, but if you ever predict *across* time, respect the arrow.
- **Stratify when classes are rare.** If "bad rep" is 5% of examples, a naive split can leave the test set with almost none. Stratify so each set keeps the class balance — but stratify *within* the grouping, not across it.
- **contrl anchor.** This is the trap contrl sits directly on top of. Pose data is 30+ frames a second of near-duplicates; a row-wise shuffle would scatter consecutive frames across train and test and report a near-perfect score that collapses on a new person. The discipline is to split by workout session, and ideally by person — so the held-out set represents a body the model has never trained on. That's the difference between "works in my recordings" and "works for a stranger."

## Project exercises

### Build a grouped-split utility

- **Exercise ID:** EX-ML-03a (Phase 2C — the split stage of the new belt; aptkit has no split code today)
- **What to build:** A `groupedSplit(rows, groupKey, ratios)` that carves train/val/test along a group key (session or user) so no group straddles two sets. Drop-in replacement for the naive row-wise split in the EX-ML-01a skeleton.
- **Why it earns its place:** This is the single most leverage-per-line hygiene tool in classical ML. It directly encodes the lesson that wrecks contrl-shaped data, and it's the thing an interviewer will press on when they hear "time series."
- **Files to touch:** Case B (new) — `aptkit/packages/ml-evals/src/split.ts` exporting `groupedSplit()`; wired into `pipeline.ts` from EX-ML-01a. No existing source edits.
- **Done when:** Given rows tagged with `session_id`, the three returned sets contain disjoint session sets, and the ratios are respected at the group level (not the row level).
- **Estimated effort:** 1–4hr

### Add a leakage test to the pipeline

- **Exercise ID:** EX-ML-03b (Phase 5 — ML hardening; make leaks fail the build)
- **What to build:** An `assertNoLeak(train, val, test, groupKey)` plus a unit test that *deliberately* constructs a leaky row-wise split and confirms the assertion catches it, and a clean grouped split that passes.
- **Why it earns its place:** It turns the most expensive invisible bug into a loud build failure. Demonstrating that you test for leakage — not just avoid it by hand — is a strong staff-level signal.
- **Files to touch:** Case B (new) — `aptkit/packages/ml-evals/src/split.test.ts`; `assertNoLeak()` in `aptkit/packages/ml-evals/src/split.ts`, invoked by `pipeline.ts` before any `fit`. Optional: a `buffr` training-log column noting `split_strategy` and `group_key` so every recorded run states how it split.
- **Done when:** The test proves the assertion throws on an intentionally leaky split and passes on a grouped split, and the pipeline refuses to fit if the sets share a group.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: You shuffled and split 80/20 and got 0.99. Why am I skeptical?**

```
shuffle ──▶ frame 3 → TRAIN
            frame 4 → TEST   (frame 3 ≈ frame 4)  ──▶ test is near-copy ──▶ 0.99 is fake
```

Because your rows are probably correlated, so a row-wise shuffle leaks near-duplicates across the boundary and inflates the score. I'd re-split by the group the model sees as new — session or user — and expect a lower, truthful number. Anchor: contrl's adjacent pose frames are near-identical; row-wise splitting there is the textbook leak.

**Q: Why touch the test set only once?**

```
peek → tune → peek → tune ...  ──▶ test set silently becomes a 2nd val set
                                     reported number no longer honest
```

Every decision made by looking at the test set leaks a bit of it into the model's design, so its honesty erodes with each peek. Tune on validation, freeze test, report against it once per release. Anchor: if I kept re-checking contrl against the same held-out person and tweaking, I'd eventually overfit to that one person and lose the generalization the test set was supposed to measure.

## See also

- [01-supervised-pipeline.md](./01-supervised-pipeline.md) — the five stages this split sits inside
- [02-feature-engineering.md](./02-feature-engineering.md) — why correlated features make the split rule matter
