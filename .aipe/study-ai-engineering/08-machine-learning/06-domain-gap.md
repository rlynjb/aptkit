# When the world stops matching the training set (domain gap)

**Industry names:** domain gap, dataset shift, covariate shift, label shift, train/serve skew · *Industry standard*

## Zoom out, then zoom in

A model only knows the world it was trained on. The day you deploy it, the world
it actually meets is a different world — a different store, a different season, a
different country, a different sensor. The distance between *the distribution you
trained on* and *the distribution you serve on* is the domain gap, and it is the
single most common reason a model that looked great offline is mediocre in
production. Here's where it sits.

```
  Zoom out — the gap is between two distributions, not inside the model

  ┌─ TRAIN time ──────────────────────────────────────────────┐
  │  data sampled from  P_train(x, y)                          │
  │  e.g. US store, last winter, desktop traffic               │
  └───────────────────────────┬────────────────────────────────┘
                              │ freeze the model
                              ▼
  ┌─ SERVE time ───────────────────────────────────────────────┐
  │  data arrives from  P_serve(x, y)   ← a DIFFERENT distribution│
  │  e.g. EU store, summer sale, mobile traffic                 │
  └───────────────────────────┬────────────────────────────────┘
                              ▼
  ┌─ the gap ──────────────────────────────────────────────────┐
  │  ★ P_train ≠ P_serve  ←── THIS CONCEPT                      │
  │     model's learned boundary no longer fits the inputs       │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the model didn't break — it's the same weights it always had. What
changed is the data flowing past it. That reframing is the whole concept: a
domain gap is a *data* problem wearing a *model-quality* costume. You debug it by
comparing distributions, not by staring at the weights.

## Structure pass

**Layers.** Decompose the joint distribution P(x, y) into two pieces: P(x), the
inputs, and P(y | x), the label given the input. A domain gap is a change in one
or both, and *which one* changes determines the name and the fix.

**Axis — trace the kind of shift.** Walk the joint and ask which factor moved:

```
   covariate shift:  P(x) changes,  P(y|x) stays    ← inputs drift, rule holds
   label shift:      P(y) changes,  P(x|y) stays    ← class mix drifts
   concept drift:    P(y|x) changes                 ← the RULE itself moved
```

The hardest is concept drift, because the relationship the model learned is now
wrong — no amount of reweighting recovers a rule that no longer holds.

**Seams.** The load-bearing seam is the boundary where training data stops and
serving data starts — the moment you freeze the weights. Everything before that
boundary is a sample you controlled; everything after is a sample the world
controls. Cross that seam and you've left the distribution you can vouch for.

## How it works

You already know this exact failure from software, and not by an ML name: *"works
on my machine."* Staging passes, production breaks, and the diff isn't in your
code — it's in the environment: a config that drifted, a data shape staging never
saw, a locale you didn't test. A domain gap is config drift for a model. The code
(the weights) is identical; the inputs moved.

### Move 1 — the mental model

The mental model is two overlapping clouds of points. Training drew its decision
boundary to separate one cloud; serving hands it a cloud that has slid sideways.

```
  PATTERN — the boundary fits the train cloud, not the serve cloud

   feature space (one axis shown)

   TRAIN:   · · ·●●●● │ ○○○○· · ·          ● anomaly  ○ normal
                      ↑ boundary learned here
   SERVE:        · ·●●●● │ ○○○○· · ·        whole cloud shifted right →
                         ↑ same boundary, now mis-placed

   result: serve-time ● points fall on the ○ side → silent misclassification
```

The boundary is frozen where the training cloud sat. When the serving cloud
slides, the boundary doesn't follow — it can't, the weights are fixed — so points
that would have been classified correctly under P_train get classified wrong
under P_serve. The model is confidently, quietly mistaken.

### Move 2 — the load-bearing skeleton

Three moving parts: *spot it*, *name which shift*, *close the gap*.

**Symptom — great offline, bad in prod.** The defining signature. Your held-out
test set (drawn from P_train) scores high; the live numbers sag. The gap between
those two numbers *is* the domain gap, made visible.

```
  Symptom diagram — the two scores diverge

   offline (test set ⊂ P_train)   ████████████ 0.94
   online  (live ⊂ P_serve)       ██████        0.71
                                          ▲
                                          └─ this gap is the alarm
```

```
  pseudocode — the cheapest detector you can run
  offline_score = evaluate(model, holdout_from_train)
  online_score  = evaluate(model, recent_labeled_serve)
  if offline_score - online_score > tolerance:
      raise "domain gap suspected"   # before you blame the model
