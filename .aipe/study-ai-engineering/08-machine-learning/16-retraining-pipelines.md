# Retraining Pipelines

> retraining pipeline · ML lifecycle automation

Blunt as ever: **aptkit retrains nothing because aptkit trains nothing.** No scheduler, no trigger policy, no champion/challenger gate lives in `packages/`. New ground, buildable in buffr. Anchor to contrl: you shipped the pose-landmark rep counter, drift detection (`15-drift-detection.md`) flagged a PSI spike when that new wide-FOV phone landed, and now the question is operational — *when do you retrain, and how do you avoid shipping a worse model than the one you have?* A retraining pipeline is the automation that answers both without a human babysitting it.

## Zoom out, then zoom in

A retraining pipeline isn't one stage — it's a *loop* that re-enters the pipeline at DATA and re-runs everything, gated at DEPLOY. The trigger logic and the promotion gate are the new parts.

```
Where the retraining pipeline lives
┌──────────────────────────────────────────────────────────────────────┐
│                                                                        │
│   ★ TRIGGER ──► DATA ──► FEATURES ──► TRAIN/VAL/TEST ──► MODEL ──► ★GATE│
│      ▲          (new       │              │              │         │   │
│      │           labeled    │              │              │         ▼   │
│      │           data)      │              │              │     DEPLOY  │
│      │                                                     │      │     │
│      └──────────────── champion/challenger feedback ◄──────┘──────┘     │
│                                                                        │
│   ★ = the two new pieces: the TRIGGER (when) and the GATE (promote?)   │
└──────────────────────────────────────────────────────────────────────┘
```

The loop starts at a **trigger**, re-runs the standard pipeline on fresh labeled data to produce a *challenger* model, then a **gate** decides whether the challenger beats the current *champion* in prod. Only a winner gets promoted. A loser gets discarded and prod is untouched. The two starred pieces are the only genuinely new machinery; everything between them is the same training pipeline you already have.

## Structure pass

One axis: **when do you retrain, and how do you avoid regression on promote?** Two seams:

- **The trigger** — *when.* Three strategies, not one: SCHEDULED, DRIFT-TRIGGERED, PERFORMANCE-TRIGGERED. Most real systems run more than one at once (a schedule as a floor, drift/performance as interrupts).
- **The gate** — *promote or not.* Champion/challenger: the new model must *beat the incumbent on the same held-out evaluation* before it goes live. No "newer is better" assumption. Worse challenger → roll back, keep champion.

The mistake people make is building only the trigger and auto-deploying whatever it produces. That's how you ship a regression on a bad data week.

## How it works

### Move 1 — Mental model

Three triggers, one gate. The triggers are independent OR conditions; the gate is the single AND everything must pass.

```
Three triggers (OR) → one gate (AND)
        ┌─────────────────────────────────────────────┐
        │  SCHEDULED:    every N days                  │
        │  DRIFT:        PSI > 0.20  (→ 15-drift)       │ any one fires
        │  PERFORMANCE:  live_metric < floor           │ ──────────────┐
        └─────────────────────────────────────────────┘               │
                                                                       ▼
                                                            ┌──────────────────┐
                                                            │ RETRAIN producing │
                                                            │ a CHALLENGER      │
                                                            └────────┬─────────┘
                                                                     ▼
                                                            ┌──────────────────┐
                                                            │ GATE: challenger  │
                                                            │ > champion ?      │
                                                            └──────────────────┘
```

### Move 2 — Step by step

**Part A: The three triggers**

Each trigger answers "when" from a different signal. Build them as independent predicates.

```
Trigger predicates (any true → retrain)
┌────────────────────┬──────────────────────────────────────────┐
│ SCHEDULED          │ now - last_train >= N days                │
│ DRIFT-TRIGGERED    │ psi(feature) > 0.20    (from 15-drift)     │
│ PERFORMANCE-TRIG.  │ live_metric < floor    (e.g. acc < 0.85)   │
└────────────────────┴──────────────────────────────────────────┘
```

```python
# not yet exercised in aptkit — no retraining machinery exists in packages/
def should_retrain(state) -> bool:
    scheduled   = (now() - state.last_train) >= timedelta(days=state.N)
    drift       = state.max_feature_psi > 0.20        # cross-ref 15
    performance = state.live_metric < state.floor
    return scheduled or drift or performance
```

