# Overview — the evidence map

AptKit has a genuinely strong observability story for an LLM system, and it all hangs
off one decision: **every agent action emits a typed, timestamped event.** Not a log
line you grep later — a discriminated-union record (`CapabilityEvent`) with a known
shape per event type. That one choice is why the repo can do everything else here:
derive token/cost metrics, stream a live dashboard, snapshot a whole run to a file,
and replay it deterministically.

Here's the whole evidence pipeline in one frame. Read it top to bottom — it's the
spine every pattern file walks a slice of.

```
  The AptKit observability pipeline — emit → sink → fan-out

  ┌─ Runtime layer (packages/runtime) ─────────────────────────────────┐
  │                                                                     │
  │   runAgentLoop()  ── each turn / tool call ──►  trace.emit(event)   │
  │                                                       │             │
  │                          CapabilityEvent: step | tool_call_start |  │
  │                          tool_call_end | model_usage | warning |    │
  │                          error   (events.ts)                        │
  └───────────────────────────────────────────────────────┬───────────┘
                                                            │ one event
                              ┌─────────────────────────────┼──────────────────────┐
                              ▼                              ▼                       ▼
  ┌─ in-memory array ──────────┐   ┌─ NDJSON over HTTP ──────────┐   ┌─ derived metrics ────┐
  │ trace: CapabilityEvent[]   │   │ encodeNdjsonRecord(event)   │   │ summarizeUsage(trace) │
  │ → embedded in the artifact │   │ → /api/stream/replay        │   │ estimateCost(...)     │
  │   (replay snapshot JSON)   │   │ → Studio TracePanel (live)  │   │ modelTurnCount(...)   │
  └─────────────┬──────────────┘   └─────────────────────────────┘   └──────────────────────┘
                │ persisted
                ▼
  ┌─ artifacts/replays/*.json ──────────────────────────────────────────┐
  │ { capabilityId, durationMs, provider, trace[], eval{ok,issues},      │
  │   modelTurns, <output> }   ← reproduction + evidence in one file     │
  └──────────────────────────────────────────────────────────────────────┘
```

## Ranked findings — what to look at first

**1. The trace event is the load-bearing observability primitive.**
`packages/runtime/src/events.ts:1-24` defines `CapabilityEvent` as a six-arm
discriminated union. `run-agent-loop.ts` emits one at every consequential moment:
`model_usage` after each completion (`:111-122`), `step` for assistant text
(`:128`), `tool_call_start` / `tool_call_end` around each tool call (`:147-179`,
note `durationMs` on the end event). Strip this out and the system can no longer
explain *anything* about a run — not which tool failed, not where the tokens went,
not why it stopped. Everything else in this guide reads from this stream.
→ `01-structured-trace-events.md`.

**2. The replay artifact is reproduction and evidence in one file.**
`artifacts/replays/*.json` embeds the full `trace` array plus `eval`, `durationMs`,
`modelTurns`, the provider, the fixture reference, and the capability output. Open
`artifacts/replays/2026-06-18T18-37-26-958Z-sp-revenue-monitoring-fixture-studio.json`
and you can replay the exact monitoring run that produced it — the model turns, the
two tool calls, the final JSON. This is the repo's answer to "incidents": there's no
production, so a debugging session *is* opening a saved artifact and re-running it.
→ `02-replay-artifact-as-snapshot.md`.

**3. Metrics are derived from the event stream, not separately instrumented.**
`usage-ledger.ts:25-47` folds the `model_usage` events into one usage row
(`summarizeUsage`) and counts turns (`modelTurnCount`); `estimateCost` (`:50-68`)
turns tokens into USD. There is no second metrics pipeline — the trace *is* the
metrics source. That's the right call for a single-process toolkit, and it's why
the Studio token/cost counters and the CLI eval report agree by construction.
→ `03-usage-metrics-ledger.md`.

**4. The same events stream live to a dashboard.**
`ndjson-stream.ts` encodes each event as one NDJSON line (`encodeCapabilityEvent`,
`:36-38`) with a runtime guard (`isCapabilityEvent`, `:41-62`). Studio's
`/api/stream/replay` route (`vite.config.ts:385-396`, `streamReplayResponse`
`:887-918`) writes each event as it's emitted, and `AgentReplayShell.tsx:114-119`
appends them to React state so the trace fills in *while the run is happening*.
→ `04-live-trace-stream.md`.

**5. Degradation is explained, not silent.**
When a provider fails over, `fallback-provider.ts:77-84` emits a `warning` trace
naming which provider failed and why. When the local context guard skips a model
because the prompt won't fit, `context-window-guard.ts:61-67` emits a `warning` with
the token estimate. Studio surfaces these specifically (`components.tsx:360-362`
matches fallback warnings by regex). Without these, a slower/cheaper-than-expected
run would be an unexplained mystery.
→ `05-degradation-warning-traces.md`.

## What's `not yet exercised`

Be honest: this is a pre-production toolkit. Several standard production-observability
mechanisms are absent, and that's appropriate for where the project is.

- **Log aggregation / logging library** — no `winston`, `pino`, `console`-logger, or
  log levels. The `CapabilityEvent` stream *is* the log. There's no separate logger to
  ship to a backend. `not yet exercised`.
- **Distributed tracing** — no OpenTelemetry, no spans crossing services, no trace
  context propagation. Everything runs in one Node process (or one Vite dev server).
  `capabilityId` is the only correlation key, and it's per-capability, not per-request.
  `not yet exercised`.
- **Metrics backend** — no Prometheus, StatsD, or Grafana. Metrics live in memory and
  in the artifact JSON; nothing scrapes or stores time-series. `not yet exercised`.
- **Alerting** — no thresholds, no paging, no anomaly alerts on the *system itself*
  (the agents detect anomalies in customer data; nothing watches the agents).
  `not yet exercised`.
- **Error tracking** — no Sentry/Rollbar. Errors become `error` trace events and
  thrown exceptions; nothing aggregates them across runs. `not yet exercised`.
- **Incident runbooks / on-call** — no production, so no incidents in the SRE sense.
  "Incident analysis" here = local debugging via replay. `not yet exercised` as a
  formal practice; the replay loop is the de-facto substitute.
- **Log levels / sampling** — every event is emitted unconditionally; there's no
  `debug`/`info`/`warn` gating and no sampling. Fine at toolkit scale. `not yet
  exercised`.

The takeaway: AptKit over-indexes on the parts that matter for an LLM system you're
*debugging by hand* — full-fidelity traces, deterministic replay, derived
cost/token metrics — and skips the parts that only pay off under production scale and
distribution. Read `audit.md` next for the lens-by-lens walk.