```

**Cause — find what moved.** A different store, season, geography, device, or
upstream pipeline change. You localize it by comparing feature distributions
between train and serve — per-feature, because the shift usually hides in one or
two inputs, not all of them at once.

```
  Cause diagram — compare per-feature distributions

   feature: avg_cart_value
     train  ▁▂▅█▅▂▁           mean ≈ $48
     serve  ▁▂▃▅█▇▅▃          mean ≈ $71   ← shifted: EU summer sale
                              this feature moved; the model never saw $71 carts
```

```
  pseudocode — localize the shift to specific features
  for f in features:
      d = distance(P_train[f], P_serve[f])   # KL, PSI, or KS-stat
      if d > threshold: flag f as shifted
  # the flagged features tell you WHICH world changed — store? season? device?
```

**Mitigation — close the gap.** Three standard moves, in rising cost.

```
  Mitigations, cheap → expensive

   reweighting ───► importance-weight train samples so they LOOK like serve:
                    weight_i = P_serve(x_i) / P_train(x_i)
                    (only fixes covariate shift, where P(y|x) still holds)

   domain adaptation ─► learn features that are INVARIANT across domains, so
                        the boundary transfers (adversarial / alignment methods)

   retrain on target ─► collect labeled serve data, retrain (or fine-tune)
                        on the NEW distribution. The honest cure when the
                        rule itself moved (concept drift).
```

```
  pseudocode — the three levers
  # 1. importance reweighting (covariate shift only)
  w_i = density_serve(x_i) / density_train(x_i)
  retrain_loss = sum( w_i * loss_i )

  # 2. domain adaptation: penalize features a domain-classifier can tell apart
  loss = task_loss - lambda * domain_classifier_loss   # adversarial

  # 3. retrain on target — the blunt, reliable one
  model = fit( labeled_serve_data )
```

Reweighting is cheap but only valid when the rule P(y|x) still holds (covariate
shift). Domain adaptation tries to learn representations that survive the move.
Retraining on target data is the blunt, reliable cure — and the only one that
addresses concept drift, where the relationship itself has changed.

### Move 3 — the principle

A domain gap is a mismatch between two distributions, not a defect in the model.
The diagnosis is always the same shape: *measure offline vs online, compare
train vs serve distributions, name which factor of P(x, y) moved, and pick the
cheapest mitigation that the kind of shift permits.* Reweighting can't fix a
moved rule; only retraining can.

## Primary diagram

The full path: two distributions, the symptom that exposes the gap, the
comparison that localizes it, and the three mitigations feeding back.

```
  Domain gap — full recap

   P_train(x,y) ──train──► [ frozen model ] ──serve──► P_serve(x,y)
        │                       │                          │
        │                       ▼                          │
        │              offline score = 0.94                │
        │                       │                          ▼
        │                       │                  online score = 0.71
        │                       └──────── gap ────────────┘
        │                                  │ symptom: great offline, bad prod
        ▼                                  ▼
   compare per-feature P_train[f] vs P_serve[f]
        │                                  │ name the shift:
        │            ┌─────────────────────┼─────────────────────┐
        ▼            ▼                      ▼                     ▼
   covariate (P(x) moved)         label (P(y) moved)      concept (P(y|x) moved)
        │                                  │                     │
        ▼                                  ▼                     ▼
   reweighting / adaptation        reweight class prior     RETRAIN on target
        └──────────────────────────────────┴─────────────────────┘
                                  │ redeploy
                                  ▼ (loop — the world keeps moving)
