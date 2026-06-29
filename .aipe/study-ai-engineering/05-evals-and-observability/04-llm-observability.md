# LLM observability

> Traces / spans / replay (Industry standard)

Observability for an LLM app answers three questions at three time scales. Traces: what happened in *this* request — which steps, which tools, how many tokens? Spans: how long did each *part* take? Replay: can I re-run a saved trace to prove a fix? aptkit has the trace pillar as a real `CapabilityEvent` stream and the replay pillar as the promote-and-replay loop. The span pillar — per-segment latency — is thin: the events carry timestamps but there's no per-span duration roll-up yet. No external vendor (Langfuse/LangSmith); it's local artifacts and NDJSON. Say that plainly.

## Zoom out, then zoom in

The three pillars stack from "what" to "how long" to "prove it." Traces are the event record of a single run. Spans are the timing breakdown of that run. Replay is the ability to take a saved run and execute it again deterministically — which is what turns a trace from a log into a *verification tool*.

```
The three observability pillars in aptkit (LAYERS)

  ┌──────────────────────────────────────────────────────────────┐
  │ REPLAY   re-run a saved trace to verify a fix                  │  ★ strong
  │   artifact → eval → promote → deterministic replay             │  replay-runner.ts
  ├──────────────────────────────────────────────────────────────┤
  │ SPANS    how long did each part take?                          │  thin
  │   model_usage carries timestamps; no per-span duration roll-up │  ← Case A gap
  ├──────────────────────────────────────────────────────────────┤
  │ TRACES   what happened: steps, tool calls, tokens, model       │  ★ strong
  │   CapabilityEvent union, streamed as NDJSON                    │  ndjson-stream.ts
  └──────────────────────────────────────────────────────────────┘
        traces + replay are real; spans (latency) is the open edge
```

Two pillars are load-bearing — the trace stream and the replay loop. The middle pillar exists in raw form (timestamps on events) but isn't aggregated into per-span latency yet.

## Structure pass

One axis: **the lifetime of the observed thing — instant, interval, or rerun**.

- **Traces (instant events)** — `CapabilityEvent` is a discriminated union: `step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`. Each carries a `capabilityId` and an ISO `timestamp`. Streamed line-by-line as NDJSON (`packages/runtime/src/ndjson-stream.ts`). Token/model cost rolls up via `summarizeUsage` (`packages/runtime/src/usage-ledger.ts:24-42`).
- **Spans (intervals)** — you *can* derive a tool-call duration from the `tool_call_start`/`tool_call_end` pair, and model latency from `model_usage` timestamps, but aptkit doesn't compute or surface per-span durations today. The raw material is there; the roll-up isn't.
- **Replay (rerun)** — `listReplayArtifacts` (`replay-runner.ts:31-44`) finds saved runs deterministically; `evaluateReplayArtifact` (47-67) re-grades them; the promote-and-replay scripts turn a verified run into a frozen baseline.

The seam: events flow out as NDJSON during a live run, get saved as an artifact, and the *same* artifact later drives a deterministic replay. One format, two lives — live observation and offline verification.

## How it works

**Move 1 — the mental model.** A trace is a flight recorder: every step the agent took, time-stamped, appended one line at a time. Replay is taking that recording and re-flying the exact route in a simulator — same inputs, no live engine — to confirm your fix didn't crash anything. The deterministic replay provider (`FixtureModelProvider`) is the simulator.

```
The replay-as-verification loop (PATTERN)

  LIVE RUN
    │  emits CapabilityEvent stream (step/tool_call/model_usage/...)
    ▼  as NDJSON
  artifacts/replays/*.json ───────── the flight recording
    │  eval (structural-diff / detection / rubric)
    ▼
  promote:replay ───────────────────► fixtures/promoted/*.json (baseline)
    │  replay:fixtures
    ▼
  FixtureModelProvider feeds canned responses, deterministic
    │
    ▼
  {ok, checked, failed}  ── a fix is "verified" when the replay still passes
```

**Move 2 — walk the pillars.**

**Traces: a discriminated union streamed as NDJSON.** Each event is one self-describing line, so you can tail a run live or parse it after the fact.

```
CapabilityEvent + ndjson-stream.ts            what each line tells you
  { type: 'step',           capabilityId, ts } ─ agent advanced a step
  { type: 'tool_call_start',capabilityId, ts } ─ a tool began
  { type: 'tool_call_end',  capabilityId, ts } ─ a tool finished
  { type: 'model_usage',    capabilityId, ts } ─ tokens + model for THIS call
  { type: 'warning'|'error',capabilityId, ts } ─ something went sideways
       └ streamed one-JSON-object-per-line (NDJSON)
```

The union lives across the runtime; the NDJSON encoding is `packages/runtime/src/ndjson-stream.ts`. NDJSON matters because it's append-only and line-delimited — you don't need the whole run in memory to read or write it, and standard tools (`jq`, `grep`) work on it directly.

**Token/cost roll-up via the usage ledger.** Per-request `model_usage` events get summed.

```
usage-ledger.ts (24-42)                       the cost pillar
  summarizeUsage(events) =>
    fold model_usage events ──────────────  total tokens, per model
                                            (the $ side of a trace)
```

`packages/runtime/src/usage-ledger.ts:24-42` is the aggregation. This is the per-request token/model/cost view — the "what did this run cost" question.

