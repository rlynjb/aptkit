# On-device inference

> on-device / edge inference · deployment topology

Blunt up front: aptkit ships no on-device classifier. There is no embedded model running inside a mobile app anywhere in this codebase. This file is new ground, and it is `not yet exercised in aptkit` for an on-device classifier. I am scaffolding the deployment-topology decision so you can make it on purpose later, not stumble into it.

You have actually shipped the hard version of this once. In contrl, MediaPipe runs *on the device* — pose-landmark inference happens in the app, in the hot path, frame by frame, with no network round-trip. That was not an aesthetic choice. A network call per frame would be fatal for a real-time rep counter: 30 frames a second, each waiting on a server, jitter and dropouts visible to the user mid-rep. On-device was the only topology that could meet the latency budget. Hold that example in your head — it is the canonical "why edge" story, and we will generalize from it.

## Zoom out, then zoom in

On-device vs server is not a step in the pipeline; it is *where the Deploy box physically lives*. Same trained model, same features — the question is which machine runs the forward pass when a request arrives. The star sits on the Deploy box and asks: device, or server?

```
On-device inference is a placement choice for the Deploy stage
┌──────────┐   ┌──────────┐   ┌──────────────────┐   ┌────────┐   ┌──────────────────┐
│  Data    │──▶│ Features │──▶│ Train / Val / Test│──▶│ Model  │──▶│ ★ Deploy / Serve │
└──────────┘   └──────────┘   └──────────────────┘   └────────┘   └────────┬─────────┘
                                                                           │
                            where does the forward pass run?               │
                       ┌───────────────────────────────────────────────────┘
                       ▼
            ┌──────────────────┐                 ┌──────────────────┐
            │  SERVER inference │                 │  DEVICE inference │
            │  (cloud GPU/CPU)  │                 │  (phone/edge)     │
            └──────────────────┘                 └──────────────────┘
```

Everything before Deploy is identical between the two topologies. The split happens only at serve time, and it cascades into latency, privacy, update cadence, and how big a model you are even allowed to use.

## Structure pass

One axis: **where does the forward pass execute relative to the user?** On the server, far away, big and updatable. On the device, right next to the user, small and constrained. Every tradeoff hangs off that single distance.

```
Axis: distance from forward pass to the user
 far (server) ◀──────────────────────────────────────────────▶ near (device)

 SERVER                                                          DEVICE
 + big models, easy to update                                   + low latency, offline, private
 + central monitoring                                           + no per-request network cost
 − network latency + jitter                                     − constrained compute/mem/battery
 − offline = dead                                               − updates are slow (app ship)
 − data leaves the device                                       − model must be SMALL
```

The seam is sharp: cross it and the entire set of constraints flips. You do not get to keep server's "update instantly" and device's "works offline" — pick the topology that matches the dominant constraint.

## How it works

### Move 1 — mental model

Mental model: **inference placement is a latency-and-trust budget, not a model-quality question.** You do not choose device because the model is better there (it is usually worse — smaller). You choose device when the round-trip cost, the offline requirement, or the privacy requirement dominates the loss from a smaller model.

```
PATTERN: the placement tradeoff seesaw
        SERVER side                            DEVICE side
   ┌────────────────────┐                 ┌────────────────────┐
   │ + model capacity   │       ╱╲        │ + latency (no hop) │
   │ + instant updates  │      ╱  ╲       │ + offline          │
   │ + easy monitoring  │ ────●────────── │ + privacy          │
   │ − latency + jitter │   fulcrum:      │ − tiny model only  │
   │ − needs network    │   what          │ − slow updates     │
   │ − data egress      │   dominates?    │ − battery/heat     │
   └────────────────────┘                 └────────────────────┘
```

Find the dominant constraint, and the seesaw tips itself. For contrl, the dominant constraint was per-frame latency, so it tipped hard to device.

### Move 2 — step by step

**Server inference, in full.** The forward pass runs on cloud hardware. Big models are fine — you have GPUs and memory. Updating is trivial: redeploy the server and every user gets the new model instantly. But every request pays a network round-trip, and when the network is bad the inference is bad or absent. And the input data leaves the device to reach the server, which is a privacy and compliance cost.

