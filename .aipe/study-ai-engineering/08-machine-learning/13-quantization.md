# Quantization

**Subtitle:** shrink a model by storing weights at lower numeric precision · *Language-agnostic*

## Zoom out, then zoom in

Quantization is not a stage you add to the pipeline — it is a *transform* you
apply to the fitted model on its way from training to deployment. Same generic
supervised arc as file 01; the starred box is where quantization lives, between
"I have a trained `f`" and "this `f` runs on the target device."

```
  Zoom out — where quantization sits in the supervised arc (generic)

  ┌─ Data layer ───────────────────────────────────────────────────┐
  │  labeled rows  (files 01–02)                                    │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ split (file 03)
  ┌─ Model layer ─────────────▼─────────────────────────────────────┐
  │  fitted model f: X → ŷ   weights stored as FP32                 │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ quantize (THIS FILE)
  ┌─ Compress layer ──────────▼─────────────────────────────────────┐
  │  same f, weights re-stored at FP16 / INT8 / INT4 — smaller      │
  └───────────────────────────┬─────────────────────────────────────┘
                              │ ship to device under a size budget
  ┌─ Serving layer ───────────▼─────────────────────────────────────┐
  │  ★ on-device inference ★  fits RAM/disk budget (file 12)        │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. The model's *function* does not change when you quantize — `f` still
maps `X → ŷ`. What changes is how many bits each weight costs to store and to
multiply. A weight that was a 32-bit float becomes an 8-bit integer plus a tiny
recipe for turning it back into an approximate float. You trade numeric precision
for size and speed, and you pay for it in a measurable drop in output quality.
The job is to find the cheapest precision whose quality drop you can still accept.

## Structure pass

**Layers.** Trained weights (FP32) → a precision-conversion step → the same
network running on smaller integers. The network topology, the feature code, and
the inference math are unchanged; only the *number format* of the parameters
moves.

**Axis — bits-per-weight vs quality.** This is the only dial. Slide it from 32
bits toward 4 bits: size and memory bandwidth fall roughly linearly, integer
hardware gets faster, and output quality degrades — slowly at first (FP16 is
nearly free), then sharply (INT4 is visible). Every quantization decision is a
point chosen on this one axis.

**Seam.** The load-bearing boundary is the **scale + zero-point mapping** — the
pair of numbers that converts a float to an int and back. Above it, the model
thinks in floats. Below it, storage and integer matmul happen in ints. Get the
mapping wrong (bad scale, clipped outliers) and quality collapses; get it right
and INT8 is nearly lossless. The whole art of quantization lives in this seam.

## How it works

### Move 1 — the mental model

You already do this with images. A PNG stores each pixel channel in 8 bits; a
RAW photo stores 12–14. The RAW is "truer," but for a thumbnail nobody can tell,
and the PNG is a quarter the size. Quantization is that, applied to model
weights: store each number in fewer bits, accept that it is now an *approximation*
of the original, and win on size. The catch — which images share — is that
compression artifacts get worse the harder you push, and at some point a human
(or, here, your eval) notices.

```
  Pattern — fewer bits per number, same meaning, more error

  FP32 weight:  0.7421875…  (32 bits, ~7 decimal digits of precision)
                   │  quantize: pick a scale, round to nearest grid point
                   ▼
  INT8 weight:  95          (8 bits) + scale 0.0078  ⇒ ≈ 0.7410
                   │  the gap (0.7422 − 0.7410) is QUANTIZATION ERROR
                   ▼
  smaller storage · faster integer matmul · slightly wrong answer
```

You are not changing what the weight *means*. You are storing it on a coarser
grid and accepting the rounding error that introduces.

### Move 2 — the precision ladder, one rung at a time

**FP32 — the baseline (4 bytes/param).** Full single-precision float. This is
what training produces and what every quality number is measured *against*. A
model with 50M params costs `50M × 4 bytes ≈ 200MB` just for weights. Treat FP32
as the reference, not a deployment target — you rarely ship it to a device.

```
  FP32: 50M params × 4 bytes = 200 MB   quality: 1.00× (reference)
```

**FP16 / BF16 — half precision (2 bytes/param).** Drop to 16 bits. Size halves;
quality loss is near zero because 16 bits still covers the range training cared
about. FP16 has more mantissa (precision) in a narrow range; BF16 keeps FP32's
*exponent* range (fewer overflow surprises) with less mantissa. This is the
default for serving large models — almost free, so almost always taken first.

```
  FP16/BF16: 50M × 2 bytes = 100 MB   quality: ≈1.00× (near-lossless)
