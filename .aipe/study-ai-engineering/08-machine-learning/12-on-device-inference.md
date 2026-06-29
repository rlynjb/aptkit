# On-device vs server inference

**Subtitle:** where the trained model physically runs · *Language-agnostic*

## Zoom out, then zoom in

A trained model is a function `f(X) → ŷ`. Before you can call it, you must decide
*where the compute lives* — on the user's device, or on a server you control. That
decision sits in the serving box of the supervised pipeline, and it is the whole
subject of this file.

```
  Zoom out — the pipeline, with the deploy decision marked

  ┌─ Data layer ──────────────────────────────────────────────────┐
  │  labeled rows                                                  │
  └───────────────────────────┬────────────────────────────────────┘
                              │ featurize
  ┌─ Feature layer ───────────▼────────────────────────────────────┐
  │  numeric X, label y                                            │
  └───────────────────────────┬────────────────────────────────────┘
                              │ split + fit
  ┌─ Model layer ─────────────▼────────────────────────────────────┐
  │  fitted f: X → ŷ                                               │
  └───────────────────────────┬────────────────────────────────────┘
                              │ ship
  ┌─ Serving layer ───────────▼────────────────────────────────────┐
  │  ★ WHERE does f(X) run? on-device  vs  server ★                │
  └──────────────────────────────────────────────────────────────────┘
```

Now zoom in. The model is identical either way — same weights, same `f`. What
changes is the *physics* of the call: a function call inside the app's own memory,
or an HTTP round-trip to a machine somewhere else. Every tradeoff in this file
falls out of that one difference. You already live this tradeoff one layer up:
aptkit defaults to a *local* Gemma and can fall back to *cloud* OpenAI. Same
choice, different model.

## Structure pass

**Layers.** Model → serving location → caller. The fitted `f` is fixed; the
serving location is the knob; the caller (the app) feels the consequences as
latency, a bill, or an offline failure.

**Axis — where does the compute physically run?** Trace one prediction. On-device:
`f` executes in the app's process, reading device RAM, returning in microseconds-
to-milliseconds with no network. Server: the app serializes `X`, opens a
connection, waits for a remote machine, parses the response. The *answer* is the
same; everything around it — speed, privacy, cost, offline behavior — flips on
this axis.

**Seam.** The load-bearing boundary is the **inference call site** — the single
function the app calls to get `ŷ`. Hide the location behind it (`predict(x)`),
and you can move the model between device and server without the caller noticing.
This is the same discipline as aptkit's `ModelProvider.complete()`: one method, and
the agent above it never learns whether Gemma ran locally or OpenAI ran in the
cloud.

## How it works

### Move 1 — the mental model

You already make this exact call in aptkit, just with an LLM instead of a trained
classifier. The default provider runs Gemma *on your own machine*: free per call,
nothing leaves the box, but bounded by your hardware. Flip to the OpenAI provider
and the same request leaves the machine: faster hardware, a per-call bill, and now
a network dependency. On-device vs server inference for a trained model is the
*identical* decision one floor down.

```
  Pattern — the same call, two locations

                       ┌──────────────────────────┐
   app calls           │   predict(x)             │   ← one seam
   predict(x) ───────► │   (location is hidden)   │
                       └─────────────┬────────────┘
                ┌────────────────────┴────────────────────┐
                ▼                                          ▼
       ON-DEVICE                                    SERVER
   ┌────────────────┐                        ┌────────────────┐
   │ f runs in app  │                        │ HTTP ─► remote │
   │ RAM, no network│                        │ f, then back   │
   └────────────────┘                        └────────────────┘
   free · private · offline                  paid · fast HW · online-only
```

You write the seam once. *Where* `f` lives behind it is a deployment decision, not
an application-logic decision.

### Move 2 — the axes, one tradeoff at a time

Five axes decide the location. Walk each; the diagram per axis shows which side
wins and why.

**Latency — on-device avoids the network; the server has faster silicon.** A
server may run `f` in 2ms on a datacenter GPU, but the *round-trip* to reach it is
20–200ms+ and varies with the user's connection. On-device adds zero network but
runs on a phone CPU. For small models the round-trip dominates, so on-device wins
the *wall-clock* race even with slower hardware.

```
  Latency budget — what the user actually waits

  ON-DEVICE:  [ f: 8ms ]                              = 8ms
  SERVER:     [ net out: 40ms ][ f: 2ms ][ net in: 40ms ] = 82ms
                ▲ network round-trip dominates for small models
```

