# tagged-union event log

**Industry name(s):** discriminated union / sum type / tagged-union schema; the persisted form is an append-only event log (event-sourcing-adjacent). **Type label:** Language-agnostic pattern.

## Zoom out, then zoom in

You know how a Redux action is `{ type: 'ADD_TODO', payload }` and a reducer switches on `type`? AptKit's trace is the same shape, but as a *schema for stored data* — every step an agent takes is appended as a typed event, and the `type` field tells you which variant you're holding.

```
  Zoom out — where the event log sits

  ┌─ Agent loop (packages/runtime) ─────────────────────┐
  │  runAgentLoop → emits events as it runs              │
  │      sink.emit(CapabilityEvent)                      │
  └───────────────────────────┬─────────────────────────┘
                              │  one event per step
  ┌─ TRACE schema (events.ts) ────────────────────────▼┐
  │  ★ CapabilityEvent ★  6-variant discriminated union  │ ← we are here
  │   step | tool_call_start | tool_call_end |           │
  │   model_usage | warning | error                      │
  └───────────────────────────┬─────────────────────────┘
                              │  collected into trace[]
  ┌─ Persisted (artifacts/replays/*.json) ─────────────▼┐
  │  "trace": [ {event}, {event}, ... ]  append-only     │
  └───────────────────────────────────────────────────────┘
```

Zoom in: the pattern is **a closed set of event shapes, discriminated by a `type` tag, appended in order.** The question it answers: how do you model a heterogeneous log — some entries are tool calls, some are token-usage records, some are errors — in one array, type-safely, so a reader can switch on the tag and the compiler knows exactly which fields are present?

## Structure pass

**Layers.** One schema, two lives: the *in-memory* union (`CapabilityEvent`, compiler-checked) and the *on-disk* array (`trace[]` inside an artifact, just JSON). Same seam as `01` — the `JSON.parse` boundary is where compiler safety ends.

**Axis — trace "what's guaranteed about a record's fields?":**

```
  axis: "given a record, which fields are guaranteed present?"

  ┌─ before reading `type` ─┐  seam  ┌─ after switching on `type` ─┐
  │  only the common fields │ ══╪═══► │  the variant's full field set│
  │  (capabilityId, type,   │ (flips) │  e.g. tool_call_end ⇒        │
  │   timestamp)            │         │  toolName + durationMs       │
  └─────────────────────────┘        └──────────────────────────────┘
```

**Seam.** The discriminant field (`type`) *is* the seam. Before you read it, you only know the three common fields every variant carries. After you switch on it, the compiler narrows the type and the variant-specific fields become available. That narrowing is the entire ergonomic payoff of a tagged union — it's the thing that makes the heterogeneous log safe to consume.

## How it works

### Move 1 — the mental model

A tagged union is a closed enum of shapes that share a discriminant.

```
  The pattern — closed set, one discriminant, narrow on read

  CapabilityEvent =
    { type:'step'            ... }  ┐
    { type:'tool_call_start' ... }  │ closed set —
    { type:'tool_call_end'   ... }  ├ a 7th variant
    { type:'model_usage'     ... }  │ can't sneak in
    { type:'warning'         ... }  │ without editing
    { type:'error'           ... }  ┘ the type

  read:  switch (event.type) { case 'tool_call_end': event.durationMs }
                                     └─ compiler now KNOWS this field exists
```

The closedness is load-bearing: because the union lists every variant, a consumer's `switch` can be checked for exhaustiveness, and a reader of an old artifact knows the complete set of things it might find.

### Move 2 — the walkthrough

**The common fields — the "every row has these" columns.** All six variants carry `capabilityId: string` and `timestamp: string`. Bridge: these are the columns a logging table puts on *every* row regardless of log type. `capabilityId` says which agent emitted it; `timestamp` is the ISO time. What breaks without them: you couldn't order the log or attribute an event to a run.

**The discriminant — `type`.** The one field whose *value* selects the shape. This is the tag. A reader switches on it; a writer sets it once and the rest of the variant's fields are then required by the type.

```
  Narrowing on the discriminant (execution trace)

  event = { type:'tool_call_end', toolName:'get_metric_timeseries',
            durationMs: 0, result: {...}, capabilityId:'query-agent', ts }

  switch (event.type):
    'tool_call_end' ─► event.toolName     ✓ available (variant has it)
                       event.durationMs   ✓ available
                       event.inputTokens  ✗ compile error (wrong variant)
```

