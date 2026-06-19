# Replay artifact as snapshot

*Industry name(s): record-and-replay / golden-run capture / state-snapshot debugging.
Type label: Project-specific (the artifact schema is AptKit's; the technique is
industry-standard).*

## Zoom out, then zoom in

You know how a browser's "Save HAR" gives you a single file that captures every request
of a page load, so you can hand it to someone and they see exactly what happened? The
replay artifact is that for an agent run — one JSON file holding the entire run, so you
can reproduce it, inspect it, and diff it without re-spending tokens.

```
  Zoom out — where the artifact lives

  ┌─ Studio UI layer ───────────────────────────────────────────┐
  │  Run button → POST /api/replay → result shown                │
  └───────────────────────────────▲──────────────────────────────┘
                                   │  saved on demand
  ┌─ Persistence layer ─────────────────────────────────────────┐
  │  ★ artifacts/replays/*.json ★   trace[] + eval + durationMs  │ ← we are here
  │  promote ──► fixtures/promoted/*.json (regression baseline)  │
  └───────────────────────────────▲──────────────────────────────┘
                                   │  produced by
  ┌─ Runtime layer ─────────────────────────────────────────────┐
  │  runReplay() runs the agent, collects trace, runs eval       │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **capture the whole run as one self-contained record.** Not just
the output — the output *plus* the trace that produced it *plus* the verdict on whether
it's correct *plus* the timing. The question it answers: *can I reproduce and inspect
this exact run later, without the model and without guessing what happened?*

## The structure pass

**Layers.** Two that matter: the *live run* (non-deterministic if it hits a real
provider) and the *captured artifact* (frozen, deterministic to re-read). The seam
between them is the act of writing the JSON.

**One axis — "is this deterministic?"** Trace it across the run's lifecycle:

```
  axis = "is this reproducible byte-for-byte?"

  ┌─ live OpenAI/Anthropic run ─┐  NO — model output varies per call
  └──────────────┬──────────────┘
                 │  seam: save artifact (freezes the run)
  ┌─ saved artifact ────────────┐  YES — re-reading the JSON is deterministic
  └──────────────┬──────────────┘
                 │  seam: promote to fixture (freezes the responses)
  ┌─ fixture replay ────────────┐  YES — re-RUNNING is deterministic too
  └─────────────────────────────┘
```

**The two seams are load-bearing.** Saving the artifact flips "re-*reading* is
deterministic." Promoting to a fixture flips "re-*running* is deterministic," because the
recorded `ModelResponse[]` replace the live model. The promotion is deliberately lossy —
it captures the final answer, not the live tool loop — and the artifact's own
`promotion.note` says so (`vite.config.ts:1352`). That honesty is the whole reason the
seam is trustworthy.

## How it works

### Move 1 — the mental model

Think of it as a JSON envelope with three things glued together: *what came out*, *how it
got there*, and *whether it's right*. The output is the answer; the trace is the
recording; the eval is the verdict.

```
  The pattern — one run, captured as three glued layers

  ┌──────────────────────────────────────────────┐
  │  replay artifact (one .json file)              │
  │                                                │
  │  WHAT CAME OUT ── anomalies | recommendations |│
  │                   diagnosis | answer           │
  │                                                │
  │  HOW IT GOT THERE ── trace: [ model_usage,     │
  │                       tool_call_start,         │
  │                       tool_call_end, step, ... ]│
  │                                                │
  │  WHETHER IT'S RIGHT ── eval: { ok, issues }     │
  │                                                │
  │  + metadata: capabilityId, createdAt,          │
  │    durationMs, provider, fixture, modelTurns   │
  └────────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**The output field — capability-shaped.** Each capability writes its own output key:
`anomalies` for monitoring, `recommendations` for recommendation, `diagnosis` for
diagnostic, `answer` for query. Bridge: it's the response body of the run. What breaks
without it: the artifact records *how* but not *what* — you'd see the tool calls but not
the conclusion they led to.

**The trace array — the recording.** This is the `CapabilityEvent[]` from
`01-structured-trace-events.md`, frozen in order. Every tool's `args` and `result` are
embedded, so you can inspect exactly what each tool returned. Bridge: the HAR file's
list of requests, except these are model turns and tool calls.

```
  Trace inside the artifact — execution order preserved

  trace[0]  model_usage   (turn 1: 900 in / 80 out tokens)
  trace[1]  tool_call_start  get_metric_timeseries(args)
  trace[2]  tool_call_end    get_metric_timeseries → {periodComparison...} 0ms
  trace[3]  model_usage   (turn 2)
  trace[4]  tool_call_start  get_anomaly_context(args)
  trace[5]  tool_call_end    get_anomaly_context → {anomaly_summary...} 0ms
  trace[6]  model_usage   (turn 3)
  trace[7]  step             ```json [{ "category":"revenue_drop", ... }]```
            │
            └─ read top-to-bottom = the agent's reasoning, reproduced exactly
```

