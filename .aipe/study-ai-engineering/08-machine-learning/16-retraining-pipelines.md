# Retraining pipelines

**Subtitle:** the file-01 pipeline put on a trigger, with a promotion gate · *Language-agnostic*

## Zoom out, then zoom in

File 01 drew the supervised pipeline as a straight arc: data → features → split →
fit → serve. A retraining pipeline is that exact arc bent into a circle. Serving
feeds a monitor, the monitor arms a trigger, the trigger re-runs the arc, and a
gate decides whether the new model ever reaches serving. The starred boxes — the
TRIGGER and the GATE — are the only parts that don't already exist in file 01.

```
  Zoom out — the supervised pipeline bent into a loop

  ┌─ Serving layer ──────────────────────────────────────────────────┐
  │  current model f_live serves; every run logged (file 14)         │◄──┐
  └───────────────────────────┬───────────────────────────────────────┘   │
                              │ metrics + replay artifacts                 │
  ┌─ Monitor layer ───────────▼───────────────────────────────────────┐   │
  │  drift (PSI, file 15) · live metric vs floor · calendar clock      │   │
  └───────────────────────────┬───────────────────────────────────────┘   │
                              │ condition crosses threshold                │
  ┌─ Trigger layer ───────────▼───────────────────────────────────────┐   │ deploy
  │  ★ TRIGGER ★  scheduled | drift | performance — fires a retrain    │   │ (only if
  └───────────────────────────┬───────────────────────────────────────┘   │  gate
                              │ collect fresh labels → re-run files 01–04  │  passes)
  ┌─ Retrain layer ───────────▼───────────────────────────────────────┐   │
  │  fit candidate f_new on accumulated data, fixed held-out set       │   │
  └───────────────────────────┬───────────────────────────────────────┘   │
                              │ score candidate on held-out               │
  ┌─ Gate layer ──────────────▼───────────────────────────────────────┐   │
  │  ★ PROMOTION GATE ★  f_new ships only if metric ≥ f_live's         │───┘
  └─────────────────────────────────────────────────────────────────────┘
```

Now zoom in. Nothing in the Retrain layer is new — it is files 01–04 verbatim.
What turns a one-shot pipeline into a *pipeline* is the loop's two new boxes: the
condition that decides *when* to fire, and the gate that decides *whether the
output is allowed to replace the incumbent*. An LLM person already owns the gate
half of this without realizing it — you already run evals to decide if an output
regressed. The gate here is the same eval, pointed at a model swap instead of a
prompt change.

## Structure pass

**Layers.** Serving → monitor → trigger → retrain → gate → back to serving. The
retrain layer is the entire file-01 arc collapsed into one box; the loop is the
contribution of *this* file. Each pass around the loop either swaps the model or
keeps the old one — never silently degrades.

**Axis — what fires the retrain?** Trace the trigger backward and you find three
distinct signals, in increasing directness and increasing cost. A *clock* fires
on the calendar (cheapest signal, blindest). *Drift* fires when the input
distribution moves (file 15 — catches the cause before the symptom). *Performance*
fires when the live metric drops below a floor (the symptom itself — most direct,
but needs fresh labels to measure). Pick by how fast your data shifts and how
expensive labels are.

**Seam.** The load-bearing boundary is **the promotion gate** — the single
comparison `metric(f_new) ≥ metric(f_live)` on a *fixed* held-out set. Above it:
a freshly fitted candidate, unproven. Below it: production traffic. The gate is
the one place that guarantees retraining can only hold steady or improve, never
regress. Remove it and "retraining" becomes "deploying an untested model on a
timer."

## How it works

### Move 1 — the mental model

You already run `scorePrecisionAtK` (`packages/evals/src/precision-at-k.ts`) to
decide whether an output regressed: take the candidate's retrieved ids, take the
known-relevant ids, compute `matched / min(k, retrieved)`, refuse to ship if the
score dropped. A promotion gate is *that same call*, except the thing being
graded is a retrained model instead of a new prompt. Same metric, same held-out
fixtures, same refuse-on-regression rule — different artifact under test.

