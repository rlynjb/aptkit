# Training-Run Logging

> experiment/training-run logging · reproducibility infrastructure

Let me be blunt before we start: **aptkit trains no model.** There is no `model.fit()` anywhere in `packages/`. So everything in this file is new ground — concepts you'll build into buffr as exercises, not features I'm pointing at in shipped code. Your one real ML project is contrl (the MediaPipe pose-landmark rep counter on-device). Keep that in your head as the anchor: imagine you'd trained a small classifier on top of those landmarks and shipped three versions of it. The question this file answers is the one that wrecks ML teams: **"Which run produced the model that's in prod right now, and can I rebuild it byte-for-byte?"** If you can't answer that, you don't have an ML system, you have a science experiment that escaped the lab.

## Zoom out, then zoom in

Training-run logging is not a *stage* in the pipeline. It's a cross-cutting recorder that taps every stage and writes a permanent receipt for each run. Here's the generic supervised-ML pipeline with the recorder marked.

```
Where training-run logging lives
┌──────────────────────────────────────────────────────────────────────┐
│  DATA ──→ FEATURES ──→ TRAIN/VAL/TEST ──→ MODEL ──→ DEPLOY            │
│   │          │              │              │          │               │
│   │ data     │ feature      │ hyperparams  │ metrics  │ prod model id  │
│   │ version  │ set version  │ + seed       │ + confmat│                │
│   ▼          ▼              ▼              ▼          ▼               │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │  ★ TRAINING-RUN LOGGER  (one row per run)                     │    │
│  │     taps EVERY stage; writes an immutable receipt             │    │
│  └──────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

The recorder reads from each stage as the run executes and emits exactly one durable record per run. It sits *beside* the pipeline, not inside it — which is why a missing logger is invisible until the day you need it and it isn't there. Tools that do this for a living are MLflow and Weights & Biases; you're going to build a tiny version of the same idea.

## Structure pass

One axis: **what must be captured to make a run reproducible AND comparable.** Reproducible = I can rebuild this exact model. Comparable = I can rank this run against the other forty. Both demands hit the same record, and they imply different fields. The seams fall along *who owns each fact*:

- **Inputs the run consumed** — data version, feature-set version, hyperparameters, random seed. Owned upstream; the logger snapshots them.
- **Code that ran** — git commit SHA of the training code. Owned by version control; the logger reads `git rev-parse`.
- **Outputs the run produced** — train/val/test metrics, the confusion matrix (see `08-confusion-matrices.md`), the model artifact pointer. Owned by the run itself.

The seam that people skip is the middle one. They log hyperparameters and metrics, forget the commit SHA, and six months later cannot rebuild the model because the training code changed underneath them.

## How it works

### Move 1 — Mental model

A training run is a pure-ish function. Same inputs + same code + same seed → same model. The logger's job is to record the full left-hand side of that equation so the right-hand side is reproducible.

```
The reproducibility equation
┌─────────────────────────────────────────────────────────────┐
│   f( data_version,                                            │
│      feature_set_version,    ─── INPUTS (snapshot these)      │
│      hyperparameters,                                         │
│      seed ) @ code_commit    ─── CODE (snapshot this)         │
│            │                                                  │
│            ▼                                                  │
│        MODEL  +  {train/val/test metrics, confusion matrix}   │
│            │            └── OUTPUTS (snapshot these too)       │
│            ▼                                                  │
│     ONE LOG ROW = the whole equation, frozen                  │
└───────────────────────────────────────────────────────────────┘
```

If any term on the left is missing from the row, the equation is unsolvable — you cannot reproduce the model.

### Move 2 — Step by step

**Part A: Snapshot the inputs at run start**

Before a single gradient step, freeze the inputs. Don't capture them at the end — by then someone may have edited the config.

```
Run start: freeze inputs
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ data_version │   │ feature_set  │   │ hyperparams  │
│  "2026-06-   │   │  _version    │   │ {lr, epochs, │
│   01_v3"     │   │  "fs_v7"     │   │  batch}      │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       └──────────────────┼──────────────────┘
                          ▼
                  ┌───────────────┐
                  │  seed = 1337  │  ← fix it, log it
                  └───────────────┘
