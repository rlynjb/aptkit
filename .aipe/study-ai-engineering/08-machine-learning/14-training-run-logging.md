# Training-run logging

**Subtitle:** every run logs enough to reproduce and compare it · *Industry standard*

## Zoom out, then zoom in

aptkit trains no models, so the layers below are the *generic* supervised
pipeline. The point of this file is the band drawn *across* it: the
logging/tracking layer that records one row per run so you can answer "what
changed?" later. It is not a stage — it is a cross-cutting concern that taps
every stage and emits one durable record.

```
  Zoom out — the pipeline with the tracking band across it

  ┌─ Data layer ───────────────────────────────────────────────┐
  │  labeled rows @ DATA VERSION (snapshot id / hash)           │──┐
  └────────────────────────────┬───────────────────────────────┘  │
                               │ featurize                         │
  ┌─ Feature layer ────────────▼───────────────────────────────┐  │
  │  numeric X @ FEATURE VERSION (feature code / config sha)    │──┤
  └────────────────────────────┬───────────────────────────────┘  │
                               │ fit (HYPERPARAMS, CODE git sha)   │
  ┌─ Model layer ──────────────▼───────────────────────────────┐  │
  │  fitted f(X) → ŷ                                            │──┤
  └────────────────────────────┬───────────────────────────────┘  │
                               │ evaluate                          │
  ┌─ Metrics layer ────────────▼───────────────────────────────┐  │
  │  precision@k / recall@k on held-out test                    │──┤
  └─────────────────────────────────────────────────────────────┘  │
                                                                    ▼
  ★ ════ TRACKING BAND ═══════════════════════════════════════════ ★
  │  one RUN RECORD: {run_id, ts, data_ver, feature_ver,            │
  │  hyperparams, code_sha, metrics} — spans data → model → metrics │
  ════════════════════════════════════════════════════════════════
```

Now zoom in. Without that record, "the model got worse this week" is
undebuggable — you cannot tell whether the data snapshot moved, the feature code
changed, a hyperparameter was nudged, or someone shipped a different commit. The
discipline is simple and unglamorous: *every run logs its inputs and its
outputs, keyed by a run id and a timestamp.* You already practice this in
aptkit — on eval runs, not training runs.

## Structure pass

**Layers.** Data → feature → model → metrics, and a tracking band laid across
all four. Each pipeline layer contributes one *version* field to the record; the
metrics layer contributes the *result* fields. The record is the only artifact
that sees all layers at once.

**Axis — what must I log to reproduce this run?** Five inputs and one output.
Inputs: which data (data version), which feature code (feature version), which
knobs (hyperparameters), which code (git sha), and *when* (timestamp + run id).
Output: the metrics. If any input is missing from the record, a regression
becomes a guessing game — you can re-run but you cannot diff.

**Seam.** The load-bearing boundary is **the run record schema** — the fixed set
of fields every run must populate before it is allowed to count. Above the seam:
humans comparing runs in a table. Below it: training code writing one JSON/row.
The axis "can two runs be compared?" flips exactly here — a run with a record is
comparable; a run without one is folklore.

## How it works

### Move 1 — the mental model

You already own this discipline. Every aptkit replay run writes a structured
artifact to `artifacts/replays/*.json`, and it records *exactly the fields a
training-run log records* — just for an eval run instead of a fit. Open
`2026-06-18T19-29-11-225Z-revenue-by-state-query-fixture-studio.json`: it logs
`provider:{id,model}` (which model produced this), `fixture:{path}` (which
dataset fed it), `createdAt` (when), `durationMs` (how long), and the output
(`answer`). That is a run record. The "training" is the only missing word.

```
  Pattern — every run emits one durable record

  ┌──────────────┐  reads inputs   ┌─────────────────────────────┐
  │  a run       │ ──────────────► │  RUN RECORD (one JSON/row)  │
  │  (fit OR     │  writes output  │  inputs: which data, code,  │
  │   replay)    │ ──────────────► │  knobs, when               │
  └──────────────┘                 │  output: the metrics       │
                                   └─────────────────────────────┘
        many runs ──► many records ──► one comparison table
```

You don't compare runs by re-running them. You compare the *records* they left
behind. The record outlives the process.

### Move 2 — the five inputs and one output, one field at a time

A reproducible run record pins five inputs and records one output. Each maps
onto a field aptkit's replay artifact already writes.

**Data version — which snapshot fed the run.** Not "the dataset" — *which
version* of it. A path, a content hash, or a snapshot id. Change the rows and
the record must change.

```
  data_version: "voucher-dropoff.json@sha:9f3a…"   (snapshot, not "latest")
        │
        └─► aptkit replay logs this as:  fixture.path
            "packages/agents/recommendation/fixtures/voucher-dropoff.json"
```