**Privacy — on-device data never leaves.** On-device, `X` is built and consumed in
the same process; the raw input never crosses the network boundary. Server, you
must transmit `X` (often derived from sensitive user data) off the device. This is
the same reason aptkit's local Gemma is the privacy default: the conversation
never leaves the user's machine.

```
  Privacy — does X cross the device boundary?

  ON-DEVICE   ┌──────────────┐               (boundary not crossed)
              │ build X      │
              │ f(X) → ŷ     │  ── stays inside ──
              └──────────────┘
  ─────────────────────────── device boundary ──────────────────────
  SERVER      build X ──► │ X leaves device │ ──► remote f   ⚠ exposure
```

**Cost — on-device is free per call; the server bills every call.** On-device, the
user's hardware does the work: marginal cost per prediction is zero. Server, every
call consumes compute you pay for; cost scales with traffic. At high call volume
this dominates the decision — the same arithmetic as free local Gemma vs metered
cloud OpenAI tokens.

```
  Cost vs call volume

  $ │            server (linear in calls) ╱
    │                                  ╱
    │                               ╱
    │                            ╱
    │  ─────────────────────────────────  on-device (flat ≈ 0)
    └──────────────────────────────────► calls
```

**Size / latency budget — on-device must fit in RAM and the budget.** This is the
hard constraint, not a preference. A trained `f` ships *inside the app*, so it
competes for device RAM and must return within the interaction budget. Rule of
thumb for a mobile/edge classifier: under ~50MB on disk and within a ~50–100ms
inference budget. Check it before you choose on-device — if the model busts
either limit, the decision is made for you.

```pseudo
  // gate: can this trained model ship on-device?
  // run BEFORE choosing a location — a fail forces server.
  MAX_MODEL_BYTES   = 50 * 1024 * 1024   // ~50MB on disk/RAM budget
  MAX_INFERENCE_MS  = 100                // interaction latency budget

  function fitsOnDevice(model, device):
      sizeOk    = model.diskBytes <= MAX_MODEL_BYTES
      // measured on the TARGET device, not the dev laptop
      latencyOk = benchmark(model, device).p95Ms <= MAX_INFERENCE_MS
      ramOk     = model.peakRamBytes <= device.availableRamBytes

      if sizeOk and latencyOk and ramOk:
          return ON_DEVICE        // small enough — keep it local
      else:
          return SERVER           // too big/slow — must run remote
                                  // (file 13: quantization can shrink it
                                  //  enough to pass this same gate)
```

**Updateability — the server updates instantly; on-device needs a ship.** A
server model is one deploy away from every user; you can retrain nightly and roll
out without touching the app. On-device weights are baked into the installed app —
updating them means an app-store release (or a model-download channel you build)
and waiting for users to adopt it.

```
  Update path — how a new model reaches users

  SERVER:     retrain ──► deploy ──► every call now uses new f   (minutes)
  ON-DEVICE:  retrain ──► rebuild app ──► store review ──►
                          user updates ──► new f          (days, partial rollout)
```

**Move 2.5 — the aptkit reality.** Not yet exercised in aptkit — aptkit runs
pre-trained LLMs, not trained models. The pattern is taught here as study ground.
The honest anchor is one layer up: aptkit's default *local Gemma vs cloud OpenAI*
choice is this exact tradeoff applied to LLM inference rather than a trained `f`.
Local Gemma is free/private/hardware-bound; cloud OpenAI is fast/paid and leaves
the machine. The same `ModelProvider` seam would hide a future on-device trained
reranker the same way it hides Gemma today.

### Move 3 — the principle

Pick the location from the constraints, not from taste. **Small model + a
privacy, offline, or latency need → on-device.** **Large model, or one that needs
frequent retraining → server.** Then hide the choice behind one `predict(x)` seam
so you can move the model later without rewriting the caller. The model is the same
`f` either way; you are choosing physics, and the physics is reversible only if the
seam is clean.

## Primary diagram

The full topology, both locations behind one seam, with each axis labeled on the
side that wins it.

```
  On-device vs server inference — one model, two homes

                          app
                           │  predict(x)        ← THE SEAM (location hidden)
                           ▼
              ┌────────────┴────────────┐
              ▼                         ▼
      ┌───────────────┐         ═══════════════ device boundary ═══════════
      │  ON-DEVICE    │                 │ X leaves device
      │  f in app RAM │                 ▼
      │  ┌─────────┐  │         ┌───────────────┐   HTTP   ┌──────────────┐
      │  │ f(X)→ŷ  │  │         │ serialize X   │ ───────► │  remote f    │
      │  └─────────┘  │         │ wait...       │ ◄─────── │  fast HW     │
      └───────────────┘         └───────────────┘          └──────────────┘
       wins: latency             wins: model size, updateability
             privacy             pays:  per-call cost, network round-trip
             cost (free)         needs: connectivity
             offline
```