Scheduled is the safety floor — it bounds staleness even if no alarm fires. Drift and performance are interrupts that fire *between* scheduled runs when reality moves faster than your calendar.

**Part B: The champion/challenger gate**

Retraining produces a challenger. Never auto-promote. Evaluate both models on the *same* frozen eval set and compare.

```
Champion / challenger promotion
   ┌──────────────┐        same eval set        ┌──────────────┐
   │  CHAMPION     │ ──► metric_champ            │  CHALLENGER   │
   │ (in prod now) │                              │ (just trained)│ ──► metric_chal
   └──────────────┘                              └──────────────┘
            │                                            │
            └────────────────┬───────────────────────────┘
                             ▼
              metric_chal > metric_champ + margin ?
                   │ yes                  │ no
                   ▼                      ▼
              PROMOTE challenger     KEEP champion,
              (becomes new prod)     discard challenger (ROLL BACK)
```

```python
# not yet exercised in aptkit
def gate(champion, challenger, eval_set, margin=0.005):
    m_champ = evaluate(champion,  eval_set)
    m_chal  = evaluate(challenger, eval_set)
    if m_chal > m_champ + margin:
        return promote(challenger)   # new prod model
    return keep(champion)            # roll back, log the loss
```

The `margin` stops you from churning prod for noise-level improvements. A challenger that's 0.1% better isn't better — it's lucky.

**Part C: Every retrain logs back to the run log**

Each challenger is a training run, and it gets logged exactly like any other (cross-ref `14-training-run-logging.md`): data version, seed, code commit, metrics, confusion matrix. The gate's decision (promoted / rolled back) and the champion it was compared against go in the row too. That's how, months later, you answer "why did we promote run-847 over run-846?"

**`not yet exercised in aptkit`** — buffr has no trigger scheduler, no champion/challenger gate, and no model registry. This is buildable, not built.

### Move 3 — Principle

**A retraining pipeline's job is not to ship new models — it's to refuse to ship worse ones.** The trigger is the cheap half; the gate is the half that earns its keep. Automate the loop, but make promotion *prove* itself against the incumbent every single time.

## Primary diagram

```
Retraining loop, end to end
┌─────────────────────────────────────────────────────────────────────┐
│                                                                       │
│  ┌────────── TRIGGERS (any fires) ──────────┐                         │
│  │ scheduled (N days) │ PSI>0.20 (→15) │ metric<floor │              │
│  └──────────────────────┬─────────────────────────────┘              │
│                         ▼                                             │
│  collect NEW labeled data ──► retrain ──► CHALLENGER model           │
│                         │                                             │
│                         ▼                                             │
│        ┌──────── evaluate on frozen eval set ────────┐                │
│        │  champion metric   vs   challenger metric    │                │
│        └───────────────────┬───────────────────────────┘              │
│                            ▼                                          │
│            chal > champ + margin ?                                    │
│             │ yes                    │ no                             │
│             ▼                         ▼                               │
│        PROMOTE                    ROLL BACK                           │
│        (challenger → prod)        (keep champion, discard challenger) │
│             │                         │                               │
│             └─────────┬───────────────┘                               │
│                       ▼                                               │
│        LOG the run + decision ──► 14-training-run-logging            │
│        (data_ver, seed, commit, metrics, confmat, promoted?)         │
└───────────────────────────────────────────────────────────────────────┘
```

Before the loop, a contrl drift spike requires a human to notice, manually retrain, eyeball whether it's better, and manually deploy. After, the PSI > 0.20 from `15` fires the drift trigger, a challenger trains on freshly-labeled new-phone footage, the gate refuses it unless it actually beats the shipped counter, and `14` records the whole decision.

## Elaborate

- **Run multiple triggers together.** Scheduled-only goes stale between runs; drift-only never retrains on a slow-rotting concept that doesn't move `P(X)`. Combine: scheduled floor + drift interrupt + performance interrupt.
- **The eval set must be frozen and shared.** Champion and challenger evaluated on *different* sets is not a comparison, it's a coin flip. Freeze a held-out set; both models face the identical exam.
- **Shadow before promote, for the cautious version.** A stronger gate runs the challenger in *shadow* (scoring live traffic without serving its answers) and compares to the champion on real prod inputs before promoting. More infra, fewer surprises.
- **Roll-back must be one switch.** If promotion is hard to reverse, you won't promote aggressively. Keep prod model selection a pointer (the `model_uri` from `14`) so rollback is "repoint to the previous champion," not "redeploy."
- **New labeled data is the bottleneck, not compute.** Drift-triggered retraining assumes you *can* get fresh labels for the drifted population. For contrl that means labeling rep boundaries on new-phone footage — often the slow, human part of the whole loop. Build the labeling path before you build the trigger, or the trigger fires into a void.

