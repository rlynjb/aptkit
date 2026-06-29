# Quantization

> quantization · model compression

Blunt up front: aptkit quantizes nothing. There is no model in `packages/` to compress, no precision knob to turn. This file is new ground and `not yet exercised in aptkit`. I am scaffolding the concept so that when you need to fit a model onto constrained hardware, you reach for the right lever on purpose.

You met the *need* for this in contrl without naming it. A pose model running on-device in a real-time hot path lives or dies by how small and fast it is — every megabyte and millisecond on a phone is contested. Quantization is the standard lever for buying that headroom: trade a little numeric precision for a smaller, faster model. That is the whole pitch.

## Zoom out, then zoom in

Quantization acts on the trained Model artifact, between training and deployment. You finish training in high precision, then *compress* the weights (and often activations) to lower precision before you serve. The star sits on the edge from Model to Deploy.

```
Quantization sits on the Model → Deploy edge
┌──────────┐   ┌──────────┐   ┌──────────────────┐   ┌────────┐         ┌──────────────┐
│  Data    │──▶│ Features │──▶│ Train / Val / Test│──▶│ Model  │── ★ ──▶ │ Deploy/Serve │
└──────────┘   └──────────┘   └──────────────────┘   └────────┘         └──────────────┘
                                                       FP32 weights      smaller, faster
                                                           │             lower precision
                                                           ▼
                                              ★ QUANTIZE: FP32 ─▶ INT8/INT4
                                                shrink size, speed up math
```

Training usually happens in FP32 (or FP16). Quantization is the post-training (or training-aware) step that maps those high-precision numbers down to low-precision ones so the deployed model is cheaper to store and faster to run.

## Structure pass

One axis organizes the entire topic: **numeric precision of the weights/activations.** Slide from FP32 down to INT4 and you trade accuracy for size and speed. Every quantization decision is a point on that single axis.

```
Axis: numeric precision (bits per value)
 high precision ◀────────────────────────────────────────────▶ low precision
 (big, accurate, slow)                                    (tiny, fast, lossy)

 FP32            FP16             INT8                 INT4
 32-bit float    16-bit float     8-bit integer        4-bit integer
 training        mixed-precision  edge inference       aggressive edge
 baseline        training/serve   (the workhorse)      (LLM weight squeeze)
```

The seam between FP16 and INT8 is the important one: above it you are in float land (training, mild speedup); at and below it you are in integer land (real size/speed wins, real accuracy risk). That seam is where "compression for deployment" actually begins.

## How it works

### Move 1 — mental model

Mental model: **quantization is lossy rounding of numbers, applied deliberately.** You take a continuous range of float values and snap them onto a small grid of integers. Fewer bits means a coarser grid means more rounding error — but also less storage and faster integer math. You are buying size and speed with accuracy.

```
PATTERN: mapping a float range onto an integer grid
 FP32 values (fine, continuous)
 │··············································│   range [min, max]
 ▼  snap each value to nearest grid point
 INT8 grid (256 levels)
 ●────●────●────●────●────●────●────●────●────●
 │    │    │    │    rounding error = distance to nearest ●
 INT4 grid (16 levels) — coarser, more error, smaller
 ●─────────●─────────●─────────●─────────●
```

Coarser grid, more error, smaller footprint. The whole craft is choosing a grid coarse enough to save real resources but fine enough that accuracy survives.

### Move 2 — step by step

**The precision ladder, as a tradeoff table.** This is the table to memorize. Read it as: more bits = bigger and more accurate; fewer bits = smaller and faster but lossier.

```
Precision tradeoff table (relative to FP32 baseline)
┌────────┬───────────┬──────────────┬──────────────────────┬───────────────────────────┐
│ format │ bits/value │ size vs FP32 │ typical accuracy hit  │ where it's used           │
├────────┼───────────┼──────────────┼──────────────────────┼───────────────────────────┤
│ FP32   │ 32        │ 1.0×  (base) │ none (the reference)  │ training baseline          │
│ FP16   │ 16        │ ~0.5×        │ negligible            │ mixed-precision training;  │
│        │           │              │                       │ GPU serving                │
│ INT8   │ 8         │ ~0.25×       │ small, usually < ~1%  │ edge inference workhorse;  │
│        │           │              │ with calibration      │ mobile, CPU                │
│ INT4   │ 4         │ ~0.125×      │ noticeable; needs care│ aggressive edge; large-LLM │
│        │           │              │ (QAT or good calib)   │ weight compression         │
└────────┴───────────┴──────────────┴──────────────────────┴───────────────────────────┘
```