## Elaborate

The hard-won lesson: the size/latency gate decides more cases than engineers
expect. People debate privacy and cost in the abstract, but most of the time the
model simply does not fit the device budget, and that *forces* server — which is
exactly why file 13 (quantization) matters: it is the technique that shrinks `f`
enough to pass the `fitsOnDevice` gate, converting a forced-server case into a real
choice. The second lesson is to always benchmark on the *target* device, never the
dev laptop; a model that returns in 8ms on an M-series Mac can blow a 100ms budget
on a three-year-old phone. The third is the seam: teams that hard-code the location
into business logic pay for it when traffic, privacy law, or a bigger model later
flips the right answer. aptkit's `ModelProvider` is the reference shape for that
seam — local and cloud are interchangeable because nobody above the contract knows
which ran.

## Project exercises

### Add an on-device-vs-server gate to the local/cloud provider choice
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a small `fitsOnDevice`-style decision function that, given a
  (hypothetical) trained reranker's size and a measured p95 latency, returns
  `ON_DEVICE | SERVER`, mirroring how buffr already prefers local Gemma and falls
  back to cloud — wire it as a documented helper next to the provider selection.
- **Why it earns its place:** forces you to express the five axes as a single
  constraint check and to connect it to the *real* local/cloud decision aptkit
  already makes one layer up.
- **Files to touch:** new `/Users/rein/Public/buffr/src/inference-location.ts`,
  referencing the provider-selection path in `/Users/rein/Public/buffr/src` where
  the local Gemma vs cloud provider is chosen.
- **Done when:** a unit test passes asserting a 12MB / 30ms model returns
  `ON_DEVICE` and a 400MB / 250ms model returns `SERVER`.
- **Estimated effort:** `<1hr`

### Write the deployment decision note for a learned reranker
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a design note that takes a learned reranker over aptkit
  retrieval and walks all five axes (latency, privacy, cost, size/budget,
  updateability), then states a recommendation and the `predict(x)` seam that would
  let the team reverse it later.
- **Why it earns its place:** the senior move is justifying the location from
  constraints and naming the seam *before* writing code — the same reasoning that
  justifies local Gemma as aptkit's default.
- **Files to touch:** new `/Users/rein/Public/buffr/docs/reranker-deployment.md`,
  citing `/Users/rein/Public/aptkit/packages/evals/src/precision-at-k.ts` as the
  metric the reranker would be graded by.
- **Done when:** the note gives a per-axis verdict table and a final
  on-device-or-server recommendation with the gate that would flip it.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: "On-device or server — how do you decide for a trained model?"**
From constraints, in order. First the size/latency gate: does it fit RAM and the
interaction budget? If not, server, full stop. If it fits, then a privacy, offline,
or latency need pushes on-device; a large model or frequent retraining pushes
server. Then hide the choice behind one `predict(x)` seam so it's reversible.

```
  fits budget? ─no─► SERVER
       │yes
       ▼
  privacy / offline / latency need? ─yes─► ON-DEVICE
       │no
       ▼
  big model / retrains often? ─yes─► SERVER
```
*Anchor: it's the same call aptkit makes — local Gemma (private/free/hardware-bound)
vs cloud OpenAI (fast/paid/off-machine), one layer up.*

**Q: "Why might on-device be *faster* than a server with a better GPU?"**
Because the user waits on wall-clock, not on `f`. The server's GPU may run the
model in 2ms, but the round-trip to reach it is tens to hundreds of ms and varies
with the user's network. On-device adds zero network, so for a small model it wins
the total even on slower silicon.

```
  on-device:  [ f 8ms ]                          = 8ms
  server:     [ net 40 ][ f 2 ][ net 40 ]         = 82ms
                ▲ the network, not the model, sets the budget
```
*Anchor: latency is round-trip + compute; on-device deletes the round-trip.*

## See also

- `13-quantization.md` — HOW you shrink `f` to pass the on-device size/latency gate
- `01-supervised-pipeline.md` — the serving box this decision lives in
- `../01-llm-foundations/01-what-an-llm-is.md` — the `complete()` seam that hides
  local Gemma vs cloud OpenAI the same way `predict(x)` hides device vs server