**The eval block — the verdict.** `{ name, ok, issues }`. `ok: true` means the output
passed its shape check; `issues` names what failed if not. Bridge: the green/red of a
test, embedded in the data. What breaks without it: you'd have to re-derive correctness
every time you opened the artifact; instead the verdict travels *with* the evidence.

**The metadata — the provenance.** `provider` (id + model), `fixture` (id +
description + path), `createdAt`, `durationMs`, `modelTurns`, `schemaVersion`. Bridge:
the headers of the recording — who produced it, when, against what input, how long it
took. The `fixture.path` is the load-bearing one for reproduction: it points at the
source fixture so the run can be re-created.

**The promote step — turning a snapshot into a guard.** A good artifact can be promoted
into a deterministic fixture under `fixtures/promoted/`. The promotion captures the
final answer as a recorded `ModelResponse`, derives behavioral expectations from the
output (e.g. `monitoringExpectationsFromAnomalies`), and writes a `promotion` block with
the source artifact and the honest note that it does *not* reconstruct the live tool
loop. Bridge: "save this passing run as a regression test." What breaks without it: every
fix is a one-time inspection with no guard against the same break recurring.

### Move 2 variant — the load-bearing skeleton

```
  the kernel:  output + trace + eval + fixture-reference, in one file
```

- **Drop the `trace`** → you have the answer and the verdict but no *why*; you can't
  debug a wrong answer, only observe that it's wrong.
- **Drop the `eval`** → you have a recording with no verdict; correctness must be
  re-judged on every read.
- **Drop the `fixture` reference** → you can read the run but can't reproduce it; the
  snapshot is a photo, not a save-state.
- **Drop the `output`** → the recording leads nowhere; no conclusion to check the trace
  against.

**Skeleton vs hardening:** the four above are the skeleton. `durationMs`, `modelTurns`,
`schemaVersion`, the secret-scan, the ASCII-stripping on promotion — hardening. The
artifact is still a reproducible snapshot without them.

### Move 3 — the principle

The principle is **make the run a value.** Once a run is a self-contained, inspectable,
re-runnable file, debugging stops being "reproduce the conditions and hope it happens
again" and becomes "open the file." For a non-deterministic system — and an LLM is the
most non-deterministic thing you'll instrument — capturing the run as a frozen artifact
is the only way to debug it twice the same way. The promote step then converts that
frozen evidence into a regression guard, so a debugging session permanently improves the
test suite.

## Primary diagram

The full lifecycle: live run → artifact → inspect/replay → promote → guard.

```
  Replay artifact lifecycle — capture, inspect, prevent

  ┌─ Runtime ──────────┐   runReplay(): run agent, collect trace, run eval
  │ live or fixture run│
  └─────────┬──────────┘
            │ POST /api/replay/save  (Studio, vite.config.ts:364-383)
            ▼
  ┌─ artifacts/replays/<ts>-<fixture>-<provider>.json ──────────────────┐
  │ { output, trace[], eval{ok,issues}, durationMs, modelTurns,          │
  │   provider, fixture{id,path}, createdAt, schemaVersion }             │
  └───────┬──────────────────────────────────────────┬──────────────────┘
          │ re-read = deterministic inspection         │ POST /api/replays/promote
          ▼                                            ▼
  ┌─ debug ───────────────────┐          ┌─ fixtures/promoted/*.json ──────────┐
  │ read trace top-to-bottom, │          │ recorded ModelResponse + derived     │
  │ find root cause           │          │ expectations + promotion note        │
  └───────────────────────────┘          │ → re-RUNNING is now deterministic    │
                                          └──────────────────────────────────────┘
   Network boundary: a live run crosses to the OpenAI/Anthropic provider; the artifact
   freezes everything on THIS side of that boundary so the next read needs no network.
```

## Implementation in codebase

**Use cases in this repo.** Studio's "Run" button against a live provider produces an
artifact you save (`/api/replay/save`). The CLI `eval:replays` scans every artifact in
`artifacts/replays/`. A passing run gets promoted to `fixtures/promoted/` to lock in a
correctness baseline. Debugging a wrong answer = opening the artifact and reading the
trace.

**A real artifact — `artifacts/replays/2026-06-18T18-37-26-958Z-sp-revenue-monitoring-fixture-studio.json`:**

```
  the monitoring snapshot (lines 1-212)

  "capabilityId": "anomaly-monitoring-agent",   ← which capability
  "durationMs": 3,                               ← whole-run latency
  "provider": { "id": "fixture", ... },          ← deterministic source
  "fixture": { "id": "sp-revenue-monitoring",    ← reproduction pointer
               "path": "packages/agents/anomaly-monitoring/fixtures/..." },
  "anomalies": [ { "category": "revenue_drop", "severity": "critical", ... } ], ← OUTPUT
  "trace": [ model_usage, tool_call_start, tool_call_end, ... step ],           ← HOW
  "eval": { "name": "anomaly-shape", "ok": true, "issues": [] },                ← VERDICT
  "modelTurns": 3                                ← derived turn count
        │
        └─ this single file is enough to re-run, inspect, or promote the run.
           The fixture.path makes it reproducible; the trace makes it debuggable;
           the eval makes it judgeable; all without touching a live model.
```