```
Server inference path (per request)
 device                         network                   server
 ┌──────┐   input bytes   ┌───────────────┐   ┌──────────────────────┐
 │ app  │ ──────────────▶ │ latency+jitter │─▶ │ big model forward pass│
 │      │ ◀────────────── │  (+ offline=∅) │◀─ │  result               │
 └──────┘    result        └───────────────┘   └──────────────────────┘
            data has now LEFT the device ──────────────▲ privacy cost
```

`Not yet exercised in aptkit` as a classifier topology — but note the nuance in the next part, because aptkit *does* have a local-execution story that is easy to confuse with this.

**Device inference, in full.** The forward pass runs on the user's hardware — phone, tablet, laptop. No network hop, so latency is bounded by the device and inputs never leave it (offline-capable, private). The cost: the device has limited compute, memory, and battery, so the model must be small, and you can only update it by shipping a new app build, which is slow and fragmented across users who update on their own schedule.

```
Device inference path (per request)
 device
 ┌──────────────────────────────────────────────┐
 │ app                                            │
 │  input ─▶ SMALL model forward pass ─▶ result   │  no network hop
 │  data never leaves this box ──── privacy ✓     │  offline ✓
 │  constrained by: compute / memory / battery    │  update = ship app ✗ slow
 └──────────────────────────────────────────────┘
```

This is the contrl topology: MediaPipe's pose model runs inside the box above, per frame.

**The distinction you must not blur: local LLM ≠ on-device classifier.** aptkit has a local-execution angle — Gemma via Ollama. That means a *large language model running locally on the user's own machine* instead of a cloud LLM API. It is genuinely "local," and it earns the privacy and offline benefits of the device column. But it is **not** the same animal as an on-device *classifier* embedded in a mobile app, and conflating them will burn you in an interview.

```
Two different things that both say "local" — keep them apart
┌──────────────────────────────────────┬──────────────────────────────────────┐
│ aptkit: LOCAL LLM (Gemma via Ollama)  │ contrl: ON-DEVICE CLASSIFIER (MediaPipe)│
├──────────────────────────────────────┼──────────────────────────────────────┤
│ host: user's machine (desktop/server) │ host: mobile device, inside the app   │
│ model: large generative LLM           │ model: small specialized classifier   │
│ runtime: Ollama process               │ runtime: embedded in the app binary    │
│ workload: text generation, agentic    │ workload: per-frame pose landmarks     │
│ latency need: seconds OK              │ latency need: per-frame, real-time     │
│ "local" means: not a cloud LLM API    │ "device" means: not a server at all    │
└──────────────────────────────────────┴──────────────────────────────────────┘
```

Both avoid the cloud, so both buy privacy and offline. But the local LLM is a *deployment-host* choice for a big generative model (Ollama instead of a hosted API), while the on-device classifier is a *real-time hot-path* choice for a tiny purpose-built model embedded in a mobile app. Different model classes, different latency regimes, different runtimes. `Not yet exercised in aptkit`: the on-device-classifier-in-a-mobile-app topology. aptkit only has the local-LLM flavor.

### Move 3 — principle

Principle: **place inference where the dominant constraint lives, then pay the bill for that choice with eyes open.** Device buys latency, offline, and privacy at the price of model size and update speed. Server buys model capacity and instant updates at the price of network dependence and data egress. There is no free placement — name the constraint that decides it, write it down, and accept the bill.

## Primary diagram

```
Placement decision tree (run this before you write any inference code)
                         start: where to run the forward pass?
                                       │
                ┌──────────────────────┼────────────────────────┐
                ▼                       ▼                        ▼
      is per-request latency    must it work OFFLINE?    can data NOT leave
      in a real-time hot path?   (no network assumed)     the device (privacy)?
                │                       │                        │
           yes  │ no               yes  │ no                yes  │ no
                ▼                       ▼                        ▼
          ┌──────────┐           ┌──────────┐            ┌──────────┐
          │  DEVICE  │           │  DEVICE  │            │  DEVICE  │
          └──────────┘           └──────────┘            └──────────┘
                                       │ (if all "no")
                                       ▼
                            ┌────────────────────────┐
                            │ default to SERVER:      │
                            │ bigger model, instant   │
                            │ updates, central monitor │
                            └────────────────────────┘
                                       │
                            but can the model even FIT
                            on the device's budget?  ── no ─▶ stay SERVER
                                       │ yes
                                       ▼
                            quantize to fit (see 13)
```