**Feature version — which feature code/config.** The feature function is the
train/serve seam (file 01). Its version belongs in the record so a feature-code
change is visible as a different run, not a silent drift.

```
  feature_version: "featurize.py@git:4c2e…"   (the code that built X)
        │
        └─► aptkit replay analogue: fixture.description / capabilityId
            (which capability + intent shaped the input)
```

**Hyperparameters — the knobs.** Learning rate, depth, regularization, k.
Logged as a flat map so two runs diff cleanly.

```
  hyperparams: { lr: 0.01, max_depth: 6, k: 10 }
        │
        └─► aptkit replay analogue: provider.model + (temperature/maxTokens
            in the ModelRequest) — the run-shaping knobs
```

**Code / model version — which commit produced f.** A git sha pins the training
code and the model architecture together. Without it, "same data, same
hyperparams, different result" has no explanation.

```
  code_sha: "git:1a9f…"        model_version: "reranker-v3"
        │
        └─► aptkit replay logs this as:  provider: { id, model }
            { id: "openai", model: "gpt-4.1" }   ← the "which model" field
```

**Timestamp + run id — when, and a stable key.** The id makes the run
addressable; the timestamp orders the history.

```
  run_id: "run-2026-06-18-001"   created_at: "2026-06-18T19:29:11.225Z"
        │
        └─► aptkit replay logs this as:  createdAt  (+ the filename is the id)
```

**Metrics — the one output.** The numbers you compare runs on. In aptkit these
come from `scorePrecisionAtK` / `scoreRecallAtK`
(`packages/evals/src/precision-at-k.ts`) — the per-run metric you would log.

```
  metrics: { precision_at_10: 0.62, recall_at_10: 0.48, duration_ms: 8211 }
        │
        └─► aptkit replay logs the result + cost:  eval.ok, durationMs,
            trace[].inputTokens / outputTokens
```

Field-by-field, the replay artifact *is* a run record:

```
  REPLAY ARTIFACT  (artifacts/replays/*.json)      TRAINING-RUN RECORD
  ┌─────────────────────────────────┐              ┌──────────────────────┐
  │ filename + createdAt            │ ───────────► │ run_id + timestamp   │
  │ provider: { id, model }         │ ───────────► │ model_version /      │
  │                                 │              │ code_sha             │
  │ fixture: { path }               │ ───────────► │ data_version         │
  │ fixture: { description }        │ ───────────► │ feature_version      │
  │ (ModelRequest temp / maxTokens) │ ───────────► │ hyperparams          │
  │ eval.ok + durationMs            │ ───────────► │ metrics              │
  │ trace[].input/outputTokens      │ ───────────► │ cost metrics         │
  │ answer / recommendations        │ ───────────► │ predictions (output) │
  └─────────────────────────────────┘              └──────────────────────┘
```

A training-run record as annotated JSON — same shape, training words:

```jsonc
{
  "run_id": "run-2026-06-18-001",          // stable, addressable key
  "created_at": "2026-06-18T19:29:11.225Z",// orders the history
  "data_version": "rerank-train.csv@sha:9f3a",  // WHICH rows
  "feature_version": "featurize.py@git:4c2e",   // WHICH feature code
  "code_sha": "git:1a9f",                  // WHICH training commit
  "model_version": "reranker-v3",          // WHICH architecture
  "hyperparams": { "lr": 0.01, "k": 10 },  // the knobs, flat for diffing
  "metrics": {                             // the one output you compare on
    "precision_at_10": 0.62,
    "recall_at_10": 0.48
  }
}
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study
ground. But aptkit *does* log per-run replay artifacts (`artifacts/replays/*.json`)
that map 1:1 onto a training-run record: `provider.{id,model}` ≈ model version,
`fixture.path` ≈ data version, `createdAt` ≈ timestamp, `durationMs` + `eval.ok`
≈ metrics, and the output blocks ≈ predictions. You already own the discipline
end to end — you apply it to *eval* runs instead of *training* runs.

### Move 3 — the principle

A run you cannot reproduce or compare did not happen — it left no evidence. Log
the five inputs and the one output, keyed by id and time, *before* you trust the
result. The record, not the process, is the unit of comparison. aptkit proves
the habit is already yours: it writes one structured artifact per replay, and a
training pipeline only adds the word "fit" to the same record.

## Primary diagram

The whole loop: many runs, each leaving one record, compared in one table.

```
  From runs to a comparison table

  run A ─┐                                   ┌─────────────────────────────┐
  run B ─┤  each writes 1 record  ┌────────► │  COMPARISON TABLE           │
  run C ─┘  (5 inputs + metrics)  │          │  diff inputs → explain Δ    │
            │                     │          └─────────────────────────────┘
            ▼                     │
  ┌──────────────────────────────┴──┐
  │ {run_id, ts, data_ver, feat_ver, │   ★ the record is the seam ★
  │  hyperparams, code_sha, metrics} │   no record → "the model got worse"
  └──────────────────────────────────┘       is unanswerable
```

A multi-run comparison table is the payoff — one row per record, inputs on the
left, the metric on the right, so a metric drop lines up with the input that
moved:

```
  run_id   data_ver   feat_ver   code_sha   lr     k    prec@10  recall@10
  ─────────────────────────────────────────────────────────────────────────
  001      v9f3a      4c2e       1a9f       0.01   10   0.62     0.48
  002      v9f3a      4c2e       2b8d       0.01   10   0.66     0.51   ← code↑
  003      vA1c4      4c2e       2b8d       0.01   10   0.58     0.44   ← data moved
  004      vA1c4      7e91       2b8d       0.10   10   0.41     0.30   ← feat+lr both
  ─────────────────────────────────────────────────────────────────────────
  run 003's drop is the DATA column; run 004 changed two inputs at once —
  unattributable. One input per run, or the table cannot explain the metric.
```

## Elaborate

The hard-won lesson behind MLflow / Weights & Biases is that comparison is only
possible when *exactly one thing changes per run* and that thing is recorded.
Run 004 above is the cautionary tale: it moved feature version *and* learning
rate, so its metric drop is unattributable — the record is present but the
experiment is wasted. The tooling does not enforce discipline; it only stores
records. The same trap exists in aptkit replays: if you swap the fixture *and*
the provider in one replay, the artifact still writes, but you can no longer say
whether the data or the model caused the output to change. The record schema is
necessary but not sufficient — the *one-variable-per-run* habit is what makes it
pay. Read `15-drift-detection.md` next: drift is what you detect *between* runs
once you can compare them.

## Project exercises

### Build a run-comparison table from replay artifacts
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that reads every `artifacts/replays/*.json`, pulls
  `createdAt`, `provider.{id,model}`, `fixture.{id,path}`, `durationMs`,
  `eval.ok`, and `trace[].inputTokens/outputTokens`, and prints a one-row-per-run
  comparison table (run id from the filename) sorted by timestamp.
- **Why it earns its place:** turns the existing replay artifacts into the
  comparison table this file argues for — proving you can read records you
  already produce and diff runs without re-running them.
- **Files to touch:** reads `/Users/rein/Public/aptkit/artifacts/replays/`,
  new file `/Users/rein/Public/aptkit/packages/evals/src/run-table.ts`.
- **Done when:** running it prints a fixed-column table where each replay is one
  row and a provider/fixture difference is visible column-by-column.
- **Estimated effort:** `1–4hr`

### Write a run record alongside a learned-reranker fit
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** extend a learned-reranker training loop so that after each
  fit it writes a run record `{run_id, created_at, data_version, feature_version,
  code_sha, hyperparams, metrics}` to disk, mirroring the replay-artifact shape,
  with metrics from `scorePrecisionAtK` / `scoreRecallAtK`.
- **Why it earns its place:** closes the loop from this section — you produce the
  `(X,y)` dataset (file 01), fit a model (file 04), and now log the run so the
  next fit is comparable, not folklore.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/rerank-run-record.ts`,
  using `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`.
- **Done when:** two fits with different hyperparams write two records whose
  `hyperparams` and `metrics` differ and whose `code_sha`/`data_version` match,
  and the records load into the table from exercise 1.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "A model regressed week over week. How do you find what changed?"**
You don't guess — you diff the run records. Pull last week's record and this
week's, line up data version, feature version, hyperparams, and code sha, and the
column that moved is your suspect. If no records exist, you cannot answer at all;
you can only re-run blind. That is why the record is logged *before* the result
is trusted.

```
  run_t-1 ┐
          ├─► diff inputs ─► the field that changed ─► the cause
  run_t   ┘    (data? feature? hyperparam? code?)
```
*Anchor: aptkit's replay artifacts already log provider, fixture path, and
timestamp per run — diff two and the change is visible.*

**Q: "What's the minimum a run must log to be reproducible?"**
Five inputs and one output: data version, feature version, hyperparameters, code
sha, and a timestamp+run id — plus the metrics. Drop any input and the run
becomes a result you can observe but not explain. aptkit's replay JSON logs the
analogue of every one of these per eval run.

```
  reproducible = data_ver + feat_ver + hyperparams + code_sha + (id, ts)
                 ───────────────── inputs ─────────────────   + metrics(out)
```
*Anchor: the replay artifact's `provider` + `fixture.path` + `createdAt` +
`eval` are the same fields, logged for replays instead of fits.*

## See also

- `15-drift-detection.md` — what you detect once runs are comparable
- `16-retraining-pipelines.md` — the loop that produces a new run to log
- `01-supervised-pipeline.md` — the pipeline whose stages each contribute a field
- `05-evals-and-observability/` — how aptkit records and grades runs today