The numbers are rules of thumb, not guarantees — always measure on *your* model and *your* data. `Not yet exercised in aptkit`: no model exists here to place on this table, so the harness exercise below is how you would generate these rows for real.

**Two ways to get there: PTQ vs QAT.** There are two roads from FP32 to a quantized model, and they differ in *when* the model learns to tolerate the rounding.

```
Post-training quantization (PTQ) vs quantization-aware training (QAT)
┌───────────────────────────────┐        ┌───────────────────────────────────┐
│ PTQ                            │        │ QAT                                 │
│  train FP32 ─▶ DONE            │        │  train WITH fake-quant in the loop  │
│       │ then quantize after    │        │  model learns to be robust to       │
│       ▼                        │        │  rounding DURING training           │
│  calibrate on sample data,     │        │       │                            │
│  pick the int grid             │        │       ▼                            │
│  ┌───────────────────────────┐ │        │  ┌───────────────────────────────┐ │
│  │ + cheap, fast, no retrain │ │        │  │ + best accuracy at low bits   │ │
│  │ − more accuracy loss,     │ │        │  │ − needs full retrain pipeline │ │
│  │   esp. at INT4            │ │        │  │   + data + time               │ │
│  └───────────────────────────┘ │        │  └───────────────────────────────┘ │
└───────────────────────────────┘        └───────────────────────────────────┘
```

PTQ is what you reach for first: it is cheap and needs no retraining, just a calibration pass over sample data to choose the grid. QAT is what you escalate to when PTQ's accuracy loss is unacceptable — usually at INT4 — because the model trained *with* fake-quantization in the loop learns weights that survive the rounding. Rule of thumb: try PTQ, and only pay for QAT if INT8 PTQ already hurts or you need INT4.

**Calibration is the quiet make-or-break.** PTQ needs a small representative dataset to find the float range to map onto the integer grid. Pick a bad range (clip too aggressively, or include outliers that stretch the grid) and accuracy craters even at INT8.

```
calibration: choose the [min,max] the int grid covers
 outliers stretch grid ─▶ wasted resolution ─▶ accuracy ↓
 clip too tight        ─▶ clipped values    ─▶ accuracy ↓
 representative sample  ─▶ tight, well-placed grid ─▶ accuracy holds
```

`Not yet exercised in aptkit`.

### Move 3 — principle

Principle: **quantize as aggressively as the accuracy budget allows, and prove the tradeoff with measurement, not faith.** The table's "typical" numbers are starting hypotheses. The only honest precision choice is one where you measured size, latency, *and* accuracy on your model at each candidate precision and picked the smallest one that stayed inside your accuracy budget.

## Primary diagram

```
Quantization workflow + the bridge to on-device
   FP32 trained model
          │
          ▼
   pick target precision (INT8 first; INT4 if you must)
          │
   ┌──────┴───────────────┐
   ▼                       ▼
  PTQ                     QAT
  calibrate on            retrain with
  sample data             fake-quant
   │                       │
   └──────────┬────────────┘
              ▼
   ┌──────────────────────────────────────┐
   │ BENCHMARK the three axes together:    │
   │  size   ── did it shrink enough?      │
   │  latency── did it speed up enough?    │
   │  accuracy─ still inside budget?       │
   └──────────────────┬────────────────────┘
                      │ smallest precision that passes all three
                      ▼
   ┌──────────────────────────────────────┐
   │ now it FITS the device budget (see 12)│
   │  this is HOW you get a model onto a   │
   │  phone in the first place             │
   └──────────────────────────────────────┘
```

The load-bearing box is the benchmark: you do not choose a precision, you *measure your way* to one across all three axes at once. The bottom box is the bridge — quantization is the concrete answer to on-device's "but does it fit?" question.

## Elaborate

A few edges. First, **size and latency do not improve in lockstep** — INT8 reliably quarters storage, but the speedup depends on whether the hardware has fast integer kernels; on hardware without them you can shrink the model and gain little speed. Measure latency separately, never infer it from size. Second, **not every layer should be quantized equally** — sensitive layers (often the first and last) are sometimes kept at higher precision (mixed-precision quantization) because quantizing them tanks accuracy for little size win. Third, **INT4 is mostly an LLM-weights story** — it is how large language models get squeezed onto consumer hardware, and it almost always needs careful calibration or QAT; do not casually drop a small classifier to INT4 and expect INT8-grade accuracy.

