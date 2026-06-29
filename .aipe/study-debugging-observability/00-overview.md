# Debugging & Observability — the map

> How aptkit reveals its own behavior. Read this first, then the audit, then the pattern files in order.

The question this whole guide answers: **when an agent does something wrong, what evidence exists to explain it quickly — and to stop it recurring?**

For a normal web app the answer is "logs + a stack trace." For an LLM agent it's different. There's no stack trace for "the model decided to pass a filter that wiped the results." The bug lives in a *decision the model made mid-run*, and the only way to see it is to have recorded every decision as it happened. That recording is the spine of aptkit's observability, and it has a name: the **CapabilityEvent trace**.

## The whole system in one frame

Everything below hangs off one stream of events. The agent loop emits it; three sinks consume it.

```
  Observability spine — one event stream, three sinks

  ┌─ Runtime layer (packages/runtime) ───────────────────────────────┐
  │  runAgentLoop()  ── emits ──►  CapabilityEvent                    │
  │  run-agent-loop.ts:112-179      (step · tool_call_start ·        │
  │                                  tool_call_end · model_usage ·    │
  │                                  warning · error)                 │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  trace?.emit(event)   (sync, fire-and-forget)
          ┌───────────────────┼────────────────────────────┐
          ▼                   ▼                            ▼
  ┌─ Studio (apps) ──┐ ┌─ buffr (durable) ──────┐ ┌─ Runtime (derived) ──┐
  │ TracePanel       │ │ SupabaseTraceSink      │ │ summarizeUsage()     │
  │ components.tsx   │ │ → agents.messages      │ │ usage-ledger.ts:25   │
  │ :131 visual      │ │ (Postgres, ordered by  │ │ tokens + USD cost    │
  │ replay = the     │ │  event timestamp)      │ │ folded from trace    │
  │ dev-time debugger│ │ the war-story evidence │ │                      │
  └──────────────────┘ └────────────────────────┘ └──────────────────────┘
   ephemeral, in-browser  durable, queryable          a pure reduction
```

One event type, three readers. The same `CapabilityEvent[]` array drives a live visual timeline in Studio, gets written row-by-row into Postgres by buffr, and folds into a token/cost summary by a pure function. Learn the event shape once (`packages/runtime/src/events.ts:1-24`) and you understand all three.

## Ranked findings — what's interesting here

1. **The trace IS the observability system — there is no separate logger.** aptkit emits zero `console.log` lines from its agent loop. Instead every consequential moment (a model turn, a tool call's args, its result, its duration, a token count, a warning) is a typed event on one stream. This is the single most important thing to understand: debugging this codebase means *reading the trace*, not grepping logs. → `01-capability-event-trace.md`

2. **A real bug was diagnosed by reading the persisted trajectory backward — and the fix shipped with a regression test.** The agent answered "not available" on a corpus that clearly contained the answer. Reading the durable trajectory from the final answer *backward*, the `tool_call_start` event showed Gemma had passed a hallucinated `{textContains: ...}` filter; the exact-match filter then zeroed every result. The fix (`matchesFilter`, commit `c5dbf1a`) ignores filter keys no chunk carries, locked by a regression test. → `03-persisted-trajectory-backward-read.md`, `04-silent-empty-result-blind-spot.md`

3. **The same trace makes bugs reproducible without a network.** Live runs are recorded as fixtures (`ModelResponse[]`); `FixtureModelProvider` replays them deterministically. The "not available" bug can be reproduced offline, in a unit test, with no Ollama running. → `05-deterministic-replay-reproduction.md`

## The honest gaps — `not yet exercised`

This is a single-process toolkit and a laptop runtime, not a fleet of services. So large swaths of production observability simply aren't here, and the audit says so plainly:

- **No metrics system.** No counters, gauges, or histograms; no Prometheus/OpenTelemetry/Datadog. Token totals are computed *after* a run from the trace, not emitted as a live metric. `not yet exercised`.
- **No distributed tracing / spans.** `CapabilityEvent` has a `capabilityId` and a `timestamp` but no `traceId`/`spanId` and no parent links. One process, one run — there's nothing to correlate *across*. `not yet exercised`.
- **No log aggregation.** No structured log shipper, no searchable index beyond ad-hoc SQL over `agents.messages`. `not yet exercised`.
- **No alerting or incident tooling.** No thresholds, no pages, no runbooks, no on-call. `not yet exercised`.
- **No per-call timeout instrumentation.** The loop honors an `AbortSignal` (`run-agent-loop.ts:99`) but nothing sets a deadline or records a timeout as a distinct, observable failure. `not yet exercised`.
- **The teachable one — empty retrieval is silent.** A zero-hit search emits *no* warning event. That silence is exactly what made the war-story bug hard. The unbuilt fix is one line: emit a `warning` event when retrieval returns nothing. → `04-silent-empty-result-blind-spot.md`.

## Reading order

1. `audit.md` — the 8-lens sweep; what each observability boundary actually exposes.
2. `01-capability-event-trace.md` — the event spine. **Read this before any other pattern file.**
3. `02-trace-replay-as-debugger.md` — Studio's visual timeline as the dev-time debugger.
4. `03-persisted-trajectory-backward-read.md` — the war story, told as a debugging arc.
5. `04-silent-empty-result-blind-spot.md` — the root-cause blind spot and the unbuilt fix.
6. `05-deterministic-replay-reproduction.md` — making the bug reproducible offline.
7. `06-model-usage-accounting.md` — turning trace into tokens and dollars.

## See also (neighboring guides)

- `study-testing` — owns the fixture/replay *correctness* mechanism (eval scorers, promotion). This guide borrows it for *reproduction*; the eval semantics live there.
- `study-performance-engineering` — owns latency/throughput *measurement*. `durationMs` on `tool_call_end` is shared evidence; the budgets live there.
- `study-system-design` — owns the provider/retrieval seams. This guide reads what crosses them.
- `study-ai-engineering` — owns RAG retrieval quality (precision@k). The war story's *fix quality* lives there; its *diagnosis* lives here.
