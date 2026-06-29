# 06 — The trace persisted as message rows

**Industry name(s):** event log / append-only trajectory table (a.k.a.
persisted trace, audit/event-sourcing-lite). **Type:** Industry standard.

The agent's in-memory `CapabilityEvent` discriminated union — a stream of
steps, tool calls, usage, warnings — is flattened into rows of one
append-only `messages` table, with the event timestamp persisted so replay
order survives concurrent writes. The discriminated union is the source
shape; the table is its durable, queryable form.

## Zoom out, then zoom in

The trace starts as a typed union emitted by aptkit's agent loop and lands
as rows in buffr's `messages` table — one row per event, every variant
captured.

```
  Zoom out — where the trace shape lives

  ┌─ aptkit runtime (packages/runtime) ────────────────────────┐
  │  CapabilityEvent =                                          │
  │    step | tool_call_start | tool_call_end                   │ ← we are here
  │    | model_usage | warning | error   (events.ts:1-24)      │
  │  emitted by runAgentLoop via CapabilityTraceSink.emit()     │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ buffr's sink implements emit()
  ┌─ buffr SupabaseTraceSink ──────▼────────────────────────────┐
  │  switch(event.type) → persistMessage(...)                   │
  │   (supabase-trace-sink.ts:53-85)                            │
  └───────────────────────────────┬─────────────────────────────┘
                                  │ insert
  ┌─ agents.messages ──────────────▼────────────────────────────┐
  │  conversation_id FK · role · content · tool_calls jsonb      │
  │  · tool_results jsonb · model · tokens_used · created_at     │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the agent loop emits a typed event for everything it does — "I took
a step," "I'm calling this tool with these args," "the tool returned," "this
model turn cost N tokens." That's a discriminated union in memory. To make a
conversation *replayable* after the process exits, each event becomes a row.
The question it answers: *how do you turn an ephemeral, typed event stream
into a durable, ordered, queryable trajectory?* You map the union's variants
onto one wide table, store the variant's distinguishing fields in `jsonb`
columns, and persist the event timestamp so order is recoverable.

## Structure pass

```
  One axis — "where does the trace's shape live?" — across layers

  ┌─ emit (aptkit) ───────────────────┐
  │  CapabilityEvent union, in memory │   → TYPED. 6 variants, compiler-checked.
  └───────────────────────────────────┘
              │  the seam ═══════════════  ◄── typing flips here
              ▼
  ┌─ sink (buffr) ────────────────────┐
  │  switch on event.type → row        │   → FLATTENED. union → one row shape.
  └───────────────────────────────────┘
              │  insert
              ▼
  ┌─ messages table ──────────────────┐
  │  role + jsonb columns, by event   │   → UNTYPED ROWS. variant lives in
  └───────────────────────────────────┘      `role` + which jsonb is filled.
```

- **Layers:** emit (typed union) → sink (the `switch`) → table (rows).
- **Axis = "what carries the variant's identity?"** In memory, the
  TypeScript discriminant (`event.type`). At the table, it's the `role`
  string plus *which* nullable column got filled (`tool_calls` vs
  `tool_results` vs `tokens_used`).
- **The seam = `SupabaseTraceSink.emit`.** The `switch(event.type)` is
  exactly where the typed union is flattened into row shape. That `switch` is
  the contract translation — lose a case and that event variant is silently
  dropped (the comment notes earlier versions dropped most of them).

## How it works

#### Move 1 — the mental model

You know a discriminated union from frontend reducers: an `action` with a
`type` field, and a `switch(action.type)` that handles each case. Persisting
the trace is taking that action stream and writing every action to a table
so you can replay the session later. The catch: a database table has *one*
fixed column set, but the union's variants carry *different* fields. So the
table is the superset — every column any variant might need — and each row
fills only the columns its variant uses, leaving the rest null.

```
  The pattern — flatten a tagged union into one wide table

  CapabilityEvent (6 variants)        agents.messages (1 row shape)
  ┌──────────────────────────┐        ┌──────────────────────────────┐
  │ step       {role,content}│  ────► │ role=<role>  content=<content>│
  │ tool_call_start {name,args}│ ────►│ role='tool_call' tool_calls={}│
  │ tool_call_end {result,err}│ ────► │ role='tool' tool_results={}   │
  │ model_usage {tokens}      │ ────► │ role='model_usage' tokens_used│
  │ warning {message}         │ ────► │ role='warning' content=msg    │
  │ error {message}           │ ────► │ role='error' content=msg      │
  └──────────────────────────┘        └──────────────────────────────┘
   one variant → one row; unused columns are null
