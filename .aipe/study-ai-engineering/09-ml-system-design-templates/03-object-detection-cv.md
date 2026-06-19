# Object Detection / CV System Design

- **The prompt:** "Design a computer vision system that detects objects in real-time video, on-device."

- **Standard architecture:**

  ```text
  On-device CV pipeline
  ────────────────────────────────────
  Video frames
    │
    ▼
  ┌──────────────────────────────────┐
  │ Preprocessing                    │
  │  (resize, normalize, batch)      │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Detection model                  │
  │  (CNN or MediaPipe-style         │
  │   landmark detector)             │
  └──────────────┬───────────────────┘
                 │  bounding boxes
                 │  or landmarks
                 ▼
  ┌──────────────────────────────────┐
  │ Post-processing                  │
  │  (smoothing, tracking,           │
  │   confidence thresholding)       │
  └──────────────┬───────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────┐
  │ Downstream consumer              │
  │  (rep counter, form classifier,  │
  │   AR overlay, etc.)              │
  └──────────────┬───────────────────┘
                 │
                 ▼
              Output
  ```

- **Data model:**
  - Frame buffer (rolling window, last N frames).
  - Detection output per frame: `{bounding boxes or landmarks, confidence, model version, timestamp}`.
  - Tracking state: which detection in frame T corresponds to which in frame T+1 (object identity across time).
  - Inference log (when audit-enabled): raw detections, post-processed outputs, user feedback — the training-data pipeline for future model improvements.

- **Key components:**
  - *Preprocessing*: resize to model input size, normalize. Decision: on-device, not cloud, for privacy + latency.
  - *Detection model*: CNN for general object detection (YOLO-style), pose-estimation model for landmarks (MediaPipe-style). Decision: choose by output shape needed downstream — boxes vs landmarks.
  - *Post-processing*: temporal smoothing (Kalman or EMA) to reduce jitter, confidence thresholding to drop noisy detections.
  - *Tracking*: maintain object identity across frames so downstream sees "the same object moved," not "two new objects appeared."
  - *Downstream consumer*: the trained classifier or rule engine that turns detections into final output (form labels, rep counts, AR placement).

- **Scale concerns:**
  - At ~30fps real-time: per-frame inference must hit < 33ms. Quantization (int8/fp16), GPU delegate where supported, skip frames when behind.
  - On older devices: model too big/slow. Smaller variant, fall back to per-frame instead of streaming.
  - Battery cost: continuous inference drains battery. Pause when idle, lower fps when motion is slow.

- **Eval framing:**
  - Offline: mAP (mean Average Precision) on held-out labeled video, per-class precision and recall.
  - Online: latency p95/p99 on real devices, battery cost per minute, sustained FPS.
  - User-facing: downstream task accuracy (does the rep counter agree with ground truth?).
  - Domain-gap measurement: train on public data, eval on real user devices to catch distribution shift.

- **Common failure modes:**
  - Domain gap: trained on studio video, fails on phone-camera-in-living-room video. Mitigation: fine-tune on self-collected deployment data.
  - Occlusion / partial visibility: low confidence or missed entirely. Mitigation: track through occlusion with temporal smoothing, surface uncertainty downstream.
  - Drift in deployment: lighting, angles, demographics shift. Mitigation: drift detection on detection-output distribution, retraining trigger.
  - Battery / thermal throttling on long sessions. Mitigation: monitor frame time, degrade gracefully (drop fps, skip frames) before the user notices.

- **Applies to this codebase:** **No.** AptKit has no vision or computer-vision surface anywhere. There are no frames, no detection model, no on-device inference, no image or video input. The entire repo operates on text-and-stream data: natural-language questions, workspace metric metadata, and JSON trace/replay artifacts (see `.aipe/project/context.md` — "Data is file- and stream-shaped"). No tool in any agent's policy touches pixels. This template does not map onto AptKit at any layer.

  (Background only, do not cite as AptKit: real-time pose-based CV with a MediaPipe-style landmark detector feeding a downstream form classifier is a system the author has built elsewhere. That is relevant context for an interviewer asking "have you done CV?" — the answer is yes, separately — but it is not in this codebase and should not be presented as AptKit's.)

- **How to make it apply:** Do not force a mapping. The right move is to recognize that this template is the one you reach for *only when explicitly asked to design a CV system*. If that comes up, walk the canonical architecture above end to end — preprocessing → detection model → post-processing/tracking → downstream consumer → eval on mAP and real-device latency — and answer from CV experience built elsewhere rather than pretending AptKit exercises it.

  If you genuinely wanted AptKit to host a CV capability, the seam is clean but the work is real: a CV agent would be a new `packages/agents/*` capability with its own `*_CAPABILITY_ID`, tool policy, and validator, but the "tool" would be an on-device inference call rather than an analytics query, and the structured output would be detections rather than anomalies or recommendations. That is a from-scratch model-training and deployment effort, not a reframe — which is exactly why "Applies" is `no`. The supervised-learning and feature-engineering foundations live in [`../08-machine-learning/`](../08-machine-learning/).
