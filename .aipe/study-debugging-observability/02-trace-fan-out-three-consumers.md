# Trace fan-out — one emitter, three consumers

**Industry name(s):** observer pattern / pub-sub sink / fan-out over a single
interface. **Type:** Industry standard.

## Zoom out, then zoom in

The loop emits one event stream. Three completely different things need that
stream for completely different reasons — a developer wants to *see* it, an
accountant wants to *cost* it, production wants to *keep* it. The trick is that
none of them changes the loop, because they all enter through the same one-method
door.

```
  Zoom out — three readers behind one interface

  ┌─ Runtime layer ─────────────────────────────────────────┐
  │  runAgentLoop ──emit──► CapabilityTraceSink (the seam)   │
  └──────────────────────────────┬───────────────────────────┘
        ┌────────────────────────┼────────────────────────┐
        ▼                         ▼                         ▼
  ┌─ UI layer ─────┐    ┌─ Runtime (cost) ─┐     ┌─ Storage layer ──┐
  │ ★ Studio       │    │ ★ usage ledger    │     │ ★ Supabase sink  │ ← each is
  │   replay UI    │    │   summarizeUsage  │     │   (buffr repo)   │   "here"
  └────────────────┘    └───────────────────┘     └──────────────────┘
   sees the run          costs the run             keeps the run
```

Zoom in: this is the observer pattern, but degenerate in the best way — the
"subject" doesn't even maintain a list of observers. It holds *one* optional
sink and calls `emit`. Multiplexing to several backends, if you need it, is the
sink's job, not the loop's. The question this file answers: *how does one stream
serve three needs without the producer knowing any of them?*

## The structure pass

**Layers.** UI (Studio), Runtime-cost (the ledger), Storage (buffr's Postgres).
Three different architectural bands, one shared input.

**Axis — trace it on `state`: where does the observed run end up living?**

```
  "where does the run's state come to rest?"  — across the three consumers

  Studio        → React state (liveTrace), ephemeral, dies with the tab
  Usage ledger  → a reduced value, computed on demand, stored nowhere
  Supabase sink → a Postgres row per event, durable, survives the process

  same input stream; three different resting states
```

**Seam.** Still the one `CapabilityTraceSink` boundary from `01`. What's new
here is that the *axis answer* (where state lives) differs wildly per consumer —
ephemeral, computed, durable — yet the contract they implement is identical.
That contrast is the lesson: a good interface lets radically different
implementations sit behind it without leaking their differences upward.

## How it works

### Move 1 — the mental model

Think of a `fetch()` response body you can `.json()` *or* `.text()` *or* pipe to
a file — same bytes, three reads. The trace is the same: one event stream, and
each consumer reads it in the shape it needs. The producer commits to the
*format*, not to any reader's intent.

```
  The pattern — fold one stream three ways

     event stream:  e0  e1  e2  e3  e4 ...
                     │
        ┌────────────┼────────────┐
        ▼            ▼             ▼
   collect into   reduce to    persist each
   an array       a sum        as a row
   (UI tree)      (tokens)     (Postgres)
        │            │             │
   render        display       query later
```

Each reader is a *fold* over the same sequence — accumulate into an array,
reduce to a scalar, or side-effect per element. Three folds, one source.

### Move 2 — the step-by-step walkthrough

**Consumer 1 — Studio collects into React state and renders a tree.**
`AgentReplayShell` (`apps/studio/src/AgentReplayShell.tsx`) passes an `onEvent`
callback as the sink during a streamed run; each event is appended to a
`liveTrace` state array. When the run finishes, `summarizeUsage(visibleTrace)`
derives the metrics line. `TracePanel` (`apps/studio/src/components.tsx`) then
folds the array into a filterable visual tree.

```
  Layers-and-hops — Studio reads the stream

  ┌─ Runtime ───┐  hop 1: emit(event)     ┌─ UI: AgentReplayShell ─┐
  │ runAgentLoop│ ──────────────────────► │ onEvent → setLiveTrace │
  └─────────────┘  (NDJSON when streamed   └──────────┬─────────────┘
                    over the Vite route)    hop 2: trace array
                                                       ▼
                                            ┌─ UI: TracePanel ──────┐
                                            │ filter: all|model|    │
                                            │ tools|warnings        │
                                            │ → TraceItem per event │
                                            │   (expandable payload)│
                                            └───────────────────────┘
```

The filter categories map directly onto event types — `'model'` shows
`model_usage|step`, `'tools'` shows `tool_call_start|tool_call_end`,
`'warnings'` shows `warning|error`. That mapping is only possible *because* the
events are typed; an unstructured log couldn't offer it. Each `TraceItem`
expands a `<details>` to reveal the raw payload — args, result, error — which is
the dev-time state inspector.

**Consumer 2 — the usage ledger reduces the stream to cost.**
`summarizeUsage` folds only the `model_usage` events into one usage row, then
`estimateCost` prices it:

```typescript
// packages/runtime/src/usage-ledger.ts:25-42 — fold to a usage summary
export function summarizeUsage(trace: readonly CapabilityEvent[]): TokenUsageSummary {
  return trace.reduce<TokenUsageSummary>((summary, event) => {
    if (event.type !== 'model_usage') return summary;   // ignore every other event
    const inputTokens = event.inputTokens ?? 0;
    const outputTokens = event.outputTokens ?? 0;
    return {
      inputTokens: summary.inputTokens + inputTokens,
      outputTokens: summary.outputTokens + outputTokens,
      totalTokens: summary.totalTokens + inputTokens + outputTokens,
      modelName: event.model || summary.modelName,
      turns: summary.turns + 1,                          // each model_usage = one turn
      estimated: summary.estimated || event.estimated === true,
    };
  }, { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '', turns: 0, estimated: false });
}
```

This is a pure reduce — same stream, but it discards everything that isn't
`model_usage`. The `estimated` flag is honest plumbing: if any turn's tokens
were estimated rather than reported, the whole summary is flagged estimated.

The known limit (audit lens 4 + 8): `pricingForModel` only prices `gpt-4.1*`
(`usage-ledger.ts:71-78`) and returns `undefined` otherwise — so a local Gemma
or Anthropic run produces a usage summary but a `n/a` cost. The signal exists;
the pricing table is partial.

**Consumer 3 — buffr's sink persists each event as a row.**
The durable reader implements the same interface and side-effects per event into
Postgres. Detailed in `03`; the point here is it satisfies the *identical*
contract as the other two:

```typescript
// /Users/rein/Public/buffr/src/supabase-trace-sink.ts:49-85 (shape)
export class SupabaseTraceSink implements CapabilityTraceSink {
  emit(event: CapabilityEvent): void {
    switch (event.type) {            // same discriminant the other consumers fold on
      case 'step': /* → agents.messages row */ return;
      case 'tool_call_start': /* persist args */ return;
      // ... one case per event type
    }
  }
}
```

**The serialization seam — NDJSON when the stream crosses a process boundary.**
Studio's two of these (UI and ledger) run in the browser, but the *run* executes
in the Vite dev server, so the events cross a network hop. They serialize as
NDJSON — one JSON object per line — via `encodeCapabilityEvent`
(`packages/runtime/src/ndjson-stream.ts`), decoded with a runtime guard
(`isCapabilityEvent`) on the far side. The Vite route streams
`{ type: 'event', event }` records and a final `{ type: 'result', result }`.
NDJSON is the line-oriented format precisely because it's append-friendly and
parseable one line at a time as the stream arrives.

### Move 3 — the principle

Commit the producer to a *format*, never to a *consumer*. The loop knows how to
emit a `CapabilityEvent`; it knows nothing about React, Postgres, or USD. That
ignorance is the feature — it's why adding a fourth consumer (say, a metrics
exporter) would be a new sink class and zero loop edits. The cost of the
decoupling is one indirection (`trace?.emit`), which is nothing.

