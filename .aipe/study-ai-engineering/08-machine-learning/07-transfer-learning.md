# Borrowing a model's learned eyes (transfer learning)

**Industry names:** transfer learning, feature extraction, fine-tuning, backbone reuse · *Industry standard*

## Zoom out, then zoom in

Nobody with sense trains an image model from scratch anymore. You take a model
that already learned to see — edges, textures, shapes, faces, hands — from
millions of images, and you graft *your* small task onto the front of what it
already knows. That reuse of learned representations is transfer learning, and
it's why a hobbyist with a few hundred labeled images can get results that used
to need a research lab. Here's the shape.

```
  Zoom out — reuse the bottom, replace the top

  ┌─ pretrained model (trained on a HUGE generic dataset) ──────┐
  │  ┌───────────────┐                                          │
  │  │   BACKBONE    │  learned low/mid features (edges→shapes)  │
  │  │  (many layers)│  ★ THESE TRANSFER ←── THIS CONCEPT        │
  │  └───────┬───────┘                                          │
  │  ┌───────▼───────┐                                          │
  │  │     HEAD      │  task-specific (its 1000 ImageNet classes)│
  │  └───────────────┘  ✂ cut this off                          │
  └──────────────────────────────────────────────────────────────┘
                              │ graft on
                              ▼
                      ┌───────────────┐
                      │  YOUR HEAD    │  your 3 classes, trained on your data
                      └───────────────┘
```

Zoom in: a deep network learns in layers of abstraction — the bottom layers learn
generic visual primitives (edges, gradients), the top layers learn the *specific*
task (these exact 1000 classes). The generic bottom transfers to almost any
vision task; only the specific top needs replacing. The pattern is **reuse the
backbone, replace the head** — and then choose how much of the backbone you let
move.

## Structure pass

**Layers.** A network is a stack: a *backbone* (the deep feature extractor) and a
*head* (the final task-specific layers). Transfer learning is the discipline of
which layers you reuse, which you replace, and which you allow to keep learning.

**Axis — trace one layer's freedom.** Walk from bottom to top and ask of each
layer: *frozen or trainable?* That single axis defines the whole spectrum:

```
   feature extraction:  backbone FROZEN ───────────── head trainable
   light fine-tuning:   backbone mostly frozen ─ top few layers trainable ─ head trainable
   full fine-tuning:    everything trainable (rare; needs lots of data)
```

**Seams.** The load-bearing seam is the freeze line — the boundary between "these
weights stay exactly as pretrained" and "these weights update on my data." Put
the freeze line too low (everything trainable) on a tiny dataset and you overwrite
the very knowledge you came to borrow; put it too high and the model can't adapt
to your domain at all.

## How it works

You already know this from software: you don't write a JSON parser from scratch,
you import a battle-tested library and write the thin layer that's specific to
your app. The library is the backbone — generic, reusable, debugged by millions
of inputs. Your code is the head — small, specific, the only part that's actually
about *your* problem. Transfer learning is `import` for learned representations.

### Move 1 — the mental model

The mental model is two dials on the freeze line, and where you set them is
governed by one thing: how much labeled data you have.

```
  PATTERN — feature extraction vs fine-tuning

  FEATURE EXTRACTION                FINE-TUNING
  ┌───────────────┐                ┌───────────────┐
  │ backbone ❄FROZEN│               │ backbone 🔥top layers unfrozen│
  │   (no gradient) │               │   (small learning rate)       │
  └───────┬─────────┘               └───────┬─────────────────────┘
  ┌───────▼───────┐                ┌───────▼───────┐
  │ new head 🔥train│               │ new head 🔥train│
  └───────────────┘                └───────────────┘
  little data, fast              more data, slower, better fit
```

Feature extraction freezes the whole backbone and trains only the new head — the
backbone is a fixed function turning your images into feature vectors. Fine-tuning
unfreezes some top backbone layers too, letting them nudge toward your domain at a
small learning rate. Less data → freeze more. More data → unfreeze more.

### Move 2 — the load-bearing skeleton

Two moving parts: *why the bottom transfers*, then *how you graft and train*.

**Why low-level features transfer.** The bottom layers of any vision model learn
edge and texture detectors — and an edge is an edge whether it's on an ImageNet
dog or your factory part. That genericity is what's portable.

