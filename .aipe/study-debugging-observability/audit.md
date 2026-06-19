# Pass 1 — the debugging & observability audit

Eight lenses, walked against the real repo. Each lens names what AptKit actually does
with `file:line` grounding, or emits `not yet exercised` honestly. Significant findings
cross-link to a Pass 2 pattern file rather than restating it.

The through-line: AptKit is a single-process LLM-agent toolkit with no production
deployment. So the audit measures it against *development-time* debugging and
observability — reproducing a run, seeing what the agent did, attributing cost — not
production SRE concerns. Where a lens only makes sense under scale and distribution,
it's `not yet exercised`, and that's the correct verdict, not a gap to apologize for.

## 1. observability-map — what can be observed at each boundary

The evidence map is unusually clean because there is exactly one observability
primitive, and every boundary reports through it.

```
  Boundaries and what each emits

  ┌─ agent loop ──────┐   each turn → model_usage; assistant text → step
  │ run-agent-loop.ts │
  └────────┬──────────┘
           │
  ┌─ tool call ───────┐   start → tool_call_start (args)
  │ tools.callTool()  │   end   → tool_call_end (result | error, durationMs)
  └────────┬──────────┘
           │
  ┌─ provider ────────┐   fallover → warning; context overflow → warning;
  │ fallback / guard  │   adapter throw → error / exception
  └────────┬──────────┘
           │
  ┌─ run boundary ────┐   whole run → artifact JSON (trace[] + eval + durationMs)
  │ replay artifact   │
  └───────────────────┘
```

Concretely:
- **Inside a turn:** `run-agent-loop.ts:111-129` emits `model_usage` (tokens, provider,
  model) and `step` (assistant text). You can see what the model said and what it cost.
- **At a tool call:** `run-agent-loop.ts:147-179` brackets every call with
  `tool_call_start` (args) and `tool_call_end` (result, error, `durationMs`). You can
  see which tools ran, with what arguments, returning what, in how long.
- **At the provider boundary:** `fallback-provider.ts:77-84` and
  `context-window-guard.ts:61-67` emit `warning` events explaining degradation.
- **At the run boundary:** the replay artifact (`artifacts/replays/*.json`) captures the
  entire `trace` array plus the verdict.

The one observability *gap* at a boundary: tool execution latency is captured
(`durationMs` on `tool_call_end`), but the *model* call's wall-clock latency is not a
field on `model_usage` — only token counts are. Per-turn model latency is inferable
from event `timestamp` deltas (Studio does exactly this in `components.tsx:404-415`,
computing `elapsedMs` from min/max timestamps), but it isn't a first-class field.
→ deep walk in `01-structured-trace-events.md`.

## 2. reproduction-and-evidence — minimal repro, hypotheses, controlled experiments

This is AptKit's strongest lens, and it's the whole point of the replay system.

A run produces a **replay artifact** — a single JSON file holding the full trace, the
eval verdict, `durationMs`, `modelTurns`, the provider/fixture used, and the output.
That file *is* the minimal reproduction: re-running the fixture deterministically
reproduces the exact trace. See
`artifacts/replays/2026-06-18T18-37-26-958Z-sp-revenue-monitoring-fixture-studio.json`
— three `model_usage` turns, two tool calls, one `step` with the final anomaly JSON,
`eval.ok: true`, `modelTurns: 3`.

The controlled-experiment seam is the **mode switch**: the same fixture can run against
`fixture` (recorded responses, deterministic), `openai`, or `anthropic` providers
(`vite.config.ts:531-571`, `runReplay`). Hold the input fixed, swap the provider, diff
the traces — that's a controlled experiment on model behavior. `FixtureModelProvider`
replays recorded `ModelResponse[]` so the *tool loop* and *output shape* are reproduced
byte-for-byte without spending tokens.

The hypothesis-test loop appears inside the agents themselves too (the diagnostic agent
records `hypothesesConsidered` with `supported` flags), but that's agent-architecture
territory; here the relevant fact is that the trace + artifact let you *re-run a
hypothesis* deterministically.
→ deep walk in `02-replay-artifact-as-snapshot.md`.

## 3. structured-logs-and-correlation — events, levels, context, correlation, redaction

Structured: **yes, fully.** Levels: **no.** Correlation: **partial.** Redaction:
**a guard, not redaction.**

- **Structured events** — `CapabilityEvent` (`events.ts:1-24`) is a discriminated union;
  each arm has typed fields. This is the opposite of free-text logging. Searchable
  fields exist by construction: `type`, `capabilityId`, `toolName`, `provider`,
  `model`, `durationMs`, `timestamp`. Studio filters on `type`
  (`components.tsx:419-423`: `all | model | tools | warnings`).
