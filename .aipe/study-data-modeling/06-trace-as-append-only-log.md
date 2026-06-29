# 06 — `agents.messages` as an append-only trajectory log

**Industry name(s):** append-only event log · event sourcing (lite) ·
persisted trace / audit log · discriminated-union-to-rows projection.
**Type:** Industry-standard logging shape; the projection from aptkit's
`CapabilityEvent` union is project-specific.

## Zoom out, then zoom in

The agent's entire run — every model turn, tool call, token count, warning
— is captured as rows in one table, written once, never updated. Here's
where the log sits relative to the live trace.

```
  Zoom out — the in-memory trace becomes durable rows

  ┌─ aptkit runtime (in-memory) ────────────────────────────────────┐
  │  runAgentLoop emits CapabilityEvent[]                            │
  │    step | tool_call_start | tool_call_end | model_usage |        │
  │    warning | error      (discriminated union, each w/ timestamp) │
  └───────────────────────────┬──────────────────────────────────────┘
                              │  CapabilityTraceSink.emit(event)
  ┌─ buffr Storage (Postgres) ▼─────────────────────────────────────┐
  │  agents.conversations  (one row per run)                        │
  │  agents.messages       (one row per EVENT, append-only)         │
  │     conversation_id FK → conversations  (on delete cascade)     │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in. aptkit's agent loop doesn't write a database — it emits a stream
of `CapabilityEvent`s (`packages/runtime/src/events.ts:1-24`), a
discriminated union. buffr's `SupabaseTraceSink` is the consumer that
*projects* each event variant into a row in `agents.messages`. The table is
append-only: `SupabaseTraceSink` only ever `insert`s, never updates or
deletes. The result is a complete, ordered, replayable record of what the
agent did. This file is about that projection — how six event shapes
collapse into one table, and why the table is the right shape for the job.

## The structure pass

Axis: **lifecycle — is a row ever mutated after it's written?**

```
  axis = "after a message row is written, does it change?"

  ┌─ conversations ──────────┐  seam  ┌─ messages ───────────────────┐
  │ one row per run, written │ ══╪══► │ one row per EVENT, INSERT-only│
  │ at start, never updated  │  same  │ never updated, never deleted  │
  └──────────────────────────┘ answer │ (except cascade w/ conversation)│
                                       └──────────────────────────────┘
        the answer DOESN'T flip — everything here is append-only;
        that immutability IS the property that makes it replayable
```

- **Layers:** the live `CapabilityEvent` stream (aptkit) vs the persisted
  rows (buffr).
- **The axis (mutability/lifecycle):** unlike domain tables where rows get
  updated, *nothing* in this log mutates after insert. The axis-answer
  ("is it mutated?" → "no") holds across both tables — and that constancy
  is the point: an append-only log is replayable precisely because history
  is never rewritten.
- **The seam:** the `emit()` boundary. aptkit promises a *synchronous*
  `emit` (the `CapabilityTraceSink` contract); buffr needs *async* DB
  writes. The sink bridges that by queuing promises and awaiting them in a
  separate `flush()`.

## How it works

#### Move 1 — the mental model

You know `console.log` lines in order tell you what happened — but they're
gone when the process exits. An append-only event log is that, made
durable and queryable: one row per thing-that-happened, in order, never
edited. Because you never overwrite history, you can *replay* it — re-derive
the agent's whole trajectory by reading the rows back in `created_at`
order. The trick is mapping a typed event union onto a single flexible row.

```
  the pattern — project a discriminated union onto one append-only table

  CapabilityEvent (6 variants) ──► one switch ──► one INSERT per event
        step          → role=<role>,    content=text
        tool_call_start → role='tool_call', tool_calls=jsonb{name,args}
        tool_call_end → role='tool',     tool_results=jsonb{result,err,ms}
        model_usage   → role='model_usage', model, tokens_used
        warning/error → role=<type>,     content=message
                              │ every row carries created_at = event.timestamp
                              ▼
        replay = SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at
