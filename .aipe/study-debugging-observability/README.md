# Study — Debugging & Observability (AptKit)

How this repo reveals its own behavior. AptKit is an LLM-agent toolkit, so "behavior"
means *what the agent did across a run* — which model turns fired, which tools it
called, what they returned, how many tokens it burned, and whether the final output
passed its shape check. The whole observability story is built on one primitive: a
typed, timestamped **trace event** emitted at every agent action.

The question this guide answers: **when an agent run goes wrong, what evidence exists
to explain it — and to reproduce it deterministically later?**

## Reading order

1. `00-overview.md` — the evidence map, ranked findings, what's `not yet exercised`.
2. `audit.md` — Pass 1. The 8-lens debugging-and-observability audit, grounded in
   real `file:line`. Read this to see which lenses the repo exercises and which it
   doesn't.
3. Pass 2 — the discovered pattern files, in dependency order:
   - `01-structured-trace-events.md` — `CapabilityEvent`, the load-bearing primitive.
     Every other pattern reads from the stream this produces.
   - `02-replay-artifact-as-snapshot.md` — the full run captured as one JSON file:
     reproduction + evidence in a single artifact.
   - `03-usage-metrics-ledger.md` — tokens, cost, and turn count *derived from* the
     trace, not separately instrumented.
   - `04-live-trace-stream.md` — the same events serialized as NDJSON and streamed to
     the Studio UI while the run is still in flight.
   - `05-degradation-warning-traces.md` — `warning` events that explain *why* a
     provider switched or a local model was skipped.
   - `06-eval-as-embedded-evidence.md` — the pass/fail verdict stamped onto every
     snapshot, and the secret-scan that guards artifacts before they're shared.
   - `07-reproduction-spike-harness.md` — a forward-looking de-risk spike
     (`scripts/gemma-toolcall-spike.mjs`): run a flaky component N times, measure the
     pass rate, band it into a build / harden / no-go decision *before* building on it.
   - `08-retrieval-miss-diagnosis.md` — a real war story: a silent "not available" on a
     good corpus, diagnosed by reading the trajectory backward to a hallucinated tool
     argument. The local-incident loop run end to end, with the regression guard.

## Where this sits — partition

```
  study-testing                 catches known failures before release (evals, fixtures).
  study-debugging-observability explains unknown behavior with evidence (this guide).
  study-performance-engineering measures cost/latency budgets from the same metrics.
```

A finding belongs to the generator that owns the mechanism. This guide owns the
*evidence* — the trace, the snapshot, the metrics derived from them. It cross-links
rather than re-teaching its neighbors.

## Cross-links

- **`study-testing`** — the `eval` block, the fixture-replay backbone, and the
  promote-to-fixture loop. The trace is the *input* to those evals; the eval verdict
  is the *evidence* this guide reads. See `06-eval-as-embedded-evidence.md`.
- **`study-performance-engineering`** — `usage-ledger.ts` (tokens, USD cost, latency
  attribution). This guide treats those numbers as diagnostic signals;
  performance-engineering treats them as budgets. See `03-usage-metrics-ledger.md`.
- **`study-ai-engineering`** — the trace as eval input and the model-output JSON
  extraction path. The trace is how you *see* the reasoning that AI engineering tunes.
- **`study-agent-architecture`** — the agent loop in `run-agent-loop.ts`. The trace is
  that loop made observable: every turn and tool call is one event.