```

```python
# not yet exercised in aptkit — no ML training exists in packages/
def start_run(config) -> RunHandle:
    return RunHandle(
        run_id      = uuid4(),
        started_at  = now(),
        data_version       = config.data_version,        # input
        feature_set_version= config.feature_set_version, # input
        hyperparameters    = config.hyperparameters,     # input
        seed               = config.seed,                # input
        code_commit        = git_rev_parse("HEAD"),      # code
    )
```

**Part B: Capture the outputs at run end**

When training finishes, attach the results — including the confusion matrix, which is the single richest comparison artifact you get (it tells you *how* the model is wrong, not just how often).

```
Run end: attach outputs
   MODEL ──→ evaluate on train / val / test
              │
              ▼
   ┌─────────────────────────────────────────┐
   │ train_metrics : {acc .94, f1 .93}        │
   │ val_metrics   : {acc .88, f1 .86}        │
   │ test_metrics  : {acc .87, f1 .85}        │
   │ confusion_matrix : [[..],[..]]  ◄────────┼── see 08-confusion-matrices.md
   │ model_uri     : "s3://models/run-id"     │
   └─────────────────────────────────────────┘
```

```python
# not yet exercised in aptkit
def finish_run(handle, model, splits):
    write_row({
        **handle.as_dict(),
        "train_metrics": evaluate(model, splits.train),
        "val_metrics":   evaluate(model, splits.val),
        "test_metrics":  evaluate(model, splits.test),
        "confusion_matrix": confusion(model, splits.test),  # cross-ref 08
        "model_uri":     persist(model),
        "finished_at":   now(),
    })  # ONE immutable row