```

**INT8 — 8-bit integer (1 byte/param).** Now you leave floats entirely: each
weight is an integer in `[-128, 127]`, plus a per-tensor (or per-channel)
**scale** and **zero-point** that map ints back to approximate floats. Size is
~1/4 of FP32; integer matmul is much faster on hardware that has integer units
(most CPUs, mobile NPUs). Quality loss is small *if the mapping is good*. The
mapping is the seam:

```
  INT8 scale + zero-point mapping (annotated pseudocode — NOT aptkit code)

  # PER-TENSOR calibration: find the float range this tensor actually uses
  w_min, w_max = min(weights), max(weights)        # observed float range

  # the 8-bit grid has 256 points; spread the range across them
  scale      = (w_max - w_min) / 255               # float gap per int step
  zero_point = round(-w_min / scale)               # which int maps to 0.0

  # quantize: float -> int8   (store this)
  q = round(w / scale) + zero_point
  q = clamp(q, -128, 127)                           # outliers get clipped

  # dequantize: int8 -> approx float   (at matmul time)
  w_hat = scale * (q - zero_point)                  # ≈ w, not == w
```

The two numbers that matter: `scale` is the size of one integer step in float
units; `zero_point` is the integer that represents true 0.0 (so that exact zeros
stay exact). Pick the range from extreme outliers and every normal weight gets a
coarse grid — that is the #1 INT8 quality bug.

**INT4 — 4-bit integer (0.5 bytes/param).** Same idea, only 16 grid points
(`[-8, 7]`). Size is ~1/8 of FP32 — the rung that lets a multi-billion-param LLM
fit in a laptop's RAM. Quality loss is now *noticeable*: 16 levels cannot
represent a weight distribution finely, so practitioners use tricks (group-wise
scales, keeping a few sensitive layers at higher precision) to claw quality back.

```
  INT4 group-wise mapping (annotated pseudocode — NOT aptkit code)

  # one scale per SMALL GROUP of weights (e.g. 64), not per whole tensor —
  # finer mapping limits the damage of only 16 grid points
  for group in chunks(weights, size=64):
      scale = max(abs(group)) / 7          # symmetric: zero_point = 0
      q     = clamp(round(group / scale), -8, 7)   # 4 bits each
  # store: q (4-bit) + one scale per 64 weights
```

**PTQ vs QAT — when you pay the quality bill.** Two ways to quantize:

```
  ┌─ Post-Training Quantization (PTQ) ───────────────────────────────┐
  │  train in FP32 → AFTER training, convert weights to INT8/INT4    │
  │  cheap, no retraining; calibrate scales on a few hundred samples │
  │  good enough for INT8; INT4 quality often suffers                │
  └───────────────────────────────────────────────────────────────────┘
  ┌─ Quantization-Aware Training (QAT) ─────────────────────────────┐
  │  SIMULATE the rounding error DURING training (fake-quant nodes)  │
  │  the model learns weights robust to low precision               │
  │  expensive (full retrain) but recovers most INT4 quality        │
  └───────────────────────────────────────────────────────────────────┘
```

PTQ is the default reach because it needs no labels and no training loop. Escalate
to QAT only when PTQ's measured quality drop blows your budget — usually at INT4.

**Measure, then accept.** Quantization is the lever to hit the on-device size
budget from file 12 (e.g. a 200MB FP32 model → 50MB at INT8 fits the budget). But
size is not the deliverable — *quality within budget* is. The discipline:
quantize, run the held-out eval, and accept the smallest precision whose metric
stays inside tolerance.

```
  The quantize→measure→accept loop (annotated pseudocode — NOT aptkit code)

  baseline = evaluate(model_fp32, held_out)        # the number to beat
  for precision in [FP16, INT8, INT4]:             # smallest size last
      q = quantize(model_fp32, precision)
      score = evaluate(q, held_out)                # SAME metric as baseline
      if baseline - score <= TOLERANCE:            # within budget?
          candidate = q                            # keep going smaller
      else:
          break                                    # too lossy; stop here
  ship(candidate)                                  # smallest acceptable
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.
The honest anchor that makes it concrete: aptkit's default *local* Gemma is itself
already a quantized model — local LLMs ship in quantized formats (INT4/INT8 GGUF
and friends) so they fit consumer hardware. aptkit does not quantize anything
itself, but the model you already run is the output of exactly this transform.

### Move 3 — the principle

Quantization buys size and speed with precision, and the only honest currency for
the trade is a quality metric on held-out data. Slide down the bits-per-weight
axis as far as the metric lets you, and no further. The smallest precision whose
quality stays in budget is the right one — not the smallest you can produce.

## Primary diagram

