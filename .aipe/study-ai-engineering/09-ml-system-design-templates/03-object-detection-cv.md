# Design an object-detection / computer-vision system

- **The prompt:** "Design a system that detects and localizes objects in images or a video stream in real time."

- **Standard architecture:** The whiteboard is a frame pipeline from capture through a detection model to post-processing, with the training path that produces the model shown alongside.

  ```
  Object detection — frame pipeline + training path
  ┌────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌────────┐
  │ frame  │ → │ preprocess│ → │ detection│ → │   NMS    │ → │ boxes  │
  │ capture│   │ (resize) │   │  model   │   │ + thresh │   │ + class│
  └────────┘   └──────────┘   └────┬─────┘   └──────────┘   └────────┘
                                   ▲
                              ┌────┴─────────────────────┐
                              │      training path        │
                              │ labeled images → augment  │
                              │ → train CNN → quantize     │
                              └───────────────────────────┘
  ```

  The detection model is the system; everything else is feeding it frames and cleaning up its boxes.

- **Data model:**
  - Labeled image set — images with bounding boxes + class labels, the training ground truth.
  - Model weights — versioned trained detector (and a quantized variant for the edge).
  - Anchor/class config — the box priors and label taxonomy the model was trained against.
  - Inference log — frames, predicted boxes, confidences, for monitoring and hard-example mining.
  - Augmentation config — the transforms (crop, flip, color jitter) applied at train time, recorded for reproducibility.

- **Key components:**
  - Preprocessing resizes and normalizes frames to the model's input spec; choice: fixed input resolution trades detection of tiny objects for predictable latency.
  - Detection model predicts boxes + classes in one pass; choice: a single-stage detector (YOLO/SSD family) over two-stage (R-CNN) when real-time latency matters more than peak accuracy.
  - Non-max suppression collapses overlapping boxes to one per object; choice: IoU-threshold NMS as the standard dedup, tuned per class.
  - Quantization/edge runtime shrinks the model for on-device inference; choice: int8 quantization to hit frame-rate on constrained hardware, accepting a small mAP drop.

- **Scale concerns:**
  - At ~30 fps real-time the model inference time per frame is the hard constraint; a model slower than ~33ms/frame drops frames.
  - At edge deployment memory and compute are capped; you must quantize, accepting an mAP drop for the frame-rate.
  - At ~1k classes the long tail has few labeled examples and detection accuracy collapses there; you need class-balanced sampling and hard-example mining.
  - At high resolution (4K) preprocessing and model cost scale with pixels; tile or downsample, trading small-object recall for throughput.

- **Eval framing:** Offline, measure mean average precision (mAP) at IoU thresholds (mAP@0.5, mAP@0.5:0.95) on a held-out labeled set — this is precision/recall over boxes, with IoU defining a correct localization. Online, track inference latency per frame, dropped-frame rate, and a sampled human-audit precision on production frames. The offline mAP and the online experience diverge when production frames differ from the training distribution.

- **Common failure modes:**
  - Domain shift — production lighting/angles/cameras differ from training data; mitigate with augmentation covering the deployment conditions and periodic retraining on production samples.
  - Small-object miss — fixed input resolution loses tiny objects; mitigate with tiling or a higher-resolution input where latency allows.
  - Class imbalance — rare classes are under-detected; mitigate with class-balanced sampling and hard-example mining.
  - Quantization accuracy loss — the edge model drops boxes the full model caught; mitigate with quantization-aware training rather than post-hoc quantization.

- **Applies to this codebase:** `no`. aptkit has no vision capability whatsoever — no image input, no frames, no MediaPipe, no CNN, no on-device runtime, no quantization. It is a text/LLM-application toolkit; nothing in the architecture above maps to a real aptkit component. You'd only reach for this template in an interview if explicitly asked to design a CV system, in which case you walk the canonical pipeline above on its own merits and do not force an aptkit mapping. Pretending the retrieval or agent layers are a detection system would be dishonest.

- **How to make it apply:** It doesn't, and you should say so rather than contrive a mapping. Computer vision is entirely out of aptkit's shape: there is no frame source to detect over, no labeled image set, and no model to train. If a CV system were genuinely required, it would be a new subsystem built from scratch — a separate package with its own image-ingestion path, a trained detector, and an NMS/serving layer — sharing nothing with the current retrieval and agent packages beyond, at most, the buffr persistence layer for logging inference results. CV is `not yet exercised` and outside the toolkit's domain.