```

#### Move 2 — the walkthrough

**The row shape: typed columns + jsonb sidecars.** `agents.messages`
(`/Users/rein/Public/buffr/sql/001_agents_schema.sql:40-50`) mixes scalar
columns (`role`, `content`, `model`, `tokens_used`, `created_at`) with two
jsonb sidecars (`tool_calls`, `tool_results`) for the open-shaped payloads —
the same hybrid trick as `02`, here because a tool's args/results have no
fixed schema. `role` is free text, not an enum, so it can hold both real
chat roles (`'assistant'`) and synthetic event-type roles (`'tool_call'`,
`'model_usage'`) without a migration per new event type.

**The projection: one switch, six variants → rows.**
`SupabaseTraceSink.emit` is the whole mapping —
`/Users/rein/Public/buffr/src/supabase-trace-sink.ts:53-85`:

```ts
emit(event: CapabilityEvent): void {
  const at = event.timestamp;
  switch (event.type) {
    case 'step':
      if (event.content)                                   // skip empty steps
        this.push(persistMessage(pool, convId, event.role, event.content, {createdAt: at}));
      return;
    case 'tool_call_start':
      this.push(persistMessage(pool, convId, 'tool_call', event.toolName, {
        toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at }));   // args = the CAUSE
      return;
    case 'tool_call_end':
      this.push(persistMessage(pool, convId, 'tool', event.toolName, {
        toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, createdAt: at }));
      return;
    case 'model_usage':
      this.push(persistMessage(pool, convId, 'model_usage', '', {
        model: `${event.provider}/${event.model}`,
        tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), createdAt: at }));
      return;
    case 'warning': case 'error':
      this.push(persistMessage(pool, convId, event.type, event.message, {createdAt: at}));
      return;
  }
}
```

Walk the load-bearing choices. **Every variant is persisted** — the
file's own comment (`supabase-trace-sink.ts:42-48`) notes that tool-call
*args* (the cause of a tool call), `durationMs`, `error`, and token usage
were "previously dropped on the floor"; capturing them is what turns the
table from "assistant messages" into "a complete replayable trajectory."
`model_usage` is the row that fills the otherwise-orphaned `tokens_used`
column. **What breaks if you only persist `step` events: you get the
agent's words but not its actions — no tool args, no timings, no token
ledger — and the log is no longer replayable.**

**The timestamp is the ordering key, on purpose.** Each `persistMessage`
binds `created_at = coalesce($8::timestamptz, now())` from the *event's*
timestamp (`supabase-trace-sink.ts:26-30`), not the insert time. The
comment (`:46-48`) explains why: writes are flushed concurrently, so
insert order races; persisting the *emit* timestamp means
`order by created_at` reconstructs the true emit order regardless of which
insert landed first. **The ordering invariant lives in the data
(`created_at`), not in the write sequence.**

**The sync-emit / async-write seam.** aptkit's `CapabilityTraceSink.emit`
is synchronous (`events.ts:26-28`), but Postgres writes are async. The sink
resolves this by *not awaiting* inside `emit` — it pushes the insert promise
onto a `pending` array (`supabase-trace-sink.ts:87-89`) and the caller
awaits them all in `flush()` after the run (`:91-93`). That's how an
append-only log gets written from a synchronous emit contract without
blocking the agent loop.

**Why append-only is the right shape.** A trajectory is *history* — it
already happened, so there's nothing to update. Modeling it as mutable rows
would invite the question "which version is current," which has no meaning
for a log. The only deletion is structural: `conversation_id references
conversations(id) on delete cascade` (schema line 42) — drop a conversation
and its whole message history goes with it, atomically. That's the one real
FK in the schema (contrast `01`'s dropped chunk FK), and it's safe to keep
because the relationship lives entirely inside buffr's own tables.

#### Move 3 — the principle

History is append-only by nature, so model it that way: one immutable row
per event, ordered by a timestamp carried *in the data*, never updated.
When the source is a discriminated union of event types, you don't need a
table per type — one table with a discriminator (`role`) plus jsonb
sidecars for the open payloads projects the whole union, and stays open to
new event types without a migration. The payoff is replayability: because
no row is ever rewritten, reading them back in order re-derives exactly
what happened. The cost — an unbounded, ever-growing table with no
retention — is the standard append-only tradeoff, and it's `not yet
exercised` here (no archival/TTL in the schema).

## Primary diagram

```
  CapabilityEvent → agents.messages, one frame

  ── aptkit runtime ────────────────────────────────────────────────
  runAgentLoop ──emit(event)──► CapabilityTraceSink (SYNC contract)
                                      │ push promise (no await)
  ── buffr SupabaseTraceSink ─────────▼──────────────────────────────
  switch(event.type):
    step/warning/error → role + content
    tool_call_start    → role='tool_call',   tool_calls jsonb {name,args}
    tool_call_end      → role='tool',         tool_results jsonb {result,err,ms}
    model_usage        → role='model_usage',  model + tokens_used
        │ every insert: created_at = event.timestamp  (ordering in the DATA)
        │ pending[] ──► flush() awaits all after the run
        ▼
  ── Postgres agents.messages (append-only) ─────────────────────────
  [ msg | msg | msg | ... ]   conversation_id FK → conversations CASCADE
        replay = ORDER BY created_at   ← immutable history, re-derivable