```

## Implementation in codebase

**Not yet implemented in AptKit — AptKit ships no trained model**, so there is no
P_train to drift away from and no weights frozen against a distribution. The
honest analog is conceptual rather than coded: the anomaly-monitoring agent
(`packages/agents/anomaly-monitoring/src/monitoring-agent.ts`) leans on
hand-authored thresholds per category
(`packages/agents/anomaly-monitoring/src/categories.ts`) — those thresholds were
chosen for an assumed traffic regime, so a store with very different baselines is
the *threshold* version of a domain gap (a constant tuned for one distribution
applied to another), even though no model was ever trained.

## Elaborate

"Dataset shift" was systematized in *Dataset Shift in Machine Learning*
(Quiñonero-Candela et al., 2009), which gives the covariate/label/concept
taxonomy used above. Importance reweighting for covariate shift traces to Shimodaira
(2000). Domain-adversarial training (Ganin et al., 2016) is the canonical
"learn domain-invariant features" method.

This file's closest cousin in the section is `15-drift-detection.md`: a domain
gap is the *condition*, drift detection is the *monitor* that catches it moving —
PSI and the KS-statistic in that file are precisely the per-feature distances
Move 2 calls for. And the framing rhymes with the anomaly agent's own job:
spotting that "now" no longer looks like "before" is anomaly detection pointed at
your own input stream.

You touched the supervised-pipeline shape once with on-device CV pose landmarking
in MediaPipe — a vivid place this bites is lighting and camera: a landmark model
trained on bright indoor footage meets a dim phone camera, the input distribution
shifts, and accuracy quietly drops with no code change at all. That's covariate
shift you can feel.

Read-next: `15-drift-detection.md`, `16-retraining-pipelines.md` (retrain-on-target
is a *trigger* there), `09-calibration.md` (a shifted domain wrecks calibration
even when ranking survives).

## Project exercises

*Provenance: Phase 2C — Machine learning (C2C.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case B — new ground; AptKit has no model to
detect a gap on, so this is a measurable analog plus a thought experiment.*

### Exercise — train-vs-serve distribution probe

- **Exercise ID:** `[C2C.6]` Phase 2C, domain-gap concept
- **What to build:** Pick one anomaly category's driving metric (e.g.
  `conversion_drop`'s funnel counts) and compute a per-feature distribution
  distance (PSI or KS) between two event windows that stand in for "train"
  (baseline period) and "serve" (recent period). Surface a flag when the distance
  crosses a threshold. Then write a short note framing what would change if a
  *trained* classifier — rather than a thresholded LLM — sat behind that metric,
  and which mitigation (reweight vs retrain) the shift kind would permit.
- **Why it earns its place:** Being able to localize a shift to a specific
  feature and name covariate vs concept drift is rare, and it's the exact muscle
  interviewers test with "great offline, bad in prod — now what?"
- **Files to touch:** A new distribution-distance helper under
  `packages/evals/src/` and a test in `packages/evals/test/`; the baseline/recent
  windows read from existing event fixtures. A real domain-adaptation training
  pipeline does not belong in AptKit — keep that on paper.
- **Done when:** A test feeds two deliberately-shifted fixtures and asserts the
  probe flags the moved feature, and the note names the permissible mitigation.
- **Estimated effort:** `4–8hr`

## Interview defense

**Q: Your model scores 0.94 offline and 0.71 in production. Walk me through it.**

```
   offline 0.94  ─┐
                  ├─ gap ⇒ suspect P_train ≠ P_serve, not the weights
   online  0.71  ─┘
   next: compare per-feature train vs serve → which one moved?
```

"That gap is the signature of a domain gap. The weights didn't change, so I don't
debug the model — I compare the input distributions, train versus serve, per
feature, to localize which one moved. Then I name the shift: if only P(x) moved
and the rule still holds, it's covariate shift and I can reweight; if P(y|x)
moved, the rule itself changed and only retraining on target data fixes it."
*Anchor: an offline/online gap is a distribution mismatch, not a model defect.*

**Q: When can you reweight, and when must you retrain?**

```
   covariate shift (P(y|x) holds) ──► reweight: cheap, valid
   concept drift  (P(y|x) moved)  ──► retrain on target: the only honest fix
```

"Reweighting only works when the *rule* still holds — covariate shift, where just
the inputs drifted. The moment the relationship between input and label changes —
concept drift — reweighting is reweighting toward a rule that's now wrong. Then I
have to collect labeled data from the new distribution and retrain or fine-tune
on it."
*Anchor: you can reweight a moved input, but you must retrain a moved rule.*

## Validate

- **Reconstruct:** From memory, decompose P(x, y) and define covariate shift,
  label shift, and concept drift in terms of which factor moves.
- **Explain:** Why is "great offline, bad in prod" the canonical symptom? (The
  offline score is measured on a sample of P_train; the online score on P_serve.
  Their divergence *is* the gap, made numeric.)
- **Apply:** Take `conversion_drop` from
  `packages/agents/anomaly-monitoring/src/categories.ts`. Its thresholds assume a
  traffic regime. Describe the "domain gap" a brand-new store with 10× the
  baseline traffic would create for those constants, and which kind of shift it
  most resembles.
- **Defend:** Why can importance reweighting fail silently on concept drift?
  (Reweighting assumes P(y|x) is unchanged and only re-balances P(x); if the rule
  itself moved, you're up-weighting samples toward a relationship that no longer
  exists, so the fix is invalid even though the code runs.)

## See also

- [15-drift-detection.md](15-drift-detection.md) — the monitor that catches the gap moving (PSI, KS)
- [16-retraining-pipelines.md](16-retraining-pipelines.md) — retrain-on-target as a scheduled/drift trigger
- [09-calibration.md](09-calibration.md) — a shifted domain breaks calibrated probabilities
- [03-train-val-test.md](03-train-val-test.md) — the split discipline a gap quietly defeats
- [README.md](README.md) — the honest banner for this whole section