The load-bearing node is the last one: even when latency/offline/privacy all say "device," you only get to go there if the model *fits the device budget*. That is the bridge to quantization.

## Elaborate

A few edges. First, **hybrid is real and common**: run a small model on-device for the hot path and call a big server model for the rare hard cases (an on-device gate that escalates). Contrl-style real-time work would gate on-device and could escalate ambiguous segments off the hot path. Second, **"device budget" is concrete, not vibes** — memory ceiling, sustained compute before thermal throttling, battery drain per minute, app-binary size limit. Write those four numbers down before choosing device; they are the actual constraint. Third, **update cadence asymmetry is underrated**: a bug in a server model is fixed in one deploy; a bug in an on-device model lives until every user updates the app, which for some users is *never*. Plan for stale device models in the field.

Cross-reference: `13-quantization.md` is the answer to "the model doesn't fit the device budget." On-device inference is the *why*; quantization is one of the *hows*.

## Project exercises

### Inference-placement decision doc + device-budget check

- **Exercise ID:** EX-ML-12a — Phase 5 ML hardening, because placement is a deployment-topology decision you make once you know real constraints, not a day-one guess.
- **What to build:** A short written decision doc that runs the placement decision tree for a concrete buffr use case (e.g. a hypothetical on-device intent classifier vs the Gemma-via-Ollama local LLM), *plus* a small `device-budget.ts` utility that takes a model's size and a device's memory/compute/battery ceilings and returns fits/doesn't-fit with the binding constraint named.
- **Why it earns its place:** It forces you to (a) name the dominant constraint instead of cargo-culting "edge is cool," and (b) make "device budget" concrete numbers rather than a vibe — exactly the discipline that separates a real placement decision from a guess. It also makes you write down the local-LLM-vs-on-device-classifier distinction so you never blur it.
- **Files to touch:** `/Users/rein/Public/buffr/docs/inference-placement.md` (Case B (new)); `/Users/rein/Public/buffr/src/inference/device-budget.ts` (Case B (new)); `/Users/rein/Public/buffr/src/inference/device-budget.test.ts` (Case B (new)).
- **Done when:** The doc walks the decision tree to a placement with the dominant constraint named, explicitly separates aptkit's local-LLM (Ollama) story from an on-device-classifier story, and `device-budget.ts` returns the binding constraint (memory vs compute vs battery vs binary size) for at least two model/device pairs with tests.
- **Estimated effort:** 1–4hr

## Interview defense

**Q: Why did contrl run pose inference on-device instead of calling a server?**

Per-frame latency dominated. A real-time rep counter processes ~30 frames/sec; a network round-trip per frame adds latency and jitter you can feel mid-rep, and a dropped connection kills the feature. On-device was the only topology meeting the latency budget.

```
30 fps × network hop = visible jitter ─▶ device wins
```

Anchor: MediaPipe ran inside the app, no hop, per frame.

**Q: aptkit runs Gemma locally via Ollama. Is that on-device inference like contrl?**

Both avoid the cloud, so both buy privacy and offline — but they are different animals. Gemma-via-Ollama is a *large generative LLM* hosted on the user's machine instead of a cloud API. contrl's MediaPipe is a *small specialized classifier embedded in a mobile app* in a real-time hot path. Different model class, latency regime, and runtime.

```
local LLM (Ollama, big, seconds OK) ≠ on-device classifier (embedded, tiny, per-frame)
```

Anchor: aptkit has the local-LLM flavor only; the embedded-mobile-classifier topology is not exercised.

**Q: When does server inference beat device?**

When none of latency/offline/privacy dominate and you want model capacity plus instant updates. Server lets you run a big model and fix it in one deploy instead of waiting for every user to update an app.

```
no hot-path / no offline / no egress concern ─▶ default SERVER
```

Anchor: the placement tree defaults to server only when all three device-pulling constraints are absent.

## See also

- [13-quantization.md](./13-quantization.md) — how you shrink a model to fit the device budget
- [11-cold-start.md](./11-cold-start.md) — the personal agent that has to run somewhere