```

## Elaborate

This is event-sourcing's core idea in a small form: persist the *events*,
not just the final state, and you can replay to any point. Full event
sourcing rebuilds application state by folding the log; buffr stops short —
it persists the trajectory for observability and replay-based eval, not to
reconstruct domain state. The discriminated-union-to-single-table
projection is the standard way to land a closed set of event types in SQL
(single-table inheritance with a type discriminator); the jsonb sidecars
handle the parts of each variant that don't fit fixed columns, exactly like
`02`'s `meta` bag. The honest gaps: `role` is free text so a typo (`'tool'`
vs `'tools'`) wouldn't be rejected — a CHECK or enum would guard it; and the
table has no retention policy, so it grows unbounded. Both are `not yet
exercised`. Read next: `02` (the jsonb-sidecar pattern), `04` (why this
table gets transitive tenancy), `study-debugging-observability` (the trace
as the observability backbone), `study-testing` (replay-from-trace eval).

## Interview defense

**Q: How is an agent run persisted, and why append-only?**

aptkit's loop emits a `CapabilityEvent` discriminated union — steps, tool
calls, model usage, warnings, errors. buffr's `SupabaseTraceSink` projects
each variant into a row in `agents.messages`: a `role` discriminator plus
`content`, and jsonb sidecars (`tool_calls`, `tool_results`) for the
open-shaped payloads. It's append-only because a trajectory is history —
nothing to update. Every variant is persisted, not just assistant
messages, so tool args, timings, and token counts are all there — that's
what makes it replayable.

```
  6 event types ──switch──► 1 table (role discriminator + jsonb sidecars)
  created_at = event.timestamp  → ORDER BY created_at re-derives emit order
  insert-only → history immutable → replayable
```

Anchor: *persist the events, not the final state — and carry the ordering
key in the data, because concurrent flushes race the insert order.*

**Q: emit is synchronous but DB writes are async — how?**

The sink doesn't await inside `emit`; it pushes the insert promise onto a
`pending` array and the caller awaits them all in `flush()` after the run.
And `created_at` is set from the event timestamp, not insert time, so
order survives the concurrent flush.

Anchor: *queue-on-emit, await-on-flush bridges a sync trace contract to
async durable writes.*

## See also

- `02-metadata-as-json-bag.md` — same jsonb-sidecar pattern.
- `04-app-id-tenancy-without-rls.md` — why messages has transitive tenancy.
- `01-dropped-fk-for-drop-in-parity.md` — the one real FK (cascade) vs the
  dropped one.
- `study-debugging-observability` · `study-testing` — the trace as
  observability + replay-eval backbone.