## Project exercises

### EX-ML-16a — retraining-trigger policy

- **Exercise ID:** `EX-ML-16a` (Phase 5 — ML hardening; trigger policy is operational automation layered over a working training loop)
- **What to build:** A `shouldRetrain(state)` policy combining all three triggers as independent OR predicates: scheduled (`now - lastTrain >= N days`), drift (`maxFeaturePsi > 0.20`, consuming `15`'s scorer output), performance (`liveMetric < floor`). Returns `{ retrain: bool, reasons: string[] }` so the firing trigger(s) are recorded, not just the boolean.
- **Why it earns its place:** It's the entry point of the whole loop and the consumer of `15`'s PSI output — it turns a drift score into an action. Returning `reasons` (not just a bool) is what lets the run log in `14` record *why* a retrain happened.
- **Files to touch:** `Case B (new)` — `/Users/rein/Public/buffr/src/ml/retrain/triggerPolicy.ts` (new); `/Users/rein/Public/buffr/src/ml/retrain/triggerPolicy.test.ts` (new).
- **Done when:** Each trigger fires independently in a unit test (only-scheduled, only-drift, only-performance), `reasons` lists exactly the triggers that fired, and all-quiet returns `{ retrain: false, reasons: [] }`.
- **Estimated effort:** `1–4hr`

### EX-ML-16b — champion/challenger promotion gate

- **Exercise ID:** `EX-ML-16b` (Phase 5 — ML hardening; the regression guard on top of `16a`)
- **What to build:** A `gate(championMetric, challengerMetric, margin)` that promotes only when `challenger > champion + margin`, otherwise keeps the champion; plus a thin recorder that writes the decision (`promoted` | `rolledBack`, the two metrics, the champion's `model_uri`) into the `training_runs` row from `14`.
- **Why it earns its place:** It's the half of the pipeline that prevents regressions — the part that makes automated retraining safe enough to leave unattended. Wiring the decision into `14`'s row closes the loop: every promotion is auditable.
- **Files to touch:** `Case B (new)` — `/Users/rein/Public/buffr/src/ml/retrain/gate.ts` (new); test `/Users/rein/Public/buffr/src/ml/retrain/gate.test.ts` (new); writes into the `agents.training_runs` table created in `EX-ML-14a`.
- **Done when:** A challenger within `margin` of the champion is *not* promoted; a clear winner is promoted; and each decision appends a row recording both metrics and the outcome, queryable as "why was run-X promoted over run-Y?"
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: Why not auto-deploy every retrained model? It's trained on fresher data.**

```
fresh data ──► CHALLENGER ──► auto-deploy?  ──► NO
                                  │
              a bad data week / mislabeled batch can make
              the challenger WORSE than the champion
                                  │
              ──► gate: promote ONLY if challenger > champion + margin
```

Fresher isn't automatically better — a mislabeled batch or a quiet week produces a worse model. The gate forces every challenger to beat the incumbent on a frozen eval set. One-line anchor: *the pipeline's real job is refusing to ship regressions, not shipping novelty.*

**Q: You have a scheduled retrain every 30 days. Why also wire up drift and performance triggers?**

A 30-day schedule can't see a drift spike on day 3 — that's 27 days of silent degradation. Drift and performance triggers are interrupts that fire when reality outpaces the calendar; the schedule is just the staleness floor. One-line anchor: *the schedule bounds staleness; the interrupts catch surprises* (drift from `15`, performance from a live metric).

## See also

- [`15-drift-detection.md`](./15-drift-detection.md) — the PSI > 0.20 condition behind the drift trigger
- [`14-training-run-logging.md`](./14-training-run-logging.md) — where each retrain run and gate decision is recorded
- [`06-domain-gap.md`](./06-domain-gap.md) — the population mismatch that retraining on fresh labeled data is meant to close