Cross-reference: this is the direct sequel to `12-on-device-inference.md`. That file ends on "but does the model fit the device budget?" — quantization is the primary lever that makes the answer yes.

## Project exercises

### Quantize-and-benchmark harness

- **Exercise ID:** EX-ML-13a — Phase 3 ML evals, because the deliverable is an eval-shaped harness that measures a tradeoff, which is exactly where measurement discipline belongs.
- **What to build:** A harness that takes a small reference model and a held-out eval set, produces FP32 / FP16 / INT8 (PTQ) variants, and emits a table of (size, latency, accuracy) per precision — the real version of the tradeoff table in this file. Add an INT4 row if the tooling supports it for your model.
- **Why it earns its place:** It converts the memorized "typical" numbers into *measured* numbers for a real model, and forces the discipline of benchmarking all three axes together rather than assuming size implies speed. That is the principle of the whole file, made executable.
- **Files to touch:** `/Users/rein/Public/buffr/tools/quantize-benchmark/run.ts` (Case B (new)); `/Users/rein/Public/buffr/tools/quantize-benchmark/report.ts` (Case B (new)) to render the size/latency/accuracy table; a fixtures dir at `/Users/rein/Public/buffr/tools/quantize-benchmark/fixtures/` (Case B (new)).
- **Done when:** Running the harness prints a precision table with measured size, latency, and accuracy for at least FP32/FP16/INT8, and the report flags which precisions stay inside a stated accuracy budget so the smallest passing one is obvious.
- **Estimated effort:** 1–2 days

### PTQ-vs-QAT comparison on the same model

- **Exercise ID:** EX-ML-13b — also Phase 3 ML evals, building directly on 13a's harness once INT8/INT4 numbers exist.
- **What to build:** Extend the harness to produce both a PTQ INT8 variant and a QAT INT8 (or INT4) variant of the same model and compare their accuracy at equal size, so the PTQ→QAT escalation rule becomes a measured result rather than a claim.
- **Why it earns its place:** It makes the PTQ-vs-QAT decision concrete: you see exactly how much accuracy QAT buys back at a given precision, which is the only honest basis for paying QAT's retraining cost.
- **Files to touch:** Extend `/Users/rein/Public/buffr/tools/quantize-benchmark/run.ts` (Case B (new)); add `/Users/rein/Public/buffr/tools/quantize-benchmark/qat.ts` (Case B (new)) for the training-aware path.
- **Done when:** The report shows PTQ vs QAT accuracy at the same precision/size, and you can state from the numbers whether QAT's retraining cost was worth it for this model.
- **Estimated effort:** ≥1 week

## Interview defense

**Q: What does quantization actually trade, and how do you choose a precision?**

It trades accuracy for size and speed by rounding weights/activations onto a coarser integer grid. You don't choose by reputation — you benchmark size, latency, and accuracy at each candidate precision and take the smallest one that stays inside the accuracy budget.

```
FP32 ──▶ INT8 ──▶ INT4
big/accurate    tiny/lossy
measure all 3 axes, pick smallest passing
```

Anchor: a phone pose model lives or dies on size and ms — quantization buys both.

**Q: PTQ or QAT — when do you reach for which?**

PTQ first: cheap, no retraining, just calibrate on sample data. Escalate to QAT only when PTQ's accuracy loss is unacceptable — typically at INT4 — because training with fake-quant in the loop teaches the model to survive rounding.

```
INT8 PTQ ok? ─▶ ship it
INT8 PTQ hurts / need INT4? ─▶ pay for QAT
```

Anchor: you don't pay QAT's retrain bill until the numbers say PTQ failed.

**Q: INT8 quartered the model — why didn't it run 4× faster?**

Size and latency aren't locked together. INT8 reliably quarters storage, but the speedup needs hardware with fast integer kernels. Without them you shrink the model and gain little speed — which is why you measure latency separately, never infer it from size.

```
size ↓ 4×  ≠  latency ↓ 4×   (depends on int kernels)
```

Anchor: the benchmark harness measures latency as its own axis for exactly this reason.

## See also

- [12-on-device-inference.md](./12-on-device-inference.md) — the "does it fit the device?" question this answers
- [11-cold-start.md](./11-cold-start.md) — the upstream personalization context for any deployed model