```
  Pattern — the eval gate you already run, now gating a model swap

  prompt change ──┐                          model swap ──┐
                  ▼                                        ▼
        ┌───────────────────┐                   ┌───────────────────┐
        │ scorePrecisionAtK │   same gate, same  │ scorePrecisionAtK │
        │  on fixtures      │ ◄── metric, same ──►│  on held-out set  │
        └─────────┬─────────┘   threshold rule    └─────────┬─────────┘
                  │                                          │
       ship only if ≥ baseline                   promote only if ≥ incumbent
```

The gate doesn't care whether the change upstream was a reworded system prompt or
a refit reranker. It cares only: did the score on the frozen set hold or improve?

### Move 2 — the loop, one box at a time

**Trigger A — scheduled.** Retrain every N days regardless of state. Simplest to
reason about, fully predictable, and it needs no monitoring infrastructure. The
cost: you either retrain when nothing changed (wasted compute) or you lag a sudden
shift that lands the day after a run.

```
  Scheduled trigger — fire on the clock, ignore state

  ┌──────────┐  every 7d  ┌──────────┐
  │  clock   │ ─────────► │ retrain  │   (no signal from the data at all)
  └──────────┘            └──────────┘
```

```python
# Scheduled trigger — the whole condition is the calendar.
def should_retrain_scheduled(last_run_at, now, interval_days=7):
    return (now - last_run_at).days >= interval_days   # that is the entire check
```

**Trigger B — drift-triggered.** Retrain when the input distribution moves — reuse
the PSI computation from file 15. Catches the *cause* (inputs changed) before the
*symptom* (metric drops), and needs no fresh labels to fire. The cost: drift does
not always hurt the metric, so you can retrain on a shift that didn't matter.

```
  Drift trigger — fire when inputs move past a threshold

  ┌──────────────┐  PSI > 0.2  ┌──────────┐
  │ PSI(live vs  │ ──────────► │ retrain  │
  │  training)   │             └──────────┘
  └──────────────┘   (file 15 supplies PSI)
```

```python
# Drift trigger — arm on distribution shift (PSI from file 15).
def should_retrain_drift(psi_value, threshold=0.2):
    return psi_value > threshold     # 0.1–0.2 = watch, >0.2 = significant shift
```

**Trigger C — performance-triggered.** Retrain when the monitored metric falls
below a floor. The most direct signal — it fires on the actual harm, not a proxy.
The cost: you need *fresh labels* to measure live precision, and on buffr's
single-user corpus those labels accrue slowly (you only generate so many real
queries a week).

```
  Performance trigger — fire when the live metric drops below the floor

  ┌──────────────┐  p@k < 0.70  ┌──────────┐
  │ live p@k on  │ ───────────► │ retrain  │
  │ recent labels│              └──────────┘
  └──────────────┘   (needs fresh ground-truth labels)
```

```python
# Performance trigger — arm when measured live metric breaches the floor.
def should_retrain_performance(live_p_at_k, floor=0.70):
    return live_p_at_k < floor       # requires labeled recent traffic to compute
```

**The collect → train → eval → gate → deploy loop.** Whichever trigger fires, the
body is identical. Collect fresh labeled data (buffr's corpus has grown since last
run), re-run the file-01 pipeline to fit a candidate, score the candidate on a
*frozen* held-out set, and pass it through the gate. The held-out set must not
change between runs — if it moves, the comparison is meaningless.

```
  The retrain body — one pass around the loop

  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ collect  │──►│ re-train │──►│  eval on │──►│ PROMOTION│──►│  deploy  │
  │ fresh    │   │ (files   │   │  FIXED   │   │  GATE ★  │   │ (shadow/ │
  │ labels   │   │  01–04)  │   │ held-out │   │          │   │  canary) │
  └──────────┘   └──────────┘   └──────────┘   └────┬─────┘   └──────────┘
                                                    │ fail
                                          keep f_live, log, wait
```

