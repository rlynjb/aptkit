# The durable trajectory (`SupabaseTraceSink`)

**Industry name(s):** durable audit log / persistent trace store / event
journal. **Type:** Industry standard (the local sink is project-specific).

## Zoom out, then zoom in

Studio's view of a run dies when you close the tab. Production runs need to
survive the process — so you can read them an hour later, after a user
complaint, when the only thing that exists is what got written down. That's
this sink's job: take the same event stream and lay it down as queryable rows.

```
  Zoom out — the durable reader (lives in buffr)

  ┌─ Runtime layer (aptkit, on npm) ──────────────────────┐
  │  runAgentLoop ──emit──► CapabilityTraceSink            │
  └──────────────────────────────┬─────────────────────────┘
                                 │ emit(event)  (sync; queued)
  ┌─ Adapter (buffr repo) ───────▼─────────────────────────┐
  │  ★ SupabaseTraceSink ★   maps each event → a row        │ ← we are here
  │  supabase-trace-sink.ts                                 │
  └──────────────────────────────┬─────────────────────────┘
                                 │ flush(): await all inserts
  ┌─ Storage layer (Postgres) ───▼─────────────────────────┐
  │  agents.messages   (conversation_id, role, content,    │
  │  tool_calls, tool_results, model, tokens_used, created_at)│
  └──────────────────────────────────────────────────────────┘
```

Zoom in: this is the consumer that turned the signature incident from
unsolvable into a ten-minute read. The question it answers: *after the run is
gone, what's left to debug from?* Everything — because this sink persists every
event variant, including the tool-call args that turned out to be the cause.

## The structure pass

**Layers.** Adapter (`SupabaseTraceSink`, in buffr) and Storage (the `agents`
Postgres schema, also in buffr). aptkit ships the *contract*; buffr ships the
*durable implementation* — the deployment-agnostic-core / fills-the-slot split.

**Axis — trace it on `guarantees`: sync vs async, ordered vs raced.**

```
  "what's guaranteed about when and in what order events are written?"

  emitter side:  emit() is SYNC, returns void   → no write guarantee yet
        │                                          (the loop moves on instantly)
  adapter side:  push(promise) into a queue      → write is PENDING
        │
  flush() side:  await Promise.all(pending)      → all writes DURABLE
        │
  ordering:      created_at = event.timestamp    → replay order = EMIT order,
                                                   not insert-race order
```

**Seam.** The `CapabilityTraceSink` interface again — but here the *guarantees*
axis flips hard across it. The emitter promises nothing about durability
(sync/void); the adapter converts that into eventual durability via
queue-then-flush, and preserves emit-order by writing the event's own timestamp
into `created_at` rather than trusting `now()`. That timestamp choice is the
subtle, load-bearing decision: concurrent flush inserts race, but the stored
order doesn't, because order is data, not insert time.

## How it works

### Move 1 — the mental model

You know how an `INSERT` inside a request handler shouldn't block the response —
you fire it and move on, or queue it. Same instinct here. The agent loop's
`emit` can't block on a Postgres round-trip, so the sink doesn't write inline:
it *enqueues a promise* and returns immediately, then drains the queue once, at
the end, in `flush()`.

```
  The pattern — sync emit, deferred durable write

  loop turn ─► emit(e0) ─► push(insert e0) ─┐  returns instantly
  loop turn ─► emit(e1) ─► push(insert e1) ─┤  (loop never awaits I/O)
  loop turn ─► emit(e2) ─► push(insert e2) ─┤
                                            │  pending: [p0, p1, p2]
  run ends  ─► flush() ─► await all(pending)┘ ─► every row durable
```

The hot loop sees a `void` return every time; the I/O all happens after the run
in one awaited batch.

### Move 2 — the step-by-step walkthrough

**The row writer — every event becomes one `agents.messages` row.** The
foundation is a single parameterized insert. Two details earn their keep:

```typescript
// /Users/rein/Public/buffr/src/supabase-trace-sink.ts:19-37
export async function persistMessage(pool, conversationId, role, content, extra?): Promise<void> {
  // jsonb columns stringified explicitly so array payloads aren't mistaken
  // for a Postgres array literal by node-postgres.
  const toJsonb = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));
  const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
  await pool.query(
    `insert into agents.messages
       (conversation_id, role, content, tool_calls, tool_results, model, tokens_used, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`,
    [conversationId, role, content, toJsonb(extra?.toolCalls), toJsonb(extra?.toolResults),
     extra?.model ?? null, extra?.tokensUsed ?? null, createdAt]);
}
```

The `coalesce($8::timestamptz, now())` is the ordering guarantee: if the event
carried a timestamp, that's `created_at`; only if it's missing do we fall back
to server `now()`. Reading the trajectory back by `created_at` reproduces *emit*
order, not the order the racing inserts happened to land.

**The dispatch — one case per event variant.** The `emit` switches on the
discriminant and maps each variant onto the row shape. The key insight, from the
sink's own doc comment, is that it persists **every** variant — not just
assistant text:

```typescript
// /Users/rein/Public/buffr/src/supabase-trace-sink.ts:53-85
emit(event: CapabilityEvent): void {
  const { pool, conversationId } = this.opts;
  const at = event.timestamp;
  switch (event.type) {
    case 'step':                                         // assistant text → a message row
      if (event.content) this.push(persistMessage(pool, conversationId, event.role, event.content, { createdAt: at }));
      return;
    case 'tool_call_start':                              // ◄── persists ARGS: the cause
      this.push(persistMessage(pool, conversationId, 'tool_call', event.toolName,
        { toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at }));
      return;
    case 'tool_call_end':                                // result + error + durationMs
      this.push(persistMessage(pool, conversationId, 'tool', event.toolName,
        { toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, createdAt: at }));
      return;
    case 'model_usage':                                  // fills the otherwise-orphan tokens_used
      this.push(persistMessage(pool, conversationId, 'model_usage', '',
        { model: `${event.provider}/${event.model}`,
          tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), createdAt: at }));
      return;
    case 'warning':
    case 'error':
      this.push(persistMessage(pool, conversationId, event.type, event.message, { createdAt: at }));
      return;
  }
}
```

Read the `tool_call_start` case closely — it persists `args`. The sink's doc
comment is explicit that args, `durationMs`, errors, and token usage "were
previously dropped on the floor; capturing them turns `agents.messages` into a
complete, replayable trajectory." That one decision — persist the *cause*, not
just the *effect* — is what made the war story solvable. Without the persisted
args, the trajectory would show "tool returned empty" with no visible reason.

**The queue and flush — deferred durability.** The mechanism that keeps `emit`
synchronous:

```typescript
// /Users/rein/Public/buffr/src/supabase-trace-sink.ts:50-93
private readonly pending: Promise<void>[] = [];
private push(p: Promise<void>): void { this.pending.push(p); }   // fire, don't await
async flush(): Promise<void> { await Promise.all(this.pending); } // drain once, after the run
```

`push` stores the insert's promise and returns; `emit` is therefore synchronous
and `void`, honoring the contract from `01`. The caller (buffr's session
runtime) awaits `flush()` once the agent loop completes. The cost of this design:
if the process dies mid-run, un-flushed events are lost — durability is
end-of-run, not per-event. For a laptop runtime debugging completed runs, that's
the right tradeoff; for a system that must survive a crash mid-trajectory, you'd
write per-event and accept the latency.

### Move 2 variant — the load-bearing skeleton

```
  Kernel of a durable trace sink

  1. implements the sink interface   ── plugs into the loop unchanged
  2. per-variant → row mapping       ── nothing dropped, args included
  3. event timestamp → created_at    ── stored order = emit order
  4. queue + flush                   ── sync emit, async durability
```

- **Drop variant coverage of `tool_call_start`** and you lose the args — the
  trajectory shows effects with no causes; the war story becomes unsolvable.
- **Drop the timestamp-into-`created_at`** and concurrent inserts race; replay
  order scrambles and the causal chain is unreadable.
- **Drop queue+flush** and either `emit` blocks the loop on Postgres, or you
  break the sync/void contract.

**Skeleton vs hardening.** The four above are the kernel. Hardening: the
explicit `toJsonb` stringify (node-postgres array-literal footgun), the
`conversation_id` correlation key for cross-run queries. Those are correctness
polish, not the pattern.

### Move 3 — the principle

Persist the cause, not just the effect — and make stored order a property of the
data, not of when the write happened. A durable log that records *what came out*
but not *what went in* can tell you something broke but never why. The whole
value of this sink over a plain "log the answer" is that it kept the inputs (tool
args) and kept them ordered.

## Primary diagram

```
  The durable trajectory — emit to queryable rows

  ┌─ Runtime (aptkit) ─────────────────────────────────────────────┐
  │  runAgentLoop ── emit(event) ──►                                │
  └────────────────────────────────┬────────────────────────────────┘
                                   │ sync, void
  ┌─ Adapter (buffr) SupabaseTraceSink ─▼──────────────────────────┐
  │  switch(event.type):                                           │
  │    step          → persistMessage(role, content)              │
  │    tool_call_start → persist {toolName, args}   ◄── THE CAUSE   │
  │    tool_call_end   → persist {result, error, durationMs}       │
  │    model_usage     → persist {model, tokensUsed}               │
  │    warning|error   → persist {message}                         │
  │  each: push(insertPromise)  ──► pending[]                      │
  │  run ends: flush() = await Promise.all(pending)                │
  └────────────────────────────────┬────────────────────────────────┘
                                   │ INSERT ... created_at =
                                   │   coalesce(event.timestamp, now())
  ┌─ Storage (Postgres, agents schema) ─▼──────────────────────────┐
  │  agents.messages  rows, ordered by created_at = EMIT order      │
  │  → read backward for root cause (see 04)                        │
  └─────────────────────────────────────────────────────────────────┘
```

## Elaborate

This is a write-ahead-log idea applied to agent runs: every action is journaled
before it's forgotten, and order is intrinsic to the record. The aptkit/buffr
split is the deeper architectural point — aptkit defines `CapabilityTraceSink`
as a published contract and ships no Postgres dependency; buffr implements the
durable adapter and owns the `agents` schema. The core stays deployment-agnostic;
the body fills the slot. If you swapped Postgres for SQLite or a file, only this
one adapter changes.

Read next: `04-reading-the-trajectory-backward.md` (using these rows for root
cause), `01-capability-event-trace.md` (the events being persisted).

## Interview defense

**Q: How do you persist a trace without blocking the agent loop?**
The sink's `emit` is synchronous and `void` — it enqueues the insert promise and
returns. The loop never awaits I/O. After the run, the caller awaits `flush()`,
which drains every queued write. Off the hot path, durable by end of run.

```
  emit ─► push(promise) ─► return   |  ...run ends...  | flush ─► await all
```

**Q: Two events insert concurrently — how is replay order preserved?**
Order is data, not timing. Each row's `created_at` is set from the *event's own
timestamp* via `coalesce(event.timestamp, now())`, so reading back ordered by
`created_at` reproduces emit order regardless of which racing insert landed
first. Anchor: `supabase-trace-sink.ts:30`.

**Q: What's the part of this design that actually solved the incident?**
Persisting `tool_call_start` *args*. Effects without causes can't be debugged.
Because the args were on disk, reading backward exposed the hallucinated
`{textContains}` filter as the root cause. The doc comment calls out that these
were "previously dropped on the floor" — capturing them is the whole point.

## See also

- `04-reading-the-trajectory-backward.md` — the diagnostic method over these rows.
- `01-capability-event-trace.md` — the event union being persisted.
- `02-trace-fan-out-three-consumers.md` — this as the third consumer.
- `audit.md` lens 3 (correlation, redaction gap), lens 7 (incident).
- `study-system-design` — the aptkit/buffr core-vs-body split.
