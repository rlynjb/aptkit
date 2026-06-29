# Transfer Learning

> transfer learning · training strategy

Here's the blunt version up front: aptkit trains no model. There is no supervised pipeline, no backbone, no fine-tuning loop anywhere in `packages/`. Everything below is new ground — study material plus exercises you could build, not a tour of shipped code. I'll say `not yet exercised in aptkit` at the moves where it matters so you never confuse the map for the territory.

You actually *have* touched this idea once, even if you didn't name it. In contrl, you never trained a pose detector. You took MediaPipe's pose-landmark model — pretrained on a mountain of human-pose images you'll never see — and built a rep counter on top of its outputs. That's transfer learning at the coarsest grain: someone else paid for the backbone, you spent your budget on the task. This file is about the finer-grained version, where you don't just *consume* the backbone, you crack it open and retrain part of it.

## Zoom out, then zoom in

Transfer learning lives at the Train step of the pipeline, but it reaches back into Model initialization. The trick is that your model doesn't start from random weights — it starts from weights borrowed from a different, bigger job.

```
Generic supervised-ML pipeline · where transfer learning sits
┌────────┐   ┌──────────┐   ┌──────────────────┐   ┌─────────────┐   ┌────────┐
│  Data  │──▶│ Features │──▶│ Train / Val / Test│──▶│    Model    │──▶│ Deploy │
└────────┘   └──────────┘   └─────────┬────────┘   └─────────────┘   └────────┘
                                      │
                            ┌─────────▼──────────┐
                            │ ★ TRANSFER LEARNING │
                            │  init from a        │
                            │  PRETRAINED backbone│
                            │  (not random)       │
                            └────────────────────┘
   borrowed ───────────────────────────────────────────▶ kept frozen or lightly tuned
   yours ──────────────────────────────────────────────▶ trained on YOUR small dataset
```

The arrow into Train is the whole point: instead of starting Model from random noise and burning a huge labeled dataset to discover edges, textures, and shapes from scratch, you start from a model that already learned those things on millions of examples. Your small dataset only has to teach the *last mile* — the part specific to your task. That's why a 500-image dataset can produce a usable classifier when training from scratch on 500 images would produce garbage.

## Structure pass

Lay a deep network out along one axis — input on the left, prediction on the right — and the seams that matter for transfer become obvious.

```
A pretrained network, split for transfer · input → output
INPUT                                                          OUTPUT
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
│ early    │  │ mid      │  │ mid      │  │ late     │  │ HEAD         │
│ layers   │─▶│ layers   │─▶│ layers   │─▶│ layers   │─▶│ (classifier) │
│          │  │          │  │          │  │          │  │              │
│ edges,   │  │ textures,│  │ parts,   │  │ task-ish │  │ YOUR classes │
│ colors   │  │ corners  │  │ motifs   │  │ features │  │              │
└────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘
     │             │             │             │               │
   GENERAL ◀───────┴─────────────┴─────────────┴────────────▶ SPECIFIC
   (reuse, freeze)                              (retrain, replace)
```

Two seams. The first seam is the **freeze line** — everything to its left you keep fixed because it learned general visual priors that transfer cleanly. The second seam is the **head** — the final layer(s) that map features to class labels; this almost always gets thrown away and replaced, because the pretrained model's classes are not your classes. The art of transfer learning is deciding where to draw the freeze line: too far left and you waste your data re-learning textures; too far right and you have so few trainable parameters you can't fit your task.

## How it works

### Move 1 — the mental model

The mental model: **a pretrained backbone is a feature factory you rent, and the head is the part you own.** You don't rebuild the factory; you re-point its output at your product line.

```
Pattern · rent the factory, own the output
        ┌─────────────────────────────┐
input ─▶│   FROZEN BACKBONE (rented)   │─▶ features ─▶ ┌──────────────┐
        │   weights from big dataset   │              │ NEW HEAD     │─▶ your label
        │   gradients DO NOT flow here │              │ (you own it) │
        └─────────────────────────────┘              │ gradients ✔  │
                                                      └──────────────┘
              ▲                                              ▲
        no training cost                            cheap to train,
        (just forward pass)                         small dataset OK
```