## Primary diagram

```
  Trace fan-out — one emitter, three consumers, one contract

  ┌─ Runtime layer ──────────────────────────────────────────────────┐
  │  runAgentLoop ── trace?.emit(event) ──► CapabilityTraceSink        │
  └────────────────────────────────┬───────────────────────────────────┘
            ┌──────────────────────┼───────────────────────┐
            │ (in-process)         │ (in-process)           │ (NDJSON over hop,
            ▼                      ▼                        ▼  buffr process)
  ┌─ UI: Studio ──────┐  ┌─ Runtime: cost ────┐  ┌─ Storage: Supabase ──┐
  │ onEvent →liveTrace│  │ summarizeUsage      │  │ SupabaseTraceSink     │
  │ → TracePanel tree │  │ → estimateCost      │  │ → agents.messages rows│
  │ collect (array)   │  │ reduce (scalar)     │  │ side-effect (rows)    │
  │ state: ephemeral  │  │ state: computed     │  │ state: durable        │
  └───────────────────┘  └─────────────────────┘  └───────────────────────┘
   AgentReplayShell.tsx   usage-ledger.ts:25-78    buffr/...trace-sink.ts:49-94
```

## Elaborate

This is the Gang-of-Four observer pattern with the registry collapsed to a
single optional slot — the simplest possible version, and correct for a
single-process loop. If you've used `EventTarget`/`addEventListener` in the
browser, or subscribed a reducer to a store, you've used the full version; here
the producer just holds one sink reference. The reduce-the-stream-to-cost
consumer is a textbook *fold/catamorphism* — the same operation as
`Array.reduce`, `sum()`, or building a Redux state from an action log.

Read next: `03-durable-trajectory-supabase-sink.md` (consumer 3 in depth),
`01-capability-event-trace.md` (the stream they all share).

## Interview defense

**Q: How do you serve three observability needs without bloating the loop?**
One sink interface. The loop emits a typed event; each consumer is a fold over
the same stream — collect to an array (UI), reduce to a cost (ledger),
side-effect per event (Postgres). Adding a consumer is a new class, not a loop
change.

```
  emit ─► [ collect ] [ reduce ] [ persist ]   one stream, three folds
```

**Q: What breaks if a consumer is slow?**
Nothing on the hot path *if* the sink honors the synchronous-`void` contract.
buffr's durable sink can't write synchronously, so it queues and `flush()`es
after the run — the loop never awaits I/O. That's the load-bearing detail people
miss: the contract keeps observation off the critical path.

**Q: Where's the weak spot in this fan-out today?**
The cost consumer only prices `gpt-4.1*` (`usage-ledger.ts:71-78`). A Gemma or
Anthropic run gets a token count but `n/a` cost — the fold runs fine, the
pricing table is just incomplete.

## See also

- `01-capability-event-trace.md` — the stream all three consume.
- `03-durable-trajectory-supabase-sink.md` — the Postgres consumer in full.
- `audit.md` lens 4 (cost signals), lens 6 (Studio as state inspector).
- `study-performance-engineering` — the token/cost/latency signals as budgets.