```python
# Promotion gate — the seam. Score both on the SAME frozen set; swap only if won.
def promote_if_better(f_new, f_live, held_out):
    new_score  = score_precision_at_k(f_new(held_out.queries),  held_out.relevant)
    live_score = score_precision_at_k(f_live(held_out.queries), held_out.relevant)
    log_run(candidate=f_new, new=new_score, incumbent=live_score)   # file 14
    if new_score >= live_score:        # ≥, not > : ties keep the simpler/newer fit
        return f_new                   # promote — begin shadow/canary rollout
    return f_live                      # regression — keep incumbent, no deploy
```

Even when the gate passes, you don't hard-swap. The promoted model goes out as a
shadow (runs in parallel, serves nothing) or a canary (serves a slice), and the
loop closes: serving logs again, the monitor watches again, the next trigger arms.

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.
The closest real artifacts are the eval bridge (`scorePrecisionAtK` /
`scoreRecallAtK` in `packages/evals/src/precision-at-k.ts`) and the per-run replay
logs under `/Users/rein/Public/aptkit/artifacts/replays/*.json`. Those replays are
the eval substrate: the same JSON that today proves an LLM output didn't regress
is exactly the held-out evidence a promotion gate would score a retrained model
against. buffr, being single-user with a corpus that grows over time, is the
natural place a personal reranker or intent classifier *would* be retrained.

### Move 3 — the principle

A retraining pipeline is just the file-01 pipeline put on a trigger, with a
promotion gate. The retrain step is not new engineering — it is the supervised arc
you already built. The new engineering is (1) a condition that decides *when* to
fire and (2) a gate that decides *whether the result is allowed to ship*. The gate
is the same eval gate you already run on outputs; here it gates a model swap. Build
the gate first — an automated retrain without one is an automated regression.

## Primary diagram

```
  The closed retraining loop, with the trigger and the gate marked

                     ┌──────────────────────────────────────────┐
                     │                                          ▼
  ┌──────────┐  log  ┌──────────┐  signal  ┌──────────┐  fire  ┌──────────┐
  │  SERVE   │ ────► │ MONITOR  │ ───────► │ ★TRIGGER★│ ─────► │ RETRAIN  │
  │ f_live   │       │ drift /  │          │ sched |  │        │ files    │
  │          │       │ metric / │          │ drift |  │        │ 01–04 →  │
  └────▲─────┘       │ clock    │          │ perf     │        │ f_new    │
       │             └──────────┘          └──────────┘        └────┬─────┘
       │ promote (shadow/canary)                                    │ score on
       │                                                            │ FIXED
       │             ┌──────────────────────────────────────┐      │ held-out
       └──────────── │ ★PROMOTION GATE★                     │ ◄────┘
            f_new     │ scorePrecisionAtK(f_new) ≥           │
                     │ scorePrecisionAtK(f_live) ? promote   │
         pass ──────►│ : keep f_live    ──► fail (no deploy) │
                     └──────────────────────────────────────┘
```

Trigger-strategy comparison — pick by how fast data shifts and label cost:

```
  ┌────────────────┬──────────────────┬───────────────┬────────────────────┐
  │ Strategy       │ Fires on         │ Needs labels? │ Failure mode       │
  ├────────────────┼──────────────────┼───────────────┼────────────────────┤
  │ SCHEDULED      │ the calendar     │ no (to fire)  │ wastes compute OR  │
  │                │ (every N days)   │               │ lags a sudden shift│
  ├────────────────┼──────────────────┼───────────────┼────────────────────┤
  │ DRIFT-         │ PSI > threshold  │ no (to fire)  │ retrains on shifts │
  │ TRIGGERED      │ (file 15)        │               │ that didn't hurt   │
  ├────────────────┼──────────────────┼───────────────┼────────────────────┤
  │ PERFORMANCE-   │ live metric <    │ YES — must    │ slow to fire if    │
  │ TRIGGERED      │ floor            │ measure live  │ labels accrue slow │
  └────────────────┴──────────────────┴───────────────┴────────────────────┘
   most teams run scheduled + drift as the floor, performance when labels are cheap
```

## Elaborate