```

#### Move 2 — the step-by-step walkthrough

**Step 1 — the source is a typed discriminated union.** Each variant carries
only its own fields, plus the common `capabilityId` + `timestamp`.

```ts
// packages/runtime/src/events.ts:1-24
export type CapabilityEvent =
  | { type: 'step'; capabilityId: string; role: string; content: string; timestamp: string }
  | { type: 'tool_call_start'; capabilityId: string; toolName: string; args: unknown; timestamp: string }
  | { type: 'tool_call_end'; capabilityId: string; toolName: string; result?: unknown; error?: string; durationMs: number; timestamp: string }
  | { type: 'model_usage'; capabilityId: string; provider: string; model: string; inputTokens?: number; outputTokens?: number; estimated?: boolean; timestamp: string }
  | { type: 'warning'; capabilityId: string; message: string; timestamp: string }
  | { type: 'error'; capabilityId: string; message: string; timestamp: string };
```

The `timestamp` on every variant is load-bearing for Step 4 — it's how
replay order is preserved.

**Step 2 — the table is the superset of all variants' fields.** Nullable
columns + two `jsonb` columns hold whatever a given variant carries.

```sql
-- buffr/sql/001_agents_schema.sql:40-50
create table if not exists agents.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid references agents.conversations(id) on delete cascade,  -- the one hard FK
  role text not null,
  content text not null default '',
  tool_calls jsonb,        -- filled by tool_call_start
  tool_results jsonb,      -- filled by tool_call_end
  model text,              -- filled by model_usage
  tokens_used int,         -- filled by model_usage
  created_at timestamptz not null default now()
);
```

This is single-table inheritance again (same family as
`03-kind-tag-shared-collection.md`): one table, many logical row types,
discriminated — here by `role` plus which columns are non-null. The cost is
the usual one: lots of nullable columns, since no single event fills them
all.

**Step 3 — the sink's `switch` maps each variant to a row.** This is the
seam. Every union case is handled; the comment records that earlier versions
dropped most of them.

```ts
// buffr/src/supabase-trace-sink.ts:53-84
emit(event: CapabilityEvent): void {
  const at = event.timestamp;
  switch (event.type) {
    case 'step':
      if (event.content) this.push(persistMessage(pool, cid, event.role, event.content, { createdAt: at }));
      return;
    case 'tool_call_start':                                  // the CAUSE — args captured
      this.push(persistMessage(pool, cid, 'tool_call', event.toolName,
        { toolCalls: { toolName: event.toolName, args: event.args }, createdAt: at }));
      return;
    case 'tool_call_end':                                    // the EFFECT — result + durationMs
      this.push(persistMessage(pool, cid, 'tool', event.toolName,
        { toolResults: { result: event.result, error: event.error, durationMs: event.durationMs }, createdAt: at }));
      return;
    case 'model_usage':                                      // fills the otherwise-orphaned tokens_used
      this.push(persistMessage(pool, cid, 'model_usage', '',
        { model: `${event.provider}/${event.model}`, tokensUsed: (event.inputTokens ?? 0) + (event.outputTokens ?? 0), createdAt: at }));
      return;
    case 'warning':
    case 'error':
      this.push(persistMessage(pool, cid, event.type, event.message, { createdAt: at }));
      return;
  }
}
```

The header comment (`:39-48`) is the design note: capturing *every* variant —
tool args (the cause), durationMs + error, token usage — "turns
`agents.messages` into a complete, replayable trajectory and fills the
otherwise-orphaned `tokens_used` column." A trace that dropped
`tool_call_start` would record *that* a tool ran but not *why* — you couldn't
replay the decision.

**Step 4 — the event timestamp is persisted, not the insert time.** This is
the subtle correctness move. `emit()` is synchronous (aptkit's contract), but
the writes are queued and `flush()`ed concurrently — so insert order is a
race. Persisting `event.timestamp` into `created_at` makes replay order match
*emit* order regardless of which insert wins the race.

```ts
// buffr/src/supabase-trace-sink.ts:26-30, 87-93
const createdAt = extra?.createdAt && extra.createdAt.length > 0 ? extra.createdAt : null;
await pool.query(
  `insert into agents.messages (...) values (..., coalesce($8::timestamptz, now()))`,  // ← event time wins
  [..., createdAt]);
// emit() queues a promise; flush() awaits Promise.all(pending) after the run.
```

```
  Layers-and-hops — why event-time beats insert-time

  ┌─ agent loop (aptkit) ─┐ emit(step@T1), emit(tool_start@T2), emit(tool_end@T3)
  │ runAgentLoop          │ ──────────────────────────────────────────────┐
  └───────────────────────┘  (synchronous emit, in order T1<T2<T3)         │
                       ┌─ SupabaseTraceSink ───────────────────────────────┐│
                       │ push 3 promises; flush() = Promise.all (CONCURRENT)│◄┘
                       └───────────────┬────────────────────────────────────┘
                       ┌─ Postgres ────▼────────────────────────────────────┐
                       │ inserts may COMMIT out of order (race)              │
                       │ but created_at = event.timestamp (T1,T2,T3)         │
                       │ → order by created_at recovers true emit order      │
                       └─────────────────────────────────────────────────────┘
