# Trajectory persistence and the PII surface

**Industry name(s):** full-trajectory logging · PII data minimization (the
gap) · **Type:** Project-specific control with a privacy cost (a deliberate
design that's also the repo's #2 exposure)

## Zoom out, then zoom in

aptkit's agent loop emits a stream of trace events — every assistant turn,
every tool call, every result. buffr's job as the persistent body is to
write that stream somewhere durable so runs can be replayed and inspected.
The trace sink (the `SupabaseTraceSink`) does exactly that, and does it
completely: *every* event lands in `agents.messages`. That completeness is
the feature — and the privacy problem. Whatever a user typed, whatever a
document contained, whatever an error revealed, is now permanent and
unredacted.

```
  Zoom out — where the trajectory gets persisted

  ┌─ Runtime layer (aptkit) ───────────────────────────────────┐
  │  runAgentLoop  →  trace.emit(CapabilityEvent)               │
  │    step · tool_call_start · tool_call_end · model_usage ··· │
  └──────────────────────────┬──────────────────────────────────┘
                             │  CapabilityEvent stream
  ┌─ Trace sink (buffr) ─────▼──────────────────────────────────┐
  │  ★ SupabaseTraceSink.emit() ★   persists EVERY variant      │ ← we are here
  └──────────────────────────┬──────────────────────────────────┘
                             │  insert into agents.messages
  ┌─ Storage (Postgres) ─────▼──────────────────────────────────┐
  │  content text · tool_calls jsonb · tool_results jsonb · ··· │
  │  unredacted · plaintext · durable                           │
  └─────────────────────────────────────────────────────────────┘
```

Zoom in: the missing control is **data minimization** — persisting only
what you need, redacting the rest. The question it answers: *if someone gets
read access to `agents.messages`, what do they learn?* Today: every
question asked, every retrieved passage, every tool argument, every error.

## Structure pass

**Layers:** the runtime *emits* a complete trajectory (correct — it can't
know what's sensitive); the sink *decides what to keep* (the layer where
minimization belongs); storage *holds it forever*.

**Axis — data exposure:** trace "what sensitive content lives here?" down
the layers.

```
  The exposure axis — sensitivity accumulates downward

  ┌─ runtime ──┐   emits all   ┌─ sink ─────┐  persists all  ┌─ storage ─┐
  │ trajectory │ ═════════════► │ no filter  │ ═════════════► │ durable   │
  │ (ephemeral)│                │ no redact  │                │ PII at    │
  │            │                │            │                │ rest      │
  └────────────┘                └────────────┘                └───────────┘
       ▲                              ▲                             ▲
       └── "what sensitive content?" ─┴── grows: nothing persisted  ┘
           until the sink — which keeps everything
```

**Seam:** `SupabaseTraceSink.emit()` (`buffr/src/supabase-trace-sink.ts:53`)
is where ephemeral becomes durable. It's the right place to put a redaction
step, and today it has none — it's a pass-through.

## How it works

#### Move 1 — the mental model

You've seen the logging anti-pattern: `console.log(req.body)` on a login
handler, and now the password is in your log aggregator forever. The trace
sink is that at the agent layer — it logs the *entire* conversation
trajectory, including the user's raw input and the tool arguments derived
from it, into a queryable table. The difference from a stray `console.log`
is that here it's deliberate and structured, which makes it useful *and*
makes the exposure systematic rather than accidental.

```
  What one run writes to agents.messages

  user asks "..."        → (arrives as the loop's userPrompt)
  assistant step         → content: the model's reasoning text
  tool_call_start        → tool_calls: { args: { query: "..." } }
  tool_call_end          → tool_results: { result, error, durationMs }
  model_usage            → model, tokens_used
  warning / error        → content: the raw message
  ─────────────────────────────────────────────────────────────
  all rows: app_id-scoped, plaintext content, jsonb args/results
```

#### Move 2 — the step-by-step walkthrough

**The sink persists every event variant, by design.** The class comment is
explicit that this is intentional — tool-call args, durations, errors, and
token usage were previously dropped and are now captured to make the
trajectory complete and replayable.

```typescript
// buffr/src/supabase-trace-sink.ts:39-48 (the design note, paraphrased intent)
// "Every CapabilityEvent variant is persisted — not just assistant steps and
//  tool results. Tool-call args (the cause), durationMs + error, token usage,
//  and warning/error events ... capturing them turns `agents.messages` into a
//  complete, replayable trajectory ..."
```

The intent is sound for observability (see `study-debugging-observability`).
The privacy cost is the silent part of that decision.

**Each variant maps to a persisted message.** The `emit` switch routes every
event type into `persistMessage`, carrying its payload verbatim.

```typescript
// buffr/src/supabase-trace-sink.ts:53-83
emit(event: CapabilityEvent): void {
  switch (event.type) {
    case 'step':                                            // assistant text
      if (event.content)
        this.push(persistMessage(pool, cid, event.role, event.content, {...}));
      return;
    case 'tool_call_start':                                 // the model's args
      this.push(persistMessage(pool, cid, 'tool_call', event.toolName, {
        toolCalls: { toolName: event.toolName, args: event.args }, ...   // ← raw args
      }));
      return;
    case 'tool_call_end':                                   // results + errors
      this.push(persistMessage(pool, cid, 'tool', event.toolName, {
        toolResults: { result: event.result, error: event.error, durationMs },
      }));
      return;
    // model_usage, warning, error → also persisted
  }
}
```

The `args` carry whatever the model derived from the user's question — for
`search_knowledge_base`, the literal search `query`. The `result` carries
retrieved document text. Both are now rows.

**The columns store it unredacted.** `persistMessage` writes `content` as
text and `tool_calls` / `tool_results` as JSONB, with no transform beyond
JSON-stringifying the jsonb payloads.

```typescript
// buffr/src/supabase-trace-sink.ts:27-36
await pool.query(
  `insert into agents.messages
     (conversation_id, role, content, tool_calls, tool_results, model, tokens_used, created_at)
   values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))`,
  [conversationId, role, content,                          // ← content: plaintext
   toJsonb(extra?.toolCalls), toJsonb(extra?.toolResults), // ← args/results: raw jsonb
   extra?.model ?? null, extra?.tokensUsed ?? null, createdAt],
);
```