**Replay: the same artifact, re-graded deterministically.** Listing is sorted so two runs see files in the same order; evaluation re-checks shape.

```
replay-runner.ts (31-44, 47-67)               deterministic re-verification
  listReplayArtifacts(dir):
    readdir → filter .json → .sort()   ─────  stable order (43)
  evaluateReplayArtifact(artifact):
    assertCapabilityReplayArtifactShape  ───  re-grade the saved run (48)
    return { ok, issues, capabilityId,
             fixture, recommendationCount,
             anomalyCount, diagnosisPresent }
```

`packages/evals/src/replay-runner.ts:43` sorts artifacts so replays are order-stable; `:47-67` re-evaluates one. Paired with the deterministic replay provider (`fixture-provider.ts:11-16`, returns `responses[index++]`, throws when exhausted), the rerun is reproducible to the byte — the foundation of "this fix is verified."

**Move 3 — the principle.** A trace becomes valuable when you can *replay* it. Logs you only read are forensic; traces you can re-execute are a verification harness. aptkit leans into that — one NDJSON artifact format serves both the live "what happened" view and the offline "does it still pass" check. The cost is honest scope: it's local files, not a hosted vendor with a UI, and per-span latency isn't aggregated yet.

## Primary diagram

```
aptkit's pillar scorecard

  TRACES  ████████████  CapabilityEvent union, NDJSON, usage-ledger (real)
  SPANS   ████░░░░░░░░  timestamps present, no per-span latency roll-up (gap)
  REPLAY  ████████████  artifact → eval → promote → deterministic replay (real)
          └ vendor? none — local artifacts + NDJSON, honest scope
```

## Elaborate

The NDJSON choice is the unglamorous-but-right call. A single fat JSON blob per run forces you to buffer the whole trace before you can read any of it and corrupts everything if the process dies mid-write. NDJSON appends one valid line at a time, so a killed process still leaves a readable partial trace, and you can stream-process arbitrarily large runs. It's also why the same file works live and offline — each line stands alone.

The span gap is the honest edge to name. The events carry ISO timestamps and `tool_call_start`/`tool_call_end` come in pairs, so the *data* to compute per-span latency exists. What's missing is the roll-up: nothing subtracts start from end and surfaces "the retrieval tool took 1.2s." That's a derivation over data you already emit — the Case A exercise.

And there's no Langfuse/LangSmith here. That's fine for a local-first toolkit, but it's the right thing to disclose rather than imply a hosted dashboard exists.

## Project exercises

### Add per-span latency to the trace

- **Exercise ID:** `EX-EVAL-04a`
- **What to build:** A function that pairs `tool_call_start` with its matching `tool_call_end` (and derives model-call latency from `model_usage` timestamps), then surfaces per-span durations in the replay/Studio summary. This fills the span pillar the README's observability section leaves thin (Phase 3, evals/observability).
- **Why it earns its place:** It turns the existing instant-event trace into a real timing breakdown without changing what's emitted — pure derivation over data you already have. Latency-per-span is the question every production triage starts from.
- **Files to touch:** `packages/runtime/src/usage-ledger.ts` (sibling summarizer) or a new module; surface in `packages/evals/src/replay-runner.ts` summary fields.
- **Done when:** a replayed artifact reports a per-tool and per-model-call duration, and a slow tool is visibly attributable.
- **Estimated effort:** `1–4hr`

### NDJSON trace viewer

- **Exercise ID:** `EX-EVAL-04b`
- **What to build:** A tiny CLI that reads an NDJSON artifact and renders a readable timeline (step / tool / usage / error) with the usage-ledger totals at the bottom.
- **Why it earns its place:** It proves the local-artifact story replaces a hosted vendor UI for the basics, and makes the trace pillar inspectable.
- **Files to touch:** new script reading `artifacts/replays/*.json`; reuse `usage-ledger.ts:24-42`.
- **Done when:** running it on a saved artifact prints an ordered event timeline plus token totals.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: What's in a trace here, and how is it stored?**

```
  CapabilityEvent union: step | tool_call_start/end | model_usage | warning | error
  each: capabilityId + ISO timestamp → streamed as NDJSON (one object per line)
```

Anchor: `packages/runtime/src/ndjson-stream.ts` for the encoding; `usage-ledger.ts:24-42` rolls up tokens.

**Q: How does a trace verify a fix?**

```
  live run → artifact → eval → promote → deterministic replay (FixtureModelProvider)
  fix is "verified" when the replay still passes  {ok, checked, failed}
```

Anchor: `replay-runner.ts:47-67` re-grades; `fixture-provider.ts:11-16` makes the rerun deterministic.

**Q: What's missing from the observability story?**

Anchor: no external vendor (local artifacts + NDJSON), and per-span latency isn't rolled up — timestamps exist (`tool_call_start`/`end`) but nothing computes the duration. Honest gaps.

## See also

- [01-eval-set-types.md](01-eval-set-types.md) — the golden/regression sets the replay loop produces.
- [02-eval-methods.md](02-eval-methods.md) — the scorers run against each artifact.
- [../02-context-and-prompts/03-prompt-chaining.md](../02-context-and-prompts/03-prompt-chaining.md) — the multi-capability run a trace records.