```

#### Move 2 variant — the load-bearing skeleton

Kernel of "persisted trace": **an append-only table keyed to a parent
(conversation) + one row per event + a discriminant (`role` + filled
columns) + an event-time column for ordering.**

- **Drop the per-variant capture** (only persist `step`s) and you lose the
  *causes* — you see answers but not the tool calls and decisions that
  produced them; replay becomes impossible.
- **Drop the event timestamp** (use insert `now()`) and concurrent flushes
  scramble the order — replay shows tool results before their calls.
- **Drop the `on delete cascade` FK** and deleting a conversation orphans
  its messages.

Optional hardening (not present): an index on `conversation_id` (the read
path — `audit.md` lens 3); retention/partitioning on this unbounded table
(`audit.md` lens 5). Both `not yet exercised`.

#### Move 3 — the principle

A typed event stream and a relational table are two representations of the
same trajectory — the union is the live, compiler-checked shape; the table is
the durable, queryable one. Mapping between them well means two things:
capture *every* variant (a partial map silently loses information — the
causes, the costs), and preserve *logical* order independent of physical
write order (persist event time, not insert time). Get both and the table is
a faithful replay of the run; miss either and it's a lossy summary.

## Primary diagram

```
  The trace: typed union → flattened rows → ordered replay

  ┌─ aptkit ───────────────────────────────────────────────────┐
  │ CapabilityEvent: step·tool_start·tool_end·usage·warn·error  │
  │ each carries capabilityId + ISO timestamp                   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ SupabaseTraceSink.emit() switch
  ┌─ buffr ────────────────────▼─────────────────────────────────┐
  │ agents.messages (append-only, FK→conversations cascade)      │
  │  role + content + tool_calls? + tool_results? + tokens_used? │
  │  created_at = event.timestamp  ← logical order, race-proof   │
  └───────────────────────────┬─────────────────────────────────┘
                              │ order by created_at
                              ▼
                   faithful, replayable trajectory
  gaps: no index on conversation_id · no retention (grows forever)
```

## Elaborate

Persisting an agent's trajectory as an event log is event-sourcing-lite:
you store *what happened* (the events), not just *the final state* (the
answer), so you can replay, audit, and evaluate the run after the fact. In
this stack that table feeds the replay-centric evaluation backbone described
in context.md — live run → artifact → eval → fixture. The discriminated
union is the in-memory contract (`CapabilityEvent`); the NDJSON stream
helpers (`packages/runtime/src/ndjson-stream.ts`) are its wire form; this
table is its durable form. Same trajectory, three representations.

The two named gaps are the standard event-log tax: an append-only table that
grows forever needs retention or time-partitioning, and the parent-keyed read
path (`where conversation_id = $`) wants an index. Both are deferred for a
laptop runtime where one user's message history is small. Read next:
`03-kind-tag-shared-collection.md` (the same single-table-inheritance shape),
and study-debugging-observability for the trace as the observability surface.

## Interview defense

**Q: Why persist the event's own timestamp into `created_at` instead of just
using `now()` on insert?**

> Because the writes race. aptkit's `emit()` is synchronous and in-order, but
> my sink queues each event as a promise and flushes them with
> `Promise.all` — so the inserts can commit out of order. If I used insert
> `now()`, replay could show a tool result before the tool call that
> produced it. Persisting `event.timestamp` into `created_at` means `order by
> created_at` recovers the true emit order no matter which insert won the
> race.

```
  emit T1<T2<T3 (in order) → concurrent flush → commits out of order
  created_at = event time  → order by created_at → T1,T2,T3 recovered
```

Anchor: *persist logical (event) time, not physical (insert) time — order is
a property of when it happened, not when it landed.*

**Q: Why capture all six event variants instead of just the assistant's
messages?**

> Because a trace that only stores `step`s records the *answers* but not the
> *causes*: which tools ran, with what args, what they returned, what each
> model turn cost. Without the `tool_call_start` args you can see a tool
> fired but not why — you can't replay the decision. Capturing every variant
> turns the table into a complete trajectory and fills `tokens_used`, which
> was otherwise an orphaned column. The `switch` handles all six; a missing
> case would silently drop that event type.

Anchor: *capture the causes, not just the effects — a partial event map is a
lossy trace.*

## See also

- `03-kind-tag-shared-collection.md` — the same single-table-inheritance /
  discriminator shape.
- `02-metadata-as-a-json-bag.md` — `tool_calls`/`tool_results` are jsonb
  bags, like `meta`.
- `05-app-id-tenancy-without-rls.md` — `conversations` carries `app_id`;
  `messages` inherits the tenant via its FK.
- `audit.md` lenses 4, 5 — the cascade FK, the missing index, the missing
  retention.
- **study-debugging-observability** — the trace as the observability surface.