```
  Feature hierarchy — generic at the bottom, specific at the top

   layer 1  ▏  edges, gradients          ← universal, transfers to ANY image task
   layer 2  ▏  corners, textures         ← still very general
   layer 3  ▏  motifs, simple parts      ← somewhat task-leaning
   layer N  ▏  "is this a Golden Retriever" ← specific to the ORIGINAL task; cut it
```

```
  pseudocode — the transfer, in five lines
  backbone, head = load_pretrained("imagenet-resnet")
  drop(head)                              # the original 1000-class head is useless to you
  new_head = Dense(units = your_num_classes)
  model = backbone + new_head
  # now decide the freeze line (next part)
```

**How you graft and train.** Replace the head with one shaped for your classes,
set the freeze line, train. The freeze line is the decision, not the grafting.

```
  Grafting + the freeze decision

   data size?
      small ──► freeze ALL backbone; train head only  (feature extraction)
      medium ─► freeze low layers; unfreeze top few + head  (light fine-tune)
      large ──► train everything at a small LR  (full fine-tune)
                                  │
                                  ▼ KEY: low learning rate on unfrozen backbone
                          so you NUDGE pretrained weights, not OVERWRITE them
```

```
  pseudocode — set the freeze line and train
  for layer in backbone.layers[:freeze_up_to]:
      layer.trainable = False             # ❄ keep the borrowed knowledge
  for layer in backbone.layers[freeze_up_to:]:
      layer.trainable = True              # 🔥 let the top adapt to your domain
  train(model, your_data, lr = small)     # small LR: nudge, don't clobber
```

The freeze line and the learning rate are a pair: anything you unfreeze, you train
at a *small* learning rate, because a big update would erase the millions-of-images
knowledge you came to reuse. Catastrophic forgetting is the failure mode — too
much freedom, too fast, and the backbone forgets how to see.

### Move 3 — the principle

Reuse the generic, replace the specific, and let the borrowed weights move only as
much as your data can justify. Low-level features are task-agnostic, so you
inherit them for free; the head is task-specific, so you always retrain it. The
freeze line trades adaptation against the risk of forgetting — set it by how much
labeled data you have.

## Primary diagram

The full path: pretrained stack in, head swapped, freeze line set by data size,
trained at a careful learning rate.

```
  Transfer learning — full recap

   pretrained model (trained on millions of generic examples)
        │
        ├─ BACKBONE: edges → textures → parts   ← features TRANSFER
        └─ HEAD: original task's classes        ← ✂ DROP
        │
        ▼
   graft NEW HEAD (your classes)
        │
        ▼
   set the FREEZE LINE by data size:
        small  ─► ❄ freeze all backbone ──┐
        medium ─► ❄ low / 🔥 top few ─────┤
        large  ─► 🔥 train all ───────────┤
                                          ▼
   train at SMALL learning rate on unfrozen layers
   (nudge borrowed weights; don't overwrite → avoid catastrophic forgetting)
        │
        ▼
   your task, with a model that already knew how to see
```

## Implementation in codebase

**Not yet implemented in AptKit — AptKit ships no trained model and fine-tunes
nothing.** There is no backbone to freeze, no head to graft, no learning rate to
keep small. The honest near-instinct is LLM *in-context learning* — you show a
prompt a few examples and the model "adapts" — but that is a *different mechanism*:
no weights change, the model conditions on examples in the context window at
inference time, where transfer learning actually updates (or freezes) parameters.
AptKit does the in-context kind throughout its prompts; it never touches the
weight kind.

## Elaborate

Transfer learning went mainstream with deep ImageNet models (AlexNet onward,
2012+): people noticed that a network trained on ImageNet was a superb generic
feature extractor for almost any vision task. Yosinski et al. (2014),
"How transferable are features in deep neural networks?", is the paper that
mapped exactly how transferability decays from the generic bottom to the specific
top — that's the hierarchy in Move 2.

The cleanest anchor you already own: you did on-device CV pose landmarking with
MediaPipe. MediaPipe ships a *pretrained* hand/pose landmark model — when you
consumed it, you were on the receiving end of transfer learning. You didn't train
those landmark detectors; someone trained a backbone on a huge corpus, and you
ran the frozen result on-device. Recognizing "the model I shipped was transfer
learning I consumed, not produced" is the whole point of this file.

