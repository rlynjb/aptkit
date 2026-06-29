# Overview — Debugging & Observability in aptkit

The question this guide answers: **when an agent gives a wrong answer, what
evidence exists to explain it quickly and stop it recurring?**

For aptkit the answer is one mechanism doing almost all the work: the
structured event log (the `CapabilityEvent` trace). The agent loop emits it,
three consumers read it, and the one production incident on record was solved
entirely by reading the persisted version of it backward. There are no
metrics, no spans, no alerting — and for a single-process toolkit that mostly
replays deterministically, that's the right scope. The honest gaps are real
and named at the bottom.

## The evidence map — what can be observed, and where

```
  Observability spine — one emitter, three readers

  ┌─ Runtime layer (the emitter) ──────────────────────────────┐
  │  runAgentLoop()                                            │
  │  run-agent-loop.ts                                         │
  │    emits → step | tool_call_start | tool_call_end          │
  │            | model_usage | warning | error                 │
  │            (CapabilityEvent, events.ts)                     │
  └───────────────────────────┬────────────────────────────────┘
                              │ trace.emit(event)   one sink interface:
                              │                     CapabilityTraceSink
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼ (dev)               ▼ (cost)              ▼ (prod, in buffr)
  ┌─ Studio UI ────┐   ┌─ Usage ledger ─┐   ┌─ Storage layer ──────┐
  │ AgentReplay-   │   │ summarizeUsage  │   │ SupabaseTraceSink    │
  │ Shell + Trace- │   │ estimateCost    │   │ → agents.messages     │
  │ Panel; NDJSON  │   │ usage-ledger.ts │   │ (Postgres, buffr repo)│
  │ when streamed  │   └─────────────────┘   └──────────────────────┘
  └────────────────┘
   visual replay        cost per run         durable, queryable trail
```

The interface is the seam. `CapabilityTraceSink.emit(event)` is the only
contract a consumer implements (`packages/runtime/src/events.ts:26-28`).
Anything that wants to observe a run implements that one method. Studio's
in-memory collector, buffr's Postgres writer, and a no-op all satisfy it
identically — the emitter never knows which it's talking to.

## Ranked findings

**1. The trace IS the observability system — and it's well-designed.**
`CapabilityEvent` is a discriminated union of six event types
(`packages/runtime/src/events.ts:1-24`), emitted at every meaningful boundary
of the agent loop: each model turn (`model_usage`), each assistant message
(`step`), each tool call's start and end with `durationMs` and `error`
(`tool_call_start` / `tool_call_end`), plus `warning` and `error`. Because the
emitter writes to an *interface*, not a logger, the same event stream becomes a
dev-time replay UI, a cost ledger, and a durable production trajectory with no
change to the loop. → `01-capability-event-trace.md`, `02-trace-fan-out-three-consumers.md`.

**2. The durable trajectory is what made the signature incident solvable.**
buffr's trace sink (`SupabaseTraceSink`,
`/Users/rein/Public/buffr/src/supabase-trace-sink.ts:49-94`) persists *every*
event variant — including tool-call args, the cause — to `agents.messages`,
stamping each row with the event's own `timestamp` so replay order matches emit
order. An agent answered "not available" on a corpus that clearly contained the
answer. The fix came from reading that persisted trajectory *backward*:
final answer → empty tool result → the `tool_call_start` args showed Gemma had
passed a hallucinated `{textContains}` filter that exact-matched to zero hits.
→ `03-durable-trajectory-supabase-sink.md`, `04-reading-the-trajectory-backward.md`.

**3. Empty retrieval is SILENT — the one real diagnostic blind spot.**
The `search_knowledge_base` tool returns `{ query, results: [] }` on zero hits
(`packages/retrieval/src/search-knowledge-base-tool.ts:92-95`) and emits no
`warning` event. A zero-hit retrieval and a one-hit retrieval look identical in
the trace except for an empty array you have to notice. The fix that *was*
shipped hardened the filter so a hallucinated key can't zero results
(`matchesFilter`, line 101-106) plus a regression test. The fix that is **not**
shipped is a zero-hit `warning` event that would have flagged the incident the
moment it happened instead of after a user complaint. → `audit.md` lens 8,
`06-hallucination-tolerant-retrieval-guard.md`.

## not yet exercised

These are absent by deliberate scope, not oversight. Each becomes relevant only
at a shape this repo hasn't reached.

- **Metrics system (Prometheus / OpenTelemetry / StatsD).** No counters,
  gauges, or histograms. A grep for `prometheus|opentelemetry|otel|datadog`
  across both repos returns nothing. Relevant when the toolkit runs as a
  long-lived service with aggregate behavior to watch, not per-run traces.
- **Distributed tracing / spans / trace-correlation IDs.** No `traceId`,
  `correlationId`, `requestId`, or span propagation. The agent loop is one
  process; there's no cross-service call to correlate. Relevant when a request
  fans out across services.
- **Log aggregation / structured log levels.** No log shipper, no log levels —
  the trace replaces logs. Relevant at multi-instance scale where you can't
  read one process's output.
- **Alerting / incident tooling / on-call.** No thresholds, no pages. The one
  incident was found by a human noticing a wrong answer. Relevant once the
  system serves traffic nobody is watching live.
- **Per-call timeout instrumentation.** `runAgentLoop` threads an `AbortSignal`
  (`run-agent-loop.ts:99`) but there's no per-tool timeout budget emitted as an
  event. Relevant when a hung provider call needs to be observable, not just
  abortable.
- **Cost coverage beyond gpt-4.1.** `pricingForModel` only prices `gpt-4.1*`
  (`packages/runtime/src/usage-ledger.ts:71-78`); Anthropic and Gemma runs
  return `undefined` cost. The cost signal exists but is partial.