The hard-won lesson of retraining pipelines is that the retrain step is the easy
part — it's code you already wrote in file 01. The failures cluster in the two new
boxes. A trigger with no gate ships untested models on a timer; that is the most
common way a "self-improving" system silently degrades. A gate whose held-out set
is *not frozen* — say it's regenerated from recent traffic each run — makes the
incumbent-vs-candidate comparison incoherent, because the two models are scored
against different rulers. And the choice of trigger is a data-velocity decision,
not a sophistication contest: a corpus that barely moves wants a slow scheduled
clock; a corpus under a sudden distribution shift wants drift detection (file 15)
arming the trigger before the metric ever drops. The gate itself is the part you
already own from the eval side — `scorePrecisionAtK` over the replay set is the
exact same machinery, which is why the bridge from "I run evals" to "I run a
retraining pipeline" is shorter than it looks. Read `15-drift-detection.md` for
the drift trigger's PSI, and `14-training-run-logging.md` for what each loop pass
records.

## Project exercises

### Build a promotion-gate script for a learned reranker
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that fits a candidate reranker on buffr's
  accumulated labeled data, scores both the candidate and the current retrieval
  baseline on a *frozen* held-out set with `scorePrecisionAtK`, and promotes the
  candidate only if its p@k is `>=` the incumbent's — otherwise keeps the
  incumbent and logs the rejected run.
- **Why it earns its place:** the promotion gate is the load-bearing seam of the
  whole loop; building it proves you can turn an eval into a deploy decision, the
  exact bridge from output-grading to model-promotion.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/promotion-gate.ts`,
  reading `/Users/rein/Public/buffr/eval/queries.json` and using
  `scorePrecisionAtK` from
  `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`.
- **Done when:** the script prints both scores and a `PROMOTE` / `KEEP` decision,
  and a deliberately-worse candidate is correctly rejected against the held-out
  set.
- **Estimated effort:** `1–4hr`

### Build a scheduled-retrain harness over the replay artifacts
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a harness that treats
  `/Users/rein/Public/aptkit/artifacts/replays/*.json` as the held-out eval
  substrate, checks a scheduled trigger condition (last-run timestamp vs an
  interval), and on fire runs the collect → eval → gate sequence end to end,
  appending a one-line run record per pass.
- **Why it earns its place:** wires a trigger to the gate over *real* logged
  artifacts, making the closed loop concrete instead of diagrammed — you see the
  loop refuse to deploy when the candidate doesn't beat the incumbent.
- **Files to touch:** new
  `/Users/rein/Public/aptkit/packages/evals/test/retrain-harness.test.ts`,
  reading `/Users/rein/Public/aptkit/artifacts/replays/` and
  `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts`.
- **Done when:** `node --test` shows the trigger firing on an elapsed interval and
  the gate emitting `PROMOTE` / `KEEP` per replay-backed run.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: "How is a retraining pipeline different from a training pipeline?"**
It isn't, at the core — the retrain step *is* the training pipeline (files 01–04).
What's added is a loop: a trigger that decides *when* to re-run it, and a promotion
gate that decides *whether* the result is allowed to replace the live model. Strip
those two boxes and you have file 01 again.

```
  training:    data ─► fit ─► serve
  retraining:  data ─► fit ─► GATE ─► serve ─► monitor ─► TRIGGER ─┐
                                ▲                                  │
                                └──────────────────────────────────┘
```
*Anchor: a retraining pipeline is the file-01 pipeline put on a trigger, with a gate.*

**Q: "How do you make sure automated retraining never degrades production?"**
A promotion gate. Score the candidate and the incumbent on the *same frozen*
held-out set with the same metric — `scorePrecisionAtK` over the replay fixtures —
and promote only if the candidate ties or beats the incumbent. It's the same eval
gate you run to decide if an output regressed, pointed at a model swap. No gate
means a timer that ships untested models.

```
  f_new  ─► scorePrecisionAtK ─┐
                               ├─► new ≥ live ? promote : keep f_live
  f_live ─► scorePrecisionAtK ─┘   (same frozen held-out set, same metric)
```
*Anchor: the promotion gate is the eval gate — ship only if it beats the incumbent.*

## See also

- `15-drift-detection.md` — the PSI signal that arms the drift trigger
- `14-training-run-logging.md` — what each pass around the loop records
- `01-supervised-pipeline.md` — the arc the retrain step re-runs verbatim
