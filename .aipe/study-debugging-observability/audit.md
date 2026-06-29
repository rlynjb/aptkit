# Debugging & Observability — the 8-lens audit

Pass 1. One sweep of the codebase against eight observability lenses. Each section names what aptkit actually does (with `file:line` grounding) or says `not yet exercised` and when it would matter. Significant findings cross-link to a Pass 2 pattern file rather than restating it.

The repo under audit: aptkit (a deployment-agnostic agent toolkit) plus its companion runtime buffr (`/Users/rein/Public/buffr`, the laptop body that supplies durable persistence). Where a lens only lights up in buffr, that's named explicitly.

---

## 1. observability-map — what can be observed at each boundary

The evidence map is unusually clean because there's exactly one source of truth: the **CapabilityEvent trace**. Every boundary that matters emits onto it.

```
  Where evidence is emitted — boundary by boundary

  ┌─ boundary ───────────────┬─ event emitted ─────────┬─ file:line ──────────┐
  │ model turn completes     │ model_usage             │ run-agent-loop.ts:112│
  │ assistant produces text  │ step                    │ run-agent-loop.ts:128│
  │ tool invocation begins   │ tool_call_start (+args) │ run-agent-loop.ts:147│
  │ tool invocation ends     │ tool_call_end (+ms,err) │ run-agent-loop.ts:171│
  │ recovery turn fails       │ warning                 │ run-agent-loop.ts:220│
  │ provider fallback fires  │ warning (in provider)   │ rendered in TracePanel│
  └──────────────────────────┴─────────────────────────┴──────────────────────┘
```

What you CAN observe: every model decision, every tool call with its exact arguments and result, per-tool latency, token usage per turn. What you CANNOT observe: anything *inside* a tool handler (no sub-spans), anything across processes (no `traceId`), and — the load-bearing gap — **a retrieval that returned zero hits emits nothing** (`search-knowledge-base-tool.ts:89-91` returns silently). → `01-capability-event-trace.md` for the spine; `04-silent-empty-result-blind-spot.md` for the gap.

## 2. reproduction-and-evidence — minimal repro, hypotheses, controlled experiments

This is a strength. The fixture/replay system turns any live run into a deterministic, offline reproduction. A recorded `ModelResponse[]` (`packages/agents/*/fixtures/*.json`) is replayed by `FixtureModelProvider`, so a bug that only appeared against live Gemma can be re-run in a `node --test` unit with no network. The retrieval war-story bug is reproduced exactly this way — `search-knowledge-base-tool.test.ts:105-117` is a controlled experiment: seed a corpus, fire a hallucinated `{textContains:'moon'}` filter, assert results are non-empty. → `05-deterministic-replay-reproduction.md`.

## 3. structured-logs-and-correlation — events, levels, context, correlation IDs, redaction

Partly exercised, with sharp edges.

- **Structured events: yes.** `CapabilityEvent` is a typed discriminated union (`events.ts:1-24`), serialized as NDJSON (`ndjson-stream.ts:36`). Far better than freetext logs — every record is queryable by `type`.
- **Levels: minimal.** Only `warning` and `error` carry severity; everything else is untyped signal. There's no debug/info/trace gradation.
- **Correlation ID: partial.** Every event carries a `capabilityId` (`events.ts`), which correlates events *within one capability's run*. There is **no** cross-run or cross-process `traceId`/`spanId`. Single-process, single-run — nothing to correlate across yet. `traceId` is `not yet exercised`.
- **Redaction: none in the trace itself.** The loop truncates tool results to 16k chars (`run-agent-loop.ts:52-57`) but does not redact secrets. buffr's persistence stringifies args/results verbatim into `agents.messages` (`supabase-trace-sink.ts:62-71`). `.env` keys never enter the trace (the gemma provider is keyless), so the live exposure is low, but per-field redaction is `not yet exercised`.

→ `01-capability-event-trace.md`.

## 3a. NDJSON decode robustness — a quieter strength worth naming

The stream decoder treats a malformed line as a *bounded warning*, never a throw: `decodeNdjsonLine` returns a `{ok:false, warning}` shape (`ndjson-stream.ts:65-82`), warnings are capped at 25 (`DEFAULT_MAX_WARNINGS`, `:28`), and partial lines are preserved across chunk boundaries (`:103-135`). One corrupt trace line can't crash the replay that's reading it. This is defensive observability plumbing — the channel that carries evidence is itself fault-tolerant.

## 4. metrics-slis-slos-and-alerts — signals, SLIs, SLOs, thresholds

`not yet exercised`. There is no metrics system — no counters, gauges, or histograms, no Prometheus/OpenTelemetry/StatsD/Datadog (a repo-wide grep for these returns nothing). The closest thing is `summarizeUsage()` (`usage-ledger.ts:25-42`), which *folds* a trace into token totals and a turn count *after* the run — a derived summary, not a live metric, and not aggregated across runs. No SLIs, no SLOs, no alert thresholds, no paging. This becomes relevant the moment buffr runs as a long-lived multi-user service instead of a single laptop session. → the summary mechanism itself is taught in `06-model-usage-accounting.md`.