Read it left to right: the input goes through the frozen backbone, which produces a feature vector. That vector is the *only* thing your new head ever sees. Because gradients don't flow into the backbone, training is fast and your tiny dataset only has to fit the head's parameters — orders of magnitude fewer than the full network.

### Move 2 — the steps

**Step A — replace the head.** The pretrained model ends in a classifier sized for *its* task (say 1000 ImageNet classes). You chop it off and bolt on a fresh head sized for *your* task (say 3 classes).

```
Head swap · before and after
BEFORE                              AFTER
backbone ─▶ [1000-way head]   ───▶  backbone ─▶ [3-way head]  (new, random init)
            (ImageNet)                          (your classes)
```

```python
# not yet exercised in aptkit — no model, no backbone exists in packages/
backbone = load_pretrained("mobilenet_v3", weights="imagenet")
backbone.classifier = NewHead(in_features=backbone.feat_dim, num_classes=3)
```

**Step B — freeze the backbone.** Mark backbone parameters as non-trainable so the optimizer ignores them. Only the head learns.

```
Freeze · which parameters the optimizer updates
backbone params ── requires_grad = False ──▶ skipped by optimizer ✘
head params    ── requires_grad = True  ──▶ updated each step    ✔
```

```python
# not yet exercised in aptkit
for p in backbone.parameters():
    p.requires_grad = False        # freeze
optimizer = SGD(head.parameters(), lr=1e-3)   # only the head
```

**Step C — fine-tune (optional, later).** Once the head has stabilized, you *may* unfreeze the late backbone layers and train the whole thing at a much smaller learning rate. This adapts the task-ish late features to your domain without destroying the general early ones.

```
Two-phase schedule · feature-extract then fine-tune
phase 1: [FROZEN backbone] + [train head]        lr = 1e-3
                 │
                 ▼  unfreeze late layers
phase 2: [froz][froz][TUNE][TUNE] + [train head] lr = 1e-5  (10–100× smaller)
```

```python
# not yet exercised in aptkit
for p in backbone.late_layers.parameters():
    p.requires_grad = True
optimizer = SGD([
    {"params": backbone.late_layers.parameters(), "lr": 1e-5},
    {"params": head.parameters(),                 "lr": 1e-3},
])
```

### Move 3 — the principle

The principle: **spend your scarce resource — labeled data — only on what is unique to your problem.** General features are a commodity; someone already paid for them at scale. Transfer learning is the discipline of not re-buying the commodity.

## Primary diagram

```
Transfer learning · end to end
                 BIG GENERIC DATASET (someone else's)
                        │  (expensive, once)
                        ▼
                 ┌──────────────┐
                 │  PRETRAINED  │
                 │   BACKBONE   │  ◀── you download this
                 └──────┬───────┘
                        │  freeze line
        ┌───────────────┼───────────────┐
        ▼ FROZEN                         ▼ REPLACED
 ┌──────────────┐                 ┌──────────────┐
 │ early + mid  │                 │   NEW HEAD   │
 │ layers       │── features ────▶│ (your task)  │
 │ (general)    │                 │              │
 └──────────────┘                 └──────┬───────┘
        ▲                                 │
        │                                 ▼
 your SMALL dataset ──── trains only ──▶ head (+ optional late layers)
```

Top half is the world's work; bottom half is yours. The freeze line is the negotiated boundary between them. Move it left as your dataset grows; move it right when data is precious.

## Elaborate