- **No log levels** — there's no `debug`/`info`/`warn`/`error` severity gating. The
  closest is the event `type` itself (`warning`, `error` are arms). Every event is
  emitted unconditionally; no sampling. `not yet exercised` as conventional log levels.
- **Correlation** — every event carries `capabilityId` (e.g. `anomaly-monitoring-agent`),
  which ties a stream of events to one capability. But there is **no per-run or
  per-request ID** on the events themselves; runs are separated by being in different
  artifacts / different in-memory arrays, not by a correlation field. If two runs
  interleaved in one stream, you could not separate them by ID. At single-process
  toolkit scale this is fine, but it's the honest limit of the correlation story.
- **Redaction** — there's no redaction *of* events, but there is a **secret-scan** that
  blocks artifacts containing secret-like strings from being treated as valid:
  `assertions.ts:397-411` (`findSecretLikeString`) rejects anything matching
  `sk-[A-Za-z0-9_-]{10,}` or `OPENAI_API_KEY=`. The promotion path also ASCII-strips
  output (`vite.config.ts:1444-1451`). So the posture is "detect and refuse," not
  "redact and continue."
→ deep walk in `01-structured-trace-events.md` and `06-eval-as-embedded-evidence.md`.

## 4. metrics-slis-slos-and-alerts — signals, SLIs, SLOs, alerts, thresholds

Signals: **yes, derived from the trace.** SLIs/SLOs/alerts: **not yet exercised.**

The metrics are all *derived*, never separately instrumented (`usage-ledger.ts`):
- `summarizeUsage(trace)` (`:25-42`) — folds `model_usage` events into
  `{ inputTokens, outputTokens, totalTokens, turns, estimated }`.
- `modelTurnCount(trace)` (`:45-47`) — counts model turns even when token fields are
  absent.
- `estimateCost(provider, usage, model)` (`:50-68`) — tokens → USD via
  `pricingForModel` (`:71-78`).

These are real signals: tokens-per-run, cost-per-run, turns-per-run, tool-calls-per-run,
elapsed-ms-per-run (Studio computes the last from timestamps, `components.tsx:404-415`).
But there is **no SLI/SLO framing** (no "p95 latency target," no "error budget"), **no
alerting**, and **no thresholds** that fire. The cost-pricing table is also
incomplete: `pricingForModel` only covers `gpt-4.1-*` and returns `undefined` for
Anthropic and everything else (`:71-78`), so cost for non-OpenAI runs is silently
`n/a`. That's a known limitation noted in the project context.
→ deep walk in `03-usage-metrics-ledger.md`. Budget/latency framing is
`study-performance-engineering`'s territory.

## 5. traces-and-request-lifecycles — request lifecycles, spans, causal chains, latency

Lifecycles: **yes, one process.** Spans across services: **not yet exercised.**

The full lifecycle of an agent run is a trace: `model_usage` → (`step`) →
`tool_call_start` → `tool_call_end` → `model_usage` → … → final `step`. The causal
chain is visible because events are emitted in execution order and timestamped. You can
read the artifact above and reconstruct: model decided to call `get_metric_timeseries`,
it returned in 0ms (fixture), model decided to call `get_anomaly_context`, it returned,
model emitted the final anomaly JSON. That's a complete causal trace of the reasoning.

Latency attribution is partial:
- **Tool latency** is first-class: `tool_call_end.durationMs` (`run-agent-loop.ts:159`,
  measured by `tools.callTool` returning `durationMs`).
- **Per-turn model latency** is not a field, but is recoverable from `timestamp` deltas.
- **Whole-run latency** is `durationMs` on the artifact (`runReplay` `:569`,
  `Date.now() - startedAt`).

What's absent: **distributed spans.** There is no OpenTelemetry, no parent/child span
IDs, no trace propagation across process or service boundaries — because there are no
service boundaries. Everything is one process. `not yet exercised`, correctly.
→ deep walk in `01-structured-trace-events.md` and `04-live-trace-stream.md`.

## 6. state-snapshots-and-debugging-boundaries — state inspection, before/after

This is the second-strongest lens, and it's the replay artifact again, viewed as a
*snapshot* rather than a reproduction.

The artifact is a complete state snapshot of one run: every tool's input args and
output result are embedded in the trace (`tool_call_start.args`,
`tool_call_end.result`), the final model output is in the capability-specific field
(`anomalies` / `recommendations` / `diagnosis` / `answer`), and the verdict is in
`eval`. You can inspect the entire state of a finished run without re-running it.

The **before/after** boundary is the **promote-to-fixture** flow: a replay artifact gets
promoted into a deterministic fixture (`vite.config.ts:1306-1368`,
`promoteCapabilityReplayArtifact`), which captures the final answer and derived
behavioral expectations. The promoted fixture is the "known-good before" that future
runs are diffed against. The trace's tool results become the "captured state" that the
fixture replays. The promotion is deliberately lossy and says so in its own
`promotion.note`: it captures the final answer, *not* the live tool loop
(`vite.config.ts:1352`).