It's parameterized (no injection), and it's complete (good observability),
and it's unredacted (the PII surface). Three true things at once.

**Who can read it.** `agents.messages` is governed by the same tenancy as
the rest of the schema — `app_id`, no RLS (see `04`). So the PII surface and
the tenancy gap compound: not only is every trajectory stored unredacted, a
query that forgets `where app_id` could read *another tenant's* trajectories.
The two findings multiply.

#### Move 2.5 — current state vs future state

```
  Phase A (now)                   Phase B (minimized)
  ─────────────────────           ───────────────────────────────
  emit → persist verbatim         emit → redact → persist
  content: full text              content: redacted (PII patterns
  tool_calls.args: raw query      stripped, or hashed for replay)
  tool_results: full doc text     results: store ids/scores, not
                                  full retrieved text
  retained forever                retention policy / TTL on the table

  what changes: a redaction step at the sink seam
    (the ONE place ephemeral → durable), plus a retention
    policy on agents.messages.
  what does NOT change: the runtime's complete emit stream
    (it stays complete; minimization is the sink's job, not
    the loop's), the replay machinery (redact reversibly or
    keep a separate, access-controlled raw store).
```

The minimization belongs at the sink, not the loop — the loop can't know
what's sensitive, but the sink is the deliberate ephemeral→durable boundary
where the policy decision lives. That's also *why* it's the natural fix
site: one function, one place to add `redact()`.

#### Move 3 — the principle

Observability and privacy pull in opposite directions, and the trace sink is
where you choose the balance. "Log everything" is the right default for
debugging and the wrong default for PII. The discipline is data
minimization: persist what you need to replay and diagnose, redact or
drop the rest, and put that decision at the single boundary where ephemeral
data becomes durable — not scattered, and not omitted because "it's just a
log."

## Primary diagram

```
  Trajectory persistence and the PII surface — the full picture

  ┌─ aptkit runtime ───────────────────────────────────────────┐
  │  runAgentLoop emits: step · tool_call_start · tool_call_end │
  │                      · model_usage · warning · error        │
  └──────────────────────────┬──────────────────────────────────┘
                             │ CapabilityEvent (ephemeral, complete)
  ┌─ buffr SupabaseTraceSink ▼──────────────────────────────────┐
  │  emit() switch → persistMessage()   ← NO redaction step     │
  └──────────────────────────┬──────────────────────────────────┘
                             │ insert into agents.messages
  ┌─ Postgres agents.messages ─────────────────────────────────┐
  │  content (text, plaintext)   ← user question, model output  │
  │  tool_calls (jsonb)          ← raw search query / args      │
  │  tool_results (jsonb)        ← retrieved document text       │
  │  app_id scoped · NO RLS (see 04) · durable · unredacted     │
  └─────────────────────────────────────────────────────────────┘
       compounds with 04: a forgotten app_id filter reads
       another tenant's full trajectories
```

## Elaborate

This is the tension between the observability backbone (replay-centric
evaluation: live run → artifact → eval → fixture) and data minimization, a
GDPR/privacy-by-design principle: collect and retain only the personal data
you need. The repo nails the observability half — the complete trajectory is
what makes deterministic replay and rubric evals possible (see
`study-testing` and `study-debugging-observability`). The privacy half is
unbuilt: no redaction at the sink, no retention policy on the table. The fix
doesn't trade away observability — it adds a redaction seam at the one
boundary that already exists, and optionally a separate access-controlled
raw store for the rare case full fidelity is needed. Pairs with `04`: RLS
limits *who* reads the table, redaction limits *what* they find.

## Interview defense

**Q: Your agent persists the full trajectory for replay. What's the privacy
risk?**

Everything the user typed and every document retrieved is now durable,
unredacted, in a queryable table — `content` as plaintext, tool args and
results as JSONB. The completeness that makes runs replayable is exactly the
PII surface. The fix is data minimization at the trace sink: redact
sensitive content before persisting, store result *references* (ids, scores)
rather than full retrieved text, and add a retention policy. It goes at the
sink because that's the single ephemeral→durable boundary — the runtime
can't know what's sensitive, but the sink is where the keep/drop decision
belongs.

```
  loop emits all (can't know what's sensitive)
       └─► sink: redact here (the one durable boundary)
            └─► storage holds only what's needed
```

*Anchor: minimization belongs at the trace sink — the single
ephemeral-to-durable boundary, not the loop.*

**Q: How does this interact with the tenancy gap?**

They compound. The trajectories are stored unredacted *and* the table has no
RLS — so a query that forgets `where app_id` doesn't just leak metadata, it
leaks another tenant's entire conversation history, including their raw
questions and retrieved documents. You want both fixes: RLS bounds who can
read the rows, redaction bounds what's in them.

*Anchor: PII-at-rest plus no-RLS multiply — fix both, not one.*

## See also

- `04-app-code-tenancy-without-rls.md` — the tenancy gap this compounds with
- `audit.md` lens 5 (data exposure) and lens 1 (the trace-sink boundary)
- `study-debugging-observability` — why the complete trajectory exists
- `study-testing` — replay-centric evaluation built on these traces
- `study-data-modeling` — the `agents.messages` table shape
