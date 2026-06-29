# Audit — Debugging & Observability (8 lenses)

Pass 1. Each lens is walked against the live repo. Findings are grounded in
`file:line`; where a lens finds nothing, it says `not yet exercised` and names
when it would matter. Significant mechanisms cross-link to their Pass 2 file.

---

## 1. observability-map — what can be observed at each boundary

The evidence is concentrated in one place: the structured event log (the
`CapabilityEvent` trace). Every important boundary of an agent run emits an
event into it.

```
  What each boundary can be observed emitting

  boundary                     event emitted              where
  ──────────────────────────   ─────────────────────────  ───────────────────────
  model turn completes      →  model_usage (tokens)       run-agent-loop.ts:111-122
  assistant produces text   →  step (role, content)       run-agent-loop.ts:127-129
  tool invocation begins    →  tool_call_start (args)     run-agent-loop.ts:147-153
  tool invocation ends      →  tool_call_end (result,     run-agent-loop.ts:171-179
                                  error, durationMs)
  recovery turn fails       →  warning (message)          run-agent-loop.ts:220-225
  (zero-hit retrieval)      →  ⌀ NOTHING — silent          see lens 8
```

The boundaries that emit nothing are as important as the ones that do. A
retrieval that returns zero hits passes through `search_knowledge_base`
(`packages/retrieval/src/search-knowledge-base-tool.ts:92-95`) and produces a
`tool_call_end` with an empty `results` array — observable only if you read the
result payload, never surfaced as a `warning`. That gap is lens 8's headline.

The map has three reading surfaces hung off the one emitter — Studio (visual),
the usage ledger (cost), and buffr's Postgres sink (durable). →
`01-capability-event-trace.md` for the spine; `02-trace-fan-out-three-consumers.md`
for the three readers.

## 2. reproduction-and-evidence — minimal repro, hypotheses, controlled experiments

Reproduction is the repo's strongest debugging asset. The whole evaluation
backbone is built on **deterministic replay**: a recorded `ModelResponse[]` is
fed back through `FixtureModelProvider` so a run reproduces byte-for-byte
without touching a live model
(`packages/agents/recommendation/src/fixture-provider.ts`, replayed by
`scripts/replay-promoted-fixtures.mjs`). A bug found in a live run can be frozen
into a fixture and re-run on demand — the controlled experiment is free.

The evidence collected per run is the trace plus the replay artifact
(`artifacts/replays/*.json`), which carries `capabilityId`, `durationMs`,
`provider`, `fixture`, the output, the full `trace`, the `eval`, and
`modelTurns`. That artifact is both the evidence and the reproduction seed. →
`05-deterministic-replay-reproduction.md`.

## 3. structured-logs-and-correlation — events, levels, context, redaction, searchable fields

The trace *is* the structured log — there is no separate logging system, and
that's the right call here. Each `CapabilityEvent` is a typed record with a
discriminant (`type`), a `capabilityId` for context, and an ISO `timestamp`
(`packages/runtime/src/events.ts:1-24`). When streamed, events serialize as
NDJSON — one JSON object per line — via `encodeCapabilityEvent`
(`packages/runtime/src/ndjson-stream.ts`), the searchable line-oriented format.

Correlation: within a run, every event carries the same `capabilityId`, so a
single run's events group cleanly. In buffr, the durable rows additionally
carry a `conversation_id` (`/Users/rein/Public/buffr/src/supabase-trace-sink.ts:27-36`),
which is the cross-run correlation key — all messages for one conversation
share it.

**Levels:** there is no `debug`/`info`/`warn`/`error` severity ladder. The
closest is the event *type* — `warning` and `error` are distinct variants. Fine
for now; a real level system matters only when log volume forces filtering.

**Redaction:** `not yet exercised` as an explicit mechanism. There is no field
redaction in the trace path — tool args and results are persisted verbatim
(`supabase-trace-sink.ts:62-71`). The repo's discipline is upstream: `.env`
holds provider keys and is gitignored, and the project notes warn never to echo
secrets into artifacts. But if a tool ever received PII in its args, the trace
would persist it unredacted. Relevant the moment a tool handles user-identifying
input. → `02-trace-fan-out-three-consumers.md` for the NDJSON serialization.

## 4. metrics-slis-slos-and-alerts — signals, indicators, objectives, thresholds

`not yet exercised` as a metrics system. There is **no** Prometheus,
OpenTelemetry, StatsD, Datadog, or counter/gauge/histogram instrumentation in
either repo (grep confirms zero hits). No SLIs, no SLOs, no alert thresholds,
no paging.

What exists instead are two per-run *signals* derived from the trace, not
aggregated metrics:

- **Token usage** — `summarizeUsage(trace)` folds all `model_usage` events into
  one `{ inputTokens, outputTokens, totalTokens, turns }` row
  (`packages/runtime/src/usage-ledger.ts:25-42`). This is the SLI-shaped signal
  closest to existing: tokens-per-run.
- **Cost** — `estimateCost` turns that into USD, but only for `gpt-4.1*` models
  (`usage-ledger.ts:71-78`); every other provider returns `undefined`. A
  partial signal.
- **Latency** — `durationMs` per tool call (`tool_call_end`) and `durationMs`
  per whole run (replay artifact). Per-run, not aggregated.

