# Design an On-Device Object Detection System

- **The prompt:** "Design a computer vision system that detects objects in real-time video, on-device."

- **Standard architecture:**

```
        camera frames (30fps)
              │
              ▼
   ┌──────────────────────────┐
   │ Preprocessing             │  resize, normalize, color convert
   └────────────┬─────────────┘
                │
                ▼
   ┌──────────────────────────┐
   │ Detection model           │  CNN detector / MediaPipe landmark
   │ (quantized, GPU delegate) │
   └────────────┬─────────────┘
                │  raw detections
                ▼
   ┌──────────────────────────┐
   │ Post-processing           │  confidence threshold, NMS,
   │                           │  temporal smoothing, tracking
   └────────────┬─────────────┘
                │  stable detections
                ▼
   ┌──────────────────────────┐
   │ Downstream consumer        │  rep counter / form classifier / AR
   └──────────────────────────┘
```

- **Data model:**
  - frame buffer `{frame, ts}` — bounded ring buffer; drop frames under back-pressure rather than queue latency.
  - per-frame detection `{boxes|landmarks, confidence, model_version, ts}` — the model output for one frame.
  - tracking state `{track_id, last_pos, velocity, age}` — links detections across frames so a single object isn't N independent blips.
  - inference log `{ts, latency_ms, fps, device, model_version}` — on-device telemetry for the latency/battery story.

- **Key components:**
  - Preprocessing — resizes and normalizes frames to model input; choice: do it on the GPU/accelerator, not the CPU — at 30fps the CPU copy alone can blow the frame budget.
  - Detection model — produces boxes or landmarks per frame; choice: a quantized mobile architecture (int8/fp16) with a hardware delegate, because a server-grade model misses the 33ms budget on a phone.
  - Post-processing — thresholds, suppresses duplicates, smooths, tracks; choice: temporal smoothing across frames so a one-frame dropout doesn't flicker the downstream output.
  - Downstream consumer — turns stable detections into the user-facing signal (rep count, form check, AR overlay); choice: keep it pure of the model so you can swap detectors without rewriting the product logic.

- **Scale concerns:**
  - At ~30fps each frame's full inference must finish in <33ms → quantize (int8/fp16), use the GPU/NNAPI delegate, and skip frames before you ever miss the budget.
  - On older devices the model is simply too big for the budget → ship a smaller variant and select by device class at install/runtime.
  - Battery and thermal — sustained inference drains and throttles → pause when no object is present, drop fps when backgrounded or hot.

- **Eval framing:** Offline: mAP and per-class precision/recall on a labeled validation set. Online: latency p95/p99 measured on *real devices* (not the dev machine), sustained FPS under thermal load, battery cost per session, and the downstream task accuracy (did the rep counter actually count right). Always measure the domain gap explicitly — train on public data, evaluate on self-collected real-usage footage, and report the drop.

- **Common failure modes:**
  - Domain gap — public training data ≠ real users' lighting/angles/bodies → fine-tune on self-collected footage from the actual use context.
  - Occlusion — object partly hidden, detection drops → temporal smoothing and tracking carry the track through the gap.
  - Deployment drift — input distribution shifts post-launch (new device cameras, new user population) → monitor the output distribution on-device and alert on shift.
  - Battery / thermal throttling — the chip slows under sustained load, fps collapses → degrade gracefully (lower fps, smaller model) rather than stutter.

- **Applies to this codebase:** `no`. aptkit has no computer vision, no on-device model, no video pipeline, no image preprocessing — it is a server/local-LLM agent toolkit (retrieval contracts, RAG, analytics agents over `runAgentLoop`). None of the boxes above map onto aptkit code. This template's natural anchor is the reader's own on-device CV work in contrl (MediaPipe pose → rep counter, running on-device with the exact latency/battery/domain-gap constraints above) — that is where the real CV experience lives, not aptkit.

- **How to make it apply:** This template does not map onto aptkit, and forcing a mapping would be dishonest. In an interview, say so directly: "I haven't built CV inside aptkit — that's an LLM-agent toolkit — but I shipped on-device pose detection in contrl, and I'd walk the canonical architecture from that: MediaPipe landmarks, quantized on-device inference, temporal smoothing into a rep counter, and the domain-gap problem of training on public pose data but running on real users in real gyms." Anchor the design to lived CV experience; don't retrofit it onto a server toolkit.