```
  The precision ladder — pick the lowest rung that passes the eval

  bits/param   format     size of a 50M-param model     quality vs FP32
  ┌────────┐
  │  32    │  FP32        200 MB  ████████████████████   1.00×  (reference)
  ├────────┤
  │  16    │  FP16/BF16   100 MB  ██████████             ≈1.00× (near-free)
  ├────────┤
  │   8    │  INT8         50 MB  █████                  ~0.99× (small drop)
  ├────────┤
  │   4    │  INT4         25 MB  ██▌                    ~0.95× (noticeable)
  └────────┘
       │  size & memory bandwidth fall ~linearly ─────────────►
       │  quality holds, then degrades ───────────────────────►
       ▼
   accept the lowest rung whose MEASURED metric stays within budget
   (numbers illustrative; the real ones come from YOUR held-out eval)
```

## Elaborate

The hard-won lesson is that quantization quality is not predictable from theory —
it is *empirical per model*. Two networks of identical size can tolerate INT4
very differently depending on their weight distributions and how many outlier
activations they carry. That is why the loop in Move 2 measures rather than
assumes, and why production teams keep a small held-out set specifically for the
quantization decision. The second lesson: the mapping seam dominates. Most "INT8
ruined my model" reports are a calibration bug — a few outlier weights stretched
the range so the scale got coarse — not a fundamental limit of 8 bits. Fix the
range (per-channel scales, clip outliers) before you blame the precision. File 12
is the budget this all serves; this file is how you hit it.

## Project exercises

### Measure precision@k drop across a simulated precision ladder

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a script that takes the existing vector-retrieval scores from
  buffr, simulates "quantizing" the stored embeddings at FP32 / INT8 / INT4 (round
  each dimension to a coarser grid via a scale), re-ranks, and scores each rung
  with `scorePrecisionAtK` against the known relevant ids — printing the metric
  drop per precision.
- **Why it earns its place:** turns the abstract size/quality tradeoff into the
  exact measured-quality-delta loop from Move 2, using the same eval metric the
  real pipeline uses. You feel quality fall as bits fall.
- **Files to touch:** new `/Users/rein/Public/buffr/eval/quantize-ladder.ts`,
  importing `scorePrecisionAtK` from
  `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts` and reading
  `/Users/rein/Public/buffr/src/pg-vector-store.ts`.
- **Done when:** the script prints a table of `precision → precision@k`, showing
  FP32 as the baseline and a monotone-or-near-monotone drop toward INT4.
- **Estimated effort:** `1–4hr`

### Write the scale + zero-point quantizer and round-trip test

- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a small, dependency-free `quantizeInt8(floats) → {ints,
  scale, zeroPoint}` plus `dequantize(...) → floats`, with a unit test asserting
  the round-trip error stays below a tolerance and that exact zeros survive.
- **Why it earns its place:** the scale+zero-point mapping is the seam of the
  whole topic; implementing it once kills the mystery and exposes the outlier bug
  firsthand.
- **Files to touch:** new `/Users/rein/Public/buffr/src/quantize.ts` and
  `/Users/rein/Public/buffr/eval/quantize.test.ts`.
- **Done when:** `node --test` passes with bounded round-trip error and a case
  proving an outlier-stretched range degrades a normal weight's accuracy.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "Walk me from FP32 to INT4 — what am I trading?"**
Bits per weight for size and speed, paid in output quality. FP32 is the 4-byte
baseline. FP16/BF16 halves size for near-zero loss — almost always free. INT8
quarters it via a scale + zero-point that map ints↔floats, with a small loss on
integer hardware. INT4 is ~1/8 the size, the rung that fits LLMs on laptops, but
with noticeable loss you fight back with group-wise scales or QAT.

```
  FP32 ─► FP16 ─► INT8 ─► INT4
   4B      2B      1B     0.5B   bytes/param
  1.00×   ≈1.0×  ~0.99×  ~0.95×  quality   (slide down till the eval says stop)
```
*Anchor: one axis — bits-per-weight vs quality; pick the lowest passing rung.*

**Q: "How do you decide which precision to ship?"**
You don't decide by size; you decide by measured quality. Quantize at each rung,
run the *same* held-out eval you scored FP32 with — precision@k on a reranker,
macro-F1 on a classifier — and accept the smallest precision whose metric stays
within tolerance. Size buys you into the device budget (file 12); the eval is
what makes the trade honest.

```
  quantize ─► evaluate(held_out, SAME metric) ─► within budget? ─► keep & go smaller
                                                  └─ no ─► stop, ship previous rung
```
*Anchor: the quality delta is measured with `scorePrecisionAtK`
(`packages/evals/src/precision-at-k.ts`), not assumed.*

## See also

- `12-on-device-inference.md` — the size/RAM budget quantization exists to hit
- `04-model-selection.md` — pick the simplest model that wins, then shrink it
- `09-calibration.md` — another post-training transform measured on held-out data
- `01-supervised-pipeline.md` — where the FP32 model the transform consumes is built