```

**The bridge — aptkit already has this instinct.** This is the part to internalize. aptkit does *not* log ML training runs — it trains nothing. But aptkit already logs `CapabilityEvents` and writes **replay artifacts** for every LLM run: enough to replay the run deterministically and compare two runs side by side. That is *exactly the same reproducibility discipline*, just pointed at LLM invocations instead of gradient descent. The mental move — "capture enough per run to reproduce and compare it later" — is identical. Training-run logging is that same instinct applied to ML training. So you're not learning a foreign concept; you're transferring a habit aptkit already enforces for LLM runs onto a domain it doesn't yet touch.

### Move 3 — Principle

**A run you can't reproduce is a run you can't trust, and a run you can't compare is a run you can't improve.** Log the full input equation plus the outputs, immutably, one row per run. The cost is a few fields; the cost of skipping it is the model in prod becoming a black box with no birth certificate.

## Primary diagram

```
End-to-end: one run → one immutable receipt
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  config ──┐                                                           │
│           ▼                                                           │
│      start_run() ──► snapshot {data_ver, fs_ver, hparams, seed,       │
│           │                    code_commit @ git HEAD}                │
│           ▼                                                           │
│      [ TRAIN over fixed seed ]                                        │
│           │                                                           │
│           ▼                                                           │
│      finish_run() ──► attach {train/val/test metrics,                 │
│           │                   confusion_matrix, model_uri}            │
│           ▼                                                           │
│   ┌───────────────────────────────────────────────────────────┐     │
│   │  training_runs table  (buffr / reindb agents schema)        │     │
│   │  ┌──────┬──────────┬─────────┬────────┬──────┬───────────┐ │     │
│   │  │run_id│data_ver  │fs_ver   │hparams │seed  │code_commit│ │     │
│   │  ├──────┼──────────┼─────────┼────────┼──────┼───────────┤ │     │
│   │  │ ...  │ ...      │ ...     │ {...}  │ 1337 │ a1b2c3    │ │     │
│   │  └──────┴──────────┴─────────┴────────┴──────┴───────────┘ │     │
│   │  + train/val/test metrics, confusion_matrix, model_uri      │     │
│   └───────────────────────────────────────────────────────────┘     │
│                                                                       │
│  Query: "which run made the prod model?"  → SELECT ... WHERE model_uri│
│                                              = <prod pointer>          │
└───────────────────────────────────────────────────────────────────────┘
```

Before the row exists, the prod model is an orphan. After, every prod model has a traceable parent run, and "rebuild it" becomes a `SELECT` plus a `git checkout`.

## Elaborate

A few things that separate a toy logger from a real one:

- **Immutability.** Rows are append-only. If you let runs mutate, you've reintroduced the "config changed underneath me" failure you were trying to kill. No `UPDATE` on a completed run.
- **The git commit is non-negotiable.** Hyperparameters in the row but stale code on disk means you reproduce a *different* model and conclude the logger lied. Capture `git rev-parse HEAD` and also flag a dirty working tree (`git status --porcelain` non-empty) — a dirty tree means "this run is not reproducible from any commit," and you want that recorded honestly.
- **Data version is a pointer, not a copy.** You log `"2026-06-01_v3"`, not the dataset. The version string must resolve to immutable data (a snapshot, a content hash) — otherwise the pointer dangles.
- **Confusion matrix earns its row.** Two runs with identical accuracy can have wildly different confusion matrices. Storing it (cross-ref `08-confusion-matrices.md`) is what lets you compare *failure shape*, which for contrl would be "v2 confuses rep-top with rep-bottom, v3 fixed that but now misses the eccentric phase."
- **Seed alone isn't full determinism.** GPU nondeterminism, library versions, and data-loader ordering all leak. Logging the seed gets you most of the way; a mature setup also logs library versions. For your buffr exercise, seed + commit + data version is the right scope.

## Project exercises

### EX-ML-14a — buffr training-run log table + row writer

- **Exercise ID:** `EX-ML-14a` (Phase 2C — establishing the reproducibility substrate before any ML evals exist)
- **What to build:** A new `training_runs` table in buffr's shared `agents` schema (reindb), plus a small `TrainingRunLogger` with `start_run()` / `finish_run()` that writes exactly one immutable row per run. Columns: `run_id`, `started_at`, `finished_at`, `data_version`, `feature_set_version`, `hyperparameters` (jsonb), `seed`, `code_commit`, `code_dirty` (bool), `train_metrics` (jsonb), `val_metrics` (jsonb), `test_metrics` (jsonb), `confusion_matrix` (jsonb), `model_uri`.
- **Why it earns its place:** It's the substrate everything else in this sub-section sits on — drift detection and retraining both need to point back at "the run that made the current prod model." Without the table, those features have no parent to reference. It also forces you to practice aptkit's existing replay-artifact instinct in a new domain.
- **Files to touch:** `Case B (new)` — `/Users/rein/Public/buffr/supabase/migrations/<timestamp>_create_training_runs.sql` (new migration, `agents` schema); `/Users/rein/Public/buffr/src/ml/trainingRunLogger.ts` (new logger).
- **Done when:** A test inserts a start row, finishes it with metrics + a confusion matrix, and a second `finish_run` on the same `run_id` is rejected (append-only); and `SELECT * FROM agents.training_runs WHERE model_uri = $1` returns the one parent run for a given prod pointer.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: A model is misbehaving in prod. Walk me through how you find what produced it.**

```
Prod model ──model_uri──► SELECT * FROM agents.training_runs
                          WHERE model_uri = <pointer>
                                │
                                ▼
        run row → {code_commit a1b2c3, data_version v3, seed 1337, hparams}
                                │
            git checkout a1b2c3 + load data v3 + seed 1337 → REBUILD
```

One-line anchor: *the model_uri in prod is a foreign key back to the exact run that birthed it — no row, no answer.*

**Q: Why log the confusion matrix when you already log accuracy?**

Accuracy collapses all error into one number; the confusion matrix preserves *which* classes get confused. Two runs at 87% can fail completely differently — and for contrl, "confuses rep-top with rep-bottom" vs "misses the eccentric phase" are different bugs with different fixes. One-line anchor: *accuracy says how often you're wrong; the confusion matrix says how you're wrong* (see `08-confusion-matrices.md`).

**Q: aptkit doesn't train models — why does this matter here?**

Because aptkit already practices the discipline on LLM runs via `CapabilityEvents` and replay artifacts: capture enough per run to reproduce and compare. Training-run logging is the same instinct aimed at ML. The transfer is the point. One-line anchor: *same receipt habit, different run type.*

## See also

- [`08-confusion-matrices.md`](./08-confusion-matrices.md) — what the per-run confusion matrix captures
- [`15-drift-detection.md`](./15-drift-detection.md) — detecting when the logged prod model starts degrading
- [`16-retraining-pipelines.md`](./16-retraining-pipelines.md) — what each retrain run logs back here