Network traces / error output: the `tool_call_end.error` field and the `error` event
arm capture tool and provider failures; the `truncate` at `run-agent-loop.ts:52-57`
caps embedded tool results at 16,000 chars so a huge tool response can't blow up the
snapshot.
→ deep walk in `02-replay-artifact-as-snapshot.md`.

## 7. incident-analysis-and-prevention — root cause, remediation, regression guards

There is no production, so "incident" means *a run that produced wrong or malformed
output during development.* AptKit's answer is the replay-eval-promote loop, and it
doubles as the prevention mechanism.

```
  The local "incident" loop — debug, then prevent regression

  bad run  ──►  artifact (trace + eval)  ──►  inspect trace, find root cause
                                                      │
                                            fix prompt / tool / agent
                                                      │
                                            re-run fixture deterministically
                                                      │
                                            eval.ok? ──► promote to fixture
                                                      (regression guard for next time)
```

- **Root cause** — the embedded trace shows exactly where a run went wrong: a
  `tool_call_end.error`, a `warning` from fallback, a `step` with malformed JSON.
- **The verdict** — every artifact carries `eval { name, ok, issues }`
  (`runReplay` `:561-570` sets it from `assertRecommendationShape`; the monitoring/
  diagnostic/query runs set their own). `eval.issues` names *what* failed the shape
  check.
- **Regression guard** — promoting the fixed run to a fixture
  (`vite.config.ts:1306-1368`) plus the auto-derived behavioral expectations
  (`monitoringExpectationsFromAnomalies` `:1370-1378`, etc.) means the *same* failure
  is caught next time. The eval-replay CLI (`scripts/eval-replay-artifacts.mjs`) runs
  the shape + secret checks over every saved artifact.

What's missing is anything *runbook*-shaped: no documented "when X fails, do Y," no
postmortem template, no on-call rotation — because there's no production surface to
run a book against. `not yet exercised` as formal incident management.
→ deep walk in `06-eval-as-embedded-evidence.md`. The testing mechanics
(fixtures, structural-diff, detection-scorer) belong to `study-testing`.

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by consequence for someone debugging this repo today.

**1. No per-run correlation ID on events (medium).**
Events carry `capabilityId` but no run/request ID (`events.ts:1-24`). In-memory and
per-artifact separation works *because* runs don't interleave in one stream today. The
moment two runs share a sink — concurrent Studio sessions, a future server that handles
two requests at once — you cannot separate their events by field. Evidence: the
`onEvent` callback in `runReplay` (`vite.config.ts:539-544`) pushes into one array per
run; correctness depends on one run per array. The fix when it matters: add a `runId`
to the event envelope.

**2. Cost metrics silently incomplete for non-OpenAI models (medium).**
`pricingForModel` (`usage-ledger.ts:71-78`) returns `undefined` for any provider that
isn't `openai`, and only knows `gpt-4.1-*`. An Anthropic run reports `cost: n/a`
(`formatCost` `:81-86`) with no warning that pricing is simply missing. A reader
glancing at the Studio cost panel could mistake "we don't have the price" for "this run
was free." Fix: add Anthropic pricing, and surface "pricing unknown" distinctly from
"$0.00."

**3. Per-turn model latency is not a first-class field (low).**
`model_usage` carries tokens but not the call's wall-clock duration
(`events.ts:13-22`). Tool latency *is* first-class (`tool_call_end.durationMs`). So
"which turn was slow" requires reconstructing from `timestamp` deltas, and if two
events share a timestamp (they do in fast fixture runs — see the sample artifact where
all events share `...26.955Z`) the deltas collapse to zero. Fix: add `durationMs` to
`model_usage`.

**4. Trace results truncated at 16k chars without a marker in metrics (low).**
`run-agent-loop.ts:52-57` truncates tool results fed back to the model at 16,000 chars
with a `...[truncated]` suffix in the *model's view*, but the trace's
`tool_call_end.result` stores the full object. The two can diverge: the model reasoned
over a truncated result while the snapshot shows the full one. A debugger trusting the
snapshot might not realize the model saw less. Low because it only bites on very large
tool outputs.

**5. No backpressure / bound on the live event array (low).**
`AgentReplayShell.tsx:114-116` appends every streamed event to React state unbounded.
A pathological run with thousands of events would grow the array without limit. At
current agent scale (`maxTurns` default 8, `run-agent-loop.ts:87`) this is purely
theoretical, but it's the kind of thing that bites once an agent loop is uncapped.

The honest summary: AptKit's observability is *high-fidelity but single-tenant.* The
red flags are almost all "this assumes one run at a time in one process" — which is
true today and is the right scope for a toolkit, but is exactly what would need
hardening the first time this runs as a real multi-request service.