## 5. traces-and-request-lifecycles — request lifecycles, spans, causal chains, latency attribution

Partly exercised — and this is where the vocabulary collides with the codebase, so be precise.

The word "trace" here means the **CapabilityEvent trace**: an ordered event log of one agent run's lifecycle (turn → tool call → turn → final answer). That lifecycle is fully captured and causally readable — you can follow *why* the agent did each thing by reading the events in order. Latency is attributed at one granularity: `tool_call_end.durationMs` (`run-agent-loop.ts:171-178`) measures each tool call.

What is **not** here is **distributed tracing** in the OpenTelemetry sense: no spans with parent/child links, no `spanId`, no `traceId`, no propagation across services. One process, one run, flat event list. Distributed spans are `not yet exercised` — they'd matter if a single user request fanned out across buffr → aptkit → Ollama → Postgres as separate instrumented services. → `01-capability-event-trace.md` (the lifecycle), `06-model-usage-accounting.md` (latency/token attribution).

## 6. state-snapshots-and-debugging-boundaries — state inspection, network traces, error output, before/after

Exercised well at the dev boundary, durably at the prod boundary.

- **Dev-time visual snapshot:** Studio's `TracePanel` (`components.tsx:131-182`) renders the full event list as an inspectable timeline — expandable per-event payloads (`tool_call_start` args, `tool_call_end` results/errors via `tracePayload`, `:428-434`), a filter (`all/model/tools/warnings`, `:421-426`), and a summary header (turns/tools/warnings/tokens/elapsed). This *is* the state-inspection debugger. → `02-trace-replay-as-debugger.md`.
- **Durable snapshot:** buffr's `SupabaseTraceSink` writes every event as a row in `agents.messages` (`supabase-trace-sink.ts:53-85`), ordered by the *event's own* timestamp via `coalesce($8::timestamptz, now())` (`:27-37`) so replay order survives the race between concurrent async inserts. This is a queryable before/after of the entire run. → `03-persisted-trajectory-backward-read.md`.
- **Error output:** tool errors are caught and recorded as `tool_call_end.error` (`run-agent-loop.ts:163-167`) rather than thrown — the run continues and the failure becomes evidence.

## 7. incident-analysis-and-prevention — root cause, remediation, regression guards, runbooks

One real incident, handled end-to-end — and it's the most instructive thing in the repo.

- **Symptom:** RAG agent answered "not available" on a corpus that contained the answer.
- **Evidence:** read the persisted trajectory backward from the final answer; `tool_call_start.args` showed Gemma passed a hallucinated `{textContains: ...}` filter.
- **Root cause:** the filter was applied as exact-match over chunk metadata; no chunk carried that key, so the post-filter zeroed every hit (`search-knowledge-base-tool.ts:90`).
- **Remediation:** `matchesFilter` now ignores filter keys absent from a chunk's meta (`search-knowledge-base-tool.ts:101-106`, commit `c5dbf1a`). A sibling fix floored `top_k` so a weak model can't starve its own retrieval (`minTopK`, `:51`, commit `f535e4a`).
- **Regression guard:** `search-knowledge-base-tool.test.ts:105-117` asserts a hallucinated filter key no longer wipes results.
- **Runbook:** `not yet exercised` — there's no written incident runbook; the prevention is the test, not a document.

→ `03-persisted-trajectory-backward-read.md` for the full arc; `04-silent-empty-result-blind-spot.md` for the contributing condition (the silence).

## 8. debugging-observability-red-flags-audit — ranked blind spots

Ranked by how much each one would slow a real diagnosis, most consequential first.

1. **Empty retrieval is silent (highest).** A zero-hit `search_knowledge_base` returns `{results: []}` with no `warning` event (`search-knowledge-base-tool.ts:89-91`). This is the exact condition behind the war story — and the trace gave no signal pointing at it; the diagnosis came from reading the *args*, not from any emitted alarm. The fix is one `trace.emit({type:'warning'})`. → `04-silent-empty-result-blind-spot.md`.
2. **No timeout as an observable event (high).** The loop honors an `AbortSignal` (`run-agent-loop.ts:99`) but nothing imposes a deadline or records a timeout as a distinct failure. A hung Ollama call would surface as "slow," not as a typed `timeout` event. `not yet exercised`.
3. **Trace carries unredacted payloads (medium).** Args/results persist verbatim into Postgres (`supabase-trace-sink.ts:62-71`). Low risk today (keyless local model, no PII in the demo corpus), but a real corpus with user data would leak into `agents.messages` unredacted. `not yet exercised`.
4. **No severity gradation (low).** Only `warning`/`error` carry level; a noisy run can't be filtered by importance beyond those two buckets.
5. **Cost accounting is OpenAI-only (low).** `pricingForModel` returns `undefined` for any non-OpenAI provider (`usage-ledger.ts:71-77`), so Anthropic and Gemma runs show tokens but `$n/a`. Honest (estimation refuses to guess) but a blind spot for cost observability on the default provider. → `06-model-usage-accounting.md`.