These are diagnostic evidence, not monitoring. The measurement-and-budget
treatment of these same signals belongs to `study-performance-engineering`; this
guide only notes they exist as evidence. A metrics system becomes relevant when
the toolkit runs as a service with aggregate behavior worth watching.

## 5. traces-and-request-lifecycles — request lifecycles, spans, causal chains, latency attribution

There is a **trace** in the event-log sense (the `CapabilityEvent` stream), but
**no distributed tracing**: no spans, no parent/child span relationships, no
`traceId` propagation across services (grep confirms). The agent loop is a
single process; there is no second service to correlate to.

The causal chain *is* recoverable from the event log, and this is the
load-bearing diagnostic capability. The events are ordered, and the loop emits
them in a fixed lifecycle per turn: `model_usage` → `step` → (`tool_call_start`
→ `tool_call_end`)\* → next turn (`run-agent-loop.ts:98-190`). Reading that
order forward gives you the request lifecycle; reading it *backward* gives you
root-cause analysis (lens 7). Latency attribution exists at the tool granularity
via `durationMs` per `tool_call_end` — you can see which tool call was slow, not
why. → `01-capability-event-trace.md` for the lifecycle shape.

## 6. state-snapshots-and-debugging-boundaries — state inspection, error output, before/after

The replay artifact is a full state snapshot of a run: input fixture, every
model turn, the complete trace, the output, and the eval result, frozen as JSON
in `artifacts/replays/` (project context, Data model). That's a complete
before/after — you can diff two artifacts to see what a code change did to a
run's trajectory.

Studio is the interactive state inspector. `AgentReplayShell`
(`apps/studio/src/AgentReplayShell.tsx`) accumulates events into a `liveTrace`
during a streamed run and renders them through `TracePanel`
(`apps/studio/src/components.tsx`), where each event expands to show its full
payload — tool args, results, errors, step text. This is the dev-time
state-inspection boundary: the trace rendered as an explorable tree rather than
a log to scroll. Error output: tool errors are captured per call into
`toolCall.error` (`run-agent-loop.ts:163-168`) and ride along in `tool_call_end`,
so a thrown tool surfaces as a visible event rather than crashing the run. →
`02-trace-fan-out-three-consumers.md`.

## 7. incident-analysis-and-prevention — root cause, remediation, regression guards, runbooks

The repo has one documented incident with a clean root-cause-to-prevention arc —
the signature war story.

```
  The incident arc

  symptom    agent answers "not available" on a good corpus
     │
  evidence   read the persisted trajectory BACKWARD:
     │         answer ← empty tool_result ← tool_call_start args
     ▼
  root cause Gemma passed a hallucinated {textContains} filter;
     │       the exact-match filter zeroed every result
     ▼
  fix        matchesFilter() now ignores filter keys absent
     │       from a chunk's meta (search-knowledge-base-tool.ts:101-106)
     ▼
  prevention regression test: hallucinated filter must not wipe
             results (search-knowledge-base-tool.test.ts:105-117)
```

The remediation is two-part: the filter hardening (`matchesFilter`) plus a
`minTopK` floor that stops a weak model starving its own retrieval by passing
`top_k: 1` (`search-knowledge-base-tool.ts:51,81`; test at lines 77-89). The
regression guard is real and lives next to the code. There is **no runbook
document** — the knowledge is in the code comments and the test names, not a
written incident playbook. → `04-reading-the-trajectory-backward.md` for the
method, `06-hallucination-tolerant-retrieval-guard.md` for the fix and guard.

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by diagnostic consequence — the cost of *not* being able to see
something when it breaks.

**1. Empty retrieval is silent (highest consequence).** A zero-hit
`search_knowledge_base` call emits no `warning`; it returns an empty array that
looks identical to any other result in the trace
(`search-knowledge-base-tool.ts:92-95`). Evidence: there is no `warning`/`error`
emission anywhere in `packages/retrieval/src` (grep confirms). This is the exact
blind spot the war story exposed — the incident was findable only *after* a user
complaint, by reading the trajectory backward. The unbuilt fix is a one-line
zero-hit `warning` event that would surface the failure the instant it happens.
→ `06-hallucination-tolerant-retrieval-guard.md`.

**2. Cost signal is partial.** `estimateCost` returns `undefined` for every
provider except OpenAI's `gpt-4.1*` (`usage-ledger.ts:71-78`). The default
runtime provider is local Gemma and a common cloud provider is Anthropic —
neither is priced. A run can look "free" in the cost display when it wasn't.

**3. No redaction on the persist path.** Tool args and results are written
verbatim to `agents.messages` (`supabase-trace-sink.ts:62-71`). Today the tools
are read-only analytics tools, so the exposure is low — but the *mechanism* to
redact a sensitive field before persistence does not exist. A blind spot that
activates the moment a tool touches user-identifying data.

**4. Latency attribution stops at the tool boundary.** `durationMs` tells you
*which* tool call was slow, never *why* (no spans inside a tool, no provider
round-trip timing as its own event). Acceptable at this scale; a real limit once
a single tool fans out internally.

**5. No timeout-as-event.** The loop can be aborted via `AbortSignal`
(`run-agent-loop.ts:99`) but a slow-then-aborted call doesn't emit a
distinguishable "timed out" event. A hang and a normal slow call read the same
in the trace.