Read-next: `12-on-device-inference.md` (the MediaPipe-shaped deployment of a
transferred model), `04-model-selection.md` (when reuse beats training fresh),
`06-domain-gap.md` (fine-tuning on target data is one cure for a domain gap).
The LLM cousin — in-context learning vs fine-tuning vs LoRA — lives in the
LLM-foundations and context sections, not here.

## Project exercises

*Provenance: Phase 2C — Machine learning (C2C.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case B — new ground; AptKit fine-tunes
nothing and is not the home for a training loop, so this is a thought experiment
with one optional out-of-repo build.*

### Exercise — articulate the transfer you already shipped

- **Exercise ID:** `[C2C.7]` Phase 2C, transfer-learning concept
- **What to build:** Write a one-page teardown of the MediaPipe landmark model you
  ran on-device: which part was the frozen pretrained backbone you consumed, what
  the head produced, and what would change if you fine-tuned it on a small custom
  pose set (which layers you'd freeze, what learning rate, what data you'd need to
  avoid catastrophic forgetting). Optionally, in a *separate* repo, actually
  fine-tune a small pretrained image classifier on a tiny dataset and record
  before/after accuracy — but be clear that a training pipeline does not belong in
  AptKit.
- **Why it earns its place:** Being able to say precisely where the freeze line
  goes and why — and to distinguish weight-level transfer from LLM in-context
  learning — is rare and is exactly what an interviewer probes when they ask "have
  you ever fine-tuned anything?"
- **Files to touch:** None in AptKit — AptKit is not the natural home for a
  fine-tuning loop. The optional build is a new standalone repo/notebook; the
  required deliverable is a written teardown.
- **Done when:** The teardown names the backbone/head split, the freeze line, and
  the learning-rate reason; if you did the optional build, before/after numbers
  are recorded.
- **Estimated effort:** `2–6hr` (teardown), `+ a day` if you do the optional fine-tune

## Interview defense

**Q: What's the difference between feature extraction and fine-tuning?**

```
   feature extraction:  backbone ❄FROZEN ── train head only   (little data)
   fine-tuning:         backbone 🔥top unfrozen ── small LR     (more data)
```

"Both reuse a pretrained backbone and replace the head. Feature extraction freezes
the entire backbone — it's a fixed feature function and I only train the new head.
Fine-tuning unfreezes some top backbone layers and trains them too, at a small
learning rate so I nudge the borrowed weights instead of overwriting them. I pick
based on data size: little data, freeze everything; more data, unfreeze more."
*Anchor: same graft, the difference is where the freeze line sits.*

**Q: Why does transfer learning work at all — why don't I have to retrain the
bottom?**

```
   layer 1: edges ────► generic (an edge is an edge in any task)
   layer N: "is it a dog?" ──► specific (cut it)
```

"Because the bottom layers learn generic visual primitives — edges, textures,
gradients — and those are the same whether the original task was dogs or my task
is factory parts. Only the top layers are specific to the original task, so those
are the only ones I have to replace. I inherit the hard-won generic features for
free."
*Anchor: low-level features are task-agnostic; only the head is task-specific.*

## Validate

- **Reconstruct:** From memory, draw the backbone/head split and the three
  freeze-line settings (feature extraction, light fine-tune, full fine-tune)
  against data size.
- **Explain:** Why train unfrozen layers at a *small* learning rate? (A large
  update would overwrite the pretrained weights you came to reuse — catastrophic
  forgetting; a small one nudges them toward your domain while keeping the borrowed
  knowledge.)
- **Apply:** Frame the MediaPipe landmark model you shipped on-device as transfer
  learning *consumed* — name the frozen backbone and the head, and where you would
  cut to fine-tune for a custom pose.
- **Defend:** Why is LLM in-context learning *not* transfer learning even though it
  feels like adaptation? (In-context learning changes no weights — the model
  conditions on examples in the prompt at inference; transfer learning updates or
  freezes parameters. Different mechanism, different cost, different permanence.)

## See also

- [12-on-device-inference.md](12-on-device-inference.md) — the MediaPipe-shaped deployment of a transferred model
- [04-model-selection.md](04-model-selection.md) — reuse a pretrained backbone vs train fresh
- [06-domain-gap.md](06-domain-gap.md) — fine-tuning on target data as a gap cure
- [13-quantization.md](13-quantization.md) — shrinking the transferred model for the device
- [README.md](README.md) — the honest banner for this whole section
