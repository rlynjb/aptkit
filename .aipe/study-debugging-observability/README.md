# Study — Debugging & Observability (aptkit)

How this repo reveals its own behavior in development and production: reproduction, evidence, structured events, traces, durable trajectories, and the gaps. Audit-style: one lens sweep plus pattern files for what aptkit actually exercises.

The one thing to take away: **aptkit has no logger.** Its observability is a single typed event stream — the `CapabilityEvent` trace — emitted by the agent loop and read by three independent consumers (a visual debugger, a durable Postgres audit log, a cost ledger). Debugging this codebase means reading the trace, not grepping logs.

## Reading order

| # | File | What it covers |
|---|------|----------------|
| — | `00-overview.md` | The map, ranked findings, and the `not yet exercised` gaps. **Start here.** |
| — | `audit.md` | Pass 1 — the 8-lens sweep, each boundary's evidence, red-flags ranked. |
| 01 | `01-capability-event-trace.md` | The event spine. **Read before any other pattern file.** |
| 02 | `02-trace-replay-as-debugger.md` | Studio's `TracePanel` — the dev-time visual debugger over the stream. |
| 03 | `03-persisted-trajectory-backward-read.md` | The war story: buffr's durable trajectory, diagnosed by reading backward. |
| 04 | `04-silent-empty-result-blind-spot.md` | The root-cause blind spot — zero-hit retrieval is silent. The unbuilt fix. |
| 05 | `05-deterministic-replay-reproduction.md` | Making the bug reproducible offline via `FixtureModelProvider`. |
| 06 | `06-model-usage-accounting.md` | Tokens and USD cost, derived from the trace (and where cost goes `$n/a`). |

Read 01 first — every other file is a *reader* of the thing 01 builds. Then 02→03→04 form one continuous arc (visual debugger → durable trajectory → the silence that hid the bug). 05 and 06 are the reproduction and accounting tails.

## The spine in one line

```
  runAgentLoop ──emit(CapabilityEvent)──► [ Studio panel · buffr Postgres · cost ledger ]
       01                                       02            03            06
```

## What's NOT here (honest gaps)

No metrics system · no distributed tracing/spans/`traceId` · no log aggregation · no alerting/incidents/runbooks · no timeout instrumentation. Each is `not yet exercised` and explained in `audit.md` and `00-overview.md`. The single most teachable gap — empty retrieval emits no warning — is `04`.

## Cross-links to neighboring guides

- **`study-testing`** — owns the fixture/replay *correctness* mechanism (eval scorers, fixture promotion). This guide borrows replay for *reproduction* only.
- **`study-performance-engineering`** — owns latency/throughput budgets. `durationMs` and token counts are shared evidence; the budgets live there.
- **`study-system-design`** — owns the provider/retrieval/sink seams this guide reads.
- **`study-ai-engineering`** — owns RAG retrieval quality (precision@k). The war story's *fix quality* lives there; its *diagnosis* lives here (`03`/`04`).
- **`study-data-modeling`** — owns the `agents.messages` schema that backs the durable trajectory.