**The variant-specific payloads — the sparse columns.** Each variant carries only its own fields: `tool_call_start` has `args: unknown`; `tool_call_end` has `result?`, `error?`, `durationMs`; `model_usage` has `provider`, `model`, `inputTokens?`, `outputTokens?`, `estimated?`. In a single wide log table these would be nullable columns that are populated only for some row types — the classic "sparse table" smell. The tagged union avoids that smell: each variant declares exactly its fields, so there are no always-null columns.

**The append-only persistence.** Events are emitted in order and collected into `trace[]`. They are never updated or deleted — write once, read many. This is the event-log discipline: the log is an immutable record of what happened. That immutability is what makes the trace replayable and what makes the artifact a trustworthy record.

**The denormalization that bites — the duplicated final answer.** Here's the real cost in this schema. The agent's final output lives in the artifact *twice*: once structured (`recommendations[]` / `answer` / `anomalies` / `diagnosis`) and once as a JSON string inside the final `step` event's `content`.

```
  One fact, two homes (the denormalization)

  artifact.recommendations[0].title  ──┐
                                        ├─ SAME text
  artifact.trace[last].content (string) ┘   (a step event)
         │
         └─ structured form = what evals & promotion read
            string form     = what Studio renders as "raw turn"
            edit one, the other goes stale — but the structured
            form is the source of truth, so it's a contained read
            optimization, not an accident
```

This is the update-anomaly risk denormalization always carries, made concrete. It's accepted because the two copies serve two read paths and the structured form is authoritative — but if you ever hand-edited the trace string, the eval would still pass on the structured array while the UI showed something different.

**The foreign-key analog — repeated `capabilityId`.** Every event copies `capabilityId`. In a relational model the run would be a parent row and each event a child with one FK; the value would live once. Here it's copied onto every event because each event is independently streamed over NDJSON and must be self-describing — you can't assume the reader has the parent in hand. That's a deliberate denormalization for the streaming wire format.

### Move 3 — the principle