- **Domain gap decides the freeze line.** If your images look like the pretraining set (natural photos), freeze aggressively — the features transfer. If your domain is alien (medical scans, spectrograms, pose-landmark vectors), the late features don't transfer and you'll need to unfreeze more. Your contrl case is interesting here: MediaPipe outputs *landmarks*, not pixels, so any model you build downstream is already in a very different feature space than ImageNet — pixel backbones wouldn't help you at all; you'd want a backbone pretrained on pose sequences.
- **Catastrophic forgetting.** Fine-tune with too high a learning rate and the backbone's general knowledge gets overwritten by your tiny dataset before the head ever stabilizes. The small-lr, head-first schedule in Step C exists precisely to prevent this.
- **Feature extraction vs fine-tuning are different commitments.** Pure feature extraction (frozen backbone forever) is cheap, fast, and can run the backbone *once* per image to cache features. Fine-tuning is more powerful but needs full backprop and risks forgetting. Start with extraction; only fine-tune if metrics plateau.
- **The head can be anything.** It doesn't have to be a neural layer. Run the frozen backbone, cache the feature vectors, and train a plain logistic regression or gradient-boosted tree on those features. Often that's enough and it's trivially debuggable.
- **Pretraining isn't free of bias.** The backbone inherits whatever was over/under-represented in the big dataset. Those blind spots transfer too.

## Project exercises

### EX-ML-07a — Layer-freezing config + fine-tune skeleton

- **Exercise ID:** EX-ML-07a (lands in the Phase 3 ML-evals track — the first place aptkit would grow a trainable artifact rather than only calling hosted models).
- **What to build:** A standalone fine-tuning script skeleton that loads a pretrained backbone, swaps the head for an N-class head, reads a declarative freeze config (which layer groups are frozen vs trainable, per phase), and runs a two-phase schedule (feature-extract, then optional fine-tune). No real training data required — wire it against a toy/synthetic tensor so the plumbing is exercised end to end.
- **Why it earns its place:** It forces you to make the freeze line *explicit and configurable* instead of a magic constant, and it's the minimum viable shape of every transfer-learning job you'll ever defend in an interview.
- **Files to touch:** Case B (new) — `packages/ml-evals/src/transfer/freeze-config.ts` (the declarative config + validation), `packages/ml-evals/src/transfer/finetune.py` (the script skeleton; Python because the ecosystem is there), `packages/ml-evals/src/transfer/finetune.test.ts` (asserts the config parses and the right param groups are marked trainable).
- **Done when:** A freeze config like `{ phase1: { freeze: ["backbone.*"], train: ["head"] }, phase2: { train: ["backbone.late", "head"] } }` round-trips through validation, and the skeleton, run against a synthetic input, reports the count of trainable vs frozen parameters per phase matching the config.
- **Estimated effort:** 1–2 days

## Interview defense

**Q: Why not just train from scratch if you have any data at all?**

```
from scratch:   500 imgs ─▶ learn edges+textures+task ─▶ overfit ✘
transfer:       500 imgs ─▶ learn task only ───────────▶ generalizes ✔
                (edges+textures already learned, free)
```

Because the early layers need *millions* of examples to learn general features reliably; 500 images can't, so a from-scratch model memorizes noise. Anchor: in contrl I never trained landmark detection — MediaPipe's pretrained pose model supplied that for free, and I only built the rep-counting logic on top.

**Q: How do you decide where to draw the freeze line?**

```
domain close  ──▶ freeze a lot   (features transfer)
domain far    ──▶ freeze little  (features don't transfer)
data scarce   ──▶ freeze more    (fewer params to fit)
data plenty   ──▶ freeze less    (afford to adapt)
```

Two dials: how similar your domain is to the pretraining domain, and how much labeled data you have. Close domain + scarce data → freeze hard. Far domain + plenty of data → unfreeze and fine-tune. Anchor: a pose-landmark task like contrl is far from ImageNet's pixel domain, so a pixel backbone wouldn't transfer — you'd need a pose-pretrained one.

## See also

- [Confusion matrices](./08-confusion-matrices.md)
- [Calibration](./09-calibration.md)
- [Recommender systems](./10-recommender-systems.md)
- [Cold start](./11-cold-start.md)