**Where the artifact is built — `apps/studio/vite.config.ts`, `runMonitoringReplay`
(lines 573-614):**

```
  vite.config.ts — assembling the artifact at run time

  :580  const trace: CapabilityEvent[] = [];          ← the recording buffer
  :581  const traceSink = { emit: (e) => { trace.push(e); options.onEvent?.(e); } };
        │                                              └─ tee: collect AND stream live
  :596  const anomalies = await agent.scan();          ← run, producing OUTPUT
  :597  const validation = validateAnomalies(anomalies);  ← the VERDICT source
  :600  return { ..., anomalies, trace,                ← glue output + recording...
  :606    eval: { name:'anomaly-shape', ok:validation.ok, issues }, ← ...+ verdict
  :611    modelTurns: modelTurnCount(trace),           ← derived from the trace
  :612    durationMs: Date.now() - startedAt };        ← whole-run latency
```

The `traceSink` tee at `:581` is the load-bearing detail: the *same* sink both
accumulates the array that becomes `artifact.trace` and fires `onEvent` for the live
stream. One emit, two destinations — the snapshot and the dashboard never disagree.

**The promote path — `promoteCapabilityReplayArtifact` (vite.config.ts:1306-1368):** it
validates the artifact (`adapter.validate`), reads the source fixture by
`artifact.fixture.path`, builds a single recorded `ModelResponse` from the final answer,
derives expectations, and writes the promoted fixture with a `promotion.note` stating it
captures the answer, *not* the live tool loop (`:1352`).

## Elaborate

Record-and-replay is an old idea — `vcr`/`cassette` libraries for HTTP, time-travel
debuggers, deterministic simulation testing. What's specific here is *what* gets
recorded: not the HTTP traffic to the model, but the higher-level `CapabilityEvent`
trace plus the structured output and the eval verdict. That's the right altitude for an
agent system, because the thing you debug is the *reasoning*, not the wire format.

The deliberate lossiness of promotion is worth dwelling on. A live run's fixture replay
re-runs the *whole tool loop* against recorded model responses; a promoted fixture
instead records only the final answer. So a promoted fixture catches "the output shape /
content regressed" but not "the tool-calling path changed." The project context flags
this and the `promotion.note` documents it in the data itself — that's the honest way to
ship a lossy capture: write the lossiness into the artifact. Read `06-eval-as-embedded-
evidence.md` for how the `eval` block is computed and guarded, and `study-testing` for
the fixture/structural-diff machinery the promotion feeds.

## Interview defense

**Q: Why capture the whole run as a file instead of just logging?**
Because an LLM run is non-deterministic, so "reproduce it" means "have the exact run
saved." The artifact bundles output + trace + verdict + a reproduction pointer, so
debugging is "open the file and read the trace," and a passing run can be promoted into
a regression guard.

```
  log line              vs    replay artifact
  "agent finished"            { output, trace[], eval, fixture-ref }
  re-run to debug             re-READ to debug; re-RUN deterministically via fixture
```

Anchor: the sample artifact, `vite.config.ts:600-613`.

**Q: A promoted fixture passes but the live agent broke. How?**
Promotion is lossy by design — it records the final answer, not the tool loop
(`vite.config.ts:1352`). So a change in the *tool-calling path* that still yields the
same final answer won't be caught by the promoted fixture; only a live or full
fixture-loop run catches it. The honesty is baked in: the artifact's own
`promotion.note` says exactly this.

**Q: What's the one field that makes the snapshot reproducible rather than just
readable?**
`fixture.path`. Without it the artifact is a photograph; with it you can re-create the
run from the source fixture. Anchor: the sample artifact line 13.

## Validate

1. **Reconstruct:** name the four skeleton parts of an artifact (output, trace, eval,
   fixture-reference) and what debugging capability each one provides. Check against the
   sample artifact.
2. **Explain:** in `vite.config.ts:581`, the trace sink both pushes to an array and calls
   `onEvent`. Why does that guarantee the saved snapshot and the live dashboard agree?
3. **Apply to a scenario:** a monitoring run reports zero anomalies when it should report
   one. Walk the trace in the sample artifact — which `tool_call_end.result` would you
   check first, and what would `eval.issues` tell you?
4. **Defend the decision:** argue why AptKit promotes only the final answer (lossy)
   rather than the full tool loop, and name the regression class that choice fails to
   catch (`vite.config.ts:1306-1368`).

## See also

- `01-structured-trace-events.md` — the `trace` array's element type.
- `06-eval-as-embedded-evidence.md` — how `eval` is computed and the secret-scan guard.
- `03-usage-metrics-ledger.md` — `modelTurns` and usage derived from the embedded trace.
- `study-testing` — fixtures, structural-diff, detection-scorer (the promotion target).
