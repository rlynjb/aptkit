# Study — Debugging & Observability (aptkit)

How this repo reveals its own behavior in development and production: what
evidence exists, where it lives, and how a wrong answer gets diagnosed.

The spine is the structured event log (the `CapabilityEvent` trace). One loop
emits it (`runAgentLoop`); three consumers read it (Studio replays it,
buffr's trace sink persists it, the usage ledger costs it). The signature war
story — an agent answering "not available" on a good corpus — was solved by
reading the persisted trajectory backward. That arc is the heart of this guide.

## Reading order

1. **`00-overview.md`** — the evidence map, ranked findings, and the honest
   `not yet exercised` list. Start here.
2. **`audit.md`** — the 8-lens audit. Every observability boundary walked,
   grounded or marked absent.
3. **Pattern files** (Pass 2 — the mechanisms worth a deep walk):
   - `01-capability-event-trace.md` — the structured event log spine.
   - `02-trace-fan-out-three-consumers.md` — one emitter, three sinks.
   - `03-durable-trajectory-supabase-sink.md` — the queryable production trail.
   - `04-reading-the-trajectory-backward.md` — the war story as a method.
   - `05-deterministic-replay-reproduction.md` — fixtures as a time machine.
   - `06-hallucination-tolerant-retrieval-guard.md` — the fix + the regression guard.

## Where this guide stops — cross-links to neighbors

This generator owns *explaining unknown behavior with evidence*. Adjacent
concerns live next door:

- **`study-testing`** — catching *known* failure conditions before release:
  the replay→eval→promote→fixture backbone, eval scorers, test isolation. The
  reproduction mechanism (`05`) sits on that seam; testing owns the assertion
  side, this guide owns the evidence side.
- **`study-performance-engineering`** — *measuring* bottlenecks: the
  `durationMs` and token-cost signals this guide treats as diagnostic evidence
  are measured and budgeted there.
- **`study-system-design`** — the architecture the trace observes: provider
  abstraction, the agent loop, the retrieval pipeline.
- **`study-ai-engineering`** — the RAG/agentic-retrieval mechanism whose
  failures this guide diagnoses.

When a finding is about measurement or correctness-before-release, it belongs
to those guides. This one explains what went wrong, with evidence, after it
already did.