A tagged union is how you model a heterogeneous, append-only log without either an untyped blob (lose all safety) or a wide sparse table (every variant pays for every other variant's columns). The discriminant gives you exhaustive, narrowable reads. **The closed set is the contract: a reader of any old log knows the complete universe of shapes it can contain — which is exactly the property you need for a persisted, replayable record.**

## Primary diagram

The full event-log schema, in memory and on disk, with the duplication marked.

```
  CapabilityEvent — schema + persistence + the duplication

  IN MEMORY (compiler-checked union)        ON DISK (artifact JSON)
  ──────────────────────────────────        ───────────────────────
  CapabilityEvent (discriminant: type)
   common: capabilityId, timestamp           "trace": [
   ├ step            : role, content    ───►    { type:"model_usage", ... },
   ├ tool_call_start : toolName, args   ───►    { type:"tool_call_start", ... },
   ├ tool_call_end   : result?, error?, ───►    { type:"tool_call_end", ... },
   │                   durationMs                { type:"step", content:"..." } ◄┐
   ├ model_usage     : provider, model,           ]                              │
   │                   inputTokens?               "recommendations": [ {...} ] ──┘
   ├ warning         : message                          SAME fact, two homes
   └ error           : message                          (deliberate denorm)
```

## Implementation in codebase

**Use cases in AptKit.** Every agent run produces a trace. The bounded agent loop (`runAgentLoop`) emits a `model_usage` event per model call, a `tool_call_start`/`tool_call_end` pair per tool invocation, `step` events for assistant turns, and `warning`/`error` for problems. Studio renders the trace live as NDJSON; the replay artifact persists it as `trace[]`. It's the observability backbone and the replay record at once.

**The schema, line by line** — `packages/runtime/src/events.ts:1-24`:

```
  CapabilityEvent (the union)
    | { type:'step'; capabilityId; role; content; timestamp }     ← line 2
    | { type:'tool_call_start'; ...; toolName; args:unknown; ... } ← line 3
    | { type:'tool_call_end';                                      ← lines 4-12
          toolName; result?; error?; durationMs; timestamp }
          │      │        │
          │      │        └─ optional: a tool may end with an error instead
          │      └─ optional: present on success
          └─ duration is required even on error — every call is timed
    | { type:'model_usage'; provider; model; inputTokens?; ... }   ← lines 13-22
    | { type:'warning'; message; ... } | { type:'error'; ... }     ← lines 23-24

  CapabilityTraceSink (lines 26-28)
    emit(event: CapabilityEvent): void;   ← the only write path; append-only
         │
         └─ there is no update() or delete() — the sink can only append,
            which is what makes the log immutable
```

**A persisted instance** — `artifacts/replays/2026-06-18T17-19-48-316Z-sp-revenue-drop-w4-fixture-studio.json:80-124`. The `trace[]` array holds, in order: a `model_usage`, a `tool_call_start` (`list_scenarios`), a `tool_call_end` (`"result": { "data": [] }`), another `model_usage`, then the final `step` whose `content` is a JSON string of the recommendations. That last `step` (line 122) is the duplicated copy of `recommendations[]` (lines 14-79) in the same file — the denormalization made real.

**The reader switches on the tag** — `scripts/promote-replay-to-fixture.mjs:114-119`. `modelUsageTotals` filters the trace for `event.type === 'model_usage'` and sums tokens. That's a consumer using the discriminant exactly as designed: select one variant, read its variant-specific fields (`inputTokens`, `outputTokens`).

## Elaborate

The tagged union is the algebraic-data-type idea from functional languages (Haskell's sum types, Rust's enums) landing in TypeScript via the discriminated union. As a *data-modeling* tool it solves the polymorphic-collection problem: one ordered collection of differently-shaped records. The persisted form — append-only, immutable, replayable — is the event-sourcing pattern in miniature; AptKit doesn't rebuild state from the log (it stores the final output alongside), but the log has the same write-once-read-many discipline.

Where it connects: the duplication here is the cost side of the denormalization praised in `01-type-as-schema.md`. The closedness of the union is what lets `03-versioned-artifact-schema.md` reason about migration — when you add a 7th variant, you've changed the schema, and `schemaVersion` is how you'd signal it.

## Interview defense

**Q: How is the agent trace modeled?**
"As a discriminated union, `CapabilityEvent` — six variants (`step`, `tool_call_start`, `tool_call_end`, `model_usage`, `warning`, `error`) sharing a `type` discriminant plus `capabilityId` and `timestamp`. Persisted as an append-only `trace[]` array in the replay artifact. A consumer switches on `type` and the compiler narrows to that variant's fields."

```
  type='tool_call_end' ─► toolName, durationMs guaranteed
  type='model_usage'   ─► inputTokens, model guaranteed
  one array, switch on the tag, fields narrow
```

Anchor: *closed set, one discriminant, narrow on read — a typed heterogeneous log.*

**Q: Where's the duplication, and is it a problem?**
"The final answer lives twice: structured in `recommendations[]` and as a JSON string in the last `step` event's `content` — `...sp-revenue-drop...json` lines 14-79 and 122. It's a deliberate denormalization: the structured form is what evals and promotion read, the string is what Studio shows as the raw turn. The structured form is authoritative, so it's a contained read optimization. The risk it carries is the textbook one — a hand-edited string would drift from the array — which is why nothing hand-edits the trace."

Anchor: *one fact, two read paths; the structured copy is the source of truth.*

**Q: The part people forget?**
"That the union is *closed*, and that closedness is the contract. A reader of an artifact from six months ago knows the complete set of event shapes it could contain, because the type lists them. Add a seventh variant and you've changed the schema — which is exactly when `schemaVersion` should increment."

## Validate

1. **Reconstruct.** List all six `CapabilityEvent` variants and the fields unique to each, from memory. Check `events.ts:1-24`.
2. **Explain.** Why is `durationMs` required on `tool_call_end` even when the call errored (`error?` is set)? (Every call is timed regardless of outcome; the duration is meaningful even for a failure.)
3. **Apply.** You want to record a "cache_hit" event. Write the new variant. What else must change? (The union in `events.ts`; any exhaustive `switch`; and arguably `schemaVersion`, since persisted traces can now contain a shape old readers don't know.)
4. **Defend.** Justify storing the final answer both as `recommendations[]` and inside the trace string. Then state the exact failure mode if someone hand-edited the trace string but not the array (eval passes on the array, UI renders the stale string).

## See also

- `01-type-as-schema.md` — the entity schema; the denormalization upside this file's duplication is the downside of.
- `03-versioned-artifact-schema.md` — why adding a variant is a schema change worth a version bump.
- `05-structural-diff-integrity.md` — how the trace shape is re-validated at read time (`trace` must be an array).
- `06-vector-store-row-model.md` — the same "self-describing rows" denormalization: `docId`-per-chunk there is the shape of `capabilityId`-per-event here.
- `audit.md` — Lens 1 (shape), Lens 2 (the recommendation + `capabilityId` duplications).
- `study-system-design` → trace/observability flow — how the trace streams as NDJSON (the system view).
